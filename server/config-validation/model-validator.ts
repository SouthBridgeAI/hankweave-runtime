import { CodonRunner } from "../codon-runner.js";
import type { LlmProviderRegistry } from "../llm/llm-provider-registry.js";
import type { ModelInfo } from "../llm/models-dev-schema.js";

/**
 * Result of model validation
 */
export interface ModelValidationResult {
  /** Whether the model is valid and can be used */
  valid: boolean;
  /** The resolved ModelInfo if validation succeeded */
  modelInfo?: ModelInfo;
  /** Human-readable reason if validation failed */
  reason?: string;
  /** Type of match that was found (if any) */
  matchType?: "exact" | "exact-with-inferred-provider" | "fuzzy";
}

/**
 * Validates a model string against the LLM registry and CodonRunner capabilities.
 *
 * Validation steps:
 * 1. Resolve the model using LLMProviderRegistry.resolveModel()
 * 2. Check if the resolved model can be run by CodonRunner.canRun()
 *
 * @param model - The model string to validate (e.g., "sonnet", "gemini-2.0-flash-exp")
 * @param registry - The LLMProviderRegistry instance to use for resolution
 * @param providerId - Optional provider ID to narrow the search (e.g., "anthropic", "google")
 * @returns ModelValidationResult with validation outcome
 */
export function validateModel(
  model: string,
  registry: LlmProviderRegistry,
  providerId?: string,
): ModelValidationResult {
  // Step 1: Resolve the model via registry
  const resolveResult = registry.resolveModel({
    model,
    providerId,
    ignoreBlockList: true, // Config validation should not be affected by runtime blocklists
  });

  // If resolution failed, return the reason
  if (!resolveResult.success) {
    let reason: string;

    if (resolveResult.reason === "model-not-found") {
      // Try to provide helpful suggestions by attempting fuzzy matching
      // Note: The registry's resolveModel already does fuzzy matching, so if we're here,
      // even fuzzy matching failed. We'll just provide a clear error.
      reason = `Model '${model}' not found in registry. Please check the model name or ensure the provider is configured.`;
    } else {
      reason = `Model '${model}' is blocked`;
    }

    return {
      valid: false,
      reason,
    };
  }

  // Step 2: Check if CodonRunner can execute this model
  const canRun = CodonRunner.canRun(resolveResult.modelInfo);

  if (!canRun) {
    const supportedProviders = ["anthropic", "google"];
    const providerName = resolveResult.modelInfo.providerId;
    return {
      valid: false,
      modelInfo: resolveResult.modelInfo,
      reason: `Model '${model}' uses provider '${providerName}' which is not currently supported. Supported providers: ${supportedProviders.join(", ")}. Please use a model from a supported provider or configure the appropriate shim.`,
      matchType: resolveResult.matchType,
    };
  }

  // Validation successful
  return {
    valid: true,
    modelInfo: resolveResult.modelInfo,
    matchType: resolveResult.matchType,
  };
}
