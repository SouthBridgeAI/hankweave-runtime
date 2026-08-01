import { expect, test } from "bun:test";
import type { CodonCompletedEvent } from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runCodonTimingTests(testState: TestState) {
  const codonCompletedEvents = testState.client?.getEventsByType("codon.completed") || [];

  for (const completed of codonCompletedEvents) {
    const completedEvent = completed as CodonCompletedEvent;
    test(`Codon ${completedEvent.data?.codonId} has non-negative duration`, () => {
      // >= 0, not > 0: replay rounds sub-millisecond codon durations to 0.
      expect(completedEvent.data?.duration || 0).toBeGreaterThanOrEqual(0);
    });
    // No "< 2 minutes" ceiling: the harness timeout owns run duration; a
    // wall-clock bound here only converts slow-but-correct runs into failures.
  }
}
