import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { hankFileSchema } from "../../server/config.js";
import { ClaudeModelCheck } from "../../server/harness/claude/model-check.js";
import { PiModelCheck } from "../../server/harness/pi/model-check.js";
import { userModelsJsonPath } from "../../server/harness/pi/routing.js";
import { modelHarnesses } from "../../server/harnesses.js";
import {
  type HarnessCheckOptions,
  type HarnessCheckResult,
  type HarnessModelCheck,
  type ModelCheck,
  type ModelInfo,
  Models,
  type ModelsLoadOptions,
  priceUsage,
  type RawModelConfigs,
} from "../../server/llm/index.js";
import { recordConfiguredNoOnlineModelChecks } from "../../server/model-catalog-settings.js";
import {
  createPiModelRuntime,
  freezePiModelsStore,
  refreshPiProvider,
  storeModels,
} from "../../server/pi-model-catalog.js";
import { checkPiModel, lookupPiModel } from "../../server/pi-sdk-manager.js";
import { AiSdkModelCheck } from "../../server/sentinels/model-check.js";
import { Logger } from "../../server/utils.js";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";

/**
 * The harness checks behind Models (spec 72, stage 2) and the edges between
 * them and the catalog: the pricing mapping never decides runnability, a
 * harness-only record is budgeted, Pi's offline catalog answers parse mode,
 * class C/E/F/G texts, Bedrock never asks Anthropic, sentinels read the
 * process environment, and parse mode needs no credentials.
 *
 * Hermetic: a temp catalog directory and Pi agent directory, no provider
 * credentials in process.env, and a globalThis.fetch that records every
 * request and refuses any a test did not expect.
 */

interface SeenRequest {
  url: string;
  headers: Record<string, string>;
}

type FetchHandler = (url: string) => Response | Promise<Response>;

let tmp: string;
let savedEnv: Record<string, string | undefined>;
let originalFetch: typeof fetch;
let requests: SeenRequest[];
let fetchHandler: FetchHandler;
let calls: string[];

/** Credentials, base URLs and Claude/AWS switches a developer machine may carry. */
const AMBIENT =
  /(_API_KEY|_AUTH_TOKEN|_BASE_URL)$|^(AWS_|CLAUDE_|ANTHROPIC_|HANKWEAVE_)|^(HW_INTERNAL_CLAUDE_LEGACY_AUTH|PI_OFFLINE)$/;

