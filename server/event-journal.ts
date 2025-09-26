import type { ServerEvent } from "./schemas/event-schemas.js";

/**
 * Event Journal System for maintaining complete history of all events
 * for new client synchronization.
 *
 * Features:
 * - Maintains configurable event history limit in memory
 * - Supports complete event history retrieval
 * - Automatically trims old events when limit is exceeded
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
}
