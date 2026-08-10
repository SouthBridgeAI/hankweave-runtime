import { beforeEach, describe, expect, it } from "bun:test";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import { PROVIDER_DEFINITIONS } from "../../server/llm/provider-config.js";
import { Logger } from "../../server/utils.js";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";
import { MockLlmProviderRegistry } from "../utils/mock-llm-provider-registry.js";

describe("Provider Fallback Scenarios", () => {
  let logs: string[] = [];
  let mockLogger: Logger;

  beforeEach(() => {
    logs = [];
    mockLogger = new Logger("/tmp/test-provider-fallback.log");

    // Override log method to capture logs
    const originalLog = mockLogger.log.bind(mockLogger);
    mockLogger.log = (message: string, level = "info") => {
      logs.push(`[${level}] ${message}`);
      originalLog(message, level);
    };
  });

  describe("provider availability scenarios", () => {
    it("should handle all providers being unavailable", () => {
      const originalEnv = captureEnv();

      try {
        // Clear all API keys
        for (const def of PROVIDER_DEFINITIONS) {
          delete process.env[def.apiKeyEnvVar];
          delete process.env[`HANKWEAVE_SENTINEL_${def.apiKeyEnvVar}`];
        }

        const registry = new LlmProviderRegistry({ logger: mockLogger });
        const statuses = registry.getProviderStatus();

        // All providers should be unavailable. API-key providers report
        // "No API key"; amazon-bedrock reports its credential-chain message
        // ("No credentials found ...") since it accepts more than one env var.
        for (const [_id, status] of statuses) {
          expect(status.status).toBe("not-configured");
          expect(status.error).toMatch(/No API key|No credentials found/);
        }

        // No models should be available
        const availableModels = registry.getAvailableModels();
        expect(availableModels).toHaveLength(0);

        console.log("✅ Handled scenario with no providers available");
      } finally {
        restoreEnv(originalEnv);
      }
    });

    it("should prioritize providers correctly when multiple are available", () => {
      const originalEnv = captureEnv();

      try {
        // Clear ALL provider API keys first
        for (const def of PROVIDER_DEFINITIONS) {
          delete process.env[def.apiKeyEnvVar];
        }

        // Set up exactly 3 providers
        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
        process.env.OPENAI_API_KEY = "test-openai-key";
        process.env.GEMINI_API_KEY = "test-google-key";
        // GROQ_API_KEY is intentionally not set

        const registry = new LlmProviderRegistry({ logger: mockLogger });
        const statuses = registry.getProviderStatus();

        // Count available providers (we set up 3 out of 4 total)
        const availableProviders = Array.from(statuses.values()).filter(
          (s) => s.status === "available",
        );
        expect(availableProviders.length).toBe(3);

        // Total providers should match PROVIDER_DEFINITIONS
        expect(statuses.size).toBe(PROVIDER_DEFINITIONS.length);

        // Should have models from all providers
        const anthropicModels = registry.getModelsForProvider("anthropic");
        const openaiModels = registry.getModelsForProvider("openai");
        const googleModels = registry.getModelsForProvider("google");

        expect(anthropicModels.length).toBeGreaterThan(0);
        expect(openaiModels.length).toBeGreaterThan(0);
        expect(googleModels.length).toBeGreaterThan(0);

        console.log(
          `✅ Multiple providers available: anthropic(${anthropicModels.length}), openai(${openaiModels.length}), google(${googleModels.length}) models`,
        );
      } finally {
        restoreEnv(originalEnv);
      }
    });

    it("should handle partial provider failures gracefully", async () => {
      const originalEnv = captureEnv();

      try {
        // Clear ALL provider API keys first, then set up only Anthropic
        for (const def of PROVIDER_DEFINITIONS) {
          delete process.env[def.apiKeyEnvVar];
        }
        process.env.ANTHROPIC_API_KEY = "test-key";

        const registry = new LlmProviderRegistry({
          logger: mockLogger,
          healthCheckTimeout: 5000,
        });

        // Perform health checks
        const statuses = await registry.performHealthChecks();

        // Anthropic should be available, others should not
        expect(statuses.get("anthropic")?.status).toBe("available");
        expect(statuses.get("openai")?.status).toBe("not-configured");
        expect(statuses.get("google")?.status).toBe("not-configured");

        // Note: Even though Anthropic is available, health checks may fail with test keys
        // so we test the logic rather than expecting specific model availability
        const availableModels = registry.getAvailableModels();
        const anthropicModels = availableModels.filter((m) => m.startsWith("anthropic/"));
        const nonAnthropicModels = availableModels.filter((m) => !m.startsWith("anthropic/"));

        // With test keys, health checks may fail, so models might not be available
        // But we should have more Anthropic models than other providers in the registry
        const allAnthropicModels = registry.getModelsForProvider("anthropic");
        const _allOpenaiModels = registry.getModelsForProvider("openai");

        expect(allAnthropicModels.length).toBeGreaterThan(0);
        expect(nonAnthropicModels.length).toBe(0); // Other providers have no API keys

        console.log(
          `✅ Partial failure handled: Anthropic has ${allAnthropicModels.length} models registered, ${anthropicModels.length} available after health checks`,
        );
      } finally {
        restoreEnv(originalEnv);
      }
    });
  });

  describe("health check failure scenarios", () => {
    it("should handle health check failures", async () => {
      const registry = new MockLlmProviderRegistry();

      // Set providers as available but unhealthy
      registry.setProviderAvailable("anthropic", true);
      registry.setProviderAvailable("openai", true);
      registry.setProviderHealth("anthropic", false); // Unhealthy
      registry.setProviderHealth("openai", true); // Healthy

      const statuses = await registry.performHealthChecks();

      // Anthropic should be available but unhealthy
      const anthropicStatus = statuses.get("anthropic");
      if (anthropicStatus && anthropicStatus.status === "available") {
        expect(anthropicStatus.healthy).toBe(false);
      } else {
        expect(false).toBe(true); // Should be available
      }

      // OpenAI should be available and healthy
      const openaiStatus = statuses.get("openai");
      if (openaiStatus && openaiStatus.status === "available") {
        expect(openaiStatus.healthy).toBe(true);
      } else {
        expect(false).toBe(true); // Should be available
      }

      // Only healthy providers should have available models
      const claudeModel = registry.getProviderForModel("claude-3-5-sonnet-20241022");
      const gptModel = registry.getProviderForModel("gpt-4o-mini");

      expect(claudeModel.success).toBe(false); // Unhealthy provider
      expect(gptModel.success).toBe(true); // Healthy provider

      console.log("✅ Health check failures handled correctly");
    });

    it("should report all provider statuses comprehensively", async () => {
      const registry = new LlmProviderRegistry({ logger: mockLogger });
      const statuses = await registry.performHealthChecks();

      // Create availability report
      const report = {
        total: statuses.size,
        available: 0,
        healthy: 0,
        failed: 0,
        missingKeys: 0,
      };

      const providerDetails: Record<
        string,
        {
          available: boolean;
          healthy: boolean;
          error?: string;
          lastChecked?: string;
        }
      > = {};

      for (const [id, status] of statuses) {
        if (status.status === "available") {
          report.available++;
          if (status.healthy) {
            report.healthy++;
          } else {
            report.failed++;
          }
        } else if (status.status === "not-configured") {
          report.missingKeys++;
        }

        providerDetails[id] = {
          available: status.status === "available",
          healthy: status.status === "available" ? status.healthy : false,
          error: status.error,
          lastChecked:
            status.status === "available" || status.status === "failed"
              ? status.lastChecked?.toISOString()
              : undefined,
        };
      }

      console.log("Provider Status Report:", report);
      console.log("Provider Details:", JSON.stringify(providerDetails, null, 2));

      // At least we should have status entries for all configured providers
      expect(statuses.size).toBe(PROVIDER_DEFINITIONS.length);

      // Each status should have the required fields
      for (const [id, status] of statuses) {
        expect(status.id).toBe(id);
        expect(typeof status.status).toBe("string");
        // Check status is one of the valid discriminated union values
        expect(["not-configured", "available", "failed"]).toContain(status.status);
      }
    });
  });

  describe("fallback logic simulation", () => {
    it("should demonstrate provider fallback pattern", () => {
      const registry = new MockLlmProviderRegistry();

      // Simulate scenario: Anthropic down, OpenAI available
      registry.setProviderAvailable("anthropic", false);
      registry.setProviderAvailable("openai", true);
      registry.setProviderHealth("openai", true);

      // Simulate sentinel fallback logic
      const preferredModels = ["claude-3-5-sonnet-20241022", "gpt-4o-mini", "gemini-1.5-flash"];
      let selectedModel = null;

      for (const modelName of preferredModels) {
        const result = registry.getProviderForModel(modelName);
        if (result.success) {
          selectedModel = modelName;
          break;
        }
      }

      // Should fall back to OpenAI model
      expect(selectedModel).toBe("gpt-4o-mini");

      // Calculate cost difference
      const claudeCost = registry.calculateCost("claude-3-5-sonnet-20241022", {
        inputTokens: 1000,
        outputTokens: 500,
      });
      const gptCost = registry.calculateCost("gpt-4o-mini", {
        inputTokens: 1000,
        outputTokens: 500,
      });

      console.log(
        `Fallback from Claude (${
          claudeCost ? registry.formatCost(claudeCost) : "unavailable"
        }) to GPT (${gptCost ? registry.formatCost(gptCost) : "unavailable"})`,
      );

      expect(gptCost).not.toBeNull();
    });

    it("should handle cost-based provider selection", () => {
      const registry = new MockLlmProviderRegistry();

      // Set all providers as available
      registry.setProviderAvailable("anthropic", true);
      registry.setProviderAvailable("openai", true);
      registry.setProviderAvailable("google", true);

      // Get all available models and sort by input cost
      const models = registry.getAvailableModels();
      const modelCosts = models
        .map((modelId) => {
          const infoResult = registry.getModelInfo(modelId);
          const info = infoResult.success ? infoResult.info : null;
          return {
            modelId,
            cost: info?.costPerMillionInput || 0,
            provider: info?.providerId,
          };
        })
        .filter((m) => m.cost > 0)
        .sort((a, b) => a.cost - b.cost);

      if (modelCosts.length > 0) {
        const cheapest = modelCosts[0];
        const mostExpensive = modelCosts[modelCosts.length - 1];

        console.log(
          `Cheapest model: ${cheapest.modelId} (${cheapest.provider}) at $${cheapest.cost}/M tokens`,
        );
        console.log(
          `Most expensive model: ${mostExpensive.modelId} (${mostExpensive.provider}) at $${mostExpensive.cost}/M tokens`,
        );

        // Cost difference should be significant
        expect(mostExpensive.cost).toBeGreaterThan(cheapest.cost);
      }
    });
  });

  describe("error recovery scenarios", () => {
    it("should handle provider initialization failures", () => {
      const originalEnv = captureEnv();

      try {
        // Set invalid API keys (simulate auth failure)
        process.env.ANTHROPIC_API_KEY = "invalid-key";
        process.env.OPENAI_API_KEY = "another-invalid-key";

        const registry = new LlmProviderRegistry({ logger: mockLogger });

        // Providers should be marked as available (key exists) but will fail health checks
        const statuses = registry.getProviderStatus();
        expect(statuses.get("anthropic")?.status).toBe("available");
        expect(statuses.get("openai")?.status).toBe("available");

        // Models should NOT be available with invalid keys (provider is available but unhealthy)
        // The registry marks providers with invalid keys as unhealthy immediately
        // Provider-qualified so the lookup can't resolve to another reseller of
        // the same model that has no key set.
        const claudeResult = registry.getProviderForModel("anthropic/claude-haiku-4-5-20251001");

        // The model won't be available because the provider has an invalid key
        expect(claudeResult.success).toBe(false);

        // Check the reason for failure
        // With invalid API keys, the provider is available but will be marked unhealthy on first use
        // Since we haven't done health checks yet, it should show as provider-unhealthy
        if ("reason" in claudeResult) {
          expect(claudeResult.reason).toContain("unhealthy");
        }

        console.log("✅ Provider initialization with invalid keys handled");
      } finally {
        restoreEnv(originalEnv);
      }
    });

    it("should provide detailed error information", async () => {
      const registry = new MockLlmProviderRegistry();

      // Simulate various failure modes
      registry.setProviderAvailable("anthropic", false); // No API key
      registry.setProviderAvailable("openai", true); // Has key
      registry.setProviderHealth("openai", false); // But unhealthy

      const statuses = await registry.performHealthChecks();

      // Check error messages are informative
      const anthropicStatus = statuses.get("anthropic");
      expect(anthropicStatus?.error).toContain("No API key");

      const openaiStatus = statuses.get("openai");
      expect(openaiStatus?.error).toContain("Health check failed");

      // Log detailed error information
      for (const [id, status] of statuses) {
        if (status.error) {
          console.log(`${id}: ${status.error}`);
        }
      }

      console.log("✅ Detailed error information provided");
    });
  });

  describe("model availability edge cases", () => {
    it("should handle model name variations", () => {
      const registry = new MockLlmProviderRegistry();
      registry.setProviderAvailable("anthropic", true);

      // Test both short and full model names
      const shortNameResult = registry.getModelInfo("claude-3-5-sonnet-20241022");
      const fullNameResult = registry.getModelInfo("anthropic/claude-3-5-sonnet-20241022");

      expect(shortNameResult.success).toBe(true);
      expect(fullNameResult.success).toBe(true);
      if (shortNameResult.success && fullNameResult.success) {
        expect(shortNameResult.info.fullModelId).toBe(fullNameResult.info.fullModelId);
      }

      console.log("✅ Model name variations handled correctly");
    });

    it("should handle provider-specific model availability", () => {
      const registry = new MockLlmProviderRegistry();

      // Only enable Anthropic
      registry.setProviderAvailable("anthropic", true);
      registry.setProviderAvailable("openai", false);
      registry.setProviderAvailable("google", false);

      const availableModels = registry.getAvailableModels();
      const anthropicModels = availableModels.filter((m) => m.startsWith("anthropic/"));
      const otherModels = availableModels.filter((m) => !m.startsWith("anthropic/"));

      expect(anthropicModels.length).toBeGreaterThan(0);
      expect(otherModels.length).toBe(0);

      // Test specific model availability
      expect(registry.isModelAvailable("claude-3-5-sonnet-20241022")).toBe(true);
      expect(registry.isModelAvailable("gpt-4o-mini")).toBe(false);
      expect(registry.isModelAvailable("gemini-1.5-flash")).toBe(false);

      console.log(
        `✅ Provider-specific availability: ${anthropicModels.length} Anthropic models, 0 others`,
      );
    });
  });

  describe("cost comparison scenarios", () => {
    it("should enable cost-based provider selection", () => {
      const registry = new MockLlmProviderRegistry();

      // Enable all providers
      registry.setProviderAvailable("anthropic", true);
      registry.setProviderAvailable("openai", true);
      registry.setProviderAvailable("google", true);

      // Test cost calculation for different providers
      const testTokens = { input: 10000, output: 2000 };

      const claudeCost = registry.calculateCost("claude-3-5-sonnet-20241022", {
        inputTokens: testTokens.input,
        outputTokens: testTokens.output,
      });
      const gptCost = registry.calculateCost("gpt-4o-mini", {
        inputTokens: testTokens.input,
        outputTokens: testTokens.output,
      });
      const geminiCost = registry.calculateCost("gemini-1.5-flash", {
        inputTokens: testTokens.input,
        outputTokens: testTokens.output,
      });

      const costs = [
        {
          provider: "Claude",
          cost: claudeCost,
          model: "claude-3-5-sonnet-20241022",
        },
        { provider: "GPT", cost: gptCost, model: "gpt-4o-mini" },
        { provider: "Gemini", cost: geminiCost, model: "gemini-1.5-flash" },
      ]
        .filter((c) => c.cost !== null)
        .sort((a, b) => (a.cost || 0) - (b.cost || 0));

      if (costs.length > 0) {
        console.log("Cost comparison for 10K input + 2K output tokens:");
        for (const { provider, cost, model } of costs) {
          if (cost !== null) {
            console.log(`  ${provider} (${model}): ${registry.formatCost(cost)}`);
          }
        }

        // Should be able to identify cheapest option
        const cheapest = costs[0];
        expect(cheapest.cost).toBeGreaterThan(0);
      }
    });

    it("should handle zero-cost models appropriately", () => {
      const registry = new MockLlmProviderRegistry();

      // Create a mock zero-cost model
      registry.addMockModel({
        providerId: "test",
        modelId: "free-model",
        name: "Free Test Model",
        fullModelId: "test/free-model",
        costPerMillionInput: 0,
        costPerMillionOutput: 0,
        maxContext: 10000,
        maxOutput: 1000,
        deprecated: false,
      });

      registry.setProviderAvailable("test", true);

      const cost = registry.calculateCost("free-model", {
        inputTokens: 1000,
        outputTokens: 500,
      });
      expect(cost).toBe(0);

      const formatted = registry.formatCost(0);
      expect(formatted).toBe("$0.0000");

      console.log("✅ Zero-cost models handled correctly");
    });
  });

  describe("real world provider combinations", () => {
    it("should demonstrate real provider discovery", async () => {
      // Test with whatever providers are actually available
      const registry = new LlmProviderRegistry({
        logger: mockLogger,
        performHealthCheckOnInit: false,
      });

      const statuses = registry.getProviderStatus();
      const availableCount = Array.from(statuses.values()).filter(
        (s) => s.status === "available",
      ).length;

      console.log(`Found ${availableCount} providers with API keys:`);
      for (const [id, status] of statuses) {
        if (status.status === "available") {
          console.log(`  ✅ ${id}: Available`);
          const models = registry.getModelsForProvider(id);
          console.log(`     Models: ${models.length}`);
        } else {
          console.log(`  ❌ ${id}: ${status.error}`);
        }
      }

      // Should handle both zero and multiple provider scenarios
      expect(availableCount).toBeGreaterThanOrEqual(0);

      // If providers are available, test model access (but health checks may fail with test keys)
      if (availableCount > 0) {
        const availableModels = registry.getAvailableModels();

        if (availableModels.length > 0) {
          // Test accessing first available model
          const firstModel = availableModels[0];
          const modelInfoResult = registry.getModelInfo(firstModel);
          expect(modelInfoResult.success).toBe(true);

          if (modelInfoResult.success) {
            const inputCost = modelInfoResult.info.cost?.input || 0;
            console.log(`First available model: ${firstModel} ($${inputCost}/M input tokens)`);
          }
        } else {
          console.log("No models available after health checks (likely due to test API keys)");
        }
      }
    });

    it("should handle mixed provider health states", async () => {
      // Only run if we have at least one real API key
      const hasAnyKey = PROVIDER_DEFINITIONS.some((def) => process.env[def.apiKeyEnvVar]);

      if (!hasAnyKey) {
        console.log("⚠️ Skipping mixed health test - no API keys available");
        return;
      }

      const registry = new LlmProviderRegistry({
        logger: mockLogger,
        healthCheckTimeout: 8000, // Longer timeout for real checks
      });

      // Perform actual health checks
      const statuses = await registry.performHealthChecks();

      let healthyCount = 0;
      let unhealthyCount = 0;
      let unavailableCount = 0;

      for (const [_id, status] of statuses) {
        if (status.status === "not-configured") {
          unavailableCount++;
        } else if (status.status === "available" && status.healthy) {
          healthyCount++;
        } else if (status.status === "available" && !status.healthy) {
          unhealthyCount++;
        } else if (status.status === "failed") {
          unhealthyCount++;
        }
      }

      console.log(
        `Health Check Results: ${healthyCount} healthy, ${unhealthyCount} unhealthy, ${unavailableCount} unavailable`,
      );

      // The system should handle any combination gracefully
      expect(healthyCount + unhealthyCount + unavailableCount).toBe(statuses.size);

      // If we have healthy providers, we should have available models
      if (healthyCount > 0) {
        const availableModels = registry.getAvailableModels();
        expect(availableModels.length).toBeGreaterThan(0);
      }
    }, 20000); // 20s timeout for multiple real health checks
  });

  describe("performance under provider failures", () => {
    it("should maintain performance with failing providers", async () => {
      const registry = new MockLlmProviderRegistry();

      // Mix of available and unavailable providers
      registry.setProviderAvailable("anthropic", true);
      registry.setProviderAvailable("openai", false);
      registry.setProviderAvailable("google", true);
      registry.setProviderHealth("anthropic", false); // Available but unhealthy

      const start = performance.now();

      // Perform many operations
      for (let i = 0; i < 100; i++) {
        registry.isModelAvailable("claude-3-5-sonnet-20241022"); // Should be false (unhealthy)
        registry.isModelAvailable("gpt-4o-mini"); // Should be false (unavailable)
        registry.isModelAvailable("gemini-1.5-flash"); // Should be true
        registry.getAvailableModels();
        registry.calculateCost("gemini-1.5-flash", {
          inputTokens: 1000,
          outputTokens: 500,
        });
      }

      const duration = performance.now() - start;

      console.log(`100 operations with mixed provider health took ${duration.toFixed(2)}ms`);

      // Should remain fast even with provider failures
      expect(duration).toBeLessThan(100);
    });
  });
});
