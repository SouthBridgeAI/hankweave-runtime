import fs from "node:fs";
import readline from "node:readline";
import type { WebSocketLogEntry } from "./types/websocket-log-types.js";
import { getMessageType, isClientCommand, isServerEvent } from "./types/websocket-log-types.js";

/**
 * Utility class for reading and analyzing WebSocket JSONL logs.
 * Provides methods to filter, search, and analyze logged WebSocket traffic.
 */
export class WebSocketLogReader {
  private entries: WebSocketLogEntry[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Read and parse the JSONL log file.
   * Each line should be a valid JSON object representing a WebSocketLogEntry.
   *
   * @returns Array of parsed log entries
   */
  async readLog(): Promise<WebSocketLogEntry[]> {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    this.entries = [];

    const fileStream = fs.createReadStream(this.filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity, // Handle Windows line endings
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line) as WebSocketLogEntry;
          this.entries.push(entry);
        } catch {
          console.error(
            `Skipping unparseable log line (${line.length} bytes): ${line.slice(0, 60)}`,
          );
        }
      }
    }

    return this.entries;
  }

  /**
   * Read log synchronously (useful for scripts and testing).
   *
   * @returns Array of parsed log entries
   */
  readLogSync(): WebSocketLogEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    this.entries = [];
    const content = fs.readFileSync(this.filePath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line) as WebSocketLogEntry;
          this.entries.push(entry);
        } catch {
          console.error(
            `Skipping unparseable log line (${line.length} bytes): ${line.slice(0, 60)}`,
          );
        }
      }
    }

    return this.entries;
  }

  /**
   * Get all loaded entries.
   */
  getEntries(): WebSocketLogEntry[] {
    return this.entries;
  }

  /**
   * Filter entries by direction (incoming or outgoing).
   *
   * @param direction - "in" for client->server, "out" for server->client
   */
  filterByDirection(direction: "in" | "out"): WebSocketLogEntry[] {
    return this.entries.filter((entry) => entry.direction === direction);
  }

  /**
   * Filter entries by message type (e.g., "codon.start", "server.ready").
   *
   * @param messageType - The type field of the WebSocket message
   */
  filterByMessageType(messageType: string): WebSocketLogEntry[] {
    return this.entries.filter((entry) => getMessageType(entry.message) === messageType);
  }

  /**
   * Filter entries by time range.
   *
   * @param startTime - ISO string or Date object for start of range
   * @param endTime - ISO string or Date object for end of range
   */
  filterByTimeRange(startTime: string | Date, endTime: string | Date): WebSocketLogEntry[] {
    const start = typeof startTime === "string" ? new Date(startTime) : startTime;
    const end = typeof endTime === "string" ? new Date(endTime) : endTime;

    return this.entries.filter((entry) => {
      const entryTime = new Date(entry.loggedAt);
      return entryTime >= start && entryTime <= end;
    });
  }

  /**
   * Get all messages for a specific codon.
   *
   * @param codonId - The codon ID to filter by
   */
  getCodonMessages(codonId: string): WebSocketLogEntry[] {
    return this.entries.filter((entry) => {
      // Check if message has a data property
      if ("data" in entry.message && entry.message.data) {
        const data = entry.message.data as Record<string, unknown>;
        return data.codonId === codonId;
      }
      return false;
    });
  }

  /**
   * Get all messages for a specific session.
   *
   * @param sessionId - The session ID to filter by
   */
  getSessionMessages(sessionId: string): WebSocketLogEntry[] {
    return this.entries.filter((entry) => {
      // Check if message has a data property
      if ("data" in entry.message && entry.message.data) {
        const data = entry.message.data as Record<string, unknown>;
        return data.sessionId === sessionId;
      }
      return false;
    });
  }

  /**
   * Get all server events (outgoing messages).
   */
  getServerEvents(): WebSocketLogEntry[] {
    return this.entries.filter(
      (entry) => entry.direction === "out" && isServerEvent(entry.message),
    );
  }

  /**
   * Get all client commands (incoming messages).
   */
  getClientCommands(): WebSocketLogEntry[] {
    return this.entries.filter(
      (entry) => entry.direction === "in" && isClientCommand(entry.message),
    );
  }

  /**
   * Get statistics about the log.
   */
  getStatistics(): {
    totalEntries: number;
    incomingCount: number;
    outgoingCount: number;
    messageTypes: Record<string, number>;
    averageMessageSize: number;
    timeRange: { start: string | null; end: string | null };
  } {
    const messageTypes: Record<string, number> = {};
    let totalSize = 0;

    for (const entry of this.entries) {
      const type = getMessageType(entry.message);
      messageTypes[type] = (messageTypes[type] || 0) + 1;
      totalSize += entry.metadata?.size || 0;
    }

    const timeRange = {
      start: this.entries.length > 0 ? this.entries[0].loggedAt : null,
      end: this.entries.length > 0 ? this.entries[this.entries.length - 1].loggedAt : null,
    };

    return {
      totalEntries: this.entries.length,
      incomingCount: this.filterByDirection("in").length,
      outgoingCount: this.filterByDirection("out").length,
      messageTypes,
      averageMessageSize: this.entries.length > 0 ? Math.round(totalSize / this.entries.length) : 0,
      timeRange,
    };
  }

  /**
   * Export filtered entries to a new JSONL file.
   *
   * @param entries - The entries to export
   * @param outputPath - Path to the output file
   */
  exportToFile(entries: WebSocketLogEntry[], outputPath: string): void {
    const lines = entries.map((entry) => JSON.stringify(entry));
    fs.writeFileSync(outputPath, `${lines.join("\n")}\n`);
  }

  /**
   * Stream read the log file for memory-efficient processing of large logs.
   *
   * @param callback - Function to call for each entry
   */
  async streamRead(callback: (entry: WebSocketLogEntry) => void | Promise<void>): Promise<void> {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const fileStream = fs.createReadStream(this.filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line) as WebSocketLogEntry;
          await callback(entry);
        } catch {
          console.error(
            `Skipping unparseable log line (${line.length} bytes): ${line.slice(0, 60)}`,
          );
        }
      }
    }
  }
}

/**
 * Helper function to quickly read a WebSocket log file.
 *
 * @param filePath - Path to the JSONL log file
 * @returns Array of parsed log entries
 */
export async function readWebSocketLog(filePath: string): Promise<WebSocketLogEntry[]> {
  const reader = new WebSocketLogReader(filePath);
  return reader.readLog();
}

/**
 * Helper function to get statistics from a WebSocket log file.
 *
 * @param filePath - Path to the JSONL log file
 */
export async function getWebSocketLogStats(
  filePath: string,
): Promise<ReturnType<WebSocketLogReader["getStatistics"]>> {
  const reader = new WebSocketLogReader(filePath);
  await reader.readLog();
  return reader.getStatistics();
}
