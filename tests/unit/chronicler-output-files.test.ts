import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Chronicler } from "../../server/chroniclers/chronicler.js";
import { PhaseId } from "../../server/types/branded-types.js";
import type {
  ChroniclerConfig,
  ChroniclerOutputPaths,
} from "../../server/types/chronicler-types.js";
import type {
  TadpoleGenerateTextOptions,
  TadpoleGenerateTextResult,
} from "../../server/types/llm-call-types.js";

describe("Chronicler Output Files - Unit Tests", () => {
  let testDir: string;
  let executionPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicler-output-test-"));
    executionPath = testDir;
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  const createMockLlmCall = (responseText = "Mock response") => {
    return async (
      _id: string,
      _options: TadpoleGenerateTextOptions,
    ): Promise<TadpoleGenerateTextResult> => {
      return {
        text: responseText,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    };
  };

  const createBaseConfig = (overrides: Partial<ChroniclerConfig> = {}): ChroniclerConfig => ({
    id: "test-chronicler",
    name: "Test Chronicler",
    trigger: { type: "event", on: ["assistant.action"] },
    execution: { strategy: "immediate" },
    userPromptText: "Test prompt",
    model: "test-model",
    ...overrides,
  });

  describe("Path Convention", () => {
    test("filename-only resolves to .tadpole/chroniclers/outputs/{id}/", () => {
      const config = createBaseConfig();
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "output.md",
      };

      new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      const expectedPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "output.md",
      );
      expect(fs.existsSync(expectedPath)).toBe(true);
    });

    test("path-with-slash resolves to execution-dir relative", () => {
      const config = createBaseConfig();
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "data/output.md",
      };

      new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      const expectedPath = path.join(executionPath, "data", "output.md");
      expect(fs.existsSync(expectedPath)).toBe(true);
    });

    test("creates nested directories automatically", () => {
      const config = createBaseConfig();
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "deep/nested/path/output.md",
      };

      new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      const expectedPath = path.join(executionPath, "deep", "nested", "path", "output.md");
      expect(fs.existsSync(expectedPath)).toBe(true);
    });
  });

  describe("Auto-Generation", () => {
    test("auto-generates logFile when no outputPaths provided", () => {
      const config = createBaseConfig();

      new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // No outputPaths
      );

      const autoDir = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
      );
      expect(fs.existsSync(autoDir)).toBe(true);

      const files = fs.readdirSync(autoDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^test-chronicler-test-phase-\d+\.md$/);
    });

    test("auto-generates logFile when only lastValueFile provided", () => {
      const config = createBaseConfig();
      const outputPaths: ChroniclerOutputPaths = {
        lastValueFile: "current.md",
      };

      new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      const autoDir = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
      );
      expect(fs.existsSync(autoDir)).toBe(true);

      const files = fs.readdirSync(autoDir);
      // Should have auto-generated log + lastValueFile
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(files.some((f) => f.match(/^test-chronicler-test-phase-\d+\.md$/))).toBe(true);
    });

    test("uses .md extension for text chroniclers", () => {
      const config = createBaseConfig();

      new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined,
      );

      const autoDir = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
      );
      const files = fs.readdirSync(autoDir);
      expect(files[0]).toEndWith(".md");
    });

    test("uses .ndjson extension for structured chroniclers", () => {
      const config = createBaseConfig({
        structuredOutput: {
          output: "enum",
          enumValues: ["option1", "option2"],
        },
      });

      const mockObjectCall = async () => ({
        object: "option1",
        finishReason: "stop" as const,
        usage: { inputTokens: 5, outputTokens: 10 },
      });

      new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockObjectCall, // Need this for structured output
        executionPath,
        undefined,
      );

      const autoDir = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
      );
      const files = fs.readdirSync(autoDir);
      expect(files[0]).toEndWith(".ndjson");
    });
  });

  describe("Escape Sequence Processing", () => {
    test("processes \\n to newline", async () => {
      const config = createBaseConfig({ joinString: "\\n" });
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "output.md",
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall("First"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      // Trigger chronicler
      await chronicler.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await chronicler.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("\nFirst\n");
    });

    test("processes \\t to tab", async () => {
      const config = createBaseConfig({ joinString: "\\t" });
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "output.md",
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall("First"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      await chronicler.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await chronicler.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("\tFirst\n");
    });

    test("processes multiple escape sequences", async () => {
      const config = createBaseConfig({ joinString: "\\n---\\n" });
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "output.md",
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall("First"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      await chronicler.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await chronicler.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("\n---\nFirst\n");
    });

    test("processes \\\\ to literal backslash", async () => {
      const config = createBaseConfig({ joinString: "\\\\" });
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "output.md",
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall("First"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      await chronicler.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await chronicler.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("\\First\n");
    });
  });

  describe("File Writing", () => {
    test("appends to logFile with joinString", async () => {
      const config = createBaseConfig({ joinString: "\\n---\\n" });
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "output.md",
      };

      let callCount = 0;
      const mockLlm = createMockLlmCall();
      const wrappedMock = async (id: string, options: TadpoleGenerateTextOptions) => {
        callCount++;
        return {
          ...(await mockLlm(id, options)),
          text: `Response ${callCount}`,
        };
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        wrappedMock,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      // Trigger multiple times
      for (let i = 0; i < 3; i++) {
        await chronicler.handleEvent({
          id: `evt-${i}`,
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: { phaseId: "test", action: "message", content: "test" },
        });
      }

      await chronicler.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");

      // Should have all three responses with joinString between them
      expect(content).toBe("\n---\nResponse 1\n\n---\nResponse 2\n\n---\nResponse 3\n");
    });

    test("replaces lastValueFile atomically", async () => {
      const config = createBaseConfig();
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "log.md",
        lastValueFile: "current.md",
      };

      let callCount = 0;
      const mockLlm = createMockLlmCall();
      const wrappedMock = async (id: string, options: TadpoleGenerateTextOptions) => {
        callCount++;
        return {
          ...(await mockLlm(id, options)),
          text: `Response ${callCount}`,
        };
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        wrappedMock,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      // Trigger multiple times
      for (let i = 0; i < 3; i++) {
        await chronicler.handleEvent({
          id: `evt-${i}`,
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: { phaseId: "test", action: "message", content: "test" },
        });
      }

      await chronicler.completeAllWork();

      const currentPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "current.md",
      );
      const content = fs.readFileSync(currentPath, "utf-8");

      // Should only have the LAST response
      expect(content).toBe("Response 3");
    });

    test("handles missing lastValueFile gracefully", async () => {
      const config = createBaseConfig();
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "output.md",
        // lastValueFile intentionally omitted
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall("Test"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      await chronicler.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await chronicler.completeAllWork();

      // Should only create logFile
      const logPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "output.md",
      );
      expect(fs.existsSync(logPath)).toBe(true);

      // No lastValueFile should exist
      const currentPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "current.md",
      );
      expect(fs.existsSync(currentPath)).toBe(false);
    });

    test("uses default joinString when not specified", async () => {
      const config = createBaseConfig(); // No joinString specified
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "output.md",
      };

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall("Test"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      await chronicler.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await chronicler.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");

      // Default joinString is "\n---\n"
      expect(content).toBe("\n---\nTest\n");
    });
  });

  describe("File Reuse Behavior", () => {
    test("appends to existing logFile", async () => {
      const config = createBaseConfig();
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "output.md",
      };

      const logPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "output.md",
      );

      // Create file with existing content
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, "Existing content\n");

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall("New content"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      await chronicler.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await chronicler.completeAllWork();

      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("Existing content\n\n---\nNew content\n");
    });

    test("replaces existing lastValueFile", async () => {
      const config = createBaseConfig();
      const outputPaths: ChroniclerOutputPaths = {
        logFile: "log.md",
        lastValueFile: "current.md",
      };

      const currentPath = path.join(
        executionPath,
        ".tadpole",
        "chroniclers",
        "outputs",
        "test-chronicler",
        "current.md",
      );

      // Create file with existing content
      fs.mkdirSync(path.dirname(currentPath), { recursive: true });
      fs.writeFileSync(currentPath, "Old value");

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall("New value"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        outputPaths,
      );

      await chronicler.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await chronicler.completeAllWork();

      const content = fs.readFileSync(currentPath, "utf-8");
      expect(content).toBe("New value");
    });
  });

  describe("No Execution Path (Test Mode)", () => {
    test("gracefully handles missing executionPath", () => {
      const config = createBaseConfig();

      // Should not throw
      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined, // No executionPath
        undefined,
      );

      expect(chronicler).toBeDefined();
    });

    test("writeOutputFiles is no-op when no executionPath", async () => {
      const config = createBaseConfig();

      const chronicler = new Chronicler(
        config,
        PhaseId("test-phase"),
        createMockLlmCall("Test"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined, // No executionPath
        undefined,
      );

      // Should not throw during event handling
      await chronicler.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { phaseId: "test", action: "message", content: "test" },
      });

      await chronicler.completeAllWork();

      // No files should be created
      expect(fs.existsSync(path.join(executionPath, ".tadpole"))).toBe(false);
    });
  });
});
