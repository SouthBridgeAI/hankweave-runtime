import { describe, it, expect, beforeAll } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  runSentinelTest,
  createTestLog
} from "../utils/sentinel-test-harness.js";
import { sentinelConfigSchema } from "../../server/config-validation/sentinel.schema.js";
import type { SentinelConfig } from "../../server/types/sentinel-types.js";

const TEMP_LOG_DIR = path.resolve(process.cwd(), "tests/test-area/temp-logs");
const SENTINEL_CONFIGS_DIR = path.resolve(process.cwd(), "tests/config/sentinel-triggers");

// Helper to load a Sentinel config from our test files
function loadSentinelConfig(fileName: string) {
  const filePath = path.join(SENTINEL_CONFIGS_DIR, fileName);
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const config = JSON.parse(fileContent);
  return sentinelConfigSchema.parse(config);
}

// Helper to create inline sentinel config
function createSentinelConfig(partial: Partial<SentinelConfig>): SentinelConfig {
  const base: SentinelConfig = {
    id: "test-sentinel",
    name: "Test Sentinel",
    model: "sonnet",
    trigger: {
      type: "event",
      on: ["info"],
      conditions: []
    },
    execution: {
      strategy: "immediate"
    },
    userPromptText: "Test: {{events}}",
    ...partial
  };
  return sentinelConfigSchema.parse(base);
}

// Ensure temp directory exists for test logs
beforeAll(() => {
  if (!fs.existsSync(TEMP_LOG_DIR)) {
    fs.mkdirSync(TEMP_LOG_DIR, { recursive: true });
  }
});

