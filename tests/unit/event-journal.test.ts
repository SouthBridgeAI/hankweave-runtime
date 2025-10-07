import { beforeEach, describe, expect, it } from "bun:test";
import { EventJournal } from "../../server/event-journal.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { MemoryEventStorage } from "../../server/storage/memory-event-storage.js";
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

  beforeEach(async () => {
    // Create a new journal instance for each test with memory storage
    const storage = new MemoryEventStorage(100); // Small limit for testing
    journal = new EventJournal(storage);
    await journal.initialize();
  });

  describe("constructor", () => {
    it("creates journal with default max events", () => {
      const defaultJournal = new EventJournal();
      expect(defaultJournal).toBeInstanceOf(EventJournal);
    });

    it("creates journal with custom storage", () => {
      const customStorage = new MemoryEventStorage(500);
      const customJournal = new EventJournal(customStorage);
      expect(customJournal).toBeInstanceOf(EventJournal);
    });
  });

  describe("append", () => {
    it("adds events to the journal", async () => {
      const event1 = createMockEvent("event-1");
      const event2 = createMockEvent("event-2");

      await journal.append(event1);
      await journal.append(event2);

      const allEvents = await journal.getAllEvents();
      expect(allEvents).toHaveLength(2);
      expect(allEvents[0]).toEqual(event1);
      expect(allEvents[1]).toEqual(event2);
    });

    it("trims old events when max limit is exceeded", async () => {
      const smallStorage = new MemoryEventStorage(10);
      const smallJournal = new EventJournal(smallStorage);
      await smallJournal.initialize();

      // Add more events than the limit
      for (let i = 1; i <= 15; i++) {
        await smallJournal.append(createMockEvent(`event-${i}`));
      }

      const allEvents = await smallJournal.getAllEvents();

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
    it("returns empty array when no events", async () => {
      const allEvents = await journal.getAllEvents();
      expect(allEvents).toEqual([]);
    });

    it("returns copy of all events", async () => {
      const event1 = createMockEvent("event-1");
      const event2 = createMockEvent("event-2");

      await journal.append(event1);
      await journal.append(event2);

      const allEvents = await journal.getAllEvents();
      expect(allEvents).toHaveLength(2);
      expect(allEvents[0]).toEqual(event1);
      expect(allEvents[1]).toEqual(event2);

      // Ensure it's a copy (mutations don't affect original)
      allEvents.push(createMockEvent("event-3"));
      expect((await journal.getAllEvents()).length).toBe(2);
    });
  });

  describe("getTotalEvents", () => {
    it("returns 0 for empty journal", async () => {
      expect(await journal.getTotalEvents()).toBe(0);
    });

    it("returns correct count of events", async () => {
      await journal.append(createMockEvent("event-1"));
      await journal.append(createMockEvent("event-2"));
      await journal.append(createMockEvent("event-3"));

      expect(await journal.getTotalEvents()).toBe(3);
    });
  });

  describe("getMostRecentEvents", () => {
    it("returns empty array for empty journal", async () => {
      const result = await journal.getMostRecentEvents(10);

      expect(result.events).toEqual([]);
      expect(result.cursor).toBeNull();
      expect(result.totalEvents).toBe(0);
    });

    it("returns all events when limit exceeds total", async () => {
      await journal.append(createMockEvent("event-1", "2025-01-01T10:00:00Z"));
      await journal.append(createMockEvent("event-2", "2025-01-01T10:01:00Z"));
      await journal.append(createMockEvent("event-3", "2025-01-01T10:02:00Z"));

      const result = await journal.getMostRecentEvents(10);

      expect(result.events).toHaveLength(3);
      expect(result.cursor).toBeNull();
      expect(result.totalEvents).toBe(3);
    });

    it("returns events in reverse chronological order (most recent first)", async () => {
      await journal.append(createMockEvent("event-1", "2025-01-01T10:00:00Z"));
      await journal.append(createMockEvent("event-2", "2025-01-01T10:01:00Z"));
      await journal.append(createMockEvent("event-3", "2025-01-01T10:02:00Z"));

      const result = await journal.getMostRecentEvents(10);

      // Should be in reverse order (newest first)
      expect(result.events[0].id).toBe("event-3");
      expect(result.events[1].id).toBe("event-2");
      expect(result.events[2].id).toBe("event-1");
    });

    it("returns limited number of most recent events", async () => {
      await journal.append(createMockEvent("event-1", "2025-01-01T10:00:00Z"));
      await journal.append(createMockEvent("event-2", "2025-01-01T10:01:00Z"));
      await journal.append(createMockEvent("event-3", "2025-01-01T10:02:00Z"));
      await journal.append(createMockEvent("event-4", "2025-01-01T10:03:00Z"));

      const result = await journal.getMostRecentEvents(2);

      expect(result.events).toHaveLength(2);
      expect(result.events[0].id).toBe("event-4"); // Most recent
      expect(result.events[1].id).toBe("event-3");
      expect(result.totalEvents).toBe(4);
    });

    it("returns cursor pointing to next older event when more events exist", async () => {
      await journal.append(createMockEvent("event-1", "2025-01-01T10:00:00Z"));
      await journal.append(createMockEvent("event-2", "2025-01-01T10:01:00Z"));
      await journal.append(createMockEvent("event-3", "2025-01-01T10:02:00Z"));
      await journal.append(createMockEvent("event-4", "2025-01-01T10:03:00Z"));

      const result = await journal.getMostRecentEvents(2);

      expect(result.cursor).not.toBeNull();
      expect(result.cursor?.eventId).toBe("event-2");
      expect(result.cursor?.timestamp).toBe("2025-01-01T10:01:00Z");
    });
  });

  describe("getNextEvents", () => {
    let event1: ServerEvent;
    let event2: ServerEvent;
    let event3: ServerEvent;
    let event4: ServerEvent;
    let event5: ServerEvent;

    beforeEach(async () => {
      event1 = createMockEvent("event-1", "2025-01-01T10:00:00Z");
      event2 = createMockEvent("event-2", "2025-01-01T10:01:00Z");
      event3 = createMockEvent("event-3", "2025-01-01T10:02:00Z");
      event4 = createMockEvent("event-4", "2025-01-01T10:03:00Z");
      event5 = createMockEvent("event-5", "2025-01-01T10:04:00Z");

      await journal.append(event1);
      await journal.append(event2);
      await journal.append(event3);
      await journal.append(event4);
      await journal.append(event5);
    });

    it("returns empty array when cursor not found", async () => {
      const result = await journal.getNextEvents(
        { timestamp: "2025-01-01T09:00:00Z", eventId: "nonexistent" },
        10,
      );

      expect(result.events).toEqual([]);
      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    describe("backward direction (older events)", () => {
      it("returns older events before cursor in reverse chronological order", async () => {
        const result = await journal.getNextEvents(
          { timestamp: event4.timestamp, eventId: event4.id },
          2,
          "backward",
        );

        expect(result.events).toHaveLength(2);
        expect(result.events[0].id).toBe("event-3"); // More recent of the two
        expect(result.events[1].id).toBe("event-2");
      });

      it("returns all older events when limit exceeds available", async () => {
        const result = await journal.getNextEvents(
          { timestamp: event4.timestamp, eventId: event4.id },
          10,
          "backward",
        );

        expect(result.events).toHaveLength(3); // event-1, event-2, event-3
        expect(result.events[0].id).toBe("event-3");
        expect(result.events[1].id).toBe("event-2");
        expect(result.events[2].id).toBe("event-1");
        expect(result.hasMore).toBe(false);
      });

      it("returns nextCursor when more older events exist", async () => {
        const result = await journal.getNextEvents(
          { timestamp: event5.timestamp, eventId: event5.id },
          2,
          "backward",
        );

        expect(result.events).toHaveLength(2);
        expect(result.nextCursor).not.toBeNull();
        expect(result.nextCursor?.eventId).toBe("event-2");
        expect(result.hasMore).toBe(true);
      });

      it("returns null nextCursor when no more older events exist", async () => {
        const result = await journal.getNextEvents(
          { timestamp: event2.timestamp, eventId: event2.id },
          10,
          "backward",
        );

        expect(result.events).toHaveLength(1); // Only event-1
        expect(result.nextCursor).toBeNull();
        expect(result.hasMore).toBe(false);
      });

      it("returns empty array when cursor is at beginning", async () => {
        const result = await journal.getNextEvents(
          { timestamp: event1.timestamp, eventId: event1.id },
          10,
          "backward",
        );

        expect(result.events).toEqual([]);
        expect(result.nextCursor).toBeNull();
        expect(result.hasMore).toBe(false);
      });
    });

    describe("forward direction (newer events)", () => {
      it("returns newer events after cursor", async () => {
        const result = await journal.getNextEvents(
          { timestamp: event2.timestamp, eventId: event2.id },
          2,
          "forward",
        );

        expect(result.events).toHaveLength(2);
        expect(result.events[0].id).toBe("event-3");
        expect(result.events[1].id).toBe("event-4");
      });

      it("returns all newer events when limit exceeds available", async () => {
        const result = await journal.getNextEvents(
          { timestamp: event2.timestamp, eventId: event2.id },
          10,
          "forward",
        );

        expect(result.events).toHaveLength(3); // event-3, event-4, event-5
        expect(result.events[0].id).toBe("event-3");
        expect(result.events[1].id).toBe("event-4");
        expect(result.events[2].id).toBe("event-5");
        expect(result.hasMore).toBe(false);
      });

      it("returns nextCursor when more newer events exist", async () => {
        const result = await journal.getNextEvents(
          { timestamp: event1.timestamp, eventId: event1.id },
          2,
          "forward",
        );

        expect(result.events).toHaveLength(2);
        expect(result.nextCursor).not.toBeNull();
        expect(result.nextCursor?.eventId).toBe("event-4");
        expect(result.hasMore).toBe(true);
      });

      it("returns null nextCursor when no more newer events exist", async () => {
        const result = await journal.getNextEvents(
          { timestamp: event4.timestamp, eventId: event4.id },
          10,
          "forward",
        );

        expect(result.events).toHaveLength(1); // Only event-5
        expect(result.nextCursor).toBeNull();
        expect(result.hasMore).toBe(false);
      });

      it("returns empty array when cursor is at end", async () => {
        const result = await journal.getNextEvents(
          { timestamp: event5.timestamp, eventId: event5.id },
          10,
          "forward",
        );

        expect(result.events).toEqual([]);
        expect(result.nextCursor).toBeNull();
        expect(result.hasMore).toBe(false);
      });
    });

    it("uses backward direction as default", async () => {
      const result = await journal.getNextEvents(
        { timestamp: event4.timestamp, eventId: event4.id },
        2,
      );

      // Should return older events (backward)
      expect(result.events[0].id).toBe("event-3");
      expect(result.events[1].id).toBe("event-2");
    });
  });
});
