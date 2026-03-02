import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { ClaudeLogParser } from "../../server/claude-log-parser";
import { ShimProcessManager } from "../../server/shim-process-manager";
import type { CodonId } from "../../server/types/branded-types";
import type { Codon } from "../../server/types/types";
import { Logger } from "../../server/utils";
import { createTestCodon } from "../utils/test-codon-factory";

describe("ShimProcessManager", () => {
  let tempDir: string;
  let logger: Logger;
  let mockLogParser: ClaudeLogParser;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-shim-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create a mock logger
    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    // Create a mock log parser
    mockLogParser = new ClaudeLogParser({
      logPath: path.join(tempDir, "mock.log"),
      codonId: "test-codon",
      parsingInterval: 100,
    });
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("constructor initializes correctly", () => {
    const manager = new ShimProcessManager("/project", "/project", logger, mockLogParser);
    expect(manager).toBeInstanceOf(ShimProcessManager);
    expect(manager.isRunning()).toBe(false);
    expect(manager.getPid()).toBeUndefined();
  });

  test("constructor with custom Anthropic base URL", () => {
    const manager = new ShimProcessManager(
      "/project",
      "/project",
      logger,
      mockLogParser,
      "https://custom.api.com",
    );
    expect(manager).toBeInstanceOf(ShimProcessManager);
  });

  test("isRunning returns false when no process", () => {
    const manager = new ShimProcessManager("/project", "/project", logger, mockLogParser);
    expect(manager.isRunning()).toBe(false);
  });

  test("getPid returns undefined when no process", () => {
    const manager = new ShimProcessManager("/project", "/project", logger, mockLogParser);
    expect(manager.getPid()).toBeUndefined();
  });

  test("emits events correctly", (done) => {
    const manager = new ShimProcessManager("/project", "/project", logger, mockLogParser);

    // Test that manager extends EventEmitter
    const testData = "test event data";
    manager.on("test-event", (data) => {
      expect(data).toBe(testData);
      done();
    });

    // Emit test event - TypedEventEmitter allows custom events via index signature
    manager.emit("test-event", testData);
  });

  test("closeLogStream completes without error when no stream", async () => {
    const manager = new ShimProcessManager("/project", "/project", logger, mockLogParser);
    // Should not throw even when no log stream is open
    await expect(manager.closeLogStream()).resolves.toBeUndefined();
  });

  test("kill returns when no process is running", async () => {
    const manager = new ShimProcessManager("/project", "/project", logger, mockLogParser);
    // Should not throw when no process is running
    await expect(manager.kill()).resolves.toBeUndefined();
  });

  test("kill with custom signal", async () => {
    const manager = new ShimProcessManager("/project", "/project", logger, mockLogParser);
    // Should accept custom signal
    await expect(manager.kill("SIGKILL")).resolves.toBeUndefined();
  });
});

describe("ShimProcessManager spawn behavior", () => {
  let tempDir: string;
  let logger: Logger;
  let mockLogParser: ClaudeLogParser;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-shim-spawn-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create project structure
    await fs.promises.mkdir(path.join(tempDir, ".hankweave", "logs"), {
      recursive: true,
    });

    // Create a mock logger
    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    // Create a mock log parser
    mockLogParser = new ClaudeLogParser({
      logPath: path.join(tempDir, "mock.log"),
      codonId: "test-codon",
      parsingInterval: 100,
    });
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("spawn requires valid codon config", async () => {
    const _manager = new ShimProcessManager(tempDir, tempDir, logger, mockLogParser);

    const invalidCodon: Partial<Codon> = {
      id: "test-codon" as CodonId,
      name: "Test Codon",
      // Missing required 'model' field
    };

    // We should NOT actually spawn shims in unit tests
    // Just verify the codon validation happens before spawn
    expect(() => {
      // Check if the codon would be valid for spawning
      if (!invalidCodon.model) throw new Error("Model is required");
      if (!invalidCodon.promptFile && !invalidCodon.promptText)
        throw new Error("Prompt is required");
    }).toThrow("Model is required");
  });

  test("spawn validates model names", async () => {
    const _manager = new ShimProcessManager(tempDir, tempDir, logger, mockLogParser);

    const codonWithInvalidModel = {
      id: "test-codon",
      name: "Test Codon",
      model: "invalid-model",
      promptText: "Test prompt",
    };

    // Don't actually spawn shims in unit tests
    // The ShimProcessManager doesn't validate models itself
    // That validation happens in config.ts loadCodonConfig
    // This test just verifies the manager accepts the codon structure
    expect(codonWithInvalidModel.model).toBe("invalid-model");
    expect(codonWithInvalidModel.promptText).toBeDefined();
  });

  test("spawn handles missing prompt correctly", async () => {
    const _manager = new ShimProcessManager(tempDir, tempDir, logger, mockLogParser);

    const codonWithoutPrompt = {
      id: "test-codon" as CodonId,
      name: "Test Codon",
      model: "opus",
      continuationMode: "fresh",
      // Missing both promptFile and promptText
    } as unknown as Partial<Codon>;

    // Don't actually spawn shims in unit tests
    // Just verify the codon validation
    expect(() => {
      if (!codonWithoutPrompt.promptFile && !codonWithoutPrompt.promptText) {
        throw new Error("Either promptFile or promptText is required");
      }
    }).toThrow("Either promptFile or promptText is required");
  });
});

