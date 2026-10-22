/**
 * The model module's public surface (spec 72). Outside server/llm, import
 * only from here: a spelling goes in, a record or a classified failure comes
 * out, and nothing about catalog layers, stores, refreshes, overlays or
 * suggestions is visible. Tests of internals import server/llm/internal/*.
 */

export { effortBase } from "./internal/catalog-index.js";
export { priceUsage } from "./internal/pricing.js";
export type { RawModelConfigs } from "./internal/sources.js";
export { modelsBlockSchema } from "./internal/user-models.js";
export { Models, type ModelsLoadOptions } from "./models.js";
export type {
  HarnessCheckOptions,
  HarnessCheckResult,
  HarnessCheckStep,
  HarnessModelCheck,
  HarnessRow,
  ModelCheck,
  ModelInfo,
  ModelUse,
  PricedUsage,
  PriceStatus,
  UsageTokens,
} from "./types.js";
