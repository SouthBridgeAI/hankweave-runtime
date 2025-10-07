import { promises as fs } from "node:fs";
import { open } from "node:fs/promises";
import * as path from "node:path";
import type { ServerEvent } from "../schemas/event-schemas.js";
import type { IEventStorage } from "./event-storage.js";

/**
 * File-based event storage implementation using JSONL format with indexing.
 * Designed for handling very large event volumes without loading everything into memory.
 *
 * Storage format:
 * - events.jsonl: JSON Lines file with one event per line
 * - events.index: Binary index file mapping event indices to byte offsets
 *
 * Features:
 * - append to end of file
 * - Efficient random access via index
 * - No automatic trimming - designed for unbounded event storage
 */
export class FileEventStorage implements IEventStorage {
  private readonly eventsFilePath: string;
  private readonly indexFilePath: string;

  // In-memory index: array of byte offsets for each event
  private index: number[] = [];

  // Hash map for O(1) event lookup by ID+timestamp
  private eventLookup: Map<string, number> = new Map();

  // File handle for writing (kept open for performance)
  private eventsFileHandle: Awaited<ReturnType<typeof open>> | null = null;

  // Track if index needs to be written
  private indexDirty = false;

  constructor(storagePath: string) {
    this.eventsFilePath = path.join(storagePath, "events.jsonl");
    this.indexFilePath = path.join(storagePath, "events.index");
  }

  /**
   * Initialize the storage by loading the index
   */
  async initialize(): Promise<void> {
    // Ensure storage directory exists
    await fs.mkdir(path.dirname(this.eventsFilePath), { recursive: true });

    // Load index if it exists
    try {
      const indexBuffer = await fs.readFile(this.indexFilePath);
      // Index file stores 8-byte (64-bit) offsets
      const numOffsets = indexBuffer.length / 8;
      this.index = [];
      for (let i = 0; i < numOffsets; i++) {
        this.index.push(Number(indexBuffer.readBigUInt64LE(i * 8)));
      }

      // Rebuild hash map for O(1) lookups
      this.eventLookup.clear();
      for (let i = 0; i < this.index.length; i++) {
        const event = await this.getEventAt(i);
        const lookupKey = `${event.timestamp}:${event.id}`;
        this.eventLookup.set(lookupKey, i);
      }
    } catch (error) {
      // Index file doesn't exist yet, start with empty index
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.index = [];
    }

    // Open events file for appending
    try {
      this.eventsFileHandle = await open(this.eventsFilePath, "a+");
    } catch (error) {
      // File doesn't exist yet, will be created on first append
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async append(event: ServerEvent): Promise<void> {
    // Ensure file handle is open
    if (!this.eventsFileHandle) {
      this.eventsFileHandle = await open(this.eventsFilePath, "a+");
    }

    // Get current file size (this is where we'll write)
    const stats = await this.eventsFileHandle.stat();
    const offset = stats.size;

    // Serialize event as JSON + newline
    const line = `${JSON.stringify(event)}\n`;

    // Append to events file
    await this.eventsFileHandle.write(line);

    // Add offset to index
    const eventIndex = this.index.length;
    this.index.push(offset);

    // Add to hash map for O(1) lookup
    const lookupKey = `${event.timestamp}:${event.id}`;
    this.eventLookup.set(lookupKey, eventIndex);

    // Mark index as dirty (will be written on close)
    this.indexDirty = true;
  }

  async getAllEvents(): Promise<ServerEvent[]> {
    const events: ServerEvent[] = [];
    for (let i = 0; i < this.index.length; i++) {
      events.push(await this.getEventAt(i));
    }
    return events;
  }

  async getEvents(startIndex: number, endIndex: number): Promise<ServerEvent[]> {
    const events: ServerEvent[] = [];
    const actualEnd = Math.min(endIndex, this.index.length);
    const actualStart = Math.max(0, startIndex);

    for (let i = actualStart; i < actualEnd; i++) {
      events.push(await this.getEventAt(i));
    }

    return events;
  }

  async findEventIndex(predicate: (event: ServerEvent) => boolean): Promise<number> {
    // Linear search through events
    for (let i = 0; i < this.index.length; i++) {
      const event = await this.getEventAt(i);
      if (predicate(event)) {
        return i;
      }
    }
    return -1;
  }

  async findEventByIdAndTimestamp(eventId: string, timestamp: string): Promise<number> {
    // O(1) hash map lookup
    const lookupKey = `${timestamp}:${eventId}`;
    const index = this.eventLookup.get(lookupKey);
    return index !== undefined ? index : -1;
  }

  async getTotalEvents(): Promise<number> {
    return this.index.length;
  }

  async clear(): Promise<void> {
    // Close file handle
    if (this.eventsFileHandle) {
      await this.eventsFileHandle.close();
      this.eventsFileHandle = null;
    }

    // Clear files
    try {
      await fs.unlink(this.eventsFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await fs.unlink(this.indexFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    // Clear in-memory state
    this.index = [];
    this.eventLookup.clear();
  }

  async close(): Promise<void> {
    // Write index if it has changes
    if (this.indexDirty) {
      await this.writeIndex();
      this.indexDirty = false;
    }

    // Close file handle
    if (this.eventsFileHandle) {
      await this.eventsFileHandle.close();
      this.eventsFileHandle = null;
    }
  }

  /**
   * Get an event at a specific index
   */
  private async getEventAt(index: number): Promise<ServerEvent> {
    // Read from file
    const offset = this.index[index];
    const nextOffset = index + 1 < this.index.length ? this.index[index + 1] : undefined;

    const fileHandle = await open(this.eventsFilePath, "r");
    try {
      // Calculate line length
      let length: number;
      if (nextOffset !== undefined) {
        length = nextOffset - offset;
      } else {
        // Last event - read to end of file
        const stats = await fileHandle.stat();
        length = stats.size - offset;
      }

      // Read the line
      const buffer = Buffer.alloc(length);
      await fileHandle.read(buffer, 0, length, offset);

      // Parse JSON (trim newline)
      const line = buffer.toString("utf-8").trim();
      const event = JSON.parse(line) as ServerEvent;

      return event;
    } finally {
      await fileHandle.close();
    }
  }

  /**
   * Write the index to disk
   */
  private async writeIndex(): Promise<void> {
    // Create buffer with 8 bytes per offset
    const buffer = Buffer.alloc(this.index.length * 8);

    for (let i = 0; i < this.index.length; i++) {
      buffer.writeBigUInt64LE(BigInt(this.index[i]), i * 8);
    }

    await fs.writeFile(this.indexFilePath, buffer);
  }
}
