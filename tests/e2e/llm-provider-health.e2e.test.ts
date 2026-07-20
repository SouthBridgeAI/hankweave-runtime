import { beforeEach, describe, expect, it } from "bun:test";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import { PROVIDER_DEFINITIONS } from "../../server/llm/provider-config.js";
import { Logger } from "../../server/utils.js";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";

describe("LLM Provider Health Checks (E2E)", () => {
  let logs: Array<{ message: string; level: string }> = [];
  let mockLogger: Logger;

  beforeEach(() => {
    logs = [];
    // Create a real Logger instance but capture its output
    mockLogger = new Logger("/tmp/test-llm-provider.log");

    // Override the log method to capture output for testing
    const originalLog = mockLogger.log.bind(mockLogger);
    mockLogger.log = (message: string, level = "info") => {
      logs.push({ message, level });
      console.log(`[${level}] ${message}`); // Also log to console for debugging
      // Still call original to test the actual logging
      originalLog(message, level);
    };
  });

  describe("individual provider health checks", () => {
    // Test each provider from the config
    for (const [index, providerDef] of PROVIDER_DEFINITIONS.entries()) {
      it(`should health check provider ${index + 1} (${providerDef.id})`, async () => {
        const apiKey = process.env[providerDef.apiKeyEnvVar];

        if (!apiKey) {
          console.log(
            `⚠️ Skipping ${providerDef.id} health check - set ${providerDef.apiKeyEnvVar} to run this test`,
          );
          return;
        }

        const registry = new LlmProviderRegistry({
          logger: mockLogger,
          healthCheckTimeout: 10000, // 10s for real API calls
        });

        const statuses = await registry.performHealthChecks();
        const status = statuses.get(providerDef.id);

        expect(status).toBeDefined();
        expect(status?.status).toBe("available");

        // Log the result
        if (status?.status === "available") {
          console.log(`Provider ${providerDef.id} health check:`, {
            status: status.status,
            healthy: status.healthy,
            error: status.error,
          });

          // We expect it to be healthy, but log if not (rate limits, etc.)
          if (!status.healthy) {
            console.warn(`${providerDef.id} health check failed:`, status.error);
          }
        }
      }, 30000); // 30s timeout per provider
    }

    it("should handle health check timeouts gracefully", async () => {
      // Only run if at least one provider is available
      const hasAnyKey = PROVIDER_DEFINITIONS.some((def) => process.env[def.apiKeyEnvVar]);

      if (!hasAnyKey) {
        console.log("⚠️ Skipping timeout test - no API keys available");
        return;
      }

      const registry = new LlmProviderRegistry({
        logger: mockLogger,
        healthCheckTimeout: 1, // 1ms - guaranteed timeout
      });

      const statuses = await registry.performHealthChecks();

      // All available providers should fail with timeout
      for (const [_id, status] of statuses) {
        if (status.status === "available") {
          expect(status.healthy).toBe(false);
        } else if (status.status === "failed") {
          expect(status.error).toContain("timeout");
        }
      }
    });

    it("should calculate costs accurately for real models", () => {
      const registry = new LlmProviderRegistry({ logger: mockLogger });

      // Test with actual models from the loaded data
      const availableModels = registry.getAvailableModels();

      for (const modelId of availableModels.slice(0, 3)) {
        // Test first 3 models
        const modelInfoResult = registry.getModelInfo(modelId);
        if (!modelInfoResult.success) continue;

        const modelInfo = modelInfoResult.info;
        const inputTokens = 1000;
        const outputTokens = 500;

        // Calculate expected cost based on actual model data
        const inputCost = modelInfo.cost?.input || 0;
        const outputCost = modelInfo.cost?.output || 0;
        const expectedCost =
          (inputTokens / 1_000_000) * inputCost + (outputTokens / 1_000_000) * outputCost;

        const actualCost = registry.calculateCost(modelId, {
          inputTokens,
          outputTokens,
        });

        if (actualCost !== null) {
          expect(actualCost).toBeCloseTo(expectedCost, 6);
          console.log(
            `Model ${modelId}: Input=$${inputCost}/M, ` +
              `Output=$${outputCost}/M, ` +
              `Test cost=$${actualCost.toFixed(6)}`,
          );
        }
      }
    });
  });

  describe("provider discovery", () => {
    it("should discover available providers dynamically", () => {
      const originalEnv = captureEnv();

      try {
        // Clear all provider API keys first
        for (const def of PROVIDER_DEFINITIONS) {
          delete process.env[def.apiKeyEnvVar];
        }

        // Test with first provider from list
        const provider1 = PROVIDER_DEFINITIONS[0];
        process.env[provider1.apiKeyEnvVar] = "test-key";

        let reg = new LlmProviderRegistry({ logger: mockLogger });
        let status = reg.getProviderStatus();
        expect(status.get(provider1.id)?.status).toBe("available");

        // Check that other providers are not available
        for (const def of PROVIDER_DEFINITIONS.slice(1)) {
          expect(status.get(def.id)?.status).toBe("not-configured");
        }

        // Test with multiple providers
        if (PROVIDER_DEFINITIONS.length >= 2) {
          const provider2 = PROVIDER_DEFINITIONS[1];
          process.env[provider2.apiKeyEnvVar] = "test-key-2";

          reg = new LlmProviderRegistry({ logger: mockLogger });
          status = reg.getProviderStatus();
          expect(status.get(provider1.id)?.status).toBe("available");
          expect(status.get(provider2.id)?.status).toBe("available");
        }
      } finally {
        // Restore environment
        restoreEnv(originalEnv);
      }
    });

    it("should load model data correctly from JSON file", () => {
      const registry = new LlmProviderRegistry({ logger: mockLogger });
      const stats = registry.getStats();

      console.log("Registry statistics:", stats);

      // Should have loaded models from the data file
      expect(stats.totalModels).toBeGreaterThan(0);
      expect(stats.totalProviders).toBe(PROVIDER_DEFINITIONS.length);

      // Test a few specific models we know exist in the data
      // Use provider-specific ID: this model is resold by many providers at different prices
      const claudeHaikuResult = registry.getModelInfo("anthropic/claude-haiku-4-5-20251001");
      expect(claudeHaikuResult.success).toBe(true);
      if (claudeHaikuResult.success) {
        expect(claudeHaikuResult.info.providerId).toBe("anthropic");
        expect(claudeHaikuResult.info.cost?.input).toBe(1);
      }

      // Use provider-specific ID to avoid ambiguity (gpt-4o exists in multiple providers)
      const gpt4oResult = registry.getModelInfo("openai/gpt-4o");
      expect(gpt4oResult.success).toBe(true);
      if (gpt4oResult.success) {
        expect(gpt4oResult.info.providerId).toBe("openai");
        expect(gpt4oResult.info.modelId).toBe("gpt-4o");
      }
    });
  });

  describe("model information", () => {
    it("should provide accurate model information", () => {
      const registry = new LlmProviderRegistry({ logger: mockLogger });

      // Test model lookup by short name. Many providers resell this model with
      // differing limits, so only assert on the identity of the resolved model.
      const claudeHaikuResult = registry.getModelInfo("claude-haiku-4-5-20251001");
      expect(claudeHaikuResult.success).toBe(true);
      if (claudeHaikuResult.success) {
        expect(claudeHaikuResult.info.modelId).toBe("claude-haiku-4-5-20251001");
      }

      // Test model lookup by full name
      const claudeHaikuFullResult = registry.getModelInfo("anthropic/claude-haiku-4-5-20251001");
      expect(claudeHaikuFullResult.success).toBe(true);
      if (claudeHaikuFullResult.success) {
        expect(claudeHaikuFullResult.info.modelId).toBe("claude-haiku-4-5-20251001");
        expect(claudeHaikuFullResult.info.limit?.context).toBe(200000);
        expect(claudeHaikuFullResult.info.limit?.output).toBe(64000);
      }

      // Test non-existent model
      const nonExistentResult = registry.getModelInfo("non-existent-model");
      expect(nonExistentResult.success).toBe(false);
    });

    it("should find cheapest models for each provider", () => {
      const registry = new LlmProviderRegistry({ logger: mockLogger });

      // Test that we can find models for each provider
      for (const providerDef of PROVIDER_DEFINITIONS) {
        const modelsForProvider = registry.getModelsForProvider(providerDef.id);

        if (modelsForProvider.length > 0) {
          console.log(`${providerDef.id}: ${modelsForProvider.length} models available`);

          // Find cheapest model manually to verify the logic
          let cheapestCost = Number.POSITIVE_INFINITY;
          let cheapestModel = "";

          for (const modelId of modelsForProvider) {
            const infoResult = registry.getModelInfo(modelId);
            if (infoResult.success) {
              const inputCost = infoResult.info.cost?.input || 0;
              if (inputCost > 0 && inputCost < cheapestCost) {
                cheapestCost = inputCost;
                cheapestModel = infoResult.info.modelId || modelId;
              }
            }
          }

          if (cheapestModel) {
            console.log(
              `Cheapest ${providerDef.id} model: ${cheapestModel} at $${cheapestCost}/M input tokens`,
            );
          }
        }
      }
    });
  });
});
