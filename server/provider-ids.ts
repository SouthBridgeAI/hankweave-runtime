import { runsOnPi } from "./harness/pi/routing.js";
import type { ModelInfo } from "./llm/index.js";

/**
 * Canonical ids of the two in-process runtimes a codon can execute on. Single
 * source of truth — every schema, dispatch branch, and comparison uses these
 * constants, never the string literals.
 */
export const CLAUDE_AGENT_SDK_HARNESS = "claude-agent-sdk" as const;
export const PI_HARNESS = "pi" as const;

/** The in-process runtime a codon executes on. */
export type Harness = typeof CLAUDE_AGENT_SDK_HARNESS | typeof PI_HARNESS;

/** Registry id of the Amazon Bedrock provider (models.dev spelling). */
export const AMAZON_BEDROCK_PROVIDER_ID = "amazon-bedrock";

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
  if (providerId === "anthropic") return true;
  return providerId === AMAZON_BEDROCK_PROVIDER_ID && isBedrockAnthropicModelId(modelId);
}

/**
 * The single late-bound harness-selection rule, computed at dispatch time from
 * the model's REAL identity, with the same predicates model validation routes
 * by (spec 72): the Claude Agent SDK first, then Pi. `harnessOverride` is set
 * only when the user explicitly spelled "pi/…" — it forces the pi harness for
 * models that would otherwise run on the Claude Agent SDK. Undefined when no
 * harness runs the provider (only a plan persisted by an older version can
 * hold one).
 */
export function selectHarness(
  model: Pick<ModelInfo, "providerId" | "modelId" | "harnessOverride">,
): Harness | undefined {
  if (model.harnessOverride === PI_HARNESS) return PI_HARNESS;
  if (runsOnClaudeAgentSdk(model.providerId, model.modelId)) return CLAUDE_AGENT_SDK_HARNESS;
  return runsOnPi(model.providerId) ? PI_HARNESS : undefined;
}

/**
 * The model string pi's runtime routes ("<provider>/<model>"): the model's
 * identity as written. Computed at dispatch time, never persisted.
 */
export function toPiTarget(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/**
 * Providers whose models are priced under another provider's catalog id.
 *
 * `openai-codex` is pi's ChatGPT-login route to OpenAI's own models. The model
 * catalog (models.dev data) has no such provider, so pricing by the literal
 * key found nothing and every incremental `token.usage` for a codex codon read
 * $0 — budgets could not enforce until the codon's final result arrived with
 * pi's own total. Same models, same token prices: value them as `openai/*`.
 * This maps a provider for pricing only, never a spelling (spec 72).
 */
const PRICING_PROVIDER_ALIASES: Record<string, string> = { "openai-codex": "openai" };

/** The catalog provider whose records price (and describe) this provider's models. */
export function pricingProviderId(providerId: string): string {
  return PRICING_PROVIDER_ALIASES[providerId] ?? providerId;
}
