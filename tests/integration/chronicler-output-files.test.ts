import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChroniclerManager } from "../../server/chroniclers/chronicler-manager.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { PhaseId } from "../../server/types/branded-types.js";
import type { ChroniclerConfig, ChroniclerOutputPaths } from "../../server/types/chronicler-types.js";
import type {
  TadpoleGenerateObjectOptions,
  TadpoleGenerateObjectResult,
  TadpoleGenerateTextOptions,
  TadpoleGenerateTextResult,
} from "../../server/types/llm-call-types.js";

describe("Chronicler Output Files - Integration Tests", () => {
  let testDir: string;
  let executionPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicler-output-int-"));
    executionPath = testDir;
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  const createMockLlmCall = (responseText = "Mock response") => {
    return async (_id: string, _options: TadpoleGenerateTextOptions): Promise<TadpoleGenerateTextResult> => {
      return {
        text: responseText,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    };
  };

  const createMockObjectCall = (responseObject: unknown) => {
    return async (_id: string, _options: TadpoleGenerateObjectOptions): Promise<TadpoleGenerateObjectResult<unknown>> => {
      return {
        object: responseObject,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    };
  };

  describe("Auto-Generated Files", () => {
    test("auto-generates files in .tadpole/chroniclers/outputs/", async () => {
      const config: ChroniclerConfig = {
        id: "test-chronicler",
        name: "Test Chronicler",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Summarize: <%= JSON.stringify(it.events) %>",
        model: "test-model",
        joinString: "\n---\n",
      };

      const manager = new ChroniclerManager({ enablePersistence: false });
      await manager.initialize();

      let callCount = 0;
      const mockLlm = async (id: string, options: TadpoleGenerateTextOptions) => {
        callCount++;
        return {
          text: `Summary ${callCount}`,
          finishReason: "stop" as const,
          usage: { inputTokens: 10, outputTokens: 20 },
        };
      };

      await manager.loadChroniclersForPhase([config], PhaseId("phase-1"), {
        llmCallOverride: mockLlm,
        executionPath,
      });

      // Trigger twice
      for (let i = 0; i < 2; i++) {
        await manager.handleEvent({
          id: `evt-${i}`,
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: { phaseId: "test", action: "message", content: "test" },
        });
      }

      await manager.completeAllWork();

      // Files should be auto-generated in .tadpole/chroniclers/outputs/test-chronicler/
      const autoDir = path.join(executionPath, ".tadpole", "chroniclers", "outputs", "test-chronicler");
      expect(fs.existsSync(autoDir)).toBe(true);

      const files = fs.readdirSync(autoDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^test-chronicler-phase-1-\d+\.md$/);

      const logContent = fs.readFileSync(path.join(autoDir, files[0]), "utf-8");
      expect(logContent).toBe("\n---\nSummary 1\n\n---\nSummary 2\n");
    });
  });

  describe("Structured Output Files", () => {
    test("auto-generates NDJSON files for structured output", async () => {
      const config: ChroniclerConfig = {
        id: "entity-tracker",
        name: "Entity Tracker",
        trigger: { type: "event", on: ["file.updated"] },
        execution: { strategy: "immediate" },
        userPromptText: "Extract entities",
        model: "test-model",
        structuredOutput: {
          output: "object",
          schemaStr: "z.object({ name: z.string(), type: z.string() })",
        },
      };

      const manager = new ChroniclerManager({ enablePersistence: false });
      await manager.initialize();

      const entities = [
        { name: "Alice", type: "person" },
        { name: "Paris", type: "place" },
      ];

      let callIndex = 0;
      const mockObjectCall = async () => ({
        object: entities[callIndex++],
        finishReason: "stop" as const,
        usage: { inputTokens: 10, outputTokens: 20 },
      });

      await manager.loadChroniclersForPhase([config], PhaseId("phase-1"), {
        llmCallOverride: createMockLlmCall(),
        llmObjectCallOverride: mockObjectCall,
        executionPath,
      });

      // Trigger twice
      for (let i = 0; i < 2; i++) {
        await manager.handleEvent({
          id: `evt-${i}`,
          timestamp: new Date().toISOString(),
          type: "file.updated",
          data: { path: "test.ts", filename: "test.ts", content: "", action: "created" },
        });
      }

      await manager.completeAllWork();

      // Find auto-generated file
      const autoDir = path.join(executionPath, ".tadpole", "chroniclers", "outputs", "entity-tracker");
      expect(fs.existsSync(autoDir)).toBe(true);

      const files = fs.readdirSync(autoDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^entity-tracker-phase-1-\d+\.ndjson$/);

      // Verify NDJSON format (one object per line)
      const logContent = fs.readFileSync(path.join(autoDir, files[0]), "utf-8");
      const lines = logContent.trim().split("\n");
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0])).toEqual({ name: "Alice", type: "person" });
      expect(JSON.parse(lines[1])).toEqual({ name: "Paris", type: "place" });
    });
  });

  describe("Cross-Phase File Reuse with Auto-Generation", () => {
    test("demonstrates file reuse pattern (same directory persists)", async () => {
      const config: ChroniclerConfig = {
        id: "progress-tracker",
        name: "Progress Tracker",
        trigger: { type: "event", on: ["phase.completed"] },
        execution: { strategy: "immediate" },
        userPromptText: "Track progress",
        model: "test-model",
      };

      // Simulate Phase 1
      let phase1File: string;
      {
        const manager = new ChroniclerManager({ enablePersistence: false });
        await manager.initialize();

        await manager.loadChroniclersForPhase([config], PhaseId("phase-1"), {
          llmCallOverride: createMockLlmCall("Phase 1 completed"),
          executionPath,
        });

        await manager.handleEvent({
          id: "evt-1",
          timestamp: new Date().toISOString(),
          type: "phase.completed",
          data: { phaseId: "phase-1", success: true, cost: 0.1, duration: 1000, exitStatus: { type: "success" } },
        });

        await manager.shutdown();

        // Get the auto-generated file
        const autoDir = path.join(executionPath, ".tadpole", "chroniclers", "outputs", "progress-tracker");
        const files = fs.readdirSync(autoDir);
        phase1File = path.join(autoDir, files[0]);

        // Verify Phase 1 output
        expect(fs.readFileSync(phase1File, "utf-8")).toBe("\n---\nPhase 1 completed\n");
      }

      // Simulate Phase 2 with different auto-generated file
      {
        const manager = new ChroniclerManager({ enablePersistence: false });
        await manager.initialize();

        await manager.loadChroniclersForPhase([config], PhaseId("phase-2"), {
          llmCallOverride: createMockLlmCall("Phase 2 completed"),
          executionPath,
        });

        await manager.handleEvent({
          id: "evt-2",
          timestamp: new Date().toISOString(),
          type: "phase.completed",
          data: { phaseId: "phase-2", success: true, cost: 0.2, duration: 2000, exitStatus: { type: "success" } },
        });

        await manager.shutdown();

        // Phase 1 file still exists (persistence)
        expect(fs.existsSync(phase1File)).toBe(true);
        expect(fs.readFileSync(phase1File, "utf-8")).toBe("\n---\nPhase 1 completed\n");

        // Phase 2 has its own file
        const autoDir = path.join(executionPath, ".tadpole", "chroniclers", "outputs", "progress-tracker");
        const files = fs.readdirSync(autoDir);
        expect(files.length).toBe(2); // Both phase files exist

        const phase2File = files.find(f => f.includes("phase-2"));
        expect(phase2File).toBeDefined();
        expect(fs.readFileSync(path.join(autoDir, phase2File!), "utf-8")).toBe("\n---\nPhase 2 completed\n");
      }
    });
  });

  describe("Escape Sequences in Real Scenarios", () => {
    test("renders escape sequences correctly in output", async () => {
      const config: ChroniclerConfig = {
        id: "formatted-log",
        name: "Formatted Log",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Log event",
        model: "test-model",
        joinString: "\\n=====\\n", // Newline, separator, newline
      };

      const manager = new ChroniclerManager({ enablePersistence: false });
      await manager.initialize();

      let callCount = 0;
      const mockLlm = async () => ({
        text: `Entry ${++callCount}`,
        finishReason: "stop" as const,
        usage: { inputTokens: 5, outputTokens: 10 },
      });

      await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
        llmCallOverride: mockLlm,
        executionPath,
      });

      for (let i = 0; i < 2; i++) {
        await manager.handleEvent({
          id: `evt-${i}`,
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: { phaseId: "test", action: "message", content: "test" },
        });
      }

      await manager.completeAllWork();

      // Find auto-generated file
      const autoDir = path.join(executionPath, ".tadpole", "chroniclers", "outputs", "formatted-log");
      const files = fs.readdirSync(autoDir);
      const logPath = path.join(autoDir, files[0]);

      const content = fs.readFileSync(logPath, "utf-8");

      // Should have actual newlines and separators
      expect(content).toBe("\n=====\nEntry 1\n\n=====\nEntry 2\n");
      expect(content.split("\n").length).toBe(7); // Empty, =====, Entry 1, empty, =====, Entry 2, empty
    });
  });

  describe("Mixed Chroniclers with Different Outputs", () => {
    test("handles multiple chroniclers with different output configurations", async () => {
      const textChronicler: ChroniclerConfig = {
        id: "narrator",
        name: "Narrator",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Narrate",
        model: "test-model",
      };

      const structuredChronicler: ChroniclerConfig = {
        id: "metrics",
        name: "Metrics Tracker",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Track metrics",
        model: "test-model",
        structuredOutput: {
          output: "object",
          schemaStr: "z.object({ count: z.number() })",
        },
      };

      const manager = new ChroniclerManager({ enablePersistence: false });
      await manager.initialize();

      const mockText = createMockLlmCall("Narrative");
      const mockObject = createMockObjectCall({ count: 1 });

      // Load both chroniclers - note we need to provide outputPaths in the future
      // For now they auto-generate
      await manager.loadChroniclersForPhase(
        [textChronicler, structuredChronicler],
        PhaseId("test-phase"),
        {
          llmCallOverride: mockText,
          llmObjectCallOverride: mockObject,
          executionPath,
        },
      );

      await manager.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await manager.completeAllWork();

      // Verify text chronicler output
      const narratorDir = path.join(executionPath, ".tadpole", "chroniclers", "outputs", "narrator");
      expect(fs.existsSync(narratorDir)).toBe(true);
      const narratorFiles = fs.readdirSync(narratorDir);
      expect(narratorFiles.length).toBe(1);
      expect(narratorFiles[0]).toEndWith(".md");

      // Verify structured chronicler output
      const metricsDir = path.join(executionPath, ".tadpole", "chroniclers", "outputs", "metrics");
      expect(fs.existsSync(metricsDir)).toBe(true);
      const metricsFiles = fs.readdirSync(metricsDir);
      expect(metricsFiles.length).toBe(1);
      expect(metricsFiles[0]).toEndWith(".ndjson");
    });
  });

  describe("Conversational Chronicler with Output Files", () => {
    test("accumulates conversation in auto-generated logFile", async () => {
      const config: ChroniclerConfig = {
        id: "conversational-narrator",
        name: "Conversational Narrator",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        systemPromptText: "You are a narrator",
        userPromptText: "Continue the story",
        model: "test-model",
        conversational: {
          trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
        },
      };

      const manager = new ChroniclerManager({ enablePersistence: false });
      await manager.initialize();

      let turn = 0;
      const mockLlm = async () => ({
        text: `Turn ${++turn} narrative`,
        finishReason: "stop" as const,
        usage: { inputTokens: 10, outputTokens: 20 },
      });

      await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
        llmCallOverride: mockLlm,
        executionPath,
      });

      // Multiple conversation turns
      for (let i = 0; i < 3; i++) {
        await manager.handleEvent({
          id: `evt-${i}`,
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: { phaseId: "test", action: "message", content: "test" },
        });
      }

      await manager.completeAllWork();

      // Find auto-generated file
      const autoDir = path.join(executionPath, ".tadpole", "chroniclers", "outputs", "conversational-narrator");
      const files = fs.readdirSync(autoDir);
      const logPath = path.join(autoDir, files[0]);

      // Log should have all turns
      const logContent = fs.readFileSync(logPath, "utf-8");
      expect(logContent).toContain("Turn 1 narrative");
      expect(logContent).toContain("Turn 2 narrative");
      expect(logContent).toContain("Turn 3 narrative");
    });
  });

  describe("Error Handling", () => {
    test("continues execution when write fails (permissions)", async () => {
      const config: ChroniclerConfig = {
        id: "test-chronicler",
        name: "Test",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test",
        model: "test-model",
      };

      const manager = new ChroniclerManager({ enablePersistence: false });
      await manager.initialize();

      await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
        llmCallOverride: createMockLlmCall("Test"),
        executionPath,
      });

      // Find and make the auto-generated file read-only
      const autoDir = path.join(executionPath, ".tadpole", "chroniclers", "outputs", "test-chronicler");
      const files = fs.readdirSync(autoDir);
      const logPath = path.join(autoDir, files[0]);
      fs.chmodSync(logPath, 0o444); // Read-only

      // Should not throw despite write error
      await manager.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await manager.completeAllWork();

      // Chronicler should still be active (write failures don't crash)
      expect(manager.getChroniclerCount()).toBe(1);

      // Cleanup
      fs.chmodSync(logPath, 0o644);
    });
  });

  describe("Auto-Generation with Manager", () => {
    test("manager loads chroniclers with auto-generated files", async () => {
      const config: ChroniclerConfig = {
        id: "auto-chronicler",
        name: "Auto Chronicler",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Auto log",
        model: "test-model",
      };

      const manager = new ChroniclerManager({ enablePersistence: false });
      await manager.initialize();

      // No outputPaths = auto-generation
      await manager.loadChroniclersForPhase([config], PhaseId("test-phase"), {
        llmCallOverride: createMockLlmCall("Auto"),
        executionPath,
      });

      await manager.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await manager.completeAllWork();

      // Should have auto-generated file
      const autoDir = path.join(executionPath, ".tadpole", "chroniclers", "outputs", "auto-chronicler");
      expect(fs.existsSync(autoDir)).toBe(true);

      const files = fs.readdirSync(autoDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^auto-chronicler-test-phase-\d+\.md$/);

      // Verify content
      const content = fs.readFileSync(path.join(autoDir, files[0]), "utf-8");
      expect(content).toBe("\n---\nAuto\n");
    });
  });
});