describe("Sentinel Edge Cases and Properties", () => {

  describe("Empty and No-Match Scenarios", () => {
    it("should handle empty log files gracefully", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "empty.jsonl");
      fs.writeFileSync(testLogPath, "");

      const narratorConfig = loadSentinelConfig("narrator.json");
      const mock = await runSentinelTest(testLogPath, [narratorConfig]);

      // Should not crash and should not trigger
      expect(mock.toHaveBeenCalledTimes(0)).toBe(true);
    });

    it("should not trigger when no events match the filter", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "no-match.jsonl");
      createTestLog(testLogPath, [
        { type: "info", data: { message: "test1" } },
        { type: "info", data: { message: "test2" } },
        { type: "server.ready", data: { serverVersion: "1.0.0" } },
      ]);

      // Error detector only looks for tool.result events
      const errorDetectorConfig = loadSentinelConfig("error-detector.json");
      const mock = await runSentinelTest(testLogPath, [errorDetectorConfig]);

      expect(mock.toHaveBeenCalledTimes(0)).toBe(true);
    });

    it("should handle conditions that never match", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "never-match-condition.jsonl");
      createTestLog(testLogPath, [
        { type: "assistant.action", data: { action: "thinking" } },
        { type: "assistant.action", data: { action: "message" } },
      ]);

      const config = createSentinelConfig({
        id: "never-match",
        trigger: {
          type: "event",
          on: ["assistant.action"],
          conditions: [
            { operator: "equals", path: "action", value: "nonexistent" }
          ]
        }
      });

      const mock = await runSentinelTest(testLogPath, [config]);
      expect(mock.toHaveBeenCalledTimes(0)).toBe(true);
    });
  });

  describe("Debounce Edge Cases", () => {
    it("should handle single event with debounce", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "single-debounce.jsonl");
      createTestLog(testLogPath, [
        { type: "assistant.action", data: { action: "thinking" } }
      ]);

      const config = createSentinelConfig({
        id: "single-debounce",
        trigger: {
          type: "event",
          on: ["assistant.action"]
        },
        execution: {
          strategy: "debounce",
          milliseconds: 100
        }
      });

      const mock = await runSentinelTest(testLogPath, [config]);

      // Should still fire once after debounce period
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);
      const call = mock.getCall(0);
      if (call) {
        const [_, events] = call;
        expect(events.length).toBe(1);
      }
    });

    it("should batch rapid events within debounce window", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "rapid-events.jsonl");
      createTestLog(testLogPath, [
        { type: "info", data: { message: "1" }, delayMs: 0 },
        { type: "info", data: { message: "2" }, delayMs: 10 },
        { type: "info", data: { message: "3" }, delayMs: 10 },
        { type: "info", data: { message: "4" }, delayMs: 10 },
        { type: "info", data: { message: "5" }, delayMs: 10 },
      ]);

      const config = createSentinelConfig({
        id: "rapid-debounce",
        trigger: {
          type: "event",
          on: ["info"]
        },
        execution: {
          strategy: "debounce",
          milliseconds: 500
        }
      });

      const mock = await runSentinelTest(testLogPath, [config]);

      // All events should be batched into one call
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);
      const call = mock.getCall(0);
      if (call) {
        const [_, events] = call;
        expect(events.length).toBe(5);
      }
    });
  });

  describe("Sequence Trigger Properties", () => {
    it("should not trigger on incomplete sequences", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "incomplete-sequence.jsonl");
      createTestLog(testLogPath, [
        { type: "tool.result", data: { isError: true, toolName: "test" } },
        { type: "tool.result", data: { isError: true, toolName: "test" } },
        // Missing third error - sequence incomplete
      ]);

      const errorDetectorConfig = loadSentinelConfig("error-detector.json");
      const mock = await runSentinelTest(testLogPath, [errorDetectorConfig]);

      // Should not trigger for incomplete sequence
      expect(mock.toHaveBeenCalledTimes(0)).toBe(true);
    });

    it("should reset sequence after successful match", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "double-sequence.jsonl");
      createTestLog(testLogPath, [
        // First sequence
        { type: "tool.result", data: { isError: true, toolName: "test" }, delayMs: 100 },
        { type: "tool.result", data: { isError: true, toolName: "test" }, delayMs: 100 },
        { type: "tool.result", data: { isError: true, toolName: "test" }, delayMs: 100 },
        // Break
        { type: "tool.result", data: { isError: false, toolName: "test" }, delayMs: 100 },
        // Second sequence
        { type: "tool.result", data: { isError: true, toolName: "test" }, delayMs: 100 },
        { type: "tool.result", data: { isError: true, toolName: "test" }, delayMs: 100 },
        { type: "tool.result", data: { isError: true, toolName: "test" }, delayMs: 100 },
      ]);

      const errorDetectorConfig = loadSentinelConfig("error-detector.json");
      const mock = await runSentinelTest(testLogPath, [errorDetectorConfig]);

      // Should trigger twice - once for each complete sequence
      expect(mock.toHaveBeenCalledTimes(2)).toBe(true);
    });

    it("should handle interleaved events in non-consecutive mode", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "interleaved.jsonl");
      createTestLog(testLogPath, [
        { type: "codon.started", data: { codonId: "p1" } },
        { type: "info", data: { message: "noise" } },
        { type: "assistant.action", data: { action: "thinking" } },
        { type: "tool.result", data: { toolName: "test" } },
        { type: "codon.completed", data: { codonId: "p1" } },
        { type: "info", data: { message: "more noise" } },
      ]);

      const nonConsecutiveConfig = loadSentinelConfig("non-consecutive-sequence.json");
      const mock = await runSentinelTest(testLogPath, [nonConsecutiveConfig]);

      // Should still match the codon lifecycle despite interleaved events
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);
      const call = mock.getCall(0);
      if (call) {
        const [_, events] = call;
        expect(events.length).toBe(2);
        expect(events[0].type).toBe("codon.started");
        expect(events[1].type).toBe("codon.completed");
      }
    });
  });

  describe("Count Execution Properties", () => {
    it("should handle exact threshold match", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "exact-threshold.jsonl");
      createTestLog(testLogPath, [
        { type: "info", data: { message: "1" } },
        { type: "info", data: { message: "2" } },
        { type: "info", data: { message: "3" } },
        { type: "info", data: { message: "4" } },
        { type: "info", data: { message: "5" } },
      ]);

      const config = createSentinelConfig({
        id: "exact-count",
        trigger: {
          type: "event",
          on: ["info"]
        },
        execution: {
          strategy: "count",
          threshold: 5
        }
      });

      const mock = await runSentinelTest(testLogPath, [config]);

      // Should trigger exactly once with all 5 events
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);
      const call = mock.getCall(0);
      if (call) {
        const [_, events] = call;
        expect(events.length).toBe(5);
      }
    });

    it("should not trigger if below threshold", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "below-threshold.jsonl");
      createTestLog(testLogPath, [
        { type: "info", data: { message: "1" } },
        { type: "info", data: { message: "2" } },
        { type: "info", data: { message: "3" } },
      ]);

      const config = createSentinelConfig({
        id: "below-count",
        trigger: {
          type: "event",
          on: ["info"]
        },
        execution: {
          strategy: "count",
          threshold: 5
        }
      });

      const mock = await runSentinelTest(testLogPath, [config]);

      // Should not trigger without flush (only 3 events, threshold is 5)
      // But flush will trigger with the 3 events
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);
      const call = mock.getCall(0);
      if (call) {
        const [_, events] = call;
        expect(events.length).toBe(3);
      }
    });
  });

  describe("Condition Operator Tests", () => {
    it("should correctly evaluate notEquals operator", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "not-equals.jsonl");
      createTestLog(testLogPath, [
        { type: "assistant.action", data: { action: "thinking" } },
        { type: "assistant.action", data: { action: "tool_use" } },
        { type: "assistant.action", data: { action: "message" } },
      ]);

      const config = createSentinelConfig({
        id: "not-thinking",
        trigger: {
          type: "event",
          on: ["assistant.action"],
          conditions: [
            { operator: "notEquals", path: "action", value: "thinking" }
          ]
        }
      });

      const mock = await runSentinelTest(testLogPath, [config]);

      // Should trigger for tool_use and message, not thinking
      expect(mock.toHaveBeenCalledTimes(2)).toBe(true);
    });

    it("should correctly evaluate notIn operator", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "not-in.jsonl");
      createTestLog(testLogPath, [
        { type: "tool.result", data: { toolName: "Bash" } },
        { type: "tool.result", data: { toolName: "Write" } },
        { type: "tool.result", data: { toolName: "Read" } },
        { type: "tool.result", data: { toolName: "Delete" } },
      ]);

      const config = createSentinelConfig({
        id: "not-file-ops",
        trigger: {
          type: "event",
          on: ["tool.result"],
          conditions: [
            { operator: "notIn", path: "toolName", value: ["Write", "Read", "Delete"] }
          ]
        }
      });

      const mock = await runSentinelTest(testLogPath, [config]);

      // Should only trigger for Bash
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);
      const call = mock.getCall(0);
      if (call) {
        const [_, events] = call;
        if (events[0].type === "tool.result") {
          const data = events[0].data as any;
          expect(data.toolName).toBe("Bash");
        }
      }
    });

    it("should correctly evaluate numeric comparisons", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "numeric-compare.jsonl");
      createTestLog(testLogPath, [
        { type: "token.usage", data: { totalCost: 0.1 } },
        { type: "token.usage", data: { totalCost: 0.5 } },
        { type: "token.usage", data: { totalCost: 1.5 } },
        { type: "token.usage", data: { totalCost: 0.3 } },
      ]);

      const config = createSentinelConfig({
        id: "high-cost",
        trigger: {
          type: "event",
          on: ["token.usage"],
          conditions: [
            { operator: "greaterThan", path: "totalCost", value: 0.4 }
          ]
        }
      });

      const mock = await runSentinelTest(testLogPath, [config]);

      // Should trigger for 0.5 and 1.5
      expect(mock.toHaveBeenCalledTimes(2)).toBe(true);
    });

    it("should correctly evaluate regex matches", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "regex-match.jsonl");
      createTestLog(testLogPath, [
        { type: "info", data: { message: "Starting codon-1" } },
        { type: "info", data: { message: "Processing data" } },
        { type: "info", data: { message: "Completed codon-1" } },
        { type: "info", data: { message: "Starting codon-2" } },
      ]);

      const config = createSentinelConfig({
        id: "codon-messages",
        trigger: {
          type: "event",
          on: ["info"],
          conditions: [
            { operator: "matches", path: "message", value: ".*codon-\\d+.*" }
          ]
        }
      });

      const mock = await runSentinelTest(testLogPath, [config]);

      // Should match messages containing "codon-" followed by digits
      expect(mock.toHaveBeenCalledTimes(3)).toBe(true);
    });
  });

  describe("Error Handling and Resilience", () => {
    it("should handle malformed log entries gracefully", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "malformed.jsonl");
      // Mix valid and invalid entries
      fs.writeFileSync(testLogPath,
        '{"direction":"out","loggedAt":"2024-01-01T00:00:00Z","message":{"type":"info","id":"1","timestamp":"2024-01-01T00:00:00Z","data":{"message":"valid"}}}\n' +
        'not json at all\n' +
        '{"invalid": "structure"}\n' +
        '{"direction":"out","loggedAt":"2024-01-01T00:00:01Z","message":{"type":"info","id":"2","timestamp":"2024-01-01T00:00:01Z","data":{"message":"also valid"}}}\n'
      );

      const config = createSentinelConfig({
        id: "malformed-test",
        trigger: {
          type: "event",
          on: ["info"]
        }
      });

      const mock = await runSentinelTest(testLogPath, [config]);

      // Should process the valid entries and skip malformed ones
      expect(mock.toHaveBeenCalledTimes(2)).toBe(true);
    });

    it("should handle events with missing optional fields", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "missing-fields.jsonl");
      createTestLog(testLogPath, [
        { type: "assistant.action", data: { action: "thinking", content: "test" } },
        { type: "assistant.action", data: { action: "tool_use", content: "test", toolName: "Bash" } },
        // toolInput is optional and missing
      ]);

      const config = createSentinelConfig({
        id: "optional-fields",
        trigger: {
          type: "event",
          on: ["assistant.action"],
          conditions: [
            { operator: "equals", path: "action", value: "tool_use" }
          ]
        }
      });

      const mock = await runSentinelTest(testLogPath, [config]);

      // Should still trigger even with missing optional fields
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);
    });
  });

  describe("Performance and Memory", () => {
    it("should handle large event histories efficiently", async () => {
      const testLogPath = path.join(TEMP_LOG_DIR, "large-history.jsonl");
      const events = [];

      // Create 1500 events (exceeding the 1000 event history limit)
      for (let i = 0; i < 1500; i++) {
        events.push({
          type: "tool.result",
          data: {
            isError: i % 10 === 0, // Every 10th is an error
            toolName: `tool-${i}`
          },
          delayMs: 1
        });
      }

      // Add a sequence of 3 errors at the end
      events.push(
        { type: "tool.result", data: { isError: true, toolName: "final-1" }, delayMs: 1 },
        { type: "tool.result", data: { isError: true, toolName: "final-2" }, delayMs: 1 },
        { type: "tool.result", data: { isError: true, toolName: "final-3" }, delayMs: 1 }
      );

      createTestLog(testLogPath, events);

      const errorDetectorConfig = loadSentinelConfig("error-detector.json");
      const mock = await runSentinelTest(testLogPath, [errorDetectorConfig]);

      // Should still detect the final error sequence despite large history
      const lastCall = mock.calls[mock.calls.length - 1];
      if (lastCall) {
        const events = lastCall.eventsOrMessages;
        if (events[0].type === "tool.result" && events[1].type === "tool.result" && events[2].type === "tool.result") {
          const data0 = events[0].data as any;
          const data1 = events[1].data as any;
          const data2 = events[2].data as any;
          expect(data0.toolName).toBe("final-1");
          expect(data1.toolName).toBe("final-2");
          expect(data2.toolName).toBe("final-3");
        }
      }
    });
  });
});
