import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
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

async function computeFileHash(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const fileStream = createReadStream(filePath, { encoding: "utf-8" });

  for await (const chunk of fileStream) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

describe("EventJournal with FileEventStorage", () => {
  let tempDir: string;
  let journal: EventJournal;
  let storage: FileEventStorage;
  let eventsFilePath: string;
  let expectedTotalEvents: number;
  let lastEventId: ServerEvent["id"];
  const TARGET_BYTES = 200 * 1024 * 1024;
  let sampleEventBytes: number;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "event-journal-integration-"));
    storage = new FileEventStorage(tempDir);
    journal = new EventJournal(storage);
    await journal.initialize();

    const seedEvents = Array.from({ length: 5 }, (_, index) =>
      createMockEvent(index + 1)
    );
    const seedBytes = seedEvents.reduce(
      (size, event) => size + Buffer.byteLength(JSON.stringify(event)) + 1,
      0
    );

    const sampleEvent = createPingEvent(0);
    sampleEventBytes = Buffer.byteLength(JSON.stringify(sampleEvent)) + 1;
    const remainingBytesTarget = Math.max(0, TARGET_BYTES - seedBytes);
    const pingEventCount =
      remainingBytesTarget > 0
        ? Math.ceil(remainingBytesTarget / sampleEventBytes)
        : 0;

    expectedTotalEvents = seedEvents.length + pingEventCount;

    lastEventId =
      pingEventCount > 0
        ? `ping-event-${(pingEventCount - 1).toString().padStart(10, "0")}`
        : seedEvents[seedEvents.length - 1]!.id;

    await storage.appendMany(
      (function* (): Generator<ServerEvent> {
        yield* seedEvents;
        for (let i = 0; i < pingEventCount; i++) {
          yield createPingEvent(i);
        }
      })()
    );

    eventsFilePath = join(tempDir, "events.jsonl");
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("can handle somewhat big files", async () => {
    expect(journal.transport).toBe(storage);
    const { size } = await stat(eventsFilePath);
    expect(size).toBeWithin(TARGET_BYTES, 1.1 * TARGET_BYTES);
  });

  it("provides access to the underlying transport and serves recent history", async () => {
    const limit = 5;
    const { events, hasMore, totalEvents } = await journal.getMostRecentEvents(
      limit
    );
    expect(totalEvents).toBe(expectedTotalEvents);
    expect(events).toHaveLength(Math.min(limit, expectedTotalEvents));
    expect(await journal.getTotalEvents()).toBe(expectedTotalEvents);
    if (expectedTotalEvents > 0) {
      expect(events[0].id).toBe(lastEventId);
    }
    expect(hasMore).toBe(expectedTotalEvents > limit);
  });

  it("survives restart", async () => {
    journal = new EventJournal(new FileEventStorage(tempDir));
    await journal.initialize();

    const { events, totalEvents } = await journal.getMostRecentEvents(1);
    expect(totalEvents).toBe(expectedTotalEvents);
    if (events.length > 0) {
      expect(events[0].id).toBe(lastEventId);
    }
  });

  it("streams the full log", async () => {
    const stream = await journal.streamAllEvents();
    const destinationPath = join(tempDir, "events-copy.jsonl");
    const destination = createWriteStream(destinationPath, {
      encoding: "utf-8",
    });

    await new Promise<void>((resolve, reject) => {
      const handleStreamError = (error: unknown) => {
        destination.destroy();
        reject(error);
      };
      const handleDestinationError = (error: unknown) => {
        // stream. .destroy();
        reject(error);
      };

      stream.setEncoding("utf-8");
      stream.on("data", (chunk) => {
        destination.write(chunk);
      });
      stream.once("error", handleStreamError);
      destination.once("error", handleDestinationError);
      stream.once("end", () => {
        destination.end();
      });
      destination.once("finish", resolve);
    });

    expect(await computeFileHash(destinationPath)).toBe(
      await computeFileHash(eventsFilePath)
    );
  });
});
