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
  test("state snapshots carry only a {path, timestamp} pointer for recent file access", () => {
    const stateSnapshots = (testState.client?.getEventsByType("state.snapshot") ||
      []) as StateSnapshotEvent[];
    expect(stateSnapshots.length).toBeGreaterThan(0);

    // recentFileAccess is optional per-snapshot (only set while a codon with
    // watched files is active), but EVERY snapshot that has one must be a
    // pointer — no body in any form (fingerprint-events proposal). The
    // happy-path workload (the only suite running this group) watches files,
    // so at least one snapshot must actually carry the pointer.
    let snapshotsWithRecent = 0;
    for (const snapshot of stateSnapshots) {
      const recent = snapshot.data?.recentFileAccess;
      if (!recent) continue;
      snapshotsWithRecent++;
      expect(typeof recent.path).toBe("string");
      expect(recent.path.length).toBeGreaterThan(0);
      expect(recent.timestamp).toBeDefined();
      expect("content" in recent).toBe(false);
      expect("contentRef" in recent).toBe(false);
    }
    expect(snapshotsWithRecent).toBeGreaterThan(0);
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
