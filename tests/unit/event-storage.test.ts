import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import type { IEventStorage } from "../../server/storage/event-storage.js";
import { FileEventStorage } from "../../server/storage/file-event-storage.js";
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

interface StorageFixture {
  storage: IEventStorage;
  cleanup: () => Promise<void>;
}

// Each factory yields a fresh, initialized storage plus a cleanup hook so the
// shared contract tests run identically against every IEventStorage backend.
const implementations: Array<[string, () => Promise<StorageFixture>]> = [
  [
    "MemoryEventStorage",
    async () => ({
      storage: new MemoryEventStorage(),
      cleanup: async () => {},
    }),
  ],
  [
    "FileEventStorage",
    async () => {
      const tempDir = await mkdtemp(path.join(tmpdir(), "event-storage-test-"));
      const storage = new FileEventStorage(tempDir);
      await storage.initialize();
      return {
        storage,
        cleanup: () => rm(tempDir, { recursive: true, force: true }),
      };
    },
  ],
];

describe.each(implementations)("EventStorage contract (%s)", (_name, createStorage) => {
  let storage: IEventStorage;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ storage, cleanup } = await createStorage());
  });

  afterEach(async () => {
    await cleanup();
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

  it("returns only the last N events", async () => {
    for (let i = 1; i <= 6; i++) {
      await storage.append(createMockEvent(`event-${i}`));
    }

    const { events } = await storage.getRecentEvents(3);
    expect(events.map((e) => e.id)).toEqual(["event-4", "event-5", "event-6"]);
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

describe("MemoryEventStorage", () => {
  let storage: MemoryEventStorage;

  beforeEach(() => {
    storage = new MemoryEventStorage();
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

  it("handles zero limits gracefully", async () => {
    await storage.append(createMockEvent("event-1"));

    const { events, totalEvents } = await storage.getRecentEvents(0);
    expect(events).toEqual([]);
    expect(totalEvents).toBe(1);
  });
});

describe("FileEventStorage", () => {
  let storage: FileEventStorage;
  let tempDir: string;
  let eventsPath: string | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "file-event-storage-test-"));
    eventsPath = path.join(tempDir, "events.jsonl");
    storage = new FileEventStorage(tempDir);
    await storage.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates the backing file on initialize", async () => {
    expect(eventsPath).not.toBeNull();

    if (!eventsPath) return;

    const contents = await readFile(eventsPath, "utf-8");
    expect(contents).toBe("");
    expect(await storage.getTotalEvents()).toBe(0);
  });

  it("persists events across restarts", async () => {
    await storage.append(createMockEvent("event-1"));
    await storage.append(createMockEvent("event-2"));

    const newStorage = new FileEventStorage(tempDir);
    await newStorage.initialize();

    const { events, totalEvents } = await newStorage.getRecentEvents(10);
    expect(totalEvents).toBe(2);
    expect(events.map((e) => e.id)).toEqual(["event-1", "event-2"]);
  });
});
