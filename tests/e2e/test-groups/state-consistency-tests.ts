import { expect, test } from "bun:test";
import type { PhaseStartedEvent, StateSnapshotEvent } from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: any[];
  phase1Started: any;
  phase2Started: any;
  phase3Started: any;
}

export function runStateConsistencyTests(testState: TestState) {
  test("phase session IDs are consistent across all references", () => {
    // Map phase to all its session IDs found in different places
    const sessionIdMap = new Map<string, Set<string>>();

    // From phase started events
    testState.events.forEach((event) => {
      if (event.type === "phase.started") {
        const e = event as PhaseStartedEvent;
        const phaseId = e.data?.phaseId;
        const sessionId = e.data?.sessionId;
        if (phaseId && sessionId) {
          if (!sessionIdMap.has(phaseId)) sessionIdMap.set(phaseId, new Set());
          sessionIdMap.get(phaseId)!.add(sessionId);
        }
      }
    });

    // From completed phases in state snapshots
    const snapshots = testState.client?.getEventsByType("state.snapshot") || [];
    snapshots.forEach((event) => {
      const snapshot = event as StateSnapshotEvent;
      snapshot.data?.completedPhases?.forEach((phase) => {
        if (!sessionIdMap.has(phase.phaseId)) sessionIdMap.set(phase.phaseId, new Set());
        sessionIdMap.get(phase.phaseId)!.add(phase.sessionId);
      });
    });

    // Each phase should have exactly one session ID
    sessionIdMap.forEach((sessionIds, phaseId) => {
      expect(sessionIds.size).toBe(1);
    });
  });

  test("previousSessionId correctly chains phases", () => {
    // Phase 2 should reference Phase 1's session ID
    expect(testState.phase2Started?.data?.previousSessionId).toBe(
      testState.phase1Started?.data?.sessionId,
    );

    // Phase 3 should NOT reference Phase 2 (no continueFromPrevious)
    expect(testState.phase3Started?.data?.previousSessionId).toBeUndefined();
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
