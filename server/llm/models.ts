import path from "node:path";
import {
  isModelCatalogOffline,
  recordConfiguredNoOnlineModelChecks,
} from "../model-catalog-settings.js";
import { PI_HARNESS, pricingProviderId } from "../provider-ids.js";
import type { ProbeRecord } from "../provider-probe.js";
import type { ShimSelfTestResult } from "../types/types.js";
import { Logger } from "../utils.js";
import { type BuiltCatalog, familyKey } from "./internal/catalog-build.js";
import { CatalogIndex, effortVariant } from "./internal/catalog-index.js";
import { bundledCatalogSnapshot, ModelCatalogStore } from "./internal/catalog-store.js";
import type { ModelInfo } from "./internal/models-dev-schema.js";
import { compareNewest } from "./internal/name-hints.js";
import { modelNoticeForCodon, type ReportRow, renderModelTable } from "./internal/report.js";
import {
  collectModelSources,
  hankModelsLayer,
  type ModelOccurrence,
  type RawModelConfigs,
} from "./internal/sources.js";
import { type ParsedSpelling, parseSpelling } from "./internal/spelling.js";
import { suggestIds } from "./internal/suggestions.js";
import type {
  HarnessCheckResult,
  HarnessCheckStep,
  HarnessModelCheck,
  HarnessRow,
  ModelCheck,
  ModelUse,
} from "./types.js";

/**
 * The model module's one door (spec 72). A spelling goes in; a record or a
 * classified failure comes out. Validation asks the harness first:
 *
 *   0. syntax: "<provider>/<model>", a provider some harness runs, exact case
 *   1. harness selection: the first harness for the use whose `runs` is true
 *   2. runnability: the harness confirms it can run the model here
 *      (credentials, its own catalog); parse mode checks catalog membership
 *   3. enrichment: hankweave's catalog record, else the harness's row, else
 *      an unpriced record
 *
 * Each stage runs only for spellings the one before accepted. `load` does
 * all of it before any config is parsed; Zod's model validation then reads
 * the results synchronously through `check`.
 */

export interface ModelsLoadOptions {
  raw: RawModelConfigs;
  /** `--model` from the command line. */
  cliModel?: string;
  /** Ordered: the first harness whose `runs` is true wins. */
  harnesses: { codon: readonly HarnessModelCheck[]; sentinel: readonly HarnessModelCheck[] };
  /** Process env with the HANKWEAVE_ pass-through applied; codon env blocks overlay it per codon. */
  env: NodeJS.ProcessEnv;
  /** May checks go online? hankweave.json's noOnlineModelChecks can still turn it off. */
  network: boolean;
  /**
   * false = parse mode: the caller only needs the hank parsed and priced,
   * never run (replay, pack, bundle check, cleanup). No credential, install
   * or network check; catalog membership is the evidence.
   */
  prerequisites: boolean;
  /** Start background refreshes of stale catalog sources (runs only). */
  background: boolean;
  catalogDir?: string;
  logger?: Logger;
  fetch?: typeof fetch;
  /** Bound on each network question (pi.dev refresh, provider model list). */
  timeoutMs?: number;
}

export interface ModelsParseOptions {
  harnesses: { codon: readonly HarnessModelCheck[]; sentinel: readonly HarnessModelCheck[] };
  catalogDir?: string;
  /** Bundled data only: no cache directory read (tests). */
  bundledOnly?: boolean;
  logger?: Logger;
}

/** One distinct (use, spelling) and everywhere it was written. */
interface Entry {
  key: string;
  spelling: string;
  use: ModelUse;
  occurrences: ModelOccurrence[];
}

interface Confirmed {
  entry: Entry;
  parsed: ParsedSpelling;
  harness: HarnessModelCheck;
  evidence: string;
  row?: HarnessRow;
  steps: HarnessCheckStep[];
}

interface RunContext {
  env: NodeJS.ProcessEnv;
  network: boolean;
  prerequisites: boolean;
  timeoutMs: number;
  logger?: Logger;
  checks: Map<string, Promise<HarnessCheckResult>>;
  adoptions: Map<string, Promise<{ ok: true; evidence: string } | { ok: false; reason: string }>>;
  probes: ProbeRecord[];
}

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * The model pre-pass runs before any run log exists. Its lines (pi.dev
 * refresh failures, injected rows, dropped providers) are held here until
 * the run or --validate attaches its log (Models.attachLogger).
 */
class BufferedLogger extends Logger {
  private held: [string, "info" | "error" | "debug"][] = [];
  private target?: Logger;

  constructor() {
    super("");
  }

  override log(message: string, level: "info" | "error" | "debug" = "info"): void {
    if (this.target) this.target.log(message, level);
    else if (this.held.length < 1000) this.held.push([message, level]);
  }

  attach(target: Logger): void {
    this.target = target;
    for (const [message, level] of this.held) target.log(message, level);
    this.held = [];
  }
}
const ADOPTABLE = new Set(["registry", "user"]);

const keyOf = (use: ModelUse, spelling: string) => `${use}\u0000${spelling}`;
const lineOf = (modelId: string) => modelId.toLowerCase().split(/[-_.]/)[0] ?? "";

