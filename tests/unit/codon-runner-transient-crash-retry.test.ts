/**

 * A transient server-side API error (HTTP 500 / "overloaded" / dropped socket)
 * can crash the Claude Agent SDK subprocess MID-CONVERSATION, before any result
 * message is emitted. The SDK surfaces this as a rejected queryPromise, which
 * ClaudeAgentSDKManager re-emits as a process-manager "error" event.
 *
 * The `analyze#0` codon was configured
 *   onFailure: "retry", retryConfig: { maxAttempts: 2 }
 * yet the run was marked "failed" with the codon stuck in "running" and ZERO
 * retry attempts recorded. The smoking gun: `analyze#0` has no
 * `resultMessageReceived` flag (contrast: the `prepare` codon does) — i.e. the
 * SDK crashed without ever delivering a terminal result.
 *
 * Root cause: CodonRunner re-emits this process "error" verbatim (see the
 * "without success result (normal error path)" case in
 * codon-runner-post-success-error.test.ts), and the runtime escalates ANY
 * runner "error" to handleError(ErrorSeverity.FATAL) -> shutdown
 * (hankweave-runtime.ts). That path NEVER consults resolveFailurePolicy /
 * classifyApiErrorText, so `onFailure: retry` is silently bypassed.
 *
 * Desired contract (this test): a transient/retriable process "error" with no
 * success result must be surfaced as a RETRIABLE failure routed through the
 * normal exit/retry path — emit "exit" with a non-zero code AND expose a
 * retriable `failureReason` — instead of a bare fatal "error". This mirrors the
 * existing budget-exceeded and post-success error->exit conversions in
 * CodonRunner, and the runtime's APITimeoutError handling (which sets a
 * retriable failureReason and lets the codon exit into the retry machinery).
 *
 * Per classifyApiErrorText's documented policy, unrecognized crash text
 * (e.g. the SDK's generic "Claude Code process exited with code 1") defaults to
 * RETRIABLE — retries are bounded by maxAttempts, so a wrong "retriable" costs
 * one extra attempt while a wrong "non-retriable" kills the whole run.
 *
 * This test FAILS on the pre-fix code (CodonRunner emits "error", never "exit",
 * and leaves failureReason undefined).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Budget } from "../../server/budget.js";
import { CodonRunner } from "../../server/codon-runner.js";
import type { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import type { StateManager } from "../../server/state-manager.js";
import type { CodonId, RunId } from "../../server/types/branded-types.js";
import type { FailureReason } from "../../server/types/types.js";
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

// Test doubles for reaching into CodonRunner internals, matching the access
// pattern used by codon-runner-post-success-error.test.ts.
type ProcessManagerHandle = { emit: (event: string, error: Error) => void };
type RunnerInternals = {
  processManager: ProcessManagerHandle;
  successResultReceived: boolean;
  failureReason: FailureReason | undefined;
};

describe("CodonRunner transient-crash retry", () => {
  let tempDir: string;
  let logger: Logger;
  let runner: CodonRunner | null = null;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-codon-runner-cc500-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    logger = new Logger(path.join(tempDir, "test.log"));
  });

  afterEach(async () => {
    if (runner) {
      runner.cleanup();
      runner = null;
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Build a runner whose log file is empty, so no result message is ever parsed
   */
  async function makeRunnerWithEmptyLog(): Promise<CodonRunner> {
    const emptyLogPath = path.join(tempDir, "empty.jsonl");
    await fs.promises.writeFile(emptyLogPath, "");

    const codon = createTestCodon({
      id: "analyze",
      name: "Answer the next batch of queries",
      promptText: "Test prompt",
      model: "sonnet", // Anthropic model -> ClaudeAgentSDKManager
      continuationMode: "fresh",
    });

    return new CodonRunner({
      codon,
      codonId: "analyze" as CodonId,
      executionPath: tempDir,
      agentRootPath: tempDir,
      logger,
      llmRegistry: mockLlmRegistry,
      runId: mockRunId,
      stateManager: mockStateManager,
      budget: createTestBudget(),
      logPath: emptyLogPath,
    });
  }

  test("explicit 5xx crash with no result -> retriable exit, not fatal error", async () => {
    runner = await makeRunnerWithEmptyLog();

    let exitEmitted = false;
    let errorEmitted = false;
    let exitCode: number | undefined;

    runner.on("exit", (code) => {
      exitEmitted = true;
      exitCode = code;
    });
    runner.on("error", () => {
      errorEmitted = true;
    });

    const internals = runner as unknown as RunnerInternals;
    // No success result was received
    expect(internals.successResultReceived).toBe(false);

    // SDK subprocess died on a server-side 500 (queryPromise rejected).
    internals.processManager.emit(
      "error",
      new Error("API Error: 500 Internal Server Error (overloaded_error)"),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Must NOT bubble a bare fatal error (the runtime turns that into FATAL
    // shutdown, bypassing onFailure: retry).
    expect(errorEmitted).toBe(false);

    // Must route into the normal exit/retry path with a non-zero (failed) code...
    expect(exitEmitted).toBe(true);
    expect(exitCode).not.toBe(0);

    // ...carrying a retriable failure reason so resolveFailurePolicy can retry.
    expect(internals.failureReason).toMatchObject({ retriable: true });
  });

  test("generic crash before session established -> non-retriable exit (local-setup)", async () => {
    runner = await makeRunnerWithEmptyLog();

    let exitEmitted = false;
    let errorEmitted = false;
    let exitCode: number | undefined;

    runner.on("exit", (code) => {
      exitEmitted = true;
      exitCode = code;
    });
    runner.on("error", () => {
      errorEmitted = true;
    });

    const internals = runner as unknown as RunnerInternals;

    // No system/init message was ever observed (empty log, SDK session id never
    // captured), so getSystemMessageReceived() is false. The SDK's generic crash
    // text matches no known transient API pattern, so with no session established
    // it classifies as a local setup failure -> NON-retriable: retrying cannot
    // fix a process that died before it ever started talking.
    internals.processManager.emit("error", new Error("Claude Code process exited with code 1"));

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Still routed through the exit path (not a fatal runner error), so
    // resolveFailurePolicy decides — it just won't retry a non-retriable reason.
    expect(errorEmitted).toBe(false);
    expect(exitEmitted).toBe(true);
    expect(exitCode).not.toBe(0);
    expect(internals.failureReason).toMatchObject({ retriable: false });
  });

  test("generic crash AFTER session established -> retriable exit (transient)", async () => {
    // Companion to the case above: once a system/init message has been observed,
    // an unrecognized mid-conversation crash is treated as plausibly transient and
    // stays retriable. We simulate establishment by setting the runner's flag, the
    // same state onSystemMessage would produce.
    runner = await makeRunnerWithEmptyLog();

    let exitEmitted = false;
    let errorEmitted = false;
    let exitCode: number | undefined;

    runner.on("exit", (code) => {
      exitEmitted = true;
      exitCode = code;
    });
    runner.on("error", () => {
      errorEmitted = true;
    });

    const internals = runner as unknown as RunnerInternals;
    (internals as unknown as { systemMessageReceived: boolean }).systemMessageReceived = true;

    internals.processManager.emit("error", new Error("Claude Code process exited with code 1"));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errorEmitted).toBe(false);
    expect(exitEmitted).toBe(true);
    expect(exitCode).not.toBe(0);
    expect(internals.failureReason).toMatchObject({ retriable: true });
  });

  /**
   * Build a runner for a NON-Anthropic model, so createProcessManager wires up a
   * ShimProcessManager instead of the Claude Agent SDK manager. Its `error` event
   * represents a LOCAL child-process failure (missing node/bun, bad cwd,
   * unexecutable shim), not an API/SDK crash.
   */
  async function makeShimRunnerWithEmptyLog(): Promise<CodonRunner> {
    const emptyLogPath = path.join(tempDir, "empty-shim.jsonl");
    await fs.promises.writeFile(emptyLogPath, "");

    const codon = createTestCodon({
      id: "analyze",
      name: "Answer the next batch of queries",
      promptText: "Test prompt",
      model: "gemini-2.5-flash", // non-Anthropic -> ShimProcessManager
      continuationMode: "fresh",
    });

    return new CodonRunner({
      codon,
      codonId: "analyze" as CodonId,
      executionPath: tempDir,
      agentRootPath: tempDir,
      logger,
      llmRegistry: mockLlmRegistry,
      runId: mockRunId,
      stateManager: mockStateManager,
      budget: createTestBudget(),
      logPath: emptyLogPath,
    });
  }

  test("shim local spawn failure (ENOENT) -> fatal error, NOT a retriable exit", async () => {
    // Guard rail: a non-Anthropic shim's `error` event is a local config error
    // (e.g. spawn ENOENT for a missing node/bun). classifyApiErrorText would
    // default its unfamiliar text to retriable; the runner must NOT convert it
    // into an exit/retry — that would retry a hopeless local misconfiguration
    // (onFailure: retry) or, worse, leak an exit(1) that leaves the runtime
    // active instead of failing the run (onFailure: abort). It must stay fatal.
    runner = await makeShimRunnerWithEmptyLog();

    let exitEmitted = false;
    let errorEmitted = false;

    runner.on("exit", () => {
      exitEmitted = true;
    });
    runner.on("error", () => {
      errorEmitted = true;
    });

    const internals = runner as unknown as RunnerInternals;
    expect(internals.successResultReceived).toBe(false);

    // Node child_process spawn failure shape — text that classifyApiErrorText
    // would otherwise default to retriable.
    internals.processManager.emit("error", new Error("spawn node ENOENT"));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errorEmitted).toBe(true);
    expect(exitEmitted).toBe(false);
  });

  /**
   * Build a runner whose log already contains an empty error-subtype RESULT
   * message (the SDK placeholder: ClaudeAgentSDKManager.convertSDKMessageToJSONL
   * writes result:"" for subtype:"error"), then start parsing so onResultMessage
   * fires before the queryPromise-rejection "error" event.
   */
  async function makeRunnerWithEmptyErrorResult(): Promise<CodonRunner> {
    const initLine = JSON.stringify({
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
    const emptyErrorResultLine = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "", // SDK placeholder — real error text is stripped from error results
      num_turns: 1,
      duration_ms: 5000,
      duration_api_ms: 4000,
    });
    const logPath = path.join(tempDir, "empty-error-result.jsonl");
    await fs.promises.writeFile(logPath, `${initLine}\n${emptyErrorResultLine}\n`);

    const codon = createTestCodon({
      id: "analyze",
      name: "Answer the next batch of queries",
      promptText: "Test prompt",
      model: "sonnet", // Anthropic model -> ClaudeAgentSDKManager
      continuationMode: "fresh",
    });

    const r = new CodonRunner({
      codon,
      codonId: "analyze" as CodonId,
      executionPath: tempDir,
      agentRootPath: tempDir,
      logger,
      llmRegistry: mockLlmRegistry,
      runId: mockRunId,
      stateManager: mockStateManager,
      budget: createTestBudget(),
      logPath,
      logParsingInterval: 50,
    });

    // Parse the log so the empty error result is consumed by onResultMessage.
    const logParser = (r as unknown as { logParser: { start: () => void; stop: () => void } })
      .logParser;
    logParser.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    logParser.stop();
    return r;
  }

  test("empty error-subtype result then permanent throw -> non-retriable (placeholder must NOT shadow real error)", async () => {
    // Regression for the P1 bug: an empty error-subtype result must NOT be
    // classified into failureReason (it would default to retriable and, via
    // `this.failureReason ?? classifyApiErrorText(error.message)`, shadow the
    // REAL thrown billing/auth/400 error — retrying a permanent failure).
    runner = await makeRunnerWithEmptyErrorResult();

    let exitEmitted = false;
    let errorEmitted = false;
    let exitCode: number | undefined;

    runner.on("exit", (code) => {
      exitEmitted = true;
      exitCode = code;
    });
    runner.on("error", () => {
      errorEmitted = true;
    });

    const internals = runner as unknown as RunnerInternals;
    // The empty placeholder result was parsed but left failureReason unset.
    expect(internals.failureReason).toBeUndefined();

    // The SDK then rejects with the real permanent (billing) error.
    internals.processManager.emit(
      "error",
      new Error("API Error: Your credit balance is too low to access the API."),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errorEmitted).toBe(false);
    expect(exitEmitted).toBe(true);
    expect(exitCode).not.toBe(0);
    // The real thrown error wins -> permanent, so onFailure won't retry.
    expect(internals.failureReason).toMatchObject({ retriable: false });
  });

  test("permanent error (billing) with no result -> non-retriable exit routed to failure policy", async () => {
    // Guard rail #1: the fix must NOT make genuinely permanent failures retriable.
    // Guard rail #2: an SDK API failure must NOT bubble as a fatal runner "error"
    // either — the runtime escalates those to FATAL shutdown, bypassing
    // handleCodonComplete/resolveFailurePolicy (no failed-state recording, and a
    // codon configured `onFailure: "ignore"` would be ignored). Instead it exits
    // non-zero carrying a NON-retriable failureReason, so resolveFailurePolicy
    // decides shutdown (abort/retry) vs continue (ignore).
    runner = await makeRunnerWithEmptyLog();

    let exitEmitted = false;
    let errorEmitted = false;
    let exitCode: number | undefined;

    runner.on("exit", (code) => {
      exitEmitted = true;
      exitCode = code;
    });
    runner.on("error", () => {
      errorEmitted = true;
    });

    const internals = runner as unknown as RunnerInternals;
    internals.processManager.emit(
      "error",
      new Error("API Error: Your credit balance is too low to access the API."),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    // No fatal error — routed through the exit/failure-policy path...
    expect(errorEmitted).toBe(false);
    expect(exitEmitted).toBe(true);
    expect(exitCode).not.toBe(0);
    // ...with a permanent reason so the policy won't retry (abort/retry shutdown,
    // ignore continues).
    expect(internals.failureReason).toMatchObject({ retriable: false });
  });
});
