/**
 * Unit tests for server/config-validation/model-validator.ts:
 *
 * - validateModel: passthrough spellings ("pi/…", legacy "opencode/…"),
 *   provider aliasing, and the general rule that non-anthropic registry
 *   models wrap onto the pi runtime.
 * - normalizeLegacyProviderModelInfo: pre-reorg executions persisted
 *   executionPlan entries whose codon.model kept providerId
 *   "google"/"openai"/"opencode" (the removed gemini/codex/opencode shims).
 *   Continuation runs restore that plan verbatim WITHOUT re-running model
 *   validation, and CodonRunner.createProcessManager now accepts only
 *   "anthropic" and "pi" — so without migration the pending codon dies with
 *   "No process manager available". The migration (applied at state restore)
 *   must rewrite these to the pi passthrough exactly as fresh validation would.
 */

import { describe, expect, test } from "bun:test";
import {
  normalizeLegacyProviderModelInfo,
  validateModel,
} from "../../server/config-validation/model-validator";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry";
import type { ModelInfo } from "../../server/llm/models-dev-schema";
import { Logger } from "../../server/utils";

// Initialize the real registry (needed for non-passthrough fallback tests and
// for bare opencode short spellings like "glm-5.2", whose provider only the
// registry can infer — state-manager passes the singleton the same way).
const logger = new Logger("/dev/null");
const registry = LlmProviderRegistry.getInstance({
  logger,
  performHealthCheckOnInit: false,
});

