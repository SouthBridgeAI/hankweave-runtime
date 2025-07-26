import { CleanupCommand } from "../../server/cleanup-command.js";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Options for the cleanup integration
 */
export interface CleanupIntegrationOptions {
  /** Path to the execution directory to clean up */
  executionPath?: string;
  /** Path to the data source directory (to find executions by hash) */
  dataSourcePath?: string;
  /** Path to any temporary test directory to remove */
  testDir?: string;
  /** Whether to skip confirmation (always true for tests) */
  skipConfirmation?: boolean;
  /**
   * Whether to run cleanup even if it might fail.
   * When true, if the CleanupCommand fails, we'll fall back to manual cleanup.
   * This is useful when:
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
  directoriesRemoved: string[];
  errors: string[];
  warnings: string[];
}

/**
 * Executes cleanup for a test using the new execution isolation design.
 *
 * This is the primary integration point for test cleanup. It:
 * 1. Runs the CleanupCommand to remove execution directories
 * 2. Optionally removes temporary test directories
 * 3. Falls back to manual cleanup if force=true and CleanupCommand fails
 *
 * ## Best Practices for Test Integration:
 *
 * 1. **Always run in afterAll()**: Ensures cleanup happens even if tests fail
 *    ```typescript
 *    afterAll(async () => {
 *      await executeTestCleanup({ executionPath, force: true });
 *    });
 *    ```
 *
 * 2. **Use force mode for e2e tests**: E2e tests can leave directories in
 *    inconsistent states, so force mode ensures cleanup always succeeds
 *
 * 3. **Capture data before cleanup**: If tests need to verify state,
 *    capture that data before cleanup runs
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
    executionPath,
    dataSourcePath,
    testDir,
    skipConfirmation = true,
    force = false,
  } = options;

  const directoriesRemoved: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // Run cleanup command if we have execution or data source path
  if (executionPath || dataSourcePath) {
    try {
      // Create cleanup command
      const cleanup = new CleanupCommand({
        executionPath,
        dataSourcePath,
        skipConfirmation,
      });

      // Execute cleanup
      const result = await cleanup.execute();

      // Add results
      directoriesRemoved.push(...result.directoriesRemoved);
      errors.push(...result.errors);
      warnings.push(...result.warnings);

      // Check if cleanup failed and force mode is enabled
      if (!result.success && force) {
        // Try manual cleanup as fallback
        const manualResult = await forceManualCleanup(executionPath, dataSourcePath);
        directoriesRemoved.push(...manualResult.directoriesRemoved);
        errors.push(...manualResult.errors);
        warnings.push(...manualResult.warnings);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`Cleanup command failed: ${errorMessage}`);

      if (force) {
        // If force is true, we'll try manual cleanup
        const manualResult = await forceManualCleanup(executionPath, dataSourcePath);
        directoriesRemoved.push(...manualResult.directoriesRemoved);
        errors.push(...manualResult.errors);
        warnings.push(...manualResult.warnings);
      }
    }
  }

  // Clean up test directory if provided
  if (testDir && fs.existsSync(testDir)) {
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
      directoriesRemoved.push(testDir);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (force) {
        warnings.push(`Failed to remove test directory: ${errorMessage}`);
      } else {
        errors.push(`Failed to remove test directory: ${errorMessage}`);
      }
    }
  }

  return {
    success: errors.length === 0,
    directoriesRemoved,
    errors,
    warnings,
  };
}

/**
 * Performs manual cleanup when the cleanup command fails.
 *
 * This is a fallback mechanism that directly removes directories.
 * It's used when:
 * - The main CleanupCommand fails
 * - The force option is set to true
 * - Test isolation is more important than perfect cleanup
 *
 * @param executionPath The execution directory to clean
 * @param dataSourcePath The data source path (for finding executions)
 * @returns Cleanup result
 */
async function forceManualCleanup(
  executionPath?: string,
  dataSourcePath?: string
): Promise<CleanupIntegrationResult> {
  const warnings: string[] = [
    "Performing manual cleanup due to CleanupCommand failure",
  ];
  const directoriesRemoved: string[] = [];
  const errors: string[] = [];

  // Try to remove execution directory directly
  if (executionPath && fs.existsSync(executionPath)) {
    try {
      await fs.promises.rm(executionPath, { recursive: true, force: true });
      directoriesRemoved.push(executionPath);
    } catch (error) {
      errors.push(`Failed to manually remove execution directory: ${error}`);
    }
  }

  // If we have a data source path, try to find and remove execution directories
  if (dataSourcePath && !executionPath) {
    try {
      // Import data hasher functions
      const { hashDataDirectory, findExecutionDirs } = await import("../../server/data-hasher.js");

      // Calculate hash and find directories
      const dataHash = await hashDataDirectory(dataSourcePath);
      const execDirs = await findExecutionDirs(dataHash);

      // Remove latest execution directory
      if (execDirs.length > 0) {
        const latestDir = execDirs[0];
        try {
          await fs.promises.rm(latestDir, { recursive: true, force: true });
          directoriesRemoved.push(latestDir);
        } catch (error) {
          errors.push(`Failed to remove execution directory ${latestDir}: ${error}`);
        }
      }
    } catch (error) {
      errors.push(`Failed to find execution directories: ${error}`);
    }
  }

  return {
    success: errors.length === 0,
    directoriesRemoved,
    errors,
    warnings,
  };
}

/**
 * Checks if cleanup is needed for a test.
 *
 * This is useful for:
 * - Conditional cleanup (only clean if needed)
 * - Pre-test validation (ensure clean state)
 * - Debugging (check what artifacts remain)
 *
 * @param executionPath The execution directory to check
 * @param testDir Optional test directory to check
 * @returns true if any test artifacts are found
 */
export function isCleanupNeeded(executionPath?: string, testDir?: string): boolean {
  // Check execution directory
  if (executionPath && fs.existsSync(executionPath)) {
    return true;
  }

  // Check test directory
  if (testDir && fs.existsSync(testDir)) {
    return true;
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
      if (result.directoriesRemoved.length > 0) {
        console.log(
          `  - Directories removed: ${result.directoriesRemoved.length}`
        );
        if (verbose) {
          for (const dir of result.directoriesRemoved) {
            console.log(`    - ${dir}`);
          }
        }
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