beforeEach(() => {
  savedEnv = captureEnv();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hw-harness-checks-"));
  for (const key of Object.keys(process.env)) {
    if (AMBIENT.test(key)) delete process.env[key];
  }
  process.env.PI_CODING_AGENT_DIR = path.join(tmp, "pi-agent");
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  process.env.HANKWEAVE_MODEL_CATALOG_DIR = path.join(tmp, "catalog");
  process.env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS = "1";
  // The developer's ~/.aws and an EC2 metadata endpoint never decide Bedrock auth here.
  process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(tmp, "aws-credentials");
  process.env.AWS_CONFIG_FILE = path.join(tmp, "aws-config");
  process.env.AWS_EC2_METADATA_DISABLED = "true";

  calls = [];
  requests = [];
  fetchHandler = (url) => {
    throw new Error(`unexpected network request: ${url}`);
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [k, v] of new Headers(init?.headers)) headers.set(k, v);
    requests.push({ url, headers: Object.fromEntries(headers) });
    return fetchHandler(url);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv(savedEnv);
  Models.loadForParsing({}, { harnesses: modelHarnesses(), bundledOnly: true });
  recordConfiguredNoOnlineModelChecks(false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// === Helpers ===

type Answer = (
  provider: string,
  modelId: string,
  env: NodeJS.ProcessEnv,
  opts: HarnessCheckOptions,
) => HarnessCheckResult | Promise<HarnessCheckResult>;

function fakeHarness(
  harness: string,
  providers: string[],
  options: { label?: string; answer?: Answer; adopt?: HarnessModelCheck["adopt"] } = {},
): HarnessModelCheck {
  return {
    harness,
    label: options.label ?? harness,
    providers: () => providers,
    runs: (provider) => providers.includes(provider),
    async check(provider, modelId, env, opts) {
      calls.push(`${harness}:${provider}/${modelId}`);
      return (options.answer ?? (() => ({ ok: true, evidence: `${harness} says yes` })))(
        provider,
        modelId,
        env,
        opts,
      );
    },
    ...(options.adopt ? { adopt: options.adopt } : {}),
  };
}

const claude = (options: Parameters<typeof fakeHarness>[2] = {}) =>
  fakeHarness("claude-agent-sdk", ["anthropic"], { label: "the Claude Agent SDK", ...options });
const pi = (options: Parameters<typeof fakeHarness>[2] = {}) =>
  fakeHarness("pi", ["anthropic", "deepseek", "openai", "openai-codex"], {
    label: "Pi",
    ...options,
  });

function codon(id: string, model: string) {
  return { id, name: id, model, continuationMode: "fresh", promptText: "x" };
}

const hankOf = (models: string[]) => ({ hank: models.map((model, i) => codon(`c${i}`, model)) });

function load(raw: RawModelConfigs, options: Partial<ModelsLoadOptions> = {}): Promise<Models> {
  return Models.load({
    raw,
    harnesses: { codon: [claude(), pi()], sentinel: [] },
    env: {},
    network: false,
    prerequisites: true,
    background: false,
    catalogDir: path.join(tmp, "catalog"),
    ...options,
  });
}

function failed(result: ModelCheck) {
  if (result.ok)
    throw new Error(`expected a failure, got ${result.model.providerId}/${result.model.modelId}`);
  return result;
}

function confirmed(result: ModelCheck): ModelInfo {
  if (!result.ok) throw new Error(`expected a model, got ${result.kind}: ${result.message}`);
  return result.model;
}

function failedCheck(result: HarnessCheckResult) {
  if (result.ok) throw new Error(`expected a failed check, got ok (${result.evidence})`);
  return result;
}

const checkOptions = (overrides: Partial<HarnessCheckOptions> = {}): HarnessCheckOptions => ({
  network: false,
  timeoutMs: 2_000,
  knownToCatalog: () => false,
  ...overrides,
});

const unknownToPi: Answer = (provider, modelId) => ({
  ok: false,
  kind: "unknown-model",
  message: `Pi has no model '${provider}/${modelId}'.`,
  candidates: [],
});

/** A row as pi stores it in its models store (pi-models-store.json). */
const storeRow = (id: string) => ({
  id,
  name: "DeepSeek Store Only",
  reasoning: true,
  input: ["text"],
  cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0 },
  contextWindow: 333_000,
  maxTokens: 22_000,
  api: "openai-completions",
  provider: "deepseek",
});

function writePiStore(entries: Record<string, unknown>): void {
  const catalogDir = process.env.HANKWEAVE_MODEL_CATALOG_DIR as string;
  fs.mkdirSync(catalogDir, { recursive: true });
  fs.writeFileSync(path.join(catalogDir, "pi-models-store.json"), JSON.stringify(entries));
  // This process reads its own copy of the store from here on, as a run does.
  freezePiModelsStore();
}

// === Tests ===

describe("the pricing mapping never decides runnability", () => {
  it("does not adopt openai-codex/gpt-4o from the openai/gpt-4o record", async () => {
    const adopt = mock(async () => ({ ok: true as const, evidence: "adopted" }));
    const models = await load(
      { hank: hankOf(["openai-codex/gpt-4o"]) },
      { harnesses: { codon: [claude(), pi({ adopt, answer: unknownToPi })], sentinel: [] } },
    );

    // The openai record exists; it prices openai-codex but cannot vouch for it.
    expect(models.get("openai", "gpt-4o")).toBeDefined();
    expect(adopt).not.toHaveBeenCalled();
    expect(calls).toEqual(["pi:openai-codex/gpt-4o"]);
    expect(failed(models.check("openai-codex/gpt-4o"))).toMatchObject({
      kind: "unknown-model",
      stage: "harness",
    });
  });

  it("parse mode asks Pi's offline catalog for openai-codex ids and prices them as openai", () => {
    const models = Models.loadForParsing({}, { harnesses: modelHarnesses(), bundledOnly: true });

    // Pi's openai-codex provider has no gpt-4o, whatever hankweave knows about openai/gpt-4o.
    expect(failed(models.check("openai-codex/gpt-4o")).kind).toBe("unknown-model");

    const sol = confirmed(models.check("openai-codex/gpt-5.6-sol"));
    const openai = models.get("openai", "gpt-5.6-sol");
    if (!openai) throw new Error("the bundled catalog has no openai/gpt-5.6-sol");
    expect(sol.providerId).toBe("openai-codex");
    expect(sol.cost).toEqual(openai.cost);
    expect(sol.provenance).toMatchObject({
      evidence: "pi catalog (parse mode)",
      source: openai.provenance?.source,
    });
  });

  // For a harness with no list of its own (parse mode, the Claude route) the
  // closest ids come from the pricing provider's rows, filtered to ids the
  // harness itself lists: a suggestion must pass the same check.
  it("suggests only ids that are themselves accepted for an openai-codex miss", () => {
    const models = Models.loadForParsing({}, { harnesses: modelHarnesses(), bundledOnly: true });

    const miss = failed(models.check("openai-codex/gpt-4o"));

    expect(miss.suggestions.length).toBeGreaterThan(0);
    for (const suggestion of miss.suggestions) expect(models.check(suggestion).ok).toBe(true);
  });

  it("hands the Claude check an exact catalog lookup", async () => {
    let knownToCatalog: HarnessCheckOptions["knownToCatalog"] | undefined;
    await load(
      { hank: hankOf(["anthropic/claude-haiku-4-5"]) },
      {
        harnesses: {
          codon: [
            claude({
              answer: (_provider, _modelId, _env, opts) => {
                knownToCatalog = opts.knownToCatalog;
                return { ok: true, evidence: "catalog" };
              },
            }),
            pi(),
          ],
          sentinel: [],
        },
      },
    );

    if (!knownToCatalog) throw new Error("the Claude check was not asked");
    expect(knownToCatalog("anthropic", "claude-haiku-4-5")).toBe(true);
    expect(knownToCatalog("openai", "gpt-5.6-sol")).toBe(true);
    // No pricing provider, no case folding.
    expect(knownToCatalog("openai-codex", "gpt-5.6-sol")).toBe(false);
    expect(knownToCatalog("anthropic", "Claude-Haiku-4-5")).toBe(false);
  });
});

describe("a harness-only record with no price", () => {
  it("gets the catalog's ceiling estimate, so budgets still count it", async () => {
    const models = await load(
      { hank: hankOf(["deepseek/deepseek-v99", "deepseek/deepseek-v98"]) },
      {
        harnesses: {
          codon: [
            claude(),
            pi({
              answer: (_provider, modelId) => ({
                ok: true,
                evidence: "pi catalog",
                row: {
                  name: modelId,
                  limit: { context: 1_000_000, output: 64_000 },
                  // Pi's default for an unpriced row: zeros.
                  ...(modelId === "deepseek-v98"
                    ? { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }
                    : {}),
                },
              }),
            }),
          ],
          sentinel: [],
        },
      },
    );

    for (const spelling of ["deepseek/deepseek-v99", "deepseek/deepseek-v98"]) {
      const model = confirmed(models.check(spelling));
      expect(model.cost).toBeUndefined();
      expect(model.provenance).toMatchObject({ confidence: "harness", priceStatus: "unknown" });
      const budget = model.provenance?.budgetCost;
      if (!budget) throw new Error(`${spelling} has no ceiling estimate`);
      expect(budget.input).toBeGreaterThan(0);
      expect(budget.output).toBeGreaterThan(0);
      expect(model.provenance?.budgetCostBasis).toStartWith("ceiling estimate");

      const priced = priceUsage(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
      expect(priced).not.toBeNull();
      expect(priced?.estimated).toBe(true);
      expect(priced?.cost).toBeCloseTo(budget.input + budget.output, 9);
    }
  });
});

describe("Pi's offline catalog (parse mode)", () => {
  it("finds a model only Pi's models store lists, with the store's price and limits", () => {
    writePiStore({
      deepseek: {
        models: [storeRow("deepseek-store-only-1")],
        checkedAt: Date.now(),
        lastModified: Date.now(),
      },
    });
    const models = Models.loadForParsing({}, { harnesses: modelHarnesses() });

    const model = confirmed(models.check("deepseek/deepseek-store-only-1"));
    expect(model).toMatchObject({
      providerId: "deepseek",
      modelId: "deepseek-store-only-1",
      name: "DeepSeek Store Only",
      cost: { input: 0.5, output: 1.5, cache_read: 0.05 },
      limit: { context: 333_000, output: 22_000 },
      reasoning: true,
    });
    expect(model.provenance).toMatchObject({
      confidence: "harness",
      priceStatus: "known",
      evidence: "pi catalog (parse mode)",
    });
  });

  // Pi ignores a store entry whose lastModified is missing or not newer than
  // its vendored snapshot (remote-catalog-provider.js remoteModels) — the
  // shape pi itself writes after a 404. Parse mode must ignore it too, or it
  // accepts a model the run's Pi check rejects.
  it("agrees with Pi about a store entry Pi ignores as stale", async () => {
    writePiStore({
      deepseek: { models: [storeRow("deepseek-store-only-2")], checkedAt: Date.now() },
    });
    const run = await checkPiModel(
      "deepseek",
      "deepseek-store-only-2",
      { DEEPSEEK_API_KEY: "sk-test-never-valid" },
      { network: false },
    );
    const parse = Models.loadForParsing({}, { harnesses: modelHarnesses() }).check(
      "deepseek/deepseek-store-only-2",
    );

    expect(run.ok).toBe(false);
    expect(parse.ok).toBe(run.ok);
  });

  it("takes an effort suffix only on a reasoning model", () => {
    const piCheck = new PiModelCheck();
    expect(piCheck.offlineRow("openai", "gpt-5.6-sol-high")?.reasoning).toBe(true);
    expect(piCheck.offlineRow("openai", "gpt-4o")).toBeDefined();
    expect(piCheck.offlineRow("openai", "gpt-4o-xhigh")).toBeUndefined();

    const models = Models.loadForParsing({}, { harnesses: modelHarnesses(), bundledOnly: true });
    confirmed(models.check("openai/gpt-5.6-sol-high"));
    expect(confirmed(models.check("openai-codex/gpt-5.6-sol-high")).provenance?.evidence).toBe(
      "pi catalog (parse mode)",
    );
    expect(failed(models.check("openai/gpt-4o-xhigh")).kind).toBe("unknown-model");
  });

  it("lookupPiModel does not fall back from gpt-4o-xhigh to the non-reasoning gpt-4o", async () => {
    const runtime = await createPiModelRuntime();
    expect(runtime.getModel("openai", "gpt-4o")).toBeDefined();

    expect(lookupPiModel(runtime, "openai", "gpt-4o-xhigh").model).toBeUndefined();
    const sol = lookupPiModel(runtime, "openai", "gpt-5.6-sol-xhigh");
    expect(sol.model?.id).toBe("gpt-5.6-sol");
    expect(sol.thinkingLevel).toBe("xhigh");
  });

  it("storeModels ignores rows another provider's name is on, as Pi does", async () => {
    writePiStore({
      deepseek: {
        models: [
          storeRow("deepseek-store-own"),
          { ...storeRow("deepseek-store-foreign"), provider: "openai" },
          { ...storeRow("deepseek-store-unlabelled"), provider: undefined },
        ],
        checkedAt: Date.now(),
        lastModified: Date.now(),
      },
    });

    expect(storeModels("deepseek").map((row) => (row as { id: string }).id)).toEqual([
      "deepseek-store-own",
      "deepseek-store-unlabelled",
    ]);
    expect(storeModels("openai")).toEqual([]);
    const piCheck = new PiModelCheck();
    expect(piCheck.offlineRow("deepseek", "deepseek-store-own")).toBeDefined();
    expect(piCheck.offlineRow("deepseek", "deepseek-store-foreign")).toBeUndefined();
    expect(piCheck.offlineRow("openai", "deepseek-store-foreign")).toBeUndefined();

    // A run's Pi check agrees with parse mode about the foreign row.
    const run = await checkPiModel(
      "deepseek",
      "deepseek-store-foreign",
      { DEEPSEEK_API_KEY: "sk-test-never-valid" },
      { network: false },
    );
    expect(run.ok).toBe(false);
  });
});

/** Write $PI_CODING_AGENT_DIR/models.json. */
function writeUserModelsJson(content: unknown): void {
  fs.writeFileSync(userModelsJsonPath(), JSON.stringify(content, null, 2));
}

/** A Pi runtime over the user's models.json and the shared store, as Pi itself composes them. */
function piRuntimeOverUserFiles(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    modelsPath: userModelsJsonPath(),
    modelsStorePath: path.join(
      process.env.HANKWEAVE_MODEL_CATALOG_DIR as string,
      "pi-models-store.json",
    ),
  });
}

describe("Pi's offline row composition", () => {
  const solRow = (contextWindow: number) => ({
    id: "gpt-5.6-sol",
    name: `Sol ${contextWindow}`,
    api: "openai-responses",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 10_000,
  });

  it("models.json over the pi.dev store over the vendored row", () => {
    const piCheck = new PiModelCheck();
    const vendored = piCheck.offlineRow("openai", "gpt-5.6-sol")?.limit?.context;
    expect(vendored).toBeDefined();
    expect([111_111, 222_222]).not.toContain(vendored);

    writePiStore({
      openai: {
        models: [{ ...solRow(111_111), provider: "openai" }],
        checkedAt: Date.now(),
        lastModified: Date.now(),
      },
    });
    expect(piCheck.offlineRow("openai", "gpt-5.6-sol")?.limit?.context).toBe(111_111);

    writeUserModelsJson({ providers: { openai: { models: [solRow(222_222)] } } });
    expect(piCheck.offlineRow("openai", "gpt-5.6-sol")).toMatchObject({
      name: "Sol 222222",
      limit: { context: 222_222 },
    });
  });

  it("modelOverrides change the row, and a non-reasoning override drops the effort suffix", async () => {
    const piCheck = new PiModelCheck();
    expect(piCheck.offlineRow("openai", "gpt-5.6-sol-high")).toBeDefined();
    expect(piCheck.offlineRow("openai-codex", "gpt-5.6-sol-high")).toBeDefined();

    writeUserModelsJson({
      providers: {
        openai: {
          modelOverrides: { "gpt-5.6-sol": { reasoning: false, contextWindow: 99_999 } },
        },
        "openai-codex": { modelOverrides: { "gpt-5.6-sol": { reasoning: false } } },
      },
    });

    expect(piCheck.offlineRow("openai", "gpt-5.6-sol")).toMatchObject({
      reasoning: false,
      limit: { context: 99_999 },
    });
    expect(piCheck.offlineRow("openai", "gpt-5.6-sol-high")).toBeUndefined();
    expect(piCheck.offlineRow("openai-codex", "gpt-5.6-sol-high")).toBeUndefined();
    // Parse mode: hankweave's catalog has no openai-codex rows, so Pi's row decides.
    const models = Models.loadForParsing({}, { harnesses: modelHarnesses(), bundledOnly: true });
    expect(failed(models.check("openai-codex/gpt-5.6-sol-high")).kind).toBe("unknown-model");
    expect(confirmed(models.check("openai-codex/gpt-5.6-sol")).limit.context).toBeGreaterThan(0);

    // Pi composes the same row.
    const runtime = await piRuntimeOverUserFiles();
    expect(runtime.getModel("openai", "gpt-5.6-sol")).toMatchObject({
      reasoning: false,
      contextWindow: 99_999,
    });
  });
});

describe("Pi unreachable (class F)", () => {
  it("refreshPiProvider tells onError when the refresh throws", async () => {
    process.env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS = "0";
    const runtime = await createPiModelRuntime();
    spyOn(runtime, "refresh").mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED pi.dev");
    });
    const errors: unknown[] = [];

    const found = await refreshPiProvider(runtime, "deepseek", "deepseek-v99", {
      network: true,
      onError: (error) => errors.push(error),
    });

    expect(found).toBe(false);
    expect(errors.map((e) => (e as Error).message)).toEqual(["connect ECONNREFUSED pi.dev"]);
  });

  // pi's ModelRuntime.refresh does not throw for a failed provider — it
  // returns { aborted, errors } — so refreshPiProvider reads the result: a
  // pi.dev outage is class F, not "Pi has no model".
  it("refreshPiProvider tells onError when pi.dev fails", async () => {
    process.env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS = "0";
    process.env.DEEPSEEK_API_KEY = "sk-test-never-valid";
    fetchHandler = () => {
      throw new Error("connect ECONNREFUSED pi.dev");
    };
    const runtime = await createPiModelRuntime();
    const errors: unknown[] = [];

    await refreshPiProvider(runtime, "deepseek", "deepseek-v99", {
      network: true,
      onError: (error) => errors.push(error),
    });

    expect(requests.some((r) => r.url.startsWith("https://pi.dev/"))).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("refreshPiProvider asks pi.dev for '<id>-high' when <id> is not a reasoning model", async () => {
    process.env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS = "0";
    process.env.OPENAI_API_KEY = "sk-test-never-valid";
    fetchHandler = () => {
      throw new Error("connect ECONNREFUSED pi.dev");
    };
    // An empty store: an earlier test's fresh openai entry would let pi skip the refresh.
    writePiStore({});
    const runtime = await createPiModelRuntime();
    expect(runtime.getModel("openai", "gpt-4o")?.reasoning).toBe(false);

    // A reasoning base is already Pi's: no request.
    expect(await refreshPiProvider(runtime, "openai", "gpt-5.6-sol-high", { network: true })).toBe(
      true,
    );
    expect(requests).toEqual([]);

    const found = await refreshPiProvider(runtime, "openai", "gpt-4o-high", { network: true });

    expect(found).toBe(false);
    expect(requests.some((r) => r.url.startsWith("https://pi.dev/"))).toBe(true);
  });

  it("checkPiModel reports a pi.dev failure as unreachable", async () => {
    process.env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS = "0";
    process.env.DEEPSEEK_API_KEY = "sk-test-never-valid";
    fetchHandler = () => {
      throw new Error("connect ECONNREFUSED pi.dev");
    };

    const result = failedCheck(
      await checkPiModel("deepseek", "deepseek-v99", { ...process.env }, { network: true }),
    );

    expect(result.kind).toBe("unreachable");
    expect(result.message).toStartWith(
      "Could not check 'deepseek/deepseek-v99' with Pi: pi.dev did not answer",
    );
  });

  it("Models adopts a model the harness could not check when the catalog has a record", async () => {
    const adopted = new Set<string>();
    const adopt = mock(
      async (
        provider: string,
        modelId: string,
        _record: ModelInfo,
        siblings: readonly ModelInfo[],
      ) => {
        adopted.add(`${provider}/${modelId}`);
        return { ok: true as const, evidence: `adopted from ${provider}/${siblings[0]?.modelId}` };
      },
    );
    const answer: Answer = (provider, modelId) =>
      adopted.has(`${provider}/${modelId}`)
        ? { ok: true, evidence: "pi catalog" }
        : {
            ok: false,
            kind: "unreachable",
            message: `Could not check '${provider}/${modelId}' with Pi: pi.dev did not answer (offline).`,
            candidates: [],
          };
    const models = await load(
      { hank: hankOf(["deepseek/deepseek-v4-pro", "deepseek/deepseek-v99"]) },
      { harnesses: { codon: [claude(), pi({ adopt, answer })], sentinel: [] } },
    );

    // A registry record: adopted, then checked again.
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt.mock.calls[0]?.[2]).toMatchObject({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    });
    expect(confirmed(models.check("deepseek/deepseek-v4-pro")).provenance?.evidence).toStartWith(
      "adopted from deepseek/",
    );
    // No record: the harness's answer stands.
    expect(failed(models.check("deepseek/deepseek-v99"))).toMatchObject({
      kind: "unreachable",
      message: "Could not check 'deepseek/deepseek-v99' with Pi: pi.dev did not answer (offline).",
    });
  });
});

