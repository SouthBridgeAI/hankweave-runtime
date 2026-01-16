import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ClaudeLogParser } from "../../server/claude-log-parser.js";
import { ShimProcessManager } from "../../server/shim-process-manager.js";
import type { Codon } from "../../server/types/types.js";
import { Logger } from "../../server/utils.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

/**
 * Helper function to run a complete session: creates manager, spawns process,
 * waits for completion, extracts session ID, and cleans up.
 */
async function runSessionToCompletion(
  tempDir: string,
  executionPath: string,
  logger: Logger,
  geminiShimPath: string,
  codon: Codon,
  previousSessionId: string | null,
  timeoutMs: number = 60000
): Promise<{
  sessionId: string;
  logPath: string;
  allMessages: any[];
}> {
  console.log(`\n  Setting up session for codon: ${codon.id}...`);

  // Create log path - use the same path for both parser and spawn
  const sessionLogPath = path.join(tempDir, `session-${codon.id}.jsonl`);

  // Create log parser
  const logParser = new ClaudeLogParser({
    logPath: sessionLogPath,
    codonId: codon.id,
    parsingInterval: 100,
  });

  // Create manager
  const manager = new ShimProcessManager(executionPath, logger, logParser);

  console.log(`  Spawning gemini shim for ${codon.id}...`);

  // Spawn process - pass the same logPath so parser and manager use the same file
  const command = ["bun", "run", geminiShimPath];
  const actualLogPath = await manager.spawn(
    command,
    codon,
    previousSessionId,
    sessionLogPath
  );
  console.log(`    ✓ Spawned gemini shim, log: ${actualLogPath}`);

  console.log(`  Waiting for completion...`);

  // Wait for completion
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

  // Extract session ID from log
  console.log(`  Extracting session ID from log...`);
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

  // Get all messages before stopping parser
  const allMessages = logParser.getAllMessages();
  console.log(`    ✓ Log parser found ${allMessages.length} messages`);

  // Stop parser
  logParser.stop();

  return {
    sessionId,
    logPath: actualLogPath,
    allMessages,
  };
}

