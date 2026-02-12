import type { ShimConfig, TestResult, TestDefinition } from "../types.js";
import { runShimWithEmptyStdin } from "../shim.js";
import { WorkspaceManager } from "../workspace.js";
import { assert, assertEqual, AssertionError } from "../utils/assertions.js";
import { getLogger } from "../logger.js";

/**
 * TEST: Empty Prompt Handling
 * Verifies empty stdin exits cleanly with no output.
 * Per spec: If empty after trimming, exit silently with code 0 (no output).
 */
async function runEmptyPrompt(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "empty-prompt";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShimWithEmptyStdin(config, 10000);

    // Exit code should be 0 (clean exit)
    assertEqual(result.exitCode, 0, "Exit code should be 0 for empty prompt", {
      actual: result.exitCode,
    });

    // stdout should be EMPTY (no JSONL)
    assertEqual(result.stdout.trim(), "", "stdout should be empty for empty prompt", {
      actual: result.stdout,
    });

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: result.stdout,
        stderr: result.stderr,
        workspace: "",
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
        workspace: "",
      },
    };
  }
}

// Export test definitions
// Note: Removed "missing-p-flag" test since -p is now optional per spec
export const errorTests: TestDefinition[] = [
  {
    name: "empty-prompt",
    category: "errors",
    priority: "P1",
    run: async (config, workspace) => runEmptyPrompt(config, workspace as WorkspaceManager),
  },
];

export { runEmptyPrompt };