describe("message texts", () => {
  it("C, Pi: returns Pi's ids for the provider as candidates and names the 'models' block", async () => {
    const ids = (await createPiModelRuntime())
      .getModels("deepseek")
      .map((m) => m.id)
      .sort();

    const result = failedCheck(
      await checkPiModel(
        "deepseek",
        "deepseek-v99",
        { DEEPSEEK_API_KEY: "sk-test-never-valid" },
        { network: false },
      ),
    );

    expect(result).toMatchObject({
      kind: "unknown-model",
      message:
        `Pi has no model 'deepseek/deepseek-v99' (checked its catalog; online model checks are off). ` +
        "A model newer than Pi's catalog that hankweave's catalog lists (models.dev, or a 'models' block entry for a provider the catalog has) is added to Pi's catalog from its newest sibling.",
      candidates: ids.map((id) => `deepseek/${id}`),
    });
    expect(requests).toEqual([]);
  });

  it("C, Claude keyless: says Anthropic could not be asked, without asking", async () => {
    process.env.HW_INTERNAL_CLAUDE_LEGACY_AUTH = "1";

    const result = failedCheck(
      await new ClaudeModelCheck().check(
        "anthropic",
        "claude-sonnet-99",
        { PATH: process.env.PATH },
        checkOptions({ network: true }),
      ),
    );

    expect(result).toMatchObject({
      kind: "unknown-model",
      message:
        "Could not ask Anthropic about 'anthropic/claude-sonnet-99' (no ANTHROPIC_API_KEY; the Claude login cannot list models) and the model catalog does not list it.",
    });
    expect(requests).toEqual([]);
  });

  it("C, Claude keyless behind ANTHROPIC_BASE_URL: still not asked, no request", async () => {
    process.env.HW_INTERNAL_CLAUDE_LEGACY_AUTH = "1";
    process.env.ANTHROPIC_BASE_URL = "http://gateway.invalid";

    const result = failedCheck(
      await new ClaudeModelCheck().check(
        "anthropic",
        "claude-sonnet-99",
        { PATH: process.env.PATH, ANTHROPIC_BASE_URL: "http://gateway.invalid" },
        checkOptions({ network: true }),
      ),
    );

    expect(result.kind).toBe("unknown-model");
    expect(result.message).toStartWith(
      "Could not ask Anthropic about 'anthropic/claude-sonnet-99' (no ANTHROPIC_API_KEY",
    );
    expect(requests).toEqual([]);
  });

  it("C, Claude on Bedrock: a catalog miss names the 'models' block", async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer-token";

    const result = failedCheck(
      await new ClaudeModelCheck().check(
        "amazon-bedrock",
        "us.anthropic.claude-haiku-9-9-20990101-v1:0",
        { PATH: process.env.PATH },
        checkOptions({ network: true }),
      ),
    );

    expect(result).toMatchObject({
      kind: "unknown-model",
      message:
        "The model catalog does not list 'amazon-bedrock/us.anthropic.claude-haiku-9-9-20990101-v1:0', and Bedrock's model list cannot be asked " +
        "(hankweave does not sign AWS requests). Use a listed Bedrock id, or declare it in a 'models' block.",
    });
  });

  it("E, Pi: names the provider's key variable and Pi's auth store", async () => {
    const result = failedCheck(
      await checkPiModel("deepseek", "deepseek-v4-pro", {}, { network: false }),
    );

    expect(result).toMatchObject({
      kind: "no-credentials",
      message:
        "No credentials for provider 'deepseek' (checked the environment, this codon's env block and Pi's auth store). Set DEEPSEEK_API_KEY, or add the key in Pi's auth store.",
    });
  });

  it("E, Claude: no key and no legacy login", async () => {
    const result = failedCheck(
      await new ClaudeModelCheck().check(
        "anthropic",
        "claude-haiku-4-5",
        { PATH: process.env.PATH },
        checkOptions({ knownToCatalog: () => true }),
      ),
    );

    expect(result).toMatchObject({
      kind: "no-credentials",
      message: "No authentication found (set ANTHROPIC_API_KEY)",
    });
  });

  it("G, Claude: a CLI path that does not exist is harness-unavailable, not a key problem", async () => {
    const cliPath = path.join(tmp, "no-such-claude");

    const result = failedCheck(
      await new ClaudeModelCheck().check(
        "anthropic",
        "claude-haiku-4-5",
        { ANTHROPIC_API_KEY: "sk-ant-test-never-valid", CLAUDE_PATH_TO_CLAUDE_EXECUTABLE: cliPath },
        checkOptions({ knownToCatalog: () => true }),
      ),
    );

    expect(result).toMatchObject({
      kind: "harness-unavailable",
      message: `The Claude Agent SDK's CLI could not be found or started: Claude CLI not found at specified path: ${cliPath}`,
    });
  });
});

