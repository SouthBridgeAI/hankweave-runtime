import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SentinelConfig } from "../../server/config-validation/sentinel.schema.js";
import { Sentinel } from "../../server/sentinels/sentinel.js";
import { CodonId } from "../../server/types/branded-types.js";
import type {
  HankweaveGenerateTextOptions,
  HankweaveGenerateTextResult,
} from "../../server/types/llm-call-types.js";
import type { SentinelOutputPaths } from "../../server/types/sentinel-types.js";

describe("Sentinel Output Files - Unit Tests", () => {
  let testDir: string;
  let executionPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-output-test-"));
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
      _options: HankweaveGenerateTextOptions,
    ): Promise<HankweaveGenerateTextResult> => {
      return {
        text: responseText,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    };
  };

  const createBaseConfig = (overrides: Partial<SentinelConfig> = {}): SentinelConfig => ({
    id: "test-sentinel",
    name: "Test Sentinel",
    trigger: { type: "event", on: ["assistant.action"] },
    execution: { strategy: "immediate" },
    userPromptText: "Test prompt",
    model: "test-model",
    ...overrides,
  });

  describe("Path Convention", () => {
    test("filename-only resolves to .hankweave/sentinels/outputs/{id}/", () => {
      const config = createBaseConfig();
      const outputPaths: SentinelOutputPaths = {
        logFile: "output.md",
      };

      new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      const expectedPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "output.md",
      );
      expect(fs.existsSync(expectedPath)).toBe(true);
    });

    test("path-with-slash resolves to execution-dir relative", () => {
      const config = createBaseConfig();
      const outputPaths: SentinelOutputPaths = {
        logFile: "data/output.md",
      };

      new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      const expectedPath = path.join(executionPath, "data", "output.md");
      expect(fs.existsSync(expectedPath)).toBe(true);
    });

    test("creates nested directories automatically", () => {
      const config = createBaseConfig();
      const outputPaths: SentinelOutputPaths = {
        logFile: "deep/nested/path/output.md",
      };

      new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      const expectedPath = path.join(executionPath, "deep", "nested", "path", "output.md");
      expect(fs.existsSync(expectedPath)).toBe(true);
    });
  });

  describe("Auto-Generation", () => {
    test("auto-generates logFile when no outputPaths provided", () => {
      const config = createBaseConfig();

      new Sentinel(
        config,
        CodonId("test-codon"),
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
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
      );
      expect(fs.existsSync(autoDir)).toBe(true);

      const files = fs.readdirSync(autoDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^test-sentinel-test-codon-\d+\.md$/);
    });

    test("auto-generates logFile when only lastValueFile provided", () => {
      const config = createBaseConfig();
      const outputPaths: SentinelOutputPaths = {
        lastValueFile: "current.md",
      };

      new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      const autoDir = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
      );
      expect(fs.existsSync(autoDir)).toBe(true);

      const files = fs.readdirSync(autoDir);
      // Should have auto-generated log + lastValueFile
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(files.some((f) => f.match(/^test-sentinel-test-codon-\d+\.md$/))).toBe(true);
    });

    test("uses .md extension for text sentinels", () => {
      const config = createBaseConfig();

      new Sentinel(
        config,
        CodonId("test-codon"),
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
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
      );
      const files = fs.readdirSync(autoDir);
      expect(files[0]).toEndWith(".md");
    });

    test("uses .ndjson extension for structured sentinels", () => {
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

      new Sentinel(
        config,
        CodonId("test-codon"),
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
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
      );
      const files = fs.readdirSync(autoDir);
      expect(files[0]).toEndWith(".ndjson");
    });
  });

  describe("Escape Sequence Processing", () => {
    test("processes \\n to newline", async () => {
      const config = createBaseConfig({ joinString: "\\n" });
      const outputPaths: SentinelOutputPaths = {
        logFile: "output.md",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("First"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      // Trigger sentinel
      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("\nFirst\n");
    });

    test("processes \\t to tab", async () => {
      const config = createBaseConfig({ joinString: "\\t" });
      const outputPaths: SentinelOutputPaths = {
        logFile: "output.md",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("First"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("\tFirst\n");
    });

    test("processes multiple escape sequences", async () => {
      const config = createBaseConfig({ joinString: "\\n---\\n" });
      const outputPaths: SentinelOutputPaths = {
        logFile: "output.md",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("First"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("\n---\nFirst\n");
    });

    test("processes \\\\ to literal backslash", async () => {
      const config = createBaseConfig({ joinString: "\\\\" });
      const outputPaths: SentinelOutputPaths = {
        logFile: "output.md",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("First"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("\\First\n");
    });
  });

  describe("File Writing", () => {
    test("appends to logFile with joinString", async () => {
      const config = createBaseConfig({ joinString: "\\n---\\n" });
      const outputPaths: SentinelOutputPaths = {
        logFile: "output.md",
      };

      let callCount = 0;
      const mockLlm = createMockLlmCall();
      const wrappedMock = async (id: string, options: HankweaveGenerateTextOptions) => {
        callCount++;
        return {
          ...(await mockLlm(id, options)),
          text: `Response ${callCount}`,
        };
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        wrappedMock,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      // Trigger multiple times
      for (let i = 0; i < 3; i++) {
        await sentinel.handleEvent({
          id: `evt-${i}`,
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: { codonId: "test", action: "message", content: "test" },
        });
      }

      await sentinel.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");

      // Should have all three responses with joinString between them
      expect(content).toBe("\n---\nResponse 1\n\n---\nResponse 2\n\n---\nResponse 3\n");
    });

    test("replaces lastValueFile atomically", async () => {
      const config = createBaseConfig();
      const outputPaths: SentinelOutputPaths = {
        logFile: "log.md",
        lastValueFile: "current.md",
      };

      let callCount = 0;
      const mockLlm = createMockLlmCall();
      const wrappedMock = async (id: string, options: HankweaveGenerateTextOptions) => {
        callCount++;
        return {
          ...(await mockLlm(id, options)),
          text: `Response ${callCount}`,
        };
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        wrappedMock,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      // Trigger multiple times
      for (let i = 0; i < 3; i++) {
        await sentinel.handleEvent({
          id: `evt-${i}`,
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: { codonId: "test", action: "message", content: "test" },
        });
      }

      await sentinel.completeAllWork();

      const currentPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "current.md",
      );
      const content = fs.readFileSync(currentPath, "utf-8");

      // Should only have the LAST response
      expect(content).toBe("Response 3");
    });

    test("handles missing lastValueFile gracefully", async () => {
      const config = createBaseConfig();
      const outputPaths: SentinelOutputPaths = {
        logFile: "output.md",
        // lastValueFile intentionally omitted
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("Test"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      // Should only create logFile
      const logPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "output.md",
      );
      expect(fs.existsSync(logPath)).toBe(true);

      // No lastValueFile should exist
      const currentPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "current.md",
      );
      expect(fs.existsSync(currentPath)).toBe(false);
    });

    test("uses default joinString when not specified", async () => {
      const config = createBaseConfig(); // No joinString specified
      const outputPaths: SentinelOutputPaths = {
        logFile: "output.md",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("Test"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
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
      const outputPaths: SentinelOutputPaths = {
        logFile: "output.md",
      };

      const logPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "output.md",
      );

      // Create file with existing content
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, "Existing content\n");

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("New content"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("Existing content\n\n---\nNew content\n");
    });

    test("replaces existing lastValueFile", async () => {
      const config = createBaseConfig();
      const outputPaths: SentinelOutputPaths = {
        logFile: "log.md",
        lastValueFile: "current.md",
      };

      const currentPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "current.md",
      );

      // Create file with existing content
      fs.mkdirSync(path.dirname(currentPath), { recursive: true });
      fs.writeFileSync(currentPath, "Old value");

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("New value"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined, // agentRootPath
        outputPaths,
      );

      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      const content = fs.readFileSync(currentPath, "utf-8");
      expect(content).toBe("New value");
    });
  });

  describe("No Execution Path (Test Mode)", () => {
    test("gracefully handles missing executionPath", () => {
      const config = createBaseConfig();

      // Should not throw
      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
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

      expect(sentinel).toBeDefined();
    });

    test("writeOutputFiles is no-op when no executionPath", async () => {
      const config = createBaseConfig();

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
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
      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      // No files should be created
      expect(fs.existsSync(path.join(executionPath, ".hankweave"))).toBe(false);
    });
  });

  describe("config.output.file as sentinel-level default", () => {
    test("uses output.file when no outputPaths provided", () => {
      const config = createBaseConfig({
        output: { file: "my-output.md" },
      });

      new Sentinel(
        config,
        CodonId("test-codon"),
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

      const expectedPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "my-output.md",
      );
      expect(fs.existsSync(expectedPath)).toBe(true);
    });

    test("output.file with slash resolves to agentRoot", () => {
      const agentRootPath = path.join(testDir, "agent-root");
      fs.mkdirSync(agentRootPath, { recursive: true });

      const config = createBaseConfig({
        output: { file: "./sentinel-notes/out.md" },
      });

      new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        agentRootPath,
      );

      const expectedPath = path.join(agentRootPath, "sentinel-notes", "out.md");
      expect(fs.existsSync(expectedPath)).toBe(true);
    });

    test("settings.outputPaths.logFile overrides output.file", () => {
      const config = createBaseConfig({
        output: { file: "sentinel-default.md" },
      });
      const outputPaths: SentinelOutputPaths = {
        logFile: "override.md",
      };

      new Sentinel(
        config,
        CodonId("test-codon"),
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
        outputPaths,
      );

      const overridePath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "override.md",
      );
      const defaultPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "sentinel-default.md",
      );
      expect(fs.existsSync(overridePath)).toBe(true);
      expect(fs.existsSync(defaultPath)).toBe(false);
    });

    test("output.file writes content correctly", async () => {
      const config = createBaseConfig({
        output: { file: "my-log.md" },
      });

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("Hello from sentinel"),
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

      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "my-log.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toContain("Hello from sentinel");
    });
  });

  describe("output.format controls auto-generated extension", () => {
    test("format jsonl produces .jsonl extension", () => {
      const config = createBaseConfig({
        output: { format: "jsonl" },
      });

      new Sentinel(
        config,
        CodonId("test-codon"),
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
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
      );
      const files = fs.readdirSync(autoDir);
      expect(files.length).toBe(1);
      expect(files[0]).toEndWith(".jsonl");
    });

    test("format text produces .md extension (default)", () => {
      const config = createBaseConfig({
        output: { format: "text" },
      });

      new Sentinel(
        config,
        CodonId("test-codon"),
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
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
      );
      const files = fs.readdirSync(autoDir);
      expect(files.length).toBe(1);
      expect(files[0]).toEndWith(".md");
    });

    test("no output config produces .md extension (unchanged)", () => {
      const config = createBaseConfig();

      new Sentinel(
        config,
        CodonId("test-codon"),
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
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
      );
      const files = fs.readdirSync(autoDir);
      expect(files.length).toBe(1);
      expect(files[0]).toEndWith(".md");
    });

    test("output.file takes precedence over format for extension", () => {
      const config = createBaseConfig({
        output: { format: "jsonl", file: "my-output.md" },
      });

      new Sentinel(
        config,
        CodonId("test-codon"),
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

      const expectedPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "my-output.md",
      );
      expect(fs.existsSync(expectedPath)).toBe(true);
    });
  });

  describe("output.format controls write behavior", () => {
    test("jsonl format wraps text as JSON lines", async () => {
      const config = createBaseConfig({
        output: { format: "jsonl", file: "output.jsonl" },
      });

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("Analysis result"),
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

      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "output.jsonl",
      );
      const content = fs.readFileSync(logPath, "utf-8").trim();
      const parsed = JSON.parse(content);
      expect(parsed.text).toBe("Analysis result");
      expect(parsed.sentinelId).toBe("test-sentinel");
      expect(parsed.timestamp).toBeDefined();
    });

    test("text format uses joinString (default behavior)", async () => {
      const config = createBaseConfig({
        output: { format: "text", file: "output.md" },
        joinString: "\\n---\\n",
      });

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("Plain text"),
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

      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      const logPath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "output.md",
      );
      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("\n---\nPlain text\n");
    });

    test("jsonl format writes to lastValueFile as pretty JSON", async () => {
      const config = createBaseConfig({
        output: { format: "jsonl", file: "log.jsonl" },
      });
      const outputPaths: SentinelOutputPaths = {
        lastValueFile: "latest.json",
      };

      const sentinel = new Sentinel(
        config,
        CodonId("test-codon"),
        createMockLlmCall("Latest value"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        executionPath,
        undefined,
        outputPaths,
      );

      await sentinel.handleEvent({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        type: "assistant.action",
        data: { codonId: "test", action: "message", content: "test" },
      });

      await sentinel.completeAllWork();

      const lastValuePath = path.join(
        executionPath,
        ".hankweave",
        "sentinels",
        "outputs",
        "test-sentinel",
        "latest.json",
      );
      const content = fs.readFileSync(lastValuePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.text).toBe("Latest value");
      expect(parsed.sentinelId).toBe("test-sentinel");
      expect(content).toContain("\n"); // Pretty-printed
    });
  });
});
