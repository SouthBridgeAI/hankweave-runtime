import fs from "node:fs";
import {
  type AssistantMessage,
  logMessageSchema,
  type ResultMessage,
  type SystemMessage,
} from "../types/claude-session-schema.js";
import { calculateCost } from "./config.js";
import type { ServerConfig, TokenUsage } from "./types.js";

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
  }

  private parseLogFile(): void {
    const { logPath } = this.options;
    if (!fs.existsSync(logPath)) return;

    try {
      const content = fs.readFileSync(logPath, "utf-8");
      const newContent = content.slice(this.lastPosition);
      if (!newContent) return;

      this.buffer += newContent;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          this.parseLogLine(line);
        }
      }

      this.lastPosition = content.length - this.buffer.length;
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

// ============================================================================
// Helper Functions for Phase State Loading
// ============================================================================

/**
 * Load phase execution state from a Claude log file.
 *
 * Used during server startup to recover previous session state.
 * Extracts:
 * - Session ID from init message
 * - Success status from result message
 * - Token usage from all assistant messages
 * - Calculated costs based on token usage
 *
 * @param logPath - Path to Claude log file
 * @param costsPerMTok - Cost configuration for calculations
 * @returns Phase state information
 */
export function loadPhaseStateFromLog(
  logPath: string,
  costsPerMTok: ServerConfig["costsPerMTok"],
): {
  sessionId: string | null;
  success: boolean;
  cost: number;
  tokens: TokenUsage;
} {
  let sessionId: string | null = null;
  let success = false;
  const tokens: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  try {
    if (!fs.existsSync(logPath)) {
      return { sessionId, success, cost: 0, tokens };
    }

    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const result = logMessageSchema.safeParse(JSON.parse(trimmed));
        if (!result.success) continue;

        const entry = result.data;

        if (entry.type === "system" && entry.subtype === "init") {
          sessionId = entry.session_id;
        }

        if (entry.type === "result" && entry.subtype === "success") {
          success = true;

          // Use final usage from result message if available
          if (entry.usage) {
            tokens.inputTokens = entry.usage.input_tokens || 0;
            tokens.outputTokens = entry.usage.output_tokens || 0;
            tokens.cacheCreationTokens = entry.usage.cache_creation_input_tokens || 0;
            tokens.cacheReadTokens = entry.usage.cache_read_input_tokens || 0;
          }

          // If total_cost_usd is provided, we'll use it directly in cost calculation
          if (entry.total_cost_usd !== undefined) {
            // Store it temporarily - we'll return it directly
            // @ts-ignore - temporary property
            tokens._totalCost = entry.total_cost_usd;
          }
        }

        // Only use assistant message usage if we haven't found result usage yet
        // @ts-ignore - temporary property
        if (entry.type === "assistant" && entry.message.usage && !tokens._totalCost) {
          // Claude reports cumulative usage, so we take the last one
          const usage = entry.message.usage;
          tokens.inputTokens = usage.input_tokens || 0;
          tokens.outputTokens = usage.output_tokens || 0;
          tokens.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
          tokens.cacheReadTokens = usage.cache_read_input_tokens || 0;
        }
      } catch {
        // Skip invalid lines
      }
    }

    // Use the total cost from result message if available, otherwise calculate
    // @ts-ignore - temporary property
    const cost =
      tokens._totalCost !== undefined
        ? // @ts-ignore - temporary property
          tokens._totalCost
        : calculateCost(tokens, costsPerMTok);

    // Clean up temporary property
    // @ts-ignore - temporary property
    delete tokens._totalCost;

    return { sessionId, success, cost, tokens };
  } catch (error) {
    console.error(`Error loading state from log ${logPath}:`, error);
    return { sessionId, success: false, cost: 0, tokens };
  }
}