/** A stable identity for a codon env block, so equal envs share a check. */
function envFingerprint(codonEnv: Readonly<Record<string, string>> | undefined): string {
  if (!codonEnv) return "";
  return JSON.stringify(Object.entries(codonEnv).sort(([a], [b]) => a.localeCompare(b)));
}

function hasPrice(cost: HarnessRow["cost"]): boolean {
  return !!cost && ((cost.input ?? 0) > 0 || (cost.output ?? 0) > 0);
}

/** "<id>-high"/"-xhigh" → "<id>"; undefined for a spelling with no effort suffix. */
function effortBaseId(modelId: string): string | undefined {
  return /^(.*)-(xhigh|high)$/.exec(modelId)?.[1];
}

/** Whether a harness row takes attachments: as it says, else whether it reads images. */
function rowAttachment(row: HarnessRow): boolean {
  return row.attachment ?? row.input?.includes("image") ?? false;
}

/** A harness row's limits, with defaults for the ones it leaves out. */
function rowLimit(row: HarnessRow): ModelInfo["limit"] {
  return { context: row.limit?.context ?? 128_000, output: row.limit?.output ?? 16_384 };
}

/** A harness row's modalities: its listed inputs (text when it lists none), text out. */
function rowModalities(row: HarnessRow): ModelInfo["modalities"] {
  return { input: row.input?.length ? row.input : ["text"], output: ["text"] };
}

/**
 * A record for a model hankweave's catalog does not list, from what the
 * harness knows (Pi's row) or nothing at all. A harness that lists no price
 * (or only zeros, Pi's default for an unpriced row) leaves it unknown.
 */
function harnessRecord(
  provider: string,
  modelId: string,
  harnessRow: HarnessRow | undefined,
  source: string,
): ModelInfo {
  const row: HarnessRow = harnessRow ?? {};
  const today = new Date().toISOString().substring(0, 10);
  const priced = hasPrice(row.cost);
  return {
    providerId: provider,
    modelId,
    name: row.name ?? modelId,
    attachment: rowAttachment(row),
    reasoning: row.reasoning ?? false,
    tool_call: true,
    cost: priced ? row.cost : undefined,
    limit: rowLimit(row),
    modalities: rowModalities(row),
    release_date: today,
    last_updated: today,
    provenance: { confidence: "harness", source, priceStatus: priced ? "known" : "unknown" },
  };
}

/**
 * A harness row found through an effort suffix ("<id>-xhigh" on Pi's <id>)
 * prices like the catalog's synthesized variants: xhigh at twice the base
 * rate. A row whose own id carries the suffix is priced as listed.
 */
function effortPriced(record: ModelInfo, row: HarnessRow | undefined): ModelInfo {
  const effort = /-(xhigh|high)$/.exec(record.modelId)?.[1];
  if (!effort || !row?.id || row.id === record.modelId || !record.cost) return record;
  const factor = effort === "xhigh" ? 2 : 1;
  const scale = (v: number | undefined) => (v === undefined ? undefined : v * factor);
  return {
    ...record,
    cost: {
      input: scale(record.cost.input),
      output: scale(record.cost.output),
      cache_read: scale(record.cost.cache_read),
      cache_write: scale(record.cost.cache_write),
    },
  };
}

function failure(
  kind: Exclude<ModelCheck, { ok: true }>["kind"],
  message: string,
  suggestions: string[],
  stage: "name" | "harness",
): ModelCheck {
  return { ok: false, kind, message, suggestions, stage };
}

export class Models {
  private static installed: Models | undefined;

  private index: CatalogIndex;
  private readonly results = new Map<string, ModelCheck>();
  private readonly entries = new Map<string, Entry>();
  /** Harness that runs each confirmed key, for the report. */
  private readonly harnessOf = new Map<string, string>();
  private readonly steps = new Map<string, HarnessCheckStep[]>();
  /** Stage-2 confirmations, kept so stage 3 can run again when the catalog changes. */
  private readonly confirmations = new Map<string, Confirmed>();
  private readonly problemList: string[] = [];

  private constructor(
    built: BuiltCatalog,
    private readonly harnesses: {
      codon: readonly HarnessModelCheck[];
      sentinel: readonly HarnessModelCheck[];
    },
    /** Parse mode answers any spelling on demand; run mode only prepared ones. */
    private readonly parseMode: boolean,
    private logger?: Logger,
  ) {
    this.index = this.indexFor(built);
    this.problemList.push(...built.problems);
  }

  // === Construction ===

