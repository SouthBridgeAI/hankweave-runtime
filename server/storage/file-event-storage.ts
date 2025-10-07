import { createReadStream as createFileReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import * as path from "node:path";
import type { ServerEvent } from "../schemas/event-schemas.js";
import type { IEventStorage } from "./event-storage.js";

/**
 * Minimal file-based event storage that keeps an append-only JSONL log.
 * Suitable for durable persistence while keeping the implementation simple.
 */
export class FileEventStorage implements IEventStorage {
  private readonly eventsFilePath: string;
  private totalEvents = 0;

  constructor(storagePath: string) {
    this.eventsFilePath = path.join(storagePath, "events.jsonl");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.eventsFilePath), { recursive: true });

    try {
      await fs.access(this.eventsFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await fs.writeFile(this.eventsFilePath, "");
      } else {
        throw error;
      }
    }

    this.totalEvents = await this.countExistingEvents();
  }

  async append(event: ServerEvent): Promise<void> {
    const serialized = `${JSON.stringify(event)}\n`;
    await fs.appendFile(this.eventsFilePath, serialized);
    this.totalEvents += 1;
  }

  async getRecentEvents(
    limit: number
  ): Promise<{ events: ServerEvent[]; totalEvents: number }> {
    if (limit <= 0) {
      return {
        events: [],
        totalEvents: this.totalEvents,
      };
    }

    const recent: ServerEvent[] = [];

    try {
      const stream = createFileReadStream(this.eventsFilePath, {
        encoding: "utf-8",
      });
      const lineReader = createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY,
      });

      for await (const rawLine of lineReader) {
        const line = rawLine.trim();
        if (line.length === 0) continue;

        const event = JSON.parse(line) as ServerEvent;
        if (recent.length === limit) {
          recent.shift();
        }
        recent.push(event);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    return {
      events: recent,
      totalEvents: this.totalEvents,
    };
  }

  async getTotalEvents(): Promise<number> {
    return this.totalEvents;
  }

  async createReadStream(): Promise<NodeJS.ReadableStream> {
    return createFileReadStream(this.eventsFilePath, { encoding: "utf-8" });
  }

  private async countExistingEvents(): Promise<number> {
    let count = 0;

    try {
      const stream = createFileReadStream(this.eventsFilePath, {
        encoding: "utf-8",
      });
      const lineReader = createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY,
      });

      for await (const rawLine of lineReader) {
        if (rawLine.trim().length === 0) continue;
        count += 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    return count;
  }
}
