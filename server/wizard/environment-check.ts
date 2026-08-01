/**
 * Environment Check
 *
 * Detects the Claude Code harness and the API keys needed to run hanks.
 * Non-Anthropic models run on the embedded Pi coding agent (in-process),
 * which only needs the provider API keys — nothing to install.
 * Also provides credit validation via lightweight API calls.
 */

import { detectClaudeExecutable, isLegacyClaudeAuthEnabled } from "../claude-agent-sdk-manager.js";
import { LlmProviderRegistry } from "../llm/llm-provider-registry.js";
import { resolveProviderApiKey } from "../pi-sdk-manager.js";

// ── Types ─────────────────────────────────────────────────────

export interface HarnessStatus {
  name: string;
  found: boolean;
  /** Short label for display (e.g., "found" or "not found") */
  detail?: string;
  /** URL or command to install if missing */
  helpLink?: string;
}

export interface ApiKeyStatus {
  name: string;
  envVar: string;
  found: boolean;
  /** URL to get an API key if missing */
  helpLink?: string;
}

export interface EnvironmentResult {
  harnesses: HarnessStatus[];
  apiKeys: ApiKeyStatus[];
  /** True if at least one harness is found AND its corresponding API key is set */
  canRunHanks: boolean;
  /** Human-readable summary of what they can run */
  summary: string;
  /** The best available harness for the demo (claude > pi) */
  bestHarness: "claude" | "pi" | null;
}

// ── API Key Detection ─────────────────────────────────────────

function hasAnthropicAuth(): boolean {
  // The Agent SDK authenticates via ANTHROPIC_API_KEY (OAuth tokens are not supported).
  // In lenient/legacy mode, also accept the SDK's local Claude Code login fallback.
  return !!process.env.ANTHROPIC_API_KEY || isLegacyClaudeAuthEnabled();
}

