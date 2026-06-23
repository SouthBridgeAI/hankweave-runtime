/**
 * Tests for CodonRunner's handling of post-success SDK errors.
 *
 * This tests the fix for a known Claude Agent SDK bug where the SDK
 * emits an error ("only prompt commands are supported in streaming mode")
 * AFTER already reporting a successful result.
 *
 * See: intermediates/31-fixing-claude-sdk-bug/bug_investigation.md
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Budget } from "../../server/budget.js";
import { CodonRunner } from "../../server/codon-runner.js";
import type { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import type { StateManager } from "../../server/state-manager.js";
import { type CodonId, type RunId, SessionId } from "../../server/types/branded-types.js";
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

// Path to test log file that reproduces the SDK bug sequence
// This contains real data extracted from run 1769144204725-v8vnh
const BUGGY_LOG_PATH = path.resolve(
  import.meta.dir,
  "../test-data/claude-logs/sdk-post-success-error/buggy-sequence.jsonl",
);

describe("CodonRunner post-success SDK error handling", () => {
  let tempDir: string;
  let logger: Logger;
  let runner: CodonRunner | null = null;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-codon-runner-sdk-error-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);
  });

  afterEach(async () => {
    if (runner) {
      runner.cleanup();
      runner = null;
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe("with real buggy SDK log sequence (log replay)", () => {
    test("should emit exit instead of error after parsing success result", async () => {
      // Copy the buggy log file to temp dir (so we don't modify test data)
      const testLogPath = path.join(tempDir, "buggy.jsonl");
      await fs.promises.copyFile(BUGGY_LOG_PATH, testLogPath);

      // Create test codon with Anthropic model (to get ClaudeAgentSDKManager)
      const codon = createTestCodon({
        id: "test-codon",
        name: "Test Codon",
        promptText: "Test prompt",
        model: "sonnet", // Anthropic model
        continuationMode: "fresh",
      });

      // Create runner with the buggy log file
      runner = new CodonRunner({
        codon,
        codonId: "test-codon" as CodonId,
        executionPath: tempDir,
        agentRootPath: tempDir, // Use same path for tests
        logger,
        llmRegistry: mockLlmRegistry,
        runId: mockRunId,
        stateManager: mockStateManager,
        budget: createTestBudget(),
        logPath: testLogPath,
        logParsingInterval: 50, // Fast parsing for test
      });

      // Track emitted events
      let exitEmitted = false;
      let errorEmitted = false;
      let exitCode: number | undefined;

      runner.on("exit", (code, _contextExceeded) => {
        exitEmitted = true;
        exitCode = code;
      });

      runner.on("error", () => {
        errorEmitted = true;
      });

      // Start the log parser (normally done in runner.run(), but we're not spawning a real process)
      // Access private property for testing
      const logParser = (runner as unknown as { logParser: { start: () => void } }).logParser;
      logParser.start();

      // Wait for log parser to process the success result (150ms should be plenty at 50ms interval)
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify the success flag was set by parsing the log
      const successReceived = (runner as unknown as { successResultReceived: boolean })
        .successResultReceived;
      expect(successReceived).toBe(true);

      // Now simulate the SDK crash - this is what triggers the error event
      // In real scenario: SDK emits success, then error_during_execution, then crashes
      const processManager = (
        runner as unknown as {
          processManager: { emit: (event: string, error: Error) => void };
        }
      ).processManager;
      processManager.emit("error", new Error("Claude Code process exited with code 1"));

      // Give event handlers time to process
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify: we got exit(0), not error
      expect(exitEmitted).toBe(true);
      expect(exitCode).toBe(0);
      expect(errorEmitted).toBe(false);

      // Stop the log parser
      const logParserStop = (runner as unknown as { logParser: { stop: () => void } }).logParser;
      logParserStop.stop();
    });
  });

  describe("without success result (normal error path)", () => {
    test("permanent failure with no success result -> non-retriable exit, not fatal error", async () => {
      // No success result -> post-success suppression must NOT apply. With no
      // result message at all, the crash is classified. A PERMANENT failure
      // (here, a billing error) is still an SDK/API outcome, so it routes through
      // the EXIT path carrying a non-retriable failureReason — letting
      // resolveFailurePolicy decide shutdown vs continue — rather than a fatal
      // "error" that the runtime would escalate to FATAL shutdown, bypassing the
      // policy. Transient crashes with no result also route to the exit path —
      // see tests/unit/codon-runner-transient-crash-retry.test.ts.
      // Use an empty log file (no success result)
      const emptyLogPath = path.join(tempDir, "empty.jsonl");
      await fs.promises.writeFile(emptyLogPath, "");

      const codon = createTestCodon({
        id: "test-codon",
        name: "Test Codon",
        promptText: "Test prompt",
        model: "sonnet",
        continuationMode: "fresh",
      });

      runner = new CodonRunner({
        codon,
        codonId: "test-codon" as CodonId,
        executionPath: tempDir,
        agentRootPath: tempDir, // Use same path for tests
        logger,
        llmRegistry: mockLlmRegistry,
        runId: mockRunId,
        stateManager: mockStateManager,
        budget: createTestBudget(),
        logPath: emptyLogPath,
      });

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

      // No log parsing needed - just trigger error directly
      // successResultReceived should be false
      const successReceived = (runner as unknown as { successResultReceived: boolean })
        .successResultReceived;
      expect(successReceived).toBe(false);

      // Simulate a permanent SDK error without prior success
      const internals = runner as unknown as {
        processManager: { emit: (event: string, error: Error) => void };
        failureReason: { retriable: boolean } | undefined;
      };
      const permanentError = "API Error: Your credit balance is too low to access the API.";
      internals.processManager.emit("error", new Error(permanentError));

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify: routed to the exit/failure-policy path with a non-retriable
      // reason, NOT a fatal runner error.
      expect(errorEmitted).toBe(false);
      expect(exitEmitted).toBe(true);
      expect(exitCode).not.toBe(0);
      expect(internals.failureReason).toMatchObject({ retriable: false });
    });
  });

  describe("error result followed by an SDK throw", () => {
    // The SDK can emit an error RESULT and THEN throw a process-manager error.
    // onResultMessage classifies the result into `failureReason`; the subsequent
    // throw must be routed by RETRIABILITY (prefer that classified reason), not
    // by whether a result arrived — otherwise `onFailure: retry` is bypassed for
    async function runWithResultThenThrow(resultMessage: Record<string, unknown>) {
      const logPath = path.join(tempDir, "result-then-throw.jsonl");
      const log = `${[
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "test-session",
          model: "claude-sonnet-4-5",
          cwd: "/test",
          tools: ["Read"],
          mcp_servers: [],
          permissionMode: "bypassPermissions",
          apiKeySource: "ANTHROPIC_API_KEY",
        }),
        JSON.stringify({
          type: "result",
          num_turns: 5,
          duration_ms: 10000,
          ...resultMessage,
        }),
      ].join("\n")}\n`;
      await fs.promises.writeFile(logPath, log);

      const codon = createTestCodon({
        id: "test-codon",
        name: "Test Codon",
        promptText: "Test prompt",
        model: "sonnet",
        continuationMode: "fresh",
      });

      runner = new CodonRunner({
        codon,
        codonId: "test-codon" as CodonId,
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

      const events = {
        exitEmitted: false,
        errorEmitted: false,
        exitCode: undefined as number | undefined,
      };
      runner.on("exit", (code) => {
        events.exitEmitted = true;
        events.exitCode = code;
      });
      runner.on("error", () => {
        events.errorEmitted = true;
      });

      const internals = runner as unknown as {
        logParser: { start: () => void; stop: () => void };
        successResultReceived: boolean;
        processManager: { emit: (event: string, error: Error) => void };
      };
      internals.logParser.start();
      await new Promise((resolve) => setTimeout(resolve, 150));

      // A disguised/error result is never a success.
      expect(internals.successResultReceived).toBe(false);

      // SDK throws after emitting the result.
      internals.processManager.emit("error", new Error("Claude Code process exited with code 1"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      internals.logParser.stop();
      return events;
    }

    test("retriable error result then throw -> retriable exit, not fatal", async () => {
      // The reviewer's exact case: a disguised socket-drop result.
      const events = await runWithResultThenThrow({
        subtype: "success",
        is_error: true,
        result: "API Error: The socket connection was closed unexpectedly.",
        duration_api_ms: 8000,
      });
      expect(events.errorEmitted).toBe(false);
      expect(events.exitEmitted).toBe(true);
      expect(events.exitCode).not.toBe(0);
    });

    test("permanent error result then throw -> non-retriable exit routed to failure policy", async () => {
      const events = await runWithResultThenThrow({
        subtype: "error",
        is_error: true,
        result: "API Error: Your credit balance is too low to access the API.",
        duration_api_ms: 8000,
      });
      // Permanent, but still an SDK/API outcome: route through the exit path with
      // a non-retriable reason (not a fatal runner error that bypasses the policy).
      expect(events.errorEmitted).toBe(false);
      expect(events.exitEmitted).toBe(true);
      expect(events.exitCode).not.toBe(0);
      expect(
        (
          runner as unknown as {
            failureReason: { retriable: boolean } | undefined;
          }
        ).failureReason,
      ).toMatchObject({ retriable: false });
    });
  });

  describe("successResultReceived flag behavior", () => {
    test("should be false initially", async () => {
      const emptyLogPath = path.join(tempDir, "empty.jsonl");
      await fs.promises.writeFile(emptyLogPath, "");

      const codon = createTestCodon({
        id: "test-codon",
        name: "Test Codon",
        promptText: "Test prompt",
        model: "sonnet",
        continuationMode: "fresh",
      });

      runner = new CodonRunner({
        codon,
        codonId: "test-codon" as CodonId,
        executionPath: tempDir,
        agentRootPath: tempDir, // Use same path for tests
        logger,
        llmRegistry: mockLlmRegistry,
        runId: mockRunId,
        stateManager: mockStateManager,
        budget: createTestBudget(),
        logPath: emptyLogPath,
      });

      const successReceived = (runner as unknown as { successResultReceived: boolean })
        .successResultReceived;
      expect(successReceived).toBe(false);
    });

    test("should be set to true only for success subtype", async () => {
      // Create a log with success result - use same format as buggy-sequence.jsonl
      const successLogPath = path.join(tempDir, "success.jsonl");
      const successLog = `${[
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "test-session",
          model: "claude-sonnet-4-5",
          cwd: "/test",
          tools: ["Read"], // Must have at least one tool
          mcp_servers: [],
          permissionMode: "bypassPermissions",
          apiKeySource: "ANTHROPIC_API_KEY",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success", // This should trigger the flag
          is_error: false,
          result: "All done!",
          num_turns: 10,
          duration_ms: 5000,
          duration_api_ms: 4000, // Required by schema
        }),
      ].join("\n")}\n`; // Trailing newline like real log files
      await fs.promises.writeFile(successLogPath, successLog);

      const codon = createTestCodon({
        id: "test-codon",
        name: "Test Codon",
        promptText: "Test prompt",
        model: "sonnet",
        continuationMode: "fresh",
      });

      runner = new CodonRunner({
        codon,
        codonId: "test-codon" as CodonId,
        executionPath: tempDir,
        agentRootPath: tempDir, // Use same path for tests
        logger,
        llmRegistry: mockLlmRegistry,
        runId: mockRunId,
        stateManager: mockStateManager,
        budget: createTestBudget(),
        logPath: successLogPath,
        logParsingInterval: 50,
      });

      // Initially false
      let successReceived = (runner as unknown as { successResultReceived: boolean })
        .successResultReceived;
      expect(successReceived).toBe(false);

      // Start parsing
      const logParser = (runner as unknown as { logParser: { start: () => void } }).logParser;
      logParser.start();
      await new Promise((resolve) => setTimeout(resolve, 150));

      // After parsing success result, should be true
      successReceived = (runner as unknown as { successResultReceived: boolean })
        .successResultReceived;
      expect(successReceived).toBe(true);

      const logParserStop = (runner as unknown as { logParser: { stop: () => void } }).logParser;
      logParserStop.stop();
    });

    test("should NOT be set for disguised errors (subtype=success, is_error=true)", async () => {
      // The SDK reports transport failures as subtype="success" with is_error=true. Treating
      // those as success routed the SDK's thrown error through the
      // post-success suppression path, masking the real failure.
      const disguisedLogPath = path.join(tempDir, "disguised-error.jsonl");
      const disguisedLog = `${[
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "test-session",
          model: "claude-sonnet-4-5",
          cwd: "/test",
          tools: ["Read"],
          mcp_servers: [],
          permissionMode: "bypassPermissions",
          apiKeySource: "ANTHROPIC_API_KEY",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true, // Disguised error: success subtype, error flag set
          result: "API Error: The socket connection was closed unexpectedly.",
          num_turns: 1,
          duration_ms: 5000,
          duration_api_ms: 4000,
        }),
      ].join("\n")}\n`;
      await fs.promises.writeFile(disguisedLogPath, disguisedLog);

      const codon = createTestCodon({
        id: "test-codon",
        name: "Test Codon",
        promptText: "Test prompt",
        model: "sonnet",
        continuationMode: "fresh",
      });

      runner = new CodonRunner({
        codon,
        codonId: "test-codon" as CodonId,
        executionPath: tempDir,
        agentRootPath: tempDir, // Use same path for tests
        logger,
        llmRegistry: mockLlmRegistry,
        runId: mockRunId,
        stateManager: mockStateManager,
        budget: createTestBudget(),
        logPath: disguisedLogPath,
        logParsingInterval: 50,
      });

      const logParser = (
        runner as unknown as {
          logParser: { start: () => void; stop: () => void };
        }
      ).logParser;
      logParser.start();
      await new Promise((resolve) => setTimeout(resolve, 150));
      logParser.stop();

      // Disguised error must not count as success...
      const successReceived = (runner as unknown as { successResultReceived: boolean })
        .successResultReceived;
      expect(successReceived).toBe(false);

      // ...and must produce a retriable failure reason for the runtime.
      const failureReason = (
        runner as unknown as {
          failureReason: { type: string; retriable: boolean } | undefined;
        }
      ).failureReason;
      expect(failureReason).toMatchObject({
        type: "api-error",
        retriable: true,
      });
    });

    test("should reset successResultReceived between extensions", async () => {
      // Regression test: Ensures successResultReceived is properly reset between extensions.
      // Previously, this flag persisted across extensions, causing extension failures
      // to be masked as successes when SDK errors occurred.

      // Create a log with success result
      const successLogPath = path.join(tempDir, "success-with-extension.jsonl");
      const successLog = `${[
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "test-session",
          model: "claude-sonnet-4-5",
          cwd: "/test",
          tools: ["Read"],
          mcp_servers: [],
          permissionMode: "bypassPermissions",
          apiKeySource: "ANTHROPIC_API_KEY",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Initial run completed successfully",
          num_turns: 10,
          duration_ms: 5000,
          duration_api_ms: 4000,
        }),
      ].join("\n")}\n`;
      await fs.promises.writeFile(successLogPath, successLog);

      // Create test codon WITH extension config
      const codon = createTestCodon({
        id: "test-codon",
        name: "Test Codon",
        promptText: "Test prompt",
        model: "sonnet",
        continuationMode: "fresh",
        exhaustWithPrompt: "Continue with extension", // Enable extensions
      });

      runner = new CodonRunner({
        codon,
        codonId: "test-codon" as CodonId,
        executionPath: tempDir,
        agentRootPath: tempDir, // Use tempDir for both in tests
        logger,
        llmRegistry: mockLlmRegistry,
        runId: mockRunId,
        stateManager: mockStateManager,
        budget: createTestBudget(),
        logPath: successLogPath,
        logParsingInterval: 50,
        extensionConfig: {
          maxExtensions: 5,
          exhaustWithPrompt: "Continue with extension",
        },
        shouldInterrupt: () => false,
        onExtension: () => {
          // Extension callback - empty for this test
        },
      });

      // Start parsing to trigger success result
      const logParser = (runner as unknown as { logParser: { start: () => void } }).logParser;
      logParser.start();
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify: successResultReceived is true after initial success
      let successReceived = (runner as unknown as { successResultReceived: boolean })
        .successResultReceived;
      expect(successReceived).toBe(true);

      // Prevent real SDK spawn during this unit test
      // (performExtension -> runExtension -> spawn -> SDK query)
      (
        runner as unknown as {
          runExtension: (sessionId: SessionId, exhaustionPrompt: string) => Promise<void>;
        }
      ).runExtension = async () => {};

      // Now simulate triggering an extension by calling performExtension directly
      // In real scenarios, this happens when the process exits and shouldExtendCodon returns true
      const performExtension = (
        runner as unknown as {
          performExtension: (
            sessionId: string,
            extensionConfig: { exhaustWithPrompt: string },
            onExtension: () => void,
            previousExitCode: number,
            wasContextExceeded: boolean,
          ) => Promise<void>;
        }
      ).performExtension;

      await performExtension.call(
        runner,
        SessionId("test-session"),
        { exhaustWithPrompt: "Continue with extension" },
        () => {},
        0, // previousExitCode
        false, // wasContextExceeded
      );

      // After performExtension resets per-extension state,
      // successResultReceived should be false (ready for the next extension's success tracking)
      successReceived = (runner as unknown as { successResultReceived: boolean })
        .successResultReceived;

      // Verify the flag was properly reset
      expect(successReceived).toBe(false);

      const logParserStop = (runner as unknown as { logParser: { stop: () => void } }).logParser;
      logParserStop.stop();
    });
  });
});
