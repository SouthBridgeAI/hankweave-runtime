import type { ServerEvent } from "../schemas/event-schemas.js";

/**
 * Interface for event storage implementations.
 * Allows pluggable storage backends (memory, file-based, etc.)
 */
export interface IEventStorage {
  /**
   * Initialize the storage (required for some implementations like file-based storage)
   */
  initialize(): Promise<void>;

  /**
   * Append a new event to storage
   */
  append(event: ServerEvent): Promise<void>;

  /**
   * Get all events from storage
   */
  getAllEvents(): Promise<ServerEvent[]>;

  /**
   * Get a slice of events by index range
   * @param startIndex Inclusive start index (0-based)
   * @param endIndex Exclusive end index
   */
  getEvents(startIndex: number, endIndex: number): Promise<ServerEvent[]>;

  /**
   * Find the index of an event matching the predicate
   * @param predicate Function to test each event
   * @returns Index of the first matching event, or -1 if not found
   */
  findEventIndex(predicate: (event: ServerEvent) => boolean): Promise<number>;

  /**
   * Find the index of an event by ID and timestamp (optimized for cursor lookups)
   * @param eventId The event ID to find
   * @param timestamp The event timestamp to find
   * @returns Index of the matching event, or -1 if not found
   */
  findEventByIdAndTimestamp(eventId: string, timestamp: string): Promise<number>;

  /**
   * Get the total number of events in storage
   */
  getTotalEvents(): Promise<number>;

  /**
   * Clear all events from storage (primarily for testing)
   */
  clear(): Promise<void>;

  /**
   * Close/cleanup storage resources
   */
  close(): Promise<void>;
}