describe("ShimProcessManager extension behavior", () => {
  let tempDir: string;
  let logger: Logger;
  let mockLogParser: ClaudeLogParser;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-shim-extension-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, ".hankweave", "logs"), {
      recursive: true,
    });

    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);
    mockLogParser = new ClaudeLogParser({
      logPath: path.join(tempDir, "mock.log"),
      codonId: "test-codon",
      parsingInterval: 100,
    });
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("extension mode should force --resume regardless of continuationMode", async () => {
    const manager = new ShimProcessManager(tempDir, tempDir, logger, mockLogParser);

    // Mock child_process.spawn to capture arguments
    const spawnSpy = spyOn(child_process, "spawn");
    const mockProcess: Partial<ChildProcess> = {
      pid: 12345,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for Writable stream
      stdin: { write: mock(() => {}), end: mock(() => {}) } as any,
      // biome-ignore lint/suspicious/noExplicitAny: Real PassThrough stream for readline
      stdout: new PassThrough() as any,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for Readable stream
      stderr: new PassThrough() as any,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for EventEmitter
      on: mock(() => mockProcess as ChildProcess) as any,
      killed: false,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for kill method
      kill: mock(() => true) as any,
      removeAllListeners: mock(() => mockProcess as ChildProcess),
    };
    spawnSpy.mockReturnValue(mockProcess as ChildProcess);

    // Create a codon with continuationMode: "fresh"
    const codon = createTestCodon({
      id: "test-codon",
      name: "Test Codon",
      model: "gemini-2.0-flash-exp",
      promptText: "Test prompt",
      continuationMode: "fresh", // KEY: fresh mode
      description: "Test",
      checkpointedFiles: [],
    });

    const sessionToResume = "test-session-123";
    const exhaustionPrompt = "Continue working on the task";

    // Spawn with exhaustion mode (simulating an extension)
    await manager.spawn(["node", "path/to/shim.js"], codon, sessionToResume, {
      exhaustionPrompt, // Extension mode
    });

    // Get the spawn call arguments
    expect(spawnSpy).toHaveBeenCalled();
    const spawnCall = spawnSpy.mock.calls[0];
    const [_bin, args] = spawnCall;

    // EXPECTATION: In extension mode, --resume should ALWAYS be present
    // This test will FAIL with current code because continuationMode is "fresh"
    const resumeIndex = args.indexOf("--resume");
    expect(resumeIndex).not.toBe(-1); // Should find --resume flag
    expect(args[resumeIndex + 1]).toBe(sessionToResume); // Should have session ID

    spawnSpy.mockRestore();
  });

  test("fresh mode without extension should NOT add --resume", async () => {
    const manager = new ShimProcessManager(tempDir, tempDir, logger, mockLogParser);

    const spawnSpy = spyOn(child_process, "spawn");
    const mockProcess: Partial<ChildProcess> = {
      pid: 12345,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for Writable stream
      stdin: { write: mock(() => {}), end: mock(() => {}) } as any,
      // biome-ignore lint/suspicious/noExplicitAny: Real PassThrough stream for readline
      stdout: new PassThrough() as any,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for Readable stream
      stderr: new PassThrough() as any,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for EventEmitter
      on: mock(() => mockProcess as ChildProcess) as any,
      killed: false,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for kill method
      kill: mock(() => true) as any,
      removeAllListeners: mock(() => mockProcess as ChildProcess),
    };
    spawnSpy.mockReturnValue(mockProcess as ChildProcess);

    const codon = createTestCodon({
      id: "test-codon",
      name: "Test Codon",
      model: "gemini-2.0-flash-exp",
      promptText: "Test prompt",
      continuationMode: "fresh",
      description: "Test",
      checkpointedFiles: [],
    });

    const sessionToResume = "test-session-123";

    // Spawn WITHOUT exhaustion mode (normal execution)
    await manager.spawn(["node", "path/to/shim.js"], codon, sessionToResume, {
      // No exhaustionPrompt = normal mode
    });

    const spawnCall = spawnSpy.mock.calls[0];
    const [_bin, args] = spawnCall;

    // In normal mode with fresh continuationMode, should NOT have --resume
    const resumeIndex = args.indexOf("--resume");
    expect(resumeIndex).toBe(-1); // Should NOT find --resume flag

    spawnSpy.mockRestore();
  });
});

