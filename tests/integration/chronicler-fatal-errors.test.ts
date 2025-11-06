import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import { ChroniclerManager } from "../../server/chroniclers/chronicler-manager.js";
import { Chronicler } from "../../server/chroniclers/chronicler.js";
import { ChroniclerFatalError } from "../../server/chroniclers/chronicler-fatal-error.js";
import { PhaseId } from "../../server/types/branded-types.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import type { ChroniclerConfig } from "../../server/types/chronicler-types.js";
import type { TadpoleModelMessage } from "../../server/types/input-ai-types.js";
import type { TadpoleGenerateTextOptions } from "../../server/types/llm-call-types.js";
import { Logger } from "../../server/utils.js";
import { createTypedMockLlmAdapter } from "../utils/mock-llm.js";

// Enhanced mock logger
class TestLogger extends Logger {
  public logs: Array<{ message: string; level: string }> = [];
  public llmCalls: Array<{ id: string; eventsOrMessages: ServerEvent[] | TadpoleModelMessage[] }> = [];

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
    return this.logs.some(log => {
      const messageMatches = typeof pattern === 'string'
        ? log.message.includes(pattern)
        : pattern.test(log.message);
      const levelMatches = level ? log.level === level : true;
      return messageMatches && levelMatches;
    });
  }

  getLogsContaining(pattern: string | RegExp): Array<{ message: string; level: string }> {
    return this.logs.filter(log => {
      return typeof pattern === 'string'
        ? log.message.includes(pattern)
        : pattern.test(log.message);
    });
  }
}

const TEMP_CHRONICLER_DIR = path.resolve(process.cwd(), "tests/test-area/temp-chroniclers-fatal");

beforeAll(() => {
  if (!fs.existsSync(TEMP_CHRONICLER_DIR)) {
    fs.mkdirSync(TEMP_CHRONICLER_DIR, { recursive: true });
  }
});

