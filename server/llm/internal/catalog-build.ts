import { pricingProviderId } from "../../provider-ids.js";
import type { ProbeRecord } from "../../provider-probe.js";
import type { PriceReference } from "./litellm-prices.js";
import type {
  ModelConfidence,
  ModelCost,
  ModelInfo,
  ModelProvenance,
  PriceStatus,
} from "./models-dev-schema.js";
import type { ModelOverlay } from "./overlay.js";
import type { UserModelDefinition, UserModelLayer, UserModelOrigin } from "./user-models.js";

/**
 * The model catalog (spec 70): every model record hankweave resolves
 * against, merged from layers, each record carrying where its fields came
 * from and how far to trust them. This module is the pure merge; loading and
 * refreshing the layers lives in model-catalog-store.ts.
 *
 * Layers, later winning field by field:
 *   bundled snapshot → models.dev live → provider probes (only for ids
 *   nothing else lists) → overlay corrections → user `models` blocks
 * LiteLLM prices cross-check first-party prices and fill missing ones.
 */
export interface CatalogLayers {
  /** The compiled-in models.dev snapshot: the offline floor. */
  bundled: { rows: readonly ModelInfo[]; lastUpdated?: string };
  /** Cached rows from models.dev's live api.json. */
  live?: { rows: readonly ModelInfo[]; fetchedAt: string };
  /** First-party list prices from LiteLLM, keyed by lowercased "provider/model". */
  litellm?: { prices: Readonly<Record<string, PriceReference>>; fetchedAt: string };
  /** Models a provider's own model list confirmed (see provider-probe.ts). */
  probes?: readonly ProbeRecord[];
  overlay: { data: ModelOverlay; source: string };
  /** hank.json then hankweave.json `models` blocks. */
  user?: readonly UserModelLayer[];
  /** Reference time for "released in the last year" (tests pin it). */
  now?: Date;
}

export interface BuiltCatalog {
  rows: ModelInfo[];
  /** Human-readable problems, e.g. a user model whose basedOn is unknown. */
  problems: string[];
}

/** How far above the listed price (relative) LiteLLM's may be before the price is disputed. */
const PRICE_DISPUTE_THRESHOLD = 0.05;

/** Providers whose prices LiteLLM cross-checks: first-party list prices only. */
const CROSS_CHECK_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "xai",
  "mistral",
  "groq",
  "amazon-bedrock",
]);

const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;

interface Entry {
  row: ModelInfo;
  source: string;
  confidence: ModelConfidence;
  /** Where the price came from, when not the record's source. */
  priceSource?: string;
  /** Price set by a reviewed source (overlay or user); never cross-checked. */
  priceFixed?: boolean;
  inheritedFrom?: string;
}

interface PriceVerdict {
  priceStatus: PriceStatus;
  budget?: Rates;
  basis?: string;
}

type Rates = NonNullable<ModelProvenance["budgetCost"]>;

/** Exact "provider/model": ids differing only by case are different models (spec 72). */
const keyOf = (providerId: string, modelId: string) => `${providerId}/${modelId}`;
const day = (iso: string) => iso.substring(0, 10);
const stamp = (iso: string) => `${iso.substring(0, 16).replace("T", " ")}Z`;
const padDate = (date: string) => (date.length === 7 ? `${date}-01` : date);

