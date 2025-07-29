import fs from "node:fs";
import {
  type AssistantMessage,
  logMessageSchema,
  type ResultMessage,
  type SystemMessage,
} from "./claude-types/claude-session-schema.js";

/**
 * Configuration options for Claude log parser.
 */
export interface ClaudeLogParserOptions {
  /** Path to the Claude JSONL log file to parse */
  logPath: string;
  /** ID of the phase being parsed (for context) */
  phaseId: string;
  /** Callback for system messages (init, info) */
  onSystemMessage?: (msg: SystemMessage) => void;
  /** Callback for assistant messages (Claude's responses) */
  onAssistantMessage?: (msg: AssistantMessage) => void;
  /** Callback for result messages (success/error) */
  onResultMessage?: (msg: ResultMessage) => void;
  /** How often to check for new log entries (milliseconds) */
  parsingInterval: number;
}

/**
 * Real-time parser for Claude's JSON log output.
 *
 * Watches a log file and parses new lines as they're written,
 * validating them against the Claude session schema and calling
 * appropriate callbacks for each message type.
 *
 * Uses both file watching and periodic polling to ensure no
 * messages are missed.
 */
export class ClaudeLogParser {
  private buffer = ""; // Incomplete line buffer
  private lastPosition = 0; // Last read position in file
  private logTimer?: NodeJS.Timeout;
  private isFirstParse = true; // Track if this is the first parse

  constructor(private options: ClaudeLogParserOptions) {}

  start(): void {
    const { parsingInterval } = this.options;

    // Set up periodic parsing
    this.logTimer = setInterval(() => this.parseLogFile(), parsingInterval);

    // Initial parse
    this.parseLogFile();
  }

  stop(): void {
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = undefined;
    }
    // NEW: Clear buffer to free memory
    this.buffer = "";
    this.lastPosition = 0;
  }

  /**
   * Force an immediate parse of the log file.
   * Useful when we need to ensure all messages are processed before process termination.
   */
  parseNow(): void {
    this.parseLogFile();
  }

  private parseLogFile(): void {
    const { logPath } = this.options;
    if (!fs.existsSync(logPath)) {
      return;
    }

    try {
      const content = fs.readFileSync(logPath, "utf-8");

      // On first parse, read from beginning to catch any messages written before we started
      const newContent = this.isFirstParse ? content : content.slice(this.lastPosition);
      if (!newContent) {
        return;
      }

      this.buffer += newContent;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          this.parseLogLine(line);
        }
      }

      this.lastPosition = content.length - this.buffer.length;
      this.isFirstParse = false; // Mark that we've done our first parse
    } catch (error) {
      console.error(`Error parsing log: ${error}`);
    }
  }

  private parseLogLine(line: string): void {
    try {
      const result = logMessageSchema.safeParse(JSON.parse(line));
      if (!result.success) {
        return; // Skip invalid messages
      }

      const message = result.data;

      switch (message.type) {
        case "system":
          if (this.options.onSystemMessage) {
            this.options.onSystemMessage(message);
          }
          break;

        case "assistant":
          if (this.options.onAssistantMessage) {
            this.options.onAssistantMessage(message);
          }
          break;

        case "result":
          if (this.options.onResultMessage) {
            this.options.onResultMessage(message);
          }
          break;
      }
    } catch {
      // Invalid JSON, skip
    }
  }
}
