import { beforeEach, describe, expect, it } from "bun:test";
import { bundledCatalogSnapshot } from "../../server/llm/internal/catalog-store.js";
import { isProbeableProvider, probeProviderAccess } from "../../server/provider-probe.js";
import { PROVIDER_DEFINITIONS } from "../../server/sentinels/provider-config.js";
import { ProviderHealth } from "../../server/sentinels/provider-health.js";
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

        const registry = new ProviderHealth({
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

      const registry = new ProviderHealth({
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
      const registry = new ProviderHealth({ logger: mockLogger });

      // Test with actual models from the loaded data
      const models = [
        "anthropic/claude-haiku-4-5",
        "openai/gpt-4o-mini",
        "google/gemini-2.5-flash",
      ];

      for (const modelId of models) {
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
        // Clear all provider API keys first. amazon-bedrock's availability
        // also derives from the ambient AWS credential chain markers (not a
        // single apiKeyEnvVar), so clear those too — otherwise a developer
        // shell with AWS keys makes Bedrock "available" and the
        // not-configured assertions below fail.
        for (const def of PROVIDER_DEFINITIONS) {
          delete process.env[def.apiKeyEnvVar];
        }
        for (const awsVar of [
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
          "AWS_SESSION_TOKEN",
          "AWS_BEARER_TOKEN_BEDROCK",
          "AWS_PROFILE",
        ]) {
          delete process.env[awsVar];
        }

        // Test with first provider from list
        const provider1 = PROVIDER_DEFINITIONS[0];
        process.env[provider1.apiKeyEnvVar] = "test-key";

        let reg = new ProviderHealth({ logger: mockLogger });
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

          reg = new ProviderHealth({ logger: mockLogger });
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
      const registry = new ProviderHealth({ logger: mockLogger });

      // Should have loaded models from the data file, and a status per provider
      expect(bundledCatalogSnapshot().rows.length).toBeGreaterThan(0);
      expect(registry.getProviderStatus().size).toBe(PROVIDER_DEFINITIONS.length);

      // Test a few specific models we know exist in the data
      const claudeHaikuResult = registry.getModelInfo("anthropic/claude-haiku-4-5-20251001");
      expect(claudeHaikuResult.success).toBe(true);
      if (claudeHaikuResult.success) {
        expect(claudeHaikuResult.info.providerId).toBe("anthropic");
        expect(claudeHaikuResult.info.cost?.input).toBe(1);
      }

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
      const registry = new ProviderHealth({ logger: mockLogger });

      // A bare model id doesn't resolve: sentinel models are "provider/model"
      const claudeHaikuResult = registry.getModelInfo("claude-haiku-4-5-20251001");
      expect(claudeHaikuResult.success).toBe(false);

      // Test model lookup by full name
      const claudeHaikuFullResult = registry.getModelInfo("anthropic/claude-haiku-4-5-20251001");
      expect(claudeHaikuFullResult.success).toBe(true);
      if (claudeHaikuFullResult.success) {
        expect(claudeHaikuFullResult.info.modelId).toBe("claude-haiku-4-5-20251001");
        expect(claudeHaikuFullResult.info.limit?.context).toBe(200000);
        expect(claudeHaikuFullResult.info.limit?.output).toBe(64000);
      }

      // Test non-existent model
      const nonExistentResult = registry.getModelInfo("anthropic/non-existent-model");
      expect(nonExistentResult.success).toBe(false);
    });

    it("should find cheapest models for each provider", () => {
      const registry = new ProviderHealth({ logger: mockLogger });
      const rows = bundledCatalogSnapshot().rows;

      // Test that we can find models for each provider
      for (const providerDef of PROVIDER_DEFINITIONS) {
        const modelsForProvider = rows
          .filter((row) => row.providerId === providerDef.id)
          .map((row) => `${row.providerId}/${row.modelId}`);

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

  // A health check that lists models proves the key works only while the
  // provider refuses its list to a request without one. These need no keys:
  // they send hankweave's own health-check request with an empty key and a
  // made-up one, and require an authentication rejection. Anything else —
  // a 200 (the list went public), a 404 (the endpoint moved), a timeout — is
  // a change the health check has to follow.
  describe("model lists that health checks rely on refuse invalid keys", () => {
    const listed = PROVIDER_DEFINITIONS.filter((def) => isProbeableProvider(def.id));
    const invalidKeys = {
      "an empty key": "",
      "a made-up key": "hankweave-health-check-test-not-a-real-key",
    };
    const authRejections = [400, 401, 403];

    for (const def of listed) {
      it(`${def.id} refuses its model list without a valid key`, async () => {
        for (const [label, key] of Object.entries(invalidKeys)) {
          const access = await probeProviderAccess(def.id, key, { timeoutMs: 15_000 });
          expect(
            access.ok,
            `${def.id} served its model list to ${label}. Its health check (a model-list call, ` +
              "server/provider-probe.ts) now passes with any key; health-check it by " +
              "generation instead (checkByGeneration in server/sentinels/provider-health.ts).",
          ).toBe(false);
          if (!access.ok) {
            // No status means the provider never answered (network error, timeout).
            expect(
              access.status !== undefined && authRejections.includes(access.status),
              `${def.id} answered ${label} with something other than an authentication ` +
                `rejection (${access.reason}). Either the provider is down or the health check's ` +
                "request is out of date.",
            ).toBe(true);
          }
        }
      }, 60_000);
    }
  });
});
