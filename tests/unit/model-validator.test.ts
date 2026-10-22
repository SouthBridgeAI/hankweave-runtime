/**
 * Unit tests for what remains of server/config-validation/model-validator.ts
 * and the dispatch-time routing around it (spec 72). Spellings are checked
 * by the model module (llm-spelling.test.ts); this file covers persisted
 * records:
 *
 * - normalizeLegacyProviderModelInfo: pre-upgrade executions persisted the
 *   retired "pi" pseudo-provider encoding (providerId "pi", modelId
 *   "<provider>/<model>") or the removed opencode shim's. Continuation runs
 *   restore the plan verbatim WITHOUT re-running model validation, so the
 *   migration splits those into real identities. A bare id keeps its raw
 *   shape: nothing infers a provider any more.
 * - CodonRunner.canRun / selectHarness: harness selection is late-bound at
 *   dispatch from the model's real identity; undefined when no harness runs
 *   the provider (only an old persisted plan can hold one).
 * - The ModelInfo schema still loads plans persisted with the old match types
 *   and the "unverified" confidence.
 */

import { describe, expect, test } from "bun:test";
import { CodonRunner } from "../../server/codon-runner";
import { normalizeLegacyProviderModelInfo } from "../../server/config-validation/model-validator";
import { type ModelInfo, Models } from "../../server/llm/index";
import { modelInfoSchema } from "../../server/llm/internal/models-dev-schema";
import { selectHarness, toPiTarget } from "../../server/provider-ids";

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

function resolve(spelling: string): ModelInfo {
  const result = Models.current().check(spelling, "codon");
  if (!result.ok) throw new Error(`${spelling}: ${result.kind}: ${result.message}`);
  return result.model;
}