afterEach(async () => {
  try {
    await fsPromises.rm(TEMP_CHRONICLER_DIR, { recursive: true, force: true });
    await fsPromises.mkdir(TEMP_CHRONICLER_DIR, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("Chronicler Fatal Error Handling", () => {

  describe("Configuration Fatal Errors", () => {
    it("should throw fatal error for conversational chronicler without system prompt", () => {
      const logger = new TestLogger();

      // This should fail at construction time
      const config: ChroniclerConfig = {
        id: "bad-conversational",
        name: "Bad Conversational",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 }
        }
        // Missing systemPromptText/systemPromptFile
      };

      expect(() => {
        new Chronicler(
          config,
          PhaseId("test-phase"),
          createTypedMockLlmAdapter("mock"),
          logger,
          TEMP_CHRONICLER_DIR
        );
      }).toThrow(ChroniclerFatalError);
    });
  });

  describe("ChroniclerManager Unloading Logic", () => {
    it("should unload chroniclers with template fatal errors", async () => {
      const logger = new TestLogger();
      const manager = new ChroniclerManager({ logger, enablePersistence: true });

      // Create a failing LLM function that simulates template errors
      const fatalLlmCall = createTypedMockLlmAdapter(() => {
        throw new ChroniclerFatalError("test", "Template syntax error", "template", true);
      });

      const config: ChroniclerConfig = {
        id: "template-error-chronicler",
        name: "Template Error Chronicler",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt"
      };

      await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
        llmCallOverride: fatalLlmCall,
      });

      // Verify chronicler was loaded
      expect(manager.getChroniclerCount()).toBe(1);
      expect(manager.getChroniclerIds()).toContain("template-error-chronicler");

      // Send an event that should trigger the chronicler
      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test-phase", action: "message", content: "test" }
      };

      await manager.handleEvent(mockEvent);

      // Give time for async unloading (increased for queue processing)
      await new Promise(resolve => setTimeout(resolve, 100));

      // Chronicler should have been unloaded due to template error
      expect(manager.getChroniclerCount()).toBe(0);
      expect(logger.hasLog("threw fatal error (template)")).toBe(true);
      expect(logger.hasLog("Unloaded chronicler template-error-chronicler")).toBe(true);
    });

    it("should respect continueOnError for conversational chroniclers with LLM errors", async () => {
      const logger = new TestLogger();
      const manager = new ChroniclerManager({ logger, enablePersistence: true });

      // LLM that throws regular errors (not fatal)
      const failingLlmCall = createTypedMockLlmAdapter(() => {
        throw new Error("LLM service temporarily unavailable");
      });

      // Conversational chronicler with continueOnError: true
      const configContinue: ChroniclerConfig = {
        id: "continue-on-error",
        name: "Continue On Error",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        systemPromptText: "System prompt",
        userPromptText: "Test prompt",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
          continueOnError: true
        }
      };

      await manager.loadChroniclersForPhase([configContinue], PhaseId("test-phase"), {
        llmCallOverride: failingLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test-phase", action: "message", content: "test" }
      };

      await manager.handleEvent(mockEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should NOT unload because continueOnError: true handles regular LLM errors
      expect(manager.getChroniclerCount()).toBe(1);
      expect(logger.hasLog("Ignoring error as per configuration and continuing conversation")).toBe(true);
    });

    it("should unload conversational chroniclers when continueOnError is false", async () => {
      const logger = new TestLogger();
      const manager = new ChroniclerManager({ logger, enablePersistence: true });

      // LLM that throws corruption error
      const corruptionLlmCall = createTypedMockLlmAdapter(() => {
        throw new ChroniclerFatalError("test", "History corruption detected", "corruption", false);
      });

      // Conversational chronicler with continueOnError: false (default)
      const configNoContinue: ChroniclerConfig = {
        id: "no-continue-on-error",
        name: "No Continue On Error",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        systemPromptText: "System prompt",
        userPromptText: "Test prompt",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 }
          // continueOnError defaults to false
        }
      };

      await manager.loadChroniclersForPhase([configNoContinue], PhaseId("test-phase"), {
        llmCallOverride: corruptionLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test-phase", action: "message", content: "test" }
      };

      await manager.handleEvent(mockEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should unload because continueOnError is false
      expect(manager.getChroniclerCount()).toBe(0);
      expect(logger.hasLog("Unloaded chronicler no-continue-on-error")).toBe(true);
    });

    it("should unload non-conversational chroniclers after consecutive failures", async () => {
      const logger = new TestLogger();
      const manager = new ChroniclerManager({ logger, enablePersistence: true });

      let callCount = 0;
      // LLM that always fails for regular errors
      const failingLlmCall = createTypedMockLlmAdapter(() => {
        callCount++;
        throw new Error(`LLM call failed attempt ${callCount}`);
      });

      const config: ChroniclerConfig = {
        id: "failing-chronicler",
        name: "Failing Chronicler",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt"
      };

      await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
        llmCallOverride: failingLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test-phase", action: "message", content: "test" }
      };

      // Send events to trigger 3 consecutive failures
      await manager.handleEvent(mockEvent);
      await manager.handleEvent(mockEvent);
      await manager.handleEvent(mockEvent);

      // Complete all work to ensure all triggers processed and unloading decisions made
      // Use try-catch since completeAllWork might fail if chronicler was unloaded mid-process
      try {
        await manager.completeAllWork();
      } catch {
        // Expected - chronicler might be unloaded during processing
      }

      // Additional wait for async unloading to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should unload after 3 consecutive failures
      expect(manager.getChroniclerCount()).toBe(0);
      expect(logger.hasLog("Unloading non-conversational chronicler failing-chronicler after 3 consecutive failures")).toBe(true);
    });

    it("should reset failure count on successful execution", async () => {
      const logger = new TestLogger();
      const manager = new ChroniclerManager({ logger, enablePersistence: true });

      let callCount = 0;
      // LLM that fails twice then succeeds
      const intermittentLlmCall = createTypedMockLlmAdapter(async () => {
        callCount++;
        if (callCount <= 2) {
          throw new Error(`LLM call failed attempt ${callCount}`);
        }
        return "Success!";
      });

      const config: ChroniclerConfig = {
        id: "intermittent-chronicler",
        name: "Intermittent Chronicler",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt"
      };

      await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
        llmCallOverride: intermittentLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test-phase", action: "message", content: "test" }
      };

      // Send events: fail, fail, succeed
      await manager.handleEvent(mockEvent);
      await manager.handleEvent(mockEvent);
      await manager.handleEvent(mockEvent);

      await new Promise(resolve => setTimeout(resolve, 150));

      // Should NOT unload because the 3rd call succeeded, resetting the counter
      expect(manager.getChroniclerCount()).toBe(1);
      expect(logger.hasLog("Unloading")).toBe(false);
    });

    it("should never unload for resource errors", async () => {
      const logger = new TestLogger();
      const manager = new ChroniclerManager({ logger, enablePersistence: true });

      // LLM that throws resource error
      const resourceErrorLlmCall = createTypedMockLlmAdapter(() => {
        throw new ChroniclerFatalError("test", "Cannot access history file - permission denied", "resource", false);
      });

      const config: ChroniclerConfig = {
        id: "resource-error-chronicler",
        name: "Resource Error Chronicler",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt"
      };

      await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
        llmCallOverride: resourceErrorLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test-phase", action: "message", content: "test" }
      };

      await manager.handleEvent(mockEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should keep chronicler because resource errors are transient
      expect(manager.getChroniclerCount()).toBe(1);
      expect(logger.hasLog("resource errors are often transient")).toBe(true);
      expect(logger.hasLog("Keeping chronicler resource-error-chronicler")).toBe(true);
    });
  });

  describe("Error Type Classification", () => {
    it("should handle all error types correctly", async () => {
      const logger = new TestLogger();

      const testCases = [
        { errorType: "template", shouldUnload: true, reason: "will recur on every execution" },
        { errorType: "configuration", shouldUnload: true, reason: "will recur on every execution" },
        { errorType: "resource", shouldUnload: false, reason: "are often transient" },
        { errorType: "corruption", shouldUnload: false, reason: "Keeping chronicler" }
      ] as const;

      for (const testCase of testCases) {
        const manager = new ChroniclerManager({ logger, enablePersistence: true });

        const errorLlmCall = createTypedMockLlmAdapter(() => {
          throw new ChroniclerFatalError("test", `Test ${testCase.errorType} error`, testCase.errorType, false);
        });

        const config: ChroniclerConfig = {
          id: `${testCase.errorType}-test`,
          name: `${testCase.errorType} Test`,
          model: "sonnet",
          trigger: { type: "event", on: ["assistant.action"] },
          execution: { strategy: "immediate" },
          userPromptText: "Test prompt"
        };

        await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
          llmCallOverride: errorLlmCall,
        });

        logger.clear();

        const mockEvent: ServerEvent = {
          id: "test-event",
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: { phaseId: "test-phase", action: "message", content: "test" }
        };

        await manager.handleEvent(mockEvent);
        await new Promise(resolve => setTimeout(resolve, 100));

        if (testCase.shouldUnload) {
          expect(manager.getChroniclerCount()).toBe(0);
          expect(logger.hasLog(testCase.reason)).toBe(true);
        } else {
          expect(manager.getChroniclerCount()).toBe(1);
          expect(logger.hasLog(testCase.reason)).toBe(true);
        }
      }
    });
  });

  describe("Explicit shouldUnload Override", () => {
    it("should respect explicit shouldUnload=true regardless of error type", async () => {
      const logger = new TestLogger();
      const manager = new ChroniclerManager({ logger, enablePersistence: true });

      // Resource error that explicitly requests unloading
      const explicitUnloadLlmCall = createTypedMockLlmAdapter(() => {
        throw new ChroniclerFatalError("test", "Critical resource failure", "resource", true); // Explicit unload
      });

      const config: ChroniclerConfig = {
        id: "explicit-unload",
        name: "Explicit Unload",
        model: "sonnet",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt"
      };

      await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
        llmCallOverride: explicitUnloadLlmCall,
      });

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test-phase", action: "message", content: "test" }
      };

      await manager.handleEvent(mockEvent);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should unload despite being a resource error because shouldUnload=true
      expect(manager.getChroniclerCount()).toBe(0);
      expect(logger.hasLog("error explicitly requested unload")).toBe(true);
    });
  });

  describe("Multiple Chroniclers with Mixed Errors", () => {
    it("should handle mixed success and failure scenarios correctly", async () => {
      const logger = new TestLogger();
      const manager = new ChroniclerManager({ logger, enablePersistence: true });

      // Three chroniclers: one succeeds, one has template error, one has resource error
      const mixedLlmCall = (id: string, options: TadpoleGenerateTextOptions) => {
        switch (id) {
          case "success-chronicler":
            return createTypedMockLlmAdapter("Success!")(id, options);
          case "template-error":
            return createTypedMockLlmAdapter(() => {
              throw new ChroniclerFatalError(id, "Template broken", "template", true);
            })(id, options);
          case "resource-error":
            return createTypedMockLlmAdapter(() => {
              throw new ChroniclerFatalError(id, "File access denied", "resource", false);
            })(id, options);
          default:
            throw new Error("Unknown chronicler");
        }
      };

      const configs: ChroniclerConfig[] = [
        {
          id: "success-chronicler",
          name: "Success Chronicler",
          model: "sonnet",
          trigger: { type: "event", on: ["assistant.action"] },
          execution: { strategy: "immediate" },
          userPromptText: "Success"
        },
        {
          id: "template-error",
          name: "Template Error",
          model: "sonnet",
          trigger: { type: "event", on: ["assistant.action"] },
          execution: { strategy: "immediate" },
          userPromptText: "Template Error"
        },
        {
          id: "resource-error",
          name: "Resource Error",
          model: "sonnet",
          trigger: { type: "event", on: ["assistant.action"] },
          execution: { strategy: "immediate" },
          userPromptText: "Resource Error"
        }
      ];

      await manager.loadChroniclersForPhase(configs, PhaseId("test-phase"), {
        llmCallOverride: mixedLlmCall,
      });

      // Start with 3 chroniclers
      expect(manager.getChroniclerCount()).toBe(3);

      const mockEvent: ServerEvent = {
        id: "test-event",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test-phase", action: "message", content: "test" }
      };

      await manager.handleEvent(mockEvent);
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should have 2 chroniclers left (success + resource-error)
      // template-error should be unloaded
      expect(manager.getChroniclerCount()).toBe(2);
      expect(manager.getChroniclerIds()).toContain("success-chronicler");
      expect(manager.getChroniclerIds()).toContain("resource-error");
      expect(manager.getChroniclerIds()).not.toContain("template-error");

      expect(logger.hasLog("Unloaded chronicler template-error")).toBe(true);
    });
  });
});
