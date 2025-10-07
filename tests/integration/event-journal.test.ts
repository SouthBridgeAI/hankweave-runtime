import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventJournal } from "../../server/event-journal.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { FileEventStorage } from "../../server/storage/file-event-storage.js";
import { EventId } from "../../server/types/branded-types.js";

// Helper function to create mock events with realistic size
function createMockEvent(id: number, timestamp?: string): ServerEvent {
  return {
    id: EventId(`event-${id.toString().padStart(10, "0")}`),
    timestamp: timestamp || new Date(Date.now() + id * 1000).toISOString(),
    type: "pong",
    data: {
      message: `Test event ${id} - This is a longer message to simulate realistic event sizes with additional data that would typically be present in production events. We want to ensure the file-based storage can handle large volumes efficiently. Extra padding to make events larger: Lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
      timestamp: timestamp || new Date(Date.now() + id * 1000).toISOString(),
      clientId: `client-${Math.floor(id / 100)}`,
    },
  };
}

describe("Big Event Journal with FileEventStorage", () => {
  let tempDir: string;
  let storage: FileEventStorage;
  let journal: EventJournal;

  // Configuration for the test
  const TARGET_FILE_SIZE_MB = 200;
  const SAMPLE_EVENT = createMockEvent(0);
  const SAMPLE_EVENT_SIZE = JSON.stringify(SAMPLE_EVENT).length + 1; // +1 for newline
  const TARGET_EVENT_COUNT = Math.floor(
    (TARGET_FILE_SIZE_MB * 1024 * 1024) / SAMPLE_EVENT_SIZE
  );

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "event-journal-scaling-test-"));
    storage = new FileEventStorage(tempDir);
    journal = new EventJournal(storage);
    await journal.initialize();

    // Generate large dataset for all tests
    console.log(
      `\nGenerating dataset: ${TARGET_EVENT_COUNT.toLocaleString()} events (~${TARGET_FILE_SIZE_MB}MB)`
    );
    console.log(`Sample event size: ${SAMPLE_EVENT_SIZE} bytes`);

    const startTime = Date.now();
    let lastLogTime = startTime;

    for (let i = 0; i < TARGET_EVENT_COUNT; i++) {
      await journal.append(createMockEvent(i));

      // Log progress every 50,000 events
      if ((i + 1) % 50000 === 0) {
        const now = Date.now();
        const elapsed = now - startTime;
        const batchElapsed = now - lastLogTime;
        const eventsPerSec = Math.floor(50000 / (batchElapsed / 1000));
        console.log(
          `  Progress: ${(i + 1).toLocaleString()} events (${Math.floor(
            elapsed / 1000
          )}s, ${eventsPerSec.toLocaleString()} events/sec)`
        );
        lastLogTime = now;
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`\nGeneration complete: ${(totalTime / 1000).toFixed(2)}s`);
    console.log(
      `Average: ${Math.floor(
        TARGET_EVENT_COUNT / (totalTime / 1000)
      ).toLocaleString()} events/sec`
    );

    // Verify file size
    const eventsFilePath = join(tempDir, "events.jsonl");
    const fileStats = await stat(eventsFilePath);
    const fileSizeMB = fileStats.size / (1024 * 1024);
    console.log(`File size: ${fileSizeMB.toFixed(2)}MB`);
    console.log(`Total events in journal: ${await journal.getTotalEvents()}`);
  });

  afterAll(async () => {
    await journal.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("gets most recent events efficiently", async () => {
    const result = await journal.getMostRecentEvents(100);

    expect(result.events).toHaveLength(100);
    expect(result.events[0].id).toBe(
      EventId(`event-${(TARGET_EVENT_COUNT - 1).toString().padStart(10, "0")}`)
    );
    expect(result.events[99].id).toBe(
      EventId(
        `event-${(TARGET_EVENT_COUNT - 100).toString().padStart(10, "0")}`
      )
    );
    expect(result.cursor).not.toBeNull();
    expect(result.totalEvents).toBe(TARGET_EVENT_COUNT);
  });

  it("paginates backward through older events", async () => {
    const recentResult = await journal.getMostRecentEvents(100);
    const backwardResult = await journal.getNextEvents(
      recentResult.cursor!,
      100,
      "backward"
    );
    expect(backwardResult.events).toHaveLength(100);
    expect(backwardResult.events[0].id).toBe(
      EventId(
        `event-${(TARGET_EVENT_COUNT - 102).toString().padStart(10, "0")}`
      )
    );
    expect(backwardResult.hasMore).toBe(true);
  });

  it("paginates forward through newer events", async () => {
    const recentResult = await journal.getMostRecentEvents(100);
    const backwardResult = await journal.getNextEvents(
      recentResult.cursor!,
      100,
      "backward"
    );

    const forwardResult = await journal.getNextEvents(
      backwardResult.nextCursor!,
      50,
      "forward"
    );

    expect(forwardResult.events).toHaveLength(50);
    expect(forwardResult.events[0].id).toBe(
      EventId(
        `event-${(TARGET_EVENT_COUNT - 201).toString().padStart(10, "0")}`
      )
    );
  });

  it("handles random access from middle of dataset", async () => {
    const middleResult = await journal.getMostRecentEvents(1000);
    const middleEvent =
      middleResult.events[Math.floor(middleResult.events.length / 2)];
    const middleCursor = {
      timestamp: middleEvent.timestamp,
      eventId: middleEvent.id,
    };

    const fromMiddleResult = await journal.getNextEvents(
      middleCursor,
      50,
      "forward"
    );

    expect(fromMiddleResult.events).toHaveLength(50);
    expect(fromMiddleResult.hasMore).toBe(true);
  });

  it("handles large page sizes efficiently", async () => {
    const largePageResult = await journal.getMostRecentEvents(10000);
    expect(largePageResult.events).toHaveLength(10000);
  });

  it("handles sequential pagination", async () => {
    console.log("\nTesting sequential pagination...");

    const pageSize = 1000;
    const maxPages = 50; // Paginate through 50k events
    let retrievedCount = 0;
    let lastEventId: string | null = null;

    // Get first page
    const firstPage = await journal.getMostRecentEvents(pageSize);
    retrievedCount += firstPage.events.length;
    lastEventId = firstPage.events[firstPage.events.length - 1].id;

    // Paginate through multiple pages
    let cursor = firstPage.cursor;
    let pageCount = 1;
    while (cursor !== null && pageCount < maxPages) {
      const nextPage = await journal.getNextEvents(
        cursor,
        pageSize,
        "backward"
      );
      retrievedCount += nextPage.events.length;

      if (nextPage.events.length > 0) {
        const currentLastId = nextPage.events[nextPage.events.length - 1].id;
        expect(currentLastId).not.toBe(lastEventId); // Ensure we're moving forward
        lastEventId = currentLastId;
      }

      cursor = nextPage.nextCursor;
      pageCount++;

      // Log progress every 10 pages
      if (pageCount % 10 === 0) {
        console.log(
          `  Retrieved ${retrievedCount.toLocaleString()} events (${pageCount} pages)`
        );
      }
    }

    expect(retrievedCount).toBeGreaterThan(0);
    expect(pageCount).toBe(maxPages);
  });
});
