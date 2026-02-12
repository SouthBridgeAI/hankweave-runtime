import type { ShimConfig, TestResult, TestDefinition } from "../types.js";
import { runShim, runShimSimple } from "../shim.js";
import { WorkspaceManager } from "../workspace.js";
import { assert, assertEqual, assertContains, assertDefined, AssertionError } from "../utils/assertions.js";
import { getSystemMessage, getResultMessage, getAllAssistantText, parseJsonl } from "../utils/parsing.js";
import { getLogger } from "../logger.js";

/**
 * TEST: Session Resume - Invalid Session
 * Verifies graceful error when resuming non-existent session.
 * Per spec: Print error to stderr, exit 1 (no JSONL required).
 */
async function runInvalidSessionResume(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "invalid-session-resume";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: "Hello",
        args: ["--resume", "00000000-0000-0000-0000-000000000000"],
        timeout: 30000,
      },
      workspace,
      testName
    );

    // Exit code should be 1 (error)
    assertEqual(result.exitCode, 1, "Exit code should be 1 for invalid session", {
      actual: result.exitCode,
    });

    // stderr should mention session not found or similar
    assert(
      result.stderr.toLowerCase().includes("session") ||
        result.stderr.toLowerCase().includes("conversation") ||
        result.stderr.toLowerCase().includes("not found"),
      "stderr should mention session/conversation not found",
      { stderr: result.stderr }
    );

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: result.stdout,
        stderr: result.stderr,
        workspace: result.workspace,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as AssertionError;
    logger.testFail(testName, duration, err.message);

    return {
      name: testName,
      passed: false,
      duration,
      error: err instanceof AssertionError ? err.toTestError() : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Session Resume - Valid Session
 * Verifies session continuation actually maintains context.
 * Per spec: When resuming, use the same session ID (reused, not new).
 */
async function runValidSessionResume(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "valid-session-resume";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    // Create a shared workspace for both runs (so session files are shared)
    const sharedWorkspace = await workspace.createTestWorkspace(testName);

    // First run: establish context
    const firstResult = await runShim(
      config,
      {
        prompt: "Remember the secret code: PURPLE_ELEPHANT_42. Just acknowledge you've remembered it.",
        timeout: 60000,
        cwd: sharedWorkspace, // Use shared workspace
      },
      workspace,
      `${testName}-first`
    );

    assertEqual(firstResult.exitCode, 0, "First run should succeed");

    const firstResultMsg = getResultMessage(firstResult.messages);
    assertDefined(firstResultMsg, "First run should have result message");

    // Get session ID from first run
    const firstSessionId = firstResultMsg.session_id;
    assertDefined(firstSessionId, "First run should have session_id in result");

    logger.debug(`First session ID: ${firstSessionId}`);

    // Second run: continue session (same cwd so session is found)
    const secondResult = await runShim(
      config,
      {
        prompt: "What was the secret code I told you earlier?",
        args: ["--resume", firstSessionId],
        timeout: 60000,
        cwd: sharedWorkspace, // Use same workspace
      },
      workspace,
      `${testName}-second`
    );

    assertEqual(secondResult.exitCode, 0, "Second run should succeed", {
      stderr: secondResult.stderr.slice(0, 500),
    });

    // Response should contain the secret code
    const assistantText = getAllAssistantText(secondResult.messages);
    assertContains(
      assistantText,
      "PURPLE_ELEPHANT_42",
      "Agent should remember the secret code from previous session"
    );

    // Verify system init exists
    const secondSystemMsg = getSystemMessage(secondResult.messages);
    assertDefined(secondSystemMsg, "Second run should have system init");

    // Per spec: When resuming, use the SAME session ID (reused)
    const secondSessionId = secondSystemMsg.session_id;
    assertEqual(
      secondSessionId,
      firstSessionId,
      "Second run should reuse the same session_id when resuming",
      {
        firstSessionId,
        secondSessionId,
      }
    );

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: firstResult.stdout + "\n---SECOND RUN---\n" + secondResult.stdout,
        stderr: firstResult.stderr + "\n---SECOND RUN---\n" + secondResult.stderr,
        workspace: workspace.getTestDir(testName),
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as AssertionError;
    logger.testFail(testName, duration, err.message);

    return {
      name: testName,
      passed: false,
      duration,
      error: err instanceof AssertionError ? err.toTestError() : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

// Export test definitions
export const sessionTests: TestDefinition[] = [
  {
    name: "invalid-session-resume",
    category: "sessions",
    priority: "P2",
    run: async (config, workspace) => {
      return runInvalidSessionResume(config, workspace as WorkspaceManager);
    },
  },
  {
    name: "valid-session-resume",
    category: "sessions",
    priority: "P2",
    run: async (config, workspace) => {
      return runValidSessionResume(config, workspace as WorkspaceManager);
    },
  },
];

export { runInvalidSessionResume, runValidSessionResume };
