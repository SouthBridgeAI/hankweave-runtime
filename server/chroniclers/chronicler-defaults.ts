import type { TadpoleLlmCallParams } from "../types/llm-call-types.js";

/**
 * Default LLM parameters for chroniclers.
 * These provide sensible defaults that can be overridden per-chronicler.
 */
export const DEFAULT_CHRONICLER_LLM_PARAMS: Required<TadpoleLlmCallParams> = {
  temperature: 0, // Deterministic by default for consistent chronicler output
  maxOutputTokens: 8192, // Reasonable default for most chronicler responses
  maxRetries: 2, // Retry failed calls twice before giving up
} as const;

/**
 * Merges chronicler-specific LLM params with defaults.
 * Chronicler params take precedence over defaults.
 */
export function mergeWithDefaults(
  chroniclerParams?: TadpoleLlmCallParams,
): Required<TadpoleLlmCallParams> {
  return {
    ...DEFAULT_CHRONICLER_LLM_PARAMS,
    ...chroniclerParams,
  };
}
