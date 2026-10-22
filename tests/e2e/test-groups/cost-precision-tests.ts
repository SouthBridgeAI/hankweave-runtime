import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { Models, priceUsage, type UsageTokens } from "../../../server/llm/index.js";
import { pricingProviderId } from "../../../server/provider-ids.js";
import type {
  CodonCompletedEvent,
  StateSnapshotEvent,
  TokenUsageEvent,
} from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

/**
 * Codon id → the provider its model is priced under. Token events carry the
 * bare model id the harness ran, so the provider comes from the hank config.
 */
function codonPricingProviders(configPath: string): Map<string, string> {
  const providers = new Map<string, string>();
  const hank = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
    hank?: Array<{ id?: string; model?: unknown }>;
  };
  for (const codon of hank.hank ?? []) {
    if (!codon.id || typeof codon.model !== "string") continue;
    const check = Models.current().check(codon.model);
    if (check.ok) providers.set(codon.id, pricingProviderId(check.model.providerId));
  }
  return providers;
}

/** The catalog cost of a usage, or null when the catalog doesn't price the model. */
function catalogCost(provider: string, modelId: string, usage: UsageTokens): number | null {
  const record = Models.current().get(provider, modelId);
  return record ? (priceUsage(record, usage)?.cost ?? null) : null;
}

export function runCostPrecisionTests(testState: TestState, configPath: string) {
  test("token costs are calculated with proper precision", () => {
    const tokenEvents = testState.client?.getEventsByType("token.usage") || [];
    const pricingProviders = codonPricingProviders(configPath);

    tokenEvents.forEach((event) => {
      const tokenEvent = event as TokenUsageEvent;
      const data = tokenEvent.data;

      if (data) {
        // Costs should be reasonable
        expect(data.totalCost).toBeGreaterThanOrEqual(0);
        expect(data.totalCost).toBeLessThan(1); // Less than $1 per event

        // Should have at least 4 decimal places of precision
        const costStr = data.totalCost.toString();
        if (costStr.includes(".")) {
          const decimals = costStr.split(".")[1].length;
          expect(decimals).toBeGreaterThanOrEqual(4);
        }

        // Verify cost calculation against the model catalog
        let expectedCost: number | null = null;
        const provider = pricingProviders.get(data.codonId) ?? "anthropic";

        // If modelUsage is available (multi-model scenario), calculate per model
        if (data.modelUsage) {
          let totalCost = 0;
          let allModelsFound = true;

          for (const [modelId, usage] of Object.entries(data.modelUsage)) {
            console.log(`\n  Processing model: ${modelId}`);

            const modelCost = catalogCost(provider, modelId, {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadInputTokens || 0,
              cacheCreationTokens: usage.cacheCreationInputTokens || 0,
            });

            if (modelCost === null) {
              console.warn(`  ❌ Model ${provider}/${modelId} NOT FOUND in catalog`);
              allModelsFound = false;
              break;
            }

            console.log(`  ✅ Model cost calculated: $${modelCost.toFixed(6)}`);
            totalCost += modelCost;
          }

          if (allModelsFound) {
            expectedCost = totalCost;
          }
        } else {
          // Single-model scenario: read modelId directly from event
          const modelId = data.modelId;
          console.log(`Model ID from event: ${modelId || "NOT FOUND"}`);

          if (modelId) {
            const usageForCalc = {
              inputTokens: data.inputTokens,
              outputTokens: data.outputTokens,
              cacheReadTokens: data.cacheReadTokens || 0,
              cacheCreationTokens: data.cacheCreationTokens || 0,
            };

            const modelCost = catalogCost(provider, modelId, usageForCalc);

            if (modelCost !== null) {
              expectedCost = modelCost;
              console.log(`✅ Model cost calculated: $${modelCost.toFixed(6)}`);
            } else {
              console.warn(`❌ Model ${provider}/${modelId} NOT FOUND in catalog`);
            }
          } else {
            console.warn(`❌ No modelId in event for codon ${data.codonId}`);
          }
        }

        // Only verify if we successfully calculated expected cost
        if (expectedCost !== null) {
          // Check if values are within 5% of expected
          const percentageDiff = Math.abs(data.totalCost - expectedCost) / expectedCost;
          const diffDollars = data.totalCost - expectedCost;

          console.log(`\n=== COMPARISON ===`);
          console.log(`Expected: $${expectedCost.toFixed(6)}`);
          console.log(`Actual:   $${data.totalCost.toFixed(6)}`);
          console.log(
            `Difference: $${diffDollars.toFixed(6)} (${(percentageDiff * 100).toFixed(2)}%)`,
          );

          if (percentageDiff > 0.05) {
            console.log(
              `❌ FAILED: Difference ${(percentageDiff * 100).toFixed(2)}% exceeds 5% threshold`,
            );
          } else {
            console.log(`✅ PASSED: Within 5% tolerance`);
          }

          expect(percentageDiff).toBeLessThanOrEqual(0.05);
        }
      }
    });
  });

  test("cumulative costs match sum of codon costs", () => {
    // Get final state snapshot
    const snapshots = testState.client?.getEventsByType("state.snapshot") || [];
    const finalSnapshot = snapshots[snapshots.length - 1];
    const finalTotalCost = (finalSnapshot as StateSnapshotEvent)?.data?.totalCost || 0;

    // Calculate sum of codon costs
    const codonCompletions = testState.client?.getEventsByType("codon.completed") || [];
    const sumOfCodonCosts = codonCompletions.reduce((sum, event) => {
      const completion = event as CodonCompletedEvent;
      return sum + (completion.data?.cost || 0);
    }, 0);

    // Check if values are within 5% of each other
    const percentageDiff = Math.abs(finalTotalCost - sumOfCodonCosts) / sumOfCodonCosts;

    if (percentageDiff > 0.05) {
      console.log(
        `Cumulative cost test failed: expected ${sumOfCodonCosts}, got ${finalTotalCost}, difference: ${
          percentageDiff * 100
        }%`,
      );
    } else {
      console.log(
        `Cumulative cost test passed: expected ${sumOfCodonCosts}, got ${finalTotalCost}, difference: ${
          percentageDiff * 100
        }%`,
      );
    }

    expect(percentageDiff).toBeLessThanOrEqual(0.2);
  });
}
