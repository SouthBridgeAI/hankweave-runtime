/**
 * Tests for CodonRunner's failure reason classification from result messages.
 *
 * Classification is delegated to the shared classifier in
 * server/error-classification.ts: transient errors (timeouts, rate limits,
 * transport faults, unknown text) are retriable; billing/auth/invalid-request
 * errors are not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Budget } from "../../server/budget.js";
import { CodonRunner } from "../../server/codon-runner.js";
import type { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import type { StateManager } from "../../server/state-manager.js";
import type { CodonId, RunId } from "../../server/types/branded-types.js";
import { Logger } from "../../server/utils.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

function createTestBudget() {
  return new Budget({
    config: {},
    executionPlan: [],
    logger: new Logger("/dev/null"),
  });
}

const mockLlmRegistry = {
  calculateCost: () => null,
} as unknown as LlmProviderRegistry;

const mockStateManager = {
  transition: () => {},
  getState: () => ({ executionPlan: [] }),
  getCodonInCurrentRun: () => null,
  getCurrentRun: () => null,
} as unknown as StateManager;

const mockRunId = "test-run-id" as unknown as RunId;

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "test-session",
  model: "claude-sonnet-4-5",
  cwd: "/test",
  tools: ["Read"],
  mcp_servers: [],
  permissionMode: "bypassPermissions",
  apiKeySource: "ANTHROPIC_API_KEY",
});

function makeErrorLog(resultText: string): string {
  return (
    INIT_LINE +
    "\n" +
    JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: resultText,
      num_turns: 1,
      duration_ms: 5000,
      duration_api_ms: 4000,
    }) +
    "\n"
  );
}

async function runAndGetFailureReason(
  tempDir: string,
  logContent: string,
): Promise<{ type: string; retriable: boolean } | undefined> {
  const logPath = path.join(tempDir, `test-${Date.now()}.jsonl`);
  await fs.promises.writeFile(logPath, logContent);

  const codon = createTestCodon({
    id: "test-codon",
    name: "Test Codon",
    promptText: "Test prompt",
    model: "sonnet",
    continuationMode: "fresh",
  });

  const runner = new CodonRunner({
    codon,
    codonId: "test-codon" as CodonId,
    executionPath: tempDir,
    agentRootPath: tempDir,
    logger: new Logger(path.join(tempDir, "runner.log")),
    llmRegistry: mockLlmRegistry,
    runId: mockRunId,
    stateManager: mockStateManager,
    budget: createTestBudget(),
    logPath,
    logParsingInterval: 50,
  });

  const logParser = (runner as unknown as { logParser: { start: () => void; stop: () => void } })
    .logParser;
  logParser.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  logParser.stop();

  const failureReason = (
    runner as unknown as { failureReason: { type: string; retriable: boolean } | undefined }
  ).failureReason;

  runner.cleanup();
  return failureReason;
}

describe("CodonRunner failure reason classification", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-codon-runner-failure-reason-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test("classifies timeout error as { type: 'timeout', retriable: true }", async () => {
    const failureReason = await runAndGetFailureReason(
      tempDir,
      makeErrorLog("API Error: Request timed out."),
    );
    expect(failureReason).toMatchObject({ type: "timeout", retriable: true });
  });

  test("classifies rate-limit error as { type: 'rate-limit', retriable: true }", async () => {
    const failureReason = await runAndGetFailureReason(
      tempDir,
      makeErrorLog("Rate limit exceeded (429)"),
    );
    expect(failureReason).toMatchObject({ type: "rate-limit", retriable: true });
  });

  test("classifies api error as { type: 'api-error', retriable: true }", async () => {
    const failureReason = await runAndGetFailureReason(
      tempDir,
      makeErrorLog("Internal API error 500"),
    );
    expect(failureReason).toMatchObject({ type: "api-error", retriable: true });
  });

  test("classifies unknown error as retriable api-error (transient by default)", async () => {
    const failureReason = await runAndGetFailureReason(
      tempDir,
      makeErrorLog("Something unexpected happened"),
    );
    expect(failureReason).toMatchObject({ type: "api-error", retriable: true });
  });

  test("classifies billing error as non-retriable", async () => {
    const failureReason = await runAndGetFailureReason(
      tempDir,
      makeErrorLog("Credit balance is too low"),
    );
    expect(failureReason).toMatchObject({ type: "api-error", retriable: false });
  });

  test("leaves failureReason UNSET for an empty error-subtype result (SDK placeholder)", async () => {
    // The Claude SDK strips the `result` field from subtype:"error" messages;
    // ClaudeAgentSDKManager.convertSDKMessageToJSONL then writes result:"".
    // Classifying that empty placeholder would always yield a default-retriable
    // api-error and shadow the real thrown error in the SDK-crash path. Instead,
    // failureReason must stay undefined so the later thrown error is classified
    // authoritatively (see codon-runner-transient-crash-retry.test.ts).
    const failureReason = await runAndGetFailureReason(tempDir, makeErrorLog(""));
    expect(failureReason).toBeUndefined();
  });

  test("classifies disguised error (subtype=success, is_error=true) as retriable failure", async () => {
    const disguisedErrorLog =
      INIT_LINE +
      "\n" +
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result:
          "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        num_turns: 1,
        duration_ms: 5000,
        duration_api_ms: 4000,
      }) +
      "\n";
    const failureReason = await runAndGetFailureReason(tempDir, disguisedErrorLog);
    expect(failureReason).toMatchObject({ type: "api-error", retriable: true });
  });

  test("does NOT extend on an empty error-subtype result followed by a clean exit", async () => {
    // Regression for the retry/extension-bypass hole. An empty subtype:"error"
    // result (the SDK placeholder, result:"") intentionally leaves failureReason
    // unset so a later thrown error can be classified authoritatively. But when the
    // process then exits cleanly (code 0) with NO thrown error, the internal
    // extension loop must NOT re-prompt: the codon must fail and let the runtime's
    // failure policy apply. Previously shouldExtendCodon saw
    // resultMessageReceived && !failureReason && exitCode === 0 and extended up to
    // maxExtensions instead of failing.
    const logPath = path.join(tempDir, `empty-error-extend-${Date.now()}.jsonl`);
    await fs.promises.writeFile(logPath, makeErrorLog(""));

    const codon = createTestCodon({
      id: "test-codon",
      name: "Test Codon",
      promptText: "Test prompt",
      model: "sonnet",
      continuationMode: "fresh",
      exhaustWithPrompt: "Continue", // enable extensions
    });

    let onExtensionCalled = false;
    const runner = new CodonRunner({
      codon,
      codonId: "test-codon" as CodonId,
      executionPath: tempDir,
      agentRootPath: tempDir,
      logger: new Logger(path.join(tempDir, "runner.log")),
      llmRegistry: mockLlmRegistry,
      runId: mockRunId,
      stateManager: mockStateManager,
      budget: createTestBudget(),
      logPath,
      logParsingInterval: 50,
      extensionConfig: { maxExtensions: 2, exhaustWithPrompt: "Continue" },
      shouldInterrupt: () => false,
      onExtension: () => {
        onExtensionCalled = true;
      },
    });

    // Guard: even if the (buggy) extension path fires, never spawn a real SDK.
    (runner as unknown as { runExtension: () => Promise<void> }).runExtension = async () => {};

    let exitEmitted = false;
    let exitCode: number | undefined;
    runner.on("exit", (code: number) => {
      exitEmitted = true;
      exitCode = code;
    });

    // Parse the init + empty error result (sets resultMessageReceived and
    // currentSessionId; leaves failureReason undefined).
    const logParser = (runner as unknown as { logParser: { start: () => void; stop: () => void } })
      .logParser;
    logParser.start();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Simulate the process exiting cleanly with no thrown SDK error.
    const processManager = (
      runner as unknown as { processManager: { emit: (event: string, ...args: unknown[]) => void } }
    ).processManager;
    processManager.emit("exit", 0, false);
    await new Promise((resolve) => setTimeout(resolve, 50));

    logParser.stop();
    runner.cleanup();

    expect(onExtensionCalled).toBe(false);
    expect(exitEmitted).toBe(true);
    expect(exitCode).toBe(0);
  });
});
