import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ClaudeLogParser } from "../../server/claude-log-parser.js";
import { calculateCost } from "../../server/config.js";
import type { AssistantMessage, ResultMessage } from "../../server/types/claude-session-schema.js";
import { logMessageSchema } from "../../server/types/claude-session-schema.js";
import type { TokenUsage } from "../../server/types/types.js";

// Local helper for testing log parsing - replaces the removed loadCodonStateFromLog
function parseLogForTesting(
  logPath: string,
  costsPerMTok: {
    input: number;
    output: number;
    inputCache: number;
    cacheRead: number;
  },
): {
  sessionId: string | null;
  success: boolean;
  cost: number;
  tokens: TokenUsage;
} {
  let sessionId: string | null = null;
  let success = false;
  const tokens: TokenUsage & { _totalCost?: number } = {
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

        if (entry.type === "result") {
          // Mark success only if subtype is "success" AND is_error is false
          if (entry.subtype === "success" && !entry.is_error) {
            success = true;
          }

          // Use final usage from result message if available (for both success and error)
          if (entry.usage) {
            tokens.inputTokens = entry.usage.input_tokens || 0;
            tokens.outputTokens = entry.usage.output_tokens || 0;
            tokens.cacheCreationTokens = entry.usage.cache_creation_input_tokens || 0;
            tokens.cacheReadTokens = entry.usage.cache_read_input_tokens || 0;
          }

          // If total_cost_usd is provided, we'll use it directly in cost calculation
          if (entry.total_cost_usd !== undefined) {
            // Store it temporarily - we'll return it directly
            tokens._totalCost = entry.total_cost_usd;
          }
        }

        // Only use assistant message usage if we haven't found result usage yet
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
    const tokensWithCost = tokens as TokenUsage & { _totalCost?: number };
    const cost =
      tokensWithCost._totalCost !== undefined
        ? tokensWithCost._totalCost
        : calculateCost(tokens, costsPerMTok);

    // Clean up temporary property
    if (tokensWithCost._totalCost !== undefined) {
      delete tokensWithCost._totalCost;
    }

    return { sessionId, success, cost, tokens };
  } catch (error) {
    console.error(`Error loading state from log ${logPath}:`, error);
    return { sessionId, success: false, cost: 0, tokens };
  }
}

