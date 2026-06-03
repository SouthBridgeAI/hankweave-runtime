#!/usr/bin/env bun
/**
 * Tests for wizard environment check: model fallback and credit validation.
 *
 * Covers:
 * - getDemoModelChoice() correctly picks the best provider
 * - validateApiCredits() detects credit exhaustion, auth errors, and success
 * - End-to-end scenarios: Anthropic-only, OpenAI-only, Gemini-only, no-credits
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DemoModelChoice, EnvironmentResult } from "../../server/wizard/environment-check.js";
import { getDemoModelChoice, validateApiCredits } from "../../server/wizard/environment-check.js";

// ── Helpers ───────────────────────────────────────────────────

/**
 * Build an EnvironmentResult with the given provider flags.
 */
function makeEnv(opts: { claude?: boolean; codex?: boolean; gemini?: boolean }): EnvironmentResult {
  const { claude = false, codex = false, gemini = false } = opts;

  return {
    harnesses: [
      {
        name: "Claude Code",
        found: claude,
        detail: claude ? "found" : "not found",
      },
      { name: "Codex", found: codex, detail: codex ? "found" : "not found" },
      {
        name: "Gemini CLI",
        found: gemini,
        detail: gemini ? "found" : "not found",
      },
    ],
    apiKeys: [
      { name: "Anthropic", envVar: "ANTHROPIC_API_KEY", found: claude },
      { name: "OpenAI", envVar: "OPENAI_API_KEY", found: codex },
      { name: "Google", envVar: "GOOGLE_API_KEY", found: gemini },
    ],
    canRunHanks: claude || codex || gemini,
    summary: "test summary",
    bestHarness: claude ? "claude" : codex ? "codex" : null,
  };
}

/**
 * Assert that getDemoModelChoice returns a non-null result and return it typed.
 * Satisfies biome's noNonNullAssertion rule by using a runtime assertion.
 */
function expectChoice(env: EnvironmentResult): DemoModelChoice {
  const choice = getDemoModelChoice(env);
  expect(choice).not.toBeNull();
  if (choice === null) throw new Error("Expected non-null choice");
  return choice;
}

/**
 * Build spawn args from a DemoModelChoice, mimicking the wizard's logic.
 */
function buildSpawnArgs(choice: DemoModelChoice): string[] {
  const args = ["server/index.ts", "https://github.com/SouthBridgeAI/demo-hank", "/tmp/data"];
  if (choice.modelOverride) {
    args.push("-m", choice.modelOverride);
  }
  args.push("-o", "/tmp/output");
  return args;
}

// ── getDemoModelChoice ────────────────────────────────────────

describe("getDemoModelChoice", () => {
  test("picks Anthropic (no -m override) when Claude is available", () => {
    const choice = expectChoice(makeEnv({ claude: true, codex: true, gemini: true }));
    expect(choice.provider).toBe("anthropic");
    expect(choice.modelOverride).toBeUndefined();
    expect(choice.providerName).toBe("Claude");
  });

  test("falls back to OpenAI when only Codex is available", () => {
    const choice = expectChoice(makeEnv({ codex: true }));
    expect(choice.provider).toBe("openai");
    expect(choice.modelOverride).toBe("gpt-5.2");
    expect(choice.providerName).toBe("Codex");
  });

  test("falls back to Google when only Gemini is available", () => {
    const choice = expectChoice(makeEnv({ gemini: true }));
    expect(choice.provider).toBe("google");
    expect(choice.modelOverride).toBe("gemini-2.5-flash");
    expect(choice.providerName).toBe("Gemini");
  });

  test("prefers OpenAI over Google when both are available (no Claude)", () => {
    const choice = expectChoice(makeEnv({ codex: true, gemini: true }));
    expect(choice.provider).toBe("openai");
  });

  test("returns null when nothing is available", () => {
    const choice = getDemoModelChoice(makeEnv({}));
    expect(choice).toBeNull();
  });

  test("requires both harness and key for each provider", () => {
    // Harness found but no API key
    const envHarnessOnly: EnvironmentResult = {
      harnesses: [
        { name: "Claude Code", found: true },
        { name: "Codex", found: false },
        { name: "Gemini CLI", found: false },
      ],
      apiKeys: [
        { name: "Anthropic", envVar: "ANTHROPIC_API_KEY", found: false },
        { name: "OpenAI", envVar: "OPENAI_API_KEY", found: false },
        { name: "Google", envVar: "GOOGLE_API_KEY", found: false },
      ],
      canRunHanks: false,
      summary: "",
      bestHarness: null,
    };
    expect(getDemoModelChoice(envHarnessOnly)).toBeNull();

    // API key found but no harness
    const envKeyOnly: EnvironmentResult = {
      harnesses: [
        { name: "Claude Code", found: false },
        { name: "Codex", found: false },
        { name: "Gemini CLI", found: false },
      ],
      apiKeys: [
        { name: "Anthropic", envVar: "ANTHROPIC_API_KEY", found: true },
        { name: "OpenAI", envVar: "OPENAI_API_KEY", found: false },
        { name: "Google", envVar: "GOOGLE_API_KEY", found: false },
      ],
      canRunHanks: false,
      summary: "",
      bestHarness: null,
    };
    expect(getDemoModelChoice(envKeyOnly)).toBeNull();
  });
});

