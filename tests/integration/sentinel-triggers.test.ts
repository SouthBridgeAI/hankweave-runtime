import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { sentinelConfigSchema } from "../../server/config-validation/sentinel.schema.js";
import { countEventType, createTestLog, runSentinelTest } from "../utils/sentinel-test-harness.js";

// --- Test Setup ---
const TEST_LOG_DIR = path.resolve(process.cwd(), "tests/test-data/websocket-logs");
const SENTINEL_CONFIGS_DIR = path.resolve(process.cwd(), "tests/config/sentinel-triggers");
const TEMP_LOG_DIR = path.resolve(process.cwd(), "tests/test-area/temp-logs");

// Helper to load a Sentinel config from our test files
function loadSentinelConfig(fileName: string) {
  const filePath = path.join(SENTINEL_CONFIGS_DIR, fileName);
  const fileContent = fs.readFileSync(filePath, "utf-8");
  const config = JSON.parse(fileContent);
  // Validate it before using to catch schema errors
  return sentinelConfigSchema.parse(config);
}

// Ensure temp directory exists for test logs
beforeAll(() => {
  if (!fs.existsSync(TEMP_LOG_DIR)) {
    fs.mkdirSync(TEMP_LOG_DIR, { recursive: true });
  }
});

// --- The Tests ---

