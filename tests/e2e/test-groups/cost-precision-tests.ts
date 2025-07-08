import { expect, test } from "bun:test";
import type { PhaseCompletedEvent, TokenUsageEvent } from "../../../server/types.js";
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

        // Verify cost calculation (based on config.ts defaults)
        const expectedCost =
          (data.inputTokens / 1_000_000) * 3.0 +
          (data.outputTokens / 1_000_000) * 15.0 +
          (data.cacheCreationTokens / 1_000_000) * 3.75 +
          (data.cacheReadTokens / 1_000_000) * 0.3;

        expect(data.totalCost).toBeCloseTo(expectedCost, 6);
      }
    });
  });

  test("cumulative costs match sum of phase costs", () => {
    // Get final state snapshot
    const snapshots = testState.client?.getEventsByType("state.snapshot") || [];
    const finalSnapshot = snapshots[snapshots.length - 1];
    const finalTotalCost = (finalSnapshot as any)?.data?.totalCost || 0;

    // Calculate sum of phase costs
    const phaseCompletions = testState.client?.getEventsByType("phase.completed") || [];
    const sumOfPhaseCosts = phaseCompletions.reduce((sum, event) => {
      const completion = event as PhaseCompletedEvent;
      return sum + (completion.data?.cost || 0);
    }, 0);

    expect(finalTotalCost).toBeCloseTo(sumOfPhaseCosts, 6);
  });
}