describe("Gemini Shim Integration Test", () => {
  let tempDir: string;
  let executionPath: string;
  let logPath: string;
  let logger: Logger;
  let geminiShimPath: string;

  beforeAll(async () => {
    // Create temp directory for test
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-gemini-integration-${Date.now()}`
    );
    executionPath = path.join(tempDir, "execution");
    await fs.promises.mkdir(executionPath, { recursive: true });

    // Create log file for logger
    logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    // Get absolute path to gemini shim
    geminiShimPath = path.resolve("shims/gemini/index.js");

    console.log(`\n🧪 Integration test directory: ${tempDir}`);
    console.log(`📦 Gemini shim path: ${geminiShimPath}`);

    // Verify gemini shim exists
    if (!fs.existsSync(geminiShimPath)) {
      throw new Error(`Gemini shim not found at ${geminiShimPath}`);
    }
  });

  afterAll(async () => {
    // Cleanup
    // await fs.promises.rm(tempDir, { recursive: true, force: true });
    console.log(`\n🧹 Cleaned up test directory: ${tempDir}`);
  });

  test("can spawn gemini shim and get response", async () => {
    console.log("\n📝 Test: Can spawn gemini shim and get response");

    // Check if GOOGLE_API_KEY or GEMINI_API_KEY is set
    if (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY) {
      console.log(
        "⏭️  Skipping test: No GOOGLE_API_KEY or GEMINI_API_KEY found"
      );
      return;
    }

    const codon = createTestCodon({
      id: "gemini-test-codon",
      name: "Gemini Test Session",
      promptText: "Say 'Hello from Gemini' and nothing else.",
      model: "gemini-2.5-flash",
      continuationMode: "fresh",
    });

    const { logPath: actualLogPath, allMessages } =
      await runSessionToCompletion(
        tempDir,
        executionPath,
        logger,
        geminiShimPath,
        codon,
        null
      );

    console.log("\n  Verifying log file exists and has content...");

    // Verify log file was created and has content
    expect(fs.existsSync(actualLogPath)).toBe(true);
    const logContent = await fs.promises.readFile(actualLogPath, "utf-8");
    expect(logContent.length).toBeGreaterThan(0);
    console.log(`    ✓ Log file size: ${logContent.length} bytes`);

    // Parse log to verify it has the expected JSONL format
    const lines = logContent.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    console.log(`    ✓ Log has ${lines.length} lines`);

    console.log("\n  Verifying ClaudeLogParser parsed messages...");

    // Verify we have messages
    expect(allMessages.length).toBeGreaterThan(0);

    // Check for system message
    const systemMessages = allMessages.filter((msg) => msg.type === "system");
    expect(systemMessages.length).toBeGreaterThan(0);
    console.log(`    ✓ Found ${systemMessages.length} system message(s)`);
    if (systemMessages[0]) {
      console.log(
        `      - Session ID: ${systemMessages[0].session_id || "N/A"}`
      );
      console.log(`      - Model: ${systemMessages[0].model || "N/A"}`);
    }

    // Check for assistant messages
    const assistantMessages = allMessages.filter(
      (msg) => msg.type === "assistant"
    );
    expect(assistantMessages.length).toBeGreaterThan(0);
    console.log(`    ✓ Found ${assistantMessages.length} assistant message(s)`);
    if (assistantMessages[0]) {
      const content = assistantMessages[0].message?.content;
      if (Array.isArray(content)) {
        const textContent = content.find((c: any) => c.type === "text");
        if (textContent && "text" in textContent) {
          const text = textContent.text || "";
          console.log(
            `      - Response: "${text.substring(0, 50)}${
              text.length > 50 ? "..." : ""
            }"`
          );
        }
      }
    }

    // Check for result message
    const resultMessages = allMessages.filter((msg) => msg.type === "result");
    expect(resultMessages.length).toBeGreaterThan(0);
    console.log(`    ✓ Found ${resultMessages.length} result message(s)`);
    if (resultMessages[0]) {
      console.log(`      - Result: ${resultMessages[0].result || "N/A"}`);
      console.log(`      - Is error: ${resultMessages[0].is_error || false}`);
      if (resultMessages[0].usage) {
        console.log(
          `      - Token usage: ${
            resultMessages[0].usage.input_tokens || 0
          } in / ${resultMessages[0].usage.output_tokens || 0} out`
        );
      }
    }

    console.log("\n✅ Test passed: Can spawn gemini shim and get response\n");
  }, 120000); // 2 minute timeout for the whole test

  test("gemini shim with continuation mode", async () => {
    console.log("\n📝 Test: Gemini shim with continuation mode");

    // Check if GOOGLE_API_KEY or GEMINI_API_KEY is set
    if (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY) {
      console.log(
        "⏭️  Skipping test: No GOOGLE_API_KEY or GEMINI_API_KEY found"
      );
      return;
    }

    // =====================================
    // Step 1: Run first session
    // =====================================
    console.log("\n  Step 1: Running first session...");

    const codon1 = createTestCodon({
      id: "gemini-test-codon-1",
      name: "First Gemini Session",
      promptText:
        "Remember the number 42. Say 'Number saved' and nothing else.",
      model: "gemini-2.5-flash",
      continuationMode: "fresh",
    });

    const { sessionId: firstSessionId } = await runSessionToCompletion(
      tempDir,
      executionPath,
      logger,
      geminiShimPath,
      codon1,
      null
    );

    console.log(`    ✓ First session ID: ${firstSessionId}`);

    // =====================================
    // Step 2: Run continuation session
    // =====================================
    console.log("\n  Step 2: Running continuation session...");

    const codon2 = createTestCodon({
      id: "gemini-test-codon-2",
      name: "Continuation Gemini Session",
      promptText:
        "What number did I tell you to remember? Reply with just the number.",
      model: "gemini-2.5-flash",
      continuationMode: "continue-previous",
    });

    const { sessionId: continuationSessionId } = await runSessionToCompletion(
      tempDir,
      executionPath,
      logger,
      geminiShimPath,
      codon2,
      firstSessionId
    );

    console.log(`    ✓ Continuation session ID: ${continuationSessionId}`);

    // =====================================
    // Step 3: Verify session IDs match
    // =====================================
    console.log("\n  Step 3: Verifying session IDs...");
    expect(continuationSessionId).toBe(firstSessionId);
    console.log("    ✓ Session IDs match!");
    console.log(`      First:        ${firstSessionId}`);
    console.log(`      Continuation: ${continuationSessionId}`);

    console.log("\n✅ Test passed: Gemini shim with continuation mode\n");
  }, 180000); // 3 minute timeout for the whole test

  test("shim self-test via ShimProcessManager", async () => {
    console.log("\n📝 Test: Shim self-test via ShimProcessManager");

    // Create log path for logger
    const logPath = path.join(tempDir, "self-test-log.jsonl");

    // Create log parser (required by ShimProcessManager constructor)
    const logParser = new ClaudeLogParser({
      logPath,
      codonId: "self-test-codon",
      parsingInterval: 100,
    });

    // Create manager
    const manager = new ShimProcessManager(executionPath, logger, logParser);

    console.log("\n  Running self-test...");

    // Run self-test
    const command = ["bun", "run", geminiShimPath];
    const result = await manager.runSelfTest(command);

    console.log(`    ✓ Self-test completed`);
    console.log(
      `      Overall: ${result.overall.passed ? "PASSED" : "FAILED"}`
    );
    console.log(`      Message: ${result.overall.message}`);

    // Verify result structure
    console.log("\n  Verifying result structure...");
    expect(result).toBeDefined();
    expect(result.shim).toBeDefined();
    expect(result.shim.name).toBe("gemini-cli-shim");
    expect(typeof result.shim.version).toBe("string");
    console.log(`    ✓ Shim: ${result.shim.name} v${result.shim.version}`);

    expect(result.agent).toBeDefined();
    expect(result.agent.name).toBe("gemini-cli");
    expect(typeof result.agent.found).toBe("boolean");
    console.log(
      `    ✓ Agent: ${result.agent.name} (found: ${result.agent.found})`
    );

    expect(result.checks).toBeDefined();
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
    console.log(`    ✓ Checks: ${result.checks.length} checks performed`);

    // Verify each check has required fields
    for (const check of result.checks) {
      expect(check.name).toBeDefined();
      expect(typeof check.passed).toBe("boolean");
      expect(check.message).toBeDefined();
      console.log(
        `      - ${check.name}: ${check.passed ? "✓" : "✗"} ${check.message}`
      );
    }

    expect(result.overall).toBeDefined();
    expect(typeof result.overall.passed).toBe("boolean");
    expect(result.overall.message).toBeDefined();
    console.log(`    ✓ Overall result is well-formed`);

    // Clean up
    logParser.stop();

    console.log("\n✅ Test passed: Shim self-test via ShimProcessManager\n");
  }, 30000); // 30 second timeout
});
