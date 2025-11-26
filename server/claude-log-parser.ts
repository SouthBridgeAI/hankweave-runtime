import fs from "node:fs";
import {
  type AssistantMessage,
  logMessageSchema,
  type ResultMessage,
  type SystemMessage,
  type UserMessage,
} from "./types/claude-session-schema.js";

/**
 * Configuration options for Claude log parser.
 */
export interface ClaudeLogParserOptions {
  /** Path to the Claude JSONL log file to parse */
  logPath: string;
  /** ID of the codon being parsed (for context) */
  codonId: string;
  /** Callback for system messages (init, info) */
  onSystemMessage?: (msg: SystemMessage) => void;
  /** Callback for assistant messages (Claude's responses) */
  onAssistantMessage?: (msg: AssistantMessage) => void;
  /** Callback for user messages (tool results) */
  onUserMessage?: (msg: UserMessage) => void;
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
   * Get all parsed messages from the log file.
   * Re-parses the entire log file to collect all messages.
   * Useful for analyzing the entire conversation at process completion.
   */
  getAllMessages(): Array<SystemMessage | AssistantMessage | UserMessage | ResultMessage> {
    return this.parseLogFile({ noEmit: true, fullParse: true });
  }

  /**
   * Force an immediate parse of the log file.
   * Useful when we need to ensure all messages are processed before process termination.
   */
  public parseNow(): void {
    this.parseLogFile();
  }

  /**
   * Parse the log file and return all parsed messages.
   * Supports both incremental parsing (with buffer management) and full file parsing.
   *
   * @param options.noEmit - If true, don't fire callbacks (default: false)
   * @param options.fullParse - If true, parse entire file from scratch (default: false)
   */
  private parseLogFile(options?: {
    noEmit?: boolean;
    fullParse?: boolean;
  }): Array<SystemMessage | AssistantMessage | UserMessage | ResultMessage> {
    const { logPath } = this.options;
    const { noEmit = false, fullParse = false } = options || {};
    const messages: Array<SystemMessage | AssistantMessage | UserMessage | ResultMessage> = [];

    if (!fs.existsSync(logPath)) {
      return messages;
    }

    try {
      const content = fs.readFileSync(logPath, "utf-8");

      if (fullParse) {
        // Full parse mode: parse entire file without buffer management
        const lines = content.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            const message = this.parseLogLine(line, noEmit);
            if (message) {
              messages.push(message);
            }
          }
        }
      } else {
        // Incremental parse mode: use buffer and position tracking
        // On first parse, read from beginning to catch any messages written before we started
        const newContent = this.isFirstParse ? content : content.slice(this.lastPosition);
        if (!newContent) {
          return messages;
        }

        this.buffer += newContent;
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            const message = this.parseLogLine(line, noEmit);
            if (message) {
              messages.push(message);
            }
          }
        }

        this.lastPosition = content.length - this.buffer.length;
        this.isFirstParse = false; // Mark that we've done our first parse
      }
    } catch (error) {
      console.error(`Error parsing log: ${error}`);
    }

    return messages;
  }

  private parseLogLine(
    line: string,
    noEmit = false,
  ): SystemMessage | AssistantMessage | UserMessage | ResultMessage | undefined {
    try {
      const parsed = JSON.parse(line);
      const result = logMessageSchema.safeParse(parsed);
      if (!result.success) {
        // Log validation failures for debugging - especially important for system init messages
        if (parsed.type === "system" && parsed.subtype === "init") {
          console.error(
            `[ClaudeLogParser] Failed to parse system init message for codon ${this.options.codonId}:`,
            result.error.format(),
          );
          console.error(
            `[ClaudeLogParser] Message that failed validation:`,
            JSON.stringify(parsed, null, 2),
          );
        }
        return undefined; // Skip invalid messages
      }

      const message = result.data;

      // Only emit callbacks if noEmit is false
      if (!noEmit) {
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

          case "user":
            if (this.options.onUserMessage) {
              this.options.onUserMessage(message);
            }
            break;

          case "result":
            if (this.options.onResultMessage) {
              this.options.onResultMessage(message);
            }
            break;
        }
      }

      return message;
    } catch {
      // Invalid JSON, skip
      return undefined;
    }
  }
}
