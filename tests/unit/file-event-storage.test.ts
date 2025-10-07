import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { FileEventStorage } from "../../server/storage/file-event-storage.js";
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

describe("FileEventStorage", () => {
  let storage: FileEventStorage;
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    tempDir = await mkdtemp(join(tmpdir(), "file-event-storage-test-"));
    storage = new FileEventStorage(tempDir);
    await storage.initialize();
  });

  afterEach(async () => {
    // Clean up
    await storage.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("initialize", () => {
    it("creates storage directory and initializes empty storage", async () => {
      const newTempDir = await mkdtemp(join(tmpdir(), "file-event-storage-test-"));
      const newStorage = new FileEventStorage(newTempDir);

      await newStorage.initialize();
      expect(await newStorage.getTotalEvents()).toBe(0);

      await newStorage.close();
      await rm(newTempDir, { recursive: true, force: true });
    });

    it("loads existing index on initialization", async () => {
      // Add some events
      await storage.append(createMockEvent("event-1"));
      await storage.append(createMockEvent("event-2"));
      await storage.close();

      // Create new storage instance pointing to same directory
      const newStorage = new FileEventStorage(tempDir);
      await newStorage.initialize();

      expect(await newStorage.getTotalEvents()).toBe(2);
      const events = await newStorage.getAllEvents();
      expect(events[0].id).toBe("event-1");
      expect(events[1].id).toBe("event-2");

      await newStorage.close();
    });
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

    it("persists events to disk", async () => {
      await storage.append(createMockEvent("event-1"));
      await storage.append(createMockEvent("event-2"));
      await storage.close();

      // Create new storage instance
      const newStorage = new FileEventStorage(tempDir);
      await newStorage.initialize();

      const events = await newStorage.getAllEvents();
      expect(events).toHaveLength(2);

      await newStorage.close();
    });
  });

  describe("getAllEvents", () => {
    it("returns empty array when no events", async () => {
      const allEvents = await storage.getAllEvents();
      expect(allEvents).toEqual([]);
    });

    it("returns all events", async () => {
      const event1 = createMockEvent("event-1");
      const event2 = createMockEvent("event-2");
      const event3 = createMockEvent("event-3");

      await storage.append(event1);
      await storage.append(event2);
      await storage.append(event3);

      const allEvents = await storage.getAllEvents();
      expect(allEvents).toHaveLength(3);
      expect(allEvents[0]).toEqual(event1);
      expect(allEvents[1]).toEqual(event2);
      expect(allEvents[2]).toEqual(event3);
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
    it("clears all events and files", async () => {
      await storage.append(createMockEvent("event-1"));
      await storage.append(createMockEvent("event-2"));

      expect(await storage.getTotalEvents()).toBe(2);

      await storage.clear();

      expect(await storage.getTotalEvents()).toBe(0);
      expect(await storage.getAllEvents()).toEqual([]);
    });

    it("allows appending after clear", async () => {
      await storage.append(createMockEvent("event-1"));
      await storage.clear();
      await storage.append(createMockEvent("event-2"));

      expect(await storage.getTotalEvents()).toBe(1);
      const events = await storage.getAllEvents();
      expect(events[0].id).toBe("event-2");
    });
  });

  describe("close", () => {
    it("closes file handles", async () => {
      await storage.append(createMockEvent("event-1"));
      await expect(storage.close()).resolves.toBeUndefined();
    });

    it("can be called multiple times", async () => {
      await storage.close();
      await expect(storage.close()).resolves.toBeUndefined();
    });
  });

  describe("persistence and recovery", () => {
    it("recovers data after restart", async () => {
      // Add events
      await storage.append(createMockEvent("event-1", "2025-01-01T10:00:00Z"));
      await storage.append(createMockEvent("event-2", "2025-01-01T10:01:00Z"));
      await storage.append(createMockEvent("event-3", "2025-01-01T10:02:00Z"));
      await storage.close();

      // Create new storage instance
      const newStorage = new FileEventStorage(tempDir);
      await newStorage.initialize();

      // Should have all events
      expect(await newStorage.getTotalEvents()).toBe(3);
      const events = await newStorage.getAllEvents();
      expect(events[0].id).toBe("event-1");
      expect(events[1].id).toBe("event-2");
      expect(events[2].id).toBe("event-3");

      await newStorage.close();
    });
  });
});