describe("a Bedrock id on the Claude route", () => {
  it("never asks Anthropic's API, even with ANTHROPIC_API_KEY set and online checks on", async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer-token";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-valid";
    process.env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS = "0";
    const hit = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    const miss = "us.anthropic.claude-haiku-9-9-20990101-v1:0";
    const env = { PATH: process.env.PATH, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

    const check = new ClaudeModelCheck();
    expect(check.runs("amazon-bedrock", hit)).toBe(true);
    const direct = await Promise.all(
      [hit, miss].map((id) =>
        check.check(
          "amazon-bedrock",
          id,
          env,
          checkOptions({ network: true, knownToCatalog: (_p, m) => m === hit }),
        ),
      ),
    );
    expect(direct.map((r) => r.ok)).toEqual([true, false]);

    const models = await load(
      { hank: hankOf([`amazon-bedrock/${hit}`, `amazon-bedrock/${miss}`]) },
      {
        harnesses: { codon: [new ClaudeModelCheck(), new PiModelCheck()], sentinel: [] },
        env,
        network: true,
      },
    );
    expect(confirmed(models.check(`amazon-bedrock/${hit}`)).provenance?.evidence).toBe("catalog");
    expect(failed(models.check(`amazon-bedrock/${miss}`)).message).toStartWith(
      `The model catalog does not list 'amazon-bedrock/${miss}'`,
    );

    // The miss refreshes the missing models.dev cache once; nothing else is asked.
    expect(requests.map((r) => r.url)).toEqual(["https://models.dev/api.json"]);
  });
});

