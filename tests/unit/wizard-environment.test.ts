#!/usr/bin/env bun
/**
 * Tests for wizard environment check: model fallback and credit validation.
 *
 * Covers:
 * - getDemoModelChoice() correctly picks the best provider
 * - validateApiCredits() rejects unknown providers
 * - End-to-end scenarios: Anthropic-only, OpenAI-key-only, Google-key-only
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DemoModelChoice, EnvironmentResult } from "../../server/wizard/environment-check.js";
import { getDemoModelChoice, validateApiCredits } from "../../server/wizard/environment-check.js";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";

// ── Helpers ───────────────────────────────────────────────────

/**
 * Build an EnvironmentResult with the given provider flags.
 */
function makeEnv(opts: {
  claude?: boolean;
  openai?: boolean;
  google?: boolean;
}): EnvironmentResult {
  const { claude = false, openai = false, google = false } = opts;

  return {
    harnesses: [
      {
        name: "Claude Code",
        found: claude,
        detail: claude ? "found" : "not found",
      },
      { name: "Pi coding agent", found: true, detail: "embedded" },
    ],
    apiKeys: [
      { name: "Anthropic", envVar: "ANTHROPIC_API_KEY", found: claude },
      { name: "OpenAI", envVar: "OPENAI_API_KEY", found: openai },
      { name: "Google", envVar: "GEMINI_API_KEY", found: google },
    ],
    canRunHanks: claude || openai || google,
    summary: "test summary",
    bestHarness: claude ? "claude-agent-sdk" : openai || google ? "pi" : null,
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

// ── getDemoModelChoice ────────────────────────────────────────

describe("getDemoModelChoice", () => {
  test("picks Anthropic (no -m override) when Claude is available", () => {
    const choice = expectChoice(makeEnv({ claude: true, openai: true, google: true }));
    expect(choice.provider).toBe("anthropic");
    expect(choice.modelOverride).toBeUndefined();
    expect(choice.providerName).toBe("Claude");
  });

  test("falls back to OpenAI (via embedded Pi) when only an OpenAI key is available", () => {
    const choice = expectChoice(makeEnv({ openai: true }));
    expect(choice.provider).toBe("openai");
    expect(choice.modelOverride).toBe("gpt-5.2");
    expect(choice.providerName).toBe("OpenAI");
  });

  test("falls back to Google (via embedded Pi) when only a Google key is available", () => {
    const choice = expectChoice(makeEnv({ google: true }));
    expect(choice.provider).toBe("google");
    expect(choice.modelOverride).toBe("gemini-2.5-flash");
    expect(choice.providerName).toBe("Gemini");
  });

  test("prefers OpenAI over Google when both keys are available (no Claude)", () => {
    const choice = expectChoice(makeEnv({ openai: true, google: true }));
    expect(choice.provider).toBe("openai");
  });

  test("returns null when nothing is available", () => {
    const choice = getDemoModelChoice(makeEnv({}));
    expect(choice).toBeNull();
  });

  test("Claude requires both the harness and the Anthropic key", () => {
    // Harness found but no API key
    const envHarnessOnly: EnvironmentResult = {
      harnesses: [
        { name: "Claude Code", found: true },
        { name: "Pi coding agent", found: true, detail: "embedded" },
      ],
      apiKeys: [
        { name: "Anthropic", envVar: "ANTHROPIC_API_KEY", found: false },
        { name: "OpenAI", envVar: "OPENAI_API_KEY", found: false },
        { name: "Google", envVar: "GEMINI_API_KEY", found: false },
      ],
      canRunHanks: false,
      summary: "",
      bestHarness: null,
    };
    expect(getDemoModelChoice(envHarnessOnly)).toBeNull();

    // Anthropic key found but no Claude harness (and no pi-routable keys)
    const envKeyOnly: EnvironmentResult = {
      harnesses: [
        { name: "Claude Code", found: false },
        { name: "Pi coding agent", found: true, detail: "embedded" },
      ],
      apiKeys: [
        { name: "Anthropic", envVar: "ANTHROPIC_API_KEY", found: true },
        { name: "OpenAI", envVar: "OPENAI_API_KEY", found: false },
        { name: "Google", envVar: "GEMINI_API_KEY", found: false },
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
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = captureEnv();
    // Set dummy keys so the SDK constructors don't complain about missing keys
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-dummy-key";
    process.env.OPENAI_API_KEY = "sk-test-dummy-key";
    process.env.GEMINI_API_KEY = "AIza-test-dummy-key";
  });

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  test("returns valid:false for unknown provider", async () => {
    const result = await validateApiCredits("unknown" as "anthropic");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown provider");
  });
});

// ── End-to-end wizard scenario tests ──────────────────────────

describe("wizard demo scenarios (end-to-end logic)", () => {
  test("Anthropic-only user: gets haiku with no -m override", () => {
    const choice = expectChoice(makeEnv({ claude: true }));
    expect(choice.provider).toBe("anthropic");
    expect(choice.modelOverride).toBeUndefined();
  });

  test("OpenAI-only user: gets gpt-5.2 via -m flag", () => {
    const choice = expectChoice(makeEnv({ openai: true }));
    expect(choice.provider).toBe("openai");
    expect(choice.modelOverride).toBe("gpt-5.2");
  });

  test("Google-key-only user: gets gemini-2.5-flash via -m flag", () => {
    const choice = expectChoice(makeEnv({ google: true }));
    expect(choice.provider).toBe("google");
    expect(choice.modelOverride).toBe("gemini-2.5-flash");
  });

  test("all providers available: prefers Claude (no override needed)", () => {
    const choice = expectChoice(makeEnv({ claude: true, openai: true, google: true }));
    expect(choice.provider).toBe("anthropic");
    expect(choice.modelOverride).toBeUndefined();
  });

  test("Claude + Google key available: prefers Claude", () => {
    const choice = expectChoice(makeEnv({ claude: true, google: true }));
    expect(choice.provider).toBe("anthropic");
  });

  test("OpenAI + Google keys available: prefers OpenAI", () => {
    const choice = expectChoice(makeEnv({ openai: true, google: true }));
    expect(choice.provider).toBe("openai");
  });
});
