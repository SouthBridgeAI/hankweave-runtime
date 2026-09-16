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

function createInfoEvent(id: number): ServerEvent {
  const timestamp = new Date(Date.now() + id).toISOString();
  return {
    id: EventId(`info-event-${id.toString().padStart(10, "0")}`),
    timestamp,
    type: "info",
    data: {
      message: `Info event ${id}`,
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

    const sampleEvent = createInfoEvent(0);
    sampleEventBytes = Buffer.byteLength(JSON.stringify(sampleEvent)) + 1;
    expectedTotalEvents = Math.ceil(TARGET_BYTES / sampleEventBytes);
    lastEventId = `info-event-${(expectedTotalEvents - 1).toString().padStart(10, "0")}`;

    await storage.appendMany(
      (function* (): Generator<ServerEvent> {
        for (let i = 0; i < expectedTotalEvents; i++) {
          yield createInfoEvent(i);
        }
      })(),
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
    const { events, hasMore, totalEvents } = await journal.getMostRecentEvents(limit);
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
    expect(events[0].id).toBe(lastEventId);
  }, 10000);

  it("tails 50 events from the 200 MB journal in O(tail) time", async () => {
    // Order-of-magnitude guard only: the tail read must seek from EOF, not
    // parse the whole file (which takes ~250 ms on this fixture). Best of 3
    // so one cold-cache or GC hiccup can't flake the bound.
    let bestMs = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = performance.now();
      const { events } = await journal.getMostRecentEvents(50);
      bestMs = Math.min(bestMs, performance.now() - start);
      expect(events).toHaveLength(50);
      expect(events[0].id).toBe(lastEventId);
    }
    expect(bestMs).toBeLessThan(50);
  });

  it("pages by cursor without drifting from the journal tail", async () => {
    // Sanity for the cursor API at scale: sequential pages must continue
    // exactly where the previous one stopped (cursor lineNo == lines consumed).
    const { totalEvents } = await journal.getMostRecentEvents(1);
    const page1 = await journal.transport.getEventsAfter(null, 100);
    expect(page1.events).toHaveLength(100);
    expect(page1.events[0].id).toBe("info-event-0000000000");
    expect(page1.hasMore).toBe(totalEvents > 100);

    const page2 = await journal.transport.getEventsAfter(page1.nextCursor, 100);
    expect(page2.events[0].id).toBe("info-event-0000000100");
    expect(page2.events[99].id).toBe("info-event-0000000199");

    // A fresh instance has no warm cursor→offset cache, so resuming from a
    // mid-file cursor exercises the skip-from-zero path; it must agree.
    const cold = new FileEventStorage(tempDir);
    await cold.initialize();
    const coldPage = await cold.getEventsAfter(page1.nextCursor, 3);
    expect(coldPage.events.map((e) => e.id)).toEqual([
      "info-event-0000000100",
      "info-event-0000000101",
      "info-event-0000000102",
    ]);
  });

  it("getAllEvents crosses cursor page boundaries in order", async () => {
    // The journal pages getAllEvents at 1000 events/page; walking past 2500
    // covers two page transitions and the 64 KB scan-boundary arithmetic.
    const iterator = journal.getAllEvents()[Symbol.asyncIterator]();
    for (let i = 0; i < 2500; i++) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      const expectedId = `info-event-${i.toString().padStart(10, "0")}`;
      if (next.value.id !== expectedId) {
        throw new Error(`Out of order at ${i}: expected ${expectedId}, got ${next.value.id}`);
      }
    }
    await iterator.return?.(undefined);
  });

  it("streams the full log", async () => {
    // Stream contract (diet decision 0.3.2): streamAllEvents yields the
    // LOGICAL journal. On a live (undieted) directory like this one, the
    // logical journal is the on-disk file, so hash equality still holds;
    // the byte-identity requirement itself is asserted where it belongs —
    // on diet/restore, in tests/unit/journal-diet.test.ts.
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

    expect(await computeFileHash(destinationPath)).toBe(await computeFileHash(eventsFilePath));
  }, 10000);
});