describe("Pi credentials from its own auth store", () => {
  it("pass checkPiModel's authentication with nothing in the environment", async () => {
    fs.writeFileSync(
      path.join(process.env.PI_CODING_AGENT_DIR as string, "auth.json"),
      JSON.stringify({ deepseek: { type: "api_key", key: "sk-test-store-only" } }),
    );

    const result = await checkPiModel("deepseek", "deepseek-v4-pro", {}, { network: false });

    if (!result.ok) throw new Error(`expected ok, got ${result.kind}: ${result.message}`);
    expect(result.evidence).toBe("pi catalog");
    expect(result.steps?.find((s) => s.name === "authentication")).toMatchObject({
      passed: true,
    });

    // The same through Models, with the real Pi check and an empty env.
    const models = await load(
      { hank: hankOf(["deepseek/deepseek-v4-pro"]) },
      { harnesses: { codon: [new ClaudeModelCheck(), new PiModelCheck()], sentinel: [] } },
    );
    expect(confirmed(models.check("deepseek/deepseek-v4-pro")).provenance?.evidence).toBe(
      "pi catalog",
    );
    expect(requests).toEqual([]);
  });
});

describe("the AI SDK sentinel check", () => {
  it("reads process.env, not the passed env, and probes with the HANKWEAVE_SENTINEL_ key", async () => {
    process.env.OPENAI_API_KEY = "sk-plain";
    process.env.HANKWEAVE_SENTINEL_OPENAI_API_KEY = "sk-sentinel";
    fetchHandler = (url) =>
      url === "https://api.openai.com/v1/models/gpt-sentinel-9"
        ? Response.json({ id: "gpt-sentinel-9", created: 1_790_000_000 })
        : new Response("not found", { status: 404 });

    const result = await new AiSdkModelCheck().check(
      "openai",
      "gpt-sentinel-9",
      { OPENAI_API_KEY: "sk-passed-env", OPENAI_BASE_URL: "http://passed-env.invalid/v1" },
      checkOptions({ network: true }),
    );

    expect(result.ok).toBe(true);
    expect(requests.map((r) => [r.url, r.headers.authorization])).toEqual([
      ["https://api.openai.com/v1/models/gpt-sentinel-9", "Bearer sk-sentinel"],
    ]);
  });

  it("finds no credentials when only the passed env has a key", async () => {
    const result = failedCheck(
      await new AiSdkModelCheck().check(
        "openai",
        "gpt-sentinel-9",
        { OPENAI_API_KEY: "sk-passed-env" },
        checkOptions({ network: true }),
      ),
    );

    expect(result).toMatchObject({
      kind: "no-credentials",
      message:
        "No credentials for sentinel provider 'openai' (checked HANKWEAVE_SENTINEL_OPENAI_API_KEY, OPENAI_API_KEY).",
    });
    expect(requests).toEqual([]);
  });
});

