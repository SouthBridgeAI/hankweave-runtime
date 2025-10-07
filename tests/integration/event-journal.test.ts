import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventJournal } from "../../server/event-journal.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { FileEventStorage } from "../../server/storage/file-event-storage.js";
import { EventId } from "../../server/types/branded-types.js";

function createMockEvent(id: number, timestamp?: string): ServerEvent {
  return {
    id: EventId(`event-${id}`),
    timestamp: timestamp || new Date(Date.now() + id * 1000).toISOString(),
    type: "pong",
    data: {
      message: `Test event ${id}`,
      timestamp: timestamp || new Date(Date.now() + id * 1000).toISOString(),
    },
  };
}

function createPingEvent(id: number): ServerEvent {
  const timestamp = new Date(Date.now() + id).toISOString();
  return {
    id: EventId(`ping-event-${id.toString().padStart(10, "0")}`),
    timestamp,
    type: "pong",
    data: {
      message: `Ping event ${id}`,
      timestamp,
    },
  };
}

describe("EventJournal with FileEventStorage", () => {
  let tempDir: string;
  let journal: EventJournal;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "event-journal-integration-"));
    journal = new EventJournal(new FileEventStorage(tempDir));
    await journal.initialize();
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists events and serves recent history", async () => {
    for (let i = 1; i <= 5; i++) {
      await journal.append(createMockEvent(i));
    }

    const { events, hasMore, totalEvents } = await journal.getMostRecentEvents(3);
    expect(events.map((e) => e.id)).toEqual(["event-5", "event-4", "event-3"]);
    expect(totalEvents).toBe(5);
    expect(hasMore).toBe(true);
  });

  it("survives restart", async () => {
    journal = new EventJournal(new FileEventStorage(tempDir));
    await journal.initialize();

    const { events, totalEvents } = await journal.getMostRecentEvents(10);
    expect(totalEvents).toBe(5);
    expect(events.map((e) => e.id)[0]).toBe("event-5");
  });

  it("streams the full log", async () => {
    const stream = await journal.streamAllEvents();
    const chunks: string[] = [];
    stream.on("data", (chunk) => chunks.push(chunk.toString()));
    await new Promise<void>((resolve) => stream.on("end", resolve));

    const lines = chunks.join("").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });

  it("handles a ~200MB event log without degradation", async () => {
    const largeDir = await mkdtemp(join(tmpdir(), "event-journal-massive-"));

    try {
      const largeJournal = new EventJournal(new FileEventStorage(largeDir));
      await largeJournal.initialize();

      const targetBytes = 200 * 1024 * 1024;
      const sampleEvent = createPingEvent(0);
      const sampleBytes = Buffer.byteLength(JSON.stringify(sampleEvent)) + 1; // newline
      const eventCount = Math.ceil(targetBytes / sampleBytes);
      const yieldInterval = Math.max(1, Math.floor(eventCount / 20));

      for (let i = 0; i < eventCount; i++) {
        await largeJournal.append(createPingEvent(i));
        if ((i + 1) % yieldInterval === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      const eventsPath = join(largeDir, "events.jsonl");
      const { size } = await stat(eventsPath);
      expect(size).toBeGreaterThanOrEqual(targetBytes);
      expect(size).toBeLessThan(Math.floor(targetBytes * 1.1));

      const { events, totalEvents, hasMore } = await largeJournal.getMostRecentEvents(100);
      expect(events).toHaveLength(100);
      expect(events[0].id).toBe(`ping-event-${(eventCount - 1).toString().padStart(10, "0")}`);
      expect(totalEvents).toBe(eventCount);
      expect(hasMore).toBe(eventCount > 100);

      const stream = await largeJournal.streamAllEvents();
      let chunkRead = 0;
      for await (const _chunk of stream) {
        chunkRead += 1;
        break; // ensure stream begins emitting without reading entire file
      }
      expect(chunkRead).toBeGreaterThan(0);
    } finally {
      await rm(largeDir, { recursive: true, force: true });
    }
  }, 120_000);
});
