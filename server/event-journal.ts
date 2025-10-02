import type { ServerEvent } from "./schemas/event-schemas.js";
import type { EventCursor, PaginationDirection } from "./types/types.js";

/**
 * Event Journal System for maintaining complete history of all events
 * for new client synchronization.
 *
 * Features:
 * - Maintains configurable event history limit in memory
 * - Supports complete event history retrieval
 * - Automatically trims old events when limit is exceeded
 * - Supports cursor-based pagination
 */
export class EventJournal {
  private events: ServerEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 10000) {
    this.maxEvents = maxEvents;
  }

  /**
   * Append a new event to the journal
   */
  append(event: ServerEvent): void {
    this.events.push(event);

    // Trim old events if needed
    if (this.events.length > this.maxEvents) {
      const trimCount = Math.floor(this.maxEvents * 0.1); // Trim 10% when limit reached
      this.events = this.events.slice(trimCount);
    }
  }

  /**
   * Get all events in the journal
   */
  getAllEvents(): ServerEvent[] {
    return [...this.events];
  }

  /**
   * Get the most recent N events (reverse chronological order)
   * @param limit Maximum number of events to return
   * @returns Object containing events, cursor for next page, and metadata
   */
  getMostRecentEvents(limit: number): {
    events: ServerEvent[];
    cursor: EventCursor | null;
    totalEvents: number;
  } {
    const totalEvents = this.events.length;

    // Get the most recent events
    const startIndex = Math.max(0, totalEvents - limit);
    const events = this.events.slice(startIndex).reverse(); // Reverse for most recent first

    // Create cursor for the next page (older events)
    const cursor: EventCursor | null =
      startIndex > 0 && events.length > 0
        ? {
            timestamp: this.events[startIndex - 1].timestamp,
            eventId: this.events[startIndex - 1].id,
          }
        : null;

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
  getNextEvents(
    cursor: EventCursor,
    limit: number,
    direction: PaginationDirection = "backward",
  ): {
    events: ServerEvent[];
    nextCursor: EventCursor | null;
    hasMore: boolean;
  } {
    // Find the cursor position
    const cursorIndex = this.events.findIndex(
      (e) => e.timestamp === cursor.timestamp && e.id === cursor.eventId,
    );

    if (cursorIndex === -1) {
      // Cursor not found, return empty
      return {
        events: [],
        nextCursor: null,
        hasMore: false,
      };
    }

    let events: ServerEvent[];
    let nextCursor: EventCursor | null = null;
    let hasMore = false;

    if (direction === "backward") {
      // Get older events (before cursor)
      const startIndex = Math.max(0, cursorIndex - limit);
      events = this.events.slice(startIndex, cursorIndex).reverse(); // Reverse for most recent first

      // Create cursor for next page
      if (startIndex > 0 && events.length > 0) {
        nextCursor = {
          timestamp: this.events[startIndex - 1].timestamp,
          eventId: this.events[startIndex - 1].id,
        };
        hasMore = true;
      }
    } else {
      // Get newer events (after cursor)
      const endIndex = Math.min(this.events.length, cursorIndex + 1 + limit);
      events = this.events.slice(cursorIndex + 1, endIndex);

      // Create cursor for next page
      if (endIndex < this.events.length && events.length > 0) {
        nextCursor = {
          timestamp: this.events[endIndex].timestamp,
          eventId: this.events[endIndex].id,
        };
        hasMore = true;
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
  getTotalEvents(): number {
    return this.events.length;
  }
}
