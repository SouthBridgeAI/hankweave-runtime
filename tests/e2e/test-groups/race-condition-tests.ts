import { expect, test } from "bun:test";
import type {
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
  StateSnapshotEvent,
} from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
  phase1Started: PhaseStartedEvent | null;
  phase1Completed: PhaseCompletedEvent | null;
}

export function runRaceConditionTests(testState: TestState) {
  test("no race conditions in phase completion handling", () => {
    // Look for signs of race conditions in event ordering
    const phaseCompletions = testState.client?.getEventsByType("phase.completed") || [];
    const stateSnapshots = testState.client?.getEventsByType("state.snapshot") || [];

    phaseCompletions.forEach((completion) => {
      const completionTime = new Date(completion.timestamp).getTime();

      // Find the next state snapshot
      const nextSnapshot = stateSnapshots.find(
        (s) => new Date(s.timestamp).getTime() > completionTime,
      ) as StateSnapshotEvent;

      if (nextSnapshot) {
        // The completed phase should be in the snapshot
        const phaseId = (completion as PhaseCompletedEvent).data?.phaseId;
        const inSnapshot = nextSnapshot.data?.completedPhases?.some((p) => p.phaseId === phaseId);
        expect(inSnapshot).toBe(true);

        // Current phase should be null or different
        expect(nextSnapshot.data?.currentPhase?.phase.id).not.toBe(phaseId);
      }
    });
  });

  test("rapid skip commands don't cause state corruption", () => {
    // In skip tests, check that rapid skips are handled properly
    if (testState.phase1Started && testState.phase1Completed) {
      const skipSentTime = testState.phase1Started.timestamp;
      const completionTime = testState.phase1Completed.timestamp;

      // Verify state is consistent even with quick skip
      const eventsInBetween = testState.events.filter((e) => {
        const t = e.timestamp;
        return t > skipSentTime && t < completionTime;
      });

      // Should not have conflicting state events
      const stateEvents = eventsInBetween.filter((e) => e.type === "state.snapshot");
      stateEvents.forEach((e) => {
        const snapshot = e as StateSnapshotEvent;
        // Current phase should still be phase-1 until completion
        if (snapshot.data?.currentPhase) {
          expect(snapshot.data.currentPhase.phase.id).toBe("phase-1");
        }
      });
    }
  });
}
