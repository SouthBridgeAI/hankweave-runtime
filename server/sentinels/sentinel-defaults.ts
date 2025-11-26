import type { StrandweaveLlmCallParams } from "../types/llm-call-types.js";

/**
 * Default LLM parameters for sentinels.
 * These provide sensible defaults that can be overridden per-sentinel.
 */
export const DEFAULT_SENTINEL_LLM_PARAMS: Required<StrandweaveLlmCallParams> = {
  temperature: 0, // Deterministic by default for consistent sentinel output
  maxOutputTokens: 8192, // Reasonable default for most sentinel responses
  maxRetries: 2, // Retry failed calls twice before giving up
} as const;

/**
 * Merges sentinel-specific LLM params with defaults.
 * Sentinel params take precedence over defaults.
 */
export function mergeWithDefaults(
  sentinelParams?: StrandweaveLlmCallParams,
): Required<StrandweaveLlmCallParams> {
  return {
    ...DEFAULT_SENTINEL_LLM_PARAMS,
    ...sentinelParams,
  };
}
