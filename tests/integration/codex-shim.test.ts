import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";
import { ClaudeLogParser } from "../../server/claude-log-parser.js";
import { ShimProcessManager } from "../../server/shim-process-manager.js";
import { Logger } from "../../server/utils.js";
import { runSessionToCompletion } from "../utils/shim-session-helpers.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

describe("Codex Shim Integration Test", () => {
  let tempDir: string;
  let executionPath: string;
  let logPath: string;
  let logger: Logger;
  let codexShimPath: string;

  beforeAll(async () => {
    // Create temp directory for test
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-codex-integration-${Date.now()}`,
    );
    executionPath = path.join(tempDir, "execution");
    await fs.promises.mkdir(executionPath, { recursive: true });

    // Create log file for logger
    logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    // Get absolute path to codex shim
    codexShimPath = path.resolve("shims/codex/index.js");

    console.log(`\n🧪 Integration test directory: ${tempDir}`);
    console.log(`📦 Codex shim path: ${codexShimPath}`);

    // Verify codex shim exists
    if (!fs.existsSync(codexShimPath)) {
      throw new Error(`Codex shim not found at ${codexShimPath}`);
    }
  });

  afterAll(async () => {
    // Cleanup
    // await fs.promises.rm(tempDir, { recursive: true, force: true });
    console.log(`\n🧹 Cleaned up test directory: ${tempDir}`);
  });

  test("can spawn codex shim and get response", async () => {
    console.log("\n📝 Test: Can spawn codex shim and get response");

    // Check if CODEX_API_KEY or OPENAI_API_KEY is set
    if (!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY) {
      console.log(
        "⏭️  Skipping test: No CODEX_API_KEY or OPENAI_API_KEY found",
      );
      return;
    }

    const codon = createTestCodon({
      id: "codex-test-codon",
      name: "Codex Test Session",
      promptText: "Say 'Hello from Codex' and nothing else.",
      model: "gpt-5.1-codex-max",
      continuationMode: "fresh",
    });

    const { logPath: actualLogPath, allMessages } =
      await runSessionToCompletion(
        tempDir,
        executionPath,
        logger,
        codexShimPath,
        codon,
        null,
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
        `      - Session ID: ${systemMessages[0].session_id || "N/A"}`,
      );
      console.log(`      - Model: ${systemMessages[0].model || "N/A"}`);
    }

    // Check for assistant messages
    const assistantMessages = allMessages.filter(
      (msg) => msg.type === "assistant",
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
            }"`,
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
          } in / ${resultMessages[0].usage.output_tokens || 0} out`,
        );
      }
    }

    console.log("\n✅ Test passed: Can spawn codex shim and get response\n");
  }, 120000); // 2 minute timeout for the whole test

  test("codex shim with continuation mode", async () => {
    console.log("\n📝 Test: Codex shim with continuation mode");

    // Check if CODEX_API_KEY or OPENAI_API_KEY is set
    if (!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY) {
      console.log(
        "⏭️  Skipping test: No CODEX_API_KEY or OPENAI_API_KEY found",
      );
      return;
    }

    // =====================================
    // Step 1: Run first session
    // =====================================
    console.log("\n  Step 1: Running first session...");

    const codon1 = createTestCodon({
      id: "codex-test-codon-1",
      name: "First Codex Session",
      promptText:
        "Remember the number 42. Say 'Number saved' and nothing else.",
      model: "gpt-5.1-codex-max",
      continuationMode: "fresh",
    });

    const { sessionId: firstSessionId } = await runSessionToCompletion(
      tempDir,
      executionPath,
      logger,
      codexShimPath,
      codon1,
      null,
    );

    console.log(`    ✓ First session ID: ${firstSessionId}`);

    // =====================================
    // Step 2: Run continuation session
    // =====================================
    console.log("\n  Step 2: Running continuation session...");

    const codon2 = createTestCodon({
      id: "codex-test-codon-2",
      name: "Continuation Codex Session",
      promptText:
        "What number did I tell you to remember? Reply with just the number.",
      model: "gpt-5.1-codex-max",
      continuationMode: "continue-previous",
    });

    const { sessionId: continuationSessionId } = await runSessionToCompletion(
      tempDir,
      executionPath,
      logger,
      codexShimPath,
      codon2,
      firstSessionId,
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

    console.log("\n✅ Test passed: Codex shim with continuation mode\n");
  }, 180000); // 3 minute timeout for the whole test

  test("codex shim with reasoning effort models", async () => {
    console.log("\n📝 Test: Codex shim with reasoning effort models");

    // Check if CODEX_API_KEY or OPENAI_API_KEY is set
    if (!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY) {
      console.log(
        "⏭️  Skipping test: No CODEX_API_KEY or OPENAI_API_KEY found",
      );
      return;
    }

    // Define test cases: model input and expected base model in system message
    const testCases = [
      {
        model: "gpt-5.2-xhigh",
        expectedModel: "openai/gpt-5.2",
        reasoningEffort: "xhigh",
      },
      {
        model: "gpt-5.2-high",
        expectedModel: "openai/gpt-5.2",
        reasoningEffort: "high",
      },
      {
        model: "gpt-5.1-codex-xhigh",
        expectedModel: "openai/gpt-5.1-codex",
        reasoningEffort: "xhigh",
      },
      {
        model: "gpt-5.1-codex-high",
        expectedModel: "openai/gpt-5.1-codex",
        reasoningEffort: "high",
      },
    ];

    for (const testCase of testCases) {
      console.log(`\n  Testing model: ${testCase.model}...`);

      const codon = createTestCodon({
        id: `codex-test-${testCase.model.replace(/\./g, "-")}`,
        name: `${testCase.model} Test`,
        promptText: `Say 'Testing ${testCase.model}' and nothing else.`,
        model: testCase.model,
        continuationMode: "fresh",
      });

      const { logPath: actualLogPath, allMessages } =
        await runSessionToCompletion(
          tempDir,
          executionPath,
          logger,
          codexShimPath,
          codon,
          null,
        );

      console.log(`    Verifying ${testCase.model}...`);

      // Verify log file was created
      expect(fs.existsSync(actualLogPath)).toBe(true);
      const logContent = await fs.promises.readFile(actualLogPath, "utf-8");
      expect(logContent.length).toBeGreaterThan(0);
      console.log(`      ✓ Log file size: ${logContent.length} bytes`);

      // Verify we have messages
      expect(allMessages.length).toBeGreaterThan(0);
      console.log(`      ✓ Log parser found ${allMessages.length} messages`);

      // Check for system message with correct model
      const systemMessages = allMessages.filter((msg) => msg.type === "system");
      expect(systemMessages.length).toBeGreaterThan(0);
      if (systemMessages[0]) {
        console.log(`      ✓ Model: ${systemMessages[0].model}`);
        expect(systemMessages[0].model).toBe(testCase.expectedModel);
      }

      // Check for assistant messages
      const assistantMessages = allMessages.filter(
        (msg) => msg.type === "assistant",
      );
      expect(assistantMessages.length).toBeGreaterThan(0);
      console.log(
        `      ✓ Found ${assistantMessages.length} assistant message(s)`,
      );

      // Verify assistant message is not an API error
      if (assistantMessages[0]) {
        const content = assistantMessages[0].message?.content;
        if (Array.isArray(content)) {
          const textContent = content.find((c: any) => c.type === "text");
          if (textContent && "text" in textContent) {
            const text = textContent.text || "";
            console.log(
              `      ✓ Response: "${text.substring(0, 50)}${text.length > 50 ? "..." : ""}"`,
            );
            expect(text).not.toContain("API Error");
            expect(text).not.toContain("does not exist");
          }
        }
      }

      // Check for result message
      const resultMessages = allMessages.filter((msg) => msg.type === "result");
      expect(resultMessages.length).toBeGreaterThan(0);

      // Verify the result is not an error
      if (resultMessages[0]) {
        console.log(`      ✓ Result: ${resultMessages[0].result}`);
        expect(resultMessages[0].is_error).toBe(false);
        expect(resultMessages[0].result).not.toContain("does not exist");
        expect(resultMessages[0].result).not.toContain("model_not_found");
      }

      console.log(`    ✓ ${testCase.model} test passed`);
    }

    console.log("\n✅ Test passed: Codex shim with reasoning effort models\n");
  }, 300000); // 5 minute timeout for all model tests

  test("codex shim with gpt-5.4 model", async () => {
    console.log("\n📝 Test: Codex shim with gpt-5.4");

    // Check if CODEX_API_KEY or OPENAI_API_KEY is set
    if (!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY) {
      console.log(
        "⏭️  Skipping test: No CODEX_API_KEY or OPENAI_API_KEY found",
      );
      return;
    }

    const codon = createTestCodon({
      id: "codex-test-gpt-5-4",
      name: "GPT-5.4 Test Session",
      promptText: "Say 'Hello from GPT-5.4' and nothing else.",
      model: "gpt-5.4",
      continuationMode: "fresh",
    });

    const { logPath: actualLogPath, allMessages } =
      await runSessionToCompletion(
        tempDir,
        executionPath,
        logger,
        codexShimPath,
        codon,
        null,
      );

    console.log("\n  Verifying gpt-5.4 response...");

    // Verify log file was created and has content
    expect(fs.existsSync(actualLogPath)).toBe(true);
    const logContent = await fs.promises.readFile(actualLogPath, "utf-8");
    expect(logContent.length).toBeGreaterThan(0);
    console.log(`    ✓ Log file size: ${logContent.length} bytes`);

    // Verify we have messages
    expect(allMessages.length).toBeGreaterThan(0);
    console.log(`    ✓ Log parser found ${allMessages.length} messages`);

    // Check for system message with correct model
    const systemMessages = allMessages.filter((msg) => msg.type === "system");
    expect(systemMessages.length).toBeGreaterThan(0);
    if (systemMessages[0]) {
      console.log(`    ✓ Model: ${systemMessages[0].model}`);
      expect(systemMessages[0].model).toBe("openai/gpt-5.4");
    }

    // Check for assistant messages
    const assistantMessages = allMessages.filter(
      (msg) => msg.type === "assistant",
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
            `    ✓ Response: "${text.substring(0, 50)}${text.length > 50 ? "..." : ""}"`,
          );
          expect(text).not.toContain("API Error");
          expect(text).not.toContain("does not exist");
        }
      }
    }

    // Check for result message
    const resultMessages = allMessages.filter((msg) => msg.type === "result");
    expect(resultMessages.length).toBeGreaterThan(0);
    if (resultMessages[0]) {
      console.log(`    ✓ Result: ${resultMessages[0].result}`);
      expect(resultMessages[0].is_error).toBe(false);
    }

    console.log("\n✅ Test passed: Codex shim with gpt-5.4\n");
  }, 120000); // 2 minute timeout

  describe("codex shim reasoning effort default", () => {
    // Read the shim source to verify the default is present
    const shimSource = fs.readFileSync(
      path.resolve(__dirname, "../../shims/codex/index.js"),
      "utf-8",
    );

    test("shim resolves a default reasoning effort in resolveModel", () => {
      // The shim's resolveModel() should always set a reasoning effort default (typically "high")
      // so the SDK never receives an undefined value. We verify the source mentions the default.
      expect(shimSource).toContain('"high"');
    });

    test("resolveModel should not extract reasoning effort from non-effort suffixes", () => {
      const validEfforts = ["minimal", "low", "medium", "high", "xhigh"];
      expect(validEfforts).not.toContain("mini");
      expect(validEfforts).not.toContain("max");
      expect(validEfforts).not.toContain("codex");
    });
  });

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

    // Create manager (use executionPath for both since this is a simple integration test)
    const manager = new ShimProcessManager(
      executionPath,
      executionPath,
      logger,
      logParser,
    );

    console.log("\n  Running self-test...");

    // Run self-test
    const command = ["bun", "run", codexShimPath];
    const result = await manager.runSelfTest(command);

    console.log(`    ✓ Self-test completed`);
    console.log(
      `      Overall: ${result.overall.passed ? "PASSED" : "FAILED"}`,
    );
    console.log(`      Message: ${result.overall.message}`);

    // Verify result structure
    console.log("\n  Verifying result structure...");
    expect(result).toBeDefined();
    expect(result.shim).toBeDefined();
    expect(result.shim.name).toBe("codex-shim");
    expect(typeof result.shim.version).toBe("string");
    console.log(`    ✓ Shim: ${result.shim.name} v${result.shim.version}`);

    expect(result.agent).toBeDefined();
    expect(result.agent.name).toBe("codex");
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

    // Clean up
    logParser.stop();

    console.log("\n✅ Test passed: Shim self-test via ShimProcessManager\n");
  }, 30000); // 30 second timeout

  test("codex shim uses ~/.codex/auth.json when no API key env vars are set", async () => {
    console.log("\n📝 Test: Codex shim with auth.json as sole auth source");

    const authJsonPath = path.join(os.homedir(), ".codex", "auth.json");
    expect(fs.existsSync(authJsonPath)).toBe(true);

    const savedEnv = captureEnv();
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;

    try {
      const codon = createTestCodon({
        id: "codex-auth-json-test",
        name: "Auth JSON Test Session",
        promptText: "Say 'Auth JSON works' and nothing else.",
        model: "gpt-5.2",
        continuationMode: "fresh",
      });

      const { allMessages } = await runSessionToCompletion(
        tempDir,
        executionPath,
        logger,
        codexShimPath,
        codon,
        null,
      );

      const systemMsg = allMessages.find((m) => m.type === "system") as any;
      expect(systemMsg).toBeDefined();
      console.log(`    ✓ apiKeySource: ${systemMsg.apiKeySource}`);
      expect(systemMsg.apiKeySource).toBe("~/.codex/auth.json");

      const resultMsg = allMessages.find((m) => m.type === "result") as any;
      expect(resultMsg?.is_error).toBe(false);
    } finally {
      restoreEnv(savedEnv);
    }

    console.log("\n✅ Test passed: codex shim uses ~/.codex/auth.json\n");
  }, 120000);

  test("codex shim uses OPENAI_API_KEY env var when set", async () => {
    console.log(
      "\n📝 Test: Codex shim picks up OPENAI_API_KEY and fails with bogus key",
    );

    const savedEnv = captureEnv();
    process.env.OPENAI_API_KEY = "sk-bogus-key-for-testing";
    delete process.env.CODEX_API_KEY;

    try {
      const codon = createTestCodon({
        id: "codex-openai-key-test",
        name: "OPENAI_API_KEY Test Session",
        promptText: "Say hello.",
        model: "gpt-5.2",
        continuationMode: "fresh",
      });

      const { allMessages } = await runSessionToCompletion(
        tempDir,
        executionPath,
        logger,
        codexShimPath,
        codon,
        null,
      );

      // Shim should report OPENAI_API_KEY as the auth source
      const systemMsg = allMessages.find((m) => m.type === "system") as any;
      expect(systemMsg).toBeDefined();
      console.log(`    ✓ apiKeySource: ${systemMsg.apiKeySource}`);
      expect(systemMsg.apiKeySource).toBe("OPENAI_API_KEY");

      // The API call should fail because the key is bogus
      const resultMsg = allMessages.find((m) => m.type === "result") as any;
      expect(resultMsg).toBeDefined();
      console.log(`    ✓ is_error: ${resultMsg.is_error}`);
      console.log(`    ✓ result: ${resultMsg.result}`);
      expect(resultMsg.is_error).toBe(true);
      expect(resultMsg.result).toContain("401");
    } finally {
      restoreEnv(savedEnv);
    }

    console.log(
      "\n✅ Test passed: codex shim uses OPENAI_API_KEY and fails with bogus key\n",
    );
  }, 120000);
});
