import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ClaudeLogParser } from "../../server/claude-log-parser.js";
import { ShimProcessManager } from "../../server/shim-process-manager.js";
import { Logger } from "../../server/utils.js";
import { runSessionToCompletion } from "../utils/shim-session-helpers.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

/**
 * Detect if opencode is available on the system.
 * Returns the path if found, null otherwise.
 */
async function isOpenCodeAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "opencode"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

describe("OpenCode Shim Integration Test", () => {
  let tempDir: string;
  let executionPath: string;
  let logPath: string;
  let logger: Logger;
  let opencodeShimPath: string;
  let openCodeAvailable: boolean;

  beforeAll(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-opencode-integration-${Date.now()}`);
    executionPath = path.join(tempDir, "execution");
    await fs.promises.mkdir(executionPath, { recursive: true });

    logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    opencodeShimPath = path.resolve("shims/opencode/index.js");

    // Verify shim exists
    if (!fs.existsSync(opencodeShimPath)) {
      throw new Error(`OpenCode shim not found at ${opencodeShimPath}`);
    }

    openCodeAvailable = await isOpenCodeAvailable();
    console.log(`\n🧪 OpenCode integration test directory: ${tempDir}`);
    console.log(`📦 OpenCode shim path: ${opencodeShimPath}`);
    console.log(`🔍 OpenCode binary available: ${openCodeAvailable}`);
  });

  afterAll(async () => {
    // Clean up temp directory
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test("can spawn opencode shim and get response", async () => {
    if (!openCodeAvailable) {
      console.log("⏭️  Skipping test: opencode not found in PATH");
      return;
    }

    const codon = createTestCodon({
      id: "opencode-test-codon",
      name: "OpenCode Test Session",
      promptText: "Say 'Hello from OpenCode' and nothing else.",
      model: "opencode/google/gemini-2.5-flash",
      continuationMode: "fresh",
    });

    const { logPath: actualLogPath, allMessages } = await runSessionToCompletion(
      tempDir,
      executionPath,
      logger,
      opencodeShimPath,
      codon,
      null,
    );

    // Verify log file was created and has content
    expect(fs.existsSync(actualLogPath)).toBe(true);
    const logContent = await fs.promises.readFile(actualLogPath, "utf-8");
    expect(logContent.length).toBeGreaterThan(0);

    // Verify we have messages
    expect(allMessages.length).toBeGreaterThan(0);

    // Check for system message
    const systemMessages = allMessages.filter((msg) => msg.type === "system");
    expect(systemMessages.length).toBeGreaterThan(0);
    if (systemMessages[0]) {
      console.log(`    ✓ Session ID: ${systemMessages[0].session_id || "N/A"}`);
      console.log(`    ✓ Model: ${systemMessages[0].model || "N/A"}`);
    }

    // Check for assistant messages
    const assistantMessages = allMessages.filter((msg) => msg.type === "assistant");
    expect(assistantMessages.length).toBeGreaterThan(0);

    // Check for result message
    const resultMessages = allMessages.filter((msg) => msg.type === "result");
    expect(resultMessages.length).toBeGreaterThan(0);
    if (resultMessages[0]) {
      expect(resultMessages[0].is_error).toBe(false);
    }

    console.log("✅ Test passed: Can spawn opencode shim and get response\n");
  }, 120000);

  test("opencode shim with continuation mode", async () => {
    if (!openCodeAvailable) {
      console.log("⏭️  Skipping test: opencode not found in PATH");
      return;
    }

    // Step 1: Run first session
    const codon1 = createTestCodon({
      id: "opencode-test-codon-1",
      name: "First OpenCode Session",
      promptText: "Remember the number 42. Say 'Number saved' and nothing else.",
      model: "opencode/google/gemini-2.5-flash",
      continuationMode: "fresh",
    });

    const { sessionId: firstSessionId } = await runSessionToCompletion(
      tempDir,
      executionPath,
      logger,
      opencodeShimPath,
      codon1,
      null,
    );

    console.log(`    ✓ First session ID: ${firstSessionId}`);

    // Step 2: Run continuation session
    const codon2 = createTestCodon({
      id: "opencode-test-codon-2",
      name: "Continuation OpenCode Session",
      promptText: "What number did I tell you to remember? Reply with just the number.",
      model: "opencode/google/gemini-2.5-flash",
      continuationMode: "continue-previous",
    });

    const { sessionId: continuationSessionId } = await runSessionToCompletion(
      tempDir,
      executionPath,
      logger,
      opencodeShimPath,
      codon2,
      firstSessionId,
    );

    // Step 3: Verify session IDs match
    expect(continuationSessionId).toBe(firstSessionId);
    console.log("✅ Test passed: OpenCode shim with continuation mode\n");
  }, 180000);

  test("shim self-test via ShimProcessManager", async () => {
    const selfTestLogPath = path.join(tempDir, "self-test-log.jsonl");
    const logParser = new ClaudeLogParser({
      logPath: selfTestLogPath,
      codonId: "self-test-codon",
      parsingInterval: 100,
    });

    const manager = new ShimProcessManager(executionPath, executionPath, logger, logParser);

    const command = ["bun", "run", opencodeShimPath];
    const result = await manager.runSelfTest(command);

    console.log(`    ✓ Self-test: ${result.overall.passed ? "PASSED" : "FAILED"}`);
    console.log(`    ✓ Message: ${result.overall.message}`);

    // Verify result structure
    expect(result).toBeDefined();
    expect(result.shim).toBeDefined();
    expect(typeof result.shim.name).toBe("string");
    expect(typeof result.shim.version).toBe("string");

    expect(result.agent).toBeDefined();
    expect(typeof result.agent.found).toBe("boolean");

    expect(result.checks).toBeDefined();
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);

    for (const check of result.checks) {
      expect(check.name).toBeDefined();
      expect(typeof check.passed).toBe("boolean");
      expect(check.message).toBeDefined();
      console.log(`      - ${check.name}: ${check.passed ? "✓" : "✗"} ${check.message}`);
    }

    expect(result.overall).toBeDefined();
    expect(typeof result.overall.passed).toBe("boolean");

    logParser.stop();
    console.log("✅ Test passed: Shim self-test via ShimProcessManager\n");
  }, 30000);
});
