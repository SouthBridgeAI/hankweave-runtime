import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ClaudeLogParser } from "../../server/claude-log-parser.js";
import { ShimProcessManager } from "../../server/shim-process-manager.js";
import type { Codon } from "../../server/types/types.js";
import { Logger } from "../../server/utils.js";

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
    geminiShimPath = path.resolve("shims/gemini/index.mjs");

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

    console.log("\n  Step 1: Setting up ShimProcessManager...");

    const sessionLogPath = path.join(tempDir, "gemini-session.jsonl");
    const logParser = new ClaudeLogParser({
      logPath: sessionLogPath,
      codonId: "gemini-test-codon",
      parsingInterval: 100,
    });

    const manager = new ShimProcessManager(executionPath, logger, logParser);

    const codon: Codon = {
      type: "codon",
      id: "gemini-test-codon",
      name: "Gemini Test Session",
      promptText: "Say 'Hello from Gemini' and nothing else.",
      model: "gemini-2.5-flash",
      continuationMode: "fresh",
    };

    console.log("\n  Step 2: Spawning gemini shim...");

    // Command to execute: ["bun", "run", "<path-to-shim>"]
    const command = ["bun", "run", geminiShimPath];

    const actualLogPath = await manager.spawn(command, codon, null);
    expect(actualLogPath).toBeTruthy();
    console.log(`    ✓ Spawned gemini shim, log: ${actualLogPath}`);

    console.log("\n  Step 3: Waiting for completion...");

    // Wait for completion
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        manager.kill("SIGTERM").catch(console.error);
        reject(new Error("Gemini session timed out after 60 seconds"));
      }, 60000);

      manager.on("exit", (code, contextExceeded) => {
        clearTimeout(timeout);
        console.log(`    ✓ Gemini session completed (exit code: ${code})`);
        if (contextExceeded) {
          console.log("    ⚠️  Context exceeded");
        }
        resolve();
      });

      manager.on("error", (error) => {
        clearTimeout(timeout);
        console.error(`    ✗ Gemini session error:`, error);
        reject(error);
      });
    });

    console.log("\n  Step 4: Verifying log file exists and has content...");

    // Verify log file was created and has content
    expect(fs.existsSync(actualLogPath)).toBe(true);
    const logContent = await fs.promises.readFile(actualLogPath, "utf-8");
    expect(logContent.length).toBeGreaterThan(0);
    console.log(`    ✓ Log file size: ${logContent.length} bytes`);

    // Parse log to verify it has the expected JSONL format
    const lines = logContent.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    console.log(`    ✓ Log has ${lines.length} lines`);

    console.log("\n  Step 5: Verifying ClaudeLogParser parsed messages...");

    // Get all messages from the log parser
    const allMessages = logParser.getAllMessages();
    console.log(`    ✓ Log parser found ${allMessages.length} messages`);

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

    // Cleanup
    logParser.stop();

    console.log("\n✅ Test passed: Can spawn gemini shim and get response\n");
  }, 120000); // 2 minute timeout for the whole test

  test.only("gemini shim with continuation mode", async () => {
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

    const logParser1 = new ClaudeLogParser({
      logPath: path.join(tempDir, "parser1.jsonl"),
      codonId: "gemini-test-codon-1",
      parsingInterval: 100,
    });

    const manager1 = new ShimProcessManager(executionPath, logger, logParser1);

    const codon1: Codon = {
      type: "codon",
      id: "gemini-test-codon-1",
      name: "First Gemini Session",
      promptText:
        "Remember the number 42. Say 'Number saved' and nothing else.",
      model: "gemini-2.5-flash",
      continuationMode: "fresh",
    };

    const command = ["bun", "run", geminiShimPath];

    const actualLogPath1 = await manager1.spawn(command, codon1, null);

    let firstSessionId: string | undefined;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        manager1.kill("SIGTERM").catch(console.error);
        reject(new Error("First session timed out after 60 seconds"));
      }, 60000);

      manager1.on("exit", () => {
        clearTimeout(timeout);
        console.log(`    ✓ First session completed`);
        resolve();
      });

      manager1.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    // Parse the log to get session ID
    const logContent1 = await fs.promises.readFile(actualLogPath1, "utf-8");
    const lines1 = logContent1.trim().split("\n");
    for (const line of lines1) {
      const entry = JSON.parse(line);
      if (entry.type === "system" && entry.session_id) {
        firstSessionId = entry.session_id;
        break;
      }
    }

    expect(firstSessionId).toBeTruthy();
    console.log(`    ✓ First session ID: ${firstSessionId}`);

    logParser1.stop();

    // =====================================
    // Step 2: Run continuation session
    // =====================================
    console.log("\n  Step 2: Running continuation session...");

    const logParser2 = new ClaudeLogParser({
      logPath: path.join(tempDir, "parser2.jsonl"),
      codonId: "gemini-test-codon-2",
      parsingInterval: 100,
    });

    const manager2 = new ShimProcessManager(executionPath, logger, logParser2);

    const codon2: Codon = {
      type: "codon",
      id: "gemini-test-codon-2",
      name: "Continuation Gemini Session",
      promptText:
        "What number did I tell you to remember? Reply with just the number.",
      model: "gemini-2.5-flash",
      continuationMode: "continue-previous",
    };

    const actualLogPath2 = await manager2.spawn(
      command,
      codon2,
      firstSessionId || null
    );

    let continuationSessionId: string | undefined;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        manager2.kill("SIGTERM").catch(console.error);
        reject(new Error("Continuation session timed out after 60 seconds"));
      }, 60000);

      manager2.on("exit", () => {
        clearTimeout(timeout);
        console.log(`    ✓ Continuation session completed`);
        resolve();
      });

      manager2.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    // Parse the log to get session ID
    const logContent2 = await fs.promises.readFile(actualLogPath2, "utf-8");
    const lines2 = logContent2.trim().split("\n");
    for (const line of lines2) {
      const entry = JSON.parse(line);
      if (entry.type === "system" && entry.session_id) {
        continuationSessionId = entry.session_id;
        break;
      }
    }

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

    logParser2.stop();

    console.log("\n✅ Test passed: Gemini shim with continuation mode\n");
  }, 180000); // 3 minute timeout for the whole test
});
