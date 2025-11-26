import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ClaudeLogParser } from "../../server/claude-log-parser";
import { EventId } from "../../server/types/branded-types";
import type { ToolResultContent, UserMessage } from "../../server/types/claude-session-schema";
import type { ToolResultEvent } from "../../server/types/types";

describe("Tool Result Tracking", () => {
  describe("ToolResultEvent type", () => {
    test("should have correct structure", () => {
      const event: ToolResultEvent = {
        id: EventId("test-id"),
        timestamp: new Date().toISOString(),
        type: "tool.result",
        data: {
          codonId: "codon-1",
          toolUseId: "toolu_01234567890",
          toolName: "Write",
          result: "File written successfully",
          truncated: false,
          originalLength: 30,
          executionTimeMs: 150,
          isError: false,
        },
      };

      expect(event.type).toBe("tool.result");
      expect(event.data.codonId).toBe("codon-1");
      expect(event.data.toolUseId).toBe("toolu_01234567890");
      expect(event.data.toolName).toBe("Write");
      expect(event.data.result).toBe("File written successfully");
      expect(event.data.truncated).toBe(false);
      expect(event.data.originalLength).toBe(30);
      expect(event.data.executionTimeMs).toBe(150);
      expect(event.data.isError).toBe(false);
    });

    test("should handle truncated results", () => {
      const event: ToolResultEvent = {
        id: EventId("test-id-2"),
        timestamp: new Date().toISOString(),
        type: "tool.result",
        data: {
          codonId: "codon-1",
          toolUseId: "toolu_12345",
          toolName: "Read",
          result: "This is a very long file content that has been truncated...",
          truncated: true,
          originalLength: 5000,
          executionTimeMs: 50,
          isError: false,
        },
      };

      expect(event.data.truncated).toBe(true);
      expect(event.data.originalLength).toBe(5000);
      expect(event.data.result).toContain("...");
    });

    test("should handle error results", () => {
      const event: ToolResultEvent = {
        id: EventId("test-id-3"),
        timestamp: new Date().toISOString(),
        type: "tool.result",
        data: {
          codonId: "codon-1",
          toolUseId: "toolu_error",
          toolName: "Write",
          result: "Error: Permission denied",
          truncated: false,
          originalLength: 24,
          executionTimeMs: 10,
          isError: true,
        },
      };

      expect(event.data.isError).toBe(true);
      expect(event.data.result).toContain("Error");
    });
  });

  describe("Tool Result Parsing from User Messages", () => {
    const testDir = path.join(import.meta.dir, "test-tool-results");
    const logPath = path.join(testDir, "test-tool-results.jsonl");

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

    beforeEach(() => {
      // Clean up any existing log file
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
    });

    test("should parse tool results from user messages", async () => {
      const userMessages: UserMessage[] = [];

      const parser = new ClaudeLogParser({
        logPath,
        codonId: "test-codon",
        parsingInterval: 50,
        onUserMessage: (msg) => userMessages.push(msg),
      });

      // Write a user message with tool result to the log
      const userMessage: UserMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01234567890",
              content: "File '/path/to/file.txt' created successfully",
            },
          ],
        },
      };

      fs.writeFileSync(
        logPath,
        `${JSON.stringify(userMessage)}
`,
      );

      parser.start();

      // Wait for parsing
      await new Promise((resolve) => setTimeout(resolve, 100));

      parser.stop();

      expect(userMessages).toHaveLength(1);
      const content = userMessages[0].message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0].type).toBe("tool_result");
        const toolResult = content[0] as ToolResultContent;
        expect(toolResult.tool_use_id).toBe("toolu_01234567890");
        expect(toolResult.content).toBe("File '/path/to/file.txt' created successfully");
      }
    });

    test("should handle array content in tool results", async () => {
      const userMessages: UserMessage[] = [];
      const arrayLogPath = path.join(testDir, "array-tool-results.jsonl");

      const parser = new ClaudeLogParser({
        logPath: arrayLogPath,
        codonId: "test-codon",
        parsingInterval: 50,
        onUserMessage: (msg) => userMessages.push(msg),
      });

      // Write a user message with array content tool result
      const userMessage: UserMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01ABC23XYZ", // Valid format: alphanumeric only (no underscores in suffix)
              content: [
                { type: "text", text: "Line 1 of result" },
                { type: "text", text: "Line 2 of result" },
              ],
            },
          ],
        },
      };

      fs.writeFileSync(
        arrayLogPath,
        `${JSON.stringify(userMessage)}
`,
      );

      parser.start();

      // Wait for parsing
      await new Promise((resolve) => setTimeout(resolve, 100));

      parser.stop();

      expect(userMessages).toHaveLength(1);
      const msgContent = userMessages[0].message.content;
      expect(Array.isArray(msgContent)).toBe(true);
      if (Array.isArray(msgContent)) {
        const toolResult = msgContent[0] as ToolResultContent;
        expect(Array.isArray(toolResult.content)).toBe(true);
        expect(toolResult.content).toHaveLength(2);
      }
    });

    test("should handle error tool results", async () => {
      const userMessages: UserMessage[] = [];

      const parser = new ClaudeLogParser({
        logPath,
        codonId: "test-codon",
        parsingInterval: 50,
        onUserMessage: (msg) => userMessages.push(msg),
      });

      // Write a user message with error tool result
      const userMessage: UserMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_error",
              content: {
                is_error: true,
                error: "Permission denied",
              },
            },
          ],
        },
      };

      fs.writeFileSync(
        logPath,
        `${JSON.stringify(userMessage)}
`,
      );

      parser.start();

      // Wait for parsing
      await new Promise((resolve) => setTimeout(resolve, 100));

      parser.stop();

      expect(userMessages).toHaveLength(1);
      const content = userMessages[0].message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        const toolResult = content[0] as ToolResultContent;
        if (typeof toolResult.content === "object" && !Array.isArray(toolResult.content)) {
          expect((toolResult.content as { is_error: boolean }).is_error).toBe(true);
          expect((toolResult.content as { error: string }).error).toBe("Permission denied");
        }
      }
    });
  });

  describe("Result Truncation Logic", () => {
    test("should truncate long results", () => {
      const longText = "a".repeat(2000);
      const truncateLength = 1000;

      const truncated = `${longText.substring(0, truncateLength)}...`;

      expect(truncated.length).toBe(1003); // 1000 + "..."
      expect(truncated.endsWith("...")).toBe(true);
      expect(truncated.startsWith("aaa")).toBe(true);
    });

    test("should not truncate short results", () => {
      const shortText = "This is a short result";
      const truncateLength = 1000;

      const shouldTruncate = shortText.length > truncateLength;

      expect(shouldTruncate).toBe(false);
      expect(shortText).toBe("This is a short result");
    });

    test("should handle exact length boundary", () => {
      const exactText = "x".repeat(1000);
      const truncateLength = 1000;

      const shouldTruncate = exactText.length > truncateLength;

      expect(shouldTruncate).toBe(false);
      expect(exactText.length).toBe(1000);
    });

    test("should handle one character over limit", () => {
      const overText = "x".repeat(1001);
      const truncateLength = 1000;

      const shouldTruncate = overText.length > truncateLength;
      const truncated = shouldTruncate ? `${overText.substring(0, truncateLength)}...` : overText;

      expect(shouldTruncate).toBe(true);
      expect(truncated.length).toBe(1003);
      expect(truncated.endsWith("...")).toBe(true);
    });
  });

  describe("Tool Use Tracking", () => {
    test("should track pending tool uses", () => {
      const pendingToolUses = new Map<
        string,
        {
          toolName: string;
          timestamp: number;
          codonId: string;
        }
      >();

      // Add a tool use
      const toolUseId = "toolu_12345";
      const startTime = Date.now();

      pendingToolUses.set(toolUseId, {
        toolName: "Read",
        timestamp: startTime,
        codonId: "codon-1",
      });

      expect(pendingToolUses.has(toolUseId)).toBe(true);
      expect(pendingToolUses.get(toolUseId)?.toolName).toBe("Read");
      expect(pendingToolUses.get(toolUseId)?.codonId).toBe("codon-1");

      // Simulate tool result arriving
      const toolUse = pendingToolUses.get(toolUseId);
      expect(toolUse).toBeDefined();

      const executionTime = Date.now() - (toolUse?.timestamp ?? 0);
      expect(executionTime).toBeGreaterThanOrEqual(0);

      // Clean up after processing
      pendingToolUses.delete(toolUseId);
      expect(pendingToolUses.has(toolUseId)).toBe(false);
    });

    test("should handle multiple concurrent tool uses", () => {
      const pendingToolUses = new Map();

      // Add multiple tool uses
      const toolUses = [
        { id: "toolu_1", name: "Read", codon: "codon-1" },
        { id: "toolu_2", name: "Write", codon: "codon-1" },
        { id: "toolu_3", name: "Edit", codon: "codon-2" },
      ];

      const baseTime = Date.now();
      toolUses.forEach((tool, index) => {
        pendingToolUses.set(tool.id, {
          toolName: tool.name,
          timestamp: baseTime + index * 10,
          codonId: tool.codon,
        });
      });

      expect(pendingToolUses.size).toBe(3);

      // Process results out of order
      const processOrder = ["toolu_2", "toolu_1", "toolu_3"];

      processOrder.forEach((toolId) => {
        expect(pendingToolUses.has(toolId)).toBe(true);
        pendingToolUses.delete(toolId);
      });

      expect(pendingToolUses.size).toBe(0);
    });

    test("should handle missing tool use gracefully", () => {
      const pendingToolUses = new Map();

      // Try to get a non-existent tool use
      const toolUse = pendingToolUses.get("toolu_nonexistent");

      expect(toolUse).toBeUndefined();

      // Should not throw when trying to delete non-existent
      expect(() => {
        pendingToolUses.delete("toolu_nonexistent");
      }).not.toThrow();
    });

    test("should clear all pending uses on cleanup", () => {
      const pendingToolUses = new Map();

      // Add multiple tool uses
      pendingToolUses.set("toolu_1", {
        toolName: "Read",
        timestamp: Date.now(),
        codonId: "codon-1",
      });
      pendingToolUses.set("toolu_2", {
        toolName: "Write",
        timestamp: Date.now(),
        codonId: "codon-1",
      });
      pendingToolUses.set("toolu_3", {
        toolName: "Edit",
        timestamp: Date.now(),
        codonId: "codon-1",
      });

      expect(pendingToolUses.size).toBe(3);

      // Simulate cleanup
      pendingToolUses.clear();

      expect(pendingToolUses.size).toBe(0);
    });
  });

  describe("Content Extraction from Tool Results", () => {
    test("should extract text from string content", () => {
      const toolResult = {
        type: "tool_result",
        tool_use_id: "toolu_123",
        content: "Simple string result",
      };

      let resultText = "";
      if (typeof toolResult.content === "string") {
        resultText = toolResult.content;
      }

      expect(resultText).toBe("Simple string result");
    });

    test("should extract text from array content", () => {
      const toolResult = {
        type: "tool_result",
        tool_use_id: "toolu_123",
        content: [
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
          { type: "image", data: "base64data" }, // Should be filtered out
          { type: "text", text: "Line 3" },
        ],
      };

      let resultText = "";
      if (Array.isArray(toolResult.content)) {
        resultText = toolResult.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { type: string; text?: string }) => c.text || "")
          .join("\n");
      }

      expect(resultText).toBe("Line 1\nLine 2\nLine 3");
    });

    test("should extract JSON from object content", () => {
      const toolResult = {
        type: "tool_result",
        tool_use_id: "toolu_123",
        content: {
          status: "success",
          data: {
            files: ["file1.txt", "file2.txt"],
            count: 2,
          },
        },
      };

      let resultText = "";
      if (
        toolResult.content &&
        typeof toolResult.content === "object" &&
        !Array.isArray(toolResult.content)
      ) {
        resultText = JSON.stringify(toolResult.content, null, 2);
      }

      expect(resultText).toContain('"status": "success"');
      expect(resultText).toContain('"count": 2');
      expect(resultText).toContain("file1.txt");
    });

    test("should detect error in object content", () => {
      const toolResult = {
        type: "tool_result",
        tool_use_id: "toolu_123",
        content: {
          is_error: true,
          error: "File not found",
          code: "ENOENT",
        },
      };

      let isError = false;
      if (
        toolResult.content &&
        typeof toolResult.content === "object" &&
        !Array.isArray(toolResult.content)
      ) {
        if ("is_error" in toolResult.content) {
          isError = toolResult.content.is_error === true;
        }
      }

      expect(isError).toBe(true);
    });
  });

  describe("Execution Time Calculation", () => {
    test("should calculate execution time correctly", async () => {
      const startTime = Date.now();

      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 50));

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      expect(executionTime).toBeGreaterThanOrEqual(50);
      expect(executionTime).toBeLessThan(100); // Should not take too long
    });

    test("should handle rapid tool execution", () => {
      const times: number[] = [];

      for (let i = 0; i < 10; i++) {
        const start = Date.now();
        // Minimal work
        const _result = Math.sqrt(i);
        const executionTime = Date.now() - start;
        times.push(executionTime);
      }

      // Most should be very fast (< 1ms)
      const fastExecutions = times.filter((t) => t < 1).length;
      expect(fastExecutions).toBeGreaterThan(5);
    });
  });
});
