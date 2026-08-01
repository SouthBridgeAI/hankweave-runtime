import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import * as path from "node:path";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { Sentinel } from "../../server/sentinels/sentinel.js";
import { SentinelFatalError } from "../../server/sentinels/sentinel-fatal-error.js";
import { SentinelManager } from "../../server/sentinels/sentinel-manager.js";
import { CodonId } from "../../server/types/branded-types.js";
import type { HankweaveModelMessage } from "../../server/types/input-ai-types.js";
import type { HankweaveGenerateTextOptions } from "../../server/types/llm-call-types.js";
import type { SentinelConfig } from "../../server/types/sentinel-types.js";
import { Logger } from "../../server/utils.js";
import { createTypedMockLlmAdapter } from "../utils/mock-llm.js";

// Enhanced mock logger
class TestLogger extends Logger {
  public logs: Array<{ message: string; level: string }> = [];
  public llmCalls: Array<{
    id: string;
    eventsOrMessages: ServerEvent[] | HankweaveModelMessage[];
  }> = [];

  constructor() {
    super("/dev/null");
  }

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }

  clear(): void {
    this.logs = [];
    this.llmCalls = [];
  }

  hasLog(pattern: string | RegExp, level?: string): boolean {
    return this.logs.some((log) => {
      const messageMatches =
        typeof pattern === "string" ? log.message.includes(pattern) : pattern.test(log.message);
      const levelMatches = level ? log.level === level : true;
      return messageMatches && levelMatches;
    });
  }

  getLogsContaining(pattern: string | RegExp): Array<{ message: string; level: string }> {
    return this.logs.filter((log) => {
      return typeof pattern === "string"
        ? log.message.includes(pattern)
        : pattern.test(log.message);
    });
  }
}

const TEMP_SENTINEL_DIR = path.resolve(process.cwd(), "tests/test-area/temp-sentinels-fatal");

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

