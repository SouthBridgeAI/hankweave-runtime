import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ClaudeLogParser } from "../../server/claude-log-parser.js";
import { ShimProcessManager } from "../../server/shim-process-manager.js";
import { Logger } from "../../server/utils.js";
import { runSessionToCompletion } from "../utils/shim-session-helpers.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

/**
 * The pi shim embeds the SDK directly — no `pi` binary needed on PATH.
 * We only need an API key (ANTHROPIC_API_KEY for default Anthropic models).
 */
function hasApiKey(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY);
}

describe("Pi Shim Integration Test", () => {
  let tempDir: string;
  let executionPath: string;
  let logPath: string;
  let logger: Logger;
  let piShimPath: string;
  let apiKeyAvailable: boolean;

  beforeAll(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-pi-integration-${Date.now()}`);
    executionPath = path.join(tempDir, "execution");
    await fs.promises.mkdir(executionPath, { recursive: true });

    logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    piShimPath = path.resolve("shims/pi/index.js");

    if (!fs.existsSync(piShimPath)) {
      throw new Error(`Pi shim not found at ${piShimPath}`);
    }

    apiKeyAvailable = hasApiKey();
    console.log(`\n🧪 Pi integration test directory: ${tempDir}`);
    console.log(`📦 Pi shim path: ${piShimPath}`);
    console.log(`🔑 API key available: ${apiKeyAvailable}`);
    console.log(`ℹ️  Pi shim embeds SDK — no pi binary needed`);
  });

  afterAll(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test("can spawn pi shim and get response", async () => {
    if (!apiKeyAvailable) {
      console.log("⏭️  Skipping test: No ANTHROPIC_API_KEY found");
      return;
    }

    const codon = createTestCodon({
      id: "pi-test-codon",
      name: "Pi Test Session",
      promptText: "Say 'Hello from Pi' and nothing else.",
      model: "pi/anthropic/claude-haiku-4-5",
      continuationMode: "fresh",
    });

    const { logPath: actualLogPath, allMessages } = await runSessionToCompletion(
      tempDir,
      executionPath,
      logger,
      piShimPath,
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

    console.log("✅ Test passed: Can spawn pi shim and get response\n");
  }, 120000);

  test("pi shim with continuation mode", async () => {
    if (!apiKeyAvailable) {
      console.log("⏭️  Skipping test: No ANTHROPIC_API_KEY found");
      return;
    }

    // Step 1: Run first session
    const codon1 = createTestCodon({
      id: "pi-test-codon-1",
      name: "First Pi Session",
      promptText: "Remember the number 42. Say 'Number saved' and nothing else.",
      model: "pi/anthropic/claude-haiku-4-5",
      continuationMode: "fresh",
    });

    const { sessionId: firstSessionId } = await runSessionToCompletion(
      tempDir,
      executionPath,
      logger,
      piShimPath,
      codon1,
      null,
    );

    console.log(`    ✓ First session ID: ${firstSessionId}`);

    // Step 2: Run continuation session
    const codon2 = createTestCodon({
      id: "pi-test-codon-2",
      name: "Continuation Pi Session",
      promptText: "What number did I tell you to remember? Reply with just the number.",
      model: "pi/anthropic/claude-haiku-4-5",
      continuationMode: "continue-previous",
    });

    const { sessionId: continuationSessionId } = await runSessionToCompletion(
      tempDir,
      executionPath,
      logger,
      piShimPath,
      codon2,
      firstSessionId,
    );

    // Step 3: Verify session IDs match
    expect(continuationSessionId).toBe(firstSessionId);
    console.log("✅ Test passed: Pi shim with continuation mode\n");
  }, 180000);

  test("shim self-test via ShimProcessManager", async () => {
    const selfTestLogPath = path.join(tempDir, "self-test-log.jsonl");
    const logParser = new ClaudeLogParser({
      logPath: selfTestLogPath,
      codonId: "self-test-codon",
      parsingInterval: 100,
    });

    const manager = new ShimProcessManager(executionPath, executionPath, logger, logParser);

    // The pi shim bundle includes undici's CacheStorage, which calls
    // `webidl.util.markAsUncloneable` — not implemented in Bun 1.3.x. The
    // shim is shebanged `#!/usr/bin/env node` and the production launcher
    // (server/utils.ts `getRuntimeCommand`) special-cases it to Node, so
    // mirror that here.
    const command = ["node", piShimPath];
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
