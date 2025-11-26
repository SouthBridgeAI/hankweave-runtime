import { expect, test } from "bun:test";
import type {
  CodonStartedEvent,
  ServerEvent,
  StateSnapshotEvent,
} from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
  codon1Started: CodonStartedEvent | null;
  codon2Started: CodonStartedEvent | null;
  codon3Started: CodonStartedEvent | null;
}

export function runStateConsistencyTests(testState: TestState) {
  test("codon session IDs are consistent across all references", () => {
    // Map codon to all its session IDs found in different places
    const sessionIdMap = new Map<string, Set<string>>();

    // From codon started events
    testState.events.forEach((event) => {
      if (event.type === "codon.started") {
        const e = event as CodonStartedEvent;
        const codonId = e.data?.codonId;
        const sessionId = e.data?.sessionId;
        if (codonId && sessionId) {
          if (!sessionIdMap.has(codonId)) sessionIdMap.set(codonId, new Set());
          sessionIdMap.get(codonId)?.add(sessionId);
        }
      }
    });

    // From completed codons in state snapshots
    const snapshots = testState.client?.getEventsByType("state.snapshot") || [];
    snapshots.forEach((event) => {
      const snapshot = event as StateSnapshotEvent;
      snapshot.data?.completedCodons?.forEach((codon) => {
        if (!sessionIdMap.has(codon.codonId)) sessionIdMap.set(codon.codonId, new Set());
        if (codon.status === "completed" && codon.claudeSessionId) {
          sessionIdMap.get(codon.codonId)?.add(codon.claudeSessionId);
        } else if (codon.status === "failed" && codon.claudeSessionId) {
          sessionIdMap.get(codon.codonId)?.add(codon.claudeSessionId);
        } else if (codon.status === "skipped" && codon.claudeSessionId) {
          sessionIdMap.get(codon.codonId)?.add(codon.claudeSessionId);
        } else if (codon.status === "running" && codon.claudeSessionId) {
          sessionIdMap.get(codon.codonId)?.add(codon.claudeSessionId);
        }
      });
    });

    // Each codon should have exactly one session ID
    sessionIdMap.forEach((sessionIds, _codonId) => {
      expect(sessionIds.size).toBe(1);
    });
  });

  test("previousSessionId correctly chains codons", () => {
    // Codon 2 should reference Codon 1's session ID
    if (testState.codon2Started && testState.codon1Started) {
      expect(testState.codon2Started.data?.previousSessionId).toBe(
        testState.codon1Started.data?.sessionId,
      );
    }

    // Codon 3 should NOT reference Codon 2 (no continueFromPrevious)
    if (testState.codon3Started) {
      expect(testState.codon3Started.data?.previousSessionId).toBeUndefined();
    }
  });

  test("cumulative costs are properly tracked", () => {
    // Get all state snapshots in order
    const snapshots =
      testState.client
        ?.getEventsByType("state.snapshot")
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()) || [];

    let lastTotalCost = 0;
    snapshots.forEach((snapshot) => {
      const s = snapshot as StateSnapshotEvent;
      const totalCost = s.data?.totalCost || 0;

      // Total cost should never decrease
      expect(totalCost).toBeGreaterThanOrEqual(lastTotalCost);
      lastTotalCost = totalCost;
    });
  });
}
