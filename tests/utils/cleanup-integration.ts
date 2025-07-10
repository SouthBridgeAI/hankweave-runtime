import { CleanupCommand } from "../../server/cleanup-command.js";
import * as path from "path";
import * as fs from "fs";

/**
 * Options for the cleanup integration
 */
export interface CleanupIntegrationOptions {
  /** Path to the test directory */
  testDir: string;
  /** Path to the phases configuration */
  phasesConfig: string;
  /** Whether to skip confirmation (always true for tests) */
  skipConfirmation?: boolean;
  /**
   * Whether to run cleanup even if it might fail.
   * When true, if the CleanupCommand fails, we'll fall back to manual cleanup
   * of just the .langton directory. This is useful when:
   * - Git operations might fail due to repository state
   * - The test directory is in an inconsistent state
   * - You need cleanup to succeed for test isolation
   */
  force?: boolean;
}

/**
 * Result of the cleanup operation
 */
export interface CleanupIntegrationResult {
  success: boolean;
  filesRemoved: string[];
  directoriesRemoved: string[];
  errors: string[];
  warnings: string[];
}

/**
 * Executes cleanup for a test directory using the cleanup command.
 *
 * This is the primary integration point for test cleanup. It:
 * 1. Validates the test directory and config exist
 * 2. Runs the full CleanupCommand (including git reset, file removal, etc.)
 * 3. Falls back to manual cleanup if force=true and CleanupCommand fails
 *
 * ## Best Practices for Test Integration:
 *
 * 1. **Always run in afterAll()**: Ensures cleanup happens even if tests fail
 *    ```typescript
 *    afterAll(async () => {
 *      await executeTestCleanup({ testDir, phasesConfig, force: true });
 *    });
 *    ```
 *
 * 2. **Use force mode for e2e tests**: E2e tests can leave the repository in
 *    inconsistent states, so force mode ensures cleanup always succeeds
 *
 * 3. **Capture data before cleanup**: If tests need to verify git state or files,
 *    capture that data before cleanup runs (see checkpoint validation pattern)
 *
 * 4. **Use isolated test directories**: Each test should use its own subdirectory
 *    to prevent conflicts when running tests in parallel
 *
 * @param options Cleanup configuration options
 * @returns Result object with success status and details of what was cleaned
 */
export async function executeTestCleanup(
  options: CleanupIntegrationOptions
): Promise<CleanupIntegrationResult> {
  const {
    testDir,
    phasesConfig,
    skipConfirmation = true,
    force = false,
  } = options;

  // Check if the test directory exists
  if (!fs.existsSync(testDir)) {
    return {
      success: false,
      filesRemoved: [],
      directoriesRemoved: [],
      errors: [`Test directory does not exist: ${testDir}`],
      warnings: [],
    };
  }

  // Check if phases config exists
  if (!fs.existsSync(phasesConfig)) {
    return {
      success: false,
      filesRemoved: [],
      directoriesRemoved: [],
      errors: [`Phases configuration does not exist: ${phasesConfig}`],
      warnings: [],
    };
  }

  try {
    // Create cleanup command
    const cleanup = new CleanupCommand({
      configPath: phasesConfig,
      projectPath: testDir,
      skipConfirmation,
    });

    // Execute cleanup
    const result = await cleanup.execute();

    // Check if cleanup failed and force mode is enabled
    if (!result.success && force) {
      // Try manual cleanup as fallback
      const errorMessage = result.errors.join("; ");
      return await forceManualCleanup(testDir, errorMessage);
    }

    // Return standardized result
    return {
      success: result.success,
      filesRemoved: result.filesRemoved,
      directoriesRemoved: result.directoriesRemoved,
      errors: result.errors,
      warnings: result.warnings,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (force) {
      // If force is true, we'll try manual cleanup
      return await forceManualCleanup(testDir, errorMessage);
    }

    return {
      success: false,
      filesRemoved: [],
      directoriesRemoved: [],
      errors: [`Cleanup command failed: ${errorMessage}`],
      warnings: [],
    };
  }
}

/**
 * Performs manual cleanup when the cleanup command fails.
 *
 * This is a fallback mechanism that only removes the .langton directory.
 * It's used when:
 * - The main CleanupCommand fails (e.g., git operations fail)
 * - The force option is set to true
 * - Test isolation is more important than perfect cleanup
 *
 * ## What it does:
 * - Removes only the .langton directory (logs, checkpoints, lock file)
 * - Does NOT remove copied directories or reset git
 * - Reports the original error as a warning
 *
 * ## When to use:
 * - E2E tests that might corrupt git state
 * - Tests that are interrupted mid-execution
 * - CI environments where cleanup must succeed
 *
 * @param testDir The test directory to clean
 * @param originalError The error message from the failed CleanupCommand
 * @returns Cleanup result with warnings about the fallback
 */
async function forceManualCleanup(
  testDir: string,
  originalError: string
): Promise<CleanupIntegrationResult> {
  const warnings: string[] = [
    `Cleanup command failed: ${originalError}`,
    "Performing manual cleanup of .langton directory only",
  ];
  const filesRemoved: string[] = [];
  const directoriesRemoved: string[] = [];
  const errors: string[] = [];

  // Try to remove .langton directory manually
  const langtonDir = path.join(testDir, ".langton");
  if (fs.existsSync(langtonDir)) {
    try {
      await fs.promises.rm(langtonDir, { recursive: true, force: true });
      directoriesRemoved.push(".langton");
    } catch (error) {
      errors.push(`Failed to manually remove .langton: ${error}`);
    }
  }

  return {
    success: errors.length === 0,
    filesRemoved,
    directoriesRemoved,
    errors,
    warnings,
  };
}

/**
 * Checks if cleanup is needed for a test directory.
 *
 * This is useful for:
 * - Conditional cleanup (only clean if needed)
 * - Pre-test validation (ensure clean state)
 * - Debugging (check what artifacts remain)
 *
 * @param testDir The test directory to check
 * @returns true if any test artifacts are found
 */
export function isCleanupNeeded(testDir: string): boolean {
  if (!fs.existsSync(testDir)) {
    return false;
  }

  // Check for .langton directory
  const langtonDir = path.join(testDir, ".langton");
  if (fs.existsSync(langtonDir)) {
    return true;
  }

  // Check for any other common test artifacts
  const testArtifacts = ["notes", "typescript_code", "output"];
  for (const artifact of testArtifacts) {
    if (fs.existsSync(path.join(testDir, artifact))) {
      return true;
    }
  }

  return false;
}

/**
 * Logs cleanup results in a test-friendly format.
 *
 * Use this in test teardown to provide feedback about cleanup success.
 * In CI, use verbose=true to help debug cleanup issues.
 *
 * @param result The cleanup result to log
 * @param verbose Whether to include detailed information
 */
export function logCleanupResults(
  result: CleanupIntegrationResult,
  verbose = false
): void {
  if (result.success) {
    console.log("✅ Test cleanup completed successfully");
    if (verbose) {
      if (result.filesRemoved.length > 0) {
        console.log(`  - Files removed: ${result.filesRemoved.length}`);
      }
      if (result.directoriesRemoved.length > 0) {
        console.log(
          `  - Directories removed: ${result.directoriesRemoved.length}`
        );
      }
    }
  } else {
    console.log("❌ Test cleanup failed");
    for (const error of result.errors) {
      console.log(`  - Error: ${error}`);
    }
  }

  if (result.warnings.length > 0 && verbose) {
    console.log("⚠️  Warnings:");
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }
}
