/**
 * Environment Check
 *
 * Detects installed agent harnesses (Claude Code, Codex, Gemini CLI)
 * and API keys needed to run hanks.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectClaudeExecutable } from "../claude-agent-sdk-manager.js";

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
  // Direct API key
  if (process.env.ANTHROPIC_API_KEY) return true;
  // OAuth token (from Claude Code)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  return false;
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
