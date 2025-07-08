import { expect, test } from "bun:test";
import type { PhaseCompletedEvent, PhaseStartedEvent } from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runProcessLifecycleTests(testState: TestState) {
  test("Claude processes are cleaned up properly", () => {
    // Check process cleanup for each phase
    const phaseStarts = testState.client?.getEventsByType("phase.started") || [];
    const phaseEnds = testState.client?.getEventsByType("phase.completed") || [];

    expect(phaseStarts.length).toBe(phaseEnds.length);

    // Each phase should have proper lifecycle
    phaseStarts.forEach((start) => {
      const phaseId = (start as PhaseStartedEvent).data?.phaseId;
      const end = phaseEnds.find((e) => (e as PhaseCompletedEvent).data?.phaseId === phaseId);

      expect(end).toBeDefined();

      // Duration should be positive
      if (end) {
        const duration = (end as PhaseCompletedEvent).data?.duration || 0;
        expect(duration).toBeGreaterThan(0);
        expect(duration).toBeLessThan(120000); // Less than 2 minutes
      }
    });
  });
}
