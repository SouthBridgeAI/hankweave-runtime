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
   * Retrieve the most recent events in chronological order (oldest first)
   * along with the total number of events persisted.
   * @param limit Maximum number of events to return
   */
  getRecentEvents(limit: number): Promise<{
    events: ServerEvent[];
    totalEvents: number;
  }>;

  /**
   * Get the total number of events in storage
   */
  getTotalEvents(): Promise<number>;

  /**
   * Create a readable stream of the underlying event log for download/streaming.
   */
  createReadStream(): Promise<NodeJS.ReadableStream>;
}
