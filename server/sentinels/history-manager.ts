import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { TrimmingStrategy } from "../config-validation/sentinel.schema.js";
import type { CodonId } from "../types/branded-types.js";
import type {
  HankweaveAssistantModelMessage,
  HankweaveModelMessage,
  HankweaveSystemModelMessage,
  HankweaveUserModelMessage,
} from "../types/input-ai-types.js";
import { hankweaveModelMessageSchema } from "../types/input-ai-types.js";
import { type Logger, renameWithRetry } from "../utils.js";

// Simple token counter - approximate 4 chars per token
// Intent: Provide a rough estimate for pruning without external dependencies
export const simpleTokenCounter = (text: string): number => {
  return Math.ceil(text.length / 4);
};

/**
 * Manages conversation history for a single sentinel.
 * Handles loading, saving, and pruning conversation messages.
 *
 * Initialization Pattern: Lazy initialization via private ensureInitialized()
 * Rationale: Cannot await in constructor. History only needed when sentinel
 * actually triggers, so lazy loading avoids unnecessary I/O for sentinels
 * that never execute. Called automatically on first use of addMessagePair()
 * or getMessagesToSend().
 */
export class HistoryManager {
  private history: Array<{
    message: HankweaveUserModelMessage | HankweaveAssistantModelMessage;
    tokens?: number; // Actual token count if available
  }> = [];
  private readonly historyFilePath?: string; // Optional - no file if no dir provided
  private readonly trimmingStrategy: TrimmingStrategy;
  private readonly logger?: Logger;
  private isInitialized = false;
  private readonly sentinelId: string;

  constructor(
    sentinelId: string,
    codonId: CodonId,
    trimmingStrategy: TrimmingStrategy,
    sentinelDir?: string, // Optional - if not provided, no persistence
    logger?: Logger,
  ) {
    this.sentinelId = sentinelId;
    this.trimmingStrategy = trimmingStrategy;
    this.logger = logger;

    // Only set up file path if directory is provided
    if (sentinelDir) {
      const filename = `${sentinelId}-codon-${codonId}.json`;
      this.historyFilePath = path.join(sentinelDir, filename);
      this.logger?.log(
        `[HistoryManager:${this.sentinelId}] Persistence enabled at: ${this.historyFilePath}`,
        "debug",
      );
    } else {
      this.logger?.log(
        `[HistoryManager:${this.sentinelId}] Running in memory-only mode (no persistence)`,
        "info",
      );
    }
  }

  /**
   * Initialize on first use - loads history if file exists.
   * Implements lazy initialization pattern.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;

    // Load existing history if we have a file path
    if (this.historyFilePath) {
      await this.loadFromFile();
    }

    this.isInitialized = true;
  }

  /**
   * Add a complete conversation turn atomically.
   *
   * Guarantees conversation integrity by adding user+assistant messages as a pair.
   * This prevents broken conversation structure (adjacent user or assistant messages).
   *
   * If persistence is enabled, saves immediately to file using atomic write pattern.
   *
   * @param userContent - The user message content (string or object for structured output)
   * @param assistantContent - The assistant response content (string or object for structured output)
   * @param userTokens - Optional actual token count for user message (from LLM response)
   * @param assistantTokens - Optional actual token count for assistant message
   */
  public async addMessagePair(
    userContent: string | object,
    assistantContent: string | object,
    userTokens?: number,
    assistantTokens?: number,
  ): Promise<void> {
    await this.ensureInitialized();

    // Stringify if needed (for structured output objects)
    const userStr = typeof userContent === "string" ? userContent : JSON.stringify(userContent);
    const assistantStr =
      typeof assistantContent === "string" ? assistantContent : JSON.stringify(assistantContent);

    // Add both messages atomically
    this.history.push(
      {
        message: { role: "user", content: userStr },
        tokens: userTokens, // Store if provided
      },
      {
        message: { role: "assistant", content: assistantStr },
        tokens: assistantTokens, // Store if provided
      },
    );

    this.logger?.log(
      `[HistoryManager:${this.sentinelId}] Added message pair - user: ${userStr.length} chars${userTokens ? ` (${userTokens} tokens)` : ""}, assistant: ${assistantStr.length} chars${assistantTokens ? ` (${assistantTokens} tokens)` : ""}. Total messages: ${this.history.length}`,
      "debug",
    );

    // Save immediately if we have persistence enabled
    if (this.historyFilePath) {
      await this.saveToFile();
    }
  }

