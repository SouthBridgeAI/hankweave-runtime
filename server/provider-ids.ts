import type { ModelInfo } from "./llm/models-dev-schema.js";

/**
 * Canonical ids of the two in-process runtimes a codon can execute on. Single
 * source of truth — every schema, dispatch branch, and comparison uses these
 * constants, never the string literals.
 */
export const CLAUDE_AGENT_SDK_HARNESS = "claude-agent-sdk" as const;
export const PI_HARNESS = "pi" as const;

/** The in-process runtime a codon executes on. */
export type Harness = typeof CLAUDE_AGENT_SDK_HARNESS | typeof PI_HARNESS;

// The pi harness name doubles as the explicit config-spelling prefix
// ("pi/<provider>/<model>") that validateModel step 0 detects.
export const PASSTHROUGH_SHIM_PROVIDER_IDS = [PI_HARNESS] as const;

/** Registry id of the Amazon Bedrock provider (models.dev spelling). */
export const AMAZON_BEDROCK_PROVIDER_ID = "amazon-bedrock";

/** Providers a codon can execute on, for user-facing error messages. */
export const SUPPORTED_CODON_PROVIDER_IDS = [
  "anthropic",
  AMAZON_BEDROCK_PROVIDER_ID,
  PI_HARNESS,
] as const;

const passthroughShimProviderSet = new Set<string>(PASSTHROUGH_SHIM_PROVIDER_IDS);

export function isPassthroughShimProvider(providerId: string): boolean {
  return passthroughShimProviderSet.has(providerId.toLowerCase());
}

export function getSupportedCodonProviderIds(): string[] {
  return [...SUPPORTED_CODON_PROVIDER_IDS];
}

/**
 * Whether a Bedrock model id is an Anthropic-family model. Bedrock spells
 * these "anthropic.claude-…" (on-demand) or "<geo>.anthropic.claude-…"
 * (cross-region inference profiles: us./eu./jp./au./global./us-gov.).
 */
function isBedrockAnthropicModelId(modelId: string): boolean {
  return /(^|\.)anthropic\./i.test(modelId);
}

/**
 * The single routing predicate for the Claude Agent SDK: first-party
 * Anthropic models, and Anthropic-family models hosted on Amazon Bedrock
 * (run via CLAUDE_CODE_USE_BEDROCK). Non-Anthropic Bedrock models never
 * qualify — they route through pi ("pi/amazon-bedrock/…" also remains the
 * explicit pi override for Anthropic-on-Bedrock).
 */
export function runsOnClaudeAgentSdk(providerId: string, modelId: string): boolean {
  const lower = providerId.toLowerCase();
  if (lower === "anthropic") return true;
  return lower === AMAZON_BEDROCK_PROVIDER_ID && isBedrockAnthropicModelId(modelId);
}

/**
 * The single late-bound harness-selection rule, computed at dispatch time from
 * the model's REAL identity. `harnessOverride` is set only when the user
 * explicitly spelled "pi/…" — it forces the pi harness for models that would
 * otherwise run on the Claude Agent SDK.
 */
export function selectHarness(
  model: Pick<ModelInfo, "providerId" | "modelId" | "harnessOverride">,
): Harness {
  if (model.harnessOverride === PI_HARNESS) return PI_HARNESS;
  return runsOnClaudeAgentSdk(model.providerId, model.modelId)
    ? CLAUDE_AGENT_SDK_HARNESS
    : PI_HARNESS;
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
export function normalizePiProviderId(providerId: string): string {
  const lower = providerId.toLowerCase();
  return PI_PROVIDER_ALIASES[lower] ?? lower;
}

/**
 * Map a real (provider, model) pair onto the model string pi's runtime routes
 * ("<provider>/<model>"). Computed at dispatch time — never persisted — so
 * alias/OpenRouter routing changes apply to resumed plans too. No catalog
 * check happens here — the mapping is optimistic, and a model pi genuinely
 * can't serve fails at runtime with its own clear "Pi model not found" /
 * missing-key error.
 */
export function toPiTarget(providerId: string, modelId: string): string {
  const provider = normalizePiProviderId(providerId);
  if (OPENROUTER_ROUTED_PROVIDERS.has(provider)) {
    return `openrouter/${provider}/${modelId}`;
  }
  return `${provider}/${modelId}`;
}

/**
 * Provider pi's router would infer for a bare model id (mirrors
 * PiSdkManager.resolveModelIdentifier): "gemini-" → google; "gpt-", "o1",
 * "o3" → openai; everything else anthropic.
 */
export function inferPiProviderForBareId(modelId: string): string {
  if (modelId.startsWith("gemini-")) return "google";
  if (modelId.startsWith("gpt-") || modelId.startsWith("o1") || modelId.startsWith("o3")) {
    return "openai";
  }
  return "anthropic";
}
