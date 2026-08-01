import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ClaudeLogParser } from "../../server/claude-log-parser.js";
import { PiSdkManager } from "../../server/pi-sdk-manager.js";
import type {
  AssistantMessage,
  ResultMessage,
  SystemMessage,
  UserMessage,
} from "../../server/types/claude-session-schema.js";
import type { Codon } from "../../server/types/types.js";
import { Logger } from "../../server/utils.js";
import { createTestCodon } from "../utils/test-codon-factory.js";
import { generateTestTimestamp } from "../utils/test-helpers.js";

/**
 * The Pi coding agent runs IN-PROCESS (embedded SDK) — nothing to install.
 * We only need an API key (ANTHROPIC_API_KEY for default Anthropic models).
 */
function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

interface SessionResult {
  sessionId: string;
  logPath: string;
  allMessages: Array<SystemMessage | AssistantMessage | UserMessage | ResultMessage>;
}

/**
 * Runs an in-process Pi session to completion: creates the manager, spawns the
 * session, waits for exit, extracts the session ID, and returns parsed messages.
 */
async function runSessionToCompletion(
  tempDir: string,
  executionPath: string,
  logger: Logger,
  codon: Codon,
  previousSessionId: string | null,
  timeoutMs = 60000,
): Promise<SessionResult> {
  const sessionLogPath = path.join(tempDir, `session-${codon.id}.jsonl`);

  const logParser = new ClaudeLogParser({
    logPath: sessionLogPath,
    codonId: codon.id,
    parsingInterval: 100,
  });

  const manager = new PiSdkManager(executionPath, executionPath, logger, logParser);

  const actualLogPath = await manager.spawn(codon, previousSessionId, {
    logPath: sessionLogPath,
  });
  console.log(`    ✓ Spawned in-process Pi session, log: ${actualLogPath}`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.kill("SIGTERM").catch(console.error);
      reject(new Error(`Session ${codon.id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    manager.on("exit", (code, contextExceeded) => {
      clearTimeout(timeout);
      console.log(`    ✓ Session completed (exit code: ${code})`);
      if (contextExceeded) {
        console.log("    ⚠️  Context exceeded");
      }
      resolve();
    });

    manager.on("error", (error) => {
      clearTimeout(timeout);
      console.error(`    ✗ Session error:`, error);
      reject(error);
    });
  });

  const logContent = await fs.promises.readFile(actualLogPath, "utf-8");
  const lines = logContent.trim().split("\n");

  let sessionId: string | undefined;
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.type === "system" && entry.session_id) {
      sessionId = entry.session_id;
      break;
    }
  }

  if (!sessionId) {
    throw new Error(`No session ID found in log for ${codon.id}`);
  }
  console.log(`    ✓ Session ID: ${sessionId}`);

  const allMessages = logParser.getAllMessages();
  logParser.stop();

  return { sessionId, logPath: actualLogPath, allMessages };
}

describe("Pi SDK Manager Integration Test", () => {
  let tempDir: string;
  let executionPath: string;
  let logPath: string;
  let logger: Logger;
  let apiKeyAvailable: boolean;

  beforeAll(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-pi-integration-${generateTestTimestamp()}`);
    executionPath = path.join(tempDir, "execution");
    await fs.promises.mkdir(executionPath, { recursive: true });

    logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    apiKeyAvailable = hasApiKey();
    console.log(`\n🧪 Pi integration test directory: ${tempDir}`);
    console.log(`🔑 API key available: ${apiKeyAvailable}`);
    console.log(`ℹ️  Pi SDK runs in-process — nothing to install`);
  });

  afterAll(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test("can run in-process pi session and get response", async () => {
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

    // Check for assistant messages
    const assistantMessages = allMessages.filter((msg) => msg.type === "assistant");
    expect(assistantMessages.length).toBeGreaterThan(0);

    // Check for result message
    const resultMessages = allMessages.filter((msg) => msg.type === "result");
    expect(resultMessages.length).toBeGreaterThan(0);
    if (resultMessages[0]) {
      expect((resultMessages[0] as ResultMessage).is_error).toBe(false);
    }

    console.log("✅ Test passed: Can run in-process pi session and get response\n");
  }, 120000);

  test("in-process pi session with continuation mode", async () => {
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
      codon2,
      firstSessionId,
    );

    // Step 3: Verify session IDs match
    expect(continuationSessionId).toBe(firstSessionId);
    console.log("✅ Test passed: In-process pi session with continuation mode\n");
  }, 180000);

  test("pi self-test via PiSdkManager", async () => {
    const selfTestLogPath = path.join(tempDir, "self-test-log.jsonl");
    const logParser = new ClaudeLogParser({
      logPath: selfTestLogPath,
      codonId: "self-test-codon",
      parsingInterval: 100,
    });

    const manager = new PiSdkManager(executionPath, executionPath, logger, logParser);
    const result = await manager.runSelfTest("anthropic/claude-haiku-4-5");

    console.log(`    ✓ Self-test: ${result.overall.passed ? "PASSED" : "FAILED"}`);
    console.log(`    ✓ Message: ${result.overall.message}`);

    // Verify result structure
    expect(result).toBeDefined();
    expect(result.shim.name).toBe("pi-sdk-manager");
    expect(typeof result.shim.version).toBe("string");

    expect(result.agent).toBeDefined();
    expect(result.agent.name).toBe("pi-coding-agent");
    expect(result.agent.found).toBe(true);

    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);

    for (const check of result.checks) {
      expect(check.name).toBeDefined();
      expect(typeof check.passed).toBe("boolean");
      expect(check.message).toBeDefined();
      console.log(`      - ${check.name}: ${check.passed ? "✓" : "✗"} ${check.message}`);
    }

    expect(typeof result.overall.passed).toBe("boolean");

    logParser.stop();
    console.log("✅ Test passed: Pi self-test via PiSdkManager\n");
  }, 30000);
});
