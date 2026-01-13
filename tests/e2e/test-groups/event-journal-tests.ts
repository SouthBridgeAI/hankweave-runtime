import { expect, it } from "bun:test";
import * as fs from "node:fs";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type {
  CodonCompletedEvent,
  CodonStartedEvent,
  ErrorEvent,
  ServerEvent,
} from "../../../server/schemas/event-schemas.js";

interface TestState {
  executionPath?: string;
  events: ServerEvent[];
  historyEvents: ServerEvent[];
  liveEvents: ServerEvent[];
  codon1Started: CodonStartedEvent | null;
  codon1Completed: CodonCompletedEvent | null;
  codon2Started: CodonStartedEvent | null;
  codon2Completed: CodonCompletedEvent | null;
  codon3Started: CodonStartedEvent | null;
  codon3Completed: CodonCompletedEvent | null;
  errorEvents: ErrorEvent[];
}

/**
 * Helper to read all events from the event journal
 */
async function readEventJournal(journalPath: string): Promise<ServerEvent[]> {
  const events: ServerEvent[] = [];

  if (!fs.existsSync(journalPath)) {
    return events;
  }

  const stream = createReadStream(journalPath, { encoding: "utf-8" });
  const reader = createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of reader) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as ServerEvent);
    } catch (error) {
      console.warn(`Failed to parse event journal line: ${error}`);
    }
  }

  return events;
}

/**
 * Filter events by type
 */
function filterEventsByType<T extends ServerEvent>(events: ServerEvent[], type: string): T[] {
  return events.filter((e) => e.type === type) as T[];
}

/**
 * Filter events by codon ID
 */
function filterEventsByCodonId(events: ServerEvent[], codonId: string): ServerEvent[] {
  return events.filter((e) => {
    if ("data" in e && e.data && typeof e.data === "object" && "codonId" in e.data) {
      return e.data.codonId === codonId;
    }
    return false;
  });
}

/**
 * Filter events by session ID
 */
function filterEventsBySessionId(events: ServerEvent[], sessionId: string): ServerEvent[] {
  return events.filter((e) => {
    if ("data" in e && e.data && typeof e.data === "object" && "sessionId" in e.data) {
      return e.data.sessionId === sessionId;
    }
    return false;
  });
}

