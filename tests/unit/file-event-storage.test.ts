import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { FileEventStorage } from "../../server/storage/file-event-storage.js";
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

  it("appends events and reports totals", async () => {
    await storage.append(createMockEvent("event-1"));
    await storage.append(createMockEvent("event-2"));

    const { events, totalEvents } = await storage.getRecentEvents(10);
    expect(totalEvents).toBe(2);
    expect(events.map((e) => e.id)).toEqual(["event-1", "event-2"]);
  });

  it("returns only the last N events", async () => {
    for (let i = 1; i <= 6; i++) {
      await storage.append(createMockEvent(`event-${i}`));
    }

    const { events } = await storage.getRecentEvents(3);
    expect(events.map((e) => e.id)).toEqual(["event-4", "event-5", "event-6"]);
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

  it("exposes a readable stream of the JSONL log", async () => {
    await storage.append(createMockEvent("event-1"));
    await storage.append(createMockEvent("event-2"));

    const stream = await storage.createReadStream();
    const chunks: string[] = [];
    stream.on("data", (chunk) => chunks.push(chunk.toString()));
    await new Promise<void>((resolve) => stream.on("end", resolve));

    const lines = chunks.join("").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });
});
