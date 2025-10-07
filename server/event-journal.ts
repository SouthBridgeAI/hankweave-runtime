import type { ServerEvent } from "./schemas/event-schemas.js";
import type { IEventStorage } from "./storage/event-storage.js";
import { MemoryEventStorage } from "./storage/memory-event-storage.js";
import type { EventCursor, PaginationDirection } from "./types/types.js";

/**
 * Event Journal System for maintaining complete history of all events
 * for new client synchronization.
 *
 * Features:
 * - Pluggable storage backends (memory, file-based)
 * - Supports complete event history retrieval
 * - Automatically trims old events when limit is exceeded
 * - Supports cursor-based pagination
 */
export class EventJournal {
  private readonly storage: IEventStorage;

  constructor(storage?: IEventStorage) {
    this.storage = storage || new MemoryEventStorage();
  }

  /**
   * Initialize the journal (required for file-based storage)
   */
  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  /**
   * Append a new event to the journal
   */
  async append(event: ServerEvent): Promise<void> {
    await this.storage.append(event);
  }

  /**
   * Get all events in the journal
   */
  async getAllEvents(): Promise<ServerEvent[]> {
    return this.storage.getAllEvents();
  }

  /**
   * Get the most recent N events (reverse chronological order)
   * @param limit Maximum number of events to return
   * @returns Object containing events, cursor for next page, and metadata
   */
  async getMostRecentEvents(limit: number): Promise<{
    events: ServerEvent[];
    cursor: EventCursor | null;
    totalEvents: number;
  }> {
    const totalEvents = await this.storage.getTotalEvents();

    // Get the most recent events
    const startIndex = Math.max(0, totalEvents - limit);
    const events = await this.storage.getEvents(startIndex, totalEvents);
    events.reverse(); // Reverse for most recent first

    // Create cursor for the next page (older events)
    let cursor: EventCursor | null = null;
    if (startIndex > 0 && events.length > 0) {
      const cursorEvents = await this.storage.getEvents(startIndex - 1, startIndex);
      if (cursorEvents.length > 0) {
        cursor = {
          timestamp: cursorEvents[0].timestamp,
          eventId: cursorEvents[0].id,
        };
      }
    }

    return {
      events,
      cursor,
      totalEvents,
    };
  }

  /**
   * Get next batch of events relative to a cursor
   * @param cursor Starting point for pagination
   * @param limit Maximum number of events to return
   * @param direction "forward" (newer) or "backward" (older)
   * @returns Object containing events, next cursor, and metadata
   */
  async getNextEvents(
    cursor: EventCursor,
    limit: number,
    direction: PaginationDirection = "backward",
  ): Promise<{
    events: ServerEvent[];
    nextCursor: EventCursor | null;
    hasMore: boolean;
  }> {
    // Find the cursor position using O(1) hash lookup
    const cursorIndex = await this.storage.findEventByIdAndTimestamp(
      cursor.eventId,
      cursor.timestamp,
    );

    if (cursorIndex === -1) {
      // Cursor not found, return empty
      return {
        events: [],
        nextCursor: null,
        hasMore: false,
      };
    }

    const totalEvents = await this.storage.getTotalEvents();
    let events: ServerEvent[];
    let nextCursor: EventCursor | null = null;
    let hasMore = false;

    if (direction === "backward") {
      // Get older events (before cursor, exclusive)
      const startIndex = Math.max(0, cursorIndex - limit);
      events = await this.storage.getEvents(startIndex, cursorIndex);
      events.reverse(); // Reverse for most recent first

      // Create cursor for next page
      if (startIndex > 0 && events.length > 0) {
        const cursorEvents = await this.storage.getEvents(startIndex - 1, startIndex);
        if (cursorEvents.length > 0) {
          nextCursor = {
            timestamp: cursorEvents[0].timestamp,
            eventId: cursorEvents[0].id,
          };
          hasMore = true;
        }
      }
    } else {
      // Get newer events (after cursor, exclusive)
      const endIndex = Math.min(totalEvents, cursorIndex + 1 + limit);
      events = await this.storage.getEvents(cursorIndex + 1, endIndex);

      // Create cursor for next page
      if (endIndex < totalEvents && events.length > 0) {
        const cursorEvents = await this.storage.getEvents(endIndex, endIndex + 1);
        if (cursorEvents.length > 0) {
          nextCursor = {
            timestamp: cursorEvents[0].timestamp,
            eventId: cursorEvents[0].id,
          };
          hasMore = true;
        }
      }
    }

    return {
      events,
      nextCursor,
      hasMore,
    };
  }

  /**
   * Get total number of events in the journal
   */
  async getTotalEvents(): Promise<number> {
    return this.storage.getTotalEvents();
  }

  /**
   * Close the journal and cleanup resources
   */
  async close(): Promise<void> {
    await this.storage.close();
  }
}