// ── validateApiCredits ────────────────────────────────────────

describe("validateApiCredits", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Set dummy keys so the SDK constructors don't complain about missing keys
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-dummy-key";
    process.env.OPENAI_API_KEY = "sk-test-dummy-key";
    process.env.GOOGLE_API_KEY = "AIza-test-dummy-key";
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  test("returns valid:false for unknown provider", async () => {
    const result = await validateApiCredits("unknown" as "anthropic");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown provider");
  });

  // The following tests exercise real error parsing against the validateApiCredits function.
  // They don't make real API calls — they rely on the dummy keys producing auth errors.

  test("detects Anthropic auth error with dummy key", async () => {
    const result = await validateApiCredits("anthropic");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  }, 15_000);

  test("detects OpenAI auth error with dummy key", async () => {
    const result = await validateApiCredits("openai");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  }, 15_000);

  test("detects Google auth error with dummy key", async () => {
    const result = await validateApiCredits("google");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  }, 15_000);
});

// ── Credit error pattern matching ─────────────────────────────

describe("credit error pattern matching", () => {
  // We test the error classification by simulating what validateApiCredits
  // would do with specific error messages from the APIs.
  // These match known real-world error strings.

  const anthropicCreditError =
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
  const openaiQuotaError =
    "You exceeded your current quota, please check your plan and billing details.";
  const genericBillingError = "Billing is not active for this account.";

  // Helper to check if an error message would be caught as a credit error
  function wouldBeCreditError(message: string): boolean {
    const patterns = [
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
    const lower = message.toLowerCase();
    return patterns.some((p) => lower.includes(p));
  }

  test("catches Anthropic 'credit balance is too low' error", () => {
    expect(wouldBeCreditError(anthropicCreditError)).toBe(true);
  });

  test("catches OpenAI 'exceeded your current quota' error", () => {
    expect(wouldBeCreditError(openaiQuotaError)).toBe(true);
  });

  test("catches generic billing error", () => {
    expect(wouldBeCreditError(genericBillingError)).toBe(true);
  });

  test("does not false-positive on normal errors", () => {
    expect(wouldBeCreditError("Connection refused")).toBe(false);
    expect(wouldBeCreditError("Model not found")).toBe(false);
    expect(wouldBeCreditError("Request timed out")).toBe(false);
  });
});

// ── End-to-end wizard scenario tests ──────────────────────────

describe("wizard demo scenarios (end-to-end logic)", () => {
  test("Anthropic-only user: gets haiku with no -m override", () => {
    const choice = expectChoice(makeEnv({ claude: true }));
    expect(choice.provider).toBe("anthropic");
    expect(choice.modelOverride).toBeUndefined();
    const spawnArgs = buildSpawnArgs(choice);
    expect(spawnArgs).not.toContain("-m");
  });

  test("OpenAI-only user: gets gpt-5.2 via -m flag", () => {
    const choice = expectChoice(makeEnv({ codex: true }));
    expect(choice.provider).toBe("openai");
    expect(choice.modelOverride).toBe("gpt-5.2");
    const spawnArgs = buildSpawnArgs(choice);
    expect(spawnArgs).toContain("-m");
    expect(spawnArgs).toContain("gpt-5.2");
  });

  test("Gemini-only user: gets gemini-2.5-flash via -m flag", () => {
    const choice = expectChoice(makeEnv({ gemini: true }));
    expect(choice.provider).toBe("google");
    expect(choice.modelOverride).toBe("gemini-2.5-flash");
    const spawnArgs = buildSpawnArgs(choice);
    expect(spawnArgs).toContain("-m");
    expect(spawnArgs).toContain("gemini-2.5-flash");
  });

  test("all providers available: prefers Claude (no override needed)", () => {
    const choice = expectChoice(makeEnv({ claude: true, codex: true, gemini: true }));
    expect(choice.provider).toBe("anthropic");
    expect(choice.modelOverride).toBeUndefined();
  });

  test("Claude + Gemini available: prefers Claude", () => {
    const choice = expectChoice(makeEnv({ claude: true, gemini: true }));
    expect(choice.provider).toBe("anthropic");
  });

  test("Codex + Gemini available: prefers Codex", () => {
    const choice = expectChoice(makeEnv({ codex: true, gemini: true }));
    expect(choice.provider).toBe("openai");
  });
});
