/**
 * Tests for CodonRunner's failure reason classification from result messages.
 *
 * Bug: onResultMessage reads msg.error to classify errors, but ResultMessage
 * has no `error` field — the text lives in `msg.result`. Because msg.error is
 * always undefined, errorText is always "" and every error result is classified
 * as { type: "unknown", retriable: false }, even when it's a retriable timeout
 * or rate-limit error.
 *
 * Fix: change `msg.error` to `msg.result` on codon-runner.ts line 541.
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
    expect(failureReason).toEqual({ type: "timeout", retriable: true });
  });

  test("classifies rate-limit error as { type: 'rate-limit', retriable: true }", async () => {
    const failureReason = await runAndGetFailureReason(
      tempDir,
      makeErrorLog("Rate limit exceeded (429)"),
    );
    expect(failureReason).toEqual({ type: "rate-limit", retriable: true });
  });

  test("classifies api error as { type: 'api-error', retriable: true }", async () => {
    const failureReason = await runAndGetFailureReason(
      tempDir,
      makeErrorLog("Internal API error 500"),
    );
    expect(failureReason).toEqual({ type: "api-error", retriable: true });
  });

  test("classifies unknown error as { type: 'unknown', retriable: false }", async () => {
    const failureReason = await runAndGetFailureReason(
      tempDir,
      makeErrorLog("Something unexpected happened"),
    );
    expect(failureReason).toEqual({ type: "unknown", retriable: false });
  });
});
