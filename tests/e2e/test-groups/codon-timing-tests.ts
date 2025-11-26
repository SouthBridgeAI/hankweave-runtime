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
    test(`Codon ${completedEvent.data?.codonId} has positive duration`, () => {
      expect(completedEvent.data?.duration || 0).toBeGreaterThan(0);
    });

    test(`Codon ${completedEvent.data?.codonId} completed within 2 minutes`, () => {
      expect(completedEvent.data?.duration || 0).toBeLessThan(120000);
    });
  }
}
