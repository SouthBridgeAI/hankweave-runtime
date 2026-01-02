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
    tempDir = path.resolve("tests", "test-area", `temp-sdk-integration-${Date.now()}`);
    executionPath = path.join(tempDir, "execution");
    await fs.promises.mkdir(executionPath, { recursive: true });

    // Create log file for logger
    logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    console.log(`\n🧪 Integration test directory: ${tempDir}`);
  });

  afterAll(async () => {
    // Cleanup
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    console.log(`\n🧹 Cleaned up test directory: ${tempDir}`);
  });

  test(
    "continuation session returns same session ID",
    async () => {
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

      const manager1 = new ClaudeAgentSDKManager(executionPath, logger, logParser1);

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

      const manager2 = new ClaudeAgentSDKManager(executionPath, logger, logParser2);

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
          console.log(`    ✓ Continuation session completed (exit code: ${code})`);
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

      console.log("\n✅ Test passed: Continuation session returns same session ID\n");
    },
    120000 // 2 minute timeout for the whole test
  );

  test(
    "fresh session creates different session ID",
    async () => {
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

      const manager1 = new ClaudeAgentSDKManager(executionPath, logger, logParser1);

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

      const manager2 = new ClaudeAgentSDKManager(executionPath, logger, logParser2);

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

      console.log("\n✅ Test passed: Fresh session creates different session ID\n");
    },
    120000 // 2 minute timeout for the whole test
  );
});
