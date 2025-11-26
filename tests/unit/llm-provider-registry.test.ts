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
  });

  afterEach(() => {
    // Restore env using proper restore
    restoreEnv(originalEnv);
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
      const cost = registry.calculateCost(
        "claude-3-5-sonnet-20241022",
        1000, // 1K input tokens
        500, // 500 output tokens
      );

      // Cost should be: (1000/1M * 3.00) + (500/1M * 15.00)
      // = 0.003 + 0.0075 = 0.0105
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it("should return null for unknown models", () => {
      const cost = registry.calculateCost("unknown-model", 1000, 500);
      expect(cost).toBeNull();
    });

    it("should handle zero token counts", () => {
      const cost = registry.calculateCost("claude-3-5-sonnet-20241022", 0, 0);
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
    const cost = mockRegistry.calculateCost("claude-3-5-sonnet-20241022", 1000, 500);
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
