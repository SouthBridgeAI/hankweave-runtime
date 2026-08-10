export const PASSTHROUGH_SHIM_PROVIDER_IDS = ["pi"] as const;

/** Registry id of the Amazon Bedrock provider (models.dev spelling). */
export const AMAZON_BEDROCK_PROVIDER_ID = "amazon-bedrock";

/** Providers a codon can execute on, for user-facing error messages. */
export const SUPPORTED_CODON_PROVIDER_IDS = [
  "anthropic",
  AMAZON_BEDROCK_PROVIDER_ID,
  "pi",
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
