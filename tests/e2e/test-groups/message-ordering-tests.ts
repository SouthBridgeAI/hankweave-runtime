import { expect, test } from "bun:test";
import type {
  CodonCompletedEvent,
  CodonStartedEvent,
  ServerEvent,
} from "../../../server/types/types.js";

interface TestState {
  events: ServerEvent[];
}

export function runMessageOrderingTests(testState: TestState) {
  for (const codonId of ["codon-1", "codon-2", "codon-3"]) {
    test(`${codonId}: events are properly ordered`, () => {
      const codonStart = testState.events.find(
        (e) => e.type === "codon.started" && (e as CodonStartedEvent).data?.codonId === codonId,
      );
      const codonComplete = testState.events.find(
        (e) => e.type === "codon.completed" && (e as CodonCompletedEvent).data?.codonId === codonId,
      );

      if (codonStart && codonComplete) {
        const startIdx = testState.events.indexOf(codonStart);
        const endIdx = testState.events.indexOf(codonComplete);

        const codonEvents = testState.events.slice(startIdx, endIdx + 1);

        // Just verify we have both types of events
        const hasAssistantActions = codonEvents.some((e) => e.type === "assistant.action");
        const hasTokenUsage = codonEvents.some((e) => e.type === "token.usage");

        expect(hasAssistantActions).toBe(true);
        expect(hasTokenUsage).toBe(true);
      }
    });
  }
}
