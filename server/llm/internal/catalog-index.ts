import type { ModelInfo } from "./models-dev-schema.js";
import { REASONING_EFFORTS } from "./name-hints.js";

/**
 * hankweave's catalog records, indexed for exact lookup (spec 72). Keys are
 * the "provider/model" id exactly as written: ids and provider names are
 * case-sensitive. The lowercased index exists only to name the correctly
 * cased id in a wrong-case error, and the by-id index only to suggest the
 * same model under another provider.
 */

/**
 * Rate multipliers for the synthesized OpenAI reasoning-effort variants
 * ("<id>-high", "<id>-xhigh"): xhigh is accounted at twice the base rate.
 */
const EFFORT_COST_MULTIPLIER: Record<(typeof REASONING_EFFORTS)[number], number> = {
  high: 1,
  xhigh: 2,
};

function scaleCost<T extends Record<string, number | undefined>>(cost: T, factor: number): T {
  return Object.fromEntries(
    Object.entries(cost).map(([key, value]) => [
      key,
      value === undefined ? undefined : value * factor,
    ]),
  ) as T;
}

/**
 * Reasoning-effort variants ("<id>-high", "<id>-xhigh") of a reasoning-capable
 * OpenAI model. Pi carries the suffix as its thinking level; registering
 * them lets the catalog price them.
 */
function effortVariantsOf(model: ModelInfo): ModelInfo[] {
  if (model.providerId !== "openai" || !model.reasoning) return [];
  return REASONING_EFFORTS.map((effort) => effortVariant(model, effort));
}

/**
 * A reasoning model's effort variant: "<id>-<effort>", rates scaled (xhigh at
 * twice the base), provenance.effortOf naming the base id.
 */
export function effortVariant(
  model: ModelInfo,
  effort: (typeof REASONING_EFFORTS)[number],
): ModelInfo {
  const factor = EFFORT_COST_MULTIPLIER[effort];
  const budgetCost = model.provenance?.budgetCost;
  return {
    ...model,
    modelId: `${model.modelId}-${effort}`,
    name: `${model.name} (${effort})`,
    cost: model.cost && scaleCost(model.cost, factor),
    provenance: model.provenance && {
      ...model.provenance,
      budgetCost: budgetCost && scaleCost(budgetCost, factor),
      effortOf: model.modelId,
    },
  };
}

/** The base record an effort variant was derived from: its id and unscaled rates. */
export function effortBase(model: ModelInfo): ModelInfo {
  const base = model.provenance?.effortOf;
  const effort = /-(xhigh|high)$/.exec(model.modelId)?.[1] as
    | (typeof REASONING_EFFORTS)[number]
    | undefined;
  if (!base || !effort) return model;
  const factor = 1 / EFFORT_COST_MULTIPLIER[effort];
  const budgetCost = model.provenance?.budgetCost;
  const { effortOf: _effortOf, ...provenance } = model.provenance ?? ({} as never);
  return {
    ...model,
    modelId: base,
    name: model.name.replace(new RegExp(` \\(${effort}\\)$`), ""),
    cost: model.cost && scaleCost(model.cost, factor),
    provenance: model.provenance && {
      ...provenance,
      budgetCost: budgetCost && scaleCost(budgetCost, factor),
    },
  };
}

const keyOf = (providerId: string, modelId: string) => `${providerId}/${modelId}`;

export class CatalogIndex {
  private readonly exact = new Map<string, ModelInfo>();
  private readonly lower = new Map<string, ModelInfo>();
  private readonly byProvider = new Map<string, ModelInfo[]>();
  private readonly byModelId = new Map<string, ModelInfo[]>();
  /** Keys of the synthesized effort variants ("openai/<id>-high", "-xhigh"). */
  private readonly variantKeys = new Set<string>();
  /** Providers whose rows were dropped because no harness runs them. */
  readonly dropped: ReadonlySet<string>;
  readonly droppedRows: number;

  /**
   * @param rows - the built catalog
   * @param runnable - whether a harness can run a provider; other providers'
   *   rows are dropped, so they neither resolve nor appear in suggestions
   */
  constructor(rows: readonly ModelInfo[], runnable: (provider: string) => boolean) {
    const dropped = new Set<string>();
    let droppedRows = 0;
    const kept = rows.filter((row) => {
      if (runnable(row.providerId)) return true;
      dropped.add(row.providerId);
      droppedRows++;
      return false;
    });
    for (const row of kept) this.add(row, true);
    // Effort variants register after every base row.
    for (const variant of kept.flatMap(effortVariantsOf)) this.add(variant, false);
    this.dropped = dropped;
    this.droppedRows = droppedRows;
  }

  private add(row: ModelInfo, base: boolean): void {
    const key = keyOf(row.providerId, row.modelId);
    if (this.exact.has(key)) return;
    this.exact.set(key, row);
    if (!this.lower.has(key.toLowerCase())) this.lower.set(key.toLowerCase(), row);
    if (!base) {
      this.variantKeys.add(key);
      return;
    }
    const list = this.byProvider.get(row.providerId);
    if (list) list.push(row);
    else this.byProvider.set(row.providerId, [row]);
    const same = this.byModelId.get(row.modelId);
    if (same) same.push(row);
    else this.byModelId.set(row.modelId, [row]);
  }

  /** Exact "provider/model" lookup: no case folding, no aliases, no inference. */
  get(providerId: string, modelId: string): ModelInfo | undefined {
    return this.exact.get(keyOf(providerId, modelId));
  }

  /** Whether the id is an effort variant the index synthesized, not a listed model. */
  isEffortVariant(providerId: string, modelId: string): boolean {
    return this.variantKeys.has(keyOf(providerId, modelId));
  }

  /** The record a wrongly cased spelling meant, when exactly one casing exists. */
  getIgnoringCase(providerId: string, modelId: string): ModelInfo | undefined {
    return this.lower.get(keyOf(providerId, modelId).toLowerCase());
  }

  hasProvider(providerId: string): boolean {
    return this.byProvider.has(providerId);
  }

  providers(): string[] {
    return [...this.byProvider.keys()];
  }

  /** A provider's records, effort variants included when asked for. */
  rowsOf(providerId: string, withEffortVariants = false): ModelInfo[] {
    const rows = this.byProvider.get(providerId) ?? [];
    return withEffortVariants ? rows.flatMap((r) => [r, ...effortVariantsOf(r)]) : rows;
  }

  /** Records of other providers listing the identical model id. */
  sameModelId(modelId: string): ModelInfo[] {
    return this.byModelId.get(modelId) ?? [];
  }

  /** Every base record (no effort variants). */
  *rows(): IterableIterator<ModelInfo> {
    for (const rows of this.byProvider.values()) yield* rows;
  }
}