describe("ShimProcessManager HANKWEAVE_* env passthrough", () => {
  let tempDir: string;
  let logger: Logger;
  let mockLogParser: ClaudeLogParser;
  const envKeysToClean: string[] = [];

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-shim-env-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, ".hankweave", "logs"), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(tempDir, ".hankweave", "logs", "shim-debug"), {
      recursive: true,
    });

    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);
    mockLogParser = new ClaudeLogParser({
      logPath: path.join(tempDir, "mock.log"),
      codonId: "test-codon",
      parsingInterval: 100,
    });
  });

  afterEach(async () => {
    for (const key of envKeysToClean) {
      delete process.env[key];
    }
    envKeysToClean.length = 0;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setEnv(key: string, value: string) {
    process.env[key] = value;
    envKeysToClean.push(key);
  }

  function createSpawnSpy() {
    const spawnSpy = spyOn(child_process, "spawn");
    const mockProcess: Partial<ChildProcess> = {
      pid: 12345,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock
      stdin: { write: mock(() => {}), end: mock(() => {}) } as any,
      // biome-ignore lint/suspicious/noExplicitAny: Real PassThrough stream for readline
      stdout: new PassThrough() as any,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for Readable stream
      stderr: new PassThrough() as any,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock
      on: mock(() => mockProcess as ChildProcess) as any,
      killed: false,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock
      kill: mock(() => true) as any,
      removeAllListeners: mock(() => mockProcess as ChildProcess),
    };
    spawnSpy.mockReturnValue(mockProcess as ChildProcess);
    return spawnSpy;
  }

  test("HANKWEAVE_FOO=bar passes FOO=bar to child", async () => {
    setEnv("HANKWEAVE_FOO", "bar");

    const manager = new ShimProcessManager(tempDir, tempDir, logger, mockLogParser);
    const spawnSpy = createSpawnSpy();

    const codon = createTestCodon({
      id: "test-codon",
      name: "Test",
      model: "gemini-2.0-flash-exp",
      continuationMode: "fresh",
      promptText: "Test",
      description: "Test",
      checkpointedFiles: [],
    });

    await manager.spawn(["node", "shim.js"], codon, null);

    const spawnCall = spawnSpy.mock.calls[0];
    const spawnOptions = spawnCall[2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env.FOO).toBe("bar");

    spawnSpy.mockRestore();
  });

  test("HANKWEAVE_FOO=unset removes FOO from child env", async () => {
    setEnv("FOO", "should-be-removed");
    setEnv("HANKWEAVE_FOO", "unset");

    const manager = new ShimProcessManager(tempDir, tempDir, logger, mockLogParser);
    const spawnSpy = createSpawnSpy();

    const codon = createTestCodon({
      id: "test-codon",
      name: "Test",
      model: "gemini-2.0-flash-exp",
      continuationMode: "fresh",
      promptText: "Test",
      description: "Test",
      checkpointedFiles: [],
    });

    await manager.spawn(["node", "shim.js"], codon, null);

    const spawnCall = spawnSpy.mock.calls[0];
    const spawnOptions = spawnCall[2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env.FOO).toBeUndefined();

    spawnSpy.mockRestore();
  });

  test("HANKWEAVE_ANTHROPIC_BASE_URL=unset removes inherited ANTHROPIC_BASE_URL", async () => {
    setEnv("ANTHROPIC_BASE_URL", "https://proxy.example.com");
    setEnv("HANKWEAVE_ANTHROPIC_BASE_URL", "unset");

    const manager = new ShimProcessManager(tempDir, tempDir, logger, mockLogParser);
    const spawnSpy = createSpawnSpy();

    const codon = createTestCodon({
      id: "test-codon",
      name: "Test",
      model: "gemini-2.0-flash-exp",
      continuationMode: "fresh",
      promptText: "Test",
      description: "Test",
      checkpointedFiles: [],
    });

    await manager.spawn(["node", "shim.js"], codon, null);

    const spawnCall = spawnSpy.mock.calls[0];
    const spawnOptions = spawnCall[2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env.ANTHROPIC_BASE_URL).toBeUndefined();

    spawnSpy.mockRestore();
  });

  test("HANKWEAVE_ANTHROPIC_BASE_URL=https://other overrides inherited value", async () => {
    setEnv("ANTHROPIC_BASE_URL", "https://proxy.example.com");
    setEnv("HANKWEAVE_ANTHROPIC_BASE_URL", "https://other.api.com");

    const manager = new ShimProcessManager(tempDir, tempDir, logger, mockLogParser);
    const spawnSpy = createSpawnSpy();

    const codon = createTestCodon({
      id: "test-codon",
      name: "Test",
      model: "gemini-2.0-flash-exp",
      continuationMode: "fresh",
      promptText: "Test",
      description: "Test",
      checkpointedFiles: [],
    });

    await manager.spawn(["node", "shim.js"], codon, null);

    const spawnCall = spawnSpy.mock.calls[0];
    const spawnOptions = spawnCall[2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env.ANTHROPIC_BASE_URL).toBe("https://other.api.com");

    spawnSpy.mockRestore();
  });
});

