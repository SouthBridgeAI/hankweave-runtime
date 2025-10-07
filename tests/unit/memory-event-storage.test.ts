import { beforeEach, describe, expect, it } from "bun:test";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { MemoryEventStorage } from "../../server/storage/memory-event-storage.js";
import { EventId } from "../../server/types/branded-types.js";

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
    storage = new MemoryEventStorage();
  });

  it("appends events and maintains order", async () => {
    const event1 = createMockEvent("event-1");
    const event2 = createMockEvent("event-2");

    await storage.append(event1);
    await storage.append(event2);

    const { events, totalEvents } = await storage.getRecentEvents(10);
    expect(totalEvents).toBe(2);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(event1);
    expect(events[1]).toEqual(event2);
  });

  it("trims when the in-memory cap is exceeded", async () => {
    for (let i = 1; i <= 130; i++) {
      await storage.append(createMockEvent(`event-${i}`));
    }

    const { events, totalEvents } = await storage.getRecentEvents(130);
    expect(totalEvents).toBeLessThanOrEqual(100);
    expect(events[events.length - 1]?.id).toBe("event-130");
    expect(events[0]?.id).not.toBe("event-1");
  });

  it("returns only the requested number of recent events", async () => {
    for (let i = 1; i <= 6; i++) {
      await storage.append(createMockEvent(`event-${i}`));
    }

    const { events } = await storage.getRecentEvents(3);
    expect(events.map((e) => e.id)).toEqual(["event-4", "event-5", "event-6"]);
  });

  it("handles zero limits gracefully", async () => {
    await storage.append(createMockEvent("event-1"));

    const { events, totalEvents } = await storage.getRecentEvents(0);
    expect(events).toEqual([]);
    expect(totalEvents).toBe(1);
  });

  it("exposes a JSONL stream for download", async () => {
    await storage.append(createMockEvent("event-1"));
    await storage.append(createMockEvent("event-2"));

    const stream = await storage.createReadStream();
    const chunks: string[] = [];

    stream.on("data", (chunk) => {
      chunks.push(chunk.toString());
    });

    await new Promise<void>((resolve) => stream.on("end", resolve));

    const combined = chunks.join("");
    expect(combined.split("\n").filter(Boolean)).toHaveLength(2);
  });
});