describe("Sentinel Fatal Error Handling", () => {
  describe("Configuration Fatal Errors", () => {
    it("should throw fatal error for conversational sentinel without system prompt", () => {
      const logger = new TestLogger();

      // This should fail at construction time
      const config: SentinelConfig = {
        id: "bad-conversational",
        name: "Bad Conversational",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
        },
        // Missing systemPromptText/systemPromptFile
      };

      expect(() => {
        new Sentinel(
          config,
          CodonId("test-codon"),
          createTypedMockLlmAdapter("mock"),
          logger,
          TEMP_SENTINEL_DIR,
        );
      }).toThrow(SentinelFatalError);
    });
  });

  describe("SentinelManager Unloading Logic", () => {
    it("should unload sentinels with template fatal errors", async () => {
      const logger = new TestLogger();
      const manager = new SentinelManager({
        logger,
        enablePersistence: true,
        rootDirectory: TEMP_SENTINEL_DIR,
      });

      // Create a failing LLM function that simulates template errors
      const fatalLlmCall = createTypedMockLlmAdapter(() => {
        throw new SentinelFatalError("test", "Template syntax error", "template", true);
      });

      const config: SentinelConfig = {
        id: "template-error-sentinel",
        name: "Template Error Sentinel",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        llmCallOverride: fatalLlmCall,
      });

      // Verify sentinel was loaded
      expect(manager.getSentinelCount()).toBe(1);
      expect(manager.getSentinelIds()).toContain("template-error-sentinel");

      // Send an event that should trigger the sentinel
      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test-codon", action: "message", content: "test" },
      };

      await manager.handleEvent(mockEvent);
      await manager.completeAllWork();

      // Sentinel should have been unloaded due to template error
      expect(manager.getSentinelCount()).toBe(0);
      expect(logger.hasLog("threw fatal error (template)")).toBe(true);
      expect(logger.hasLog("Unloaded sentinel template-error-sentinel")).toBe(true);
    });

    it("should respect continueOnError for conversational sentinels with LLM errors", async () => {
      const logger = new TestLogger();
      const manager = new SentinelManager({
        logger,
        enablePersistence: true,
        rootDirectory: TEMP_SENTINEL_DIR,
      });

      // LLM that throws regular errors (not fatal)
      const failingLlmCall = createTypedMockLlmAdapter(() => {
        throw new Error("LLM service temporarily unavailable");
      });

      // Conversational sentinel with continueOnError: true
      const configContinue: SentinelConfig = {
        id: "continue-on-error",
        name: "Continue On Error",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        systemPromptText: "System prompt",
        userPromptText: "Test prompt",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
          continueOnError: true,
        },
      };

      await manager.loadSentinelsForCodon([configContinue], CodonId("test-codon"), {
        llmCallOverride: failingLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test-codon", action: "message", content: "test" },
      };

      await manager.handleEvent(mockEvent);
      await manager.completeAllWork();

      // Should NOT unload because continueOnError: true handles regular LLM errors
      expect(manager.getSentinelCount()).toBe(1);
      expect(logger.hasLog("Ignoring error as per configuration and continuing conversation")).toBe(
        true,
      );
    });

    it("should unload conversational sentinels when continueOnError is false", async () => {
      const logger = new TestLogger();
      const manager = new SentinelManager({
        logger,
        enablePersistence: true,
        rootDirectory: TEMP_SENTINEL_DIR,
      });

      // LLM that throws corruption error
      const corruptionLlmCall = createTypedMockLlmAdapter(() => {
        throw new SentinelFatalError("test", "History corruption detected", "corruption", false);
      });

      // Conversational sentinel with continueOnError: false (default)
      const configNoContinue: SentinelConfig = {
        id: "no-continue-on-error",
        name: "No Continue On Error",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        systemPromptText: "System prompt",
        userPromptText: "Test prompt",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
          // continueOnError defaults to false
        },
      };

      await manager.loadSentinelsForCodon([configNoContinue], CodonId("test-codon"), {
        llmCallOverride: corruptionLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test-codon", action: "message", content: "test" },
      };

      await manager.handleEvent(mockEvent);
      await manager.completeAllWork();

      // Should unload because continueOnError is false
      expect(manager.getSentinelCount()).toBe(0);
      expect(logger.hasLog("Unloaded sentinel no-continue-on-error")).toBe(true);
    });

    it("should unload non-conversational sentinels after consecutive failures", async () => {
      const logger = new TestLogger();
      const manager = new SentinelManager({
        logger,
        enablePersistence: true,
        rootDirectory: TEMP_SENTINEL_DIR,
      });

      let callCount = 0;
      // LLM that always fails for regular errors
      const failingLlmCall = createTypedMockLlmAdapter(() => {
        callCount++;
        throw new Error(`LLM call failed attempt ${callCount}`);
      });

      const config: SentinelConfig = {
        id: "failing-sentinel",
        name: "Failing Sentinel",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        llmCallOverride: failingLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test-codon", action: "message", content: "test" },
      };

      // Send events to trigger 3 consecutive failures
      await manager.handleEvent(mockEvent);
      await manager.handleEvent(mockEvent);
      await manager.handleEvent(mockEvent);

      // Complete all work to ensure all triggers processed and unloading decisions made
      // Use try-catch since completeAllWork might fail if sentinel was unloaded mid-process
      try {
        await manager.completeAllWork();
      } catch {
        // Expected - sentinel might be unloaded during processing
      }

      // Should unload after 3 consecutive failures
      expect(manager.getSentinelCount()).toBe(0);
      expect(
        logger.hasLog(
          "Unloading non-conversational sentinel failing-sentinel after 3 consecutive failures",
        ),
      ).toBe(true);
    });

    it("should reset failure count on successful execution", async () => {
      const logger = new TestLogger();
      const manager = new SentinelManager({
        logger,
        enablePersistence: true,
        rootDirectory: TEMP_SENTINEL_DIR,
      });

      let callCount = 0;
      // LLM that fails twice then succeeds
      const intermittentLlmCall = createTypedMockLlmAdapter(async () => {
        callCount++;
        if (callCount <= 2) {
          throw new Error(`LLM call failed attempt ${callCount}`);
        }
        return "Success!";
      });

      const config: SentinelConfig = {
        id: "intermittent-sentinel",
        name: "Intermittent Sentinel",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        llmCallOverride: intermittentLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test-codon", action: "message", content: "test" },
      };

      // Send events: fail, fail, succeed
      await manager.handleEvent(mockEvent);
      await manager.handleEvent(mockEvent);
      await manager.handleEvent(mockEvent);
      await manager.completeAllWork();

      // Should NOT unload because the 3rd call succeeded, resetting the counter
      expect(manager.getSentinelCount()).toBe(1);
      expect(logger.hasLog("Unloading")).toBe(false);
    });

    it("should never unload for resource errors", async () => {
      const logger = new TestLogger();
      const manager = new SentinelManager({
        logger,
        enablePersistence: true,
        rootDirectory: TEMP_SENTINEL_DIR,
      });

      // LLM that throws resource error
      const resourceErrorLlmCall = createTypedMockLlmAdapter(() => {
        throw new SentinelFatalError(
          "test",
          "Cannot access history file - permission denied",
          "resource",
          false,
        );
      });

      const config: SentinelConfig = {
        id: "resource-error-sentinel",
        name: "Resource Error Sentinel",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        llmCallOverride: resourceErrorLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test-codon", action: "message", content: "test" },
      };

      await manager.handleEvent(mockEvent);
      await manager.completeAllWork();

      // Should keep sentinel because resource errors are transient
      expect(manager.getSentinelCount()).toBe(1);
      expect(logger.hasLog("resource errors are often transient")).toBe(true);
      expect(logger.hasLog("Keeping sentinel resource-error-sentinel")).toBe(true);
    });
  });

  describe("Error Type Classification", () => {
    it("should handle all error types correctly", async () => {
      const logger = new TestLogger();

      const testCases = [
        { errorType: "template", shouldUnload: true, reason: "will recur on every execution" },
        { errorType: "configuration", shouldUnload: true, reason: "will recur on every execution" },
        { errorType: "resource", shouldUnload: false, reason: "are often transient" },
        { errorType: "corruption", shouldUnload: false, reason: "Keeping sentinel" },
      ] as const;

      for (const testCase of testCases) {
        const manager = new SentinelManager({
          logger,
          enablePersistence: true,
          rootDirectory: TEMP_SENTINEL_DIR,
        });

        const errorLlmCall = createTypedMockLlmAdapter(() => {
          throw new SentinelFatalError(
            "test",
            `Test ${testCase.errorType} error`,
            testCase.errorType,
            false,
          );
        });

        const config: SentinelConfig = {
          id: `${testCase.errorType}-test`,
          name: `${testCase.errorType} Test`,
          model: "sonnet",
          trigger: { type: "event", on: ["assistant.action"] },
          execution: { strategy: "immediate" },
          userPromptText: "Test prompt",
        };

        await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
          llmCallOverride: errorLlmCall,
        });

        logger.clear();

        const mockEvent: ServerEvent = {
          id: "test-event",
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: { codonId: "test-codon", action: "message", content: "test" },
        };

        await manager.handleEvent(mockEvent);
        await manager.completeAllWork();

        if (testCase.shouldUnload) {
          expect(manager.getSentinelCount()).toBe(0);
          expect(logger.hasLog(testCase.reason)).toBe(true);
        } else {
          expect(manager.getSentinelCount()).toBe(1);
          expect(logger.hasLog(testCase.reason)).toBe(true);
        }
      }
    });
  });

  describe("Explicit shouldUnload Override", () => {
    it("should respect explicit shouldUnload=true regardless of error type", async () => {
      const logger = new TestLogger();
      const manager = new SentinelManager({
        logger,
        enablePersistence: true,
        rootDirectory: TEMP_SENTINEL_DIR,
      });

      // Resource error that explicitly requests unloading
      const explicitUnloadLlmCall = createTypedMockLlmAdapter(() => {
        throw new SentinelFatalError("test", "Critical resource failure", "resource", true); // Explicit unload
      });

      const config: SentinelConfig = {
        id: "explicit-unload",
        name: "Explicit Unload",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };

      await manager.loadSentinelsForCodon([config], CodonId("test-codon"), {
        llmCallOverride: explicitUnloadLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test-codon", action: "message", content: "test" },
      };

      await manager.handleEvent(mockEvent);
      await manager.completeAllWork();

      // Should unload despite being a resource error because shouldUnload=true
      expect(manager.getSentinelCount()).toBe(0);
      expect(logger.hasLog("error explicitly requested unload")).toBe(true);
    });
  });

  describe("Multiple Sentinels with Mixed Errors", () => {
    it("should handle mixed success and failure scenarios correctly", async () => {
      const logger = new TestLogger();
      const manager = new SentinelManager({
        logger,
        enablePersistence: true,
        rootDirectory: TEMP_SENTINEL_DIR,
      });

      // Three sentinels: one succeeds, one has template error, one has resource error
      const mixedLlmCall = (id: string, options: HankweaveGenerateTextOptions) => {
        switch (id) {
          case "success-sentinel":
            return createTypedMockLlmAdapter("Success!")(id, options);
          case "template-error":
            return createTypedMockLlmAdapter(() => {
              throw new SentinelFatalError(id, "Template broken", "template", true);
            })(id, options);
          case "resource-error":
            return createTypedMockLlmAdapter(() => {
              throw new SentinelFatalError(id, "File access denied", "resource", false);
            })(id, options);
          default:
            throw new Error("Unknown sentinel");
        }
      };

      const configs: SentinelConfig[] = [
        {
          id: "success-sentinel",
          name: "Success Sentinel",
          model: "sonnet",
          trigger: { type: "event", on: ["assistant.action"] },
          execution: { strategy: "immediate" },
          userPromptText: "Success",
        },
        {
          id: "template-error",
          name: "Template Error",
          model: "sonnet",
          trigger: { type: "event", on: ["assistant.action"] },
          execution: { strategy: "immediate" },
          userPromptText: "Template Error",
        },
        {
          id: "resource-error",
          name: "Resource Error",
          model: "sonnet",
          trigger: { type: "event", on: ["assistant.action"] },
          execution: { strategy: "immediate" },
          userPromptText: "Resource Error",
        },
      ];

      await manager.loadSentinelsForCodon(configs, CodonId("test-codon"), {
        llmCallOverride: mixedLlmCall,
      });

      // Start with 3 sentinels
      expect(manager.getSentinelCount()).toBe(3);

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test-codon", action: "message", content: "test" },
      };

      await manager.handleEvent(mockEvent);
      await manager.completeAllWork();

      // Should have 2 sentinels left (success + resource-error)
      // template-error should be unloaded
      expect(manager.getSentinelCount()).toBe(2);
      expect(manager.getSentinelIds()).toContain("success-sentinel");
      expect(manager.getSentinelIds()).toContain("resource-error");
      expect(manager.getSentinelIds()).not.toContain("template-error");

      expect(logger.hasLog("Unloaded sentinel template-error")).toBe(true);
    });
  });
});