function makeModelInfo(providerId: string, modelId: string): ModelInfo {
  return {
    providerId,
    modelId,
    name: `${providerId}: ${modelId}`,
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

describe("Model Validator — Passthrough Providers", () => {
  describe("opencode → pi passthrough rewrite (opencode shim removed)", () => {
    test("opencode/google/gemini-2.5-flash rewrites to the pi passthrough", () => {
      const result = validateModel("opencode/google/gemini-2.5-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("google/gemini-2.5-flash");
      expect(result.matchType).toBe("exact");
    });

    test("opencode/cerebras/zai-glm-4.7 rewrites to the pi passthrough", () => {
      const result = validateModel("opencode/cerebras/zai-glm-4.7", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("cerebras/zai-glm-4.7");
    });

    test("opencode/anthropic/claude-haiku-4-5 rewrites to the pi passthrough", () => {
      const result = validateModel("opencode/anthropic/claude-haiku-4-5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("anthropic/claude-haiku-4-5");
    });

    test("opencode/glm-5.2 lands on the canonical pi/zai GLM target", () => {
      const result = validateModel("opencode/glm-5.2", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("zai/glm-5.2");
    });
  });

  describe("pi passthrough routing", () => {
    test("pi/anthropic/claude-haiku-4-5 resolves as passthrough", () => {
      const result = validateModel("pi/anthropic/claude-haiku-4-5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("anthropic/claude-haiku-4-5");
      expect(result.matchType).toBe("exact");
    });

    test("pi/openai/gpt-5.4 resolves as passthrough", () => {
      const result = validateModel("pi/openai/gpt-5.4", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("openai/gpt-5.4");
    });

    test("pi/deepseek/deepseek-v4-flash resolves as passthrough", () => {
      const result = validateModel("pi/deepseek/deepseek-v4-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("deepseek/deepseek-v4-flash");
    });
  });

  describe("kimi-k3 routing to OpenRouter via pi shim", () => {
    test("bare kimi-k3 rewrites to pi/openrouter/moonshotai/kimi-k3", () => {
      const result = validateModel("kimi-k3", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("openrouter/moonshotai/kimi-k3");
    });

    test("moonshotai/kimi-k3 rewrites to pi/openrouter/moonshotai/kimi-k3", () => {
      const result = validateModel("moonshotai/kimi-k3", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("openrouter/moonshotai/kimi-k3");
    });

    test("kimi-k3 rewrite is case-insensitive", () => {
      const result = validateModel("Kimi-K3", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("openrouter/moonshotai/kimi-k3");
    });

    test("an explicit pi/openrouter kimi spelling is left untouched", () => {
      const result = validateModel("pi/openrouter/moonshotai/kimi-k3", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("openrouter/moonshotai/kimi-k3");
    });
  });

  describe("openrouter → pi passthrough routing", () => {
    test("openrouter/<org>/<model> rewrites to the pi passthrough", () => {
      const result = validateModel("openrouter/poolside/laguna-s-2.1", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("openrouter/poolside/laguna-s-2.1");
    });

    test("an openrouter model not in the registry still routes via pi", () => {
      const result = validateModel("openrouter/some-org/not-a-real-model-xyz", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("openrouter/some-org/not-a-real-model-xyz");
    });

    test("the openrouter prefix is matched case-insensitively", () => {
      const result = validateModel("OpenRouter/poolside/laguna-s-2.1", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("openrouter/poolside/laguna-s-2.1");
    });

    test("the model id after the prefix keeps its case (pi forwards it verbatim)", () => {
      const result = validateModel("openrouter/Some-Org/Mixed-Case-Model", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.modelId).toBe("openrouter/Some-Org/Mixed-Case-Model");
    });

    test("an explicit pi/openrouter spelling is left untouched (no double prefix)", () => {
      const result = validateModel("pi/openrouter/poolside/laguna-s-2.1", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("openrouter/poolside/laguna-s-2.1");
    });

    test("a registry model whose provider is openrouter wraps to pi", () => {
      const underlying = registry.resolveModel({
        model: "openrouter/poolside/laguna-s-2.1",
        ignoreBlockList: true,
      });
      expect(underlying.success).toBe(true);
      if (!underlying.success) return;

      const result = validateModel("openrouter/poolside/laguna-s-2.1", registry);
      expect(result.valid).toBe(true);
      if (!result.modelInfo) return;
      // Real registry capabilities/cost survive the wrap, not the generic defaults.
      expect(result.modelInfo.limit).toEqual(underlying.modelInfo.limit);
      expect(result.modelInfo.cost).toEqual(underlying.modelInfo.cost);
    });

    test("bare 'openrouter' is treated as a model name, not a provider qualifier", () => {
      // No remainder to route — must not become "pi/openrouter/".
      const result = validateModel("openrouter", registry);
      expect(result.modelInfo?.modelId).not.toBe("openrouter/");
    });

    test("the kimi rewrite still lands on its canonical openrouter target", () => {
      // Guards the rewrite ordering: kimi already emits a pi/openrouter string,
      // which the openrouter rewrite must leave alone.
      const result = validateModel("kimi-k3", registry);
      expect(result.modelInfo?.modelId).toBe("openrouter/moonshotai/kimi-k3");
    });

    test("opencode/openrouter/<model> still lands on a single pi prefix", () => {
      const result = validateModel("opencode/openrouter/poolside/laguna-s-2.1", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("openrouter/poolside/laguna-s-2.1");
    });
  });

  describe("passthrough ModelInfo defaults", () => {
    test("passthrough ModelInfo has expected default fields", () => {
      const result = validateModel("pi/some-provider/some-model", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo).toBeDefined();
      if (!result.modelInfo) return; // type guard for TS
      expect(result.modelInfo.tool_call).toBe(true);
      expect(result.modelInfo.reasoning).toBe(true);
      expect(result.modelInfo.limit.context).toBe(200000);
      expect(result.modelInfo.limit.output).toBe(64000);
      expect(result.modelInfo.cost).toBeUndefined();
      expect(result.modelInfo.modalities.input).toContain("text");
      expect(result.modelInfo.modalities.output).toContain("text");
    });

    test("passthrough name includes provider prefix and modelId", () => {
      const result = validateModel("pi/google/gemini-2.5-flash", registry);
      expect(result.modelInfo?.name).toBe("pi: google/gemini-2.5-flash");
    });
  });

  describe("registry-resolved passthrough ModelInfo", () => {
    test("passthrough with known registry model inherits real capabilities", () => {
      // Resolve the underlying model directly from the registry
      const underlying = registry.resolveModel({
        model: "google/gemini-2.5-flash",
        ignoreBlockList: true,
      });
      expect(underlying.success).toBe(true);
      if (!underlying.success) return;

      // Now resolve via passthrough
      const result = validateModel("pi/google/gemini-2.5-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo).toBeDefined();
      if (!result.modelInfo) return;

      // Should use real registry values, not hardcoded defaults
      expect(result.modelInfo.limit).toEqual(underlying.modelInfo.limit);
      expect(result.modelInfo.modalities).toEqual(underlying.modelInfo.modalities);
      expect(result.modelInfo.reasoning).toBe(underlying.modelInfo.reasoning);
      expect(result.modelInfo.tool_call).toBe(underlying.modelInfo.tool_call);
      expect(result.modelInfo.cost).toEqual(underlying.modelInfo.cost);
      expect(result.modelInfo.attachment).toBe(underlying.modelInfo.attachment);

      // But providerId and modelId should be overridden for the shim
      expect(result.modelInfo.providerId).toBe("pi");
      expect(result.modelInfo.modelId).toBe("google/gemini-2.5-flash");
    });

    test("rewritten opencode passthrough with known registry model inherits real capabilities", () => {
      const underlying = registry.resolveModel({
        model: "anthropic/claude-haiku-4-5",
        ignoreBlockList: true,
      });
      expect(underlying.success).toBe(true);
      if (!underlying.success) return;

      const result = validateModel("opencode/anthropic/claude-haiku-4-5", registry);
      expect(result.valid).toBe(true);
      if (!result.modelInfo) return;

      expect(result.modelInfo.limit).toEqual(underlying.modelInfo.limit);
      expect(result.modelInfo.modalities).toEqual(underlying.modelInfo.modalities);
      expect(result.modelInfo.cost).toEqual(underlying.modelInfo.cost);
      expect(result.modelInfo.providerId).toBe("pi");
    });

    test("passthrough with unknown model falls back to hardcoded defaults", () => {
      const result = validateModel("pi/fake/unknown-model-xyz", registry);
      expect(result.valid).toBe(true);
      if (!result.modelInfo) return;

      expect(result.modelInfo.limit).toEqual({ context: 200000, output: 64000 });
      expect(result.modelInfo.modalities).toEqual({ input: ["text"], output: ["text"] });
      expect(result.modelInfo.reasoning).toBe(true);
      expect(result.modelInfo.tool_call).toBe(true);
      expect(result.modelInfo.cost).toBeUndefined();
    });
  });

  describe("google/openai registry models are wrapped as pi passthrough", () => {
    test("google/gemini-2.5-flash resolves via registry, then wraps to pi", () => {
      const result = validateModel("google/gemini-2.5-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      // The wrapped modelId is "<underlying-provider>/<canonical-id>"
      expect(result.modelInfo?.modelId).toStartWith("google/");
      // Underlying registry capabilities/cost are preserved
      expect(result.modelInfo?.cost).toBeDefined();
    });

    test("bare gemini-2.5-flash resolves via registry, then wraps to pi", () => {
      const result = validateModel("gemini-2.5-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toStartWith("google/");
    });

    test("bare gpt model resolves via registry, then wraps to pi/openai", () => {
      const result = validateModel("gpt-5.2", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toStartWith("openai/");
    });

    test("anthropic models don't hit passthrough", () => {
      const result = validateModel("anthropic/claude-haiku-4-5", registry);
      if (result.valid) {
        expect(result.modelInfo?.providerId).toBe("anthropic");
      }
    });
  });

  describe("deepseek registry models are wrapped as pi passthrough", () => {
    // The pi runtime supports deepseek natively (it resolves DEEPSEEK_API_KEY
    // itself), so deepseek-provider registry models must wrap to pi exactly
    // like google/openai do — not fail with "provider not supported".
    test("bare deepseek-v4-pro resolves via registry, then wraps to pi", () => {
      const result = validateModel("deepseek-v4-pro", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("deepseek/deepseek-v4-pro");
      // Underlying registry capabilities/cost are preserved
      expect(result.modelInfo?.cost).toBeDefined();
    });

    test("deepseek/deepseek-v4-pro resolves via registry, then wraps to pi", () => {
      const result = validateModel("deepseek/deepseek-v4-pro", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("deepseek/deepseek-v4-pro");
    });

    test("pi/deepseek-v4-pro qualifies the bare id with its provider", () => {
      // A bare id after "pi/" must come out provider-qualified: the pi runtime
      // routes "provider/model" strings, and defaults bare non-gemini/gpt ids
      // to anthropic — so "deepseek-v4-pro" alone would fail at runtime.
      const result = validateModel("pi/deepseek-v4-pro", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("deepseek/deepseek-v4-pro");
    });
  });

  describe("general non-anthropic providers wrap onto pi", () => {
    test("groq model wraps to pi (was previously rejected)", () => {
      const result = validateModel("groq/llama-3.3-70b-versatile", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("groq/llama-3.3-70b-versatile");
    });

    test("xai model wraps to pi", () => {
      const result = validateModel("xai/grok-4.5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("xai/grok-4.5");
    });

    test("all moonshotai models route through openrouter, not just kimi-k3", () => {
      const result = validateModel("moonshotai/kimi-k2.5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
      expect(result.modelInfo?.modelId).toBe("openrouter/moonshotai/kimi-k2.5");
    });
  });

  describe("invalid passthrough cases", () => {
    test("unknown prefix doesn't match passthrough", () => {
      const result = validateModel("fakeagent/some-model", registry);
      // Should NOT be valid (fakeagent is not a pass-through shim provider and not in registry)
      // It might fuzzy-match to something in the registry, but the providerId won't be "fakeagent"
      if (result.valid && result.modelInfo) {
        expect(result.modelInfo.providerId).not.toBe("fakeagent");
      }
    });

    test("passthrough requires at least one slash", () => {
      // "pi" alone is not a passthrough — it's a bare model name
      const result = validateModel("pi", registry);
      // This would try registry resolution for "opencode" as a model name
      // The passthrough code only triggers when there's a "/"
      // It may or may not find something — the key test is it doesn't crash
      expect(result).toBeDefined();
    });
  });

  describe("case insensitivity", () => {
    test("OPENCODE/google/gemini-2.5-flash rewrites (case insensitive prefix)", () => {
      const result = validateModel("OPENCODE/google/gemini-2.5-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
    });

    test("Pi/anthropic/claude-haiku-4-5 resolves (mixed case)", () => {
      const result = validateModel("Pi/anthropic/claude-haiku-4-5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
    });
  });
});

describe("normalizeLegacyProviderModelInfo", () => {
  test("legacy google model wraps as pi passthrough", () => {
    const normalized = normalizeLegacyProviderModelInfo(makeModelInfo("google", "gemini-2.5-pro"));
    expect(normalized.providerId).toBe("pi");
    expect(normalized.modelId).toBe("google/gemini-2.5-pro");
    expect(normalized.name).toBe("pi: google/gemini-2.5-pro");
  });

  test("legacy openai model wraps as pi passthrough (effort suffix preserved)", () => {
    const normalized = normalizeLegacyProviderModelInfo(makeModelInfo("openai", "gpt-5.6-high"));
    expect(normalized.providerId).toBe("pi");
    // The suffix stays intact — PiSdkManager resolves it to thinkingLevel.
    expect(normalized.modelId).toBe("openai/gpt-5.6-high");
  });

  test("legacy opencode passthrough model wraps as pi passthrough", () => {
    const normalized = normalizeLegacyProviderModelInfo(
      makeModelInfo("opencode", "deepseek/deepseek-chat"),
    );
    expect(normalized.providerId).toBe("pi");
    expect(normalized.modelId).toBe("deepseek/deepseek-chat");
  });

  test("legacy opencode GLM shorthand lands on the canonical pi/zai target", () => {
    const normalized = normalizeLegacyProviderModelInfo(
      makeModelInfo("opencode", "glm-5.2"),
      registry,
    );
    expect(normalized.providerId).toBe("pi");
    expect(normalized.modelId).toBe("zai/glm-5.2");
  });

  test("legacy opencode bare id without a registry keeps the raw id", () => {
    const normalized = normalizeLegacyProviderModelInfo(makeModelInfo("opencode", "glm-5.2"));
    expect(normalized.providerId).toBe("pi");
    expect(normalized.modelId).toBe("glm-5.2");
  });

  test("legacy deepseek model wraps as pi passthrough", () => {
    const normalized = normalizeLegacyProviderModelInfo(
      makeModelInfo("deepseek", "deepseek-v4-pro"),
    );
    expect(normalized.providerId).toBe("pi");
    expect(normalized.modelId).toBe("deepseek/deepseek-v4-pro");
  });

  test("an openrouter model wraps as pi passthrough", () => {
    // OpenRouter is not natively runnable; a plan carrying providerId
    // "openrouter" must be migrated the same way fresh validation routes it.
    const normalized = normalizeLegacyProviderModelInfo(
      makeModelInfo("openrouter", "poolside/laguna-s-2.1"),
    );
    expect(normalized.providerId).toBe("pi");
    expect(normalized.modelId).toBe("openrouter/poolside/laguna-s-2.1");
    expect(normalized.name).toBe("pi: openrouter/poolside/laguna-s-2.1");
  });

  test("already-normalized pi models are returned unchanged", () => {
    const modelInfo = makeModelInfo("pi", "google/gemini-2.5-pro");
    expect(normalizeLegacyProviderModelInfo(modelInfo)).toBe(modelInfo);
  });

  test("anthropic models are returned unchanged", () => {
    const modelInfo = makeModelInfo("anthropic", "claude-sonnet-4-6");
    expect(normalizeLegacyProviderModelInfo(modelInfo)).toBe(modelInfo);
  });

  test("underlying capabilities and cost survive the wrap", () => {
    const legacy = makeModelInfo("google", "gemini-2.5-pro");
    legacy.cost = { input: 1.25, output: 10 } as ModelInfo["cost"];
    const normalized = normalizeLegacyProviderModelInfo(legacy);
    expect(normalized.cost).toEqual(legacy.cost);
    expect(normalized.limit).toEqual(legacy.limit);
  });
});

describe("Model Validator — CodonRunner.canRun for new providers", () => {
  const { CodonRunner } = require("../../server/codon-runner");

  test("canRun accepts pi provider", () => {
    expect(CodonRunner.canRun({ providerId: "pi" })).toBe(true);
  });

  test("canRun still accepts anthropic", () => {
    expect(CodonRunner.canRun({ providerId: "anthropic" })).toBe(true);
  });

  test("canRun rejects raw google/openai/opencode providers (validation wraps them to pi)", () => {
    expect(CodonRunner.canRun({ providerId: "google" })).toBe(false);
    expect(CodonRunner.canRun({ providerId: "openai" })).toBe(false);
    expect(CodonRunner.canRun({ providerId: "opencode" })).toBe(false);
  });

  test("canRun rejects direct deepseek provider without a harness", () => {
    expect(CodonRunner.canRun({ providerId: "deepseek" })).toBe(false);
  });

  test("canRun rejects unsupported provider", () => {
    expect(CodonRunner.canRun({ providerId: "venice" })).toBe(false);
  });
});

describe("Model Validator — Amazon Bedrock routing", () => {
  const { CodonRunner } = require("../../server/codon-runner");
  const BEDROCK_HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
  const BEDROCK_DEEPSEEK = "us.deepseek.r1-v1:0";

  test("Anthropic-on-Bedrock stays on the Agent SDK (provider amazon-bedrock)", () => {
    const result = validateModel(`amazon-bedrock/${BEDROCK_HAIKU}`, registry);
    expect(result.valid).toBe(true);
    expect(result.modelInfo?.providerId).toBe("amazon-bedrock");
    expect(result.modelInfo?.modelId).toBe(BEDROCK_HAIKU);
  });

  test("Anthropic-on-Bedrock carries registry cost through for the tracker", () => {
    const result = validateModel(`amazon-bedrock/${BEDROCK_HAIKU}`, registry);
    expect(result.valid).toBe(true);
    // CostTracker prices non-pi providers by "<providerId>/<modelId>", which
    // must match the registry's amazon-bedrock index entry.
    expect(result.modelInfo?.cost?.input).toBe(1);
    expect(result.modelInfo?.cost?.output).toBe(5);
  });

  test("explicit pi/ prefix overrides Anthropic-on-Bedrock onto pi", () => {
    const result = validateModel(`pi/amazon-bedrock/${BEDROCK_HAIKU}`, registry);
    expect(result.valid).toBe(true);
    expect(result.modelInfo?.providerId).toBe("pi");
    expect(result.modelInfo?.modelId).toBe(`amazon-bedrock/${BEDROCK_HAIKU}`);
  });

  test("non-Anthropic Bedrock models wrap onto pi", () => {
    const result = validateModel(`amazon-bedrock/${BEDROCK_DEEPSEEK}`, registry);
    expect(result.valid).toBe(true);
    expect(result.modelInfo?.providerId).toBe("pi");
    expect(result.modelInfo?.modelId).toBe(`amazon-bedrock/${BEDROCK_DEEPSEEK}`);
  });

  test("canRun accepts amazon-bedrock only for Anthropic-family model ids", () => {
    expect(CodonRunner.canRun({ providerId: "amazon-bedrock", modelId: BEDROCK_HAIKU })).toBe(true);
    expect(CodonRunner.canRun({ providerId: "amazon-bedrock", modelId: BEDROCK_DEEPSEEK })).toBe(
      false,
    );
  });

  test("persisted Anthropic-on-Bedrock plans survive resume un-wrapped", () => {
    const persisted = makeModelInfo("amazon-bedrock", BEDROCK_HAIKU);
    const normalized = normalizeLegacyProviderModelInfo(persisted, registry);
    expect(normalized.providerId).toBe("amazon-bedrock");
    expect(normalized.modelId).toBe(BEDROCK_HAIKU);
  });

  test("persisted non-Anthropic Bedrock plans normalize onto pi", () => {
    const persisted = makeModelInfo("amazon-bedrock", BEDROCK_DEEPSEEK);
    const normalized = normalizeLegacyProviderModelInfo(persisted, registry);
    expect(normalized.providerId).toBe("pi");
    expect(normalized.modelId).toBe(`amazon-bedrock/${BEDROCK_DEEPSEEK}`);
  });
});
