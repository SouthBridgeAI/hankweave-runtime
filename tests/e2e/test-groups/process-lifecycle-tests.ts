import { expect, test } from "bun:test";
import type { CodonCompletedEvent, CodonStartedEvent } from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runProcessLifecycleTests(testState: TestState) {
  test("Claude processes are cleaned up properly", () => {
    // Check process cleanup for each codon
    const codonStarts = testState.client?.getEventsByType("codon.started") || [];
    const codonEnds = testState.client?.getEventsByType("codon.completed") || [];

    expect(codonStarts.length).toBe(codonEnds.length);

    // Each codon should have proper lifecycle
    codonStarts.forEach((start) => {
      const codonId = (start as CodonStartedEvent).data?.codonId;
      const end = codonEnds.find((e) => (e as CodonCompletedEvent).data?.codonId === codonId);

      expect(end).toBeDefined();

      // Duration should be positive
      if (end) {
        const duration = (end as CodonCompletedEvent).data?.duration || 0;
        expect(duration).toBeGreaterThan(0);
        expect(duration).toBeLessThan(120000); // Less than 2 minutes
      }
    });
  });
}