function hasOpenAiAuth(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

function hasGoogleAuth(): boolean {
  // GEMINI_API_KEY — the same resolution the embedded pi runtime uses, so
  // "found" here means the exact key value credit validation and the demo
  // session will use exists.
  return !!resolveProviderApiKey("google");
}

// ── Main Check Function ───────────────────────────────────────

/**
 * Run all environment checks and return the results.
 */
export function checkEnvironment(): EnvironmentResult {
  // Detect harnesses. The Pi coding agent is embedded in hankweave itself, so
  // it is always available — non-Anthropic models only need an API key.
  const claudeFound = detectClaudeExecutable() !== null;

  const harnesses: HarnessStatus[] = [
    {
      name: "Claude Code",
      found: claudeFound,
      detail: claudeFound ? "found" : "not found",
      helpLink: claudeFound ? undefined : "https://docs.anthropic.com/en/docs/claude-code",
    },
    {
      name: "Pi coding agent",
      found: true,
      detail: "embedded",
    },
  ];

  // Detect API keys
  const anthropicFound = hasAnthropicAuth();
  const openaiFound = hasOpenAiAuth();
  const googleFound = hasGoogleAuth();

  const apiKeys: ApiKeyStatus[] = [
    {
      name: "Anthropic",
      envVar: "ANTHROPIC_API_KEY",
      found: anthropicFound,
      helpLink: anthropicFound ? undefined : "https://console.anthropic.com/settings/keys",
    },
    {
      name: "OpenAI",
      envVar: "OPENAI_API_KEY",
      found: openaiFound,
      helpLink: openaiFound ? undefined : "https://platform.openai.com/api-keys",
    },
    {
      name: "Google",
      envVar: "GEMINI_API_KEY",
      found: googleFound,
      helpLink: googleFound ? undefined : "https://aistudio.google.com/app/apikey",
    },
  ];

  // Determine what they can run. OpenAI/Google models run on the embedded Pi
  // agent, so an API key alone is enough.
  const canClaude = claudeFound && anthropicFound;
  const canOpenai = openaiFound;
  const canGoogle = googleFound;
  const canRunHanks = canClaude || canOpenai || canGoogle;

  // Build summary
  let summary: string;
  const readyParts: string[] = [];
  if (canClaude) readyParts.push("Claude");
  if (canOpenai) readyParts.push("OpenAI");
  if (canGoogle) readyParts.push("Gemini");

  if (readyParts.length > 0) {
    summary = `You're ready to run ${readyParts.join(" and ")}-based hanks.`;
  } else {
    summary = "No agent harnesses are fully configured yet.";
  }

  // Best harness for demo: claude > pi
  let bestHarness: "claude" | "pi" | null = null;
  if (canClaude) bestHarness = "claude";
  else if (canOpenai || canGoogle) bestHarness = "pi";

  return {
    harnesses,
    apiKeys,
    canRunHanks,
    summary,
    bestHarness,
  };
}

// ── Model Fallback for Demo Hank ──────────────────────────────

/**
 * Fallback model configuration for running the demo hank.
 * The demo hank uses "haiku" (Anthropic). When the user doesn't have
 * Anthropic credentials, we override with -m to use an available provider
 * (routed through the embedded Pi agent).
 *
 * Fallback order: Anthropic (haiku) > OpenAI (gpt-5.2) > Google (gemini-2.5-flash)
 */
export interface DemoModelChoice {
  /** Provider name for display */
  providerName: string;
  /** Model name to pass via -m flag (undefined = use hank default / haiku) */
  modelOverride: string | undefined;
  /** The provider being used */
  provider: "anthropic" | "openai" | "google";
}

/**
 * Determine the best model for running the demo hank based on
 * what credentials and harnesses the user has available.
 *
 * @returns DemoModelChoice, or null if no provider is available
 */
export function getDemoModelChoice(env: EnvironmentResult): DemoModelChoice | null {
  const keyFound = (name: string) => env.apiKeys.some((k) => k.name === name && k.found);
  const claudeHarnessFound = env.harnesses.some((h) => h.name === "Claude Code" && h.found);

  // OpenAI/Google demos run on the embedded Pi agent — the API key is enough.
  if (claudeHarnessFound && keyFound("Anthropic")) {
    return {
      providerName: "Claude",
      modelOverride: undefined, // Demo hank already uses haiku
      provider: "anthropic",
    };
  }
  if (keyFound("OpenAI")) {
    return {
      providerName: "OpenAI",
      modelOverride: "gpt-5.2",
      provider: "openai",
    };
  }
  if (keyFound("Google")) {
    return {
      providerName: "Gemini",
      modelOverride: "gemini-2.5-flash",
      provider: "google",
    };
  }
  return null;
}

// ── API Credit Validation ─────────────────────────────────────

/**
 * Result of a credit validation check.
 */
export interface CreditValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Known error messages that indicate insufficient credits or billing issues.
 * These are checked case-insensitively against API error messages.
 */
const CREDIT_ERROR_PATTERNS = [
  "credit balance is too low",
  "insufficient credits",
  "insufficient_quota",
  "billing",
  "exceeded your current quota",
  "you have exceeded",
  "payment required",
  "billing_not_active",
  "billing hard limit has been reached",
];

/**
 * Validate that an API key has working credits by making a minimal API call.
 *
 * Uses the Vercel AI SDK (@ai-sdk/*) to make a single-token generation request.
 * This catches:
 * - Invalid API keys (auth errors)
 * - Keys with no credits (billing errors)
 * - Network issues
 *
 * Known Anthropic behavior: returns HTTP 400 invalid_request_error with message
 * "Your credit balance is too low to access the Anthropic API."
 *
 * @param provider - Which provider to test ("anthropic" | "openai" | "google")
 * @returns CreditValidationResult
 */
export async function validateApiCredits(
  provider: "anthropic" | "openai" | "google",
): Promise<CreditValidationResult> {
  try {
    const { generateText } = await import("ai");

    // Use the model registry to find the cheapest available model for each
    // provider, so we don't hardcode model names that rot as providers
    // deprecate old models. Hardcoded fallbacks are last-resort only.
    const registry = LlmProviderRegistry.getInstance({ performHealthCheckOnInit: false });

    if (provider === "anthropic") {
      const modelId = registry.findCheapestModel("anthropic") ?? "claude-haiku-4-5";
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      await generateText({
        model: anthropic(modelId),
        maxOutputTokens: 1,
        prompt: "Hi",
      });
    } else if (provider === "openai") {
      const modelId = registry.findCheapestModel("openai") ?? "gpt-4o-mini";
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
      await generateText({
        model: openai(modelId),
        maxOutputTokens: 1,
        prompt: "Hi",
      });
    } else if (provider === "google") {
      const modelId = registry.findCheapestModel("google") ?? "gemini-2.5-flash";
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      // @ai-sdk/google's own env default is GOOGLE_GENERATIVE_AI_API_KEY, so
      // the key must be passed explicitly — use the same resolved value
      // hasGoogleAuth() detected.
      const google = createGoogleGenerativeAI({
        apiKey: resolveProviderApiKey("google"),
      });
      await generateText({
        model: google(modelId),
        maxOutputTokens: 1,
        prompt: "Hi",
      });
    } else {
      return { valid: false, error: `Unknown provider: ${provider}` };
    }

    // If generateText completed without throwing, credits are good
    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const messageLower = message.toLowerCase();

    // Check for known credit/billing errors
    for (const pattern of CREDIT_ERROR_PATTERNS) {
      if (messageLower.includes(pattern)) {
        return {
          valid: false,
          error: `Insufficient credits: ${message}`,
        };
      }
    }

    // Check for auth errors
    if (
      messageLower.includes("authentication") ||
      messageLower.includes("unauthorized") ||
      messageLower.includes("invalid api key") ||
      messageLower.includes("invalid x-goog-api-key") ||
      messageLower.includes("api key not valid")
    ) {
      return {
        valid: false,
        error: `Authentication failed: ${message}`,
      };
    }

    // Unknown error — still a failure
    return {
      valid: false,
      error: `API call failed: ${message}`,
    };
  }
}
