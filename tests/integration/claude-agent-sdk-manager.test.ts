import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ClaudeAgentSDKManager } from "../../server/claude-agent-sdk-manager.js";
import { ClaudeLogParser } from "../../server/claude-log-parser.js";
import { Logger } from "../../server/utils.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

describe("ClaudeAgentSDKManager Integration Test", () => {
  let tempDir: string;
  let executionPath: string;
  let logPath: string;
  let logger: Logger;

  beforeAll(async () => {
    // Create temp directory for test
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-sdk-integration-${Date.now()}`,
    );
    executionPath = path.join(tempDir, "execution");
    await fs.promises.mkdir(executionPath, { recursive: true });

    // Create log file for logger
    logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    console.log(`\n🧪 Integration test directory: ${tempDir}`);
  });

  afterAll(async () => {
    // Keep cleanup bounded so it cannot exceed Bun's default hook timeout.
    // Windows may transiently lock files after idle-timeout process termination.
    const deadlineMs = 3500;
    const start = Date.now();
    let delayMs = 100;

    while (Date.now() - start < deadlineMs) {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
        console.log(`\n🧹 Cleaned up test directory: ${tempDir}`);
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EBUSY" && code !== "EPERM") {
          console.error(
            `\n⚠️ Could not clean up test directory: ${(err as Error)?.message}`,
          );
          return;
        }

        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, 500);
      }
    }

    // Don't fail the suite on best-effort test directory cleanup.
    console.error(`\n⚠️ Could not clean up test directory before timeout: ${tempDir}`);
  });

  test("continuation session returns same session ID", async () => {
    console.log("\n📝 Test: Continuation session returns same session ID");

    // =====================================
    // Step 1: Run first session
    // =====================================
    console.log("\n  Step 1: Running first session...");

    const sessionLogPath1 = path.join(tempDir, "session1.jsonl");
    const logParser1 = new ClaudeLogParser({
      logPath: sessionLogPath1,
      codonId: "test-codon-1",
      parsingInterval: 100,
    });

    const manager1 = new ClaudeAgentSDKManager(
      executionPath,
      executionPath, // Use same path for agentRoot in tests
      logger,
      logParser1,
    );

    const codon1 = createTestCodon({
      id: "test-codon-1",
      name: "First Session",
      promptText: "Say 'Hello from first session' and nothing else.",
      model: "sonnet",
      continuationMode: "fresh",
    });

    const actualLogPath1 = await manager1.spawn(codon1, null);
    expect(actualLogPath1).toBeTruthy();
    console.log(`    ✓ Spawned first session, log: ${actualLogPath1}`);

    // Wait for completion
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("First session timed out after 60 seconds"));
      }, 60000);

      manager1.on("exit", (code, contextExceeded) => {
        clearTimeout(timeout);
        console.log(`    ✓ First session completed (exit code: ${code})`);
        if (contextExceeded) {
          console.log("    ⚠️  Context exceeded");
        }
        resolve();
      });

      manager1.on("error", (error) => {
        clearTimeout(timeout);
        console.error(`    ✗ First session error:`, error);
        reject(error);
      });
    });

    // Get session ID from first run
    const firstSessionId = manager1.getSessionId();
    expect(firstSessionId).toBeTruthy();
    console.log(`    ✓ First session ID: ${firstSessionId}`);

    // Cleanup first manager
    logParser1.stop();

    // =====================================
    // Step 2: Run continuation session
    // =====================================
    console.log("\n  Step 2: Running continuation session...");

    const sessionLogPath2 = path.join(tempDir, "session2.jsonl");
    const logParser2 = new ClaudeLogParser({
      logPath: sessionLogPath2,
      codonId: "test-codon-2",
      parsingInterval: 100,
    });

    const manager2 = new ClaudeAgentSDKManager(
      executionPath,
      executionPath, // Use same path for agentRoot in tests
      logger,
      logParser2,
    );

    const codon2 = createTestCodon({
      id: "test-codon-2",
      name: "Continuation Session",
      promptText: "Say 'Hello from continuation session' and nothing else.",
      model: "sonnet",
      continuationMode: "continue-previous",
    });

    const actualLogPath2 = await manager2.spawn(codon2, firstSessionId || null);
    expect(actualLogPath2).toBeTruthy();
    console.log(`    ✓ Spawned continuation session, log: ${actualLogPath2}`);

    // Wait for completion
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Continuation session timed out after 60 seconds"));
      }, 60000);

      manager2.on("exit", (code, contextExceeded) => {
        clearTimeout(timeout);
        console.log(
          `    ✓ Continuation session completed (exit code: ${code})`,
        );
        if (contextExceeded) {
          console.log("    ⚠️  Context exceeded");
        }
        resolve();
      });

      manager2.on("error", (error) => {
        clearTimeout(timeout);
        console.error(`    ✗ Continuation session error:`, error);
        reject(error);
      });
    });

    // Get session ID from continuation run
    const continuationSessionId = manager2.getSessionId();
    expect(continuationSessionId).toBeTruthy();
    console.log(`    ✓ Continuation session ID: ${continuationSessionId}`);

    // =====================================
    // Step 3: Verify session IDs match
    // =====================================
    console.log("\n  Step 3: Verifying session IDs...");
    expect(continuationSessionId).toBe(firstSessionId);
    console.log("    ✓ Session IDs match!");
    console.log(`      First:        ${firstSessionId}`);
    console.log(`      Continuation: ${continuationSessionId}`);

    // Cleanup second manager
    logParser2.stop();

    console.log(
      "\n✅ Test passed: Continuation session returns same session ID\n",
    );
  }, 120000); // 2 minute timeout for the whole test

  test("fresh session creates different session ID", async () => {
    console.log("\n📝 Test: Fresh session creates different session ID");

    // =====================================
    // Step 1: Run first session
    // =====================================
    console.log("\n  Step 1: Running first session...");

    const sessionLogPath1 = path.join(tempDir, "fresh-session1.jsonl");
    const logParser1 = new ClaudeLogParser({
      logPath: sessionLogPath1,
      codonId: "fresh-test-codon-1",
      parsingInterval: 100,
    });

    const manager1 = new ClaudeAgentSDKManager(
      executionPath,
      executionPath, // Use same path for agentRoot in tests
      logger,
      logParser1,
    );

    const codon1 = createTestCodon({
      id: "fresh-test-codon-1",
      name: "First Fresh Session",
      promptText: "Say 'Hello from first fresh session' and nothing else.",
      model: "sonnet",
      continuationMode: "fresh",
    });

    await manager1.spawn(codon1, null);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("First fresh session timed out after 60 seconds"));
      }, 60000);

      manager1.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      manager1.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const firstSessionId = manager1.getSessionId();
    expect(firstSessionId).toBeTruthy();
    console.log(`    ✓ First session ID: ${firstSessionId}`);

    logParser1.stop();

    // =====================================
    // Step 2: Run fresh session (not continuation)
    // =====================================
    console.log("\n  Step 2: Running fresh session...");

    const sessionLogPath2 = path.join(tempDir, "fresh-session2.jsonl");
    const logParser2 = new ClaudeLogParser({
      logPath: sessionLogPath2,
      codonId: "fresh-test-codon-2",
      parsingInterval: 100,
    });

    const manager2 = new ClaudeAgentSDKManager(
      executionPath,
      executionPath, // Use same path for agentRoot in tests
      logger,
      logParser2,
    );

    const codon2 = createTestCodon({
      id: "fresh-test-codon-2",
      name: "Second Fresh Session",
      promptText: "Say 'Hello from second fresh session' and nothing else.",
      model: "sonnet",
      continuationMode: "fresh", // Fresh mode, not continuation
    });

    // Even though we pass the previous session ID, it should be ignored
    await manager2.spawn(codon2, firstSessionId || null);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Second fresh session timed out after 60 seconds"));
      }, 60000);

      manager2.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      manager2.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const secondSessionId = manager2.getSessionId();
    expect(secondSessionId).toBeTruthy();
    console.log(`    ✓ Second session ID: ${secondSessionId}`);

    // =====================================
    // Step 3: Verify session IDs are different
    // =====================================
    console.log("\n  Step 3: Verifying session IDs are different...");
    expect(secondSessionId).not.toBe(firstSessionId);
    console.log("    ✓ Session IDs are different!");
    console.log(`      First:  ${firstSessionId}`);
    console.log(`      Second: ${secondSessionId}`);

    logParser2.stop();

    console.log(
      "\n✅ Test passed: Fresh session creates different session ID\n",
    );
  }, 120000); // 2 minute timeout for the whole test

  test("SDK self-test via ClaudeAgentSDKManager", async () => {
    console.log("\n📝 Test: SDK self-test via ClaudeAgentSDKManager");

    // Create log path for logger
    const testLogPath = path.join(tempDir, "sdk-self-test-log.jsonl");

    // Create log parser (required by ClaudeAgentSDKManager constructor)
    const logParser = new ClaudeLogParser({
      logPath: testLogPath,
      codonId: "sdk-self-test-codon",
      parsingInterval: 100,
    });

    // Create Claude Agent SDK Manager
    const manager = new ClaudeAgentSDKManager(
      executionPath,
      executionPath,
      logger,
      logParser,
    );

    console.log("\n  Running self-test...");

    // Run self-test
    const result = await manager.runSelfTest();

    console.log(`    ✓ Self-test completed`);
    console.log(
      `      Overall: ${result.overall.passed ? "PASSED" : "FAILED"}`,
    );
    console.log(`      Message: ${result.overall.message}`);

    // Verify result structure
    console.log("\n  Verifying result structure...");
    expect(result).toBeDefined();
    expect(result.shim).toBeDefined();
    expect(result.shim.name).toBe("claude-agent-sdk-manager");
    expect(typeof result.shim.version).toBe("string");
    console.log(`    ✓ Shim: ${result.shim.name} v${result.shim.version}`);

    expect(result.agent).toBeDefined();
    expect(result.agent.name).toBe("claude-agent-sdk");
    expect(typeof result.agent.found).toBe("boolean");
    console.log(
      `    ✓ Agent: ${result.agent.name} (found: ${result.agent.found})`,
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
        `      - ${check.name}: ${check.passed ? "✓" : "✗"} ${check.message}`,
      );
    }

    expect(result.overall).toBeDefined();
    expect(typeof result.overall.passed).toBe("boolean");
    expect(result.overall.message).toBeDefined();
    console.log(`    ✓ Overall result is well-formed`);

    // Verify expected checks exist
    const checkNames = result.checks.map((c) => c.name);
    expect(checkNames).toContain("sdk_installed");
    expect(checkNames).toContain("claude_cli_executable");
    expect(checkNames).toContain("authentication");
    console.log(`    ✓ Expected checks are present`);

    // Clean up
    logParser.stop();

    console.log("\n✅ Test passed: SDK self-test via ClaudeAgentSDKManager\n");
  }, 30000); // 30 second timeout

  test("idle timeout emits exit with code 1", async () => {
    const sessionLogPath = path.join(tempDir, "timeout-session.jsonl");
    const logParser = new ClaudeLogParser({
      logPath: sessionLogPath,
      codonId: "timeout-test-codon",
      parsingInterval: 100,
    });

    // Create manager with a very short idle timeout (1 second)
    const manager = new ClaudeAgentSDKManager(
      executionPath,
      executionPath,
      logger,
      logParser,
      undefined, // no anthropicBaseUrl
      null, // no globalSystemPrompt
      1, // 1 second idle timeout
    );

    const codon = createTestCodon({
      id: "timeout-test",
      name: "Timeout Test",
      // Give Claude a task that will take longer than 1 second
      promptText:
        "Write a detailed 500-word essay about the history of computing.",
      model: "sonnet",
      continuationMode: "fresh",
    });

    await manager.spawn(codon, null);

    // Idle timeout should emit "exit" with code 1 (matching shim behavior),
    // not "error" — so it flows through the normal codon failure path.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        logParser.stop();
        reject(new Error("Test timed out after 30 seconds"));
      }, 30000);

      manager.on("exit", (code) => {
        clearTimeout(timeout);
        expect(code).toBe(1);
        logParser.stop();
        resolve();
      });

      manager.on("error", (error) => {
        clearTimeout(timeout);
        logParser.stop();
        reject(new Error(`Unexpected error event: ${error.message}`));
      });
    });
  }, 30000); // 30 second timeout
});
