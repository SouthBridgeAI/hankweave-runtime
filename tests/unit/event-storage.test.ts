import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { CURSOR_WORDS } from "../../server/storage/cursor-words.js";
import {
  decodeEventCursor,
  encodeEventCursor,
  type IEventStorage,
} from "../../server/storage/event-storage.js";
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
    async () => {
      const storage = new MemoryEventStorage();
      await storage.initialize();
      return {
        storage,
        cleanup: async () => {},
      };
    },
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

/** Walk the cursor API to exhaustion and return every event seen. */
async function collectViaCursor(storage: IEventStorage, pageSize: number): Promise<ServerEvent[]> {
  const collected: ServerEvent[] = [];
  let cursor: string | null = null;
  while (true) {
    const page = await storage.getEventsAfter(cursor, pageSize);
    collected.push(...page.events);
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  return collected;
}

describe("event cursor encoding", () => {
  it("round-trips and rejects tokens outside the frozen vocabulary", () => {
    const token = encodeEventCursor(0, 1234);
    expect(token.split("-")).toHaveLength(5);
    expect(decodeEventCursor(token)).toEqual({ segmentId: 0, lineNo: 1234 });

    expect(decodeEventCursor("")).toBeNull();
    expect(decodeEventCursor("not-a-cursor")).toBeNull();
    // Lowercase list words are the single canonical form.
    expect(decodeEventCursor(token.toUpperCase())).toBeNull();
    expect(decodeEventCursor(token.split("-").slice(0, 4).join("-"))).toBeNull();
    // Words outside the list fail loudly — fabricated tokens and memorized
    // BIP39 alike.
    expect(decodeEventCursor("ada-ada-ada-ada-kermit")).toBeNull();
    expect(decodeEventCursor("abandon-ability-able-about-above")).toBeNull();
  });

  it("sorts lexicographically in stream order and refuses overflow", () => {
    // Durable-Streams-style offset property: byte-wise comparison must equal
    // stream order (fixed word count over a sorted vocabulary).
    const lines = [0, 1, 2, 9, 10, 511, 512, 1000, 487_123, 2 ** 27, 2 ** 36 - 1];
    const tokens = lines.map((lineNo) => encodeEventCursor(0, lineNo));
    expect([...tokens].sort()).toEqual(tokens);

    // The segment is the more-significant field.
    expect(encodeEventCursor(1, 0) > encodeEventCursor(0, 2 ** 36 - 1)).toBe(true);

    // Beyond-capacity positions throw at mint time instead of wrapping.
    expect(() => encodeEventCursor(0, 2 ** 36)).toThrow(/rotate/i);
    expect(() => encodeEventCursor(512, 0)).toThrow(/segment/i);
  });

  it("pins the frozen cursor wordlist", () => {
    expect(CURSOR_WORDS).toHaveLength(512);
    expect([...CURSOR_WORDS].sort()).toEqual([...CURSOR_WORDS]);
    expect(new Set(CURSOR_WORDS).size).toBe(512);
    for (const word of CURSOR_WORDS) {
      expect(word).toMatch(/^[a-z]{3,7}$/);
    }
    // The list is a wire contract: any edit remaps every persisted cursor.
    // DRAFT pin — re-pin only alongside the pre-merge human pass of the list.
    const digest = createHash("sha256").update(CURSOR_WORDS.join("\n")).digest("hex");
    expect(digest).toBe("f78baa812916dd5c3af2d9ac1f6a08ca1b37d0890d4f09286104fe290be64789");
  });
});

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

  it("rejects appends after close, and close is idempotent", async () => {
    await storage.append(createMockEvent("event-1"));
    await storage.close();
    await storage.close();

    await expect(storage.append(createMockEvent("event-2"))).rejects.toThrow(/closed/i);
    await expect(storage.appendMany([createMockEvent("event-3")])).rejects.toThrow(/closed/i);
  });

  it("close drains appends that were accepted before it", async () => {
    // Deliberately not awaited before close: an accepted append must land
    // before close() flushes and releases the storage.
    const appendPromise = storage.appendMany(
      Array.from({ length: 50 }, (_, i) => createMockEvent(`pre-close-${i}`)),
    );
    await storage.close();
    await appendPromise;

    const { events } = await storage.getRecentEvents(1);
    expect(events[0]?.id).toBe("pre-close-49");
  });

  it("supports interleaved appends and reads", async () => {
    await storage.append(createMockEvent("event-1"));
    let result = await storage.getRecentEvents(10);
    expect(result.events.map((e) => e.id)).toEqual(["event-1"]);

    await storage.appendMany([createMockEvent("event-2"), createMockEvent("event-3")]);
    result = await storage.getRecentEvents(10);
    expect(result.events.map((e) => e.id)).toEqual(["event-1", "event-2", "event-3"]);
    expect(result.totalEvents).toBe(3);
  });

  it("maintains order under a 10k burst", async () => {
    const total = 10_000;
    await storage.appendMany(
      (function* (): Generator<ServerEvent> {
        for (let i = 0; i < total; i++) {
          yield createMockEvent(`burst-${i.toString().padStart(5, "0")}`);
        }
      })(),
    );

    const { events } = await storage.getRecentEvents(5);
    expect(events.map((e) => e.id)).toEqual([
      "burst-09995",
      "burst-09996",
      "burst-09997",
      "burst-09998",
      "burst-09999",
    ]);
  });

  it("cursor iteration exhaustively equals a full scan", async () => {
    // 80 events keeps the memory backend below its ring cap so both backends
    // must return the identical exhaustive sequence.
    const appendedIds: string[] = [];
    for (let i = 0; i < 80; i++) {
      const id = `cursor-${i.toString().padStart(3, "0")}`;
      appendedIds.push(id);
      await storage.append(createMockEvent(id));
    }

    // Page size deliberately not a divisor of 80, so the walk crosses uneven
    // boundaries; a one-page walk must agree with the many-page walk.
    const paged = await collectViaCursor(storage, 7);
    const single = await collectViaCursor(storage, 500);
    expect(paged.map((e) => e.id)).toEqual(appendedIds);
    expect(single.map((e) => e.id)).toEqual(appendedIds);
  });

  it("returns an empty page for limit 0 and rejects malformed cursors", async () => {
    await storage.append(createMockEvent("event-1"));

    const page = await storage.getEventsAfter(null, 0);
    expect(page.events).toEqual([]);
    expect(page.hasMore).toBe(false);

    await expect(storage.getEventsAfter("not-a-cursor", 10)).rejects.toThrow(/cursor/i);
  });

  it("tolerates tail reads while a large append is in flight", async () => {
    const total = 2_000;
    const appendPromise = storage.appendMany(
      (function* (): Generator<ServerEvent> {
        for (let i = 0; i < total; i++) {
          yield createMockEvent(`live-${i.toString().padStart(4, "0")}`);
        }
      })(),
    );

    // Concurrent tails must never throw; whatever they see must parse.
    for (let i = 0; i < 5; i++) {
      const { events } = await storage.getRecentEvents(10);
      for (const event of events) {
        expect(String(event.id).startsWith("live-")).toBe(true);
      }
    }

    await appendPromise;
    const { events } = await storage.getRecentEvents(1);
    expect(events[0]?.id).toBe("live-1999");
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

  it("resumes cursors at the trim horizon after ring trimming", async () => {
    for (let i = 1; i <= 130; i++) {
      await storage.append(createMockEvent(`event-${i}`));
    }

    // A from-the-start cursor lands on the oldest event still held instead of
    // replaying ids that were trimmed away.
    const all = await collectViaCursor(storage, 25);
    const { events: recent } = await storage.getRecentEvents(1000);
    expect(all.map((e) => e.id)).toEqual(recent.map((e) => e.id));
  });
});

describe("FileEventStorage", () => {
  let storage: FileEventStorage;
  let tempDir: string;
  let eventsPath: string;
  let metaPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "file-event-storage-test-"));
    eventsPath = path.join(tempDir, "events.jsonl");
    metaPath = path.join(tempDir, "events.meta.json");
    storage = new FileEventStorage(tempDir);
    await storage.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates the backing file on initialize", async () => {
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

  describe("tail reads", () => {
    it("handles the empty file", async () => {
      const { events, totalEvents, corruptLines } = await storage.getRecentEvents(50);
      expect(events).toEqual([]);
      expect(totalEvents).toBe(0);
      expect(corruptLines).toBe(0);
    });

    it("handles a single event and an exactly-limit file", async () => {
      await storage.append(createMockEvent("only"));
      expect((await storage.getRecentEvents(50)).events.map((e) => e.id)).toEqual(["only"]);

      for (let i = 2; i <= 5; i++) {
        await storage.append(createMockEvent(`event-${i}`));
      }
      const { events } = await storage.getRecentEvents(5);
      expect(events).toHaveLength(5);
      expect(events[0]?.id).toBe("only");
    });

    it("handles events larger than the initial tail window", async () => {
      // 200 KB of payload per event forces the 64 KB window to double until
      // it covers whole lines.
      const big = (id: string): ServerEvent => ({
        id: EventId(id),
        timestamp: new Date().toISOString(),
        type: "pong",
        data: { message: "x".repeat(200 * 1024), timestamp: new Date().toISOString() },
      });
      await storage.appendMany([big("big-1"), big("big-2"), createMockEvent("small-3")]);

      const { events, corruptLines } = await storage.getRecentEvents(3);
      expect(events.map((e) => e.id)).toEqual(["big-1", "big-2", "small-3"]);
      expect(corruptLines).toBe(0);
    });

    it("skips a torn final line and reports it", async () => {
      await storage.append(createMockEvent("event-1"));
      await storage.close();
      await appendFile(eventsPath, '{"id":"torn-event","timestamp":"2026-');

      const reader = new FileEventStorage(tempDir);
      await reader.initialize();
      const { events, corruptLines } = await reader.getRecentEvents(10);
      expect(events.map((e) => e.id)).toEqual(["event-1"]);
      expect(corruptLines).toBe(1);
    });

    it("skips a corrupt line mid-file and reports it", async () => {
      await storage.append(createMockEvent("event-1"));
      await appendFile(eventsPath, "%%% not json %%%\n");
      await storage.append(createMockEvent("event-2"));

      const { events, corruptLines } = await storage.getRecentEvents(10);
      expect(events.map((e) => e.id)).toEqual(["event-1", "event-2"]);
      expect(corruptLines).toBe(1);
    });
  });

  describe("cursor pages", () => {
    it("skips corrupt lines without stalling the walk", async () => {
      await storage.append(createMockEvent("event-1"));
      await appendFile(eventsPath, "%%% corrupt %%%\n");
      await storage.appendMany([createMockEvent("event-2"), createMockEvent("event-3")]);

      const first = await storage.getEventsAfter(null, 2);
      expect(first.events.map((e) => e.id)).toEqual(["event-1", "event-2"]);
      expect(first.corruptLines).toBe(1);
      expect(first.hasMore).toBe(true);

      const second = await storage.getEventsAfter(first.nextCursor, 2);
      expect(second.events.map((e) => e.id)).toEqual(["event-3"]);
      expect(second.hasMore).toBe(false);
    });

    it("cursors are stable across storage instances", async () => {
      for (let i = 0; i < 20; i++) {
        await storage.append(createMockEvent(`stable-${i.toString().padStart(2, "0")}`));
      }
      const firstPage = await storage.getEventsAfter(null, 8);

      // Resuming from another instance (fresh caches, fresh restart) must
      // continue exactly where the first walk stopped.
      const other = new FileEventStorage(tempDir);
      await other.initialize();
      const resumed = await other.getEventsAfter(firstPage.nextCursor, 100);
      expect(resumed.events[0]?.id).toBe("stable-08");
      expect(resumed.events).toHaveLength(12);
      expect(resumed.hasMore).toBe(false);
    });
  });

  describe("meta sidecar", () => {
    it("trusts the meta file when it matches the journal size (no rescan)", async () => {
      await storage.appendMany([createMockEvent("event-1"), createMockEvent("event-2")]);
      await storage.close();

      // Forge the count while keeping byteLength honest: a fresh initialize
      // that reports the forged count has provably trusted the sidecar
      // instead of rescanning the journal.
      const meta = JSON.parse(await readFile(metaPath, "utf-8"));
      expect(meta.totalEvents).toBe(2);
      meta.totalEvents = 99;
      await writeFile(metaPath, JSON.stringify(meta));

      const restarted = new FileEventStorage(tempDir);
      await restarted.initialize();
      expect(await restarted.getTotalEvents()).toBe(99);
    });

    it("rescans from the last known offset when the journal outgrew the meta", async () => {
      await storage.appendMany([createMockEvent("event-1"), createMockEvent("event-2")]);
      await storage.close();

      // Simulate a crash after two more events were written but before the
      // meta could be flushed.
      await appendFile(
        eventsPath,
        `${JSON.stringify(createMockEvent("event-3"))}\n${JSON.stringify(createMockEvent("event-4"))}\n`,
      );

      const restarted = new FileEventStorage(tempDir);
      await restarted.initialize();
      expect(await restarted.getTotalEvents()).toBe(4);
      const { events } = await restarted.getRecentEvents(1);
      expect(events[0]?.id).toBe("event-4");
    });

    it("recounts from zero when the meta file is deleted", async () => {
      await storage.appendMany([createMockEvent("event-1"), createMockEvent("event-2")]);
      await storage.close();
      await unlink(metaPath);

      const restarted = new FileEventStorage(tempDir);
      await restarted.initialize();
      expect(await restarted.getTotalEvents()).toBe(2);
    });

    it("recounts from zero when the meta claims more bytes than exist", async () => {
      await storage.appendMany([createMockEvent("event-1"), createMockEvent("event-2")]);
      await storage.close();

      const meta = JSON.parse(await readFile(metaPath, "utf-8"));
      meta.byteLength = meta.byteLength + 10_000;
      meta.totalEvents = 500;
      await writeFile(metaPath, JSON.stringify(meta));

      const restarted = new FileEventStorage(tempDir);
      await restarted.initialize();
      expect(await restarted.getTotalEvents()).toBe(2);
    });
  });

  describe("crash tolerance", () => {
    it("heals a torn tail so new appends start on a fresh line", async () => {
      await storage.append(createMockEvent("event-1"));
      await storage.close();
      await appendFile(eventsPath, '{"id":"torn-event"');

      const survivor = new FileEventStorage(tempDir);
      await survivor.initialize();
      await survivor.append(createMockEvent("event-2"));

      // The torn fragment must be isolated on its own line, not fused with
      // the new event.
      const lines = (await readFile(eventsPath, "utf-8")).split("\n").filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe('{"id":"torn-event"');

      const { events, corruptLines } = await survivor.getRecentEvents(10);
      expect(events.map((e) => e.id)).toEqual(["event-1", "event-2"]);
      expect(corruptLines).toBe(1);
      await survivor.close();
    });

    it("recovers from a dead file descriptor with one reopen", async () => {
      await storage.append(createMockEvent("event-1"));

      // Kill the held descriptor behind the storage's back (EBADF on the
      // next write) and confirm the reopen path saves the append.
      const handle = (storage as unknown as { handle: { close(): Promise<void> } }).handle;
      await handle.close();

      await storage.append(createMockEvent("event-2"));
      const { events } = await storage.getRecentEvents(10);
      expect(events.map((e) => e.id)).toEqual(["event-1", "event-2"]);
    });
  });

  it("batch appends beat the open-per-event write path by 10x or more", async () => {
    // Baseline: what the writer used to do — reopen the file by path for
    // every event. Loose bound, guards regression to open-per-event only.
    const baselinePath = path.join(tempDir, "baseline.jsonl");
    const baselineCount = 300;
    const baselineStart = performance.now();
    for (let i = 0; i < baselineCount; i++) {
      await appendFile(baselinePath, `${JSON.stringify(createMockEvent(`base-${i}`))}\n`);
    }
    const baselinePerEvent = (performance.now() - baselineStart) / baselineCount;

    const batchCount = 10_000;
    const batchStart = performance.now();
    await storage.appendMany(
      (function* (): Generator<ServerEvent> {
        for (let i = 0; i < batchCount; i++) {
          yield createMockEvent(`fast-${i}`);
        }
      })(),
    );
    const batchPerEvent = (performance.now() - batchStart) / batchCount;

    expect(await storage.getTotalEvents()).toBe(batchCount);
    expect(batchPerEvent * 10).toBeLessThanOrEqual(baselinePerEvent);
  });
});
