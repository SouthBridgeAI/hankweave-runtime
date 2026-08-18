import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { validateModel } from "../../server/config-validation/model-validator.js";
import {
  isModelAccessDenialError,
  LlmProviderRegistry,
} from "../../server/llm/llm-provider-registry.js";
import { selectHarness, toPiTarget } from "../../server/provider-ids.js";
import { Logger } from "../../server/utils.js";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";
import { createMockLlmProviderRegistry } from "../utils/mock-llm-provider-registry.js";

describe("LlmProviderRegistry", () => {
  let registry: LlmProviderRegistry;
  let logs: Array<{ message: string; level: string }> = [];
  let originalEnv: Record<string, string | undefined>;

  const mockLogger = new Logger("/tmp/test.log");
  // Override the log method to capture messages
  mockLogger.log = (message: string, level = "info") => {
    logs.push({ message, level });
  };

  beforeEach(() => {
    logs = [];
    // Save original env using proper capture
    originalEnv = captureEnv();
    // Reset singleton before each test to ensure clean state
    LlmProviderRegistry.resetInstance();
  });

  afterEach(() => {
    // Restore env using proper restore
    restoreEnv(originalEnv);
    // Reset singleton after each test
    LlmProviderRegistry.resetInstance();
  });

  describe("initialization", () => {
    it("should load models from static data", () => {
      registry = new LlmProviderRegistry({ logger: mockLogger });

      // Check that models were loaded
      const sonnetInfoResult = registry.getModelInfo("claude-sonnet-4-5-20250929");
      expect(sonnetInfoResult.success).toBe(true);
      if (sonnetInfoResult.success) {
        expect(sonnetInfoResult.info.providerId).toBe("anthropic");
      }
    });

    it("should handle missing API keys gracefully", () => {
      // Clear all API keys (both standard and sentinel-prefixed)
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GROQ_API_KEY;
      delete process.env.HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY;
      delete process.env.HANKWEAVE_SENTINEL_OPENAI_API_KEY;
      delete process.env.HANKWEAVE_SENTINEL_GEMINI_API_KEY;
      delete process.env.HANKWEAVE_SENTINEL_GROQ_API_KEY;

      registry = new LlmProviderRegistry({ logger: mockLogger });

      // Should log about missing keys
      const missingKeyLogs = logs.filter((l) => l.message.includes("No API key"));
      expect(missingKeyLogs.length).toBeGreaterThan(0);

      // Should not crash when getting provider
      const providerResult = registry.getProviderForModel("claude-sonnet-4-5-20250929");
      expect(providerResult.success).toBe(false);
      if (providerResult.success === false) {
        expect(providerResult.reason).toBe("provider-unavailable");
      }
    });

    it("should initialize successfully with valid API keys", () => {
      // Set mock API keys
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
      process.env.OPENAI_API_KEY = "test-openai-key";

      registry = new LlmProviderRegistry({ logger: mockLogger });

      // Should log successful initialization
      const initLogs = logs.filter((l) => l.message.includes("Initialized"));
      expect(initLogs.length).toBeGreaterThan(0);
    });

    it("should load models data and create enhanced model info", () => {
      registry = new LlmProviderRegistry({ logger: mockLogger });

      // Check that models have enhanced properties
      const modelResult = registry.getModelInfo("claude-sonnet-4-5-20250929");
      expect(modelResult.success).toBe(true);
      if (modelResult.success) {
        expect(modelResult.info).toHaveProperty("modelId");
        expect(modelResult.info).toHaveProperty("cost");
        expect(modelResult.info.cost).toHaveProperty("input");
        expect(modelResult.info.cost).toHaveProperty("output");
        expect(modelResult.info).toHaveProperty("limit");
        expect(modelResult.info.limit).toHaveProperty("context");
        expect(modelResult.info.limit).toHaveProperty("output");
      }
    });

    it("should handle models data loading errors gracefully", () => {
      // This test is tricky because the models data is imported at module level
      // For now, we'll test that the system continues even if data loading fails
      registry = new LlmProviderRegistry({ logger: mockLogger });

      // Should not crash even if data loading encounters issues
      expect(registry).toBeDefined();
    });
  });

  describe("model operations", () => {
    beforeEach(() => {
      // Set some API keys for provider initialization
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.OPENAI_API_KEY = "test-key";
      registry = new LlmProviderRegistry({ logger: mockLogger });
    });

    it("should find models by name", () => {
      const modelResult = registry.getModelInfo("claude-sonnet-4-5-20250929");
      expect(modelResult.success).toBe(true);
      if (modelResult.success) {
        expect(modelResult.info.modelId).toBe("claude-sonnet-4-5-20250929");
      }
    });

    it("should find models by full ID", () => {
      const modelResult = registry.getModelInfo("anthropic/claude-sonnet-4-5-20250929");
      expect(modelResult.success).toBe(true);
      if (modelResult.success) {
        expect(modelResult.info.providerId).toBe("anthropic");
      }
    });

    it("should resolve the same model under short and provider-prefixed ids", () => {
      // Lifted from the retired llm-provider-load suite: models are keyed
      // under both the bare id and the provider-prefixed id, and both keys
      // must resolve to the same model.
      const byShortId = registry.getModelInfo("gpt-4o");
      const byFullId = registry.getModelInfo("openai/gpt-4o");
      expect(byShortId.success).toBe(true);
      expect(byFullId.success).toBe(true);
      if (byShortId.success && byFullId.success) {
        expect(byFullId.info.providerId).toBe("openai");
        expect(byShortId.info.modelId).toBe(byFullId.info.modelId);
      }
    });

    it("should return null for unknown models", () => {
      const modelResult = registry.getModelInfo("unknown-model");
      expect(modelResult.success).toBe(false);
    });

    it("should get models for specific provider", () => {
      const anthropicModels = registry.getModelsForProvider("anthropic");
      expect(anthropicModels.length).toBeGreaterThan(0);
      expect(anthropicModels.every((m) => m.startsWith("anthropic/"))).toBe(true);
    });

    it("should check model availability correctly", () => {
      // Model exists but provider might not be available
      const isAvailable = registry.isModelAvailable("claude-sonnet-4-5-20250929");
      // Should be boolean
      expect(typeof isAvailable).toBe("boolean");
    });

    it("should return empty array for unknown provider", () => {
      const models = registry.getModelsForProvider("unknown-provider");
      expect(models).toEqual([]);
    });
  });

  describe("cost calculation", () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.OPENAI_API_KEY = "test-key";
      registry = new LlmProviderRegistry({ logger: mockLogger });
    });

    it("should calculate costs correctly", () => {
      const cost = registry.calculateCost("claude-sonnet-4-5-20250929", {
        inputTokens: 1000, // 1K input tokens
        outputTokens: 500, // 500 output tokens
      });

      // Cost should be: (1000/1M * 3.00) + (500/1M * 15.00)
      // = 0.003 + 0.0075 = 0.0105
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it("should return null for unknown models", () => {
      const cost = registry.calculateCost("unknown-model", {
        inputTokens: 1000,
        outputTokens: 500,
      });
      expect(cost).toBeNull();
    });

    it("should handle zero token counts", () => {
      const cost = registry.calculateCost("claude-sonnet-4-5-20250929", {
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(cost).toBe(0);
    });

    it("should format costs readably", () => {
      // Small cost in cents
      expect(registry.formatCost(0.0001)).toBe("$0.0100¢");

      // Larger cost in dollars
      expect(registry.formatCost(0.1234)).toBe("$0.1234");

      // Zero cost
      expect(registry.formatCost(0)).toBe("$0.0000");
    });

    it("should keep dollar notation for costs at or above one dollar", () => {
      // Lifted from the retired llm-provider-load suite: >= $1 must stay in
      // four-decimal dollar notation — cents notation is only for < $0.01.
      expect(registry.formatCost(0)).toBe("$0.0000");
      expect(registry.formatCost(1.5)).toBe("$1.5000");
    });

    describe("provider-specific cache token semantics", () => {
      it("should use additive semantics for Anthropic (inputTokens + cacheReadTokens)", () => {
        // Anthropic: inputTokens is fresh only, cacheReadTokens is additive
        // claude-sonnet-4-5-20250929 pricing:
        //   input: $3.00/M, output: $15.00/M, cache_read: $0.30/M
        const cost = registry.calculateCost("claude-sonnet-4-5-20250929", {
          inputTokens: 1000, // 1K fresh input tokens
          outputTokens: 500, // 500 output tokens
          cacheReadTokens: 2000, // 2K cached tokens (additive)
        });

        // Expected: (1000/1M * 3.00) + (500/1M * 15.00) + (2000/1M * 0.30)
        // = 0.003 + 0.0075 + 0.0006 = 0.0111
        expect(cost).toBeCloseTo(0.0111, 6);
      });

      it("should use inclusive semantics for OpenAI (inputTokens includes cacheReadTokens)", () => {
        // OpenAI: inputTokens INCLUDES cached tokens, cacheReadTokens is a subset
        // gpt-4o-2024-08-06 pricing (has cache_read):
        //   input: $2.50/M, output: $10.00/M, cache_read: $1.25/M
        const cost = registry.calculateCost("gpt-4o-2024-08-06", {
          inputTokens: 3000, // 3K total input (includes 2K cached)
          outputTokens: 500,
          cacheReadTokens: 2000, // 2K cached tokens (subset of inputTokens)
        });

        // OpenAI fix: freshInputTokens = 3000 - 2000 = 1000
        // Expected: (1000/1M * 2.50) + (500/1M * 10.00) + (2000/1M * 1.25)
        // = 0.0025 + 0.005 + 0.0025 = 0.01
        expect(cost).toBeCloseTo(0.01, 6);
      });

      it("should NOT double-count cached tokens for OpenAI (bug fix verification)", () => {
        // This test verifies the bug fix: before the fix, OpenAI costs were inflated
        // because inputTokens (which includes cached) was being charged at full price,
        // AND cacheReadTokens was charged again at cache_read price.

        // gpt-4o-2024-08-06 pricing (has cache_read):
        //   input: $2.50/M, output: $10.00/M, cache_read: $1.25/M
        const cost = registry.calculateCost("gpt-4o-2024-08-06", {
          inputTokens: 89958860, // Total (includes cached) - from bug report
          outputTokens: 103588,
          cacheReadTokens: 88836864, // Cached tokens (subset)
        });

        // CORRECT calculation (after fix):
        // freshInputTokens = 89958860 - 88836864 = 1121996
        // inputCost = (1121996/1M * 2.50) = 2.804990
        // outputCost = (103588/1M * 10.00) = 1.03588
        // cacheReadCost = (88836864/1M * 1.25) = 111.04608
        // Total = 2.804990 + 1.03588 + 111.04608 = 114.88695
        const expectedCorrect = 114.88695;

        // WRONG calculation (before fix - double counting):
        // inputCost = (89958860/1M * 2.50) = 224.897150
        // outputCost = (103588/1M * 10.00) = 1.03588
        // cacheReadCost = (88836864/1M * 1.25) = 111.04608
        // Total = 224.897150 + 1.03588 + 111.04608 = 336.97911
        const wrongDoubleCount = 336.97911;

        expect(cost).toBeCloseTo(expectedCorrect, 2);
        expect(cost).not.toBeCloseTo(wrongDoubleCount, 2);
      });

      it("should handle OpenAI with no cache tokens (no change in behavior)", () => {
        // When there are no cache tokens, behavior should be the same
        // gpt-4o-2024-08-06 pricing: input: $2.50/M, output: $10.00/M
        const cost = registry.calculateCost("gpt-4o-2024-08-06", {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
        });

        // Expected: (1000/1M * 2.50) + (500/1M * 10.00) + 0
        // = 0.0025 + 0.005 = 0.0075
        expect(cost).toBeCloseTo(0.0075, 6);
      });

      it("should handle edge case where cacheReadTokens exceeds inputTokens for OpenAI", () => {
        // This shouldn't happen in practice, but the code should handle it gracefully
        // gpt-4o-2024-08-06 pricing: input: $2.50/M, output: $10.00/M, cache_read: $1.25/M
        const cost = registry.calculateCost("gpt-4o-2024-08-06", {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 2000, // More than inputTokens (shouldn't happen)
        });

        // freshInputTokens = max(0, 1000 - 2000) = 0
        // Expected: (0/1M * 2.50) + (500/1M * 10.00) + (2000/1M * 1.25)
        // = 0 + 0.005 + 0.0025 = 0.0075
        expect(cost).toBeCloseTo(0.0075, 6);
      });

      it("should handle Anthropic with cache tokens correctly", () => {
        // Verify Anthropic still works correctly with cache tokens
        const cost = registry.calculateCost("claude-sonnet-4-5-20250929", {
          inputTokens: 10000, // Fresh input only
          outputTokens: 2000,
          cacheReadTokens: 50000, // Additive cached tokens
          cacheCreationTokens: 1000,
        });

        // claude-sonnet-4-5-20250929 pricing:
        //   input: $3.00/M, output: $15.00/M, cache_read: $0.30/M, cache_write: $3.75/M
        // Expected: (10000/1M * 3.00) + (2000/1M * 15.00) + (50000/1M * 0.30) + (1000/1M * 3.75)
        // = 0.03 + 0.03 + 0.015 + 0.00375 = 0.07875
        expect(cost).toBeCloseTo(0.07875, 6);
      });
    });
  });

  describe("provider status and health", () => {
    it("should report providers as unavailable when API keys missing", () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY;
      delete process.env.HANKWEAVE_SENTINEL_OPENAI_API_KEY;
      registry = new LlmProviderRegistry({ logger: mockLogger });

      const statuses = registry.getProviderStatus();
      const anthropicStatus = statuses.get("anthropic");

      expect(anthropicStatus).toBeDefined();
      expect(anthropicStatus?.status).toBe("not-configured");
      if (anthropicStatus?.status === "not-configured") {
        expect(anthropicStatus.error).toContain("No API key found");
      }
    });

    it("should list only available models", () => {
      // Set only OpenAI key
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";

      registry = new LlmProviderRegistry({ logger: mockLogger });

      const available = registry.getAvailableModels();
      // Should only include OpenAI models (if any providers are actually available)
      // Note: this might be empty if providers aren't healthy
      expect(Array.isArray(available)).toBe(true);
    });

    it("should perform health checks", async () => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      registry = new LlmProviderRegistry({
        logger: mockLogger,
        healthCheckTimeout: 50,
      });

      const statuses = await registry.performHealthChecks();
      expect(statuses).toBeInstanceOf(Map);
      expect(statuses.size).toBeGreaterThan(0);

      // Check that statuses have correct structure
      const anthropicStatus = statuses.get("anthropic");
      if (anthropicStatus) {
        expect(anthropicStatus).toHaveProperty("id");
        expect(anthropicStatus).toHaveProperty("status");

        if (anthropicStatus.status === "available") {
          expect(anthropicStatus).toHaveProperty("healthy");
          expect(anthropicStatus).toHaveProperty("lastChecked");
        } else if (anthropicStatus.status === "failed") {
          expect(anthropicStatus).toHaveProperty("error");
          expect(anthropicStatus).toHaveProperty("lastChecked");
        }
      }
    });

    it("should handle health check timeouts", async () => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      registry = new LlmProviderRegistry({
        logger: mockLogger,
        healthCheckTimeout: 1, // Very short timeout to force timeout
      });

      const statuses = await registry.performHealthChecks();
      // Health checks should complete even with timeouts
      expect(statuses).toBeInstanceOf(Map);
    });

    it("should get provider statistics", () => {
      registry = new LlmProviderRegistry({ logger: mockLogger });

      const stats = registry.getStats();
      expect(stats).toHaveProperty("totalModels");
      expect(stats).toHaveProperty("totalProviders");
      expect(stats).toHaveProperty("availableProviders");
      expect(stats).toHaveProperty("healthyProviders");

      expect(typeof stats.totalModels).toBe("number");
      expect(stats.totalModels).toBeGreaterThan(0);
      expect(stats.totalProviders).toBe(6); // anthropic, openai, google, groq, deepseek, amazon-bedrock
    });
  });

  describe("error handling", () => {
    it("should handle provider initialization errors", () => {
      // Set an API key that might cause provider creation to fail
      process.env.ANTHROPIC_API_KEY = "invalid-key";

      registry = new LlmProviderRegistry({ logger: mockLogger });

      // Should not crash
      expect(registry).toBeDefined();

      // Should log provider initialization
      const providerLogs = logs.filter((l) => l.message.includes("anthropic"));
      expect(providerLogs.length).toBeGreaterThan(0);
    });

    it("should return error for providers of unavailable models", () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY;
      registry = new LlmProviderRegistry({ logger: mockLogger });

      const providerResult = registry.getProviderForModel("claude-sonnet-4-5-20250929");
      expect(providerResult.success).toBe(false);
      if (providerResult.success === false) {
        expect(providerResult.reason).toBe("provider-unavailable");
      }

      // Should log the error
      const errorLogs = logs.filter((l) => l.message.includes("not available"));
      expect(errorLogs.length).toBeGreaterThan(0);
    });

    it("should handle unhealthy providers", () => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      registry = new LlmProviderRegistry({ logger: mockLogger });

      // Getting provider status
      const statuses = registry.getProviderStatus();
      const anthropicStatus = statuses.get("anthropic");

      // Verify status structure
      if (anthropicStatus?.status === "available") {
        // Note: We can't directly modify the health status from outside
        // This is a limitation of the current implementation
        // as health status is managed internally
        expect(anthropicStatus).toHaveProperty("healthy");
      }
    });
  });

  describe("resolveModel", () => {
    beforeEach(() => {
      registry = new LlmProviderRegistry({ logger: mockLogger });
    });

    describe("exact matching with explicit provider", () => {
      it("should resolve exact match with provider ID", () => {
        const result = registry.resolveModel({
          providerId: "anthropic",
          model: "claude-sonnet-4-5-20250929",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5-20250929");
          expect(result.matchType).toBe("exact");
        }
      });

      it("should resolve exact match with full model ID", () => {
        const result = registry.resolveModel({
          providerId: "anthropic",
          model: "anthropic/claude-sonnet-4-5-20250929",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5-20250929");
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.matchType).toBe("exact");
        }
      });

      it("should fall through to fuzzy when no exact match with provider", () => {
        const result = registry.resolveModel({
          providerId: "anthropic",
          model: "claude-sonnet",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.modelInfo.modelId).toBe("claude-sonnet-5");
          expect(result.matchType).toBe("fuzzy");
        }
      });

      it("should respect provider constraint in fuzzy matching", () => {
        const result = registry.resolveModel({
          providerId: "google",
          model: "gemini-flash",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("google");
          expect(result.modelInfo.modelId).toBe("gemini-3.7-flash");
        }
      });
    });

    describe("exact matching with provider inference", () => {
      it("should resolve exact match without provider", () => {
        const result = registry.resolveModel({
          model: "claude-sonnet-4-5-20250929",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5-20250929");
          expect(result.matchType).toBe("exact-with-inferred-provider");
        }
      });

      it("should prefer anthropic for claude models", () => {
        const result = registry.resolveModel({
          model: "claude-sonnet-4-5-20250929",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5-20250929");
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.matchType).toBe("exact-with-inferred-provider");
        }
      });

      it("should prefer google for gemini models", () => {
        // Test that getPreferredProvider returns "google" for gemini models
        // Note: We use fuzzy matching to ensure we get a google model
        const result = registry.resolveModel({
          model: "gemini-flash",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Fuzzy match should prefer google provider for gemini and return most recent
          expect(result.modelInfo.modelId).toBe("gemini-3.7-flash");
          expect(result.modelInfo.providerId).toBe("google");
        }
      });

      it("should prefer openai for gpt models", () => {
        const result = registry.resolveModel({
          model: "gpt-4o-2024-05-13",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.modelId).toBe("gpt-4o-2024-05-13");
          expect(result.modelInfo.providerId).toBe("openai");
          expect(result.matchType).toBe("exact-with-inferred-provider");
        }
      });
    });

    describe("Claude Fable 5 resolution", () => {
      it("should resolve claude-fable-5 by exact model ID", () => {
        const result = registry.resolveModel({
          model: "claude-fable-5",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.modelInfo.modelId).toBe("claude-fable-5");
          expect(result.matchType).toBe("exact-with-inferred-provider");
        }
      });

      it("should resolve with full model ID anthropic/claude-fable-5", () => {
        const result = registry.resolveModel({
          model: "anthropic/claude-fable-5",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.modelInfo.modelId).toBe("claude-fable-5");
        }
      });

      it("should return model metadata via getModelInfo", () => {
        const result = registry.getModelInfo("anthropic/claude-fable-5");

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.info.name).toBe("Claude Fable 5");
          expect(result.info.reasoning).toBe(true);
          expect(result.info.limit.context).toBe(1000000);
          expect(result.info.limit.output).toBe(128000);
        }
      });
    });

    describe("fuzzy matching", () => {
      it("should fuzzy match partial model names", () => {
        const result = registry.resolveModel({
          model: "claude-sonnet",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Should match the most recent claude sonnet from anthropic
          expect(result.modelInfo.modelId).toBe("claude-sonnet-5");
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.matchType).toBe("fuzzy");
        }
      });

      it("should fuzzy match with typos", () => {
        const result = registry.resolveModel({
          model: "gemni-flash", // Missing 'i'
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Should match a gemini flash model despite typo, preferring google provider
          expect(result.modelInfo.modelId).toBe("gemini-3.7-flash");
          expect(result.modelInfo.providerId).toBe("google");
          expect(result.matchType).toBe("fuzzy");
        }
      });

      it("should match against model display names", () => {
        const result = registry.resolveModel({
          model: "Claude Sonnet",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Should match based on display name
          expect(result.modelInfo.modelId).toBe("claude-sonnet-5");
          expect(result.matchType).toBe("fuzzy");
        }
      });

      it("should return most recent model when multiple matches", () => {
        const result = registry.resolveModel({
          model: "claude-opus",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Should get the most recent opus variant
          expect(result.modelInfo.modelId).toBe("claude-opus-5");
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.matchType).toBe("fuzzy");
          expect(result.modelInfo.last_updated).toBeDefined();
        }
      });

      it("should prefer provider in fuzzy matching", () => {
        const result = registry.resolveModel({
          model: "claude-opus",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Should prefer anthropic for claude models
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.modelInfo.modelId).toBe("claude-opus-5");
        }
      });

      it("should respect explicit provider in fuzzy matching", () => {
        const result = registry.resolveModel({
          providerId: "anthropic",
          model: "claude-haiku",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.modelInfo.modelId).toBe("claude-haiku-4-5");
          expect(result.matchType).toBe("fuzzy");
        }
      });

      it("should return failure when similarity too low", () => {
        const result = registry.resolveModel({
          model: "totally-nonexistent-xyz123",
        });

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-not-found");
        }
      });
    });

    describe("GPT 5.2 models (manually injected)", () => {
      beforeEach(() => {
        registry = new LlmProviderRegistry({ logger: mockLogger });
      });

      describe("exact matching", () => {
        it("should resolve gpt-5.2-high by exact model ID", () => {
          const result = registry.resolveModel({
            model: "gpt-5.2-high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-high");
            expect(result.matchType).toBe("exact-with-inferred-provider");
          }
        });

        it("should resolve gpt-5.2-xhigh by exact model ID", () => {
          const result = registry.resolveModel({
            model: "gpt-5.2-xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-xhigh");
            expect(result.matchType).toBe("exact-with-inferred-provider");
          }
        });

        it("should resolve gpt-5.2-high with explicit provider", () => {
          const result = registry.resolveModel({
            providerId: "openai",
            model: "gpt-5.2-high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-high");
            expect(result.matchType).toBe("exact");
          }
        });

        it("should resolve gpt-5.2-xhigh with explicit provider", () => {
          const result = registry.resolveModel({
            providerId: "openai",
            model: "gpt-5.2-xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-xhigh");
            expect(result.matchType).toBe("exact");
          }
        });

        it("should resolve with full model ID openai/gpt-5.2-high", () => {
          const result = registry.resolveModel({
            model: "openai/gpt-5.2-high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-high");
          }
        });

        it("should resolve with full model ID openai/gpt-5.2-xhigh", () => {
          const result = registry.resolveModel({
            model: "openai/gpt-5.2-xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-xhigh");
          }
        });
      });

      describe("fuzzy matching", () => {
        it("should fuzzy match 'gpt-52 codex' to base codex model", () => {
          const result = registry.resolveModel({
            model: "gpt-52 codex",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            // Should match gpt-5.3-codex (most recent: 2026-02-05) via fuzzy
            expect(result.modelInfo.modelId).toBe("gpt-5.3-codex");
            expect(result.matchType).toBe("fuzzy");
          }
        });
      });

      describe("case insensitive matching", () => {
        it("should resolve GPT-5.2-HIGH (uppercase)", () => {
          const result = registry.resolveModel({
            model: "GPT-5.2-HIGH",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.modelId).toBe("gpt-5.2-high");
          }
        });

        it("should resolve GPT-5.2-XHIGH (uppercase)", () => {
          const result = registry.resolveModel({
            model: "GPT-5.2-XHIGH",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.modelId).toBe("gpt-5.2-xhigh");
          }
        });
      });
    });

    describe("GPT 5.3 models (manually injected)", () => {
      beforeEach(() => {
        registry = new LlmProviderRegistry({ logger: mockLogger });
      });

      describe("exact matching", () => {
        it("should resolve gpt-5.3-codex-high by exact model ID", () => {
          const result = registry.resolveModel({
            model: "gpt-5.3-codex-high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.3-codex-high");
            expect(result.matchType).toBe("exact-with-inferred-provider");
          }
        });

        it("should resolve gpt-5.3-codex-xhigh by exact model ID", () => {
          const result = registry.resolveModel({
            model: "gpt-5.3-codex-xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.3-codex-xhigh");
            expect(result.matchType).toBe("exact-with-inferred-provider");
          }
        });

        it("should resolve gpt-5.3-codex-xhigh with explicit provider", () => {
          const result = registry.resolveModel({
            providerId: "openai",
            model: "gpt-5.3-codex-xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.3-codex-xhigh");
            expect(result.matchType).toBe("exact");
          }
        });

        it("should resolve with full model ID openai/gpt-5.3-codex-high", () => {
          const result = registry.resolveModel({
            model: "openai/gpt-5.3-codex-high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.3-codex-high");
          }
        });
      });

      describe("fuzzy matching", () => {
        it("should fuzzy match 'gpt-5.3 codex high' to codex-high variant", () => {
          const result = registry.resolveModel({
            model: "gpt-5.3 codex high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.3-codex-high");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should fuzzy match 'gpt-5.3 codex xhigh' to codex-xhigh variant", () => {
          const result = registry.resolveModel({
            model: "gpt-5.3 codex xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.3-codex-xhigh");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should fuzzy match 'gpt 5.3 codex high' with spaces", () => {
          const result = registry.resolveModel({
            model: "gpt 5.3 codex high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.3-codex-high");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should match 'GPT-5.3-Codex-XHigh' (mixed case)", () => {
          const result = registry.resolveModel({
            model: "GPT-5.3-Codex-XHigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.3-codex-xhigh");
          }
        });
      });
    });

    describe("GPT-5.6 models", () => {
      beforeEach(() => {
        registry = new LlmProviderRegistry({ logger: mockLogger });
      });

      describe("exact matching", () => {
        it("should resolve the bare gpt-5.6 shortcut to the sol variant", () => {
          const result = registry.resolveModel({
            model: "gpt-5.6",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.6-sol");
            expect(result.matchType).toBe("exact-with-inferred-provider");
          }
        });

        it("should resolve each gpt-5.6 variant by exact model ID", () => {
          for (const modelId of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
            const result = registry.resolveModel({ model: modelId });

            expect(result.success).toBe(true);
            if (result.success) {
              expect(result.modelInfo.providerId).toBe("openai");
              expect(result.modelInfo.modelId).toBe(modelId);
              expect(result.matchType).toBe("exact-with-inferred-provider");
            }
          }
        });

        it("should resolve gpt-5.6-luna with explicit provider", () => {
          const result = registry.resolveModel({
            providerId: "openai",
            model: "gpt-5.6-luna",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.6-luna");
            expect(result.matchType).toBe("exact");
          }
        });

        it("should resolve full model ID openai/gpt-5.6 to the sol variant", () => {
          // Codex has no "gpt-5.6" slug (only -sol/-luna/-terra), so the
          // provider-qualified spelling must route to sol like the bare one.
          const result = registry.resolveModel({
            model: "openai/gpt-5.6",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.6-sol");
          }
        });
      });

      describe("reasoning effort variants", () => {
        // The registry auto-generates -high/-xhigh variants from every
        // reasoning-capable OpenAI record — including the abstract gpt-5.6.
        // The codex shim strips the effort suffix before calling codex, so an
        // abstract variant like "gpt-5.6-high" would send the nonexistent
        // "gpt-5.6" slug at runtime. The shortcut must therefore route
        // effort-suffixed spellings to the sol variant too.
        it.each(["high", "xhigh"] as const)(
          "should resolve gpt-5.6-%s to gpt-5.6-sol-%s",
          (effort) => {
            const result = registry.resolveModel({ model: `gpt-5.6-${effort}` });

            expect(result.success).toBe(true);
            if (result.success) {
              expect(result.modelInfo.providerId).toBe("openai");
              expect(result.modelInfo.modelId).toBe(`gpt-5.6-sol-${effort}`);
            }
          },
        );

        it.each(["high", "xhigh"] as const)(
          "should resolve openai/gpt-5.6-%s to gpt-5.6-sol-%s",
          (effort) => {
            const result = registry.resolveModel({ model: `openai/gpt-5.6-${effort}` });

            expect(result.success).toBe(true);
            if (result.success) {
              expect(result.modelInfo.providerId).toBe("openai");
              expect(result.modelInfo.modelId).toBe(`gpt-5.6-sol-${effort}`);
            }
          },
        );

        it("should resolve gpt-5.6-xhigh with explicit provider param", () => {
          const result = registry.resolveModel({
            providerId: "openai",
            model: "gpt-5.6-xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.modelId).toBe("gpt-5.6-sol-xhigh");
            expect(result.matchType).toBe("exact");
          }
        });

        it("should leave effort variants of explicit gpt-5.6 variants untouched", () => {
          for (const modelId of ["gpt-5.6-sol-high", "gpt-5.6-luna-high", "gpt-5.6-terra-xhigh"]) {
            const result = registry.resolveModel({ model: modelId });

            expect(result.success).toBe(true);
            if (result.success) {
              expect(result.modelInfo.providerId).toBe("openai");
              expect(result.modelInfo.modelId).toBe(modelId);
            }
          }
        });

        it("should price xhigh variants at 2x the sol base cost", () => {
          const base = registry.resolveModel({ model: "gpt-5.6-sol" });
          const xhigh = registry.resolveModel({ model: "gpt-5.6-xhigh" });

          expect(base.success).toBe(true);
          expect(xhigh.success).toBe(true);
          if (base.success && xhigh.success) {
            expect(xhigh.modelInfo.cost?.input).toBe((base.modelInfo.cost?.input ?? 0) * 2);
            expect(xhigh.modelInfo.cost?.output).toBe((base.modelInfo.cost?.output ?? 0) * 2);
          }
        });
      });

      describe("fuzzy matching", () => {
        it("should fuzzy match 'gpt 5.6 luna' with spaces", () => {
          const result = registry.resolveModel({
            model: "gpt 5.6 luna",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.6-luna");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should match 'GPT-5.6-Terra' (mixed case)", () => {
          const result = registry.resolveModel({
            model: "GPT-5.6-Terra",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.6-terra");
          }
        });
      });

      describe("model metadata", () => {
        it("should return model metadata via getModelInfo", () => {
          const result = registry.getModelInfo("openai/gpt-5.6");

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.info.name).toBe("GPT-5.6");
            expect(result.info.reasoning).toBe(true);
            expect(result.info.tool_call).toBe(true);
            expect(result.info.limit.context).toBe(1050000);
            expect(result.info.limit.output).toBe(128000);
          }
        });

        it("should calculate costs for gpt-5.6-luna", () => {
          const cost = registry.calculateCost("gpt-5.6-luna", {
            inputTokens: 1000,
            outputTokens: 500,
          });

          // gpt-5.6-luna pricing: input $0.20/M, output $1.20/M
          // Expected: (1000/1M * 0.20) + (500/1M * 1.20) = 0.0002 + 0.0006 = 0.0008
          expect(cost).toBeCloseTo(0.0008, 6);
        });
      });
    });

    describe("blocklist handling", () => {
      beforeEach(() => {
        registry = new LlmProviderRegistry({
          logger: mockLogger,
          blockList: {
            providers: ["groq"],
            models: ["claude-sonnet-4-5-20250929"],
          },
        });
      });

      it("should ignore blocklist by default", () => {
        const result = registry.resolveModel({
          model: "claude-sonnet-4-5-20250929",
        });

        // Should succeed because ignoreBlockList defaults to true
        expect(result.success).toBe(true);
      });

      it("should respect blocklist when ignoreBlockList is false", () => {
        const result = registry.resolveModel({
          model: "claude-sonnet-4-5-20250929",
          ignoreBlockList: false,
        });

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should block providers when ignoreBlockList is false", () => {
        const result = registry.resolveModel({
          providerId: "groq",
          model: "llama-3-8b",
          ignoreBlockList: false,
        });

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should filter blocked models from fuzzy results", () => {
        const result = registry.resolveModel({
          model: "claude-3.5-sonnet",
          ignoreBlockList: false,
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Should match a different sonnet variant (not the blocked one)
          expect(result.modelInfo.modelId).not.toBe("claude-sonnet-4-5-20250929");
        }
      });
    });

    describe("blocklist handling for getModelInfo", () => {
      beforeEach(() => {
        registry = new LlmProviderRegistry({
          logger: mockLogger,
          blockList: {
            providers: ["groq"],
            models: ["claude-sonnet-4-5-20250929", "gpt-4o-2024-05-13"],
          },
        });
      });

      it("should block models in blocklist", () => {
        const result = registry.getModelInfo("claude-sonnet-4-5-20250929");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should block models in blocklist (case-insensitive)", () => {
        const result = registry.getModelInfo("CLAUDE-SONNET-4-5-20250929");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should block models with full model ID", () => {
        const result = registry.getModelInfo("anthropic/claude-sonnet-4-5-20250929");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should allow non-blocked models", () => {
        const result = registry.getModelInfo("claude-sonnet-4-5");

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.info.modelId).toBe("claude-sonnet-4-5");
        }
      });

      it("should return model-not-found for unknown models", () => {
        const result = registry.getModelInfo("unknown-model");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-not-found");
        }
      });

      it("should block all models from a blocked provider", () => {
        // Use google: gemini models always resolve to google for bare model IDs
        // (groq's models are also served by resellers, which can win the bare-ID lookup)
        registry = new LlmProviderRegistry({
          logger: mockLogger,
          blockList: {
            providers: ["google"],
          },
        });

        const result = registry.getModelInfo("gemini-2.5-pro");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should block provider models even with full model ID", () => {
        const result = registry.getModelInfo("groq/llama-3.1-8b-instant");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should handle case-insensitive provider blocking", () => {
        // Create registry with uppercase provider in blocklist
        registry = new LlmProviderRegistry({
          logger: mockLogger,
          blockList: {
            providers: ["ANTHROPIC"],
          },
        });

        // Use a model that's unique to anthropic
        const result = registry.getModelInfo("claude-sonnet-4-5-20250929");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });
    });

    describe("blocklist handling for getProviderForModel", () => {
      beforeEach(() => {
        registry = new LlmProviderRegistry({
          logger: mockLogger,
          blockList: {
            providers: ["groq"],
            models: ["claude-sonnet-4-5-20250929", "gpt-4o-2024-05-13"],
          },
        });
      });

      it("should block models in blocklist", () => {
        const result = registry.getProviderForModel("claude-sonnet-4-5-20250929");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }

        // Should log the error
        const errorLogs = logs.filter((l) => l.message.includes("Model blocked"));
        expect(errorLogs.length).toBeGreaterThan(0);
      });

      it("should block models in blocklist (case-insensitive)", () => {
        const result = registry.getProviderForModel("CLAUDE-SONNET-4-5-20250929");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should block models with full model ID", () => {
        const result = registry.getProviderForModel("anthropic/claude-sonnet-4-5-20250929");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should block OpenAI models in blocklist", () => {
        const result = registry.getProviderForModel("gpt-4o-2024-05-13");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should allow non-blocked models", () => {
        const result = registry.getModelInfo("claude-sonnet-4-5");

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.info.modelId).toBe("claude-sonnet-4-5");
        }
      });

      it("should return model-not-found for unknown models", () => {
        const result = registry.getProviderForModel("unknown-model");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-not-found");
        }
      });

      it("should prioritize model-blocked over provider-unavailable", () => {
        registry = new LlmProviderRegistry({
          logger: mockLogger,
          blockList: {
            models: ["claude-sonnet-4-5-20250929"],
          },
        });

        const result = registry.getProviderForModel("claude-sonnet-4-5-20250929");

        // Should return model-blocked before checking provider availability
        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should block all models from a blocked provider", () => {
        // Use google: gemini models always resolve to google for bare model IDs
        // (groq's models are also served by resellers, which can win the bare-ID lookup)
        registry = new LlmProviderRegistry({
          logger: mockLogger,
          blockList: {
            providers: ["google"],
          },
        });

        const result = registry.getProviderForModel("gemini-2.5-pro");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should block provider models even with full model ID", () => {
        const result = registry.getProviderForModel("groq/llama-3.1-8b-instant");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should handle case-insensitive provider blocking", () => {
        // Create registry with uppercase provider in blocklist
        registry = new LlmProviderRegistry({
          logger: mockLogger,
          blockList: {
            providers: ["OPENAI"],
          },
        });

        // Use a model that's unique to openai
        const result = registry.getProviderForModel("gpt-4o-2024-05-13");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should check provider blocklist before looking up provider instance", () => {
        registry = new LlmProviderRegistry({
          logger: mockLogger,
          blockList: {
            providers: ["anthropic"],
          },
        });

        // Use a model that's unique to anthropic
        const blockedResult = registry.getProviderForModel("claude-sonnet-4-5-20250929");
        expect(blockedResult.success).toBe(false);
        if (blockedResult.success === false) {
          expect(blockedResult.reason).toBe("model-blocked");
        }
      });
    });

    describe("edge cases", () => {
      it("should handle empty model name gracefully", () => {
        const result = registry.resolveModel({
          model: "",
        });

        expect(result.success).toBe(false);
      });

      it("should handle special characters in model name", () => {
        const result = registry.resolveModel({
          model: "!@#$%^&*()",
        });
        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-not-found");
        }
      });

      it("should handle very long model names", () => {
        const result = registry.resolveModel({
          model: "a".repeat(1000),
        });

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-not-found");
        }
      });

      it("should handle invalid provider ID", () => {
        const result = registry.resolveModel({
          providerId: "invalid-provider-xyz",
          model: "claude-sonnet-4-5-20250929",
        });

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-not-found");
        }
      });

      it("should be case insensitive in fuzzy matching", () => {
        const result = registry.resolveModel({
          model: "CLAUDE-SONNET",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.modelId).toBe("claude-sonnet-5");
        }
      });
    });

    describe("case insensitive exact matching", () => {
      it("should resolve exact match with uppercase model ID", () => {
        const result = registry.resolveModel({
          model: "CLAUDE-SONNET-4-5-20250929",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5-20250929");
          expect(result.matchType).toBe("exact-with-inferred-provider");
        }
      });

      it("should resolve exact match with uppercase full provider/model ID", () => {
        const result = registry.resolveModel({
          providerId: "anthropic",
          model: "ANTHROPIC/CLAUDE-SONNET-4-5-20250929",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5-20250929");
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.matchType).toBe("exact");
        }
      });

      it("should preserve original casing in returned ModelInfo", () => {
        const result = registry.resolveModel({
          model: "CLAUDE-SONNET-4-5-20250929",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // The returned modelInfo should have the original casing from the data file
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5-20250929");
          expect(result.modelInfo.providerId).toBe("anthropic");
        }
      });

      it("should work with getModelInfo for uppercase IDs", () => {
        const result = registry.getModelInfo("CLAUDE-SONNET-4-5-20250929");

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.info.modelId).toBe("claude-sonnet-4-5-20250929");
        }
      });

      it("should work with getModelInfo for full uppercase IDs", () => {
        const result = registry.getModelInfo("ANTHROPIC/CLAUDE-SONNET-4-5-20250929");

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.info.modelId).toBe("claude-sonnet-4-5-20250929");
        }
      });
    });

    describe("case insensitive provider ID matching", () => {
      it("should resolve with uppercase provider ID", () => {
        const result = registry.resolveModel({
          providerId: "ANTHROPIC",
          model: "claude-sonnet-4-5-20250929",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5-20250929");
          expect(result.matchType).toBe("exact");
        }
      });

      it("should work with getModelsForProvider with uppercase ID", () => {
        const models = registry.getModelsForProvider("ANTHROPIC");
        expect(models.length).toBeGreaterThan(0);
        expect(models.every((m) => m.startsWith("anthropic/"))).toBe(true);
      });

      it("should work with getModelsForProvider with mixed case ID", () => {
        const models = registry.getModelsForProvider("AnThRoPiC");
        expect(models.length).toBeGreaterThan(0);
        expect(models.every((m) => m.startsWith("anthropic/"))).toBe(true);
      });

      it("should handle fuzzy matching with uppercase provider constraint", () => {
        const result = registry.resolveModel({
          providerId: "ANTHROPIC",
          model: "claude-sonnet",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("anthropic");
        }
      });
    });

    describe("match type consistency", () => {
      it("should return correct match type for exact matches", () => {
        const result = registry.resolveModel({
          providerId: "anthropic",
          model: "claude-sonnet-4-5-20250929",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.matchType).toBe("exact");
        }
      });

      it("should return correct match type for inferred provider", () => {
        const result = registry.resolveModel({
          model: "claude-sonnet-4-5-20250929",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.matchType).toBe("exact-with-inferred-provider");
        }
      });

      it("should return correct match type for fuzzy matches", () => {
        const result = registry.resolveModel({
          model: "claude-sonnet",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.matchType).toBe("fuzzy");
        }
      });
    });
  });

  describe("singleton pattern", () => {
    it("should return the same instance when getInstance is called multiple times", () => {
      const instance1 = LlmProviderRegistry.getInstance({ logger: mockLogger });
      const instance2 = LlmProviderRegistry.getInstance({ logger: mockLogger });

      expect(instance1).toBe(instance2);
    });

    it("should create new instance after resetInstance is called", () => {
      const instance1 = LlmProviderRegistry.getInstance({ logger: mockLogger });
      LlmProviderRegistry.resetInstance();
      const instance2 = LlmProviderRegistry.getInstance({ logger: mockLogger });

      expect(instance1).not.toBe(instance2);
    });
  });

  describe("model shortcuts", () => {
    beforeEach(() => {
      registry = LlmProviderRegistry.getInstance({ logger: mockLogger });
    });

    it("should expand shortcuts before resolution", () => {
      // Test that shortcuts are expanded to their full patterns
      const shortcuts = [
        {
          input: "opus",
          expectedProvider: "anthropic",
          expectedModelId: "claude-opus-5",
        },
        {
          input: "sonnet",
          expectedProvider: "anthropic",
          expectedModelId: "claude-sonnet-5",
        },
        {
          input: "haiku",
          expectedProvider: "anthropic",
          expectedModelId: "claude-haiku-4-5",
        },
      ];

      for (const shortcut of shortcuts) {
        const result = registry.resolveModel({ model: shortcut.input });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe(shortcut.expectedProvider);
          expect(result.modelInfo.modelId).toBe(shortcut.expectedModelId);
        }
      }
    });
  });

  describe("model resolution with short names", () => {
    beforeEach(() => {
      registry = LlmProviderRegistry.getInstance({ logger: mockLogger });
    });

    it("should resolve 'opus' to claude-opus-5", () => {
      const result = registry.resolveModel({
        model: "opus", // Short name that gets expanded to "claude-opus"
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-opus-5");
        // Should be fuzzy match since shortcuts expand to patterns, not exact IDs
        expect(result.matchType).toBe("fuzzy");
      }
    });

    it("should resolve 'sonnet' to claude-sonnet-5", () => {
      const result = registry.resolveModel({
        model: "sonnet", // Short name that gets expanded to "claude-sonnet"
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-sonnet-5");
        // Should be fuzzy match
        expect(result.matchType).toBe("fuzzy");
      }
    });

    it("should resolve 'opus' with anthropic provider to claude-opus-5", () => {
      const result = registry.resolveModel({
        providerId: "anthropic",
        model: "opus", // Shortcut + explicit provider
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-opus-5");
        expect(result.matchType).toBe("fuzzy");
      }
    });

    it("should handle case-insensitive OPUS shortcut", () => {
      const result = registry.resolveModel({
        model: "OPUS", // Case-insensitive shortcut
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-opus-5");
      }
    });

    it("should resolve opus to most recent model (claude-opus-5)", () => {
      const result = registry.resolveModel({
        model: "opus",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Should resolve to claude-opus-5 (most recent)
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-opus-5");
        expect(result.modelInfo.last_updated).toBeDefined();
        // Verify it's the 2026 version
        expect(result.modelInfo.last_updated).toContain("2026");
      }
    });

    it("should resolve 'haiku' to claude-haiku-4-5", () => {
      const result = registry.resolveModel({
        model: "haiku", // Shortcut
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-haiku-4-5");
      }
    });
  });

  describe("GLM routing and zhipuai preferred provider", () => {
    beforeEach(() => {
      registry = LlmProviderRegistry.getInstance({ logger: mockLogger });
    });

    // Zhipu AI ("zhipuai") is the canonical first-party provider for GLM models
    // ("zai"/"Z.AI" is its international brand) — a bare "glm-*" id must resolve
    // to it rather than to whichever reseller loads last.
    describe("zhipuai is the preferred provider for GLM", () => {
      it("resolves bare glm-5.2 to the canonical zhipuai provider, not a reseller", () => {
        const result = registry.resolveModel({ model: "glm-5.2" });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("zhipuai");
          expect(result.modelInfo.modelId).toBe("glm-5.2");
        }
      });

      it("resolves bare glm-5.1 to zhipuai", () => {
        const result = registry.resolveModel({ model: "glm-5.1" });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("zhipuai");
        }
      });
    });

    // GLM ids run on the pi harness through its native Z.AI provider — the
    // dispatch-time pi route (toPiTarget) is "zai/<id>". The GLM id is
    // lowercased because the pi/Z.AI catalog lookup is case-sensitive.
    describe("GLM routing through the pi shim's zai provider", () => {
      /** The pi route dispatch would derive for a validation result. */
      const piRouteOf = (result: ReturnType<typeof validateModel>) =>
        result.modelInfo
          ? toPiTarget(result.modelInfo.providerId, result.modelInfo.modelId)
          : undefined;

      it("routes bare glm-5.2 to the zai pi target", () => {
        const result = validateModel("glm-5.2", registry);
        expect(result.valid).toBe(true);
        expect(piRouteOf(result)).toBe("zai/glm-5.2");
        if (result.modelInfo) expect(selectHarness(result.modelInfo)).toBe("pi");
        // The bare id resolves through the registry's preferred-provider
        // inference (zhipuai) before dispatch aliases it onto zai.
        expect(result.matchType).toBe("exact-with-inferred-provider");
      });

      it("routes bare glm-5.1 to zai", () => {
        const result = validateModel("glm-5.1", registry);
        expect(result.valid).toBe(true);
        expect(piRouteOf(result)).toBe("zai/glm-5.1");
      });

      it("lowercases GLM-5.2 (catalog lookup is case-sensitive)", () => {
        const result = validateModel("GLM-5.2", registry);
        expect(result.valid).toBe(true);
        expect(piRouteOf(result)).toBe("zai/glm-5.2");
      });

      it("routes the canonical zhipuai/glm-5.2 spelling to zai (pi has no zhipuai provider)", () => {
        const result = validateModel("zhipuai/glm-5.2", registry);
        expect(result.valid).toBe(true);
        expect(piRouteOf(result)).toBe("zai/glm-5.2");
      });

      it("routes the zai/glm-5.2 (models.dev spelling) to zai", () => {
        const result = validateModel("zai/glm-5.2", registry);
        expect(result.valid).toBe(true);
        expect(piRouteOf(result)).toBe("zai/glm-5.2");
      });

      it("normalizes the z-ai/glm-5.2 (dashed spelling) to zai", () => {
        const result = validateModel("z-ai/glm-5.2", registry);
        expect(result.valid).toBe(true);
        expect(piRouteOf(result)).toBe("zai/glm-5.2");
      });

      it("lowercases Z-AI/GLM-5.2", () => {
        const result = validateModel("Z-AI/GLM-5.2", registry);
        expect(result.valid).toBe(true);
        expect(piRouteOf(result)).toBe("zai/glm-5.2");
      });

      it("keeps an explicit pi/zai/glm-5.2 passthrough on the zai route", () => {
        const result = validateModel("pi/zai/glm-5.2", registry);
        expect(result.valid).toBe(true);
        expect(result.modelInfo?.harnessOverride).toBe("pi");
        expect(piRouteOf(result)).toBe("zai/glm-5.2");
      });

      it("rewrites opencode/glm-5.2 to the canonical zai target (opencode shim removed)", () => {
        const result = validateModel("opencode/glm-5.2", registry);
        expect(result.valid).toBe(true);
        expect(result.modelInfo?.harnessOverride).toBe("pi");
        expect(piRouteOf(result)).toBe("zai/glm-5.2");
      });

      it("does not rewrite non-glm models (haiku)", () => {
        const result = validateModel("haiku", registry);
        expect(result.valid).toBe(true);
        expect(result.modelInfo?.providerId).toBe("anthropic");
      });

      it("does not rewrite a 'glmndalf-9000' word", () => {
        const result = validateModel("glmndalf-9000", registry);
        // The bare pattern requires glm to be followed by a digit/./-/slash/end,
        // so a word like "glmndalf" must not resolve onto the zai route.
        if (result.valid && result.modelInfo) {
          expect(result.modelInfo.providerId).not.toBe("zhipuai");
          expect(result.modelInfo.providerId).not.toBe("zai");
        } else {
          expect(result.valid).toBe(false);
        }
      });
    });
  });
});

describe("MockLlmProviderRegistry", () => {
  let mockRegistry: ReturnType<typeof createMockLlmProviderRegistry>;

  beforeEach(() => {
    mockRegistry = createMockLlmProviderRegistry();
  });

  it("should initialize with default models", () => {
    const models = mockRegistry.getAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain("anthropic/claude-3-5-sonnet-20241022");
  });

  it("should allow setting provider availability", () => {
    mockRegistry.setProviderAvailable("anthropic", false);

    const result = mockRegistry.getProviderForModel("anthropic/claude-3-5-sonnet-20241022");
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.reason).toContain("not configured");
    }
  });

  it("should allow setting provider health", () => {
    mockRegistry.setProviderHealth("anthropic", false);

    const result = mockRegistry.getProviderForModel("anthropic/claude-3-5-sonnet-20241022");
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.reason).toContain("unhealthy");
    }
  });

  it("should calculate mock costs correctly", () => {
    const cost = mockRegistry.calculateCost("claude-3-5-sonnet-20241022", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBeCloseTo(0.0105, 6); // Same calculation as real registry
  });

  it("should provide mock statistics", () => {
    const stats = mockRegistry.getStats();
    expect(stats.totalModels).toBeGreaterThan(0);
    expect(stats.totalProviders).toBe(4);
  });

  it("should allow adding custom models", () => {
    mockRegistry.addMockModel({
      providerId: "test",
      modelId: "test-model",
      name: "Test Model",
      fullModelId: "test/test-model",
      costPerMillionInput: 1.0,
      costPerMillionOutput: 2.0,
      maxContext: 100000,
      maxOutput: 4096,
      deprecated: false,
    });

    const modelResult = mockRegistry.getModelInfo("test-model");
    expect(modelResult.success).toBe(true);
    if (modelResult.success) {
      expect(modelResult.info.providerId).toBe("test");
    }
  });

  it("should allow clearing and resetting", () => {
    mockRegistry.clearAllModels();
    expect(mockRegistry.getAvailableModels()).toEqual([]);

    mockRegistry.reset();
    expect(mockRegistry.getAvailableModels().length).toBeGreaterThan(0);
  });

  it("should perform mock health checks", async () => {
    const statuses = await mockRegistry.performHealthChecks();
    expect(statuses).toBeInstanceOf(Map);
    expect(statuses.size).toBe(4);
  });
});

/**
 * amazon-bedrock is the one provider authenticated by a credential chain
 * instead of a single API key: availability must follow the chain (bearer
 * token, key pair, profile/credentials files) and the not-configured error
 * must say the chain was consulted — not "missing API key".
 */
describe("LlmProviderRegistry — amazon-bedrock availability", () => {
  const AWS_ENV_KEYS = [
    "AWS_BEARER_TOKEN_BEDROCK",
    "HANKWEAVE_SENTINEL_AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
  ];
  let originalEnv: Record<string, string | undefined>;
  let awsDir: string;
  const logger = new Logger("/tmp/test.log");
  logger.log = () => {};

  beforeEach(() => {
    originalEnv = captureEnv();
    for (const key of AWS_ENV_KEYS) delete process.env[key];
    // Point the file-backed sources at an empty temp dir so the developer's
    // real ~/.aws never decides these assertions.
    awsDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "bedrock-registry-test-"),
    );
    process.env.AWS_SHARED_CREDENTIALS_FILE = require("node:path").join(awsDir, "credentials");
    process.env.AWS_CONFIG_FILE = require("node:path").join(awsDir, "config");
    LlmProviderRegistry.resetInstance();
  });

  afterEach(() => {
    restoreEnv(originalEnv);
    require("node:fs").rmSync(awsDir, { recursive: true, force: true });
    LlmProviderRegistry.resetInstance();
  });

  const bedrockStatus = (registry: LlmProviderRegistry) =>
    registry.getProviderStatus().get("amazon-bedrock");

  it("is not-configured with no credential source, and names the accepted sources", () => {
    const registry = new LlmProviderRegistry({ logger });
    const status = bedrockStatus(registry);
    expect(status?.status).toBe("not-configured");
    if (status?.status === "not-configured") {
      expect(status.error).toContain("AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY");
      expect(status.error).toContain("not sentinels");
    }
  });

  it("is available with AWS_BEARER_TOKEN_BEDROCK", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer-token";
    const registry = new LlmProviderRegistry({ logger });
    expect(bedrockStatus(registry)?.status).toBe("available");
  });

  it("is available with an explicit env key pair", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
    process.env.AWS_SECRET_ACCESS_KEY = "testsecret";
    const registry = new LlmProviderRegistry({ logger });
    expect(bedrockStatus(registry)?.status).toBe("available");
  });

  it("is NOT available via a credentials-file profile — codon-only source (dependency-trim asymmetry)", () => {
    // Sentinels deliberately skip the file/SSO/container chain: resolving it
    // needs @aws-sdk/credential-providers (~6MB transitive tree), which is
    // kept out of the bundle. Codons on this machine still run Bedrock fine.
    require("node:fs").writeFileSync(
      process.env.AWS_SHARED_CREDENTIALS_FILE as string,
      "[default]\naws_access_key_id = AKIATEST\naws_secret_access_key = testsecret\n",
    );
    const registry = new LlmProviderRegistry({ logger });
    expect(bedrockStatus(registry)?.status).toBe("not-configured");
  });

  it("honors the HANKWEAVE_SENTINEL_ bearer override", () => {
    process.env.HANKWEAVE_SENTINEL_AWS_BEARER_TOKEN_BEDROCK = "override-token";
    const registry = new LlmProviderRegistry({ logger });
    expect(bedrockStatus(registry)?.status).toBe("available");
  });

  it("resolves the bedrock haiku inference profile and its health-check model", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer-token";
    const registry = new LlmProviderRegistry({ logger });
    const info = registry.getModelInfo(
      "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(info.success).toBe(true);
    if (info.success) {
      expect(info.info.providerId).toBe("amazon-bedrock");
      expect(info.info.cost).toBeDefined();
    }
    expect(registry.getHealthCheckModel("amazon-bedrock")).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
  });

  it("health-check candidates follow the configured region's geo profile", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer-token";

    const candidatesFor = (region?: string) => {
      if (region) process.env.AWS_REGION = region;
      else delete process.env.AWS_REGION;
      LlmProviderRegistry.resetInstance();
      const registry = new LlmProviderRegistry({ logger });
      return registry.getHealthCheckModelCandidates("amazon-bedrock");
    };

    // No region → default (us-east-1) → us. profile, global. as fall-through
    expect(candidatesFor()[0]).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(candidatesFor("eu-west-1").slice(0, 2)).toEqual([
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    ]);
    expect(candidatesFor("ap-northeast-1")[0]).toBe("jp.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(candidatesFor("ap-southeast-2")[0]).toBe("au.anthropic.claude-haiku-4-5-20251001-v1:0");
    // No geo-specific Anthropic profile → global. leads
    expect(candidatesFor("ap-south-1")[0]).toBe("global.anthropic.claude-haiku-4-5-20251001-v1:0");
    // GovCloud partition: us-gov. only — commercial us. and global. aren't
    // callable from it, and the candidate survives registry filtering even
    // though models.dev carries no us-gov. ids
    const govCandidates = candidatesFor("us-gov-east-1");
    expect(govCandidates[0]).toBe("us-gov.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(govCandidates).not.toContain("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(govCandidates).not.toContain("global.anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  it("classifies Bedrock's per-model access denial, not IAM invoke denials", () => {
    expect(
      isModelAccessDenialError(
        new Error("You don't have access to the model with the specified model ID."),
      ),
    ).toBe(true);
    // AI SDK APICallError carries the service message in responseBody
    const apiError = Object.assign(new Error("Forbidden"), {
      responseBody:
        '{"message":"You don\'t have access to the model with the specified model ID."}',
    });
    expect(isModelAccessDenialError(apiError)).toBe(true);
    expect(
      isModelAccessDenialError(
        new Error(
          "User: arn:aws:iam::123:user/x is not authorized to perform: bedrock:InvokeModel",
        ),
      ),
    ).toBe(false);
    expect(isModelAccessDenialError(new Error("The security token included is invalid"))).toBe(
      false,
    );
  });
});
