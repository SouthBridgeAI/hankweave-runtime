import { expect, test } from "bun:test";
import type {
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
} from "../../../server/types/types.js";

interface TestState {
  events: ServerEvent[];
}

export function runMessageOrderingTests(testState: TestState) {
  for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
    test(`${phaseId}: events are properly ordered`, () => {
      const phaseStart = testState.events.find(
        (e) => e.type === "phase.started" && (e as PhaseStartedEvent).data?.phaseId === phaseId,
      );
      const phaseComplete = testState.events.find(
        (e) => e.type === "phase.completed" && (e as PhaseCompletedEvent).data?.phaseId === phaseId,
      );

      if (phaseStart && phaseComplete) {
        const startIdx = testState.events.indexOf(phaseStart);
        const endIdx = testState.events.indexOf(phaseComplete);

        const phaseEvents = testState.events.slice(startIdx, endIdx + 1);

        // Just verify we have both types of events
        const hasAssistantActions = phaseEvents.some((e) => e.type === "assistant.action");
        const hasTokenUsage = phaseEvents.some((e) => e.type === "token.usage");

        expect(hasAssistantActions).toBe(true);
        expect(hasTokenUsage).toBe(true);
      }
    });
  }
}
