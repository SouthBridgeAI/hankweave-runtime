import { CodonRunner } from "../codon-runner.js";
import type { LlmProviderRegistry } from "../llm/llm-provider-registry.js";
import type { ModelInfo } from "../llm/models-dev-schema.js";
import {
  getSupportedCodonProviderIds,
  isPassthroughShimProvider,
  runsOnClaudeAgentSdk,
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
 * Registry provider id → pi provider id, only where the names differ.
 * Zhipu AI's canonical registry id is "zhipuai" (with "z-ai" as the
 * OpenRouter-style spelling), but pi only carries its international "Z.AI"
 * brand ("zai", authenticated via ZAI_API_KEY). Moonshot appears as
 * "moonshot"/"moonshot-ai" in some catalogs; pi and models.dev use
 * "moonshotai".
 */
const PI_PROVIDER_ALIASES: Record<string, string> = {
  zhipuai: "zai",
  "z-ai": "zai",
  moonshot: "moonshotai",
  "moonshot-ai": "moonshotai",
};

/**
 * Providers routed through pi's openrouter provider (org-prefixed model ids,
 * authenticated via OPENROUTER_API_KEY) instead of their own pi provider: we
 * don't carry their first-party API keys.
 */
const OPENROUTER_ROUTED_PROVIDERS = new Set(["moonshotai"]);

/** Resolve a provider id to the id pi knows it by (alias-aware, lowercased). */
function normalizePiProviderId(providerId: string): string {
  const lower = providerId.toLowerCase();
  return PI_PROVIDER_ALIASES[lower] ?? lower;
}

/**
 * Map a registry-resolved (provider, model) pair onto the model string pi's
 * runtime routes ("<provider>/<model>"). No catalog check happens here — the
 * mapping is optimistic, and a model pi genuinely can't serve fails at runtime
 * with its own clear "Pi model not found" / missing-key error.
 */
function toPiTarget(providerId: string, modelId: string): string {
  const provider = normalizePiProviderId(providerId);
  if (OPENROUTER_ROUTED_PROVIDERS.has(provider)) {
    return `openrouter/${provider}/${modelId}`;
  }
  return `${provider}/${modelId}`;
}

function wrapAsPiModelInfo(modelInfo: ModelInfo, piModelId: string): ModelInfo {
  return {
    ...modelInfo,
    providerId: "pi",
    modelId: piModelId,
    name: `pi: ${piModelId}`,
  };
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
 * Normalize a ModelInfo persisted by a pre-reorg execution. The removed
 * gemini/codex/opencode shims stored providerId "google"/"openai"/"opencode"
 * in the executionPlan, and continuation runs restore that plan verbatim
 * without re-running model validation — so without this migration,
 * CodonRunner.createProcessManager (which now accepts only anthropic and pi)
 * rejects the pending codon with "No process manager available". Non-anthropic
 * providers wrap as the pi passthrough exactly like fresh validation does;
 * bare opencode short spellings ("glm-5.2") need the registry to find their
 * provider, so they route through validateModel when one is supplied.
 * Already-normalized entries are returned unchanged.
 */
export function normalizeLegacyProviderModelInfo(
  modelInfo: ModelInfo,
  registry?: LlmProviderRegistry,
): ModelInfo {
  const provider = modelInfo.providerId.toLowerCase();
  // Agent-SDK-routed plans (anthropic, and Anthropic-on-Bedrock — same rule
  // as fresh validation in Step 2 below) and pi plans stay as persisted.
  if (provider === "pi" || runsOnClaudeAgentSdk(provider, modelInfo.modelId)) {
    return modelInfo;
  }
  if (provider === "opencode") {
    const raw = modelInfo.modelId;
    if (!raw.includes("/") && registry) {
      const result = validateModel(`pi/${raw}`, registry);
      if (result.valid && result.modelInfo?.providerId === "pi") {
        return {
          ...modelInfo,
          providerId: "pi",
          modelId: result.modelInfo.modelId,
          name: result.modelInfo.name,
        };
      }
    }
    return { ...modelInfo, providerId: "pi", modelId: raw, name: `pi: ${raw}` };
  }
  return wrapAsPiModelInfo(modelInfo, toPiTarget(provider, modelInfo.modelId));
}

/**
 * Validates a model string against the LLM registry and the runnable harnesses.
 *
 * The rule: models that resolve to the "anthropic" provider — and Anthropic
 * models hosted on Amazon Bedrock ("amazon-bedrock/…anthropic.claude-…") —
 * run natively on the Claude Agent SDK; everything else is wrapped as a pi
 * passthrough
 * (providerId "pi", modelId "<provider>/<canonical-id>", underlying
 * capabilities/cost kept — CostTracker prices passthrough models by that
 * "provider/model" modelId). The wrap happens AFTER registry resolution — not
 * as a string rewrite — so fuzzy matching and canonical model-id normalization
 * (e.g. gpt-5.6 spelling routing) still happen. Validation fails only when the
 * registry doesn't know the model at all.
 *
 * Explicit "pi/<provider>/<model>" spellings are trusted verbatim as an escape
 * hatch (capabilities are inherited from the registry when the underlying
 * model is known); a bare id after "pi/" is qualified with the provider the
 * registry resolves, because pi routes "provider/model" strings and would
 * default a bare id to anthropic.
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
      if (underlying.success) {
        // A bare id after the prefix ("pi/deepseek-v4-pro") must come out
        // provider-qualified — pi routes "provider/model" strings and defaults
        // bare non-gemini/gpt ids to anthropic, so the raw id would target the
        // wrong provider at runtime.
        const modelId = rest.includes("/")
          ? rest
          : toPiTarget(underlying.modelInfo.providerId, underlying.modelInfo.modelId);
        passthroughModelInfo = wrapAsPiModelInfo(underlying.modelInfo, modelId);
      } else {
        // Fallback: model not in registry, use generic defaults
        passthroughModelInfo = {
          providerId: prefix,
          modelId: rest,
          name: `${prefix}: ${rest}`,
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

  // Step 2: Anthropic models run natively on the Claude Agent SDK — including
  // Anthropic models hosted on Amazon Bedrock (the Agent SDK's Bedrock mode);
  // "pi/amazon-bedrock/…" stays available as the explicit pi override.
  // Everything else, non-Anthropic Bedrock models included, runs through the
  // embedded pi runtime.
  const resolvedInfo = resolveResult.modelInfo;
  const modelInfo = runsOnClaudeAgentSdk(resolvedInfo.providerId, resolvedInfo.modelId)
    ? resolvedInfo
    : wrapAsPiModelInfo(resolvedInfo, toPiTarget(resolvedInfo.providerId, resolvedInfo.modelId));

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
