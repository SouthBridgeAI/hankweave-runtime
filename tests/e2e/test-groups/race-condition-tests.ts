import { expect, test } from "bun:test";
import { CodonId } from "../../../server/types/branded-types.js";
import type {
  CodonCompletedEvent,
  CodonStartedEvent,
  ServerEvent,
} from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
  codon1Started: CodonStartedEvent | null;
  codon1Completed: CodonCompletedEvent | null;
}

export function runRaceConditionTests(testState: TestState) {
  test("no race conditions in codon completion handling", () => {
    // Look for signs of race conditions in event ordering
    const codonCompletions = testState.client?.getEventsByType("codon.completed") || [];
    const stateSnapshots = testState.client?.getEventsByType("state.snapshot") || [];

    codonCompletions.forEach((completion) => {
      if (completion.type === "codon.completed") {
        const completionTime = new Date(completion.timestamp).getTime();

        // Find the next state snapshot
        const nextSnapshot = stateSnapshots.find(
          (s) => new Date(s.timestamp).getTime() > completionTime,
        );

        if (nextSnapshot && nextSnapshot.type === "state.snapshot") {
          // The completed codon should be in the snapshot
          const codonId = completion.data.codonId;
          const inSnapshot = nextSnapshot.data.completedCodons.some((p) => p.codonId === codonId);
          expect(inSnapshot).toBe(true);

          // Current codon should be null or different
          expect(nextSnapshot.data.currentCodon?.codonId).not.toBe(codonId);
        }
      }
    });
  });

  test("rapid skip commands don't cause state corruption", () => {
    // In skip tests, check that rapid skips are handled properly
    if (testState.codon1Started && testState.codon1Completed) {
      const skipSentTime = testState.codon1Started.timestamp;
      const completionTime = testState.codon1Completed.timestamp;

      // Verify state is consistent even with quick skip
      const eventsInBetween = testState.events.filter((e) => {
        const t = e.timestamp;
        return t > skipSentTime && t < completionTime;
      });

      // Should not have conflicting state events
      const stateEvents = eventsInBetween.filter((e) => e.type === "state.snapshot");
      stateEvents.forEach((e) => {
        if (e.type === "state.snapshot") {
          // Current codon should still be codon-1 until completion
          if (e.data.currentCodon) {
            expect(e.data.currentCodon.codonId).toBe(CodonId("codon-1"));
          }
        }
      });
    }
  });

  test("rapid codon transitions maintain separate codonExecutionIds", () => {
    // Since state snapshots are only sent after codon completion (when currentCodon is null),
    // we need to look at codon.started events which contain the session IDs that prove
    // separate codon executions occurred
    const codonStartedEvents = testState.events.filter((e) => e.type === "codon.started");

    const sessionIds = new Set<string>();

    codonStartedEvents.forEach((event) => {
      if (event.type === "codon.started" && event.data.sessionId) {
        // Each session ID should be unique (proves separate codon executions)
        expect(sessionIds.has(event.data.sessionId)).toBe(false);
        sessionIds.add(event.data.sessionId);
      }
    });

    // Should have seen at least 3 different session IDs (one per codon)
    expect(sessionIds.size).toBeGreaterThanOrEqual(3);

    // Additionally verify that completed codons each have unique session IDs
    const finalSnapshot = [...testState.events].reverse().find((e) => e.type === "state.snapshot");

    if (finalSnapshot?.type === "state.snapshot" && finalSnapshot.data.completedCodons) {
      const completedSessionIds = new Set<string>();
      finalSnapshot.data.completedCodons.forEach((codon) => {
        if (codon.status === "completed" && codon.claudeSessionId) {
          expect(completedSessionIds.has(codon.claudeSessionId)).toBe(false);
          completedSessionIds.add(codon.claudeSessionId);
        } else if (codon.status === "failed" && codon.claudeSessionId) {
          expect(completedSessionIds.has(codon.claudeSessionId)).toBe(false);
          completedSessionIds.add(codon.claudeSessionId);
        } else if (codon.status === "skipped" && codon.claudeSessionId) {
          expect(completedSessionIds.has(codon.claudeSessionId)).toBe(false);
          completedSessionIds.add(codon.claudeSessionId);
        }
      });

      // Completed codons should also have unique session IDs
      expect(completedSessionIds.size).toBe(finalSnapshot.data.completedCodons.length);
    }
  });
}
