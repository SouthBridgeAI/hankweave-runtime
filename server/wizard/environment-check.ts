/**
 * Environment Check
 *
 * Detects installed agent harnesses (Claude Code, Codex, Gemini CLI)
 * and API keys needed to run hanks.
 * Also provides credit validation via lightweight API calls.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectClaudeExecutable, isLegacyClaudeAuthEnabled } from "../claude-agent-sdk-manager.js";
import { LlmProviderRegistry } from "../llm/llm-provider-registry.js";

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
  /** The best available harness for the demo (claude > codex, no gemini) */
  bestHarness: "claude" | "codex" | null;
}

// ── Harness Detection ─────────────────────────────────────────

function detectCodexCli(): boolean {
  // Check standard paths
  const possiblePaths = [
    path.join(os.homedir(), ".npm-global/bin/codex"),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return true;
  }

  // Fall back to `which`
  try {
    const result = execSync("which codex", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return !!result;
  } catch {
    return false;
  }
}

function detectGeminiCli(): boolean {
  // Check standard paths
  const possiblePaths = [
    path.join(os.homedir(), ".npm-global/bin/gemini"),
    "/usr/local/bin/gemini",
    "/opt/homebrew/bin/gemini",
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return true;
  }

  // Fall back to `which`
  try {
    const result = execSync("which gemini", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return !!result;
  } catch {
    return false;
  }
}

// ── API Key Detection ─────────────────────────────────────────

function hasAnthropicAuth(): boolean {
  // The Agent SDK authenticates via ANTHROPIC_API_KEY (OAuth tokens are not supported).
  // In lenient/legacy mode, also accept the SDK's local Claude Code login fallback.
  return !!process.env.ANTHROPIC_API_KEY || isLegacyClaudeAuthEnabled();
}

function hasOpenAiAuth(): boolean {
  // Direct API key
  if (process.env.OPENAI_API_KEY) return true;
  // Codex CLI auth.json
  const codexAuthPath = path.join(os.homedir(), ".codex", "auth.json");
  if (fs.existsSync(codexAuthPath)) {
    try {
      const content = fs.readFileSync(codexAuthPath, "utf-8");
      const auth = JSON.parse(content);
      // The auth file should have some token/key
      if (auth && (auth.token || auth.api_key || auth.access_token)) return true;
    } catch {
      // Malformed auth file - treat as not found
    }
  }
  return false;
}

function hasGoogleAuth(): boolean {
  return !!process.env.GOOGLE_API_KEY;
}

// ── Main Check Function ───────────────────────────────────────

/**
 * Run all environment checks and return the results.
 */
export function checkEnvironment(): EnvironmentResult {
  // Detect harnesses
  const claudeFound = detectClaudeExecutable() !== null;
  const codexFound = detectCodexCli();
  const geminiFound = detectGeminiCli();

  const harnesses: HarnessStatus[] = [
    {
      name: "Claude Code",
      found: claudeFound,
      detail: claudeFound ? "found" : "not found",
      helpLink: claudeFound ? undefined : "https://docs.anthropic.com/en/docs/claude-code",
    },
    {
      name: "Codex",
      found: codexFound,
      detail: codexFound ? "found" : "not found",
      helpLink: codexFound ? undefined : "npm i -g @openai/codex",
    },
    {
      name: "Gemini CLI",
      found: geminiFound,
      detail: geminiFound ? "found" : "not found",
      helpLink: geminiFound ? undefined : "https://github.com/google-gemini/gemini-cli",
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
      envVar: "GOOGLE_API_KEY",
      found: googleFound,
      helpLink: googleFound ? undefined : "https://aistudio.google.com/app/apikey",
    },
  ];

  // Determine what they can run
  const canClaude = claudeFound && anthropicFound;
  const canCodex = codexFound && openaiFound;
  const canGemini = geminiFound && googleFound;
  const canRunHanks = canClaude || canCodex || canGemini;

  // Build summary
  let summary: string;
  const readyParts: string[] = [];
  if (canClaude) readyParts.push("Claude");
  if (canCodex) readyParts.push("Codex");
  if (canGemini) readyParts.push("Gemini");

  if (readyParts.length > 0) {
    summary = `You're ready to run ${readyParts.join(" and ")}-based hanks.`;
  } else {
    summary = "No agent harnesses are fully configured yet.";
  }

  // Best harness for demo: claude > codex, no gemini
  let bestHarness: "claude" | "codex" | null = null;
  if (canClaude) bestHarness = "claude";
  else if (canCodex) bestHarness = "codex";

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
 * Anthropic credentials, we override with -m to use an available provider.
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
  const canClaude = env.harnesses[0]?.found && env.apiKeys[0]?.found;
  const canCodex = env.harnesses[1]?.found && env.apiKeys[1]?.found;
  const canGemini = env.harnesses[2]?.found && env.apiKeys[2]?.found;

  if (canClaude) {
    return {
      providerName: "Claude",
      modelOverride: undefined, // Demo hank already uses haiku
      provider: "anthropic",
    };
  }
  if (canCodex) {
    return {
      providerName: "Codex",
      modelOverride: "gpt-5.2",
      provider: "openai",
    };
  }
  if (canGemini) {
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
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_API_KEY,
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
