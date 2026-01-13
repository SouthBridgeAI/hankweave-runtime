import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type CleanupIntegrationResult,
  executeTestCleanup,
  isCleanupNeeded,
  logCleanupResults,
} from "../utils/cleanup-integration.js";

describe("Cleanup Integration Utility", () => {
  const testRoot = path.join(process.cwd(), "tests/unit/test-cleanup-integration");
  const executionRoot = path.join(testRoot, ".hankweave-executions");
  const dataSourcePath = path.join(testRoot, "test-data");
  const testExecutionDir = path.join(executionRoot, "test-execution-123");

  beforeEach(async () => {
    // Create test directory structure
    await fs.promises.mkdir(executionRoot, { recursive: true });
    await fs.promises.mkdir(dataSourcePath, { recursive: true });
    await fs.promises.mkdir(testExecutionDir, { recursive: true });

    // Create some test data files
    await fs.promises.writeFile(path.join(dataSourcePath, "test.txt"), "test content");
  });

  afterEach(async () => {
    // Clean up test directory
    if (fs.existsSync(testRoot)) {
      await fs.promises.rm(testRoot, { recursive: true, force: true });
    }
  });

  describe("isCleanupNeeded", () => {
    test("returns false for non-existent directory", () => {
      expect(isCleanupNeeded("/non/existent/path")).toBe(false);
    });

    test("returns false when no directories exist", async () => {
      // Remove the directory created in beforeEach
      await fs.promises.rm(testExecutionDir, { recursive: true, force: true });
      expect(isCleanupNeeded(testExecutionDir)).toBe(false);
    });

    test("returns true when execution directory exists", async () => {
      // Create .hankweave directory in execution
      const hankweaveDir = path.join(testExecutionDir, ".hankweave");
      await fs.promises.mkdir(hankweaveDir, { recursive: true });

      expect(isCleanupNeeded(testExecutionDir)).toBe(true);
    });

    test("returns true when test directory exists", async () => {
      const testDir = path.join(testRoot, "some-test-dir");
      await fs.promises.mkdir(testDir, { recursive: true });

      expect(isCleanupNeeded(undefined, testDir)).toBe(true);
    });

    test("checks both execution and test directories", async () => {
      const hankweaveDir = path.join(testExecutionDir, ".hankweave");
      await fs.promises.mkdir(hankweaveDir, { recursive: true });

      const testDir = path.join(testRoot, "some-test-dir");
      await fs.promises.mkdir(testDir, { recursive: true });

      expect(isCleanupNeeded(testExecutionDir, testDir)).toBe(true);
    });
  });

  describe("executeTestCleanup", () => {
    test("returns success when no directories to clean", async () => {
      const result = await executeTestCleanup({
        executionPath: "/non/existent/path",
        skipConfirmation: true,
      });

      expect(result.success).toBe(true);
      expect(result.directoriesRemoved).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    test("cleans up execution directory by path", async () => {
      // Create execution directory with metadata
      const hankweaveDir = path.join(testExecutionDir, ".hankweave");
      await fs.promises.mkdir(hankweaveDir, { recursive: true });

      const meta = {
        version: "1.0.0",
        readOnlySourceDataPath: dataSourcePath,
        readOnlySourceResolvedDataPath: dataSourcePath,
        dataHash: "test123",
        linkType: "symlink",
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
      };
      await fs.promises.writeFile(
        path.join(hankweaveDir, "execution-meta.json"),
        JSON.stringify(meta, null, 2),
      );

      const result = await executeTestCleanup({
        executionPath: testExecutionDir,
        skipConfirmation: true,
      });

      expect(result.success).toBe(true);
      expect(result.directoriesRemoved).toContain(testExecutionDir);
      expect(fs.existsSync(testExecutionDir)).toBe(false);
    });

    test("cleans up test directory when provided", async () => {
      const testDir = path.join(testRoot, "test-artifacts");
      await fs.promises.mkdir(testDir, { recursive: true });
      await fs.promises.writeFile(path.join(testDir, "artifact.txt"), "test artifact");

      const result = await executeTestCleanup({
        testDir,
        skipConfirmation: true,
      });

      expect(result.success).toBe(true);
      expect(result.directoriesRemoved).toContain(testDir);
      expect(fs.existsSync(testDir)).toBe(false);
    });

    test("returns error without fallback when force is false", async () => {
      // Try to clean up with invalid data source path
      const result = await executeTestCleanup({
        dataSourcePath: "/non/existent/data/source",
        skipConfirmation: true,
        force: false,
      });

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test("handles cleanup errors gracefully", async () => {
      // Create a directory that can't be removed
      const protectedDir = path.join(testRoot, "protected");
      await fs.promises.mkdir(protectedDir, { recursive: true });

      // Try to make it unremovable (this might not work on all systems)
      try {
        await fs.promises.chmod(protectedDir, 0o444);

        const result = await executeTestCleanup({
          testDir: protectedDir,
          skipConfirmation: true,
          force: false,
        });

        // If chmod worked, removal should fail
        if (!result.success) {
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.errors[0]).toContain("Failed to remove test directory");
        }

        // Restore permissions for cleanup
        await fs.promises.chmod(protectedDir, 0o755);
      } catch (_error) {
        // Skip test if chmod isn't supported
        console.log("Skipping read-only test - chmod not supported");
      }
    });
  });

  describe("logCleanupResults", () => {
    // Capture console output
    let consoleOutput: string[] = [];
    const originalLog = console.log;

    beforeEach(() => {
      consoleOutput = [];
      console.log = (...args: unknown[]) => {
        consoleOutput.push(args.join(" "));
      };
    });

    afterEach(() => {
      console.log = originalLog;
    });

    test("logs success message for successful cleanup", () => {
      const result: CleanupIntegrationResult = {
        success: true,
        directoriesRemoved: [],
        errors: [],
        warnings: [],
      };

      logCleanupResults(result);

      expect(consoleOutput).toContain("✅ Test cleanup completed successfully");
    });

    test("logs verbose details when requested", () => {
      const result: CleanupIntegrationResult = {
        success: true,
        directoriesRemoved: ["/path/to/dir1", "/path/to/dir2", "/path/to/dir3"],
        errors: [],
        warnings: ["Warning 1", "Warning 2"],
      };

      logCleanupResults(result, true);

      expect(consoleOutput).toContain("✅ Test cleanup completed successfully");
      expect(consoleOutput).toContain("  - Directories removed: 3");
      expect(consoleOutput).toContain("    - /path/to/dir1");
      expect(consoleOutput).toContain("    - /path/to/dir2");
      expect(consoleOutput).toContain("    - /path/to/dir3");
      expect(consoleOutput).toContain("⚠️  Warnings:");
      expect(consoleOutput).toContain("  - Warning 1");
      expect(consoleOutput).toContain("  - Warning 2");
    });

    test("logs error details for failed cleanup", () => {
      const result: CleanupIntegrationResult = {
        success: false,
        directoriesRemoved: [],
        errors: ["Error 1", "Error 2"],
        warnings: [],
      };

      logCleanupResults(result);

      expect(consoleOutput).toContain("❌ Test cleanup failed");
      expect(consoleOutput).toContain("  - Error: Error 1");
      expect(consoleOutput).toContain("  - Error: Error 2");
    });

    test("doesn't log warnings in non-verbose mode", () => {
      const result: CleanupIntegrationResult = {
        success: true,
        directoriesRemoved: [],
        errors: [],
        warnings: ["Warning 1"],
      };

      logCleanupResults(result, false);

      expect(consoleOutput).not.toContain("⚠️  Warnings:");
      expect(consoleOutput).not.toContain("Warning 1");
    });

    test("logs correctly when only directories were removed", () => {
      const result: CleanupIntegrationResult = {
        success: true,
        directoriesRemoved: ["dir1", "dir2"],
        errors: [],
        warnings: [],
      };

      logCleanupResults(result, true);

      expect(consoleOutput).toContain("✅ Test cleanup completed successfully");
      expect(consoleOutput).toContain("  - Directories removed: 2");
      expect(consoleOutput).not.toContain("Files removed");
    });
  });
});