  /**
   * Get messages to send to LLM with automatic pruning based on strategy.
   *
   * @param systemPrompt - The system prompt to prepend to message history
   * @param forceSkipPruning - If true, skip pruning and return all history.
   *   Useful for debugging conversation state or inspecting full history
   *   without modification. Defaults to false (pruning enabled).
   * @returns Array of messages including system prompt and (pruned) history
   */
  public async getMessagesToSend(
    systemPrompt: string,
    forceSkipPruning = false,
  ): Promise<HankweaveModelMessage[]> {
    await this.ensureInitialized();

    // Prune if needed (unless explicitly skipped)
    if (!forceSkipPruning) {
      this.prune();
    }

    // Build the messages array with system prompt + history
    const messages: HankweaveModelMessage[] = [
      { role: "system", content: systemPrompt } as HankweaveSystemModelMessage,
      ...this.history.map((item) => item.message), // Extract just the message
    ];

    this.logger?.log(
      `[HistoryManager:${this.sentinelId}] Prepared ${messages.length} messages for LLM (including system prompt)`,
      "debug",
    );

    return messages;
  }

  /**
   * Prune conversation history based on configured trimming strategy.
   *
   * maxTurns Strategy:
   * - Counts complete turns (user+assistant pairs)
   * - Removes oldest complete turns to stay within limit
   * - Preserves conversation integrity (no orphaned messages)
   *
   * maxTokens Strategy:
   * - Uses actual token counts when available (from LLM responses)
   * - Falls back to estimation (text.length / 4) for older messages
   * - Removes oldest messages until under token limit
   * - May break turn pairing if individual messages exceed limit
   *
   * Called automatically before sending messages to LLM.
   */
  private prune(): void {
    if (this.trimmingStrategy.type === "maxTurns") {
      const maxTurns = this.trimmingStrategy.maxTurns;

      // Count complete turns (user + assistant pairs)
      const userMessages = this.history.filter((item) => item.message.role === "user").length;
      const assistantMessages = this.history.filter(
        (item) => item.message.role === "assistant",
      ).length;
      const completeTurns = Math.min(userMessages, assistantMessages);

      if (completeTurns > maxTurns) {
        // Remove oldest complete turns
        const turnsToRemove = completeTurns - maxTurns;
        const messagesToRemove = turnsToRemove * 2; // Each turn has user + assistant

        const removed = this.history.splice(0, messagesToRemove);
        this.logger?.log(
          `[HistoryManager:${this.sentinelId}] Pruned ${removed.length} messages (${turnsToRemove} turns) to stay within maxTurns=${maxTurns}`,
          "info",
        );
      }
    } else if (this.trimmingStrategy.type === "maxTokens") {
      const maxTokens = this.trimmingStrategy.maxTokens;

      // Calculate total tokens using actual counts when available
      let totalTokens = this.history.reduce((sum, item) => {
        // Use actual tokens if available, fall back to estimation
        if (item.tokens !== undefined) {
          return sum + item.tokens;
        } else {
          const text =
            typeof item.message.content === "string"
              ? item.message.content
              : JSON.stringify(item.message.content);
          return sum + simpleTokenCounter(text);
        }
      }, 0);

      // Remove oldest messages until under limit
      let removedCount = 0;
      while (totalTokens > maxTokens && this.history.length > 0) {
        const removed = this.history.shift();
        if (removed) {
          const tokens =
            removed.tokens ??
            (() => {
              const text =
                typeof removed.message.content === "string"
                  ? removed.message.content
                  : JSON.stringify(removed.message.content);
              return simpleTokenCounter(text);
            })();
          totalTokens -= tokens;
          removedCount++;
        }
      }

      if (removedCount > 0) {
        this.logger?.log(
          `[HistoryManager:${this.sentinelId}] Pruned ${removedCount} messages to stay within maxTokens=${maxTokens}. Remaining: ${this.history.length}`,
          "info",
        );
      }
    }
  }

