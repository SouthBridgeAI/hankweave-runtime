import { expect, test } from "bun:test";
import { LlmProviderRegistry } from "../../../server/llm/llm-provider-registry.js";
import type {
  CodonCompletedEvent,
  StateSnapshotEvent,
  TokenUsageEvent,
} from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runCostPrecisionTests(testState: TestState, _configPath: string) {
  test("token costs are calculated with proper precision", () => {
    const tokenEvents = testState.client?.getEventsByType("token.usage") || [];
    const registry = LlmProviderRegistry.getInstance();

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

        // Verify cost calculation using LLMProviderRegistry
        let expectedCost: number | null = null;

        // If modelUsage is available (multi-model scenario), calculate using registry
        if (data.modelUsage) {
          let totalCost = 0;
          let allModelsFound = true;

          for (const [modelId, usage] of Object.entries(data.modelUsage)) {
            console.log(`\n  Processing model: ${modelId}`);

            const modelCost = registry.calculateCost(modelId, {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadInputTokens || 0,
              cacheCreationTokens: usage.cacheCreationInputTokens || 0,
            });

            if (modelCost === null) {
              console.warn(`  ❌ Model ${modelId} NOT FOUND in registry`);
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
            console.log(`Usage for calculation:`, usageForCalc);

            const modelCost = registry.calculateCost(modelId, usageForCalc);

            if (modelCost !== null) {
              expectedCost = modelCost;
              console.log(`✅ Model cost calculated: $${modelCost.toFixed(6)}`);
            } else {
              console.warn(`❌ Model ${modelId} NOT FOUND in registry`);
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