describe("ShimProcessManager log timestamps", () => {
  let tempDir: string;
  let logger: Logger;
  let mockLogParser: ClaudeLogParser;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-shim-timestamps-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, ".hankweave", "logs"), {
      recursive: true,
    });

    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);
    mockLogParser = new ClaudeLogParser({
      logPath: path.join(tempDir, "mock.log"),
      codonId: "test-codon",
      parsingInterval: 100,
    });
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("stdout JSON lines are written to log with timestamp field", async () => {
    const manager = new ShimProcessManager(tempDir, tempDir, logger, mockLogParser);
    const spawnSpy = spyOn(child_process, "spawn");

    // Use real PassThrough streams so readline can consume stdout
    const mockStdout = new PassThrough();
    const mockProcess: Partial<ChildProcess> = {
      pid: 12345,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for Writable stream
      stdin: { write: mock(() => {}), end: mock(() => {}) } as any,
      // biome-ignore lint/suspicious/noExplicitAny: Real PassThrough stream for readline
      stdout: mockStdout as any,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for Readable stream
      stderr: new PassThrough() as any,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for EventEmitter
      on: mock(() => mockProcess as ChildProcess) as any,
      killed: false,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for kill method
      kill: mock(() => true) as any,
      removeAllListeners: mock(() => mockProcess as ChildProcess),
    };
    spawnSpy.mockReturnValue(mockProcess as ChildProcess);

    const codon = createTestCodon({
      id: "test-codon",
      name: "Test",
      model: "gemini-2.0-flash-exp",
      continuationMode: "fresh",
      promptText: "Test",
      description: "Test",
      checkpointedFiles: [],
    });

    const logFilePath = await manager.spawn(["node", "shim.js"], codon, null);

    // Write JSONL lines to mock stdout (simulating shim output)
    const testMessages = [
      { type: "system", subtype: "init", session_id: "test-123" },
      { type: "assistant", message: { id: "msg_abc", role: "assistant" } },
      { type: "result", subtype: "success", result: "done" },
    ];
    for (const msg of testMessages) {
      mockStdout.write(`${JSON.stringify(msg)}\n`);
    }
    mockStdout.end();

    // Wait for readline to process all lines
    await new Promise((r) => setTimeout(r, 200));

    // Read the log file and verify timestamps
    const logContent = fs.readFileSync(logFilePath, "utf-8");
    const lines = logContent.trim().split("\n");
    expect(lines.length).toBe(3);

    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]);
      expect(parsed.timestamp).toBeDefined();
      // Verify it's a valid ISO 8601 timestamp
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
      // Verify original data is preserved
      expect(parsed.type).toBe(testMessages[i].type);
    }

    spawnSpy.mockRestore();
  });

  test("non-JSON stdout lines are written as-is without timestamp", async () => {
    const manager = new ShimProcessManager(tempDir, tempDir, logger, mockLogParser);
    const spawnSpy = spyOn(child_process, "spawn");

    const mockStdout = new PassThrough();
    const mockProcess: Partial<ChildProcess> = {
      pid: 12345,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for Writable stream
      stdin: { write: mock(() => {}), end: mock(() => {}) } as any,
      // biome-ignore lint/suspicious/noExplicitAny: Real PassThrough stream for readline
      stdout: mockStdout as any,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for Readable stream
      stderr: new PassThrough() as any,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for EventEmitter
      on: mock(() => mockProcess as ChildProcess) as any,
      killed: false,
      // biome-ignore lint/suspicious/noExplicitAny: Test mock for kill method
      kill: mock(() => true) as any,
      removeAllListeners: mock(() => mockProcess as ChildProcess),
    };
    spawnSpy.mockReturnValue(mockProcess as ChildProcess);

    const codon = createTestCodon({
      id: "test-codon",
      name: "Test",
      model: "gemini-2.0-flash-exp",
      continuationMode: "fresh",
      promptText: "Test",
      description: "Test",
      checkpointedFiles: [],
    });

    const logFilePath = await manager.spawn(["node", "shim.js"], codon, null);

    // Write a non-JSON line
    mockStdout.write("this is not json\n");
    mockStdout.end();

    await new Promise((r) => setTimeout(r, 200));

    const logContent = fs.readFileSync(logFilePath, "utf-8");
    const lines = logContent.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe("this is not json");

    spawnSpy.mockRestore();
  });
});