  /**
   * Load conversation history from filesystem.
   *
   * Handles two formats:
   * - New format: { message, tokens } objects
   * - Old format: Direct message objects (backward compatibility)
   *
   * Validation:
   * - Each message validated against hankweaveModelMessageSchema
   * - Only user/assistant messages accepted (system/tool filtered out)
   * - Invalid messages logged and skipped
   * - High corruption rate (>20%) triggers error and fresh start
   *
   * Called automatically on first use via ensureInitialized().
   *
   * @throws Error if corruption rate exceeds 20% (allows graceful recovery)
   */
  private async loadFromFile(): Promise<void> {
    if (!this.historyFilePath) return;

    try {
      const content = await fs.readFile(this.historyFilePath, "utf-8");
      const parsed = JSON.parse(content);

      // Validate the loaded data using Hankweave schemas
      if (Array.isArray(parsed)) {
        const valid: Array<{
          message: HankweaveUserModelMessage | HankweaveAssistantModelMessage;
          tokens?: number;
        }> = [];
        const errors: string[] = [];

        for (let i = 0; i < parsed.length; i++) {
          const item = parsed[i];

          // Handle both new format (with tokens) and old format (just message)
          const messageData = "message" in item ? item.message : item;
          const tokens = "tokens" in item ? item.tokens : undefined;

          const result = hankweaveModelMessageSchema.safeParse(messageData);

          if (!result.success) {
            errors.push(`Message ${i}: Parse failed - ${result.error.message}`);
            this.logger?.log(
              `[HistoryManager:${this.sentinelId}] Failed to parse message ${i}: ${result.error.message}`,
              "error",
            );
            continue;
          }

          if (result.data.role !== "user" && result.data.role !== "assistant") {
            errors.push(`Message ${i}: Invalid role '${result.data.role}'`);
            this.logger?.log(
              `[HistoryManager:${this.sentinelId}] Invalid role at message ${i}: ${result.data.role}`,
              "error",
            );
            continue;
          }

          valid.push({
            message: result.data as HankweaveUserModelMessage | HankweaveAssistantModelMessage,
            tokens: typeof tokens === "number" ? tokens : undefined,
          });
        }

        // If more than 20% of messages are corrupt, log error and clear history
        // but don't throw fatal error - let sentinel continue with fresh history
        if (errors.length > 0) {
          const corruptionRate = errors.length / parsed.length;
          this.logger?.log(
            `[HistoryManager:${this.sentinelId}] History file has ${errors.length}/${parsed.length} invalid messages (${(corruptionRate * 100).toFixed(1)}%)`,
            "error",
          );

          if (corruptionRate > 0.2) {
            this.logger?.log(
              `[HistoryManager:${this.sentinelId}] Corruption rate too high, clearing history and starting fresh`,
              "error",
            );
            this.history = [];
            // Throw regular error to signal corruption but allow recovery
            throw new Error(
              `History file severely corrupted: ${errors.length}/${parsed.length} invalid messages. Starting with fresh history.`,
            );
          }
        }

        this.history = valid;

        this.logger?.log(
          `[HistoryManager:${this.sentinelId}] Loaded ${this.history.length} messages from file${errors.length > 0 ? ` (skipped ${errors.length} invalid)` : ""}`,
          "info",
        );
      } else {
        this.logger?.log(
          `[HistoryManager:${this.sentinelId}] Invalid history file format, starting fresh`,
          "info",
        );
        this.history = [];
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // File doesn't exist yet, that's fine
        this.logger?.log(
          `[HistoryManager:${this.sentinelId}] No existing history file, starting fresh`,
          "debug",
        );
      } else {
        this.logger?.log(
          `[HistoryManager:${this.sentinelId}] Error loading history: ${error}`,
          "error",
        );
      }
      this.history = [];
    }
  }

  /**
   * Save conversation history to filesystem using atomic write pattern.
   *
   * Atomic Write Pattern:
   * 1. Write to temp file (.tmp)
   * 2. Atomic rename to final path
   * 3. Clean up temp file on error
   *
   * This prevents corruption if save is interrupted (power loss, crash).
   *
   * File Format:
   * JSON array of { message, tokens } objects where:
   * - message: HankweaveUserModelMessage or HankweaveAssistantModelMessage
   * - tokens: Optional number (actual token count if available)
   *
   * Called automatically after each addMessagePair() if persistence enabled.
   */
  private async saveToFile(): Promise<void> {
    if (!this.historyFilePath) return;

    const tempPath = `${this.historyFilePath}.tmp`;

    try {
      // Write to temp file first (atomic write pattern)
      await fs.writeFile(tempPath, JSON.stringify(this.history, null, 2), "utf-8");

      // Atomic rename with retry for Windows file locking issues
      await renameWithRetry(tempPath, this.historyFilePath, { logger: this.logger });

      this.logger?.log(
        `[HistoryManager:${this.sentinelId}] Saved ${this.history.length} messages to file`,
        "debug",
      );
    } catch (error) {
      this.logger?.log(
        `[HistoryManager:${this.sentinelId}] Error saving history: ${error}`,
        "error",
      );

      // Clean up temp file if it exists
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