describe("Models.attachLogger", () => {
  it("flushes what load logged before a run log existed, then forwards", async () => {
    const lines: string[] = [];
    const target = new Logger(path.join(tmp, "run.log"));
    target.log = (message: string) => {
      lines.push(message);
    };
    let harnessLogger: HarnessCheckOptions["logger"];
    const models = await load(
      { hank: hankOf(["deepseek/deepseek-v4-pro"]) },
      {
        harnesses: {
          codon: [
            claude(),
            pi({
              answer: (_provider, _modelId, _env, opts) => {
                harnessLogger = opts.logger;
                opts.logger?.log("pi.dev refresh for 'deepseek' failed: offline", "info");
                return { ok: true, evidence: "pi catalog" };
              },
            }),
          ],
          sentinel: [],
        },
      },
    );
    expect(lines).toEqual([]);

    models.attachLogger(target);
    expect(lines).toContain("pi.dev refresh for 'deepseek' failed: offline");
    // Catalog rows of providers no harness runs are left out at load, logged.
    expect(lines.some((line) => line.startsWith("Model catalog: left out"))).toBe(true);

    harnessLogger?.log("a later line");
    expect(lines.at(-1)).toBe("a later line");
  });
});

describe("parse mode with an empty credential environment", () => {
  const SPELLINGS = [
    "anthropic/claude-haiku-4-5",
    "openai-codex/gpt-5.6-sol",
    "deepseek/deepseek-v4-pro",
  ];
  const raw = () => hankOf(SPELLINGS);

  /** The real harness lists, every check() spied on. */
  function spiedHarnesses() {
    const harnesses = modelHarnesses();
    const spies = [...harnesses.codon, ...harnesses.sentinel].map((h) => spyOn(h, "check"));
    return { harnesses, spies };
  }

  it("pack's closure path: loadForParsing, then the hank schema", () => {
    const { harnesses, spies } = spiedHarnesses();
    const hank = raw();

    Models.loadForParsing({ hank }, { harnesses });
    const parsed = hankFileSchema.safeParse(hank);

    if (!parsed.success) throw new Error(parsed.error.message);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("replay and cleanup: Models.load with prerequisites off", async () => {
    const { harnesses, spies } = spiedHarnesses();

    const models = await Models.load({
      raw: { hank: raw() },
      harnesses,
      env: {},
      network: false,
      prerequisites: false,
      background: false,
      catalogDir: path.join(tmp, "catalog"),
    });

    expect(SPELLINGS.map((s) => confirmed(models.check(s)).provenance?.evidence)).toEqual([
      "catalog (parse mode)",
      "pi catalog (parse mode)",
      "catalog (parse mode)",
    ]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
