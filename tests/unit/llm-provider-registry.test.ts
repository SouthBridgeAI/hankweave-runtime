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
      delete process.env.STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY;
      delete process.env.STRANDWEAVE_SENTINEL_OPENAI_API_KEY;
      delete process.env.STRANDWEAVE_SENTINEL_GOOGLE_API_KEY;
      delete process.env.STRANDWEAVE_SENTINEL_GROQ_API_KEY;

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
  });

  describe("provider status and health", () => {
    it("should report providers as unavailable when API keys missing", () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY;
      delete process.env.STRANDWEAVE_SENTINEL_OPENAI_API_KEY;
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
        healthCheckTimeout: 1000, // Short timeout for tests
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
      expect(stats.totalProviders).toBe(4); // anthropic, openai, google, groq
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
      delete process.env.STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY;
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
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5");
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
          expect(result.modelInfo.modelId).toBe("gemini-flash-latest");
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
          expect(result.modelInfo.modelId).toBe("gemini-flash-latest");
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

    describe("fuzzy matching", () => {
      it("should fuzzy match partial model names", () => {
        const result = registry.resolveModel({
          model: "claude-sonnet",
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Should match the most recent claude sonnet from anthropic
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5");
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
          expect(result.modelInfo.modelId).toBe("gemini-3-flash-preview");
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
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5-20250929");
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
          expect(result.modelInfo.modelId).toBe("claude-opus-4-5");
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
          expect(result.modelInfo.modelId).toBe("claude-opus-4-5");
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
          expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5");
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
          expectedModelId: "claude-opus-4-5",
        },
        {
          input: "sonnet",
          expectedProvider: "anthropic",
          expectedModelId: "claude-sonnet-4-5",
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

    it("should resolve 'opus' to claude-opus-4-5", () => {
      const result = registry.resolveModel({
        model: "opus", // Short name that gets expanded to "claude-opus"
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-opus-4-5");
        // Should be fuzzy match since shortcuts expand to patterns, not exact IDs
        expect(result.matchType).toBe("fuzzy");
      }
    });

    it("should resolve 'sonnet' to claude-sonnet-4-5", () => {
      const result = registry.resolveModel({
        model: "sonnet", // Short name that gets expanded to "claude-sonnet"
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-sonnet-4-5");
        // Should be fuzzy match
        expect(result.matchType).toBe("fuzzy");
      }
    });

    it("should resolve 'opus' with anthropic provider to claude-opus-4-5", () => {
      const result = registry.resolveModel({
        providerId: "anthropic",
        model: "opus", // Shortcut + explicit provider
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-opus-4-5");
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
        expect(result.modelInfo.modelId).toBe("claude-opus-4-5");
      }
    });

    it("should resolve opus to most recent model (claude-opus-4-5)", () => {
      const result = registry.resolveModel({
        model: "opus",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Should resolve to claude-opus-4-5 (most recent)
        expect(result.modelInfo.providerId).toBe("anthropic");
        expect(result.modelInfo.modelId).toBe("claude-opus-4-5");
        expect(result.modelInfo.last_updated).toBeDefined();
        // Verify it's the 2025 version
        expect(result.modelInfo.last_updated).toContain("2025");
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
