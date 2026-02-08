import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import { SentinelManager } from "../../server/sentinels/sentinel-manager.js";
import { Sentinel } from "../../server/sentinels/sentinel.js";
import { CodonId } from "../../server/types/branded-types.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import type { SentinelConfig } from "../../server/types/sentinel-types.js";
import type { HankweaveModelMessage } from "../../server/types/input-ai-types.js";
import { Logger } from "../../server/utils.js";
import { createTypedMockLlmAdapter } from "../utils/mock-llm.js";

// Mock events for testing
const createMockEvent = (
  type: ServerEvent["type"],
  id?: string,
): ServerEvent => {
  const baseId = id || `event-${Date.now()}-${Math.random()}`;
  const timestamp = new Date().toISOString();

  switch (type) {
    case "assistant.action":
      return {
        id: baseId,
        timestamp,
        type,
        data: { codonId: "test-codon", action: "message", content: "Test" },
      };
    case "tool.result":
      return {
        id: baseId,
        timestamp,
        type,
        data: {
          codonId: "test-codon",
          toolUseId: "test",
          toolName: "Test",
          result: "ok",
          truncated: false,
          originalLength: 2,
          executionTimeMs: 10,
          isError: false,
        },
      };
    case "file.updated":
      return {
        id: baseId,
        timestamp,
        type,
        data: {
          path: "test.txt",
          filename: "test.txt",
          content: "test",
          action: "modified",
        },
      };
    case "token.usage":
      return {
        id: baseId,
        timestamp,
        type,
        data: {
          codonId: "test-codon",
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalCost: 0.01,
        },
      };
    case "codon.started":
      return {
        id: baseId,
        timestamp,
        type,
        data: {
          codonId: "test-codon",
          codonName: "Test Codon",
          sessionId: "test-session",
          startTime: timestamp,
        },
      };
    case "codon.completed":
      return {
        id: baseId,
        timestamp,
        type,
        data: {
          codonId: "test-codon",
          success: true,
          cost: 0.01,
          duration: 1000,
          exitStatus: { type: "success" },
        },
      };
    case "server.ready":
      return {
        id: baseId,
        timestamp,
        type,
        data: {
          serverVersion: "1.0.0",
          executionPath: "/test",
          agentRootPath: "/test/agentRoot",
          dataPath: "/test/agentRoot/read_only_data_source",
          port: 7777,
        },
      };
    case "error":
      return {
        id: baseId,
        timestamp,
        type,
        data: { message: "Test error", fatal: false, severity: "codon" },
      };
    case "info":
      return { id: baseId, timestamp, type, data: { message: "Test info" } };
    default:
      // Fallback for unsupported event types in tests
      throw new Error(`Unsupported event type in test: ${type}`);
  }
};

// Enhanced mock logger with event tracking
class TestLogger extends Logger {
  public logs: Array<{ message: string; level: string }> = [];
  public llmCalls: Array<{
    id: string;
    eventsOrMessages: ServerEvent[] | HankweaveModelMessage[];
  }> = [];
  private trackedEvents: ServerEvent[] = [];

  constructor() {
    super("/dev/null");
  }

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }

  clear(): void {
    this.logs = [];
    // Don't clear llmCalls - tests want cumulative count
  }

  clearAll(): void {
    this.logs = [];
    this.llmCalls = [];
    this.trackedEvents = [];
  }

  hasLog(pattern: string | RegExp, level?: string): boolean {
    return this.logs.some((log) => {
      const messageMatches =
        typeof pattern === "string"
          ? log.message.includes(pattern)
          : pattern.test(log.message);
      const levelMatches = level ? log.level === level : true;
      return messageMatches && levelMatches;
    });
  }

  // Event tracker for compatibility with global tracking system
  trackEvents = (sentinelId: string, events: ServerEvent[]) => {
    this.trackedEvents = events;
  };

  // Mock LLM function that tracks calls with new typed interface
  mockLlm = createTypedMockLlmAdapter(() => {
    // Use the tracked events for backward compatibility
    this.llmCalls.push({
      id: "mock",
      eventsOrMessages: [...this.trackedEvents],
    });
    this.trackedEvents = []; // Clear after recording
    return Promise.resolve(`Mock response ${this.llmCalls.length}`);
  });
}

const TEMP_SENTINEL_DIR = path.resolve(
  process.cwd(),
  "tests/test-area/temp-sentinels-wildcard",
);

