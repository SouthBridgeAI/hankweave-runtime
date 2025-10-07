import { beforeEach, describe, expect, it } from "bun:test";
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

describe("MemoryEventStorage", () => {
  let storage: MemoryEventStorage;

  beforeEach(() => {
    storage = new MemoryEventStorage(100);
  });

  describe("append", () => {
    it("adds events to storage", async () => {
      const event1 = createMockEvent("event-1");
      const event2 = createMockEvent("event-2");

      await storage.append(event1);
      await storage.append(event2);

      const allEvents = await storage.getAllEvents();
      expect(allEvents).toHaveLength(2);
      expect(allEvents[0]).toEqual(event1);
      expect(allEvents[1]).toEqual(event2);
    });

    it("trims old events when max limit is exceeded", async () => {
      const smallStorage = new MemoryEventStorage(10);

      // Add more events than the limit
      for (let i = 1; i <= 15; i++) {
        await smallStorage.append(createMockEvent(`event-${i}`));
      }

      const allEvents = await smallStorage.getAllEvents();

      // Should trim 10% (1 event) when limit (10) is exceeded
      expect(allEvents.length).toBeLessThan(15);
      expect(allEvents.length).toBeGreaterThan(0);

      // The remaining events should be the most recent ones
      const lastEvent = allEvents[allEvents.length - 1];
      expect(lastEvent.id).toBe("event-15");
    });
  });

  describe("getAllEvents", () => {
    it("returns empty array when no events", async () => {
      const allEvents = await storage.getAllEvents();
      expect(allEvents).toEqual([]);
    });

    it("returns copy of all events", async () => {
      const event1 = createMockEvent("event-1");
      const event2 = createMockEvent("event-2");

      await storage.append(event1);
      await storage.append(event2);

      const allEvents = await storage.getAllEvents();
      expect(allEvents).toHaveLength(2);
      expect(allEvents[0]).toEqual(event1);
      expect(allEvents[1]).toEqual(event2);

      // Ensure it's a copy (mutations don't affect original)
      allEvents.push(createMockEvent("event-3"));
      expect((await storage.getAllEvents()).length).toBe(2);
    });
  });

  describe("getEvents", () => {
    beforeEach(async () => {
      await storage.append(createMockEvent("event-1"));
      await storage.append(createMockEvent("event-2"));
      await storage.append(createMockEvent("event-3"));
      await storage.append(createMockEvent("event-4"));
    });

    it("returns slice of events", async () => {
      const events = await storage.getEvents(1, 3);
      expect(events).toHaveLength(2);
      expect(events[0].id).toBe("event-2");
      expect(events[1].id).toBe("event-3");
    });

    it("handles out of bounds indices", async () => {
      const events = await storage.getEvents(2, 10);
      expect(events).toHaveLength(2);
      expect(events[0].id).toBe("event-3");
      expect(events[1].id).toBe("event-4");
    });

    it("returns empty array for invalid range", async () => {
      const events = await storage.getEvents(10, 20);
      expect(events).toEqual([]);
    });
  });

  describe("findEventIndex", () => {
    beforeEach(async () => {
      await storage.append(createMockEvent("event-1", "2025-01-01T10:00:00Z"));
      await storage.append(createMockEvent("event-2", "2025-01-01T10:01:00Z"));
      await storage.append(createMockEvent("event-3", "2025-01-01T10:02:00Z"));
    });

    it("finds event by predicate", async () => {
      const index = await storage.findEventIndex((e) => e.id === "event-2");
      expect(index).toBe(1);
    });

    it("returns -1 when event not found", async () => {
      const index = await storage.findEventIndex((e) => e.id === "nonexistent");
      expect(index).toBe(-1);
    });

    it("finds event by timestamp", async () => {
      const index = await storage.findEventIndex((e) => e.timestamp === "2025-01-01T10:02:00Z");
      expect(index).toBe(2);
    });
  });

  describe("getTotalEvents", () => {
    it("returns 0 for empty storage", async () => {
      expect(await storage.getTotalEvents()).toBe(0);
    });

    it("returns correct count of events", async () => {
      await storage.append(createMockEvent("event-1"));
      await storage.append(createMockEvent("event-2"));
      await storage.append(createMockEvent("event-3"));

      expect(await storage.getTotalEvents()).toBe(3);
    });
  });

  describe("clear", () => {
    it("clears all events", async () => {
      await storage.append(createMockEvent("event-1"));
      await storage.append(createMockEvent("event-2"));

      expect(await storage.getTotalEvents()).toBe(2);

      await storage.clear();

      expect(await storage.getTotalEvents()).toBe(0);
      expect(await storage.getAllEvents()).toEqual([]);
    });
  });

  describe("close", () => {
    it("closes without error", async () => {
      await storage.append(createMockEvent("event-1"));
      await expect(storage.close()).resolves.toBeUndefined();
    });
  });
});
