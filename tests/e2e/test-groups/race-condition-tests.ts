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
    // Get completed codons from final snapshot to check session continuation
    const finalSnapshot = [...testState.events].reverse().find((e) => e.type === "state.snapshot");

    if (!finalSnapshot || finalSnapshot.type !== "state.snapshot") {
      throw new Error("No final snapshot found");
    }

    const completedCodons = finalSnapshot.data.completedCodons;
    expect(completedCodons.length).toBeGreaterThanOrEqual(3);

    // Find codons by ID (not by array index, since they may not be in execution order)
    const codon1 = completedCodons.find((c) => c.codonId === "codon-1");
    const codon2 = completedCodons.find((c) => c.codonId === "codon-2");
    const codon3 = completedCodons.find((c) => c.codonId === "codon-3");

    // Ensure all codons exist
    expect(codon1).toBeDefined();
    expect(codon2).toBeDefined();
    expect(codon3).toBeDefined();

    // Codon 1 uses "fresh" continuation mode - should have its own session ID and NO previousSessionId
    expect(codon1?.claudeSessionId).toBeDefined();
    expect(codon1?.previousSessionId).toBeUndefined();

    // Codon 2 uses "continue-previous" continuation mode - should have:
    // - The SAME session ID as codon 1 (Claude Agent SDK reuses the session ID when continuing)
    // - A previousSessionId that matches codon 1's session ID (tracking the continuation)
    expect(codon2?.claudeSessionId).toBeDefined();
    expect(codon2?.previousSessionId).toBeDefined();
    if (codon1?.claudeSessionId) {
      expect(codon2?.previousSessionId).toBe(codon1?.claudeSessionId);
    }
    if (codon1?.claudeSessionId) {
      expect(codon2?.claudeSessionId).toBe(codon1?.claudeSessionId); // Same session, continuing
    }

    // Codon 3 uses "fresh" continuation mode - should have its own session ID and NO previousSessionId
    expect(codon3?.claudeSessionId).toBeDefined();
    expect(codon3?.previousSessionId).toBeUndefined();
    // Codon 3 should have a different session ID from the shared session of codons 1 and 2
    expect(codon3?.claudeSessionId).not.toBe(codon1?.claudeSessionId);

    // Additionally verify via codon.started events
    const codonStartedEvents = testState.events.filter((e) => e.type === "codon.started");
    expect(codonStartedEvents.length).toBeGreaterThanOrEqual(3);

    // Find events by codon ID
    const startedEvent1 = codonStartedEvents.find(
      (e) => e.type === "codon.started" && e.data.codonId === "codon-1",
    );
    const startedEvent2 = codonStartedEvents.find(
      (e) => e.type === "codon.started" && e.data.codonId === "codon-2",
    );
    const startedEvent3 = codonStartedEvents.find(
      (e) => e.type === "codon.started" && e.data.codonId === "codon-3",
    );

    if (startedEvent1?.type === "codon.started" && codon1?.claudeSessionId) {
      expect(startedEvent1.data.sessionId).toBe(codon1.claudeSessionId);
      expect(startedEvent1.data.previousSessionId).toBeUndefined();
    }

    if (
      startedEvent2?.type === "codon.started" &&
      codon2?.claudeSessionId &&
      codon1?.claudeSessionId
    ) {
      expect(startedEvent2.data.sessionId).toBe(codon2.claudeSessionId);
      expect(startedEvent2.data.previousSessionId).toBe(codon1.claudeSessionId);
    }

    if (startedEvent3?.type === "codon.started" && codon3?.claudeSessionId) {
      expect(startedEvent3.data.sessionId).toBe(codon3.claudeSessionId);
      expect(startedEvent3.data.previousSessionId).toBeUndefined();
    }
  });
}