beforeAll(() => {
  if (!fs.existsSync(TEMP_SENTINEL_DIR)) {
    fs.mkdirSync(TEMP_SENTINEL_DIR, { recursive: true });
  }
});

afterEach(async () => {
  try {
    await fsPromises.rm(TEMP_SENTINEL_DIR, { recursive: true, force: true });
    await fsPromises.mkdir(TEMP_SENTINEL_DIR, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("Wildcard Event Trigger Tests", () => {
  describe("Event Trigger with Wildcard", () => {
    it("should trigger on any event type with '*' wildcard", async () => {
      const logger = new TestLogger();

      const config: SentinelConfig = {
        id: "wildcard-any-event",
        name: "Wildcard Any Event",
        model: "sonnet",
        trigger: {
          type: "event",
          on: ["*"],
        },
        execution: { strategy: "immediate" },
        userPromptText: "Process these events: {{events}}",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        logger.mockLlm,
        logger,
        TEMP_SENTINEL_DIR,
        undefined, // configDirectory
        new Date(), // runStartTime
        logger.trackEvents, // onExecute callback
      );

      // Test various event types
      const events = [
        createMockEvent("assistant.action"),
        createMockEvent("tool.result"),
        createMockEvent("file.updated"),
        createMockEvent("token.usage"),
      ];

      for (const event of events) {
        logger.clear();
        sentinel.handleEvent(event);

        // Should match every event type
        expect(logger.hasLog("✓ Trigger MATCHED")).toBe(true);

        // Give time for async execution
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(logger.llmCalls.length).toBeGreaterThan(0);
      }
    });

    it("should work with count strategy to trigger after N any events", async () => {
      const logger = new TestLogger();

      const config: SentinelConfig = {
        id: "wildcard-count",
        name: "Wildcard Count",
        model: "sonnet",
        trigger: {
          type: "event",
          on: ["*"],
        },
        execution: {
          strategy: "count",
          threshold: 3,
        },
        userPromptText: "Batch of {{events.length}} events",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        logger.mockLlm,
        logger,
        TEMP_SENTINEL_DIR,
        undefined, // configDirectory
        new Date(), // runStartTime
        logger.trackEvents, // onExecute callback
      );

      // Send various events
      sentinel.handleEvent(createMockEvent("assistant.action"));
      sentinel.handleEvent(createMockEvent("tool.result"));

      // Should not have triggered yet
      expect(logger.llmCalls.length).toBe(0);

      sentinel.handleEvent(createMockEvent("file.updated"));

      // Should trigger after 3rd event
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(logger.llmCalls.length).toBe(1);
      expect(logger.llmCalls[0].eventsOrMessages).toHaveLength(3);
    });

    it("should work with debounce strategy for wildcard events", async () => {
      const logger = new TestLogger();

      const config: SentinelConfig = {
        id: "wildcard-debounce",
        name: "Wildcard Debounce",
        model: "sonnet",
        trigger: {
          type: "event",
          on: ["*"],
        },
        execution: {
          strategy: "debounce",
          milliseconds: 100,
        },
        userPromptText: "Debounced events: {{events.length}}",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        logger.mockLlm,
        logger,
        TEMP_SENTINEL_DIR,
        undefined, // configDirectory
        new Date(), // runStartTime
        logger.trackEvents, // onExecute callback
      );

      // Send rapid events
      sentinel.handleEvent(createMockEvent("assistant.action"));
      sentinel.handleEvent(createMockEvent("tool.result"));
      sentinel.handleEvent(createMockEvent("file.updated"));

      // Should not have triggered immediately
      expect(logger.llmCalls.length).toBe(0);

      // Wait for debounce timer
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should have batched all events
      expect(logger.llmCalls.length).toBe(1);
      expect(logger.llmCalls[0].eventsOrMessages).toHaveLength(3);
    });
  });

  describe("Sequence Trigger with Wildcard", () => {
    it("should match wildcard steps in consecutive patterns", async () => {
      const logger = new TestLogger();

      const config: SentinelConfig = {
        id: "wildcard-sequence",
        name: "Wildcard Sequence",
        model: "sonnet",
        trigger: {
          type: "sequence",
          interestFilter: { on: ["*"] },
          pattern: [
            { type: "assistant.action" },
            { type: "*" },
            { type: "tool.result" },
          ],
        },
        execution: { strategy: "immediate" },
        userPromptText: "Sequence matched: {{events.length}} events",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        logger.mockLlm,
        logger,
        TEMP_SENTINEL_DIR,
        undefined, // configDirectory
        new Date(), // runStartTime
        logger.trackEvents, // onExecute callback
      );

      // Send pattern: assistant.action, file.updated (wildcard match), tool.result
      sentinel.handleEvent(createMockEvent("assistant.action"));
      sentinel.handleEvent(createMockEvent("file.updated")); // This should match the wildcard
      sentinel.handleEvent(createMockEvent("tool.result"));

      // Should have matched the pattern
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(logger.llmCalls.length).toBe(1);
      expect(logger.llmCalls[0].eventsOrMessages).toHaveLength(3);
      expect(logger.hasLog("PATTERN MATCHED")).toBe(true);
    });

    it("should match complex patterns with multiple wildcards", async () => {
      const logger = new TestLogger();

      const config: SentinelConfig = {
        id: "complex-wildcard",
        name: "Complex Wildcard",
        model: "sonnet",
        trigger: {
          type: "sequence",
          interestFilter: { on: ["*"] },
          pattern: [
            { type: "assistant.action" },
            { type: "assistant.action" },
            { type: "*" },
            { type: "*" },
            { type: "tool.result" },
          ],
        },
        execution: { strategy: "immediate" },
        userPromptText: "Complex pattern: {{events.length}} events",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        logger.mockLlm,
        logger,
        TEMP_SENTINEL_DIR,
        undefined, // configDirectory
        new Date(), // runStartTime
        logger.trackEvents, // onExecute callback
      );

      // Send the pattern
      sentinel.handleEvent(createMockEvent("assistant.action"));
      sentinel.handleEvent(createMockEvent("assistant.action"));
      sentinel.handleEvent(createMockEvent("file.updated")); // Wildcard 1
      sentinel.handleEvent(createMockEvent("token.usage")); // Wildcard 2
      sentinel.handleEvent(createMockEvent("tool.result"));

      // Should match the 5-event pattern
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(logger.llmCalls.length).toBe(1);
      expect(logger.llmCalls[0].eventsOrMessages).toHaveLength(5);
    });

    it("should work with non-consecutive sequence patterns", async () => {
      const logger = new TestLogger();

      const config: SentinelConfig = {
        id: "non-consecutive-wildcard",
        name: "Non-consecutive Wildcard",
        model: "sonnet",
        trigger: {
          type: "sequence",
          interestFilter: { on: ["*"] },
          pattern: [
            { type: "assistant.action" },
            { type: "*" },
            { type: "tool.result" },
          ],
          options: { consecutive: false },
        },
        execution: { strategy: "immediate" },
        userPromptText: "Non-consecutive pattern",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        logger.mockLlm,
        logger,
        TEMP_SENTINEL_DIR,
        undefined, // configDirectory
        new Date(), // runStartTime
        logger.trackEvents, // onExecute callback
      );

      // Send pattern with interleaved events
      sentinel.handleEvent(createMockEvent("assistant.action"));
      sentinel.handleEvent(createMockEvent("codon.started")); // Ignored
      sentinel.handleEvent(createMockEvent("file.updated")); // Wildcard match
      sentinel.handleEvent(createMockEvent("codon.completed")); // Ignored
      sentinel.handleEvent(createMockEvent("tool.result"));

      // Should match despite interleaved events
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(logger.llmCalls.length).toBe(1);
      expect(logger.llmCalls[0].eventsOrMessages).toHaveLength(3);
    });
  });

  describe("Wildcard with Conditions", () => {
    it("should apply conditions to wildcard events when possible", async () => {
      const logger = new TestLogger();

      const config: SentinelConfig = {
        id: "wildcard-with-conditions",
        name: "Wildcard with Conditions",
        model: "sonnet",
        trigger: {
          type: "event",
          on: ["*"],
          conditions: [
            { operator: "equals", path: "codonId", value: "test-codon" },
          ],
        },
        execution: { strategy: "immediate" },
        userPromptText: "Event with codonId: {{events.length}}",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        logger.mockLlm,
        logger,
        TEMP_SENTINEL_DIR,
        undefined, // configDirectory
        new Date(), // runStartTime
        logger.trackEvents, // onExecute callback
      );

      // Send event with matching codonId
      const eventWithCodon = createMockEvent("assistant.action");
      sentinel.handleEvent(eventWithCodon);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(logger.llmCalls.length).toBe(1);

      // Send event without codonId (should not match condition)
      logger.clear();
      const eventWithoutCodon: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "server.ready",
        data: {
          serverVersion: "1.0.0",
          executionPath: "/test",
          agentRootPath: "/test/agentRoot",
          dataPath: "/test/agentRoot/read_only_data_source",
          port: 7777,
        },
      };

      sentinel.handleEvent(eventWithoutCodon);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(logger.llmCalls.length).toBe(1); // Should not have increased
    });
  });

  describe("Mixed Wildcard and Specific Events", () => {
    it("should handle triggers with both wildcard and specific events", async () => {
      const logger = new TestLogger();

      const config: SentinelConfig = {
        id: "mixed-wildcard",
        name: "Mixed Wildcard",
        model: "sonnet",
        trigger: {
          type: "event",
          on: ["assistant.action", "*", "tool.result"],
        },
        execution: { strategy: "immediate" },
        userPromptText: "Mixed trigger: {{events.length}}",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        logger.mockLlm,
        logger,
        TEMP_SENTINEL_DIR,
        undefined, // configDirectory
        new Date(), // runStartTime
        logger.trackEvents, // onExecute callback
      );

      // Should match explicit assistant.action
      sentinel.handleEvent(createMockEvent("assistant.action"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(logger.llmCalls.length).toBe(1);

      // Should match explicit tool.result
      logger.clear();
      sentinel.handleEvent(createMockEvent("tool.result"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(logger.llmCalls.length).toBe(2);

      // Should match any other event via wildcard
      logger.clear();
      sentinel.handleEvent(createMockEvent("file.updated"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(logger.llmCalls.length).toBe(3);
    });
  });

  describe("Wildcard in Interest Filter", () => {
    it("should capture all events in sequence interest filter with wildcard", async () => {
      const logger = new TestLogger();

      const config: SentinelConfig = {
        id: "wildcard-interest",
        name: "Wildcard Interest Filter",
        model: "sonnet",
        trigger: {
          type: "sequence",
          interestFilter: { on: ["*"] },
          pattern: [{ type: "assistant.action" }, { type: "tool.result" }],
        },
        execution: { strategy: "immediate" },
        userPromptText: "Sequence from all events",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        logger.mockLlm,
        logger,
        TEMP_SENTINEL_DIR,
        undefined, // configDirectory
        new Date(), // runStartTime
        logger.trackEvents, // onExecute callback
      );

      // Send events that form a consecutive pattern at the end
      sentinel.handleEvent(createMockEvent("file.updated"));
      sentinel.handleEvent(createMockEvent("assistant.action")); // Pattern start
      sentinel.handleEvent(createMockEvent("tool.result")); // Pattern end

      // Should match the consecutive pattern
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(logger.llmCalls.length).toBe(1);
      expect(logger.llmCalls[0].eventsOrMessages).toHaveLength(2); // assistant.action + tool.result
    });
  });

  describe("Performance with Wildcards", () => {
    it("should handle high-frequency wildcard triggers efficiently", async () => {
      const logger = new TestLogger();

      const config: SentinelConfig = {
        id: "high-freq-wildcard",
        name: "High Frequency Wildcard",
        model: "sonnet",
        trigger: {
          type: "event",
          on: ["*"],
        },
        execution: {
          strategy: "debounce",
          milliseconds: 50,
        },
        userPromptText: "Batched events: {{events.length}}",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        logger.mockLlm,
        logger,
        TEMP_SENTINEL_DIR,
        undefined, // configDirectory
        new Date(), // runStartTime
        logger.trackEvents, // onExecute callback
      );

      const startTime = Date.now();

      // Send 20 rapid events of different types
      for (let i = 0; i < 20; i++) {
        const eventTypes: ServerEvent["type"][] = [
          "assistant.action",
          "tool.result",
          "file.updated",
          "token.usage",
        ];
        const eventType = eventTypes[i % eventTypes.length];
        sentinel.handleEvent(createMockEvent(eventType, `event-${i}`));
      }

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 100));

      const endTime = Date.now();

      // Should have batched all events into one call
      expect(logger.llmCalls.length).toBe(1);
      expect(logger.llmCalls[0].eventsOrMessages).toHaveLength(20);

      // Should be efficient (less than 200ms for 20 events + debounce)
      expect(endTime - startTime).toBeLessThan(200);
    });
  });
});
