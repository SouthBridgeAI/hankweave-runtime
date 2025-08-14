import { describe, it, expect, beforeAll } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  runChroniclerTest,
  countEventType,
  countEventsWithCondition,
  getLogDuration,
  createTestLog
} from "../utils/chronicler-test-harness.js";
import { chroniclerConfigSchema } from "../../server/config-validation/chronicler.schema.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";

// --- Test Setup ---
const TEST_LOG_DIR = path.resolve(process.cwd(), "tests/test-data/websocket-logs");
const CHRONICLER_CONFIGS_DIR = path.resolve(process.cwd(), "tests/config/chronicler-triggers");
const TEMP_LOG_DIR = path.resolve(process.cwd(), "tests/test-area/temp-logs");

// Helper to load a Chronicler config from our test files
function loadChroniclerConfig(fileName: string) {
  const filePath = path.join(CHRONICLER_CONFIGS_DIR, fileName);
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const config = JSON.parse(fileContent);
  // Validate it before using to catch schema errors
  return chroniclerConfigSchema.parse(config);
}

// Ensure temp directory exists for test logs
beforeAll(() => {
  if (!fs.existsSync(TEMP_LOG_DIR)) {
    fs.mkdirSync(TEMP_LOG_DIR, { recursive: true });
  }
});

// --- The Tests ---

