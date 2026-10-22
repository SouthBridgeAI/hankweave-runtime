/**
 * The model verification loop (spec 70, "The verification loop"); the CLI is
 * scripts/verify-models.ts.
 *
 * Probes models with real keys and reports evidence as JSON:
 * - a direct-API battery through the AI SDK: a plain reply, whether the
 *   call's usage prices against the catalog, a tool call, a forced tool
 *   choice, and image input when the catalog claims image support;
 * - with --codon, one real hankweave codon per model through the init
 *   end-to-end test (the harness hankweave would pick runs it);
 * - with --context-probe, a prompt near the catalog's context limit — this
 *   costs real money (a 1M-token prompt is dollars per model), so it is opt-in.
 *
 * A failed check is a finding about the model, reported for a human to act
 * on. The only overlay entries it proposes are limit `corrections`, where the
 * provider's own model API reports different limits than the catalog. Nothing
 * is written unless --write-overlay is given; review the diff before
 * committing.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { generateText, type LanguageModel, type LanguageModelUsage, tool } from "ai";
import { z } from "zod";
import type { ModelInfo, PricedUsage, UsageTokens } from "../server/llm/index";
import { priceUsage } from "../server/llm/index";
import { CatalogIndex } from "../server/llm/internal/catalog-index";
import { loadBundledLayer, ModelCatalogStore } from "../server/llm/internal/catalog-store";
import { type ModelOverlay, modelOverlaySchema } from "../server/llm/internal/overlay";
import { writeFileAtomic } from "../server/model-catalog-settings";
import { type Harness, selectHarness } from "../server/provider-ids";
import {
  isProbeableProvider,
  type ProbeOutcome,
  probeApiKey,
  probeModel,
} from "../server/provider-probe";
import { ProviderHealth } from "../server/sentinels/provider-health";

/** The catalog verification reads: every built record, by exact id. */
export class VerifyCatalog {
  private index = new CatalogIndex([], () => true);

  load(rows: readonly ModelInfo[]): void {
    this.index = new CatalogIndex(rows, () => true);
  }

  rows(): ModelInfo[] {
    return [...this.index.rows()];
  }

  get(provider: string, modelId: string): ModelInfo | undefined {
    return this.index.get(provider, modelId);
  }
}

const ROOT = path.resolve(import.meta.dir, "..");
const INIT_E2E_TEST = path.join(ROOT, "tests/e2e/init-command-e2e.test.ts");

/** 32×32 solid red PNG, for the image-input check. */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mO4IyJCU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJ3LED19/LmKAAAAAElFTkSuQmCC",
  "base64",
);

/** Providers --new considers: first-party APIs hankweave can call directly. */
const FIRST_PARTY = new Set(["anthropic", "openai", "google", "deepseek", "groq"]);

/** Where each provider documents its model API (the `source` of a limit correction). */
const MODEL_API_DOCS: Record<string, string> = {
  anthropic: "https://docs.anthropic.com/en/api/models",
  openai: "https://platform.openai.com/docs/api-reference/models",
  google: "https://ai.google.dev/api/models",
  deepseek: "https://api-docs.deepseek.com/api/list-models",
  groq: "https://console.groq.com/docs/models",
};

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface CodonResult {
  passed: boolean;
  log: string;
  detail?: string;
}

type Corrections = ModelOverlay["corrections"];

export interface ModelReport {
  model: string;
  harness: string;
  confidence: string;
  priceStatus: string;
  checks: Check[];
  codon?: CodonResult;
  proposed: { corrections: Corrections };
}

const add = tool({
  description: "Add two numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => a + b,
});

const signal = () => AbortSignal.timeout(120_000);