describe("Sentinel Trigger Integration Tests", () => {
  describe("Event Triggers", () => {
    it("should trigger narrator sentinel with debounce strategy", async () => {
      // Use one of the existing logs
      const logPath = path.join(TEST_LOG_DIR, "nhanes-1.log");
      if (!fs.existsSync(logPath)) {
        console.log("Skipping test - log file not found:", logPath);
        return;
      }

      const narratorConfig = loadSentinelConfig("narrator.json");
      const mock = await runSentinelTest(logPath, [narratorConfig]);

      // The narrator should have been called, but not for every single event
      expect(mock.toHaveBeenCalled()).toBe(true);

      // Count total events that would trigger
      const assistantActionCount = await countEventType(logPath, "assistant.action");
      const toolResultCount = await countEventType(logPath, "tool.result");
      const totalTriggerEvents = assistantActionCount + toolResultCount;

      // With debounce, calls should be much less than total events
      if (totalTriggerEvents > 0) {
        expect(mock.calls.length).toBeLessThan(totalTriggerEvents);
      }

      // Check that events were batched
      if (mock.calls.length > 0) {
        const firstCall = mock.getCall(0);
        expect(firstCall).toBeDefined();
        if (firstCall) {
          const [sentinelId, events] = firstCall;
          expect(sentinelId).toBe("narrator");
          // Debounce should batch multiple events
          expect(events.length).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it("should trigger immediately for immediate execution strategy", async () => {
      // Create a simple test log with specific events
      const testLogPath = path.join(TEMP_LOG_DIR, "immediate-test.jsonl");
      createTestLog(testLogPath, [
        { type: "codon.started", data: { codonId: "test-1" } },
        { type: "assistant.action", data: { action: "thinking" }, delayMs: 100 },
        { type: "codon.completed", data: { codonId: "test-1" }, delayMs: 100 },
      ]);

      // Use codon-summary which has immediate execution
      const codonSummaryConfig = loadSentinelConfig("codon-summary.json");
      const mock = await runSentinelTest(testLogPath, [codonSummaryConfig]);

      // Should trigger once for codon.completed
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);

      const call = mock.getCall(0);
      if (call) {
        const [sentinelId, events] = call;
        expect(sentinelId).toBe("codon-summary");
        expect(events.length).toBe(1);
        expect(events[0].type).toBe("codon.completed");
      }
    });
  });

  describe("Count Execution Strategy", () => {
    it("should batch events by count threshold", async () => {
      // Create a test log with multiple file.updated events
      const testLogPath = path.join(TEMP_LOG_DIR, "count-test.jsonl");
      const fileEvents = [];
      for (let i = 0; i < 12; i++) {
        fileEvents.push({
          type: "file.updated",
          data: {
            path: `file${i}.txt`,
            filename: `file${i}.txt`,
            content: `content ${i}`,
            action: "modified" as const,
          },
          delayMs: 50,
        });
      }
      createTestLog(testLogPath, fileEvents);

      const fileMonitorConfig = loadSentinelConfig("file-activity-monitor.json");
      const mock = await runSentinelTest(testLogPath, [fileMonitorConfig]);

      // With threshold of 5, 12 events should trigger 3 calls:
      // - First batch: 5 events
      // - Second batch: 5 events
      // - Third batch: 2 remaining events (flushed at the end)
      expect(mock.toHaveBeenCalledTimes(3)).toBe(true);

      // First batch should have exactly 5 events
      const firstCall = mock.getCall(0);
      if (firstCall) {
        const [_, events] = firstCall;
        expect(events.length).toBe(5);
        expect(events.every((e) => e.type === "file.updated")).toBe(true);
      }

      // Second batch should also have 5 events
      const secondCall = mock.getCall(1);
      if (secondCall) {
        const [_, events] = secondCall;
        expect(events.length).toBe(5);
      }

      // Third batch should have the remaining 2 events
      const thirdCall = mock.getCall(2);
      if (thirdCall) {
        const [_, events] = thirdCall;
        expect(events.length).toBe(2);
      }
    });
  });

  describe("Sequence Triggers", () => {
    it("should detect consecutive error sequences", async () => {
      // Create a log with consecutive errors
      const testLogPath = path.join(TEMP_LOG_DIR, "error-sequence.jsonl");
      createTestLog(testLogPath, [
        { type: "tool.result", data: { isError: false, toolName: "test" } },
        {
          type: "tool.result",
          data: { isError: true, toolName: "test", error: "Error 1" },
          delayMs: 100,
        },
        {
          type: "tool.result",
          data: { isError: true, toolName: "test", error: "Error 2" },
          delayMs: 100,
        },
        {
          type: "tool.result",
          data: { isError: true, toolName: "test", error: "Error 3" },
          delayMs: 100,
        },
        { type: "tool.result", data: { isError: false, toolName: "test" }, delayMs: 100 },
      ]);

      const errorDetectorConfig = loadSentinelConfig("error-detector.json");
      const mock = await runSentinelTest(testLogPath, [errorDetectorConfig]);

      // Should trigger once for the sequence of 3 errors
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);

      const call = mock.getCall(0);
      if (call) {
        const [sentinelId, events] = call;
        expect(sentinelId).toBe("error-detector");
        expect(events.length).toBe(3);
        expect(events.every((e) => e.type === "tool.result" && e.data.isError === true)).toBe(true);
      }
    });

    it("should detect non-consecutive sequences when configured", async () => {
      // Create a log with non-consecutive codon events
      const testLogPath = path.join(TEMP_LOG_DIR, "non-consecutive.jsonl");
      createTestLog(testLogPath, [
        { type: "codon.started", data: { codonId: "codon-1" } },
        { type: "assistant.action", data: { action: "thinking" }, delayMs: 100 },
        { type: "tool.result", data: { toolName: "test" }, delayMs: 100 },
        { type: "codon.completed", data: { codonId: "codon-1" }, delayMs: 100 },
        { type: "codon.started", data: { codonId: "codon-2" }, delayMs: 100 },
        { type: "info", data: { message: "test" }, delayMs: 100 },
        { type: "codon.completed", data: { codonId: "codon-2" }, delayMs: 100 },
      ]);

      const nonConsecutiveConfig = loadSentinelConfig("non-consecutive-sequence.json");
      const mock = await runSentinelTest(testLogPath, [nonConsecutiveConfig]);

      // Should trigger twice (once for each codon lifecycle)
      expect(mock.toHaveBeenCalledTimes(2)).toBe(true);

      // Each call should have 2 events (start and complete)
      const firstCall = mock.getCall(0);
      if (firstCall) {
        const [_, events] = firstCall;
        expect(events.length).toBe(2);
        expect(events[0].type).toBe("codon.started");
        expect(events[1].type).toBe("codon.completed");
      }
    });
  });

  describe("Complex Conditions", () => {
    it("should match events with multiple AND conditions", async () => {
      // Create a log with various assistant actions
      const testLogPath = path.join(TEMP_LOG_DIR, "complex-conditions.jsonl");
      createTestLog(testLogPath, [
        {
          type: "assistant.action",
          data: {
            action: "tool_use",
            toolName: "Bash",
            toolInput: { command: "python script.py" },
          },
        },
        {
          type: "assistant.action",
          data: {
            action: "tool_use",
            toolName: "Bash",
            toolInput: { command: "ls -la" },
          },
          delayMs: 100,
        },
        {
          type: "assistant.action",
          data: {
            action: "tool_use",
            toolName: "Write",
            toolInput: { path: "test.py", content: "print('hello')" },
          },
          delayMs: 100,
        },
        {
          type: "assistant.action",
          data: {
            action: "tool_use",
            toolName: "Bash",
            toolInput: { command: "python3 test.py" },
          },
          delayMs: 100,
        },
      ]);

      const complexConditionConfig = loadSentinelConfig("complex-condition.json");
      const mock = await runSentinelTest(testLogPath, [complexConditionConfig]);

      // Should trigger 3 times (for the three Bash commands)
      expect(mock.toHaveBeenCalledTimes(3)).toBe(true);

      // Verify the matched events
      for (let i = 0; i < mock.calls.length; i++) {
        const call = mock.getCall(i);
        if (call) {
          const [sentinelId, events] = call;
          expect(sentinelId).toBe("complex-condition");
          expect(events.length).toBe(1);
          const event = events[0];
          // Type assertion for assistant.action event data
          if (event.type === "assistant.action") {
            const data = event.data;
            expect(data.action).toBe("tool_use");
            expect(data.toolName).toBe("Bash");
          }
        }
      }
    });
  });

  describe("Time Window Execution", () => {
    it("should batch events within time windows", async () => {
      // Create a log spanning 25 seconds
      const testLogPath = path.join(TEMP_LOG_DIR, "time-window.jsonl");
      const events = [];

      // First window (0-10s)
      for (let i = 0; i < 5; i++) {
        events.push({
          type: "assistant.action",
          data: { action: "thinking", content: `Thought ${i}` },
          delayMs: 1500, // 1.5s between events
        });
      }

      // Second window (10-20s)
      events.push({
        type: "codon.started",
        data: { codonId: "test" },
        delayMs: 3000, // Jump to ~10.5s
      });
      for (let i = 0; i < 3; i++) {
        events.push({
          type: "tool.result",
          data: { toolName: `tool${i}` },
          delayMs: 2000,
        });
      }

      // Third window (20-25s)
      events.push({
        type: "codon.completed",
        data: { codonId: "test" },
        delayMs: 4000, // Jump to ~20.5s
      });

      createTestLog(testLogPath, events);

      const timeWindowConfig = loadSentinelConfig("time-window-summary.json");
      const mock = await runSentinelTest(testLogPath, [timeWindowConfig]);

      // With 10-second windows, we expect 1 call after all events are processed
      // (Our current implementation only fires once when the window closes)
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);

      // Should have collected all the events in the window
      const firstCall = mock.getCall(0);
      if (firstCall) {
        const [sentinelId, events] = firstCall;
        expect(sentinelId).toBe("time-window-summary");
        expect(events.length).toBeGreaterThan(0);
        // Should have collected multiple event types
        const eventTypes = new Set(events.map((e) => e.type));
        expect(eventTypes.size).toBeGreaterThan(1);
      }
    });
  });

  describe("Multiple Sentinels", () => {
    it("should handle multiple sentinels simultaneously", async () => {
      // Create a test log with various events
      const testLogPath = path.join(TEMP_LOG_DIR, "multi-sentinel.jsonl");
      createTestLog(testLogPath, [
        { type: "codon.started", data: { codonId: "test" } },
        { type: "assistant.action", data: { action: "thinking" }, delayMs: 100 },
        {
          type: "file.updated",
          data: {
            path: "file1.txt",
            filename: "file1.txt",
            content: "content1",
            action: "created",
          },
          delayMs: 100,
        },
        {
          type: "file.updated",
          data: {
            path: "file2.txt",
            filename: "file2.txt",
            content: "content2",
            action: "modified",
          },
          delayMs: 100,
        },
        { type: "tool.result", data: { toolName: "test" }, delayMs: 100 },
        {
          type: "file.updated",
          data: {
            path: "file3.txt",
            filename: "file3.txt",
            content: "content3",
            action: "modified",
          },
          delayMs: 100,
        },
        { type: "codon.completed", data: { codonId: "test" }, delayMs: 100 },
      ]);

      // Load multiple sentinels
      const narratorConfig = loadSentinelConfig("narrator.json");
      const fileMonitorConfig = loadSentinelConfig("file-activity-monitor.json");
      const codonSummaryConfig = loadSentinelConfig("codon-summary.json");

      const mock = await runSentinelTest(testLogPath, [
        narratorConfig,
        fileMonitorConfig,
        codonSummaryConfig,
      ]);

      // All sentinels should have triggered
      expect(mock.toHaveBeenCalled()).toBe(true);

      // Check that different sentinels were called
      const sentinelIds = new Set(mock.calls.map((call) => call.sentinelId));
      expect(sentinelIds.size).toBeGreaterThan(1);
    });
  });
});
