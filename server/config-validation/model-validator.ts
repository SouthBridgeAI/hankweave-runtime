import { CodonRunner } from "../codon-runner.js";
import type { LlmProviderRegistry } from "../llm/llm-provider-registry.js";
import type { ModelInfo } from "../llm/models-dev-schema.js";
import {
  getSupportedCodonProviderIds,
  inferPiProviderForBareId,
  isPassthroughShimProvider,
  normalizePiProviderId,
  PI_HARNESS,
} from "../provider-ids.js";

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
 * Normalize the provider segment of a qualified spelling to the id the
 * registry and pi both know ("zhipuai/glm-5.2" and "z-ai/glm-5.2" → "zai/…",
 * "moonshot/kimi-k3" → "moonshotai/…"). Leaves everything else untouched.
 */
function aliasQualifiedProvider(model: string): string {
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) return model;
  const prefix = model.substring(0, slashIndex);
  const aliased = normalizePiProviderId(prefix);
  return aliased === prefix.toLowerCase() ? model : `${aliased}${model.substring(slashIndex)}`;
}

/**
 * Normalize a ModelInfo persisted by a pre-upgrade execution. Continuation
 * runs restore the executionPlan verbatim without re-running model validation,
 * so retired encodings must be migrated here:
 *
 * - Migration #1/#2: the removed gemini/codex/opencode shims stored providerId
 *   "google"/"openai"/"opencode". Real provider ids are now natively runnable
 *   (harness selection is late-bound), so only "opencode" still needs work —
 *   bare opencode short spellings ("glm-5.2") need the registry to find their
 *   provider, so they route through validateModel when one is supplied.
 * - Migration #3 (final): the retired "pi" pseudo-provider encoding
 *   (providerId "pi", modelId "<provider>/<model>") reverse-maps to the real
 *   provider by splitting on the first slash. Legacy entries are treated as
 *   routing-derived, not user-forced, so no harnessOverride is set — a legacy
 *   plan that explicitly forced an Anthropic model onto pi re-routes to the
 *   Agent SDK on resume (release-noted). "openrouter/…" modelIds map to
 *   provider "openrouter" verbatim; dispatch-time toPiTarget routes them
 *   unchanged.
 *
 * Already-normalized entries are returned unchanged. Because harness selection
 * is now computed at dispatch from the real provider id, no future routing
 * change requires another migration here.
 */
export function normalizeLegacyProviderModelInfo(
  modelInfo: ModelInfo,
  registry?: LlmProviderRegistry,
): ModelInfo {
  const provider = modelInfo.providerId.toLowerCase();
  if (provider === "opencode") {
    const raw = modelInfo.modelId;
    if (!raw.includes("/") && registry) {
      const result = validateModel(`pi/${raw}`, registry);
      if (result.valid && result.modelInfo) {
        return {
          ...modelInfo,
          providerId: result.modelInfo.providerId,
          modelId: result.modelInfo.modelId,
          name: result.modelInfo.name,
          ...(result.modelInfo.harnessOverride
            ? { harnessOverride: result.modelInfo.harnessOverride }
            : {}),
        };
      }
    }
    // Fall through to the pi reverse-mapping below with the same modelId shape
    // the old opencode migration produced.
    return normalizeLegacyProviderModelInfo({ ...modelInfo, providerId: PI_HARNESS }, registry);
  }
  // The retired pseudo-provider encoding spelled the pi harness id in the
  // provider field — the same string the passthrough-shim prefix uses.
  if (isPassthroughShimProvider(provider)) {
    const raw = modelInfo.modelId;
    const slash = raw.indexOf("/");
    if (slash > 0) {
      return {
        ...modelInfo,
        providerId: raw.substring(0, slash).toLowerCase(),
        modelId: raw.substring(slash + 1),
        name: raw,
      };
    }
    // Bare ids (old opencode-fallback shape): infer the provider the way pi's
    // own router would have at runtime.
    return { ...modelInfo, providerId: inferPiProviderForBareId(raw), name: raw };
  }
  return modelInfo;
}

/**
 * Validates a model string against the LLM registry and the runnable harnesses.
 *
 * The returned ModelInfo always carries the model's REAL identity: providerId
 * is the registry provider ("anthropic", "openai", "amazon-bedrock", …) and
 * modelId the canonical registry id. Which harness executes the codon (Claude
 * Agent SDK vs. embedded pi) is NOT decided here — CodonRunner late-binds it
 * at dispatch via selectHarness(), so persisted plans never encode a routing
 * decision. Validation fails only when the registry doesn't know the model at
 * all.
 *
 * Explicit "pi/<provider>/<model>" spellings are the escape hatch that forces
 * the pi harness: they set harnessOverride: "pi" (capabilities are inherited
 * from the registry when the underlying model is known); a bare id after
 * "pi/" gets its provider from the registry, because pi routes
 * "provider/model" strings and would default a bare id to anthropic.
 *
 * @param model - The model string to validate (e.g., "sonnet", "deepseek-v4-pro")
 * @param registry - The LlmProviderRegistry instance to use for resolution
 * @param providerId - Optional provider ID to narrow the search (e.g., "anthropic", "google")
 * @returns ModelValidationResult with validation outcome
 */
