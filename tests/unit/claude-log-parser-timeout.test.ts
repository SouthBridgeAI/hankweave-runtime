import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ClaudeLogParser, loadPhaseStateFromLog } from "../../server/claude-log-parser.js";
import type { AssistantMessage, ResultMessage } from "../../types/claude-session-schema.js";

describe("Claude Log Parser - Timeout Detection", () => {
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
        phaseId: "test-phase",
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

      fs.writeFileSync(logPath, JSON.stringify(timeoutMessage) + "\n");

      parser.start();
      
      // Wait for parsing
      await new Promise(resolve => setTimeout(resolve, 100));
      
      parser.stop();

      expect(messages).toHaveLength(1);
      expect(messages[0]).not.toBeNull();
      const content = messages[0]!.message.content;
      const textContent = Array.isArray(content) 
        ? content.find(item => item.type === "text")?.text
        : content;
      expect(textContent).toBe("API Error: Request timed out.");
    });

    test("should parse result message with timeout error", async () => {
      const results: Array<ResultMessage | null> = [];
      
      const parser = new ClaudeLogParser({
        logPath,
        phaseId: "test-phase",
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

      fs.writeFileSync(logPath, JSON.stringify(timeoutResult) + "\n");

      parser.start();
      
      // Wait for parsing
      await new Promise(resolve => setTimeout(resolve, 100));
      
      parser.stop();

      expect(results).toHaveLength(1);
      expect(results[0]).not.toBeNull();
      expect(results[0]!.subtype).toBe("error");
      expect(results[0]!.result).toBe("API Error: Request timed out.");
    });
  });

  describe("Loading phase state with timeout", () => {
    test("should correctly load state from log with timeout error", () => {
      // Create a log file with init, assistant messages, and timeout result
      const logContent = [
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
      ].join("\n") + "\n";  // Add trailing newline

      fs.writeFileSync(logPath, logContent);

      const state = loadPhaseStateFromLog(logPath, {
        input: 15,
        output: 75,
        inputCache: 18.75,
        cacheRead: 1.5,
      });

      expect(state.sessionId).toBe("374bf5fd-dc81-4fe4-bb06-a92b30c79227");
      expect(state.success).toBe(false); // Phase failed due to timeout
      expect(state.cost).toBe(0.05); // Uses the total_cost_usd from result
      expect(state.tokens.inputTokens).toBe(100);
      expect(state.tokens.outputTokens).toBe(50);
    });
  });
});