/** Copy `over` onto `base`, skipping undefined values (an absent field is not a value). */
function mergeDefined<T extends object>(base: T, over: Partial<T>): T {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/**
 * A model's family, for sibling lookups: models.dev's `family` field when
 * present, else the id with version and date segments removed
 * ("claude-sonnet-5-5" → "claude-sonnet", "gpt-6-luna" → "gpt-luna",
 * "gemini-3.8-flash" → "gemini-flash").
 */
export function familyKey(model: Pick<ModelInfo, "modelId" | "family">): string {
  if (model.family) return model.family.toLowerCase();
  return model.modelId
    .toLowerCase()
    .split(/[-_]/)
    .filter((part) => !/^v?\d+(\.\d+)*$/.test(part))
    .join("-");
}

/** The first id segment: "claude", "gpt", "gemini", "deepseek". */
const lineKey = (modelId: string) => modelId.toLowerCase().split(/[-_.]/)[0] ?? "";

function hasPrice(cost: ModelCost): cost is NonNullable<ModelCost> {
  return cost !== undefined && (cost.input !== undefined || cost.output !== undefined);
}

/**
 * Whether LiteLLM lists input or output more than the threshold above the
 * listed price. Only then would budgeting at the higher source change
 * anything; a lower reference leaves the listed price in charge.
 */
function isDisputed(listed: NonNullable<ModelCost>, reference: PriceReference): boolean {
  return (["input", "output"] as const).some((field) => {
    const higher = reference[field];
    return higher > 0 && (higher - (listed[field] ?? 0)) / higher > PRICE_DISPUTE_THRESHOLD;
  });
}

/** Field-wise maximum of price rows (the ceiling across sources or siblings). */
function maxRates(rows: readonly NonNullable<ModelCost>[]): Rates {
  const pick = (field: keyof Rates) => {
    const values = rows.map((row) => row[field]).filter((v): v is number => v !== undefined);
    return values.length > 0 ? Math.max(...values) : undefined;
  };
  const base: Rates = { input: pick("input") ?? 0, output: pick("output") ?? 0 };
  return mergeDefined(base, { cache_read: pick("cache_read"), cache_write: pick("cache_write") });
}

const formatRate = (rates: { input?: number; output?: number }) =>
  `$${rates.input ?? 0}/$${rates.output ?? 0} per M`;

/** Newest entry in `candidates` (release date, then update date). */
function newest(candidates: readonly Entry[]): Entry | undefined {
  let best: Entry | undefined;
  for (const entry of candidates) {
    if (
      !best ||
      padDate(entry.row.release_date) > padDate(best.row.release_date) ||
      (entry.row.release_date === best.row.release_date &&
        padDate(entry.row.last_updated) > padDate(best.row.last_updated))
    ) {
      best = entry;
    }
  }
  return best;
}

/** A record for a model only its provider's model list confirms. */
function probeRow(probe: ProbeRecord, sibling: ModelInfo | undefined, today: string): ModelInfo {
  // Without a sibling: pi's own defaults for omitted limits (128k context, 16k output).
  const base: ModelInfo = sibling
    ? { ...sibling, knowledge: undefined, provenance: undefined }
    : {
        providerId: probe.providerId,
        modelId: probe.modelId,
        name: probe.modelId,
        attachment: false,
        reasoning: false,
        tool_call: true,
        limit: { context: 128_000, output: 16_384 },
        modalities: { input: ["text"], output: ["text"] },
        release_date: today,
        last_updated: today,
      };
  const released = probe.releaseDate ?? today;
  return mergeDefined(
    {
      ...base,
      providerId: probe.providerId,
      modelId: probe.modelId,
      // Never inherit a price: an unknown price is budgeted at a flagged ceiling.
      cost: undefined,
      limit: mergeDefined(base.limit, probe.limit ?? {}),
      release_date: released,
      last_updated: released,
    },
    { name: probe.name ?? probe.modelId, attachment: probe.attachment, reasoning: probe.reasoning },
  );
}

/**
 * A record for a user-declared model, over its basedOn (or existing) record
 * when there is one. A new model keeps its own id as its display name unless
 * it gives one: it is not the model it was based on.
 */
function userRow(
  model: UserModelDefinition,
  base: ModelInfo | undefined,
  today: string,
): ModelInfo | undefined {
  const limit = model.limit ?? base?.limit;
  if (!limit) return undefined;
  const slash = model.id.indexOf("/");
  const providerId = model.id.substring(0, slash);
  const modelId = model.id.substring(slash + 1);
  const sameModel = base !== undefined && keyOf(base.providerId, base.modelId) === model.id;
  const start: ModelInfo = base
    ? { ...base, provenance: undefined, name: sameModel ? base.name : modelId }
    : {
        providerId,
        modelId,
        name: modelId,
        attachment: false,
        reasoning: false,
        tool_call: true,
        limit,
        modalities: { input: ["text"], output: ["text"] },
        release_date: today,
        last_updated: today,
      };
  return mergeDefined(
    { ...start, providerId, modelId, limit },
    {
      name: model.name,
      attachment: model.attachment,
      reasoning: model.reasoning,
      tool_call: model.toolCall,
      // Rate by rate: a cache rate the entry omits keeps the base record's.
      cost:
        model.cost &&
        mergeDefined(start.cost ?? {}, {
          input: model.cost.input,
          output: model.cost.output,
          cache_read: model.cost.cacheRead,
          cache_write: model.cost.cacheWrite,
        }),
    },
  );
}

function bundledEntries(bundled: CatalogLayers["bundled"]): Map<string, Entry> {
  const source = `models.dev snapshot ${bundled.lastUpdated ? day(bundled.lastUpdated) : "(bundled)"}`;
  return new Map(
    bundled.rows.map((row) => [
      keyOf(row.providerId, row.modelId),
      { row, source, confidence: "registry" as const },
    ]),
  );
}

/** Fresher models.dev rows. New providers are skipped: hankweave only runs providers it routes. */
function applyLive(entries: Map<string, Entry>, live: CatalogLayers["live"]): void {
  if (!live) return;
  const known = new Set([...entries.values()].map((e) => e.row.providerId.toLowerCase()));
  const source = `models.dev live ${stamp(live.fetchedAt)}`;
  for (const row of live.rows) {
    if (!known.has(row.providerId.toLowerCase())) continue;
    const key = keyOf(row.providerId, row.modelId);
    const existing = entries.get(key);
    entries.set(key, {
      row: existing ? mergeDefined(existing.row, row) : row,
      source,
      confidence: "registry",
    });
  }
}

function indexByProvider(entries: Map<string, Entry>): Map<string, Entry[]> {
  const index = new Map<string, Entry[]>();
  for (const entry of entries.values()) {
    const provider = entry.row.providerId.toLowerCase();
    const list = index.get(provider);
    if (list) list.push(entry);
    else index.set(provider, [entry]);
  }
  return index;
}

/** The newest same-family record, else the newest of the same model line. */
function siblingFor(candidates: readonly Entry[], modelId: string): Entry | undefined {
  const family = familyKey({ modelId });
  const line = lineKey(modelId);
  return (
    newest(candidates.filter((e) => familyKey(e.row) === family)) ??
    newest(candidates.filter((e) => lineKey(e.row.modelId) === line))
  );
}

/** Provider probes, only for ids no registry lists. */
function applyProbes(
  entries: Map<string, Entry>,
  probes: readonly ProbeRecord[],
  today: string,
): void {
  if (probes.length === 0) return;
  const index = indexByProvider(entries);
  for (const probe of probes) {
    const key = keyOf(probe.providerId, probe.modelId);
    if (entries.has(key)) continue;
    const sibling = siblingFor(index.get(probe.providerId.toLowerCase()) ?? [], probe.modelId);
    entries.set(key, {
      row: probeRow(probe, sibling?.row, today),
      source: `${probe.source}, ${day(probe.probedAt)}`,
      confidence: "provisional",
      inheritedFrom: sibling && `${sibling.row.providerId}/${sibling.row.modelId}`,
    });
  }
}

/** Overlay corrections: numbers only. */
function applyCorrections(entries: Map<string, Entry>, overlay: CatalogLayers["overlay"]): void {
  for (const correction of overlay.data.corrections) {
    const entry = entries.get(correction.model);
    if (!entry) continue;
    if (correction.cost) {
      entry.row = { ...entry.row, cost: { ...entry.row.cost, ...correction.cost } };
      entry.priceFixed = true;
      entry.priceSource = `${overlay.source}: ${correction.source}`;
    }
    if (correction.limit) {
      entry.row = { ...entry.row, limit: mergeDefined(entry.row.limit, correction.limit) };
      entry.source = `${entry.source}; limits from ${overlay.source}`;
    }
  }
}

/** What `models` entries are checked against and merged into. */
interface UserMerge {
  entries: Map<string, Entry>;
  /** Providers the catalog has before any `models` block; an entry cannot add one. */
  providers: ReadonlySet<string>;
  today: string;
}

/**
 * Why a `models` entry cannot be used, if it cannot. Its provider must be one
 * the catalog already has: a models entry describes a model (price, limits)
 * for a provider hankweave already knows, it cannot add a provider. A
 * provider only Pi knows prices under its catalog provider ('openai-codex'
 * under 'openai').
 */
function unusableUserModel(merge: UserMerge, id: string): string | undefined {
  const provider = id.substring(0, id.indexOf("/"));
  if (merge.providers.has(provider)) return undefined;
  const pricing = pricingProviderId(provider);
  return pricing === provider
    ? `names provider '${provider}', which the model catalog does not list, and a models entry cannot add a provider; Pi's own catalog decides whether '${id}' runs`
    : `names provider '${provider}', whose models the catalog records under '${pricing}'; declare it as '${pricing}/${id.substring(provider.length + 1)}', which '${id}' is then priced as`;
}

/**
 * A `models` entry for a record the catalog already has, not based on
 * another model: a correction. The record keeps its confidence and source
 * (declaring what Sonnet 5.5 costs does not make it a user-declared model)
 * and takes the declared fields.
 */
function correctedEntry(
  existing: Entry,
  model: UserModelDefinition,
  origin: UserModelOrigin,
  today: string,
): Entry {
  const block = `${origin} models block`;
  const correctsMore = [
    model.limit,
    model.name,
    model.reasoning,
    model.toolCall,
    model.attachment,
  ].some((field) => field !== undefined);
  return {
    ...existing,
    row: userRow(model, existing.row, today) ?? existing.row,
    source: correctsMore ? `${existing.source}; corrected by ${block}` : existing.source,
    ...(model.cost ? { priceFixed: true, priceSource: block } : {}),
  };
}

/**
 * A `models` entry for a model the catalog lacks, or one based on another
 * model: a user-declared record. Returns the problem to report, if any.
 */
function addUserModel(
  merge: UserMerge,
  origin: UserModelOrigin,
  model: UserModelDefinition,
): string | undefined {
  const where = `${origin} models: '${model.id}'`;
  const basedOn = model.basedOn;
  const base = basedOn ? merge.entries.get(basedOn)?.row : undefined;
  const row = userRow(model, base, merge.today);
  if (row) {
    const block = `${origin} models block`;
    merge.entries.set(model.id, {
      row,
      source: block,
      confidence: "user",
      priceFixed: model.cost !== undefined,
      priceSource: model.cost ? block : undefined,
      inheritedFrom: basedOn,
    });
  }
  if (basedOn && !base) {
    return `${where} is based on '${model.basedOn}', which is not in the model catalog`;
  }
  return row
    ? undefined
    : `${where} is not in the model catalog; give basedOn, or limit.context and limit.output`;
}

/** Merge one `models` entry; returns the problem to report about it, if any. */
function applyUserModel(
  merge: UserMerge,
  origin: UserModelOrigin,
  model: UserModelDefinition,
): string | undefined {
  const unusable = unusableUserModel(merge, model.id);
  if (unusable) return `${origin} models: '${model.id}' ${unusable}`;
  const key = model.id;
  const existing = merge.entries.get(key);
  // No basedOn (or basedOn itself) on a record the catalog has: a correction.
  if (existing && (model.basedOn ?? key) === key) {
    merge.entries.set(key, correctedEntry(existing, model, origin, merge.today));
    return undefined;
  }
  return addUserModel(merge, origin, model);
}

/** User `models` blocks, hank.json first, hankweave.json over it. */
function applyUserModels(
  merge: UserMerge,
  layers: readonly UserModelLayer[],
  problems: string[],
): void {
  for (const layer of layers) {
    for (const model of layer.models) {
      const problem = applyUserModel(merge, layer.origin, model);
      if (problem) problems.push(problem);
    }
  }
}

/**
 * One record's price status. LiteLLM (first-party providers only) fills a
 * missing price, and disputes a listed one it prices more than 5% higher; it
 * never lowers a listed price. A price that is zero after either, whatever
 * set it, is `zero`: budgets cannot bind on it, and the preflight says so.
 */
function priceVerdict(
  entry: Entry,
  reference: PriceReference | undefined,
  litellmLabel: string,
): PriceVerdict {
  let cost = entry.row.cost;
  if (!hasPrice(cost)) {
    if (!reference) return { priceStatus: "unknown" };
    cost = { ...reference };
    entry.row = { ...entry.row, cost };
    entry.priceSource = litellmLabel;
  } else if (reference && isDisputed(cost, reference)) {
    return {
      priceStatus: "disputed",
      budget: maxRates([cost, reference]),
      basis: `price sources disagree (models.dev ${formatRate(cost)}, ${litellmLabel} ${formatRate(reference)}); budgets use the higher`,
    };
  }
  const zero = (cost.input ?? 0) === 0 && (cost.output ?? 0) === 0;
  return { priceStatus: zero ? "zero" : "known" };
}

function priceVerdicts(
  entries: Map<string, Entry>,
  litellm: CatalogLayers["litellm"],
): Map<Entry, PriceVerdict> {
  const label = litellm ? `LiteLLM ${day(litellm.fetchedAt)}` : "LiteLLM";
  const verdicts = new Map<Entry, PriceVerdict>();
  for (const [key, entry] of entries) {
    const crossChecked =
      !entry.priceFixed && CROSS_CHECK_PROVIDERS.has(entry.row.providerId.toLowerCase());
    // LiteLLM's map is keyed lowercase.
    const reference = crossChecked ? litellm?.prices[key.toLowerCase()] : undefined;
    verdicts.set(entry, priceVerdict(entry, reference, label));
  }
  return verdicts;
}

/** The rates budgets use for a record with a trusted price, else undefined. */
function pricedRates(
  entry: Entry,
  verdicts: Map<Entry, PriceVerdict>,
): NonNullable<ModelCost> | undefined {
  const verdict = verdicts.get(entry);
  if (verdict?.priceStatus !== "known" && verdict?.priceStatus !== "disputed") return undefined;
  return verdict.budget ?? entry.row.cost;
}

/**
 * The ceiling estimate for an unpriced record: the highest price among its
 * family in the provider released in the last year, else among its whole
 * family, else among its model line released in the last year. Recent
 * siblings first, because old prices are often far off current ones (a new
 * gpt-* budgeted at gpt-4's 2023 rates would stop runs at a tenth of the work).
 */
function ceilingFor(
  entry: Entry,
  candidates: readonly Entry[],
  verdicts: Map<Entry, PriceVerdict>,
  cutoff: string,
): Pick<PriceVerdict, "budget" | "basis"> | undefined {
  const provider = entry.row.providerId.toLowerCase();
  const recent = (e: Entry) => padDate(e.row.release_date) >= cutoff;
  const family = familyKey(entry.row);
  const members = candidates.filter((e) => familyKey(e.row) === family);
  const line = lineKey(entry.row.modelId);
  const choices: [readonly Entry[], string][] = [
    [members.filter(recent), `${family} model(s) in ${provider} released in the last year`],
    [members, `${family} model(s) in ${provider}`],
    [
      candidates.filter((e) => lineKey(e.row.modelId) === line && recent(e)),
      `${provider} ${line}-* model(s) released in the last year`,
    ],
  ];
  for (const [siblings, label] of choices) {
    const rates = siblings
      .filter((e) => e !== entry)
      .map((e) => pricedRates(e, verdicts))
      .filter((r): r is NonNullable<ModelCost> => r !== undefined);
    if (rates.length > 0) {
      return {
        budget: maxRates(rates),
        basis: `ceiling estimate: highest price among ${rates.length} ${label}`,
      };
    }
  }
  return undefined;
}

function applyCeilings(
  entries: Map<string, Entry>,
  verdicts: Map<Entry, PriceVerdict>,
  now: Date,
): void {
  const index = indexByProvider(entries);
  const cutoff = day(new Date(now.getTime() - ONE_YEAR_MS).toISOString());
  for (const [entry, verdict] of verdicts) {
    if (verdict.priceStatus !== "unknown") continue;
    const candidates = index.get(entry.row.providerId.toLowerCase()) ?? [];
    Object.assign(verdict, ceilingFor(entry, candidates, verdicts, cutoff));
  }
}

function withProvenance(entry: Entry, verdict: PriceVerdict): ModelInfo {
  const provenance: ModelProvenance = {
    confidence: entry.confidence,
    source: entry.source,
    priceStatus: verdict.priceStatus,
  };
  return {
    ...entry.row,
    provenance: mergeDefined(provenance, {
      priceSource: entry.priceSource,
      priceDeclared: entry.priceFixed ? (true as const) : undefined,
      budgetCost: verdict.budget,
      budgetCostBasis: verdict.basis,
      inheritedFrom: entry.inheritedFrom,
    }),
  };
}

/** Merge catalog layers into registry-ready records with provenance. */
export function buildCatalogSnapshot(layers: CatalogLayers): BuiltCatalog {
  const now = layers.now ?? new Date();
  const today = day(now.toISOString());
  const problems: string[] = [];

  const entries = bundledEntries(layers.bundled);
  applyLive(entries, layers.live);
  applyProbes(entries, layers.probes ?? [], today);
  applyCorrections(entries, layers.overlay);
  const providers = new Set([...entries.values()].map((e) => e.row.providerId));
  applyUserModels({ entries, providers, today }, layers.user ?? [], problems);

  const verdicts = priceVerdicts(entries, layers.litellm);
  applyCeilings(entries, verdicts, now);
  const rows = [...entries.values()].map((entry) =>
    withProvenance(entry, verdicts.get(entry) ?? { priceStatus: "unknown" }),
  );
  return { rows, problems };
}