export function runEventJournalTests(testState: TestState): void {
  const getEventJournalPath = () => {
    if (!testState.executionPath) {
      throw new Error("Execution path not available");
    }
    return path.join(testState.executionPath, ".hankweave/events/events.jsonl");
  };

  it("should create event journal file", () => {
    const journalPath = getEventJournalPath();
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  it("should journal events in JSONL format", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    // Should have events
    expect(events.length).toBeGreaterThan(0);

    // Each event should be valid
    events.forEach((event) => {
      expect(event).toHaveProperty("id");
      expect(event).toHaveProperty("timestamp");
      expect(event).toHaveProperty("type");
    });
  });

  it("should journal codon lifecycle events", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    // Check codon.started events
    const codonStartedEvents = filterEventsByType<CodonStartedEvent>(events, "codon.started");
    expect(codonStartedEvents.length).toBe(3); // 3 codons

    codonStartedEvents.forEach((event) => {
      expect(event.type).toBe("codon.started");
      expect(event.data).toHaveProperty("codonId");
      expect(event.data).toHaveProperty("sessionId");
    });

    // Check codon.completed events
    const codonCompletedEvents = filterEventsByType<CodonCompletedEvent>(events, "codon.completed");
    expect(codonCompletedEvents.length).toBe(3); // 3 codons

    codonCompletedEvents.forEach((event) => {
      expect(event.type).toBe("codon.completed");
      expect(event.data).toHaveProperty("codonId");
    });
  });

  it("should track events for each codon", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    // Codon 1 events
    const codon1Events = filterEventsByCodonId(events, "codon-1");
    expect(codon1Events.length).toBeGreaterThan(0);

    // Codon 2 events
    const codon2Events = filterEventsByCodonId(events, "codon-2");
    expect(codon2Events.length).toBeGreaterThan(0);

    // Codon 3 events
    const codon3Events = filterEventsByCodonId(events, "codon-3");
    expect(codon3Events.length).toBeGreaterThan(0);
  });

  it("should track session IDs in journal", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    // Get session IDs from codon started events
    const codonStartedEvents = filterEventsByType<CodonStartedEvent>(events, "codon.started");
    const sessionIds = new Set<string>();

    codonStartedEvents.forEach((event) => {
      if (event.data?.sessionId) {
        sessionIds.add(event.data.sessionId);
      }
    });

    // Should have at least one session ID
    expect(sessionIds.size).toBeGreaterThan(0);

    // Check events for each session
    sessionIds.forEach((sessionId) => {
      const sessionEvents = filterEventsBySessionId(events, sessionId);
      expect(sessionEvents.length).toBeGreaterThan(0);
    });
  });

  it("should journal assistant.action events", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    const assistantActions = filterEventsByType(events, "assistant.action");
    expect(assistantActions.length).toBeGreaterThan(0);

    assistantActions.forEach((action) => {
      expect(action.type).toBe("assistant.action");
    });
  });

  it("should journal token.usage events", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    const tokenUsageEvents = filterEventsByType(events, "token.usage");
    expect(tokenUsageEvents.length).toBeGreaterThan(0);

    tokenUsageEvents.forEach((event) => {
      expect(event.type).toBe("token.usage");
    });
  });

  it("should journal tool.result events", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    const toolResultEvents = filterEventsByType(events, "tool.result");
    // Tool results are expected in this test
    expect(toolResultEvents.length).toBeGreaterThan(0);

    toolResultEvents.forEach((event) => {
      expect(event.type).toBe("tool.result");

      if (event.type === "tool.result") {
        const data = event.data;
        expect(data).toHaveProperty("toolUseId");
        expect(data).toHaveProperty("toolName");
        expect(data).toHaveProperty("executionTimeMs");
      }
    });
  });

  it("should journal file.updated events", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    const fileUpdatedEvents = filterEventsByType(events, "file.updated");
    // File updates are expected when Claude creates files
    expect(fileUpdatedEvents.length).toBeGreaterThan(0);

    fileUpdatedEvents.forEach((event) => {
      expect(event.type).toBe("file.updated");

      if (event.type === "file.updated") {
        const data = event.data;
        expect(data).toHaveProperty("path");
        expect(data).toHaveProperty("action");
        expect(["created", "modified", "deleted"]).toContain(data.action);
      }
    });
  });

  it("should maintain chronological order", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    // Check that timestamps are in order
    for (let i = 1; i < events.length; i++) {
      const prevTime = new Date(events[i - 1].timestamp).getTime();
      const currTime = new Date(events[i].timestamp).getTime();
      expect(currTime).toBeGreaterThanOrEqual(prevTime);
    }
  });

  it("should verify complete codon execution flow in journal", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    // For each codon, verify the expected event flow
    ["codon-1", "codon-2", "codon-3"].forEach((codonId) => {
      const codonEvents = filterEventsByCodonId(events, codonId);

      // Should have codon.started
      const started = codonEvents.find((e) => {
        if (e.type === "codon.started") {
          return e.data?.codonId === codonId;
        }
        return false;
      });
      expect(started).toBeDefined();

      // Should have codon.completed
      const completed = codonEvents.find((e) => {
        if (e.type === "codon.completed") {
          return e.data?.codonId === codonId;
        }
        return false;
      });
      expect(completed).toBeDefined();

      // Should have some activity between start and complete
      const activityEvents = codonEvents.filter(
        (e) =>
          e.type === "assistant.action" || e.type === "token.usage" || e.type === "tool.result",
      );
      expect(activityEvents.length).toBeGreaterThan(0);
    });
  });

  it("should only contain server state events (no connection state events)", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    // Connection state events like server.ready and pong should NOT be in the journal
    const serverReadyEvents = filterEventsByType(events, "server.ready");
    const pongEvents = filterEventsByType(events, "pong");
    const historyBatchEvents = filterEventsByType(events, "history.batch");

    expect(serverReadyEvents.length).toBe(0);
    expect(pongEvents.length).toBe(0);
    expect(historyBatchEvents.length).toBe(0);
  });

  it("should journal server.idle events", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    // server.idle is a server state event and should be journaled
    const idleEvents = filterEventsByType(events, "server.idle");
    // May or may not have idle events depending on test configuration
    if (idleEvents.length > 0) {
      idleEvents.forEach((event) => {
        expect(event.type).toBe("server.idle");
      });
    }
  });

  it("should journal state.snapshot events", async () => {
    const journalPath = getEventJournalPath();
    const events = await readEventJournal(journalPath);

    // state.snapshot is a server state event and should be journaled
    const snapshotEvents = filterEventsByType(events, "state.snapshot");
    expect(snapshotEvents.length).toBeGreaterThan(0);

    snapshotEvents.forEach((event) => {
      expect(event.type).toBe("state.snapshot");
      if (event.type === "state.snapshot") {
        expect(event.data).toHaveProperty("totalCost");
        expect(event.data).toHaveProperty("totalTime");
      }
    });
  });

  it("should verify synced events match journal file line by line", async () => {
    const journalPath = getEventJournalPath();
    const journaledEvents = await readEventJournal(journalPath);

    // Combine history and live events
    const syncedEvents = [...testState.historyEvents, ...testState.liveEvents];

    // Should have synced events
    expect(syncedEvents.length).toBeGreaterThan(0);

    // Should have journaled events
    expect(journaledEvents.length).toBeGreaterThan(0);

    // syncedEvents are already filtered to only include Server State Events in setup
    // All journaled events are also server state events
    // They should match exactly in count and content
    expect(syncedEvents.length).toBe(journaledEvents.length);

    // Compare each synced event with the corresponding journaled event
    for (let i = 0; i < syncedEvents.length; i++) {
      const syncedEvent = syncedEvents[i];
      const journaledEvent = journaledEvents[i];

      // Events should match exactly
      expect(syncedEvent.id).toBe(journaledEvent.id);
      expect(syncedEvent.timestamp).toBe(journaledEvent.timestamp);
      expect(syncedEvent.type).toBe(journaledEvent.type);

      // Deep comparison of data
      expect(JSON.stringify(syncedEvent.data)).toBe(JSON.stringify(journaledEvent.data));
    }
  });
}