export function validateModel(
  model: string,
  registry: LlmProviderRegistry,
  providerId?: string,
): ModelValidationResult {
  // The opencode shim was removed; its model strings keep working by routing
  // through the pi passthrough, which wraps the same underlying providers.
  if (model.toLowerCase().startsWith("opencode/")) {
    model = `pi/${model.substring("opencode/".length)}`;
  }
  // OpenRouter is reachable only through pi's openrouter provider, and its
  // catalog is far larger than what the registry carries — so an explicitly
  // OpenRouter-qualified spelling ("openrouter/<org>/<model>") routes through
  // the pi passthrough verbatim, registry-known or not. The remainder keeps
  // its case (pi forwards it as-is); a bare "openrouter" with no remainder is
  // a model name, not a provider qualifier.
  if (model.toLowerCase().startsWith("openrouter/") && model.length > "openrouter/".length) {
    model = `pi/openrouter/${model.substring("openrouter/".length)}`;
  }
  model = aliasQualifiedProvider(model);

  // Step 0: Explicit pass-through spellings (e.g., "pi/openai/gpt-5.4").
  // The model ID after the prefix is passed to the shim without requiring the
  // model to be pre-registered in the registry.
  const slashIndex = model.indexOf("/");
  if (slashIndex > 0) {
    const prefix = model.substring(0, slashIndex).toLowerCase();
    if (isPassthroughShimProvider(prefix)) {
      const rest = aliasQualifiedProvider(model.substring(slashIndex + 1));

      // Try to resolve the underlying model from the registry to get real capabilities
      const underlying = registry.resolveModel({ model: rest, ignoreBlockList: true });

      let passthroughModelInfo: ModelInfo;
      const restSlash = rest.indexOf("/");
      if (restSlash > 0) {
        // Provider-qualified spelling ("pi/openai/gpt-x", "pi/openrouter/…"):
        // the user's provider/model split is trusted verbatim as the identity;
        // the registry only contributes capabilities/cost when it knows the
        // model. Dispatch-time toPiTarget re-derives the pi route from it.
        const qualifiedProvider = normalizePiProviderId(rest.substring(0, restSlash));
        const qualifiedModelId = rest.substring(restSlash + 1);
        const base: ModelInfo = underlying.success
          ? underlying.modelInfo
          : {
              providerId: qualifiedProvider,
              modelId: qualifiedModelId,
              name: `${qualifiedProvider}/${qualifiedModelId}`,
              attachment: false,
              reasoning: true,
              tool_call: true,
              cost: undefined,
              limit: { context: 200000, output: 64000 },
              modalities: { input: ["text"], output: ["text"] },
              release_date: "2025-01-01",
              last_updated: "2025-01-01",
            };
        passthroughModelInfo = {
          ...base,
          providerId: qualifiedProvider,
          modelId: qualifiedModelId,
          harnessOverride: PI_HARNESS,
        };
      } else if (underlying.success) {
        // Bare id the registry knows ("pi/deepseek-v4-pro"): the registry
        // supplies the real provider; only the harness override is added.
        passthroughModelInfo = { ...underlying.modelInfo, harnessOverride: PI_HARNESS };
      } else {
        // Bare id not in the registry: infer the provider the way pi's own
        // router would (it defaults bare non-gemini/gpt ids to anthropic).
        const inferredProvider = inferPiProviderForBareId(rest);
        passthroughModelInfo = {
          providerId: inferredProvider,
          modelId: rest,
          name: `${inferredProvider}/${rest}`,
          harnessOverride: PI_HARNESS,
          attachment: false,
          reasoning: true,
          tool_call: true,
          cost: undefined,
          limit: { context: 200000, output: 64000 },
          modalities: { input: ["text"], output: ["text"] },
          release_date: "2025-01-01",
          last_updated: "2025-01-01",
        };
      }

      if (CodonRunner.canRun(passthroughModelInfo)) {
        return {
          valid: true,
          modelInfo: passthroughModelInfo,
          matchType: "exact",
        };
      }
    }
  }

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

  // Step 2: the registry-resolved ModelInfo is returned as-is — real provider,
  // canonical model id. Harness selection (Claude Agent SDK for Anthropic
  // models incl. Anthropic-on-Bedrock, embedded pi for everything else) is
  // late-bound at dispatch by CodonRunner via selectHarness();
  // "pi/amazon-bedrock/…" stays available as the explicit pi override.
  const modelInfo = resolveResult.modelInfo;

  // Step 3: Check if CodonRunner can execute this model
  const canRun = CodonRunner.canRun(modelInfo);

  if (!canRun) {
    const providerName = modelInfo.providerId;
    return {
      valid: false,
      modelInfo,
      reason: `Model '${model}' uses provider '${providerName}' which is not currently supported. Supported providers: ${getSupportedCodonProviderIds().join(", ")}. Please use a model from a supported provider, or a pi passthrough id such as 'pi/<provider>/<model>'.`,
      matchType: resolveResult.matchType,
    };
  }

  // Validation successful
  return {
    valid: true,
    modelInfo,
    matchType: resolveResult.matchType,
  };
}
