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
    test("should emit error when no success result was received", async () => {
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
      let errorMessage: string | undefined;

      runner.on("exit", () => {
        exitEmitted = true;
      });

      runner.on("error", (error) => {
        errorEmitted = true;
        errorMessage = error.message;
      });

      // No log parsing needed - just trigger error directly
      // successResultReceived should be false
      const successReceived = (runner as unknown as { successResultReceived: boolean })
        .successResultReceived;
      expect(successReceived).toBe(false);

      // Simulate SDK error without prior success
      const processManager = (
        runner as unknown as {
          processManager: { emit: (event: string, error: Error) => void };
        }
      ).processManager;
      processManager.emit("error", new Error("Real SDK error - no success"));

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify: error propagated, no exit
      expect(errorEmitted).toBe(true);
      expect(errorMessage).toBe("Real SDK error - no success");
      expect(exitEmitted).toBe(false);
    });
  });

  describe("with error result only (conversation failed)", () => {
    test("should emit error when conversation failed before SDK error", async () => {
      // Create a log with only error result (conversation failed)
      const failedLogPath = path.join(tempDir, "failed.jsonl");
      const failedLog = `${[
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
          subtype: "error", // NOT "success"
          is_error: true,
          result: "Conversation failed due to some reason",
          num_turns: 5,
          duration_ms: 10000,
          duration_api_ms: 8000, // Required by schema
        }),
      ].join("\n")}\n`; // Trailing newline like real log files
      await fs.promises.writeFile(failedLogPath, failedLog);

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
        logPath: failedLogPath,
        logParsingInterval: 50,
      });

      let exitEmitted = false;
      let errorEmitted = false;

      runner.on("exit", () => {
        exitEmitted = true;
      });

      runner.on("error", () => {
        errorEmitted = true;
      });

      // Start parsing
      const logParser = (runner as unknown as { logParser: { start: () => void } }).logParser;
      logParser.start();
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Error result should NOT set successResultReceived
      const successReceived = (runner as unknown as { successResultReceived: boolean })
        .successResultReceived;
      expect(successReceived).toBe(false);

      // Simulate SDK error after failed conversation
      const processManager = (
        runner as unknown as {
          processManager: { emit: (event: string, error: Error) => void };
        }
      ).processManager;
      processManager.emit("error", new Error("SDK cleanup error"));

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify: error propagated (conversation actually failed)
      expect(errorEmitted).toBe(true);
      expect(exitEmitted).toBe(false);

      const logParserStop = (runner as unknown as { logParser: { stop: () => void } }).logParser;
      logParserStop.stop();
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