async function attempt<T>(
  label: string,
  run: () => Promise<T>,
): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: `${label}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function checkReply(
  model: LanguageModel,
): Promise<{ check: Check; usage?: LanguageModelUsage }> {
  const reply = await attempt("reply", () =>
    generateText({
      model,
      prompt: "Reply with exactly one word: ready",
      maxOutputTokens: 256,
      abortSignal: signal(),
    }),
  );
  return {
    check: {
      name: "reply",
      passed: /ready/i.test(reply.value?.text ?? ""),
      detail: reply.error ?? `replied "${reply.value?.text.trim().slice(0, 60)}"`,
    },
    usage: reply.value?.usage,
  };
}

/** The AI SDK's token counts in the catalog's usage shape (absent counts are 0). */
function usageTokens(usage: LanguageModelUsage): UsageTokens {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cachedInputTokens ?? 0,
  };
}

function describePrice(priced: PricedUsage | null): string {
  if (!priced) return "no price";
  return `$${priced.cost.toFixed(6)}${priced.estimated ? " (ceiling estimate)" : ""}`;
}

/** Price statuses a verification can count as priced. */
const TRUSTED_PRICES = new Set(["known", "disputed"]);

/** Whether the reply's tokens price against the catalog (a known or disputed price). */
export function checkPriced(record: ModelInfo, usage: LanguageModelUsage): Check {
  const tokens = usageTokens(usage);
  const priced = priceUsage(record, tokens);
  const status = record.provenance?.priceStatus ?? "unknown";
  return {
    name: "priced",
    passed: TRUSTED_PRICES.has(status) && priced !== null && priced.cost > 0,
    detail: `${tokens.inputTokens} in / ${tokens.outputTokens} out tokens → ${describePrice(priced)} (price ${status})`,
  };
}

async function checkToolCall(model: LanguageModel, forced: boolean): Promise<Check> {
  const name = forced ? "forced-tool-choice" : "tool-call";
  const called = await attempt(name, () =>
    generateText({
      model,
      tools: { add },
      ...(forced ? { toolChoice: { type: "tool" as const, toolName: "add" as const } } : {}),
      prompt: forced ? "What is 7 plus 8?" : "Use the add tool to add 2 and 3.",
      maxOutputTokens: 512,
      abortSignal: signal(),
    }),
  );
  const calls = called.value?.toolCalls ?? [];
  return {
    name,
    passed: calls.some((c) => c.toolName === "add"),
    detail: called.error ?? `${calls.length} tool call(s)`,
  };
}

async function checkImage(model: LanguageModel): Promise<Check> {
  const image = await attempt("image-input", () =>
    generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What color fills this image? Answer with one word." },
            { type: "image", image: RED_PNG, mediaType: "image/png" },
          ],
        },
      ],
      maxOutputTokens: 256,
      abortSignal: signal(),
    }),
  );
  return {
    name: "image-input",
    passed: /red/i.test(image.value?.text ?? ""),
    detail: image.error ?? `answered "${image.value?.text.trim().slice(0, 60)}"`,
  };
}

async function checkContext(model: LanguageModel, record: ModelInfo): Promise<Check> {
  // ~4 characters per token; 90% of the window leaves room for the reply.
  const filler = "lorem ipsum ".repeat(Math.floor((record.limit.context * 0.9 * 4) / 12));
  const probe = await attempt("context-probe", () =>
    generateText({
      model,
      prompt: `${filler}\n\nIgnore the text above. Reply with one word: ok`,
      maxOutputTokens: 64,
      abortSignal: AbortSignal.timeout(600_000),
    }),
  );
  const approx = Math.round(record.limit.context * 0.9).toLocaleString();
  return {
    name: "context-probe",
    passed: /ok/i.test(probe.value?.text ?? ""),
    detail:
      probe.error ??
      `accepted ~${approx} tokens (${probe.value?.usage.inputTokens ?? "?"} reported)`,
  };
}

/** The direct-API battery for one model. */
export async function runBattery(
  record: ModelInfo,
  model: LanguageModel,
  options: { contextProbe?: boolean } = {},
): Promise<Check[]> {
  const reply = await checkReply(model);
  const checks = [reply.check];
  if (reply.usage) checks.push(checkPriced(record, reply.usage));
  if (record.tool_call) {
    checks.push(await checkToolCall(model, false), await checkToolCall(model, true));
  }
  if (record.modalities.input.includes("image")) checks.push(await checkImage(model));
  if (options.contextProbe) checks.push(await checkContext(model, record));
  return checks;
}

/** One real codon through the init e2e test, with the model as the global override. */
export function runCodon(key: string, logDir: string): Promise<CodonResult> {
  fs.mkdirSync(logDir, { recursive: true });
  const { promise, resolve } = Promise.withResolvers<CodonResult>();
  const chunks: Buffer[] = [];
  const proc = spawn("bun", ["test", INIT_E2E_TEST], {
    cwd: ROOT,
    env: {
      ...process.env,
      HANKWEAVE_RUNTIME_MODEL: key,
      HANKWEAVE_E2E_TEST_ID: key.replace(/[^a-zA-Z0-9]/g, "-"),
    },
  });
  proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  proc.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  proc.on("close", (code) => {
    const output = Buffer.concat(chunks).toString();
    const log = path.join(logDir, "init-e2e.log");
    fs.writeFileSync(log, output);
    const failure = output.split("\n").find((l) => l.includes("(fail)") || /error:/i.test(l));
    resolve(
      code === 0
        ? { passed: true, log }
        : { passed: false, log, detail: failure?.trim() ?? `exit code ${code}` },
    );
  });
  return promise;
}

/** A limit correction where the provider's own model API disagrees with the catalog. */
export function limitCorrection(record: ModelInfo, outcome: ProbeOutcome): Corrections {
  if (outcome.status !== "found" || !outcome.record.limit) return [];
  const { context, output } = outcome.record.limit;
  const limit: { context?: number; output?: number } = {};
  if (context && context !== record.limit.context) limit.context = context;
  if (output && output !== record.limit.output) limit.output = output;
  if (Object.keys(limit).length === 0) return [];
  return [
    {
      model: `${record.providerId}/${record.modelId}`,
      limit,
      reason:
        `The provider's model API reports ${context ?? "?"} context / ${output ?? "?"} output ` +
        `tokens; the catalog had ${record.limit.context} / ${record.limit.output}`,
      source: MODEL_API_DOCS[record.providerId] ?? "https://models.dev",
    },
  ];
}

