/**
 * Unit tests for server/config-validation/model-validator.ts:
 *
 * - validateModel: the returned ModelInfo always carries the model's REAL
 *   identity (providerId = registry provider, modelId = canonical id).
 *   Harness selection is late-bound at dispatch (selectHarness); explicit
 *   "pi/…" spellings set harnessOverride: "pi" instead of rewriting identity.
 *   The pi routing string is derived at dispatch via toPiTarget — asserted
 *   here wherever the old tests asserted the persisted "pi/<provider>/<model>"
 *   encoding.
 * - normalizeLegacyProviderModelInfo: pre-upgrade executions persisted either
 *   shim providerIds ("google"/"openai"/"opencode") or the retired "pi"
 *   pseudo-provider encoding. Continuation runs restore the plan verbatim
 *   WITHOUT re-running model validation, so the migration must reverse-map
 *   those to real provider identities.
 */

import { describe, expect, test } from "bun:test";
import {
  normalizeLegacyProviderModelInfo,
  validateModel,
} from "../../server/config-validation/model-validator";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry";
import type { ModelInfo } from "../../server/llm/models-dev-schema";
import { selectHarness, toPiTarget } from "../../server/provider-ids";
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

/** The pi routing string dispatch would derive for a validation result. */
function piRouteOf(modelInfo: ModelInfo | undefined): string | undefined {
  return modelInfo ? toPiTarget(modelInfo.providerId, modelInfo.modelId) : undefined;
}

