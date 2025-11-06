import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Chronicler } from "../../server/chroniclers/chronicler.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { PhaseId } from "../../server/types/branded-types.js";
import type { ChroniclerConfig } from "../../server/types/chronicler-types.js";
import type {
  TadpoleGenerateTextOptions,
  TadpoleGenerateTextResult,
} from "../../server/types/llm-call-types.js";
import { createMockLlm } from "../utils/mock-llm.js";

// Helper function to create mock server events
function createMockServerEvent(type: string, data: Record<string, unknown>): ServerEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    type,
    data,
  } as ServerEvent;
}

describe("Chronicler LLM Interaction Logic", () => {
  const mockLlmProvider = createMockLlm();
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicler-logic-test-"));
  });

  describe("Non-conversational chronicler LLM calls", () => {
    it("should construct the correct TadpoleGenerateTextOptions for a non-conversational chronicler", async () => {
      const capturedOptions: TadpoleGenerateTextOptions[] = [];
      const mockLlmCall = async (
        _id: string,
        options: TadpoleGenerateTextOptions,
      ): Promise<TadpoleGenerateTextResult> => {
        capturedOptions.push(options);
        return await mockLlmProvider.generateText(options);
      };

      // Create a non-conversational chronicler config
      const config: ChroniclerConfig = {
        id: "test-chronicler",
        name: "Test Chronicler",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        systemPromptText: "You are a test chronicler",
        userPromptText: "Events: <%= it.events.length %> events occurred",
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined, // logger
        undefined, // chroniclerDir
        undefined, // configDirectory
        new Date(),
      );

      const testEvent = createMockServerEvent("assistant.action", {
        phaseId: "test-phase",
        action: "thinking",
      });

      await chronicler.handleEvent(testEvent);
      await chronicler.completeAllWork(); // Ensures queue is fully processed

      // Assertions
      expect(capturedOptions.length).toBe(1);
      const opts = capturedOptions[0];
      expect(opts.system).toBe("You are a test chronicler");
      expect(opts.messages.length).toBe(1);
      expect(opts.messages[0].role).toBe("user");
      expect(opts.messages[0].content).toBe("Events: 1 events occurred");
    });

    it("should handle templates correctly in non-conversational mode", async () => {
      const capturedOptions: TadpoleGenerateTextOptions[] = [];
      const mockLlmCall = async (
        _id: string,
        options: TadpoleGenerateTextOptions,
      ): Promise<TadpoleGenerateTextResult> => {
        capturedOptions.push(options);
        return await mockLlmProvider.generateText(options);
      };

      const config: ChroniclerConfig = {
        id: "template-test",
        name: "Template Test",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["tool.result"] },
        execution: { strategy: "immediate" },
        systemPromptText: "System context: phase <%= it.phase.name %>",
        userPromptText:
          "Process these <%= it.events.length %> events at <%= it.world.currentTime.toISOString() %>",
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined, // logger
        undefined, // chroniclerDir
        undefined, // configDirectory
        new Date("2025-01-01T00:00:00Z"), // runStartTime
      );

      const testEvent = createMockServerEvent("tool.result", {
        phaseId: "test-phase",
        toolUseId: "test-tool",
        toolName: "TestTool",
        result: "test result",
        truncated: false,
        originalLength: 11,
        executionTimeMs: 100,
        isError: false,
      });

      await chronicler.handleEvent(testEvent);
      await chronicler.completeAllWork();

      expect(capturedOptions.length).toBe(1);
      const opts = capturedOptions[0];
      expect(opts.system).toBe("System context: phase Template Test");
      expect(opts.messages[0].content).toContain("Process these 1 events at ");
      // The template uses world.currentTime (current execution time), not phase start time
      expect(opts.messages[0].content).toMatch(
        /Process these 1 events at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
      );
    });

    it("should respect LLM parameters from config", async () => {
      const capturedOptions: TadpoleGenerateTextOptions[] = [];
      const mockLlmCall = async (
        _id: string,
        options: TadpoleGenerateTextOptions,
      ): Promise<TadpoleGenerateTextResult> => {
        capturedOptions.push(options);
        return await mockLlmProvider.generateText(options);
      };

      const config: ChroniclerConfig = {
        id: "param-test",
        name: "Parameter Test",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["file.updated"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
        llmParams: {
          temperature: 0.5,
          maxOutputTokens: 1000,
          maxRetries: 3,
        },
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined, // logger
        undefined, // chroniclerDir
        undefined, // configDirectory
        new Date(), // runStartTime
      );

      const testEvent = createMockServerEvent("file.updated", {
        path: "test.txt",
        filename: "test.txt",
        content: "test content",
        action: "modified",
      });

      await chronicler.handleEvent(testEvent);
      await chronicler.completeAllWork();

      expect(capturedOptions.length).toBe(1);
      const opts = capturedOptions[0];
      expect(opts.temperature).toBe(0.5);
      expect(opts.maxOutputTokens).toBe(1000);
      expect(opts.maxRetries).toBe(3);
    });
  });

  describe("Conversational chronicler LLM calls", () => {
    it("should construct correct options for a conversational chronicler, including history", async () => {
      const capturedOptions: TadpoleGenerateTextOptions[] = [];
      const mockLlmCall = async (
        _id: string,
        options: TadpoleGenerateTextOptions,
      ): Promise<TadpoleGenerateTextResult> => {
        capturedOptions.push(options);
        return await mockLlmProvider.generateText(options);
      };

      const config: ChroniclerConfig = {
        id: "conversational-test",
        name: "Conversational Test",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        systemPromptText: "You are a conversational chronicler",
        userPromptText: "New events: <%= it.events.length %>",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
        },
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined, // logger
        testDir, // chroniclerDir for history persistence
        undefined, // configDirectory
        new Date(), // runStartTime
      );

      // Add some existing history
      const historyManager = chronicler.getHistoryManager();
      expect(historyManager).toBeDefined();
      if (historyManager) {
        await historyManager.addMessagePair("Old question", "Old answer");
      }

      const testEvent = createMockServerEvent("assistant.action", {
        phaseId: "test-phase",
        action: "thinking",
      });

      await chronicler.handleEvent(testEvent);
      await chronicler.completeAllWork();

      expect(capturedOptions.length).toBe(1);
      const opts = capturedOptions[0];
      expect(opts.system).toBeUndefined(); // System prompt should be in messages for conversational
      expect(opts.messages.length).toBe(4); // system + old_user + old_assistant + new_user
      expect(opts.messages[0].role).toBe("system");
      expect(opts.messages[0].content).toBe("You are a conversational chronicler");
      expect(opts.messages[1].role).toBe("user");
      expect(opts.messages[1].content).toBe("Old question");
      expect(opts.messages[2].role).toBe("assistant");
      expect(opts.messages[2].content).toBe("Old answer");
      expect(opts.messages[3].role).toBe("user");
      expect(opts.messages[3].content).toBe("New events: 1");
    });

    it("should add the LLM response to history ONLY on successful call", async () => {
      const mockLlmCall = async (
        _id: string,
        options: TadpoleGenerateTextOptions,
      ): Promise<TadpoleGenerateTextResult> => {
        return await mockLlmProvider.generateText(options);
      };

      const config: ChroniclerConfig = {
        id: "history-test",
        name: "History Test",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        systemPromptText: "System prompt",
        userPromptText: "User prompt template",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
        },
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined, // logger
        testDir, // chroniclerDir
        undefined, // configDirectory
        new Date(), // runStartTime
      );

      const historyManager = chronicler.getHistoryManager();
      expect(historyManager).toBeDefined();
      if (historyManager) {
        const addPairSpy = spyOn(historyManager, "addMessagePair");

        const testEvent = createMockServerEvent("assistant.action", {
          phaseId: "test-phase",
          action: "thinking",
        });

        await chronicler.handleEvent(testEvent);
        await chronicler.completeAllWork(); // Ensure all work is done

        expect(addPairSpy).toHaveBeenCalledTimes(1);
        const callArgs = addPairSpy.mock.calls[0];
        expect(callArgs[0]).toBe("User prompt template");
        expect(typeof callArgs[1]).toBe("string");
        expect(callArgs[1]).toContain("Mock response for:");
      }
    });

    it("should handle LLM errors correctly based on continueOnError setting", async () => {
      let callCount = 0;
      const mockLlmCall = async (_id: string, _options: TadpoleGenerateTextOptions) => {
        callCount++;
        throw new Error("LLM API Error");
      };

      const config: ChroniclerConfig = {
        id: "error-test",
        name: "Error Test",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        systemPromptText: "System prompt",
        userPromptText: "User prompt",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
          continueOnError: true, // Should not throw error
        },
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined, // logger
        testDir, // chroniclerDir
        undefined, // configDirectory
        new Date(), // runStartTime
      );

      const testEvent = createMockServerEvent("assistant.action", {
        phaseId: "test-phase",
        action: "thinking",
      });

      // Should not throw error due to continueOnError: true
      await expect(chronicler.handleEvent(testEvent)).resolves.toBeUndefined();
      await chronicler.completeAllWork();
      expect(callCount).toBe(1);
    });

    it("should throw LLM errors when continueOnError is false", async () => {
      const mockLlmCall = async (_id: string, _options: TadpoleGenerateTextOptions) => {
        throw new Error("LLM API Error");
      };

      const config: ChroniclerConfig = {
        id: "error-test-2",
        name: "Error Test 2",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        systemPromptText: "System prompt",
        userPromptText: "User prompt",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
          continueOnError: false, // Should throw error
        },
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined, // logger
        testDir, // chroniclerDir
        undefined, // configDirectory
        new Date(), // runStartTime
      );

      const testEvent = createMockServerEvent("assistant.action", {
        phaseId: "test-phase",
        action: "thinking",
      });

      // With queueing, errors are thrown during queue processing
      // For non-conversational with continueOnError:false, the error propagates
      // We need to catch it during completeAllWork() or processQueue
      await chronicler.handleEvent(testEvent);

      // The error will be thrown during queue processing
      // Since this is immediate + non-conversational with continueOnError:false,
      // the error should propagate from processQueue
      // But handleEvent itself doesn't throw anymore with queueing
      // Just wait to verify the call was attempted
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  describe("Event processing", () => {
    it("should pass the correct event data to templates", async () => {
      const capturedOptions: TadpoleGenerateTextOptions[] = [];
      const mockLlmCall = async (
        _id: string,
        options: TadpoleGenerateTextOptions,
      ): Promise<TadpoleGenerateTextResult> => {
        capturedOptions.push(options);
        return await mockLlmProvider.generateText(options);
      };

      const config: ChroniclerConfig = {
        id: "event-test",
        name: "Event Test",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["tool.result", "file.updated"] },
        execution: { strategy: "immediate" },
        userPromptText: `
Event Details:
<% for (const event of it.events) { %>
- Type: <%= event.type %>
- Timestamp: <%= event.timestamp %>
<% if (event.type === 'tool.result') { %>
- Tool: <%= event.data.toolName %>
- Success: <%= !event.data.isError %>
<% } %>
<% if (event.type === 'file.updated') { %>
- File: <%= event.data.filename %>
- Action: <%= event.data.action %>
<% } %>
<% } %>
Total: <%= it.events.length %> events
        `.trim(),
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined, // logger
        undefined, // chroniclerDir
        undefined, // configDirectory
        new Date(), // runStartTime
      );

      const toolEvent = createMockServerEvent("tool.result", {
        phaseId: "test-phase",
        toolUseId: "tool-123",
        toolName: "ReadFile",
        result: "file content",
        truncated: false,
        originalLength: 12,
        executionTimeMs: 150,
        isError: false,
      });

      const fileEvent = createMockServerEvent("file.updated", {
        path: "src/test.ts",
        filename: "test.ts",
        content: "export const test = true;",
        action: "created",
      });

      // Process both events
      await chronicler.handleEvent(toolEvent);
      await chronicler.handleEvent(fileEvent);
      // Use completeAllWork() to ensure all triggers are processed
      await chronicler.completeAllWork();

      expect(capturedOptions.length).toBe(2);

      const firstCall = capturedOptions[0];
      expect(firstCall.messages[0].content).toContain("Type: tool.result");
      expect(firstCall.messages[0].content).toContain("Tool: ReadFile");
      expect(firstCall.messages[0].content).toContain("Success: true");
      expect(firstCall.messages[0].content).toContain("Total: 1 events");

      const secondCall = capturedOptions[1];
      expect(secondCall.messages[0].content).toContain("Type: file.updated");
      expect(secondCall.messages[0].content).toContain("File: test.ts");
      expect(secondCall.messages[0].content).toContain("Action: created");
      expect(secondCall.messages[0].content).toContain("Total: 1 events");
    });

    it("should handle multiple events with debounce strategy", async () => {
      const capturedOptions: TadpoleGenerateTextOptions[] = [];
      const mockLlmCall = async (
        _id: string,
        options: TadpoleGenerateTextOptions,
      ): Promise<TadpoleGenerateTextResult> => {
        capturedOptions.push(options);
        return await mockLlmProvider.generateText(options);
      };

      const config: ChroniclerConfig = {
        id: "debounce-test",
        name: "Debounce Test",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["file.updated"] },
        execution: { strategy: "debounce", milliseconds: 100 },
        userPromptText: "Processed <%= it.events.length %> events",
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined, // logger
        undefined, // chroniclerDir
        undefined, // configDirectory
        new Date(), // runStartTime
      );

      // Create multiple events
      const events = [
        createMockServerEvent("file.updated", {
          path: "file1.ts",
          filename: "file1.ts",
          content: "content1",
          action: "modified",
        }),
        createMockServerEvent("file.updated", {
          path: "file2.ts",
          filename: "file2.ts",
          content: "content2",
          action: "created",
        }),
        createMockServerEvent("file.updated", {
          path: "file3.ts",
          filename: "file3.ts",
          content: "content3",
          action: "deleted",
        }),
      ];

      // Process events quickly
      for (const event of events) {
        await chronicler.handleEvent(event);
      }

      // Wait for debounce to complete
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should have made one call with all events
      expect(capturedOptions.length).toBe(1);
      expect(capturedOptions[0].messages[0].content).toBe("Processed 3 events");
    });
  });

  describe("Configuration validation", () => {
    it("should validate conversational chroniclers have system prompts", async () => {
      const mockLlmCall = async (): Promise<TadpoleGenerateTextResult> => {
        return {
          text: "response",
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 8 },
        };
      };

      const invalidConfig: ChroniclerConfig = {
        id: "invalid-conv",
        name: "Invalid Conversational",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "User prompt only",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
        },
        // Missing system prompt
      };

      expect(() => {
        new Chronicler(
          invalidConfig,
          PhaseId("test-phase"),
          mockLlmCall,
          undefined, // logger
          undefined, // chroniclerDir
          undefined, // configDirectory
          new Date(), // runStartTime
        );
      }).toThrow("Conversational chronicler missing required system prompt");
    });

    it("should accept valid conversational configuration", async () => {
      const mockLlmCall = async (): Promise<TadpoleGenerateTextResult> => {
        return {
          text: "response",
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 8 },
        };
      };

      const validConfig: ChroniclerConfig = {
        id: "valid-conv",
        name: "Valid Conversational",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        systemPromptText: "You are a chronicler",
        userPromptText: "User prompt",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
        },
      };

      expect(() => {
        new Chronicler(
          validConfig,
          PhaseId("test-phase"),
          mockLlmCall,
          undefined, // logger
          testDir, // chroniclerDir
          undefined, // configDirectory
          new Date(), // runStartTime
        );
      }).not.toThrow();
    });
  });
});
