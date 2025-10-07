import type { ServerEvent } from "../schemas/event-schemas.js";
import type { IEventStorage } from "./event-storage.js";

/**
 * In-memory event storage implementation.
 * Fast and suitable for moderate event volumes.
 * Automatically trims old events when max limit is exceeded.
 */
export class MemoryEventStorage implements IEventStorage {
  private events: ServerEvent[] = [];
  private eventLookup: Map<string, number> = new Map();
  private readonly maxEvents: number;

  constructor(maxEvents = 10000) {
    this.maxEvents = maxEvents;
  }

  async initialize(): Promise<void> {
    // No initialization needed for memory storage
  }

  async append(event: ServerEvent): Promise<void> {
    const eventIndex = this.events.length;
    this.events.push(event);

    // Add to hash map for O(1) lookup
    const lookupKey = `${event.timestamp}:${event.id}`;
    this.eventLookup.set(lookupKey, eventIndex);

    // Trim old events if needed
    if (this.events.length > this.maxEvents) {
      const trimCount = Math.floor(this.maxEvents * 0.1); // Trim 10% when limit reached

      // Remove trimmed events from lookup map
      for (let i = 0; i < trimCount; i++) {
        const trimmedEvent = this.events[i];
        const trimmedKey = `${trimmedEvent.timestamp}:${trimmedEvent.id}`;
        this.eventLookup.delete(trimmedKey);
      }

      this.events = this.events.slice(trimCount);

      // Rebuild lookup map with updated indices
      this.eventLookup.clear();
      for (let i = 0; i < this.events.length; i++) {
        const e = this.events[i];
        const key = `${e.timestamp}:${e.id}`;
        this.eventLookup.set(key, i);
      }
    }
  }

  async getAllEvents(): Promise<ServerEvent[]> {
    return [...this.events];
  }

  async getEvents(startIndex: number, endIndex: number): Promise<ServerEvent[]> {
    return this.events.slice(startIndex, endIndex);
  }

  async findEventIndex(predicate: (event: ServerEvent) => boolean): Promise<number> {
    return this.events.findIndex(predicate);
  }

  async findEventByIdAndTimestamp(eventId: string, timestamp: string): Promise<number> {
    // O(1) hash map lookup
    const lookupKey = `${timestamp}:${eventId}`;
    const index = this.eventLookup.get(lookupKey);
    return index !== undefined ? index : -1;
  }

  async getTotalEvents(): Promise<number> {
    return this.events.length;
  }

  async clear(): Promise<void> {
    this.events = [];
    this.eventLookup.clear();
  }

  async close(): Promise<void> {
    // No resources to clean up for memory storage
  }
}