/** Merge proposed corrections into an overlay, field by field per model. */
export function mergeProposals(
  overlay: ModelOverlay,
  reports: readonly ModelReport[],
  today: string,
): ModelOverlay {
  const corrections = new Map(overlay.corrections.map((c) => [c.model, c]));
  for (const { proposed } of reports) {
    for (const correction of proposed.corrections) {
      corrections.set(correction.model, { ...corrections.get(correction.model), ...correction });
    }
  }
  return {
    ...overlay,
    updated: today,
    corrections: [...corrections.values()],
  };
}

/**
 * Models --new checks: in the catalog but not the bundled snapshot (new since
 * the last release), from a first-party provider whose credentials are
 * available.
 */
export function newModelKeys(
  rows: readonly ModelInfo[],
  bundledKeys: ReadonlySet<string>,
  availableProviders: ReadonlySet<string>,
): string[] {
  return rows
    .filter((row) => {
      const key = `${row.providerId}/${row.modelId}`.toLowerCase();
      const provider = row.providerId.toLowerCase();
      return FIRST_PARTY.has(provider) && availableProviders.has(provider) && !bundledKeys.has(key);
    })
    .map((row) => `${row.providerId}/${row.modelId}`);
}

export interface VerifyOptions {
  keys: string[];
  newModels: boolean;
  codon: boolean;
  contextProbe: boolean;
  jsonPath?: string;
  writeOverlay: boolean;
  checkOverlay?: string;
}