describe("Model Validator — Passthrough Providers", () => {
  describe("opencode → pi passthrough rewrite (opencode shim removed)", () => {
    test("opencode/google/gemini-2.5-flash forces the pi harness with a real identity", () => {
      const result = validateModel("opencode/google/gemini-2.5-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("google");
      expect(result.modelInfo?.modelId).toBe("gemini-2.5-flash");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
      expect(result.matchType).toBe("exact");
    });

    test("opencode/cerebras/zai-glm-4.7 forces the pi harness", () => {
      const result = validateModel("opencode/cerebras/zai-glm-4.7", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("cerebras");
      expect(result.modelInfo?.modelId).toBe("zai-glm-4.7");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
    });

    test("opencode/anthropic/claude-haiku-4-5 forces an Anthropic model onto pi", () => {
      const result = validateModel("opencode/anthropic/claude-haiku-4-5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("anthropic");
      expect(result.modelInfo?.modelId).toBe("claude-haiku-4-5");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
      if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("pi");
    });

    test("opencode/glm-5.2 lands on the canonical zai pi route", () => {
      const result = validateModel("opencode/glm-5.2", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.harnessOverride).toBe("pi");
      expect(piRouteOf(result.modelInfo)).toBe("zai/glm-5.2");
    });
  });

  describe("pi passthrough routing", () => {
    test("pi/anthropic/claude-haiku-4-5 keeps the real identity and forces pi", () => {
      const result = validateModel("pi/anthropic/claude-haiku-4-5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("anthropic");
      expect(result.modelInfo?.modelId).toBe("claude-haiku-4-5");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
      if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("pi");
      expect(result.matchType).toBe("exact");
    });

    test("pi/openai/gpt-5.4 resolves with a real identity", () => {
      const result = validateModel("pi/openai/gpt-5.4", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("openai");
      expect(result.modelInfo?.modelId).toBe("gpt-5.4");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
    });

    test("pi/deepseek/deepseek-v4-flash resolves with a real identity", () => {
      const result = validateModel("pi/deepseek/deepseek-v4-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("deepseek");
      expect(result.modelInfo?.modelId).toBe("deepseek-v4-flash");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
    });
  });

  describe("kimi-k3 routing to OpenRouter via pi shim", () => {
    test("bare kimi-k3 resolves to moonshotai and routes via openrouter at dispatch", () => {
      const result = validateModel("kimi-k3", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("moonshotai");
      expect(result.modelInfo?.modelId).toBe("kimi-k3");
      expect(piRouteOf(result.modelInfo)).toBe("openrouter/moonshotai/kimi-k3");
    });

    test("moonshotai/kimi-k3 resolves to moonshotai and routes via openrouter", () => {
      const result = validateModel("moonshotai/kimi-k3", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("moonshotai");
      expect(piRouteOf(result.modelInfo)).toBe("openrouter/moonshotai/kimi-k3");
    });

    test("kimi-k3 resolution is case-insensitive", () => {
      const result = validateModel("Kimi-K3", registry);
      expect(result.valid).toBe(true);
      expect(piRouteOf(result.modelInfo)).toBe("openrouter/moonshotai/kimi-k3");
    });

    test("an explicit pi/openrouter kimi spelling keeps openrouter as the provider", () => {
      const result = validateModel("pi/openrouter/moonshotai/kimi-k3", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("openrouter");
      expect(result.modelInfo?.modelId).toBe("moonshotai/kimi-k3");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
      expect(piRouteOf(result.modelInfo)).toBe("openrouter/moonshotai/kimi-k3");
    });
  });

  describe("openrouter → pi passthrough routing", () => {
    test("openrouter/<org>/<model> keeps openrouter as the provider and forces pi", () => {
      const result = validateModel("openrouter/poolside/laguna-s-2.1", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("openrouter");
      expect(result.modelInfo?.modelId).toBe("poolside/laguna-s-2.1");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
      expect(piRouteOf(result.modelInfo)).toBe("openrouter/poolside/laguna-s-2.1");
    });

    test("an openrouter model not in the registry still routes via pi", () => {
      const result = validateModel("openrouter/some-org/not-a-real-model-xyz", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("openrouter");
      expect(result.modelInfo?.modelId).toBe("some-org/not-a-real-model-xyz");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
    });

    test("the openrouter prefix is matched case-insensitively", () => {
      const result = validateModel("OpenRouter/poolside/laguna-s-2.1", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("openrouter");
      expect(result.modelInfo?.modelId).toBe("poolside/laguna-s-2.1");
    });

    test("the model id after the prefix keeps its case (pi forwards it verbatim)", () => {
      const result = validateModel("openrouter/Some-Org/Mixed-Case-Model", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.modelId).toBe("Some-Org/Mixed-Case-Model");
      expect(piRouteOf(result.modelInfo)).toBe("openrouter/Some-Org/Mixed-Case-Model");
    });

    test("an explicit pi/openrouter spelling is left untouched (no double prefix)", () => {
      const result = validateModel("pi/openrouter/poolside/laguna-s-2.1", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("openrouter");
      expect(result.modelInfo?.modelId).toBe("poolside/laguna-s-2.1");
      expect(piRouteOf(result.modelInfo)).toBe("openrouter/poolside/laguna-s-2.1");
    });

    test("a registry model whose provider is openrouter keeps real capabilities", () => {
      const underlying = registry.resolveModel({
        model: "openrouter/poolside/laguna-s-2.1",
        ignoreBlockList: true,
      });
      expect(underlying.success).toBe(true);
      if (!underlying.success) return;

      const result = validateModel("openrouter/poolside/laguna-s-2.1", registry);
      expect(result.valid).toBe(true);
      if (!result.modelInfo) return;
      // Real registry capabilities/cost survive, not the generic defaults.
      expect(result.modelInfo.limit).toEqual(underlying.modelInfo.limit);
      expect(result.modelInfo.cost).toEqual(underlying.modelInfo.cost);
    });

    test("bare 'openrouter' is treated as a model name, not a provider qualifier", () => {
      // No remainder to route — must not become an "openrouter/" identity.
      const result = validateModel("openrouter", registry);
      expect(result.modelInfo?.modelId).not.toBe("openrouter/");
    });

    test("the kimi rewrite still lands on its canonical openrouter route", () => {
      // Guards the rewrite ordering: kimi resolves to moonshotai, whose
      // dispatch-time route is openrouter-prefixed exactly once.
      const result = validateModel("kimi-k3", registry);
      expect(piRouteOf(result.modelInfo)).toBe("openrouter/moonshotai/kimi-k3");
    });

    test("opencode/openrouter/<model> still lands on a single openrouter prefix", () => {
      const result = validateModel("opencode/openrouter/poolside/laguna-s-2.1", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("openrouter");
      expect(result.modelInfo?.modelId).toBe("poolside/laguna-s-2.1");
      expect(piRouteOf(result.modelInfo)).toBe("openrouter/poolside/laguna-s-2.1");
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

    test("a registry-known passthrough keeps the real display name (no pi: prefix)", () => {
      const result = validateModel("pi/google/gemini-2.5-flash", registry);
      expect(result.modelInfo?.name).toBeDefined();
      expect(result.modelInfo?.name?.startsWith("pi:")).toBe(false);
      expect(result.modelInfo?.providerId).toBe("google");
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

      // Identity stays real; only the harness override marks the pi routing.
      expect(result.modelInfo.providerId).toBe("google");
      expect(result.modelInfo.modelId).toBe("gemini-2.5-flash");
      expect(result.modelInfo.harnessOverride).toBe("pi");
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
      expect(result.modelInfo.providerId).toBe("anthropic");
      expect(result.modelInfo.harnessOverride).toBe("pi");
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

  describe("google/openai registry models keep their real provider (pi at dispatch)", () => {
    test("google/gemini-2.5-flash resolves via registry with its real provider", () => {
      const result = validateModel("google/gemini-2.5-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("google");
      expect(result.modelInfo?.harnessOverride).toBeUndefined();
      if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("pi");
      // Underlying registry capabilities/cost are preserved
      expect(result.modelInfo?.cost).toBeDefined();
    });

    test("bare gemini-2.5-flash resolves via registry to google", () => {
      const result = validateModel("gemini-2.5-flash", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("google");
      if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("pi");
    });

    test("bare gpt model resolves via registry to openai", () => {
      const result = validateModel("gpt-5.2", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("openai");
      if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("pi");
    });

    test("anthropic models stay on the agent-sdk harness", () => {
      const result = validateModel("anthropic/claude-haiku-4-5", registry);
      if (result.valid) {
        expect(result.modelInfo?.providerId).toBe("anthropic");
        if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("claude-agent-sdk");
      }
    });
  });

  describe("deepseek registry models run on pi with their real provider", () => {
    // The pi runtime supports deepseek natively (it resolves DEEPSEEK_API_KEY
    // itself), so deepseek-provider registry models must route to pi at
    // dispatch — not fail with "provider not supported".
    test("bare deepseek-v4-pro resolves via registry to deepseek", () => {
      const result = validateModel("deepseek-v4-pro", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("deepseek");
      expect(result.modelInfo?.modelId).toBe("deepseek-v4-pro");
      if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("pi");
      // Underlying registry capabilities/cost are preserved
      expect(result.modelInfo?.cost).toBeDefined();
    });

    test("deepseek/deepseek-v4-pro resolves via registry", () => {
      const result = validateModel("deepseek/deepseek-v4-pro", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("deepseek");
      expect(result.modelInfo?.modelId).toBe("deepseek-v4-pro");
    });

    test("pi/deepseek-v4-pro qualifies the bare id with its provider", () => {
      // A bare id after "pi/" gets its provider from the registry: the pi
      // runtime routes "provider/model" strings, and defaults bare
      // non-gemini/gpt ids to anthropic — so "deepseek-v4-pro" alone would
      // target the wrong provider at runtime.
      const result = validateModel("pi/deepseek-v4-pro", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("deepseek");
      expect(result.modelInfo?.modelId).toBe("deepseek-v4-pro");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
      expect(piRouteOf(result.modelInfo)).toBe("deepseek/deepseek-v4-pro");
    });
  });

  describe("general non-anthropic providers run on pi", () => {
    test("groq model validates with its real provider (was previously rejected)", () => {
      const result = validateModel("groq/llama-3.3-70b-versatile", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("groq");
      expect(result.modelInfo?.modelId).toBe("llama-3.3-70b-versatile");
      if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("pi");
    });

    test("xai model validates with its real provider", () => {
      const result = validateModel("xai/grok-4.5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("xai");
      expect(result.modelInfo?.modelId).toBe("grok-4.5");
      if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("pi");
    });

    test("all moonshotai models route through openrouter, not just kimi-k3", () => {
      const result = validateModel("moonshotai/kimi-k2.5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("moonshotai");
      expect(piRouteOf(result.modelInfo)).toBe("openrouter/moonshotai/kimi-k2.5");
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
      expect(result.modelInfo?.providerId).toBe("google");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
    });

    test("Pi/anthropic/claude-haiku-4-5 resolves (mixed case)", () => {
      const result = validateModel("Pi/anthropic/claude-haiku-4-5", registry);
      expect(result.valid).toBe(true);
      expect(result.modelInfo?.providerId).toBe("anthropic");
      expect(result.modelInfo?.harnessOverride).toBe("pi");
    });
  });
});

describe("normalizeLegacyProviderModelInfo", () => {
  test("legacy pi encoding reverse-maps to the real provider", () => {
    const normalized = normalizeLegacyProviderModelInfo(
      makeModelInfo("pi", "google/gemini-2.5-pro"),
    );
    expect(normalized.providerId).toBe("google");
    expect(normalized.modelId).toBe("gemini-2.5-pro");
    expect(normalized.harnessOverride).toBeUndefined();
    expect(selectHarness(normalized)).toBe("pi");
  });

  test("legacy pi encoding preserves an effort suffix", () => {
    const normalized = normalizeLegacyProviderModelInfo(makeModelInfo("pi", "openai/gpt-5.6-high"));
    expect(normalized.providerId).toBe("openai");
    // The suffix stays intact — PiSdkManager resolves it to thinkingLevel.
    expect(normalized.modelId).toBe("gpt-5.6-high");
    expect(toPiTarget(normalized.providerId, normalized.modelId)).toBe("openai/gpt-5.6-high");
  });

  test("legacy pi openrouter encoding maps to provider openrouter verbatim", () => {
    const normalized = normalizeLegacyProviderModelInfo(
      makeModelInfo("pi", "openrouter/moonshotai/kimi-k3"),
    );
    expect(normalized.providerId).toBe("openrouter");
    expect(normalized.modelId).toBe("moonshotai/kimi-k3");
    // Dispatch re-derives the same route (and the same pricing key as before).
    expect(toPiTarget(normalized.providerId, normalized.modelId)).toBe(
      "openrouter/moonshotai/kimi-k3",
    );
  });

  test("a legacy pi-forced Anthropic entry re-routes to the agent-sdk (documented change)", () => {
    // Persisted plans don't record whether "pi" was user-forced, so legacy
    // entries are treated as routing-derived: the override is dropped.
    const normalized = normalizeLegacyProviderModelInfo(
      makeModelInfo("pi", "anthropic/claude-opus-4-7"),
    );
    expect(normalized.providerId).toBe("anthropic");
    expect(normalized.modelId).toBe("claude-opus-4-7");
    expect(selectHarness(normalized)).toBe("claude-agent-sdk");
  });

  test("legacy opencode passthrough model reverse-maps to the real provider", () => {
    const normalized = normalizeLegacyProviderModelInfo(
      makeModelInfo("opencode", "deepseek/deepseek-chat"),
    );
    expect(normalized.providerId).toBe("deepseek");
    expect(normalized.modelId).toBe("deepseek-chat");
  });

  test("legacy opencode GLM shorthand lands on the canonical zai pi route", () => {
    const normalized = normalizeLegacyProviderModelInfo(
      makeModelInfo("opencode", "glm-5.2"),
      registry,
    );
    expect(toPiTarget(normalized.providerId, normalized.modelId)).toBe("zai/glm-5.2");
    expect(selectHarness(normalized)).toBe("pi");
  });

  test("legacy opencode bare id without a registry keeps the raw id", () => {
    const normalized = normalizeLegacyProviderModelInfo(makeModelInfo("opencode", "glm-5.2"));
    expect(normalized.modelId).toBe("glm-5.2");
  });

  test("legacy deepseek providerId is already real and stays unchanged", () => {
    const modelInfo = makeModelInfo("deepseek", "deepseek-v4-pro");
    expect(normalizeLegacyProviderModelInfo(modelInfo)).toBe(modelInfo);
    expect(selectHarness(modelInfo)).toBe("pi");
  });

  test("legacy google providerId is already real and stays unchanged", () => {
    const modelInfo = makeModelInfo("google", "gemini-2.5-pro");
    expect(normalizeLegacyProviderModelInfo(modelInfo)).toBe(modelInfo);
    expect(selectHarness(modelInfo)).toBe("pi");
  });

  test("an openrouter providerId is already real and stays unchanged", () => {
    const modelInfo = makeModelInfo("openrouter", "poolside/laguna-s-2.1");
    expect(normalizeLegacyProviderModelInfo(modelInfo)).toBe(modelInfo);
    expect(toPiTarget(modelInfo.providerId, modelInfo.modelId)).toBe(
      "openrouter/poolside/laguna-s-2.1",
    );
  });

  test("anthropic models are returned unchanged", () => {
    const modelInfo = makeModelInfo("anthropic", "claude-sonnet-4-6");
    expect(normalizeLegacyProviderModelInfo(modelInfo)).toBe(modelInfo);
  });

  test("underlying capabilities and cost survive the pi reverse-mapping", () => {
    const legacy = makeModelInfo("pi", "google/gemini-2.5-pro");
    legacy.cost = { input: 1.25, output: 10 } as ModelInfo["cost"];
    const normalized = normalizeLegacyProviderModelInfo(legacy);
    expect(normalized.cost).toEqual(legacy.cost);
    expect(normalized.limit).toEqual(legacy.limit);
  });
});

describe("Model Validator — CodonRunner.canRun and harness selection", () => {
  const { CodonRunner } = require("../../server/codon-runner");

  test("canRun accepts anthropic (agent-sdk harness)", () => {
    expect(CodonRunner.canRun({ providerId: "anthropic", modelId: "claude-sonnet-4-6" })).toBe(
      true,
    );
  });

  test("canRun accepts real non-anthropic providers (pi harness at dispatch)", () => {
    expect(CodonRunner.canRun({ providerId: "google", modelId: "gemini-2.5-pro" })).toBe(true);
    expect(CodonRunner.canRun({ providerId: "openai", modelId: "gpt-5.2" })).toBe(true);
    expect(CodonRunner.canRun({ providerId: "deepseek", modelId: "deepseek-v4-pro" })).toBe(true);
    expect(CodonRunner.canRun({ providerId: "venice", modelId: "some-model" })).toBe(true);
  });

  test("selectHarness routes non-anthropic providers to pi", () => {
    expect(selectHarness({ providerId: "google", modelId: "gemini-2.5-pro" })).toBe("pi");
    expect(selectHarness({ providerId: "openai", modelId: "gpt-5.2" })).toBe("pi");
    expect(selectHarness({ providerId: "deepseek", modelId: "deepseek-v4-pro" })).toBe("pi");
  });

  test("selectHarness routes anthropic to the agent-sdk unless overridden", () => {
    expect(selectHarness({ providerId: "anthropic", modelId: "claude-sonnet-4-6" })).toBe(
      "claude-agent-sdk",
    );
    expect(
      selectHarness({
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
        harnessOverride: "pi",
      }),
    ).toBe("pi");
  });
});

describe("Model Validator — Amazon Bedrock routing", () => {
  const BEDROCK_HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
  const BEDROCK_DEEPSEEK = "us.deepseek.r1-v1:0";

  test("Anthropic-on-Bedrock stays on the Agent SDK (provider amazon-bedrock)", () => {
    const result = validateModel(`amazon-bedrock/${BEDROCK_HAIKU}`, registry);
    expect(result.valid).toBe(true);
    expect(result.modelInfo?.providerId).toBe("amazon-bedrock");
    expect(result.modelInfo?.modelId).toBe(BEDROCK_HAIKU);
    if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("claude-agent-sdk");
  });

  test("Anthropic-on-Bedrock carries registry cost through for the tracker", () => {
    const result = validateModel(`amazon-bedrock/${BEDROCK_HAIKU}`, registry);
    expect(result.valid).toBe(true);
    // CostTracker prices every model by "<providerId>/<modelId>", which must
    // match the registry's amazon-bedrock index entry.
    expect(result.modelInfo?.cost?.input).toBe(1);
    expect(result.modelInfo?.cost?.output).toBe(5);
  });

  test("explicit pi/ prefix overrides Anthropic-on-Bedrock onto pi", () => {
    const result = validateModel(`pi/amazon-bedrock/${BEDROCK_HAIKU}`, registry);
    expect(result.valid).toBe(true);
    expect(result.modelInfo?.providerId).toBe("amazon-bedrock");
    expect(result.modelInfo?.modelId).toBe(BEDROCK_HAIKU);
    expect(result.modelInfo?.harnessOverride).toBe("pi");
    if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("pi");
    expect(piRouteOf(result.modelInfo)).toBe(`amazon-bedrock/${BEDROCK_HAIKU}`);
  });

  test("non-Anthropic Bedrock models keep their real provider and route to pi", () => {
    const result = validateModel(`amazon-bedrock/${BEDROCK_DEEPSEEK}`, registry);
    expect(result.valid).toBe(true);
    expect(result.modelInfo?.providerId).toBe("amazon-bedrock");
    expect(result.modelInfo?.modelId).toBe(BEDROCK_DEEPSEEK);
    if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("pi");
    expect(piRouteOf(result.modelInfo)).toBe(`amazon-bedrock/${BEDROCK_DEEPSEEK}`);
  });

  test("selectHarness splits amazon-bedrock by model family", () => {
    expect(selectHarness({ providerId: "amazon-bedrock", modelId: BEDROCK_HAIKU })).toBe(
      "claude-agent-sdk",
    );
    expect(selectHarness({ providerId: "amazon-bedrock", modelId: BEDROCK_DEEPSEEK })).toBe("pi");
  });

  test("persisted Anthropic-on-Bedrock plans survive resume un-wrapped", () => {
    const persisted = makeModelInfo("amazon-bedrock", BEDROCK_HAIKU);
    const normalized = normalizeLegacyProviderModelInfo(persisted, registry);
    expect(normalized.providerId).toBe("amazon-bedrock");
    expect(normalized.modelId).toBe(BEDROCK_HAIKU);
  });

  test("persisted non-Anthropic Bedrock plans stay real and route to pi", () => {
    const persisted = makeModelInfo("amazon-bedrock", BEDROCK_DEEPSEEK);
    const normalized = normalizeLegacyProviderModelInfo(persisted, registry);
    expect(normalized.providerId).toBe("amazon-bedrock");
    expect(normalized.modelId).toBe(BEDROCK_DEEPSEEK);
    expect(selectHarness(normalized)).toBe("pi");
  });

  test("old-encoding non-Anthropic Bedrock plans reverse-map and route to pi", () => {
    const persisted = makeModelInfo("pi", `amazon-bedrock/${BEDROCK_DEEPSEEK}`);
    const normalized = normalizeLegacyProviderModelInfo(persisted, registry);
    expect(normalized.providerId).toBe("amazon-bedrock");
    expect(normalized.modelId).toBe(BEDROCK_DEEPSEEK);
    expect(selectHarness(normalized)).toBe("pi");
    expect(toPiTarget(normalized.providerId, normalized.modelId)).toBe(
      `amazon-bedrock/${BEDROCK_DEEPSEEK}`,
    );
  });

  test("old-encoding Anthropic-on-Bedrock plans resume onto the Agent SDK", () => {
    const persisted = makeModelInfo("pi", `amazon-bedrock/${BEDROCK_HAIKU}`);
    const normalized = normalizeLegacyProviderModelInfo(persisted, registry);
    expect(normalized.providerId).toBe("amazon-bedrock");
    expect(normalized.modelId).toBe(BEDROCK_HAIKU);
    expect(selectHarness(normalized)).toBe("claude-agent-sdk");
  });
});
