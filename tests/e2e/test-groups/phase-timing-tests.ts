import { expect, test } from "bun:test";
import type { PhaseCompletedEvent } from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runPhaseTimingTests(testState: TestState) {
  const phaseCompletedEvents = testState.client?.getEventsByType("phase.completed") || [];

  for (const completed of phaseCompletedEvents) {
    const completedEvent = completed as PhaseCompletedEvent;
    test(`Phase ${completedEvent.data?.phaseId} has positive duration`, () => {
      expect(completedEvent.data?.duration || 0).toBeGreaterThan(0);
    });

    test(`Phase ${completedEvent.data?.phaseId} completed within 2 minutes`, () => {
      expect(completedEvent.data?.duration || 0).toBeLessThan(120000);
    });
  }
}
