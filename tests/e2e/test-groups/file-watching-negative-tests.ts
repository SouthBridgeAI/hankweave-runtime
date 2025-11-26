import { expect, test } from "bun:test";
import type {
  CodonCompletedEvent,
  CodonStartedEvent,
  FileUpdatedEvent,
  ServerEvent,
} from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
  codon1Started: CodonStartedEvent | null;
  codon1Completed: CodonCompletedEvent | null;
}

export function runFileWatchingNegativeTests(testState: TestState) {
  test("file events NOT sent for files outside watch patterns", () => {
    // Codon 1 watches *.txt but in notes/ directory
    // Any .txt files outside notes/ shouldn't trigger events during codon 1
    const codon1Events = testState.events.filter((e) => {
      const timestamp = new Date(e.timestamp).getTime();
      const codon1Start = new Date(testState.codon1Started?.timestamp || 0).getTime();
      const codon1End = new Date(testState.codon1Completed?.timestamp || 0).getTime();
      return timestamp >= codon1Start && timestamp <= codon1End;
    });

    const fileEvents = codon1Events.filter((e) => e.type === "file.updated");

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