  /** Stages 0–3 for every spelling in the configs, then install the result. */
  static async load(options: ModelsLoadOptions): Promise<Models> {
    const logger = options.logger ?? new BufferedLogger();
    const sources = collectModelSources(options.raw, {
      cliModel: options.cliModel,
      env: options.env,
    });
    // Before anything reads it: Pi's refreshes at codon start follow
    // hankweave.json's setting too.
    recordConfiguredNoOnlineModelChecks(sources.noOnlineModelChecks);
    const network = options.network && !isModelCatalogOffline(options.env);
    const store = new ModelCatalogStore({
      dir: options.catalogDir,
      offline: !network,
      fetch: options.fetch,
      logger: logger,
    });
    const models = new Models(
      store.build(sources.user),
      options.harnesses,
      !options.prerequisites,
      logger,
    );
    models.problemList.unshift(...sources.problems);
    const ctx: RunContext = {
      env: options.env,
      network,
      prerequisites: options.prerequisites,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      logger: logger,
      checks: new Map(),
      adoptions: new Map(),
      probes: [],
    };
    await models.prepare(sources.occurrences, ctx);
    if (models.recordProbes(store, sources.user, ctx.probes)) models.reenrich();
    if (options.background && network) models.startBackgroundRefresh(store);
    Models.install(models);
    return models;
  }

  /**
   * Parse mode, synchronously: bundled and cached catalog layers plus the
   * hank's own `models` block, catalog membership as the evidence. For
   * `hankweave pack` and the bundle extraction check, which only need a hank
   * parsed and priced. Installs the instance.
   */
  static loadForParsing(raw: { hank?: unknown }, options: ModelsParseOptions): Models {
    // A block that fails its schema is the hank schema's to report.
    const { layer } = hankModelsLayer(raw.hank);
    const built = options.bundledOnly
      ? bundledCatalogSnapshot(options.logger)
      : new ModelCatalogStore({
          dir: options.catalogDir,
          offline: true,
          logger: options.logger,
        }).build(layer ? [layer] : []);
    const models = new Models(built, options.harnesses, true, options.logger);
    Models.install(models);
    return models;
  }

  /** Send the model module's log lines (held since load) to a run's log. */
  attachLogger(logger: Logger): void {
    if (this.logger instanceof BufferedLogger) this.logger.attach(logger);
    else this.logger = logger;
  }

  /** The installed instance; Zod transforms and the runtime read it. */
  static current(): Models {
    if (!Models.installed) {
      throw new Error(
        "Model checks were not prepared: Models.load() (or Models.loadForParsing()) must run before any config is parsed",
      );
    }
    return Models.installed;
  }

  static install(models: Models): void {
    Models.installed = models;
  }

  // === Queries ===

  /** The result for a spelling and its use: a synchronous read of what load prepared. */
  check(spelling: string, use: ModelUse = "codon"): ModelCheck {
    const key = keyOf(use, spelling);
    const prepared = this.results.get(key);
    if (prepared) return prepared;
    if (this.parseMode) {
      const result = this.checkOffline(spelling, use);
      this.results.set(key, result);
      return result;
    }
    return failure(
      "unprepared",
      `Model '${spelling}' (${use}) was not checked at startup. This is a hankweave bug: ` +
        "the model pre-pass did not collect every place a model is written.",
      [],
      "name",
    );
  }

  /** Exact catalog lookup ("provider", "model"), or a record a harness confirmed for `use`. */
  get(provider: string, modelId: string, use: ModelUse = "codon"): ModelInfo | undefined {
    // A spelling this use rejected stays rejected, whatever the catalog
    // learned since (a probe another use triggered rebuilds it).
    const own = this.results.get(keyOf(use, `${provider}/${modelId}`));
    if (own && !own.ok) return undefined;
    const listed = this.listedFor(use, provider, modelId)
      ? this.index.get(provider, modelId)
      : undefined;
    return listed ?? this.confirmedRecord(provider, modelId, use);
  }

