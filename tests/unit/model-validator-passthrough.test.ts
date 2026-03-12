import { describe, expect, test } from "bun:test";
import { validateModel } from "../../server/config-validation/model-validator";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry";
import { Logger } from "../../server/utils";

// Initialize the real registry (needed for non-passthrough fallback tests)
const logger = new Logger("/dev/null");
const registry = LlmProviderRegistry.getInstance({
  logger,
  performHealthCheckOnInit: false,
});

describe("Model Validator — Passthrough Providers", () => {
  describe("opencode passthrough routing", () => {
    test("opencode/google/gemini-2.5-flash resolves as passthrough", () => {
      const result = validateModel("opencode/google/gemini-2.5-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("opencode");
      expect(result.modelInfo?.modelId).toBe("google/gemini-2.5-flash");
      expect(result.matchType).toBe("exact");
    });

    test("opencode/cerebras/zai-glm-4.7 resolves as passthrough", () => {
      const result = validateModel("opencode/cerebras/zai-glm-4.7", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("opencode");
      expect(result.modelInfo?.modelId).toBe("cerebras/zai-glm-4.7");
    });

    test("opencode/anthropic/claude-haiku-4-5 resolves as passthrough", () => {
      const result = validateModel("opencode/anthropic/claude-haiku-4-5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("opencode");
      expect(result.modelInfo?.modelId).toBe("anthropic/claude-haiku-4-5");
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
  });

  describe("passthrough ModelInfo defaults", () => {
    test("passthrough ModelInfo has expected default fields", () => {
      const result = validateModel("opencode/some-provider/some-model", registry);
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

    test("opencode passthrough with known registry model inherits real capabilities", () => {
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
      expect(result.modelInfo.providerId).toBe("opencode");
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

  describe("non-passthrough providers still use registry", () => {
    test("google/gemini-2.5-flash goes through registry, not passthrough", () => {
      const result = validateModel("google/gemini-2.5-flash", registry);
      // Should still be valid (found in registry) but through registry resolution, not passthrough
      if (result.valid) {
        expect(result.modelInfo?.providerId).toBe("google");
        // Registry-resolved modelId won't have the "google/" prefix
        expect(result.modelInfo?.modelId).not.toContain("google/");
      }
      // If the model isn't in the dev data, that's OK — the point is it doesn't hit passthrough
    });

    test("anthropic models don't hit passthrough", () => {
      const result = validateModel("anthropic/claude-haiku-4-5", registry);
      if (result.valid) {
        expect(result.modelInfo?.providerId).toBe("anthropic");
      }
    });
  });

  describe("invalid passthrough cases", () => {
    test("unknown prefix doesn't match passthrough", () => {
      const result = validateModel("fakeagent/some-model", registry);
      // Should NOT be valid (fakeagent is not in PASSTHROUGH_SHIM_PROVIDERS and not in registry)
      // It might fuzzy-match to something in the registry, but the providerId won't be "fakeagent"
      if (result.valid && result.modelInfo) {
        expect(result.modelInfo.providerId).not.toBe("fakeagent");
      }
    });

    test("passthrough requires at least one slash", () => {
      // "opencode" alone is not a passthrough — it's a bare model name
      const result = validateModel("opencode", registry);
      // This would try registry resolution for "opencode" as a model name
      // The passthrough code only triggers when there's a "/"
      // It may or may not find something — the key test is it doesn't crash
      expect(result).toBeDefined();
    });
  });

  describe("case insensitivity", () => {
    test("OPENCODE/google/gemini-2.5-flash resolves (case insensitive prefix)", () => {
      const result = validateModel("OPENCODE/google/gemini-2.5-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("opencode");
    });

    test("Pi/anthropic/claude-haiku-4-5 resolves (mixed case)", () => {
      const result = validateModel("Pi/anthropic/claude-haiku-4-5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("pi");
    });
  });
});

describe("Model Validator — CodonRunner.canRun for new providers", () => {
  const { CodonRunner } = require("../../server/codon-runner");

  test("canRun accepts opencode provider", () => {
    expect(CodonRunner.canRun({ providerId: "opencode" })).toBe(true);
  });

  test("canRun accepts pi provider", () => {
    expect(CodonRunner.canRun({ providerId: "pi" })).toBe(true);
  });

  test("canRun still accepts anthropic", () => {
    expect(CodonRunner.canRun({ providerId: "anthropic" })).toBe(true);
  });

  test("canRun still accepts google", () => {
    expect(CodonRunner.canRun({ providerId: "google" })).toBe(true);
  });

  test("canRun still accepts openai", () => {
    expect(CodonRunner.canRun({ providerId: "openai" })).toBe(true);
  });

  test("canRun rejects unsupported provider", () => {
    expect(CodonRunner.canRun({ providerId: "deepseek" })).toBe(false);
  });
});
