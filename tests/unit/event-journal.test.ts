import { beforeEach, describe, expect, it } from "bun:test";
import { EventJournal } from "../../server/event-journal.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { EventId } from "../../server/types/branded-types.js";

// Helper function to create mock events
function createMockEvent(id: string, timestamp?: string): ServerEvent {
  return {
    id: EventId(id),
    timestamp: timestamp || new Date().toISOString(),
    type: "pong",
    data: {
      message: `Test event ${id}`,
      timestamp: timestamp || new Date().toISOString(),
    },
  };
}

describe("EventJournal", () => {
  let journal: EventJournal;

  beforeEach(() => {
    // Create a new journal instance for each test
    journal = new EventJournal(100); // Small limit for testing
  });

  describe("constructor", () => {
    it("creates journal with default max events", () => {
      const defaultJournal = new EventJournal();
      expect(defaultJournal).toBeInstanceOf(EventJournal);
    });

    it("creates journal with custom max events", () => {
      const customJournal = new EventJournal(500);
      expect(customJournal).toBeInstanceOf(EventJournal);
    });
  });

  describe("append", () => {
    it("adds events to the journal", () => {
      const event1 = createMockEvent("event-1");
      const event2 = createMockEvent("event-2");

      journal.append(event1);
      journal.append(event2);

      const allEvents = journal.getAllEvents();
      expect(allEvents).toHaveLength(2);
      expect(allEvents[0]).toEqual(event1);
      expect(allEvents[1]).toEqual(event2);
    });

    it("trims old events when max limit is exceeded", () => {
      const smallJournal = new EventJournal(10);

      // Add more events than the limit
      for (let i = 1; i <= 15; i++) {
        smallJournal.append(createMockEvent(`event-${i}`));
      }

      const allEvents = smallJournal.getAllEvents();

      // Should trim 10% (1 event) when limit (10) is exceeded
      // So we should have 9 events remaining after first trim
      expect(allEvents.length).toBeLessThan(15);
      expect(allEvents.length).toBeGreaterThan(0);

      // The remaining events should be the most recent ones
      const lastEvent = allEvents[allEvents.length - 1];
      expect(lastEvent.id).toBe("event-15");
    });
  });

  describe("getAllEvents", () => {
    it("returns empty array when no events", () => {
      const allEvents = journal.getAllEvents();
      expect(allEvents).toEqual([]);
    });

    it("returns copy of all events", () => {
      const event1 = createMockEvent("event-1");
      const event2 = createMockEvent("event-2");

      journal.append(event1);
      journal.append(event2);

      const allEvents = journal.getAllEvents();
      expect(allEvents).toHaveLength(2);
      expect(allEvents[0]).toEqual(event1);
      expect(allEvents[1]).toEqual(event2);

      // Ensure it's a copy (mutations don't affect original)
      allEvents.push(createMockEvent("event-3"));
      expect(journal.getAllEvents()).toHaveLength(2);
    });
  });
});
