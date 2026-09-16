import {
  isAgenticBackboneEvent,
  isSentinelEvent,
  isServerStateEvent,
  type ServerEvent,
} from "./schemas/event-schemas.js";
import type { IEventStorage } from "./storage/event-storage.js";
import { MemoryEventStorage } from "./storage/memory-event-storage.js";

/** Page size for cursor walks over the full journal. */
const FULL_SCAN_PAGE_SIZE = 1000;

/**
 * Event Journal System that stores all events in durable storage.
 * Focuses on simple "tail" style access for initial client synchronization
 * and exposes streaming helpers for bulk export.
 */
export class EventJournal {
  private readonly storage: IEventStorage;

  constructor(storage?: IEventStorage) {
    this.storage = storage || new MemoryEventStorage();
  }

  get transport(): IEventStorage {
    return this.storage;
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  async append(event: ServerEvent): Promise<void> {
    // Only server state, agentic backbone, or sentinel events should be journaled
    if (!isServerStateEvent(event) && !isAgenticBackboneEvent(event) && !isSentinelEvent(event)) {
      throw new Error(
        `Cannot journal non-journaled event: ${event.type}. ` +
          `Only server state, agentic backbone, or sentinel events should be persisted to the event journal.`,
      );
    }
    await this.storage.append(event);
  }

  async *getAllEvents(): AsyncGenerator<ServerEvent> {
    // Cursor-paged walk: tolerant of corrupt journal lines (the storage skips
    // them) and resumable by construction.
    let cursor: string | null = null;
    while (true) {
      const page = await this.storage.getEventsAfter(cursor, FULL_SCAN_PAGE_SIZE);
      for (const event of page.events) {
        yield event;
      }
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
  }

  async getMostRecentEvents(limit: number): Promise<{
    events: ServerEvent[];
    totalEvents: number;
    hasMore: boolean;
    corruptLines: number;
  }> {
    const {
      events: recentEvents,
      totalEvents,
      corruptLines,
    } = await this.storage.getRecentEvents(limit);
    const ordered = [...recentEvents].reverse();

    return {
      events: ordered,
      totalEvents,
      hasMore: totalEvents > ordered.length,
      corruptLines,
    };
  }

  async getTotalEvents(): Promise<number> {
    return this.storage.getTotalEvents();
  }

  async streamAllEvents(): Promise<NodeJS.ReadableStream> {
    return this.storage.createReadStream();
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}
