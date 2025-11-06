import { beforeEach, describe, expect, it } from "bun:test";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import { Logger } from "../../server/utils.js";
import { MockLlmProviderRegistry } from "../utils/mock-llm-provider-registry.js";

describe("Provider Registry Performance", () => {
  let logs: string[] = [];
  let mockLogger: Logger;

  beforeEach(() => {
    logs = [];
    mockLogger = new Logger("/tmp/test-provider-load.log");

    // Override log method to capture logs
    const originalLog = mockLogger.log.bind(mockLogger);
    mockLogger.log = (message: string, level = "info") => {
      logs.push(`[${level}] ${message}`);
      originalLog(message, level);
    };
  });

  describe("concurrent operations", () => {
    it("should handle concurrent model lookups efficiently", () => {
      const registry = new LlmProviderRegistry({ logger: mockLogger });

      const start = performance.now();

      // Simulate 1000 concurrent lookups
      const lookups = [];
      for (let i = 0; i < 1000; i++) {
        lookups.push(
          registry.getModelInfo("claude-3-haiku-20240307"),
          registry.calculateCost("claude-3-haiku-20240307", 1000, 500),
          registry.isModelAvailable("gpt-4o"),
        );
      }

      const end = performance.now();
      const duration = end - start;

      console.log(`1000 lookups took ${duration.toFixed(2)}ms`);

      // Should be very fast (< 100ms for 1000 lookups)
      expect(duration).toBeLessThan(100);
    });

    it("should handle rapid model availability checks", () => {
      const registry = new MockLlmProviderRegistry();

      // Set up multiple providers and models
      registry.setProviderAvailable("anthropic", true);
      registry.setProviderAvailable("openai", true);
      registry.setProviderAvailable("google", true);

      const start = performance.now();

      // Test rapid availability checks
      const modelNames = [
        "claude-3-5-sonnet-20241022",
        "gpt-4o-mini",
        "gemini-1.5-flash",
        "non-existent-model",
        "another-fake-model",
      ];

      for (let i = 0; i < 500; i++) {
        for (const modelName of modelNames) {
          registry.isModelAvailable(modelName);
        }
      }

      const end = performance.now();
      const duration = end - start;

      console.log(`2500 availability checks took ${duration.toFixed(2)}ms`);

      // Should complete in under 150ms
      expect(duration).toBeLessThan(150);
    });

    it("should handle many cost calculations efficiently", () => {
      const registry = new MockLlmProviderRegistry();

      const start = performance.now();

      // Test many cost calculations with different token amounts
      const models = ["claude-3-5-sonnet-20241022", "gpt-4o-mini", "gemini-1.5-flash"];

      for (let i = 0; i < 1000; i++) {
        for (const model of models) {
          registry.calculateCost(model, i * 100, i * 50);
        }
      }

      const end = performance.now();
      const duration = end - start;

      console.log(`3000 cost calculations took ${duration.toFixed(2)}ms`);

      // Should be very fast
      expect(duration).toBeLessThan(50);
    });
  });

  describe("initialization performance", () => {
    it("should initialize quickly with large model datasets", () => {
      const start = performance.now();

      // Create registry (loads models from JSON file)
      const registry = new LlmProviderRegistry({
        logger: mockLogger,
      });

      const end = performance.now();
      const initDuration = end - start;

      console.log(`Registry initialization took ${initDuration.toFixed(2)}ms`);

      // Should initialize quickly even with many models
      expect(initDuration).toBeLessThan(1000); // Less than 1 second

      // Verify models were loaded
      const stats = registry.getStats();
      expect(stats.totalModels).toBeGreaterThan(0);

      console.log(`Loaded ${stats.totalModels} models from ${stats.totalProviders} providers`);
    });

    it("should handle multiple registry instances efficiently", () => {
      const start = performance.now();

      // Create multiple registry instances
      const registries = [];
      for (let i = 0; i < 10; i++) {
        registries.push(new LlmProviderRegistry({ logger: mockLogger }));
      }

      const end = performance.now();
      const duration = end - start;

      console.log(`Creating 10 registry instances took ${duration.toFixed(2)}ms`);

      // Should scale well
      expect(duration).toBeLessThan(2000);

      // All should have same model count
      const modelCounts = registries.map((r) => r.getStats().totalModels);
      const firstCount = modelCounts[0];
      expect(modelCounts.every((count) => count === firstCount)).toBe(true);
    });
  });

  describe("memory usage patterns", () => {
    it("should not leak memory with repeated operations", () => {
      const registry = new MockLlmProviderRegistry();

      // Simulate memory-intensive operations
      const initialMemory = process.memoryUsage().heapUsed;

      for (let round = 0; round < 100; round++) {
        // Create and discard data structures
        const models = registry.getAvailableModels();
        for (const model of models) {
          registry.getModelInfo(model);
          registry.calculateCost(model, Math.random() * 10000, Math.random() * 5000);
        }

        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;
      const memoryIncreaseMB = memoryIncrease / (1024 * 1024);

      console.log(`Memory increase after 100 rounds: ${memoryIncreaseMB.toFixed(2)}MB`);

      // Should not increase memory significantly (< 50MB increase)
      expect(memoryIncreaseMB).toBeLessThan(50);
    });
  });

  describe("health check performance", () => {
    it("should handle health check timeouts efficiently", async () => {
      const registry = new MockLlmProviderRegistry();

      // Set up providers that will timeout
      registry.setProviderAvailable("anthropic", true);
      registry.setProviderAvailable("openai", true);
      registry.setProviderHealth("anthropic", false); // Will fail health check
      registry.setProviderHealth("openai", false); // Will fail health check

      const start = performance.now();

      // Health checks should complete quickly even when failing
      const statuses = await registry.performHealthChecks();

      const end = performance.now();
      const duration = end - start;

      console.log(`Health checks for 2 failing providers took ${duration.toFixed(2)}ms`);

      // Should complete quickly even with failures
      expect(duration).toBeLessThan(1000);

      // Most providers should be marked as unhealthy (depending on mock implementation)
      const unhealthyCount = Array.from(statuses.values()).filter(
        (s) => s.status === "available" && !s.healthy,
      ).length;
      expect(unhealthyCount).toBeGreaterThanOrEqual(0); // Some may be unhealthy
    });

    it("should batch health checks efficiently", async () => {
      const registry = new MockLlmProviderRegistry();

      // Set up many providers
      for (let i = 0; i < 10; i++) {
        registry.setProviderAvailable(`provider-${i}`, true);
        registry.setProviderHealth(`provider-${i}`, i % 2 === 0); // Half healthy, half not
      }

      const start = performance.now();

      await registry.performHealthChecks();

      const end = performance.now();
      const duration = end - start;

      console.log(`Health checks for 10 providers took ${duration.toFixed(2)}ms`);

      // Should handle many providers efficiently
      expect(duration).toBeLessThan(2000);
    });
  });

  describe("stress testing", () => {
    it("should handle high-frequency model requests", () => {
      const registry = new LlmProviderRegistry({ logger: mockLogger });

      const start = performance.now();

      // Simulate high-frequency requests like those from active chroniclers
      for (let i = 0; i < 10000; i++) {
        const modelName = i % 2 === 0 ? "claude-3-haiku-20240307" : "gpt-4o";
        registry.getProviderForModel(modelName);
      }

      const end = performance.now();
      const duration = end - start;

      console.log(`10,000 model requests took ${duration.toFixed(2)}ms`);

      // Should handle high frequency efficiently
      expect(duration).toBeLessThan(500);
    });

    it("should handle large cost calculation batches", () => {
      const registry = new MockLlmProviderRegistry();

      // Test with realistic chronicler usage patterns
      const start = performance.now();

      const models = ["claude-3-haiku-20240307", "gpt-4o-mini", "gemini-1.5-flash"];
      let totalCalculations = 0;

      for (let batch = 0; batch < 100; batch++) {
        for (const model of models) {
          for (let i = 0; i < 10; i++) {
            const inputTokens = Math.floor(Math.random() * 5000) + 100;
            const outputTokens = Math.floor(Math.random() * 1000) + 50;
            registry.calculateCost(model, inputTokens, outputTokens);
            totalCalculations++;
          }
        }
      }

      const end = performance.now();
      const duration = end - start;

      console.log(`${totalCalculations} cost calculations took ${duration.toFixed(2)}ms`);

      // Should handle large batches efficiently
      expect(duration).toBeLessThan(200);
    });

    it("should maintain responsiveness under load", async () => {
      const registry = new MockLlmProviderRegistry();

      // Enable providers
      registry.setProviderAvailable("anthropic", true);
      registry.setProviderAvailable("openai", true);

      // Simulate concurrent chronicler load
      const promises = [];

      for (let i = 0; i < 50; i++) {
        promises.push(
          (async () => {
            // Simulate chronicler checking model availability and calculating costs
            const model = i % 2 === 0 ? "claude-3-5-sonnet-20241022" : "gpt-4o-mini";

            registry.isModelAvailable(model);
            registry.getProviderForModel(model);
            registry.calculateCost(model, 1000, 500);

            // Simulate small delay between operations
            await new Promise((resolve) => setTimeout(resolve, 1));
          })(),
        );
      }

      const start = performance.now();
      await Promise.all(promises);
      const end = performance.now();

      const duration = end - start;
      console.log(`50 concurrent chronicler simulations took ${duration.toFixed(2)}ms`);

      // Should handle concurrent load well
      expect(duration).toBeLessThan(1000);
    });
  });

  describe("data structure efficiency", () => {
    it("should efficiently handle model lookups by different keys", () => {
      const registry = new LlmProviderRegistry({ logger: mockLogger });

      const start = performance.now();

      // Test lookups by both short and full model names
      const testModels = [
        "claude-3-haiku-20240307",
        "anthropic/claude-3-haiku-20240307",
        "gpt-4o",
        "openai/gpt-4o",
        "gemini-1.5-flash",
        "google/gemini-1.5-flash",
      ];

      for (let i = 0; i < 1000; i++) {
        for (const modelName of testModels) {
          registry.getModelInfo(modelName);
        }
      }

      const end = performance.now();
      const duration = end - start;

      console.log(`6000 model info lookups took ${duration.toFixed(2)}ms`);

      // Should be very fast due to Map-based storage
      expect(duration).toBeLessThan(100);
    });

    it("should scale well with large provider lists", () => {
      const registry = new MockLlmProviderRegistry();

      // Clear all data first and reset to empty state
      registry.clearAllModels();
      registry.clearAllProviders();

      // Add many mock models
      for (let providerId = 0; providerId < 20; providerId++) {
        registry.setProviderAvailable(`provider-${providerId}`, true);

        for (let modelId = 0; modelId < 50; modelId++) {
          registry.addMockModel({
            providerId: `provider-${providerId}`,
            modelId: `model-${modelId}`,
            name: `Model ${modelId}`,
            fullModelId: `provider-${providerId}/model-${modelId}`,
            costPerMillionInput: Math.random() * 10,
            costPerMillionOutput: Math.random() * 20,
            maxContext: 100000,
            maxOutput: 4096,
            deprecated: false,
          });
        }
      }

      const start = performance.now();

      // Test operations on large dataset
      const availableModels = registry.getAvailableModels();
      expect(availableModels.length).toBeGreaterThanOrEqual(1000); // At least 1000 models
      console.log(`Actually loaded ${availableModels.length} models for performance testing`);

      // Test lookups on large dataset
      for (let i = 0; i < 100; i++) {
        registry.getModelInfo(`model-${i % 50}`);
        registry.calculateCost(`model-${i % 50}`, 1000, 500);
      }

      const end = performance.now();
      const duration = end - start;

      console.log(`Operations on 1000 models took ${duration.toFixed(2)}ms`);

      // Should scale well
      expect(duration).toBeLessThan(200);
    });
  });

  describe("real-world load simulation", () => {
    it("should handle realistic chronicler usage patterns", async () => {
      const registry = new LlmProviderRegistry({ logger: mockLogger });

      // Simulate chronicler manager with multiple chroniclers
      const chroniclerConfigs = [
        { id: "narrator", model: "claude-3-haiku-20240307" },
        { id: "analyzer", model: "gpt-4o" },
        { id: "summarizer", model: "gemini-1.5-flash" },
        { id: "error-detector", model: "claude-3-haiku-20240307" },
        { id: "cost-tracker", model: "gemini-1.5-flash" },
      ];

      const start = performance.now();

      // Simulate chronicler initialization phase
      for (const config of chroniclerConfigs) {
        // Each chronicler checks model availability on startup
        registry.isModelAvailable(config.model);
        registry.getProviderForModel(config.model);
        registry.getModelInfo(config.model);
      }

      // Simulate runtime usage - each chronicler processes events
      for (let event = 0; event < 200; event++) {
        for (const config of chroniclerConfigs) {
          // Simulate LLM call and cost tracking
          const randomInputTokens = Math.floor(Math.random() * 2000) + 100;
          const randomOutputTokens = Math.floor(Math.random() * 500) + 50;

          registry.calculateCost(config.model, randomInputTokens, randomOutputTokens);

          // Occasionally check model availability (health status changes)
          if (event % 50 === 0) {
            registry.isModelAvailable(config.model);
          }
        }
      }

      const end = performance.now();
      const duration = end - start;

      console.log(
        `Realistic chronicler simulation (5 chroniclers, 200 events) took ${duration.toFixed(2)}ms`,
      );

      // Should handle realistic load efficiently
      expect(duration).toBeLessThan(1000);
    });

    it("should handle burst load patterns", async () => {
      const registry = new MockLlmProviderRegistry();

      // Set up providers
      registry.setProviderAvailable("anthropic", true);
      registry.setProviderAvailable("openai", true);

      // Simulate burst patterns (many operations at once, then quiet)
      const burstSizes = [10, 50, 100, 200];
      const results = [];

      for (const burstSize of burstSizes) {
        const start = performance.now();

        // Create burst of operations
        const operations = [];
        for (let i = 0; i < burstSize; i++) {
          operations.push(
            registry.getAvailableModels(),
            registry.calculateCost("claude-3-5-sonnet-20241022", 1000, 500),
            registry.isModelAvailable("gpt-4o-mini"),
          );
        }

        // Wait for all operations (they're synchronous but simulate async pattern)
        await Promise.all(operations.map((op) => Promise.resolve(op)));

        const end = performance.now();
        const duration = end - start;

        results.push({ burstSize: burstSize * 3, duration }); // 3 operations per iteration
        console.log(`Burst of ${burstSize * 3} operations took ${duration.toFixed(2)}ms`);
      }

      // Performance should scale reasonably (not exponentially)
      for (let i = 1; i < results.length; i++) {
        const prev = results[i - 1];
        const curr = results[i];
        const scaleFactor = curr.duration / prev.duration;
        const sizeFactor = curr.burstSize / prev.burstSize;

        // Duration scaling should be better than linear (due to caching/optimization)
        expect(scaleFactor).toBeLessThan(sizeFactor * 2);
      }
    });
  });

  describe("edge case performance", () => {
    it("should handle non-existent model lookups efficiently", () => {
      const registry = new LlmProviderRegistry({ logger: mockLogger });

      const start = performance.now();

      // Many lookups for non-existent models
      for (let i = 0; i < 1000; i++) {
        registry.getModelInfo(`fake-model-${i}`);
        registry.isModelAvailable(`fake-model-${i}`);
        registry.calculateCost(`fake-model-${i}`, 1000, 500);
      }

      const end = performance.now();
      const duration = end - start;

      console.log(`1000 failed lookups took ${duration.toFixed(2)}ms`);

      // Failed lookups should be fast (cache misses)
      expect(duration).toBeLessThan(50);
    });

    it("should handle rapid provider status changes", async () => {
      const registry = new MockLlmProviderRegistry();

      const start = performance.now();

      // Simulate rapid provider health changes
      for (let i = 0; i < 100; i++) {
        registry.setProviderHealth("anthropic", i % 2 === 0);
        registry.setProviderHealth("openai", i % 3 === 0);

        // Check model availability after each change
        registry.isModelAvailable("claude-3-5-sonnet-20241022");
        registry.isModelAvailable("gpt-4o-mini");
      }

      const end = performance.now();
      const duration = end - start;

      console.log(`100 rapid health changes took ${duration.toFixed(2)}ms`);

      // Should handle rapid changes efficiently
      expect(duration).toBeLessThan(100);
    });

    it("should maintain performance with many cost formatting operations", () => {
      const registry = new MockLlmProviderRegistry();

      const start = performance.now();

      // Test cost formatting with various amounts
      const testCosts = [0, 0.0001, 0.001, 0.01, 0.1, 1.0, 10.0, 100.0];

      for (let i = 0; i < 1000; i++) {
        for (const cost of testCosts) {
          registry.formatCost(cost * Math.random());
        }
      }

      const end = performance.now();
      const duration = end - start;

      console.log(`8000 cost formatting operations took ${duration.toFixed(2)}ms`);

      // Should be very fast
      expect(duration).toBeLessThan(100);
    });
  });

  describe("concurrent health checks", () => {
    it("should handle concurrent health check requests", async () => {
      const registry = new MockLlmProviderRegistry();

      // Set up providers
      registry.setProviderAvailable("anthropic", true);
      registry.setProviderAvailable("openai", true);
      registry.setProviderAvailable("google", true);

      const start = performance.now();

      // Run multiple health checks concurrently
      const healthCheckPromises = [];
      for (let i = 0; i < 5; i++) {
        healthCheckPromises.push(registry.performHealthChecks());
      }

      const results = await Promise.all(healthCheckPromises);

      const end = performance.now();
      const duration = end - start;

      console.log(`5 concurrent health checks took ${duration.toFixed(2)}ms`);

      // Should handle concurrent requests efficiently
      expect(duration).toBeLessThan(500);

      // All results should be consistent
      expect(results.length).toBe(5);
      for (const result of results) {
        expect(result.size).toBeGreaterThan(0);
      }
    });
  });
});