describe("normalizeLegacyProviderModelInfo", () => {
  test("legacy pi encoding splits into the real provider", () => {
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

  test("legacy opencode qualified model splits into the real provider", () => {
    const normalized = normalizeLegacyProviderModelInfo(
      makeModelInfo("opencode", "deepseek/deepseek-chat"),
    );
    expect(normalized.providerId).toBe("deepseek");
    expect(normalized.modelId).toBe("deepseek-chat");
  });

  test("legacy opencode bare id keeps its raw shape and runs on Pi's OpenCode Zen", () => {
    const persisted = makeModelInfo("opencode", "glm-5.2");
    const normalized = normalizeLegacyProviderModelInfo(persisted);
    expect(normalized).toBe(persisted);
    // No zhipuai/zai inference: "opencode" is a real Pi provider now.
    expect(selectHarness(normalized)).toBe("pi");
    expect(toPiTarget(normalized.providerId, normalized.modelId)).toBe("opencode/glm-5.2");
  });

  test("legacy pi bare id keeps its raw shape and no harness runs it", () => {
    const persisted = makeModelInfo("pi", "deepseek-v4-pro");
    const normalized = normalizeLegacyProviderModelInfo(persisted);
    expect(normalized).toBe(persisted);
    expect(selectHarness(normalized)).toBeUndefined();
    expect(CodonRunner.canRun(normalized)).toBe(false);
  });

  test("already-real providers are returned unchanged", () => {
    for (const [provider, id] of [
      ["deepseek", "deepseek-v4-pro"],
      ["google", "gemini-2.5-pro"],
      ["openrouter", "poolside/laguna-s-2.1"],
      ["anthropic", "claude-sonnet-4-6"],
    ] as const) {
      const modelInfo = makeModelInfo(provider, id);
      expect(normalizeLegacyProviderModelInfo(modelInfo)).toBe(modelInfo);
    }
  });

  test("matches 'PI' and 'OpenCode' in any case and lowercases the split provider", () => {
    // Earlier versions matched these case-insensitively and stored the split
    // provider lowercased; the model id keeps its case.
    for (const legacy of ["PI", "Pi", "OpenCode", "OPENCODE"]) {
      const normalized = normalizeLegacyProviderModelInfo(
        makeModelInfo(legacy, "DeepSeek/DeepSeek-V4-Pro"),
      );
      expect(normalized.providerId).toBe("deepseek");
      expect(normalized.modelId).toBe("DeepSeek-V4-Pro");
      expect(normalized.name).toBe("DeepSeek/DeepSeek-V4-Pro");
    }
    // A bare id under an upper-case legacy provider still keeps its raw shape.
    const bare = makeModelInfo("PI", "deepseek-v4-pro");
    expect(normalizeLegacyProviderModelInfo(bare)).toBe(bare);
  });

  test("underlying capabilities and cost survive the pi split", () => {
    const legacy = makeModelInfo("pi", "google/gemini-2.5-pro");
    legacy.cost = { input: 1.25, output: 10 } as ModelInfo["cost"];
    const normalized = normalizeLegacyProviderModelInfo(legacy);
    expect(normalized.cost).toEqual(legacy.cost);
    expect(normalized.limit).toEqual(legacy.limit);
  });
});

describe("CodonRunner.canRun and selectHarness", () => {
  test("canRun accepts anthropic (agent-sdk harness)", () => {
    expect(CodonRunner.canRun(makeModelInfo("anthropic", "claude-sonnet-4-6"))).toBe(true);
  });

  test("canRun accepts providers Pi runs", () => {
    for (const [provider, id] of [
      ["google", "gemini-2.5-pro"],
      ["openai", "gpt-5.2"],
      ["deepseek", "deepseek-v4-pro"],
      ["openai-codex", "gpt-5.6-sol"],
      ["opencode", "claude-haiku-4-5"],
      ["moonshotai", "kimi-k3"],
    ] as const) {
      expect({ provider, canRun: CodonRunner.canRun(makeModelInfo(provider, id)) }).toEqual({
        provider,
        canRun: true,
      });
    }
  });

  test("canRun refuses a provider no harness runs", () => {
    for (const provider of ["zhipuai", "deepinfra", "pi"]) {
      const model = makeModelInfo(provider, "some-model");
      expect(selectHarness(model)).toBeUndefined();
      expect(CodonRunner.canRun(model)).toBe(false);
    }
  });

  test("selectHarness routes non-anthropic providers to pi", () => {
    expect(selectHarness({ providerId: "google", modelId: "gemini-2.5-pro" })).toBe("pi");
    expect(selectHarness({ providerId: "openai", modelId: "gpt-5.2" })).toBe("pi");
    expect(selectHarness({ providerId: "deepseek", modelId: "deepseek-v4-pro" })).toBe("pi");
  });

  test("selectHarness routes anthropic to the agent-sdk unless pi is forced", () => {
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

  test("provider names are case-sensitive at dispatch too", () => {
    expect(
      selectHarness({ providerId: "Anthropic", modelId: "claude-sonnet-4-6" }),
    ).toBeUndefined();
  });
});

describe("Amazon Bedrock routing", () => {
  const BEDROCK_HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
  const BEDROCK_DEEPSEEK = "us.deepseek.r1-v1:0";

  test("selectHarness splits amazon-bedrock by model family", () => {
    expect(selectHarness({ providerId: "amazon-bedrock", modelId: BEDROCK_HAIKU })).toBe(
      "claude-agent-sdk",
    );
    expect(
      selectHarness({ providerId: "amazon-bedrock", modelId: "anthropic.claude-haiku-4-5-v1:0" }),
    ).toBe("claude-agent-sdk");
    expect(
      selectHarness({
        providerId: "amazon-bedrock",
        modelId: "global.anthropic.claude-opus-4-6-v1",
      }),
    ).toBe("claude-agent-sdk");
    expect(selectHarness({ providerId: "amazon-bedrock", modelId: BEDROCK_DEEPSEEK })).toBe("pi");
  });

  test("Anthropic-on-Bedrock resolves under amazon-bedrock and stays on the Agent SDK", () => {
    const model = resolve(`amazon-bedrock/${BEDROCK_HAIKU}`);
    expect(model.providerId).toBe("amazon-bedrock");
    expect(model.modelId).toBe(BEDROCK_HAIKU);
    expect(selectHarness(model)).toBe("claude-agent-sdk");
    // CostTracker prices every model by "<providerId>/<modelId>".
    expect(model.cost?.input).toBe(1.1);
    expect(model.cost?.output).toBe(5.5);
  });

  test("an explicit pi/ prefix forces Anthropic-on-Bedrock onto pi", () => {
    const model = resolve(`pi/amazon-bedrock/${BEDROCK_HAIKU}`);
    expect(model.providerId).toBe("amazon-bedrock");
    expect(model.modelId).toBe(BEDROCK_HAIKU);
    expect(model.harnessOverride).toBe("pi");
    expect(selectHarness(model)).toBe("pi");
    expect(toPiTarget(model.providerId, model.modelId)).toBe(`amazon-bedrock/${BEDROCK_HAIKU}`);
  });

  test("non-Anthropic Bedrock models keep their real provider and route to pi", () => {
    const model = resolve(`amazon-bedrock/${BEDROCK_DEEPSEEK}`);
    expect(model.providerId).toBe("amazon-bedrock");
    expect(model.modelId).toBe(BEDROCK_DEEPSEEK);
    expect(selectHarness(model)).toBe("pi");
  });

  test("persisted Bedrock plans pass through unchanged", () => {
    for (const id of [BEDROCK_HAIKU, BEDROCK_DEEPSEEK]) {
      const persisted = makeModelInfo("amazon-bedrock", id);
      expect(normalizeLegacyProviderModelInfo(persisted)).toBe(persisted);
    }
  });

  test("old-encoding Bedrock plans split and route by family", () => {
    const deepseek = normalizeLegacyProviderModelInfo(
      makeModelInfo("pi", `amazon-bedrock/${BEDROCK_DEEPSEEK}`),
    );
    expect(deepseek.providerId).toBe("amazon-bedrock");
    expect(deepseek.modelId).toBe(BEDROCK_DEEPSEEK);
    expect(selectHarness(deepseek)).toBe("pi");

    const haiku = normalizeLegacyProviderModelInfo(
      makeModelInfo("pi", `amazon-bedrock/${BEDROCK_HAIKU}`),
    );
    expect(haiku.providerId).toBe("amazon-bedrock");
    expect(haiku.modelId).toBe(BEDROCK_HAIKU);
    expect(selectHarness(haiku)).toBe("claude-agent-sdk");
  });
});

describe("persisted ModelInfo schema", () => {
  const persisted = (provenance: Record<string, unknown>) => ({
    ...makeModelInfo("anthropic", "claude-sonnet-4-5"),
    provenance: { source: "models.dev snapshot 2026-06-01", priceStatus: "known", ...provenance },
  });

  test.each(["shortcut", "alias", "exact-with-inferred-provider", "exact"])(
    "a plan persisted with matchType '%s' still parses",
    (matchType) => {
      const parsed = modelInfoSchema.safeParse(
        persisted({ confidence: "registry", requestedAs: "sonnet", matchType }),
      );
      expect(parsed.success).toBe(true);
      expect(parsed.data?.provenance?.matchType).toBe(matchType);
    },
  );

  test("a plan persisted with confidence 'unverified' still parses", () => {
    const parsed = modelInfoSchema.safeParse(
      persisted({ confidence: "unverified", requestedAs: "pi/foo/bar", matchType: "exact" }),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data?.provenance?.confidence).toBe("unverified");
  });

  test("the new 'harness' confidence and evidence parse", () => {
    const parsed = modelInfoSchema.safeParse(
      persisted({ confidence: "harness", matchType: "exact", evidence: "pi catalog" }),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data?.provenance?.evidence).toBe("pi catalog");
  });

  test("a plan persisted before provenance existed still parses", () => {
    expect(modelInfoSchema.safeParse(makeModelInfo("anthropic", "claude-sonnet-4-5")).success).toBe(
      true,
    );
  });

  test("a record Models resolves today round-trips through the schema", () => {
    const model = resolve("anthropic/claude-haiku-4-5");
    expect(modelInfoSchema.parse(JSON.parse(JSON.stringify(model)))).toEqual(model);
  });
});
