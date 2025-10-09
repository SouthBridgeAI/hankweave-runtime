import { Readable } from "node:stream";
import type { ServerEvent } from "../schemas/event-schemas.js";
import type { IEventStorage } from "./event-storage.js";

/**
 * In-memory event storage implementation.
 * Fast and suitable for moderate event volumes.
 * Automatically trims old events when max limit is exceeded.
 */
export class MemoryEventStorage implements IEventStorage {
  private events: ServerEvent[] = [];
  private readonly maxEvents: number = 100;

  async initialize(): Promise<void> {
    // No initialization needed for memory storage
  }

  async append(event: ServerEvent): Promise<void> {
    await this.appendMany([event]);
  }

  async appendMany(events: Iterable<ServerEvent>): Promise<void> {
    let appended = 0;
    for (const event of events) {
      this.events.push(event);
      appended += 1;
    }

    if (appended === 0) {
      return;
    }

    if (this.events.length > this.maxEvents) {
      const trimCount = Math.max(1, Math.floor(this.maxEvents * 0.1));
      const excess = this.events.length - this.maxEvents;
      const totalTrim = Math.max(trimCount, excess);
      this.events = this.events.slice(totalTrim);
    }
  }

  async getRecentEvents(limit: number): Promise<{ events: ServerEvent[]; totalEvents: number }> {
    const totalEvents = this.events.length;
    const startIndex = Math.max(0, totalEvents - limit);
    const recentEvents = this.events.slice(startIndex);
    return {
      events: recentEvents,
      totalEvents,
    };
  }

  async getTotalEvents(): Promise<number> {
    return this.events.length;
  }

  async createReadStream(): Promise<NodeJS.ReadableStream> {
    const serialized = this.events.map((event) => `${JSON.stringify(event)}\n`);
    return Readable.from(serialized);
  }
}
