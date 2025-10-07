import { createInterface } from "node:readline";
import type { ServerEvent } from "./schemas/event-schemas.js";
import type { IEventStorage } from "./storage/event-storage.js";
import { MemoryEventStorage } from "./storage/memory-event-storage.js";

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

  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  async append(event: ServerEvent): Promise<void> {
    await this.storage.append(event);
  }

  async getAllEvents(): Promise<ServerEvent[]> {
    const stream = await this.storage.createReadStream();
    const reader = createInterface({
      input: stream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    const events: ServerEvent[] = [];
    for await (const rawLine of reader) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      events.push(JSON.parse(line) as ServerEvent);
    }

    return events;
  }

  async getMostRecentEvents(limit: number): Promise<{
    events: ServerEvent[];
    totalEvents: number;
    hasMore: boolean;
  }> {
    const { events: recentEvents, totalEvents } =
      await this.storage.getRecentEvents(limit);
    const ordered = [...recentEvents].reverse();

    return {
      events: ordered,
      totalEvents,
      hasMore: totalEvents > ordered.length,
    };
  }

  async getTotalEvents(): Promise<number> {
    return this.storage.getTotalEvents();
  }

  async streamAllEvents(): Promise<NodeJS.ReadableStream> {
    return this.storage.createReadStream();
  }

}
