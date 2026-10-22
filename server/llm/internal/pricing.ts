import type { ModelInfo } from "./models-dev-schema.js";

/**
 * Token counts in the Claude session schema's shape, for every provider:
 * `inputTokens` is fresh (uncached) input, and cache reads and writes are
 * additive on top. Both live producers deliver exactly that shape — the
 * Claude Agent SDK natively, and pi by contract: its OpenAI adapters subtract
 * cached and cache-write tokens out of OpenAI's cache-inclusive `input_tokens`
 * before reporting (see `openai-responses-shared.ts` in
 * `@earendil-works/pi-ai`).
 */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface PricedUsage {
  /** USD. */
  cost: number;
  /**
   * True when the model has no known price and the cost is a ceiling
   * estimate (spec 70, "Prices and budgets"). Budgets still bind. Only the
   * cost tracker's re-pricing log line shows the flag; token.usage events do
   * not carry it, and the journal learns of the estimate from the notice at
   * codon start (modelNoticeForCodon).
   */
  estimated: boolean;
}

/**
 * Price a usage with the rates budgets account at: the catalog's budget rates
 * when it set them (a disputed price → the higher source; an unknown price →
 * the ceiling estimate), else the listed price. Returns null when the model
 * has neither.
 */
export function priceUsage(model: ModelInfo, usage: UsageTokens): PricedUsage | null {
  const rates = model.provenance?.budgetCost ?? model.cost;
  if (!rates) return null;
  const perToken = (tokens: number | undefined, rate: number | undefined) =>
    ((tokens ?? 0) / 1_000_000) * (rate ?? 0);
  return {
    cost:
      perToken(usage.inputTokens, rates.input) +
      perToken(usage.outputTokens, rates.output) +
      perToken(usage.cacheReadTokens, rates.cache_read) +
      perToken(usage.cacheCreationTokens, rates.cache_write),
    estimated: model.provenance?.priceStatus === "unknown",
  };
}
