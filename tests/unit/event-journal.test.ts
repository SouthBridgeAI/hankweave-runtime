import { beforeEach, describe, expect, it } from "bun:test";
import { EventJournal } from "../../server/event-journal.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { MemoryEventStorage } from "../../server/storage/memory-event-storage.js";
import { EventId } from "../../server/types/branded-types.js";

function createMockEvent(id: string, timestamp?: string): ServerEvent {
  return {
    id: EventId(id),
    timestamp: timestamp || new Date().toISOString(),
    type: "info",
    data: {
      message: `Test event ${id}`,
    },
  };
}

describe("EventJournal", () => {
  let journal: EventJournal;

  beforeEach(async () => {
    journal = new EventJournal(new MemoryEventStorage());
    await journal.initialize();
  });

  it("appends events and exposes them via getAllEvents", async () => {
    const event1 = createMockEvent("event-1");
    const event2 = createMockEvent("event-2");

    await journal.append(event1);
    await journal.append(event2);

    const received: ServerEvent[] = [];
    for await (const event of journal.getAllEvents()) {
      received.push(event);
    }

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(event1);
    expect(received[1]).toEqual(event2);
  });

  it("returns totals", async () => {
    expect(await journal.getTotalEvents()).toBe(0);
    await journal.append(createMockEvent("event-1"));
    await journal.append(createMockEvent("event-2"));
    expect(await journal.getTotalEvents()).toBe(2);
  });

  describe("getMostRecentEvents", () => {
    it("returns empty when journal has no events", async () => {
      const result = await journal.getMostRecentEvents(10);
      expect(result.events).toEqual([]);
      expect(result.totalEvents).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it("returns events in reverse chronological order", async () => {
      await journal.append(createMockEvent("event-1", "2025-01-01T10:00:00Z"));
      await journal.append(createMockEvent("event-2", "2025-01-01T10:01:00Z"));
      await journal.append(createMockEvent("event-3", "2025-01-01T10:02:00Z"));

      const result = await journal.getMostRecentEvents(5);
      expect(result.events.map((e) => e.id)).toEqual(["event-3", "event-2", "event-1"]);
      expect(result.totalEvents).toBe(3);
      expect(result.hasMore).toBe(false);
    });

    it("flags when additional history exists beyond the requested limit", async () => {
      for (let i = 1; i <= 5; i++) {
        await journal.append(createMockEvent(`event-${i}`));
      }

      const result = await journal.getMostRecentEvents(3);
      expect(result.events.map((e) => e.id)).toEqual(["event-5", "event-4", "event-3"]);
      expect(result.totalEvents).toBe(5);
      expect(result.hasMore).toBe(true);
    });
  });

  it("provides a stream of all events", async () => {
    await journal.append(createMockEvent("event-1"));
    await journal.append(createMockEvent("event-2"));

    const stream = await journal.streamAllEvents();
    const chunks: string[] = [];
    stream.on("data", (chunk) => chunks.push(chunk.toString()));
    await new Promise<void>((resolve) => stream.on("end", resolve));

    const lines = chunks.join("").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it("rejects connection state events", async () => {
    const connectionEvent: ServerEvent = {
      id: EventId("test-event"),
      timestamp: new Date().toISOString(),
      type: "pong",
      data: {
        message: "pong",
        timestamp: new Date().toISOString(),
      },
    };

    await expect(journal.append(connectionEvent)).rejects.toThrow(
      "Cannot journal non-journaled event: pong",
    );
  });

  it("accepts agentic backbone events", async () => {
    const agenticEvent: ServerEvent = {
      id: EventId("test-event"),
      timestamp: new Date().toISOString(),
      type: "assistant.action",
      data: {
        phaseId: "phase-1",
        action: "message",
        content: "Test content",
      },
    };

    await journal.append(agenticEvent);
    expect(await journal.getTotalEvents()).toBe(1);
  });

  it("accepts server state events", async () => {
    const serverStateEvent: ServerEvent = {
      id: EventId("test-event"),
      timestamp: new Date().toISOString(),
      type: "phase.started",
      data: {
        phaseId: "test-phase",
        phaseName: "Test Phase",
        sessionId: "test-session",
        startTime: new Date().toISOString(),
      },
    };

    // Should not throw - just verify it completes successfully
    await journal.append(serverStateEvent);
    expect(await journal.getTotalEvents()).toBe(1);
  });
});
