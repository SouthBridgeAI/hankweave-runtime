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

  test("rapid phase transitions maintain separate phaseExecutionIds", () => {
    // Since state snapshots are only sent after phase completion (when currentPhase is null),
    // we need to look at phase.started events which contain the session IDs that prove
    // separate phase executions occurred
    const phaseStartedEvents = testState.events.filter(
      (e) => e.type === "phase.started",
    ) as PhaseStartedEvent[];

    const sessionIds = new Set<string>();

    phaseStartedEvents.forEach((event) => {
      if (event.data?.sessionId) {
        // Each session ID should be unique (proves separate phase executions)
        expect(sessionIds.has(event.data.sessionId)).toBe(false);
        sessionIds.add(event.data.sessionId);
      }
    });

    // Should have seen at least 3 different session IDs (one per phase)
    expect(sessionIds.size).toBeGreaterThanOrEqual(3);

    // Additionally verify that completed phases each have unique session IDs
    const finalSnapshot = [...testState.events]
      .reverse()
      .find((e) => e.type === "state.snapshot") as StateSnapshotEvent | undefined;

    if (finalSnapshot?.data?.completedPhases) {
      const completedSessionIds = new Set<string>();
      finalSnapshot.data.completedPhases.forEach((phase) => {
        expect(completedSessionIds.has(phase.sessionId)).toBe(false);
        completedSessionIds.add(phase.sessionId);
      });

      // Completed phases should also have unique session IDs
      expect(completedSessionIds.size).toBe(finalSnapshot.data.completedPhases.length);
    }
  });
}
