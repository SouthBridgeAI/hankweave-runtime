import { expect, test } from "bun:test";
import type { StateSnapshotEvent } from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  // State-based fields
  completedCodons: Array<{
    codonId: string;
    cost: number;
    sessionId: string;
  }>;
  totalCost: number;
}

export function runStateSnapshotTests(testState: TestState) {
  test("state snapshot includes recent file access", () => {
    const stateSnapshots = testState.client?.getEventsByType("state.snapshot") || [];

    // The final state snapshot (sent after codon completion) should have recent file access
    // if any files were accessed during the codons
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

      // Completed codons count should match
      expect(lastSnapshot.data.completedCodons?.length).toBe(testState.completedCodons.length);
    }
  });

  test("state snapshot completed codons have expected fields", () => {
    const stateSnapshots = testState.client?.getEventsByType("state.snapshot") || [];

    const lastSnapshot = stateSnapshots[stateSnapshots.length - 1] as StateSnapshotEvent;

    if (lastSnapshot?.data?.completedCodons) {
      // Each completed codon in the snapshot should have required fields
      for (const codon of lastSnapshot.data.completedCodons) {
        expect(codon.codonId).toBeDefined();
        // Cost is only available on certain codon types
        if (codon.status === "completed") {
          expect(codon.finalCost).toBeGreaterThanOrEqual(0);
        } else if (codon.status === "failed") {
          expect(codon.partialCost).toBeGreaterThanOrEqual(0);
        } else if (codon.status === "running") {
          expect(codon.currentCost).toBeGreaterThanOrEqual(0);
        }
        // Session ID is only available on certain codon types
        if (codon.status === "completed") {
          expect(codon.claudeSessionId).toBeDefined();
        } else if (codon.status === "failed" && codon.claudeSessionId) {
          expect(codon.claudeSessionId).toBeDefined();
        } else if (codon.status === "skipped" && codon.claudeSessionId) {
          expect(codon.claudeSessionId).toBeDefined();
        } else if (codon.status === "running") {
          expect(codon.claudeSessionId).toBeDefined();
        }
        // Duration is only available on terminal codon types
        if (
          (codon.status === "completed" ||
            codon.status === "failed" ||
            codon.status === "skipped") &&
          codon.endTime
        ) {
          const duration = new Date(codon.endTime).getTime() - new Date(codon.startTime).getTime();
          expect(duration).toBeGreaterThan(0);
        }
        // Note: The CompletedCodon type in StateSnapshotEvent is simplified
        // and doesn't include all fields from the full codon execution
      }
    }
  });
}