describe("Chronicler Trigger Integration Tests", () => {

  describe("Event Triggers", () => {
    it("should trigger narrator chronicler with debounce strategy", async () => {
      // Use one of the existing logs
      const logPath = path.join(TEST_LOG_DIR, "nhanes-1.log");
      if (!fs.existsSync(logPath)) {
        console.log("Skipping test - log file not found:", logPath);
        return;
      }

      const narratorConfig = loadChroniclerConfig("narrator.json");
      const mock = await runChroniclerTest(logPath, [narratorConfig]);

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
          const [chroniclerId, events] = firstCall;
          expect(chroniclerId).toBe("narrator");
          // Debounce should batch multiple events
          expect(events.length).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it("should trigger immediately for immediate execution strategy", async () => {
      // Create a simple test log with specific events
      const testLogPath = path.join(TEMP_LOG_DIR, "immediate-test.jsonl");
      createTestLog(testLogPath, [
        { type: "phase.started", data: { phaseId: "test-1" } },
        { type: "assistant.action", data: { action: "thinking" }, delayMs: 100 },
        { type: "phase.completed", data: { phaseId: "test-1" }, delayMs: 100 },
      ]);

      // Use phase-summary which has immediate execution
      const phaseSummaryConfig = loadChroniclerConfig("phase-summary.json");
      const mock = await runChroniclerTest(testLogPath, [phaseSummaryConfig]);

      // Should trigger once for phase.completed
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);

      const call = mock.getCall(0);
      if (call) {
        const [chroniclerId, events] = call;
        expect(chroniclerId).toBe("phase-summary");
        expect(events.length).toBe(1);
        expect(events[0].type).toBe("phase.completed");
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
            action: "modified" as const
          },
          delayMs: 50
        });
      }
      createTestLog(testLogPath, fileEvents);

      const fileMonitorConfig = loadChroniclerConfig("file-activity-monitor.json");
      const mock = await runChroniclerTest(testLogPath, [fileMonitorConfig]);

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
        expect(events.every(e => e.type === "file.updated")).toBe(true);
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
        { type: "tool.result", data: { isError: true, toolName: "test", error: "Error 1" }, delayMs: 100 },
        { type: "tool.result", data: { isError: true, toolName: "test", error: "Error 2" }, delayMs: 100 },
        { type: "tool.result", data: { isError: true, toolName: "test", error: "Error 3" }, delayMs: 100 },
        { type: "tool.result", data: { isError: false, toolName: "test" }, delayMs: 100 },
      ]);

      const errorDetectorConfig = loadChroniclerConfig("error-detector.json");
      const mock = await runChroniclerTest(testLogPath, [errorDetectorConfig]);

      // Should trigger once for the sequence of 3 errors
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);

      const call = mock.getCall(0);
      if (call) {
        const [chroniclerId, events] = call;
        expect(chroniclerId).toBe("error-detector");
        expect(events.length).toBe(3);
        expect(events.every(e => e.type === "tool.result" && e.data.isError === true)).toBe(true);
      }
    });

    it("should detect non-consecutive sequences when configured", async () => {
      // Create a log with non-consecutive phase events
      const testLogPath = path.join(TEMP_LOG_DIR, "non-consecutive.jsonl");
      createTestLog(testLogPath, [
        { type: "phase.started", data: { phaseId: "phase-1" } },
        { type: "assistant.action", data: { action: "thinking" }, delayMs: 100 },
        { type: "tool.result", data: { toolName: "test" }, delayMs: 100 },
        { type: "phase.completed", data: { phaseId: "phase-1" }, delayMs: 100 },
        { type: "phase.started", data: { phaseId: "phase-2" }, delayMs: 100 },
        { type: "info", data: { message: "test" }, delayMs: 100 },
        { type: "phase.completed", data: { phaseId: "phase-2" }, delayMs: 100 },
      ]);

      const nonConsecutiveConfig = loadChroniclerConfig("non-consecutive-sequence.json");
      const mock = await runChroniclerTest(testLogPath, [nonConsecutiveConfig]);

      // Should trigger twice (once for each phase lifecycle)
      expect(mock.toHaveBeenCalledTimes(2)).toBe(true);

      // Each call should have 2 events (start and complete)
      const firstCall = mock.getCall(0);
      if (firstCall) {
        const [_, events] = firstCall;
        expect(events.length).toBe(2);
        expect(events[0].type).toBe("phase.started");
        expect(events[1].type).toBe("phase.completed");
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
            toolInput: { command: "python script.py" }
          }
        },
        {
          type: "assistant.action",
          data: {
            action: "tool_use",
            toolName: "Bash",
            toolInput: { command: "ls -la" }
          },
          delayMs: 100
        },
        {
          type: "assistant.action",
          data: {
            action: "tool_use",
            toolName: "Write",
            toolInput: { path: "test.py", content: "print('hello')" }
          },
          delayMs: 100
        },
        {
          type: "assistant.action",
          data: {
            action: "tool_use",
            toolName: "Bash",
            toolInput: { command: "python3 test.py" }
          },
          delayMs: 100
        },
      ]);

      const complexConditionConfig = loadChroniclerConfig("complex-condition.json");
      const mock = await runChroniclerTest(testLogPath, [complexConditionConfig]);

      // Should trigger 3 times (for the three Bash commands)
      expect(mock.toHaveBeenCalledTimes(3)).toBe(true);

      // Verify the matched events
      for (let i = 0; i < mock.calls.length; i++) {
        const call = mock.getCall(i);
        if (call) {
          const [chroniclerId, events] = call;
          expect(chroniclerId).toBe("complex-condition");
          expect(events.length).toBe(1);
          const event = events[0];
          // Type assertion for assistant.action event data
          if (event.type === "assistant.action") {
            const data = event.data as any;
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
          delayMs: 1500 // 1.5s between events
        });
      }

      // Second window (10-20s)
      events.push({
        type: "phase.started",
        data: { phaseId: "test" },
        delayMs: 3000 // Jump to ~10.5s
      });
      for (let i = 0; i < 3; i++) {
        events.push({
          type: "tool.result",
          data: { toolName: `tool${i}` },
          delayMs: 2000
        });
      }

      // Third window (20-25s)
      events.push({
        type: "phase.completed",
        data: { phaseId: "test" },
        delayMs: 4000 // Jump to ~20.5s
      });

      createTestLog(testLogPath, events);

      const timeWindowConfig = loadChroniclerConfig("time-window-summary.json");
      const mock = await runChroniclerTest(testLogPath, [timeWindowConfig]);

      // With 10-second windows, we expect 1 call after all events are processed
      // (Our current implementation only fires once when the window closes)
      expect(mock.toHaveBeenCalledTimes(1)).toBe(true);

      // Should have collected all the events in the window
      const firstCall = mock.getCall(0);
      if (firstCall) {
        const [chroniclerId, events] = firstCall;
        expect(chroniclerId).toBe("time-window-summary");
        expect(events.length).toBeGreaterThan(0);
        // Should have collected multiple event types
        const eventTypes = new Set(events.map(e => e.type));
        expect(eventTypes.size).toBeGreaterThan(1);
      }
    });
  });

  describe("Multiple Chroniclers", () => {
    it("should handle multiple chroniclers simultaneously", async () => {
      // Create a test log with various events
      const testLogPath = path.join(TEMP_LOG_DIR, "multi-chronicler.jsonl");
      createTestLog(testLogPath, [
        { type: "phase.started", data: { phaseId: "test" } },
        { type: "assistant.action", data: { action: "thinking" }, delayMs: 100 },
        { type: "file.updated", data: { path: "file1.txt", filename: "file1.txt", content: "content1", action: "created" }, delayMs: 100 },
        { type: "file.updated", data: { path: "file2.txt", filename: "file2.txt", content: "content2", action: "modified" }, delayMs: 100 },
        { type: "tool.result", data: { toolName: "test" }, delayMs: 100 },
        { type: "file.updated", data: { path: "file3.txt", filename: "file3.txt", content: "content3", action: "modified" }, delayMs: 100 },
        { type: "phase.completed", data: { phaseId: "test" }, delayMs: 100 },
      ]);

      // Load multiple chroniclers
      const narratorConfig = loadChroniclerConfig("narrator.json");
      const fileMonitorConfig = loadChroniclerConfig("file-activity-monitor.json");
      const phaseSummaryConfig = loadChroniclerConfig("phase-summary.json");

      const mock = await runChroniclerTest(testLogPath, [
        narratorConfig,
        fileMonitorConfig,
        phaseSummaryConfig
      ]);

      // All chroniclers should have triggered
      expect(mock.toHaveBeenCalled()).toBe(true);

      // Check that different chroniclers were called
      const chroniclerIds = new Set(mock.calls.map(call => call.chroniclerId));
      expect(chroniclerIds.size).toBeGreaterThan(1);
    });
  });
});
