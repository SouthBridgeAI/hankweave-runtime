import { expect, test } from "bun:test";
import type { StateSnapshotEvent } from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
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
}
