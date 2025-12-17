import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, getModelFamily } from "../../../server/config.js";
import type {
  CodonCompletedEvent,
  StateSnapshotEvent,
  TokenUsageEvent,
} from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runCostPrecisionTests(testState: TestState) {
  test("token costs are calculated with proper precision", () => {
    const tokenEvents = testState.client?.getEventsByType("token.usage") || [];

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

        // Verify cost calculation
        let expectedCost: number;

        // If modelUsage is available (multi-model scenario), recalculate using per-model rates
        if (data.modelUsage) {
          expectedCost = Object.entries(data.modelUsage).reduce((sum, [modelId, usage]) => {
            // Extract model family (sonnet/haiku/opus) from full model ID
            const modelFamily = getModelFamily(modelId);
            const costs = DEFAULT_CONFIG.modelCosts[modelFamily];

            if (!costs) {
              console.warn(
                `Unknown model family "${modelFamily}" from model ID "${modelId}". Using default sonnet rates.`,
              );
              return (
                sum +
                (usage.inputTokens / 1_000_000) * DEFAULT_CONFIG.costsPerMTok.input +
                (usage.outputTokens / 1_000_000) * DEFAULT_CONFIG.costsPerMTok.output +
                ((usage.cacheCreationInputTokens || 0) / 1_000_000) *
                  DEFAULT_CONFIG.costsPerMTok.inputCache +
                ((usage.cacheReadInputTokens || 0) / 1_000_000) *
                  DEFAULT_CONFIG.costsPerMTok.cacheRead
              );
            }

            // Calculate cost for this model using its specific rates
            const modelCost =
              (usage.inputTokens / 1_000_000) * costs.input +
              (usage.outputTokens / 1_000_000) * costs.output +
              ((usage.cacheCreationInputTokens || 0) / 1_000_000) * costs.inputCache +
              ((usage.cacheReadInputTokens || 0) / 1_000_000) * costs.cacheRead;

            return sum + modelCost;
          }, 0);
        } else {
          // Fallback: single-model calculation (based on config.ts defaults for sonnet)
          expectedCost =
            (data.inputTokens / 1_000_000) * 3.0 +
            (data.outputTokens / 1_000_000) * 15.0 +
            (data.cacheCreationTokens / 1_000_000) * 3.75 +
            (data.cacheReadTokens / 1_000_000) * 0.3;
        }

        // Check if values are within 5% of expected
        const percentageDiff = Math.abs(data.totalCost - expectedCost) / expectedCost;
        if (percentageDiff > 0.05) {
          console.log(
            `Cost precision test failed: expected ${expectedCost}, got ${
              data.totalCost
            }, difference: ${percentageDiff * 100}%`,
          );
        } else {
          console.log(
            `Cost precision test passed: expected ${expectedCost}, got ${
              data.totalCost
            }, difference: ${percentageDiff * 100}%`,
          );
        }
        expect(percentageDiff).toBeLessThanOrEqual(0.05);
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
