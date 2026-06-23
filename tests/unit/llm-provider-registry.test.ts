import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
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
      const sonnetInfoResult = registry.getModelInfo("claude-3-5-sonnet-20241022");
      expect(sonnetInfoResult.success).toBe(true);
      if (sonnetInfoResult.success) {
        expect(sonnetInfoResult.info.providerId).toBe("anthropic");
      }
    });

    it("should handle missing API keys gracefully", () => {
      // Clear all API keys (both standard and sentinel-prefixed)
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GROQ_API_KEY;
      delete process.env.HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY;
      delete process.env.HANKWEAVE_SENTINEL_OPENAI_API_KEY;
      delete process.env.HANKWEAVE_SENTINEL_GOOGLE_API_KEY;
      delete process.env.HANKWEAVE_SENTINEL_GROQ_API_KEY;

      registry = new LlmProviderRegistry({ logger: mockLogger });

      // Should log about missing keys
      const missingKeyLogs = logs.filter((l) => l.message.includes("No API key"));
      expect(missingKeyLogs.length).toBeGreaterThan(0);

      // Should not crash when getting provider
      const providerResult = registry.getProviderForModel("claude-3-5-sonnet-20241022");
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
      const modelResult = registry.getModelInfo("claude-3-5-sonnet-20241022");
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
      const modelResult = registry.getModelInfo("claude-3-5-sonnet-20241022");
      expect(modelResult.success).toBe(true);
      if (modelResult.success) {
        expect(modelResult.info.modelId).toBe("claude-3-5-sonnet-20241022");
      }
    });

    it("should find models by full ID", () => {
      const modelResult = registry.getModelInfo("anthropic/claude-3-5-sonnet-20241022");
      expect(modelResult.success).toBe(true);
      if (modelResult.success) {
        expect(modelResult.info.providerId).toBe("anthropic");
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
      const isAvailable = registry.isModelAvailable("claude-3-5-sonnet-20241022");
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
      const cost = registry.calculateCost("claude-3-5-sonnet-20241022", {
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
      const cost = registry.calculateCost("claude-3-5-sonnet-20241022", {
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

    describe("provider-specific cache token semantics", () => {
      it("should use additive semantics for Anthropic (inputTokens + cacheReadTokens)", () => {
        // Anthropic: inputTokens is fresh only, cacheReadTokens is additive
        // claude-3-5-sonnet-20241022 pricing:
        //   input: $3.00/M, output: $15.00/M, cache_read: $0.30/M
        const cost = registry.calculateCost("claude-3-5-sonnet-20241022", {
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
        const cost = registry.calculateCost("claude-3-5-sonnet-20241022", {
          inputTokens: 10000, // Fresh input only
          outputTokens: 2000,
          cacheReadTokens: 50000, // Additive cached tokens
          cacheCreationTokens: 1000,
        });

        // claude-3-5-sonnet-20241022 pricing:
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
      expect(stats.totalProviders).toBe(5); // anthropic, openai, google, groq, deepseek
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

      const providerResult = registry.getProviderForModel("claude-3-5-sonnet-20241022");
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
          model: "claude-3-5-sonnet-20241022",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.modelInfo.modelId).toBe("claude-3-5-sonnet-20241022");
          expect(result.matchType).toBe("exact");
        }
      });

      it("should resolve exact match with full model ID", () => {
        const result = registry.resolveModel({
          providerId: "anthropic",
          model: "anthropic/claude-3-5-sonnet-20241022",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.modelId).toBe("claude-3-5-sonnet-20241022");
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
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-6");
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
          expect(result.modelInfo.modelId).toBe("gemini-3.5-flash");
        }
      });
    });

    describe("exact matching with provider inference", () => {
      it("should resolve exact match without provider", () => {
        const result = registry.resolveModel({
          model: "claude-3-5-sonnet-20241022",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.modelInfo.modelId).toBe("claude-3-5-sonnet-20241022");
          expect(result.matchType).toBe("exact-with-inferred-provider");
        }
      });

      it("should prefer anthropic for claude models", () => {
        const result = registry.resolveModel({
          model: "claude-3-5-sonnet-20241022",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.modelId).toBe("claude-3-5-sonnet-20241022");
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
          expect(result.modelInfo.modelId).toBe("gemini-3.5-flash");
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
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-6");
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
          expect(result.modelInfo.modelId).toBe("gemini-3.5-flash");
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
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-6");
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
          expect(result.modelInfo.modelId).toBe("claude-opus-4-8");
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
          expect(result.modelInfo.modelId).toBe("claude-opus-4-8");
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

        it("should resolve gpt-5.2-codex-high by exact model ID", () => {
          const result = registry.resolveModel({
            model: "gpt-5.2-codex-high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-high");
            expect(result.matchType).toBe("exact-with-inferred-provider");
          }
        });

        it("should resolve gpt-5.2-codex-xhigh by exact model ID", () => {
          const result = registry.resolveModel({
            model: "gpt-5.2-codex-xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-xhigh");
            expect(result.matchType).toBe("exact-with-inferred-provider");
          }
        });

        it("should resolve gpt-5.2-codex-high with explicit provider", () => {
          const result = registry.resolveModel({
            providerId: "openai",
            model: "gpt-5.2-codex-high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-high");
            expect(result.matchType).toBe("exact");
          }
        });

        it("should resolve gpt-5.2-codex-xhigh with explicit provider", () => {
          const result = registry.resolveModel({
            providerId: "openai",
            model: "gpt-5.2-codex-xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-xhigh");
            expect(result.matchType).toBe("exact");
          }
        });

        it("should resolve with full model ID openai/gpt-5.2-codex-high", () => {
          const result = registry.resolveModel({
            model: "openai/gpt-5.2-codex-high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-high");
          }
        });

        it("should resolve with full model ID openai/gpt-5.2-codex-xhigh", () => {
          const result = registry.resolveModel({
            model: "openai/gpt-5.2-codex-xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-xhigh");
          }
        });
      });

      describe("fuzzy matching", () => {
        it("should fuzzy match 'gpt-5.2 codex' to base codex model", () => {
          const result = registry.resolveModel({
            model: "gpt-5.2 codex",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            // Should match base gpt-5.2-codex (most recent: 2026-01-14)
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should fuzzy match 'gpt-5.2 codex high' with dashes to correct variant", () => {
          const result = registry.resolveModel({
            model: "gpt-5.2 codex high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-high");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should fuzzy match 'gpt-5.2 codex xhigh' with dashes to correct variant", () => {
          const result = registry.resolveModel({
            model: "gpt-5.2 codex xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-xhigh");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should fuzzy match 'gpt-5.2 codex high' to a codex variant (spaces)", () => {
          const result = registry.resolveModel({
            model: "gpt-5.2 codex high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            // Should match the correct variant based on exact word matching
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-high");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should fuzzy match 'gpt-5.2 codex xhigh' to a codex variant (spaces)", () => {
          const result = registry.resolveModel({
            model: "gpt-5.2 codex xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            // Should match the correct variant based on exact word matching
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-xhigh");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should fuzzy match 'gpt 5.2 codex high' to a codex variant (no dashes)", () => {
          const result = registry.resolveModel({
            model: "gpt 5.2 codex high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            // Should match the correct variant based on exact word matching
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-high");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should fuzzy match 'gpt 5.2 codex xhigh' to a codex variant (no dashes)", () => {
          const result = registry.resolveModel({
            model: "gpt 5.2 codex xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            // Should match the correct variant based on exact word matching
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-xhigh");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should fuzzy match 'gpt 5.2 codex high' with spaces", () => {
          const result = registry.resolveModel({
            model: "gpt 5.2 codex high",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            // Should match the correct variant based on exact word matching
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-high");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should fuzzy match 'gpt 5.2 codex xhigh' with spaces", () => {
          const result = registry.resolveModel({
            model: "gpt 5.2 codex xhigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            // Should match the correct variant based on exact word matching
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-xhigh");
            expect(result.matchType).toBe("fuzzy");
          }
        });

        it("should match 'GPT-5.2-Codex-High' (mixed case)", () => {
          const result = registry.resolveModel({
            model: "GPT-5.2-Codex-High",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-high");
            // Can be exact-with-inferred-provider or fuzzy depending on case-insensitive matching
          }
        });

        it("should match 'GPT-5.2-Codex-XHigh' (mixed case)", () => {
          const result = registry.resolveModel({
            model: "GPT-5.2-Codex-XHigh",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-xhigh");
            // Can be exact-with-inferred-provider or fuzzy depending on case-insensitive matching
          }
        });

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

        it("should fuzzy match 'gpt 5.2 codex' to base codex model", () => {
          const result = registry.resolveModel({
            model: "gpt 5.2 codex",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.providerId).toBe("openai");
            // Should match base gpt-5.2-codex (most recent: 2026-01-14)
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex");
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

        it("should resolve GPT-5.2-CODEX-HIGH (uppercase)", () => {
          const result = registry.resolveModel({
            model: "GPT-5.2-CODEX-HIGH",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-high");
          }
        });

        it("should resolve GPT-5.2-CODEX-XHIGH (uppercase)", () => {
          const result = registry.resolveModel({
            model: "GPT-5.2-CODEX-XHIGH",
          });

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.modelInfo.modelId).toBe("gpt-5.2-codex-xhigh");
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

    describe("blocklist handling", () => {
      beforeEach(() => {
        registry = new LlmProviderRegistry({
          logger: mockLogger,
          blockList: {
            providers: ["groq"],
            models: ["claude-3-5-sonnet-20241022"],
          },
        });
      });

      it("should ignore blocklist by default", () => {
        const result = registry.resolveModel({
          model: "claude-3-5-sonnet-20241022",
        });

        // Should succeed because ignoreBlockList defaults to true
        expect(result.success).toBe(true);
      });

      it("should respect blocklist when ignoreBlockList is false", () => {
        const result = registry.resolveModel({
          model: "claude-3-5-sonnet-20241022",
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
          expect(result.modelInfo.modelId).not.toBe("claude-3-5-sonnet-20241022");
        }
      });
    });

    describe("blocklist handling for getModelInfo", () => {
      beforeEach(() => {
        registry = new LlmProviderRegistry({
          logger: mockLogger,
          blockList: {
            providers: ["groq"],
            models: ["claude-3-5-sonnet-20241022", "gpt-4o-2024-05-13"],
          },
        });
      });

      it("should block models in blocklist", () => {
        const result = registry.getModelInfo("claude-3-5-sonnet-20241022");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should block models in blocklist (case-insensitive)", () => {
        const result = registry.getModelInfo("CLAUDE-3-5-SONNET-20241022");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should block models with full model ID", () => {
        const result = registry.getModelInfo("anthropic/claude-3-5-sonnet-20241022");

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
        const result = registry.getModelInfo("claude-3-5-sonnet-20241022");

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
            models: ["claude-3-5-sonnet-20241022", "gpt-4o-2024-05-13"],
          },
        });
      });

      it("should block models in blocklist", () => {
        const result = registry.getProviderForModel("claude-3-5-sonnet-20241022");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }

        // Should log the error
        const errorLogs = logs.filter((l) => l.message.includes("Model blocked"));
        expect(errorLogs.length).toBeGreaterThan(0);
      });

      it("should block models in blocklist (case-insensitive)", () => {
        const result = registry.getProviderForModel("CLAUDE-3-5-SONNET-20241022");

        expect(result.success).toBe(false);
        if (result.success === false) {
          expect(result.reason).toBe("model-blocked");
        }
      });

      it("should block models with full model ID", () => {
        const result = registry.getProviderForModel("anthropic/claude-3-5-sonnet-20241022");

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
            models: ["claude-3-5-sonnet-20241022"],
          },
        });

        const result = registry.getProviderForModel("claude-3-5-sonnet-20241022");

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
        const blockedResult = registry.getProviderForModel("claude-3-5-sonnet-20241022");
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
          model: "claude-3-5-sonnet-20241022",
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
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-6");
        }
      });
    });

    describe("case insensitive exact matching", () => {
      it("should resolve exact match with uppercase model ID", () => {
        const result = registry.resolveModel({
          model: "CLAUDE-3-5-SONNET-20241022",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.modelId).toBe("claude-3-5-sonnet-20241022");
          expect(result.matchType).toBe("exact-with-inferred-provider");
        }
      });

      it("should resolve exact match with uppercase full provider/model ID", () => {
        const result = registry.resolveModel({
          providerId: "anthropic",
          model: "ANTHROPIC/CLAUDE-3-5-SONNET-20241022",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.modelId).toBe("claude-3-5-sonnet-20241022");
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.matchType).toBe("exact");
        }
      });

      it("should preserve original casing in returned ModelInfo", () => {
        const result = registry.resolveModel({
          model: "CLAUDE-3-5-SONNET-20241022",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // The returned modelInfo should have the original casing from the data file
          expect(result.modelInfo.modelId).toBe("claude-3-5-sonnet-20241022");
          expect(result.modelInfo.providerId).toBe("anthropic");
        }
      });

      it("should work with getModelInfo for uppercase IDs", () => {
        const result = registry.getModelInfo("CLAUDE-3-5-SONNET-20241022");

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.info.modelId).toBe("claude-3-5-sonnet-20241022");
        }
      });

      it("should work with getModelInfo for full uppercase IDs", () => {
        const result = registry.getModelInfo("ANTHROPIC/CLAUDE-3-5-SONNET-20241022");

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.info.modelId).toBe("claude-3-5-sonnet-20241022");
        }
      });
    });

    describe("case insensitive provider ID matching", () => {
      it("should resolve with uppercase provider ID", () => {
        const result = registry.resolveModel({
          providerId: "ANTHROPIC",
          model: "claude-3-5-sonnet-20241022",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.modelInfo.providerId).toBe("anthropic");
          expect(result.modelInfo.modelId).toBe("claude-3-5-sonnet-20241022");
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
          model: "claude-3-5-sonnet-20241022",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.matchType).toBe("exact");
        }
      });

      it("should return correct match type for inferred provider", () => {
        const result = registry.resolveModel({
          model: "claude-3-5-sonnet-20241022",
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

    it("should use config from first getInstance call", () => {
      const logger1 = new Logger("/tmp/test1.log");
      logger1.log = (message: string, level = "info") => {
        logs.push({ message: `logger1: ${message}`, level });
      };

      const logger2 = new Logger("/tmp/test2.log");
      logger2.log = (message: string, level = "info") => {
        logs.push({ message: `logger2: ${message}`, level });
      };

      const instance1 = LlmProviderRegistry.getInstance({ logger: logger1 });
      const instance2 = LlmProviderRegistry.getInstance({ logger: logger2 });

      // Both should be the same instance
      expect(instance1).toBe(instance2);

      // The logger should be from the first config
      // We can verify this by checking that subsequent operations use logger1
      const modelResult = instance2.getModelInfo("claude-3-5-sonnet-20241022");
      expect(modelResult.success).toBe(true);

      // Check that logs contain logger1 prefix (if any were generated)
      // Note: This is a weak test as initialization might not log much
    });

    it("should create new instance after resetInstance is called", () => {
      const instance1 = LlmProviderRegistry.getInstance({ logger: mockLogger });
      LlmProviderRegistry.resetInstance();
      const instance2 = LlmProviderRegistry.getInstance({ logger: mockLogger });

      expect(instance1).not.toBe(instance2);
    });

    it("should work when getInstance is called without config", () => {
      const instance1 = LlmProviderRegistry.getInstance();
      const instance2 = LlmProviderRegistry.getInstance();

      expect(instance1).toBe(instance2);
      expect(instance1).toBeDefined();
    });

    it("should be usable from different modules", () => {
      // Simulate accessing from different parts of the codebase
      const instance1 = LlmProviderRegistry.getInstance({ logger: mockLogger });

      // Verify instance works
      const modelResult = instance1.getModelInfo("claude-3-5-sonnet-20241022");
      expect(modelResult.success).toBe(true);

      // Get instance again (simulating different module)
      const instance2 = LlmProviderRegistry.getInstance();

      // Should be the same instance and have the same data
      expect(instance2).toBe(instance1);
      const modelResult2 = instance2.getModelInfo("claude-3-5-sonnet-20241022");
      expect(modelResult2.success).toBe(true);
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
          expectedModelId: "claude-opus-4-8",
        },
        {
          input: "sonnet",
          expectedProvider: "anthropic",
          expectedModelId: "claude-sonnet-4-6",
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

    it("should resolve 'opus' to claude-opus-4-8", () => {
      const result = registry.resolveModel({
        model: "opus", // Short name that gets expanded to "claude-opus"
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-opus-4-8");
        // Should be fuzzy match since shortcuts expand to patterns, not exact IDs
        expect(result.matchType).toBe("fuzzy");
      }
    });

    it("should resolve 'sonnet' to claude-sonnet-4-6", () => {
      const result = registry.resolveModel({
        model: "sonnet", // Short name that gets expanded to "claude-sonnet"
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-sonnet-4-6");
        // Should be fuzzy match
        expect(result.matchType).toBe("fuzzy");
      }
    });

    it("should resolve 'opus' with anthropic provider to claude-opus-4-8", () => {
      const result = registry.resolveModel({
        providerId: "anthropic",
        model: "opus", // Shortcut + explicit provider
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-opus-4-8");
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
        expect(result.modelInfo.modelId).toBe("claude-opus-4-8");
      }
    });

    it("should resolve opus to most recent model (claude-opus-4-8)", () => {
      const result = registry.resolveModel({
        model: "opus",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Should resolve to claude-opus-4-8 (most recent)
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-opus-4-8");
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