/** Parse the CLI's arguments (see scripts/verify-models.ts). */
export function parseVerifyArgs(argv: readonly string[]): VerifyOptions {
  const flagValue = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const valueFlags = new Set(["--json", "--check-overlay"]);
  return {
    keys: argv.filter((a, i) => !a.startsWith("--") && !valueFlags.has(argv[i - 1] ?? "")),
    newModels: argv.includes("--new"),
    codon: argv.includes("--codon"),
    contextProbe: argv.includes("--context-probe"),
    jsonPath: flagValue("--json"),
    writeOverlay: argv.includes("--write-overlay"),
    checkOverlay: flagValue("--check-overlay"),
  };
}

/** Validate an overlay file against the overlay schema: 0 when valid, 1 otherwise. */
export function checkOverlayFile(filePath: string, log: (line: string) => void): number {
  const parsed = modelOverlaySchema.safeParse(JSON.parse(fs.readFileSync(filePath, "utf-8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    log(`Invalid overlay: ${issues.join("; ")}`);
    return 1;
  }
  log("Overlay is valid.");
  return 0;
}

/** What verification needs from the outside world; tests substitute each. */
export interface VerifyDeps {
  store: ModelCatalogStore;
  /** The store's catalog, loaded by runVerifyModels. */
  catalog: VerifyCatalog;
  /** The model to call for a record, or why it cannot be called. */
  languageModelFor: (record: ModelInfo) => Promise<LanguageModel | string>;
  probe: (record: ModelInfo) => Promise<ProbeOutcome>;
  codon: (key: string) => Promise<CodonResult>;
  availableProviders: () => Promise<ReadonlySet<string>>;
  log: (line: string) => void;
  overlayPath: string;
  today: () => string;
}

/** A battery failure other than an unpriced model; pricing is reported, not required. */
const batteryPassed = (checks: readonly Check[]) =>
  checks.every((c) => c.passed || c.name === "priced");

async function batteryFor(
  record: ModelInfo,
  options: VerifyOptions,
  deps: VerifyDeps,
): Promise<Check[]> {
  const model = await deps.languageModelFor(record);
  if (typeof model === "string") {
    return [{ name: "provider", passed: false, detail: `direct API unavailable: ${model}` }];
  }
  return runBattery(record, model, { contextProbe: options.contextProbe });
}

/** Verify one model: battery, optional codon, and any limit correction. */
export async function verifyModel(
  record: ModelInfo,
  options: VerifyOptions,
  deps: VerifyDeps,
): Promise<ModelReport> {
  const key = `${record.providerId}/${record.modelId}`;
  // selectModels keeps only models a harness runs.
  const harness = selectHarness(record) as Harness;
  const checks = await batteryFor(record, options, deps);
  const codon = options.codon ? await deps.codon(key) : undefined;
  return {
    model: key,
    harness,
    confidence: record.provenance?.confidence ?? "registry",
    priceStatus: record.provenance?.priceStatus ?? "unknown",
    checks,
    ...(codon ? { codon } : {}),
    proposed: { corrections: limitCorrection(record, await deps.probe(record)) },
  };
}

function printReport(report: ModelReport, log: (line: string) => void): void {
  log(`\n${report.model} (${report.harness}, ${report.confidence}, price ${report.priceStatus})`);
  for (const c of report.checks) log(`  ${c.passed ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  if (report.codon) {
    log(
      `  ${report.codon.passed ? "✓" : "✗"} codon (${report.harness}): ${report.codon.detail ?? "passed"} — ${report.codon.log}`,
    );
  }
}

/** The models to verify: the explicit keys, or --new's selection from the catalog. */
async function selectModels(options: VerifyOptions, deps: VerifyDeps): Promise<ModelInfo[]> {
  const keys = options.newModels
    ? newModelKeys(
        deps.catalog.rows(),
        new Set(loadBundledLayer().rows.map((r) => `${r.providerId}/${r.modelId}`.toLowerCase())),
        await deps.availableProviders(),
      )
    : options.keys;
  const records: ModelInfo[] = [];
  for (const key of keys) {
    const slash = key.indexOf("/");
    const record = deps.catalog.get(key.substring(0, slash), key.substring(slash + 1));
    if (!record) deps.log(`! ${key}: not in the model catalog`);
    else if (!selectHarness(record)) deps.log(`! ${key}: no harness runs its provider`);
    else records.push(record);
  }
  return records;
}

function writeOutputs(reports: ModelReport[], options: VerifyOptions, deps: VerifyDeps): void {
  const output = JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2);
  if (options.jsonPath) {
    fs.writeFileSync(options.jsonPath, `${output}\n`);
    deps.log(`\nReport written to ${options.jsonPath}`);
  } else {
    deps.log(`\n${output}`);
  }
  if (!options.writeOverlay) return;
  const current = modelOverlaySchema.parse(JSON.parse(fs.readFileSync(deps.overlayPath, "utf-8")));
  const next = modelOverlaySchema.parse(mergeProposals(current, reports, deps.today()));
  writeFileAtomic(deps.overlayPath, `${JSON.stringify(next, null, 2)}\n`);
  deps.log(`Updated ${deps.overlayPath}; review the diff before committing.`);
}

/** Run the verification loop; returns the process exit code. */
export async function runVerifyModels(options: VerifyOptions, deps: VerifyDeps): Promise<number> {
  if (options.checkOverlay) return checkOverlayFile(options.checkOverlay, deps.log);
  for (const r of await deps.store.refresh(["models.dev", "litellm"], {
    force: options.newModels,
  })) {
    if (r.outcome === "failed") deps.log(`! ${r.source}: ${r.detail}`);
  }
  deps.catalog.load(deps.store.build().rows);
  const records = await selectModels(options, deps);
  if (records.length === 0) {
    deps.log(
      "Nothing to verify. Usage: bun scripts/verify-models.ts <provider/model …> [--new] [--codon] [--context-probe] [--json file] [--write-overlay]",
    );
    return 1;
  }
  const reports: ModelReport[] = [];
  for (const record of records) {
    const report = await verifyModel(record, options, deps);
    printReport(report, deps.log);
    reports.push(report);
  }
  writeOutputs(reports, options, deps);
  const failed = reports.some((r) => !batteryPassed(r.checks) || r.codon?.passed === false);
  return failed ? 1 : 0;
}

/** The real world: live providers, the default catalog, the repo's overlay. */
export function liveVerifyDeps(): VerifyDeps {
  const catalog = new VerifyCatalog();
  const registry = new ProviderHealth({ models: catalog });
  let checked: Promise<ReadonlySet<string>> | undefined;
  const availableProviders = () => {
    // Providers count as unhealthy until checked; the check lists models (free).
    checked ??= registry
      .performHealthChecks()
      .then(
        (statuses) =>
          new Set(
            [...statuses]
              .filter(([, s]) => s.status === "available" && s.healthy)
              .map(([id]) => id),
          ),
      );
    return checked;
  };
  return {
    store: new ModelCatalogStore(),
    catalog,
    languageModelFor: async (record) => {
      await availableProviders();
      const provider = registry.getProviderForModel(`${record.providerId}/${record.modelId}`);
      return provider.success ? provider.model : provider.reason;
    },
    probe: (record) =>
      isProbeableProvider(record.providerId)
        ? probeModel(record.providerId, record.modelId, probeApiKey(record.providerId, process.env))
        : Promise.resolve({ status: "skipped", reason: "not probeable" }),
    codon: (key) => runCodon(key, path.join(ROOT, "new-models-dev", key)),
    availableProviders,
    log: (line) => console.log(line),
    overlayPath: path.join(ROOT, "server/llm/internal/model-overlay.json"),
    today: () => new Date().toISOString().substring(0, 10),
  };
}