  /** Startup / --validate lines: the model table (with evidence) and rejections. */
  report(): string[] {
    const rows: ReportRow[] = [];
    const rejections: string[] = [];
    const seen = new Set<string>();
    for (const [key, entry] of this.entries) {
      const result = this.results.get(key);
      if (!result) continue;
      if (!result.ok) {
        const origins = [...new Set(entry.occurrences.map((o) => o.origin))].join(", ");
        const skipped = entry.use === "sentinel" && result.stage === "harness";
        rejections.push(
          `! ${origins}: ${result.message}${skipped ? " (the sentinel will be skipped)" : ""}`,
        );
        continue;
      }
      if (!entry.occurrences.some((o) => o.effective)) continue;
      const identity = `${entry.use}:${entry.spelling}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      rows.push({ model: result.model, harness: this.harnessOf.get(key) ?? "?", use: entry.use });
    }
    return [...renderModelTable(rows), ...rejections];
  }

  /** Catalog problems: an invalid `models` block, an unknown basedOn, a cache that could not be written. */
  problems(): string[] {
    return [...this.problemList];
  }

  /** The journal notice for a codon's model, when a reader should know something about it. */
  notice(codonId: string, model: ModelInfo): string | undefined {
    return modelNoticeForCodon(codonId, model);
  }

  /**
   * Per codon model, the harness steps that confirmed it, in the self-test
   * shape `--validate` and run telemetry report.
   */
  harnessReports(): {
    modelId: string;
    modelName: string;
    provider: string;
    passed: boolean;
    result: ShimSelfTestResult;
  }[] {
    const reports = [];
    for (const [key, entry] of this.entries) {
      const steps = this.steps.get(key);
      const result = this.results.get(key);
      if (entry.use !== "codon" || !steps || !result?.ok) continue;
      const harness = this.harnesses.codon.find((h) => h.harness === this.harnessOf.get(key));
      const info = harness?.info?.() ?? {
        shim: { name: "unknown", version: "unknown" },
        agent: { name: "unknown", version: "unknown" },
      };
      reports.push({
        modelId: result.model.modelId,
        modelName: result.model.name,
        provider: result.model.providerId,
        passed: true,
        result: {
          shim: info.shim,
          agent: { ...info.agent, found: true },
          checks: steps,
          overall: { passed: true, message: "All checks passed" },
        },
      });
    }
    return reports;
  }

  // === Stages ===

  private indexFor(built: BuiltCatalog): CatalogIndex {
    const all = [...this.harnesses.codon, ...this.harnesses.sentinel];
    const runnable = new Set(all.flatMap((h) => h.providers()));
    const index = new CatalogIndex(built.rows, (provider) => runnable.has(provider));
    if (index.droppedRows > 0) {
      this.logger?.log(
        `Model catalog: left out ${index.droppedRows} rows of ${index.dropped.size} providers no harness runs`,
        "debug",
      );
    }
    return index;
  }

  private harnessesFor(use: ModelUse): readonly HarnessModelCheck[] {
    return use === "codon" ? this.harnesses.codon : this.harnesses.sentinel;
  }

  /** Stage 1: "pi/" forces Pi; otherwise the first harness for the use that runs it. */
  private route(parsed: ParsedSpelling, use: ModelUse): HarnessModelCheck | undefined {
    const list = this.harnessesFor(use);
    if (parsed.piForced) return list.find((h) => h.harness === PI_HARNESS);
    return list.find((h) => h.runs(parsed.provider, parsed.modelId));
  }

  /**
   * "<id>-high"/"-xhigh" for a reasoning <id> the catalog lists but whose
   * variants it does not synthesize (every provider but openai): the base
   * record at scaled rates, so a declared or disputed base price carries
   * over. Not for a harness row listed under the suffixed id itself.
   */
  private derivedVariant(
    provider: string,
    modelId: string,
    row: HarnessRow | undefined,
  ): ModelInfo | undefined {
    const match = /^(.*)-(xhigh|high)$/.exec(modelId);
    if (!match || row?.id === modelId) return undefined;
    const base = this.catalogRecord(provider, match[1]);
    if (!base?.reasoning) return undefined;
    return effortVariant(base, match[2] as "high" | "xhigh");
  }

  /**
   * Whether hankweave's catalog lists the exact id for this use. A sentinel
   * runs on the AI SDK, which sends the id verbatim: a synthesized effort
   * variant ("openai/<id>-xhigh") is not a model it can call.
   */
  private listedFor(use: ModelUse, provider: string, modelId: string): boolean {
    if (!this.index.get(provider, modelId)) return false;
    return use !== "sentinel" || !this.index.isEffortVariant(provider, modelId);
  }

  /**
   * hankweave's record for pricing and describing a model: exact, else under
   * its pricing provider (openai-codex → openai). Pricing only: whether a
   * model can run — membership, adoption, Claude's evidence — is decided by
   * the exact id (this.index.get), never through the mapping.
   */
  private catalogRecord(provider: string, modelId: string): ModelInfo | undefined {
    const exact = this.index.get(provider, modelId);
    if (exact) return exact;
    const pricing = pricingProviderId(provider);
    return pricing === provider ? undefined : this.index.get(pricing, modelId);
  }

  /**
   * A record a harness confirmed for this use. Never another use's (a model
   * Pi confirmed for a codon is not one the AI SDK confirmed for a sentinel)
   * and never a shadowed spelling's, which no harness was asked about.
   */
  private confirmedRecord(provider: string, modelId: string, use: ModelUse): ModelInfo | undefined {
    for (const [key, result] of this.results) {
      if (!result.ok || !key.startsWith(keyOf(use, ""))) continue;
      const entry = this.entries.get(key);
      if (entry && !entry.occurrences.some((o) => o.effective)) continue;
      if (result.model.providerId === provider && result.model.modelId === modelId) {
        return result.model;
      }
    }
    return undefined;
  }

  /** Group occurrences by (use, spelling) and run stages 0–2 for each, concurrently. */
  private async prepare(occurrences: readonly ModelOccurrence[], ctx: RunContext): Promise<void> {
    for (const occurrence of occurrences) {
      const key = keyOf(occurrence.use, occurrence.spelling);
      const entry = this.entries.get(key);
      if (entry) entry.occurrences.push(occurrence);
      else {
        this.entries.set(key, {
          key,
          spelling: occurrence.spelling,
          use: occurrence.use,
          occurrences: [occurrence],
        });
      }
    }
    const confirmed = await Promise.all([...this.entries.values()].map((e) => this.stages(e, ctx)));
    for (const item of confirmed) if (item) this.enrich(item);
  }

  /** Stages 0–2 for one entry; the confirmation, or undefined when it failed or needs no stage 3 now. */
  private async stages(entry: Entry, ctx: RunContext): Promise<Confirmed | undefined> {
    const parsed = parseSpelling(entry.spelling, {
      index: this.index,
      harnesses: this.harnessesFor(entry.use),
      use: entry.use,
    });
    if (!parsed.ok) {
      this.results.set(entry.key, failure(parsed.kind, parsed.message, parsed.suggestions, "name"));
      return undefined;
    }
    const harness = this.route(parsed, entry.use);
    if (!harness) {
      // parseSpelling refuses a provider no harness runs; unreachable.
      this.results.set(
        entry.key,
        failure("unrunnable-provider", `No harness runs '${entry.spelling}'.`, [], "name"),
      );
      return undefined;
    }
    const effective = entry.occurrences.filter((o) => o.effective);
    if (effective.length === 0) {
      return {
        entry,
        parsed,
        harness,
        evidence: "not checked: shadowed by a higher-precedence model setting",
        steps: [],
      };
    }
    if (!ctx.prerequisites) return this.parseModeStage(entry, parsed, harness);

    const envs = new Map<string, ModelOccurrence>();
    for (const occurrence of effective) {
      const fingerprint = envFingerprint(occurrence.codonEnv);
      if (!envs.has(fingerprint)) envs.set(fingerprint, occurrence);
    }
    let last: Confirmed | undefined;
    for (const occurrence of envs.values()) {
      // With several env blocks in play, a failure names the one that failed.
      const confirmed = await this.harnessStage(
        entry,
        parsed,
        harness,
        occurrence,
        ctx,
        envs.size > 1,
      );
      if (!confirmed) return undefined;
      last = confirmed;
    }
    return last;
  }

  /** Stage 2 in parse mode: catalog membership (hankweave's, or the harness's own offline catalog). */
  private parseModeStage(
    entry: Entry,
    parsed: ParsedSpelling,
    harness: HarnessModelCheck,
  ): Confirmed | undefined {
    const membership = this.parseModeMembership(entry.use, parsed, harness);
    if (membership) return { entry, parsed, harness, ...membership, steps: [] };
    this.results.set(entry.key, this.parseModeMiss(parsed, harness));
    return undefined;
  }

  /** Parse-mode evidence (and the harness row, if any) that a catalog lists the model. */
  private parseModeMembership(
    use: ModelUse,
    parsed: ParsedSpelling,
    harness: HarnessModelCheck,
  ): { evidence: string; row?: HarnessRow } | undefined {
    const { provider, modelId } = parsed;
    if (this.listedFor(use, provider, modelId)) {
      // A synthesized variant yields to a row the harness lists literally.
      const literal = this.index.isEffortVariant(provider, modelId)
        ? harness.offlineRow?.(provider, modelId)
        : undefined;
      return { evidence: "catalog (parse mode)", row: literal };
    }
    const row = harness.offlineRow?.(provider, modelId);
    if (row) return { evidence: `${harness.harness} catalog (parse mode)`, row };
    // An effort spelling of a reasoning model hankweave's catalog lists: a
    // run adopts the base into a harness that can adopt (Pi), so parse mode
    // accepts it from the base record, offline.
    if (harness.adopt && use === "codon" && this.reasoningBase(provider, modelId)) {
      return { evidence: "catalog (parse mode)" };
    }
    return undefined;
  }

  /** The parse-mode failure for a model no catalog lists, with the closest ids. */
  private parseModeMiss(parsed: ParsedSpelling, harness: HarnessModelCheck): ModelCheck {
    const spelled = `${parsed.provider}/${parsed.modelId}`;
    const candidates = this.closestTo(parsed, [], harness);
    const unlisted = harness.offlineRow
      ? `Neither hankweave's model catalog nor ${harness.label}'s own catalog lists '${spelled}' `
      : `hankweave's model catalog does not list '${spelled}' `;
    const closest = candidates.length > 0 ? ` Closest: ${candidates.join(", ")}.` : "";
    return failure(
      "unknown-model",
      `${unlisted}(checked offline: replay, pack and cleanup ask no harness).${closest}`,
      candidates,
      "harness",
    );
  }

  /**
   * The exact catalog record of an effort spelling's base ("<id>" for
   * "<id>-high"), when it is a reasoning model. Exact base only: the pricing
   * mapping never makes a model runnable.
   */
  private reasoningBase(provider: string, modelId: string): ModelInfo | undefined {
    const base = effortBaseId(modelId);
    const record = base ? this.index.get(provider, base) : undefined;
    return record?.reasoning ? record : undefined;
  }

  /** One harness question, shared by every entry asking the same thing in the same env. */
  private askHarness(
    harness: HarnessModelCheck,
    parsed: ParsedSpelling,
    occurrence: ModelOccurrence,
    ctx: RunContext,
    fresh = false,
  ): Promise<HarnessCheckResult> {
    const fingerprint = envFingerprint(occurrence.codonEnv);
    const key = `${harness.harness}|${parsed.provider}|${parsed.modelId}|${fingerprint}`;
    const cached = fresh ? undefined : ctx.checks.get(key);
    if (cached) return cached;
    const env = occurrence.codonEnv ? { ...ctx.env, ...occurrence.codonEnv } : ctx.env;
    const pending = harness
      .check(parsed.provider, parsed.modelId, env, {
        network: ctx.network,
        timeoutMs: ctx.timeoutMs,
        knownToCatalog: (provider, modelId) => this.listedFor(occurrence.use, provider, modelId),
        logger: ctx.logger,
      })
      .catch(
        (error: unknown): HarnessCheckResult => ({
          ok: false,
          kind: "harness-unavailable",
          message: `${harness.label} failed while checking '${parsed.provider}/${parsed.modelId}': ${error instanceof Error ? error.message : String(error)}`,
          candidates: [],
        }),
      );
    ctx.checks.set(key, pending);
    return pending;
  }

  /**
   * Stage 2: ask the harness. When it does not know the model but
   * hankweave's catalog has a record for it (a model models.dev lists before
   * pi.dev, or a `models` block entry), the harness may adopt it from that
   * record — the one place the catalog speaks before the harness.
   */
  private async harnessStage(
    entry: Entry,
    parsed: ParsedSpelling,
    harness: HarnessModelCheck,
    occurrence: ModelOccurrence,
    ctx: RunContext,
    nameOrigin = false,
  ): Promise<Confirmed | undefined> {
    const asked = await this.askHarness(harness, parsed, occurrence, ctx);
    const { result, evidence, adoptionNote } = await this.adoptMissing(
      harness,
      parsed,
      occurrence,
      ctx,
      asked,
    );
    if (!result.ok) {
      const envNote = nameOrigin ? ` (with the env block of ${occurrence.origin})` : "";
      this.results.set(
        entry.key,
        this.harnessFailure(parsed, harness, result, `${adoptionNote}${envNote}`),
      );
      return undefined;
    }
    if (result.probe) ctx.probes.push(result.probe);
    return {
      entry,
      parsed,
      harness,
      evidence: evidence ?? result.evidence,
      row: result.row,
      steps: result.steps ?? [],
    };
  }

  /**
   * When the harness lacks the model, adopt hankweave's record into it and
   * ask again: the fresh answer and the adoption's evidence, or the original
   * answer and a note on why adoption failed.
   */
  private async adoptMissing(
    harness: HarnessModelCheck,
    parsed: ParsedSpelling,
    occurrence: ModelOccurrence,
    ctx: RunContext,
    result: HarnessCheckResult,
  ): Promise<{ result: HarnessCheckResult; evidence?: string; adoptionNote: string }> {
    // Unreachable counts too: the harness's own catalog lacks the model and
    // only its refresh failed, so hankweave's record can still stand in.
    const missing =
      !result.ok && (result.kind === "unknown-model" || result.kind === "unreachable");
    if (!missing || !harness.adopt) return { result, adoptionNote: "" };
    const adopted = await this.adopt(harness, parsed, ctx);
    if (!adopted) return { result, adoptionNote: "" };
    if (!adopted.ok) {
      return {
        result,
        adoptionNote: ` hankweave's catalog has a record for it, but it could not be added to ${harness.label}'s catalog: ${adopted.reason}.`,
      };
    }
    const fresh = await this.askHarness(harness, parsed, occurrence, ctx, true);
    return { result: fresh, evidence: adopted.evidence, adoptionNote: "" };
  }

  /** The stage-2 failure for a harness's refusal, with the closest ids it or the catalog knows. */
  private harnessFailure(
    parsed: ParsedSpelling,
    harness: HarnessModelCheck,
    result: Extract<HarnessCheckResult, { ok: false }>,
    note: string,
  ): ModelCheck {
    const unknown = result.kind === "unknown-model";
    const suggestions = unknown ? this.closestTo(parsed, result.candidates, harness) : [];
    // Ranked and qualified, from the harness's own ids when it has a list
    // (Pi) and the catalog's otherwise (the Claude route).
    const closest = suggestions.length > 0 ? ` Closest: ${suggestions.join(", ")}.` : "";
    return failure(result.kind, `${result.message}${closest}${note}`, suggestions, "harness");
  }

  /**
   * Ids to suggest for a model the harness does not know: the harness's own
   * ids ranked by similarity, else the catalog's in the same provider. A
   * former family word under a provider ("amazon-bedrock/opus") gets that
   * provider's ids containing it, newest first (class J).
   */
  private closestTo(
    parsed: ParsedSpelling,
    harnessIds: readonly string[],
    harness?: HarnessModelCheck,
  ): string[] {
    const { provider, modelId } = parsed;
    // Catalog rows under the pricing provider ("openai" for "openai-codex")
    // are only ids the harness itself lists: a suggestion must run.
    const pricing = pricingProviderId(provider);
    const runnable = (id: string) =>
      pricing === provider || harness?.offlineRow?.(provider, id) !== undefined;
    const records = harnessIds.length
      ? harnessIds.map((id) => {
          const slash = id.indexOf("/");
          const p = id.substring(0, slash);
          const m = id.substring(slash + 1);
          return {
            ...(this.catalogRecord(p, m) ?? harnessRecord(p, m, undefined, "")),
            providerId: p,
            modelId: m,
          };
        })
      : this.index
          .rowsOf(pricing)
          .filter((r) => runnable(r.modelId))
          .map((r) => ({ ...r, providerId: provider }));
    const self = `${provider}/${modelId}`;
    const ranked = suggestIds(
      modelId,
      records.filter((r) => `${r.providerId}/${r.modelId}` !== self),
    );
    if (ranked.length > 0) return ranked;
    const word = modelId.toLowerCase();
    const containing = records
      .filter(
        (r) => word.length >= 3 && r.modelId !== modelId && r.modelId.toLowerCase().includes(word),
      )
      .sort(compareNewest)
      .slice(0, 3)
      .map((r) => `${r.providerId}/${r.modelId}`);
    if (containing.length > 0) return containing;
    // Nothing alike: the newest ids that do run here, so the message still
    // names something to copy.
    return harnessIds.length > 0
      ? harnessIds.slice(0, 3)
      : [...records]
          .sort(compareNewest)
          .slice(0, 3)
          .map((r) => `${r.providerId}/${r.modelId}`);
  }

  /** Adoption, once per (harness, provider, model): only from a record the registries or the user vouch for. */
  private adopt(
    harness: HarnessModelCheck,
    parsed: ParsedSpelling,
    ctx: RunContext,
  ): Promise<{ ok: true; evidence: string } | { ok: false; reason: string }> | undefined {
    const record = this.adoptionRecord(parsed);
    if (!record || !harness.adopt) return undefined;
    const key = `${harness.harness}|${parsed.provider}|${record.modelId}`;
    const cached = ctx.adoptions.get(key);
    if (cached) return cached;
    const pending = harness.adopt(
      parsed.provider,
      parsed.modelId,
      record,
      this.siblingsOf(record),
      ctx.logger,
    );
    ctx.adoptions.set(key, pending);
    return pending;
  }

  /**
   * The record a harness may adopt for a spelling, when the registries or the
   * user vouch for it. "<id>-high" adopts <id> (the harness carries the
   * effort), when <id> is a reasoning model — the base's unscaled record,
   * never a synthesized variant's; one adoption per base id, whichever
   * spelling asks. A listed id that merely ends in "-high" is its own model.
   */
  private adoptionRecord(parsed: ParsedSpelling): ModelInfo | undefined {
    const { provider, modelId } = parsed;
    const listed = this.index.isEffortVariant(provider, modelId)
      ? undefined
      : this.index.get(provider, modelId);
    const record = listed ?? this.reasoningBase(provider, modelId);
    const confidence = record?.provenance?.confidence ?? "registry";
    return record && ADOPTABLE.has(confidence) ? record : undefined;
  }

  /** The record's provider's other records: same family first, then same line, each newest first. */
  private siblingsOf(record: ModelInfo): ModelInfo[] {
    const family = record.family?.toLowerCase();
    const line = lineOf(record.modelId);
    const rows = this.index
      .rowsOf(record.providerId)
      .filter((r) => r.modelId !== record.modelId)
      .sort(compareNewest);
    const sameFamily = rows.filter(
      (r) => family !== undefined && r.family?.toLowerCase() === family,
    );
    const sameLine = rows.filter((r) => !sameFamily.includes(r) && lineOf(r.modelId) === line);
    return [...sameFamily, ...sameLine];
  }

  /** Stage 3: price, limits, capabilities and provenance for a confirmed spelling. */
  private enrich(confirmed: Confirmed): void {
    const { entry, parsed, harness, evidence } = confirmed;
    const base = this.stage3Base(confirmed);
    const model: ModelInfo = {
      ...base,
      ...(parsed.piForced ? { harnessOverride: PI_HARNESS } : {}),
      provenance: base.provenance && {
        ...base.provenance,
        requestedAs: entry.spelling.trim(),
        matchType: "exact",
        evidence,
      },
    };
    this.results.set(entry.key, { ok: true, model });
    this.harnessOf.set(entry.key, harness.harness);
    if (confirmed.steps.length > 0) this.steps.set(entry.key, confirmed.steps);
    this.confirmations.set(entry.key, confirmed);
  }

  /** Stage 3's record before provenance: hankweave's catalog record, else the harness's row priced. */
  private stage3Base(confirmed: Confirmed): ModelInfo {
    const { parsed, harness, evidence, row } = confirmed;
    const { provider, modelId } = parsed;
    const catalog = this.catalogStandIn(provider, modelId, row);
    if (catalog) return { ...catalog, providerId: provider };
    const source = row ? `${harness.label}'s catalog` : evidence;
    return this.withCeiling(effortPriced(harnessRecord(provider, modelId, row, source), row));
  }

  /**
   * hankweave's record for a confirmed spelling, listed or derived. A row
   * the harness lists under the suffixed id itself is that model: a variant
   * the catalog synthesized for the same spelling does not stand in for it.
   */
  private catalogStandIn(
    provider: string,
    modelId: string,
    row: HarnessRow | undefined,
  ): ModelInfo | undefined {
    const listedRecord = this.catalogRecord(provider, modelId);
    const synthesized = listedRecord?.provenance?.effortOf !== undefined && row?.id === modelId;
    if (synthesized) return undefined;
    return listedRecord ?? this.derivedVariant(provider, modelId, row);
  }

  /**
   * The catalog's ceiling estimate for a harness-only record with no price
   * (spec 70, "Prices and budgets"): the highest budget rates among the
   * provider's priced records of the same family released in the last year,
   * else of the family, else of the model line in the last year — so dollar
   * budgets still count the model.
   */
  private withCeiling(record: ModelInfo): ModelInfo {
    const p = record.provenance;
    if (!p || p.priceStatus !== "unknown") return record;
    const rows = this.index.rowsOf(pricingProviderId(record.providerId));
    const cutoff = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().substring(0, 10);
    const recent = (r: ModelInfo) =>
      (r.release_date.length === 7 ? `${r.release_date}-01` : r.release_date) >= cutoff;
    const family = familyKey({ modelId: record.modelId });
    const line = lineOf(record.modelId);
    const members = rows.filter(
      (r) => familyKey(r) === family || familyKey({ modelId: r.modelId }) === family,
    );
    const choices: [ModelInfo[], string][] = [
      [members.filter(recent), `${family} model(s) released in the last year`],
      [members, `${family} model(s)`],
      [
        rows.filter((r) => lineOf(r.modelId) === line && recent(r)),
        `${line}-* model(s) released in the last year`,
      ],
    ];
    for (const [siblings, label] of choices) {
      const rates = siblings
        .map((r) => r.provenance?.budgetCost ?? r.cost)
        .filter(
          (c): c is NonNullable<ModelInfo["cost"]> =>
            c !== undefined && (c.input ?? 0) + (c.output ?? 0) > 0,
        );
      if (rates.length === 0) continue;
      const max = (field: "input" | "output" | "cache_read" | "cache_write") => {
        const values = rates.map((c) => c[field]).filter((v): v is number => v !== undefined);
        return values.length > 0 ? Math.max(...values) : undefined;
      };
      const budgetCost = {
        input: max("input") ?? 0,
        output: max("output") ?? 0,
        cache_read: max("cache_read"),
        cache_write: max("cache_write"),
      };
      return {
        ...record,
        provenance: {
          ...p,
          budgetCost,
          budgetCostBasis: `ceiling estimate: highest price among ${rates.length} ${pricingProviderId(record.providerId)} ${label}`,
        },
      };
    }
    return record;
  }

  /** Re-run stage 3 after the catalog changed (probe results recorded). */
  private reenrich(): void {
    for (const confirmed of this.confirmations.values()) this.enrich(confirmed);
  }

  /** Persist provider model-list answers; rebuild the catalog so stage 3 sees them. */
  private recordProbes(
    store: ModelCatalogStore,
    user: Parameters<ModelCatalogStore["build"]>[0],
    probes: readonly ProbeRecord[],
  ): boolean {
    if (probes.length === 0) return false;
    let recorded = false;
    for (const probe of probes) {
      try {
        store.recordProbe(probe);
        recorded = true;
      } catch (error) {
        this.problemList.push(
          `Model catalog: ${probe.providerId} confirmed '${probe.modelId}', but the result could not be saved ` +
            `to ${path.join(store.dir, "probes.json")}: ${(error as Error).message}`,
        );
      }
    }
    if (!recorded) return false;
    const built = store.build(user);
    this.index = this.indexFor(built);
    return true;
  }

  /** Synchronous stages for parse mode: 0, membership, 3. */
  private checkOffline(spelling: string, use: ModelUse): ModelCheck {
    const entry: Entry = {
      key: keyOf(use, spelling),
      spelling,
      use,
      occurrences: [{ spelling, use, origin: "config", effective: true }],
    };
    const parsed = parseSpelling(spelling, {
      index: this.index,
      harnesses: this.harnessesFor(use),
      use,
    });
    if (!parsed.ok) return failure(parsed.kind, parsed.message, parsed.suggestions, "name");
    const harness = this.route(parsed, use);
    if (!harness)
      return failure("unrunnable-provider", `No harness runs '${spelling}'.`, [], "name");
    const confirmed = this.parseModeStage(entry, parsed, harness);
    if (confirmed) this.enrich(confirmed);
    return (
      this.results.get(entry.key) ??
      failure("unprepared", `Model '${spelling}' could not be checked.`, [], "name")
    );
  }

  /** Refresh stale catalog sources and the harnesses' own catalogs, for the next run. */
  private startBackgroundRefresh(store: ModelCatalogStore): void {
    const stale = (["models.dev", "litellm"] as const).filter((s) => store.isStale(s));
    if (stale.length > 0) {
      void store.refresh(stale).then((results) => {
        for (const r of results) {
          if (r.outcome === "failed")
            this.logger?.log(`Model catalog refresh: ${r.detail}`, "info");
        }
      });
    }
    const all = new Set([...this.harnesses.codon, ...this.harnesses.sentinel]);
    for (const harness of all) harness.startBackgroundRefresh?.(this.logger);
  }
}
