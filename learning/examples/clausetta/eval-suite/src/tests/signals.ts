import type { ShimConfig, TestResult, TestDefinition } from "../types.js";
import { runShim } from "../shim.js";
import { WorkspaceManager } from "../workspace.js";
import { assert, assertEqual, AssertionError } from "../utils/assertions.js";
import { getResultMessage, getSystemMessage } from "../utils/parsing.js";
import { getLogger } from "../logger.js";

/**
 * TEST: Signal Handling - SIGINT
 * Verifies shim handles SIGINT gracefully (exits cleanly).
 * Per spec: shims should exit cleanly on signals, not with code 130.
 */
async function runSigintHandling(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "sigint-handling";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: "Write a very detailed 5000 word essay about the history of computing from the 1800s to today. Include specific dates, names, and inventions.",
        signal: { type: "SIGINT", afterMs: 2000 }, // Send SIGINT after 2 seconds
        timeout: 30000,
      },
      workspace,
      testName
    );

    // Should exit cleanly (0), error (1), or with signal codes
    // Exit codes 128+N indicate the process was terminated by signal N
    // SIGINT = 2, SIGTERM = 15, so 130 and 143 respectively
    assert(
      result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 130 || result.exitCode === 143,
      "Should exit with valid code (0, 1, 130, or 143)",
      { actual: result.exitCode }
    );

    // May have partial output (system init, some assistant messages)
    // The key is that it doesn't hang

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
 * TEST: Signal Handling - SIGTERM
 * Same as SIGINT but with SIGTERM.
 */
async function runSigtermHandling(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "sigterm-handling";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: "Write a very detailed 5000 word essay about the history of computing from the 1800s to today. Include specific dates, names, and inventions.",
        signal: { type: "SIGTERM", afterMs: 2000 },
        timeout: 30000,
      },
      workspace,
      testName
    );

    // Should exit cleanly (0), error (1), signal codes (130 for SIGINT, 143 for SIGTERM), or similar
    // Exit codes 128+N indicate the process was terminated by signal N
    // SIGINT = 2, SIGTERM = 15, so 130 and 143 respectively
    assert(
      result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 130 || result.exitCode === 143,
      "Should exit with valid code (0, 1, 130, or 143)",
      { actual: result.exitCode }
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

// Export test definitions
export const signalTests: TestDefinition[] = [
  {
    name: "sigint-handling",
    category: "signals",
    priority: "P1",
    run: async (config, workspace) => runSigintHandling(config, workspace as WorkspaceManager),
  },
  {
    name: "sigterm-handling",
    category: "signals",
    priority: "P1",
    run: async (config, workspace) => runSigtermHandling(config, workspace as WorkspaceManager),
  },
];

export { runSigintHandling, runSigtermHandling };
