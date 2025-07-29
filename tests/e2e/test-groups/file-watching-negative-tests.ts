import { expect, test } from "bun:test";
import type {
  FileUpdatedEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
} from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
  phase1Started: PhaseStartedEvent | null;
  phase1Completed: PhaseCompletedEvent | null;
}

export function runFileWatchingNegativeTests(testState: TestState) {
  test("file events NOT sent for files outside watch patterns", () => {
    // Phase 1 watches *.txt but in notes/ directory
    // Any .txt files outside notes/ shouldn't trigger events during phase 1
    const phase1Events = testState.events.filter((e) => {
      const timestamp = new Date(e.timestamp).getTime();
      const phase1Start = new Date(testState.phase1Started?.timestamp || 0).getTime();
      const phase1End = new Date(testState.phase1Completed?.timestamp || 0).getTime();
      return timestamp >= phase1Start && timestamp <= phase1End;
    });

    const fileEvents = phase1Events.filter((e) => e.type === "file.updated");

    // All file events should be in notes/ directory
    fileEvents.forEach((event) => {
      const fileEvent = event as FileUpdatedEvent;
      expect(fileEvent.data?.path).toMatch(/^(\.\/)?notes\//);
    });
  });

  test("directory creation events are properly handled", () => {
    // Check for directory-related events
    const fileEvents = testState.client?.getEventsByType("file.updated") || [];

    // We shouldn't get file events for directory creation
    const dirEvents = fileEvents.filter((e) => {
      const event = e as FileUpdatedEvent;
      return (
        event.data?.path?.endsWith("/") ||
        event.data?.filename === "notes" ||
        event.data?.filename === "typescript_code"
      );
    });

    expect(dirEvents.length).toBe(0);
  });
}
