import { Readable } from "node:stream";
import type { ServerEvent } from "../schemas/event-schemas.js";
import {
  decodeEventCursor,
  type EventPage,
  encodeEventCursor,
  type IEventStorage,
} from "./event-storage.js";

/**
 * In-memory event storage implementation.
 * Fast and suitable for moderate event volumes.
 * Automatically trims old events when max limit is exceeded.
 */
export class MemoryEventStorage implements IEventStorage {
  private events: ServerEvent[] = [];
  private readonly maxEvents: number = 100;
  /**
   * Events dropped by ring trimming, so cursor line numbers keep addressing
   * the logical append sequence even after old entries are gone.
   */
  private trimmedCount = 0;
  private closed = false;

  async initialize(): Promise<void> {
    // No initialization needed for memory storage
    this.closed = false;
  }

  async append(event: ServerEvent): Promise<void> {
    await this.appendMany([event]);
  }

  async appendMany(events: Iterable<ServerEvent>): Promise<void> {
    if (this.closed) {
      throw new Error("MemoryEventStorage is closed; cannot append");
    }

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
      this.trimmedCount += totalTrim;
    }
  }

  async getRecentEvents(limit: number): Promise<{
    events: ServerEvent[];
    totalEvents: number;
    corruptLines: number;
  }> {
    const totalEvents = this.events.length;
    const startIndex = Math.max(0, totalEvents - limit);
    const recentEvents = limit > 0 ? this.events.slice(startIndex) : [];
    return {
      events: recentEvents,
      totalEvents,
      corruptLines: 0,
    };
  }

  async getEventsAfter(cursor: string | null, limit: number): Promise<EventPage> {
    const position = cursor === null ? { segmentId: 0, lineNo: 0 } : decodeEventCursor(cursor);
    if (!position || position.segmentId !== 0) {
      throw new Error(`Invalid event cursor: ${cursor}`);
    }

    if (limit <= 0) {
      return {
        events: [],
        nextCursor: encodeEventCursor(0, position.lineNo),
        hasMore: false,
        corruptLines: 0,
      };
    }

    // Events before the ring's trim horizon are gone; a cursor pointing into
    // them resumes at the oldest event still held.
    const startIndex = Math.min(
      Math.max(0, position.lineNo - this.trimmedCount),
      this.events.length,
    );
    const events = this.events.slice(startIndex, startIndex + limit);
    const endIndex = startIndex + events.length;

    return {
      events,
      nextCursor: encodeEventCursor(0, this.trimmedCount + endIndex),
      hasMore: endIndex < this.events.length,
      corruptLines: 0,
    };
  }

  async getTotalEvents(): Promise<number> {
    return this.events.length;
  }

  async createReadStream(): Promise<NodeJS.ReadableStream> {
    const serialized = this.events.map((event) => `${JSON.stringify(event)}\n`);
    return Readable.from(serialized);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