describe("Claude Log Parser", () => {
  const testDir = path.join(import.meta.dir, "test-logs");
  const logPath = path.join(testDir, "test-timeout.jsonl");

  beforeEach(() => {
    // Create test directory
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe("Parsing timeout messages", () => {
    test("should parse assistant message with timeout error", async () => {
      const messages: Array<AssistantMessage | null> = [];

      const parser = new ClaudeLogParser({
        logPath,
        codonId: "test-codon",
        parsingInterval: 50,
        onAssistantMessage: (msg) => messages.push(msg),
      });

      // Write a timeout message to the log
      const timeoutMessage = {
        type: "assistant",
        message: {
          id: "msg_01234",
          type: "message",
          role: "assistant",
          model: "claude-3-opus-20240229",
          content: [
            {
              type: "text",
              text: "API Error: Request timed out.",
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
        },
      };

      fs.writeFileSync(logPath, `${JSON.stringify(timeoutMessage)}\n`);

      parser.start();

      // Wait for parsing
      await new Promise((resolve) => setTimeout(resolve, 100));

      parser.stop();

      expect(messages).toHaveLength(1);
      expect(messages[0]).not.toBeNull();
      const content = messages[0]?.message.content;
      const textContent = Array.isArray(content)
        ? content.find((item) => item.type === "text")?.text
        : content;
      expect(textContent).toBe("API Error: Request timed out.");
    });

    test("should parse result message with timeout error", async () => {
      const results: Array<ResultMessage | null> = [];

      const parser = new ClaudeLogParser({
        logPath,
        codonId: "test-codon",
        parsingInterval: 50,
        onResultMessage: (msg) => results.push(msg),
      });

      // Write a timeout result message
      const timeoutResult = {
        type: "result",
        subtype: "error",
        is_error: true,
        duration_ms: 1253987,
        duration_api_ms: 414469,
        num_turns: 319,
        result: "API Error: Request timed out.",
        session_id: "374bf5fd-dc81-4fe4-bb06-a92b30c79227",
        total_cost_usd: 0.9070275,
        usage: {
          input_tokens: 39,
          output_tokens: 12279,
          cache_creation_input_tokens: 153466,
          cache_read_input_tokens: 490760,
        },
      };

      fs.writeFileSync(logPath, `${JSON.stringify(timeoutResult)}\n`);

      parser.start();

      // Wait for parsing
      await new Promise((resolve) => setTimeout(resolve, 100));

      parser.stop();

      expect(results).toHaveLength(1);
      expect(results[0]).not.toBeNull();
      expect(results[0]?.subtype).toBe("error");
      expect(results[0]?.result).toBe("API Error: Request timed out.");
    });
  });

  describe("Loading codon state with timeout", () => {
    test("should correctly load state from log with timeout error", () => {
      // Create a log file with init, assistant messages, and timeout result
      const logContent = `${[
        JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: "/test",
          session_id: "374bf5fd-dc81-4fe4-bb06-a92b30c79227",
          tools: ["Read", "Write"],
          mcp_servers: [],
          model: "claude-3-opus-20240229",
          permissionMode: "bypassPermissions",
          apiKeySource: "ANTHROPIC_API_KEY",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_01234",
            type: "message",
            role: "assistant",
            model: "claude-3-opus-20240229",
            content: [
              {
                type: "text",
                text: "Working on the task...",
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 10,
              cache_read_input_tokens: 20,
            },
            stop_reason: "end_turn",
            stop_sequence: null,
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_01235",
            type: "message",
            role: "assistant",
            model: "claude-3-opus-20240229",
            content: [
              {
                type: "text",
                text: "API Error: Request timed out.",
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
          },
        }),
        JSON.stringify({
          type: "result",
          subtype: "error",
          is_error: true,
          duration_ms: 1253987,
          duration_api_ms: 414469,
          num_turns: 2,
          result: "API Error: Request timed out.",
          session_id: "374bf5fd-dc81-4fe4-bb06-a92b30c79227",
          total_cost_usd: 0.05,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
          },
        }),
      ].join("\n")}\n`; // Add trailing newline

      fs.writeFileSync(logPath, logContent);

      const state = parseLogForTesting(logPath, {
        input: 15,
        output: 75,
        inputCache: 18.75,
        cacheRead: 1.5,
      });

      expect(state.sessionId).toBe("374bf5fd-dc81-4fe4-bb06-a92b30c79227");
      expect(state.success).toBe(false); // Codon failed due to timeout
      expect(state.cost).toBe(0.05); // Uses the total_cost_usd from result
      expect(state.tokens.inputTokens).toBe(100);
      expect(state.tokens.outputTokens).toBe(50);
    });
  });

  describe("getAllMessages()", () => {
    test("should return all messages from a complete log file", () => {
      // Create a log file with all message types
      const logContent = `${[
        JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: "/test",
          session_id: "test-session-123",
          tools: ["Read", "Write"],
          mcp_servers: [],
          model: "claude-3-opus-20240229",
          permissionMode: "bypassPermissions",
          apiKeySource: "ANTHROPIC_API_KEY",
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "Hello, Claude!",
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_01234",
            type: "message",
            role: "assistant",
            model: "claude-3-opus-20240229",
            content: [
              {
                type: "text",
                text: "Hello! How can I help you?",
              },
            ],
            usage: {
              input_tokens: 50,
              output_tokens: 25,
              cache_creation_input_tokens: 5,
              cache_read_input_tokens: 10,
            },
            stop_reason: "end_turn",
            stop_sequence: null,
          },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 5000,
          duration_api_ms: 3000,
          num_turns: 1,
          result: "Task completed successfully",
          session_id: "test-session-123",
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 50,
            output_tokens: 25,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 10,
          },
        }),
      ].join("\n")}\n`;

      fs.writeFileSync(logPath, logContent);

      const parser = new ClaudeLogParser({
        logPath,
        codonId: "test-codon",
        parsingInterval: 50,
      });

      const messages = parser.getAllMessages();

      expect(messages).toHaveLength(4);
      expect(messages[0].type).toBe("system");
      expect(messages[1].type).toBe("user");
      expect(messages[2].type).toBe("assistant");
      expect(messages[3].type).toBe("result");

      // Verify specific content
      if (messages[0].type === "system") {
        expect(messages[0].session_id).toBe("test-session-123");
      }
      if (messages[3].type === "result") {
        expect(messages[3].subtype).toBe("success");
        expect(messages[3].is_error).toBe(false);
      }
    });

    test("should return empty array for non-existent log file", () => {
      const nonExistentPath = path.join(testDir, "does-not-exist.jsonl");

      const parser = new ClaudeLogParser({
        logPath: nonExistentPath,
        codonId: "test-codon",
        parsingInterval: 50,
      });

      const messages = parser.getAllMessages();
      expect(messages).toHaveLength(0);
    });

    test("should skip invalid JSON lines", () => {
      // Create a log file with mix of valid and invalid lines
      const logContent = [
        JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: "/test",
          session_id: "test-session-456",
          tools: ["Read"],
          mcp_servers: [],
          model: "claude-3-opus-20240229",
          permissionMode: "bypassPermissions",
          apiKeySource: "ANTHROPIC_API_KEY",
        }),
        "{ invalid json",
        "",
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_01234",
            type: "message",
            role: "assistant",
            model: "claude-3-opus-20240229",
            content: [{ type: "text", text: "Valid message" }],
            stop_reason: "end_turn",
            stop_sequence: null,
          },
        }),
        "incomplete",
      ].join("\n");

      fs.writeFileSync(logPath, logContent);

      const parser = new ClaudeLogParser({
        logPath,
        codonId: "test-codon",
        parsingInterval: 50,
      });

      const messages = parser.getAllMessages();

      // Should only get the 2 valid messages
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe("system");
      expect(messages[1].type).toBe("assistant");
    });

    test("should not fire callbacks when getting all messages", () => {
      let systemCallbackFired = false;
      let assistantCallbackFired = false;
      let userCallbackFired = false;
      let resultCallbackFired = false;

      const logContent = `${[
        JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: "/test",
          session_id: "test-session-789",
          tools: ["Read"],
          mcp_servers: [],
          model: "claude-3-opus-20240229",
          permissionMode: "bypassPermissions",
          apiKeySource: "ANTHROPIC_API_KEY",
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "Test",
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_01234",
            type: "message",
            role: "assistant",
            model: "claude-3-opus-20240229",
            content: [{ type: "text", text: "Response" }],
            stop_reason: "end_turn",
            stop_sequence: null,
          },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 5000,
          duration_api_ms: 3000,
          num_turns: 1,
          result: "Done",
          session_id: "test-session-789",
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 50,
            output_tokens: 25,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 10,
          },
        }),
      ].join("\n")}\n`;

      fs.writeFileSync(logPath, logContent);

      const parser = new ClaudeLogParser({
        logPath,
        codonId: "test-codon",
        parsingInterval: 50,
        onSystemMessage: () => {
          systemCallbackFired = true;
        },
        onAssistantMessage: () => {
          assistantCallbackFired = true;
        },
        onUserMessage: () => {
          userCallbackFired = true;
        },
        onResultMessage: () => {
          resultCallbackFired = true;
        },
      });

      const messages = parser.getAllMessages();

      // Should get all messages
      expect(messages).toHaveLength(4);

      // But callbacks should NOT have been fired
      expect(systemCallbackFired).toBe(false);
      expect(assistantCallbackFired).toBe(false);
      expect(userCallbackFired).toBe(false);
      expect(resultCallbackFired).toBe(false);
    });

    test("should handle empty log file", () => {
      fs.writeFileSync(logPath, "");

      const parser = new ClaudeLogParser({
        logPath,
        codonId: "test-codon",
        parsingInterval: 50,
      });

      const messages = parser.getAllMessages();
      expect(messages).toHaveLength(0);
    });

    test("should handle log file with only whitespace", () => {
      fs.writeFileSync(logPath, "\n\n  \n\t\n");

      const parser = new ClaudeLogParser({
        logPath,
        codonId: "test-codon",
        parsingInterval: 50,
      });

      const messages = parser.getAllMessages();
      expect(messages).toHaveLength(0);
    });
  });
});
