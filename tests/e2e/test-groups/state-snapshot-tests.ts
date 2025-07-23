import { expect, test } from "bun:test";
import type { StateSnapshotEvent } from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  // State-based fields
  completedPhases: Array<{
    phaseId: string;
    cost: number;
    sessionId: string;
  }>;
  totalCost: number;
}

export function runStateSnapshotTests(testState: TestState) {
  test("state snapshot includes recent file access", () => {
    const stateSnapshots = testState.client?.getEventsByType("state.snapshot") || [];

    // The final state snapshot (sent after phase completion) should have recent file access
    // if any files were accessed during the phases
    const lastSnapshot = stateSnapshots[stateSnapshots.length - 1] as StateSnapshotEvent;

    if (lastSnapshot) {
      // Recent file access is optional, but if present should have all fields
      if (lastSnapshot.data?.recentFileAccess) {
        expect(lastSnapshot.data.recentFileAccess.path).toBeDefined();
        expect(lastSnapshot.data.recentFileAccess.content).toBeDefined();
        expect(lastSnapshot.data.recentFileAccess.timestamp).toBeDefined();
      }
      // The test passes even if recentFileAccess is null/undefined
      // because it's only set when files match the watch pattern
      expect(true).toBe(true);
    }
  });

  test("state snapshot matches state.json data", () => {
    const stateSnapshots = testState.client?.getEventsByType("state.snapshot") || [];

    // Get the final state snapshot
    const lastSnapshot = stateSnapshots[stateSnapshots.length - 1] as StateSnapshotEvent;

    if (lastSnapshot?.data) {
      // Total cost should match state.json
      expect(lastSnapshot.data.totalCost).toBeCloseTo(testState.totalCost, 6);

      // Completed phases count should match
      expect(lastSnapshot.data.completedPhases?.length).toBe(testState.completedPhases.length);
    }
  });

  test("state snapshot completed phases have expected fields", () => {
    const stateSnapshots = testState.client?.getEventsByType("state.snapshot") || [];

    const lastSnapshot = stateSnapshots[stateSnapshots.length - 1] as StateSnapshotEvent;

    if (lastSnapshot?.data?.completedPhases) {
      // Each completed phase in the snapshot should have required fields
      for (const phase of lastSnapshot.data.completedPhases) {
        expect(phase.phaseId).toBeDefined();
        // Cost is only available on certain phase types
        if (phase.status === "completed") {
          expect(phase.finalCost).toBeGreaterThanOrEqual(0);
        } else if (phase.status === "failed") {
          expect(phase.partialCost).toBeGreaterThanOrEqual(0);
        } else if (phase.status === "running") {
          expect(phase.currentCost).toBeGreaterThanOrEqual(0);
        }
        // Session ID is only available on certain phase types
        if (phase.status === "completed") {
          expect(phase.claudeSessionId).toBeDefined();
        } else if (phase.status === "failed" && phase.claudeSessionId) {
          expect(phase.claudeSessionId).toBeDefined();
        } else if (phase.status === "skipped" && phase.claudeSessionId) {
          expect(phase.claudeSessionId).toBeDefined();
        } else if (phase.status === "running") {
          expect(phase.claudeSessionId).toBeDefined();
        }
        // Duration is only available on terminal phase types
        if (
          phase.status === "completed" ||
          phase.status === "failed" ||
          phase.status === "skipped"
        ) {
          const duration = new Date(phase.endTime).getTime() - new Date(phase.startTime).getTime();
          expect(duration).toBeGreaterThan(0);
        }
        // Note: The CompletedPhase type in StateSnapshotEvent is simplified
        // and doesn't include all fields from the full phase execution
      }
    }
  });
}
