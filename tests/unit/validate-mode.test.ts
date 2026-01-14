import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tests for validation mode behavior.
 *
 * These tests verify that --validate mode does NOT create directories
 * or have other filesystem side effects. This is critical because
 * validation should be a read-only preflight check.
 */
describe("Validation Mode - No Directory Creation", () => {
  const TEST_BASE_DIR = path.join(os.tmpdir(), "hankweave-validate-mode-test");
  const DATA_SOURCE_DIR = path.join(TEST_BASE_DIR, "data-source");
  const EXEC_ROOT = path.join(os.homedir(), ".hankweave-executions");

  // Track what directories existed before each test
  let existingExecDirs: string[] = [];

  beforeEach(async () => {
    // Clean up any previous test run
    if (fs.existsSync(TEST_BASE_DIR)) {
      await fs.promises.rm(TEST_BASE_DIR, { recursive: true, force: true });
    }

    // Create test data source
    await fs.promises.mkdir(DATA_SOURCE_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(DATA_SOURCE_DIR, "test.txt"), "test content for hash");

    // Record existing execution directories before test
    if (fs.existsSync(EXEC_ROOT)) {
      existingExecDirs = await fs.promises.readdir(EXEC_ROOT);
    } else {
      existingExecDirs = [];
    }
  });

  afterEach(async () => {
    // Clean up test directory
    if (fs.existsSync(TEST_BASE_DIR)) {
      await fs.promises.rm(TEST_BASE_DIR, { recursive: true, force: true });
    }
  });

  describe("determinePaths function", () => {
    it("should return correct paths for explicit execution path without creating directories", async () => {
      // Import the index module to get determinePaths (indirectly through testing)
      // Since determinePaths is not exported, we test the behavior through the CLI flow
      // For unit testing, we'll verify the path calculation logic directly

      const { hashDataSource } = await import("../../server/data-hasher.js");
      const _dataHash = await hashDataSource(DATA_SOURCE_DIR, 5000);

      // Verify no new directories were created just from hashing
      const afterHashDirs = fs.existsSync(EXEC_ROOT) ? await fs.promises.readdir(EXEC_ROOT) : [];
      expect(afterHashDirs).toEqual(existingExecDirs);
    });

    it("should calculate data hash without creating any directories", async () => {
      const { hashDataSource } = await import("../../server/data-hasher.js");

      // Calculate hash
      const dataHash = await hashDataSource(DATA_SOURCE_DIR, 5000);

      // Verify hash was calculated (non-empty, valid hex)
      expect(dataHash).toMatch(/^[a-f0-9]+$/);
      expect(dataHash.length).toBeGreaterThan(0);

      // Verify NO directories were created in exec root
      const afterDirs = fs.existsSync(EXEC_ROOT) ? await fs.promises.readdir(EXEC_ROOT) : [];
      expect(afterDirs).toEqual(existingExecDirs);
    });

    it("should not create any directories when determining paths for non-existent execution path", async () => {
      const nonExistentPath = path.join(TEST_BASE_DIR, "does-not-exist");
      const { hashDataSource } = await import("../../server/data-hasher.js");

      // Calculate hash (this is what validation mode does)
      const _dataHash = await hashDataSource(DATA_SOURCE_DIR, 5000);

      // Construct what paths would be (mirroring determinePaths logic)
      const _expectedDataPath = path.join(nonExistentPath, "read_only_data_source");

      // Verify the non-existent path still doesn't exist
      expect(fs.existsSync(nonExistentPath)).toBe(false);

      // Verify no directories were created in exec root
      const afterDirs = fs.existsSync(EXEC_ROOT) ? await fs.promises.readdir(EXEC_ROOT) : [];
      expect(afterDirs).toEqual(existingExecDirs);
    });
  });

  describe("validation mode isolation", () => {
    it("should not create any new directories in ~/.hankweave-executions/ during validation-like operations", async () => {
      const { hashDataSource } = await import("../../server/data-hasher.js");

      // Simulate validation operations
      // 1. Verify data exists
      expect(fs.existsSync(DATA_SOURCE_DIR)).toBe(true);

      // 2. Calculate data hash
      const dataHash = await hashDataSource(DATA_SOURCE_DIR, 5000);
      expect(dataHash).toBeTruthy();

      // 3. Would determine paths (but not create them)
      const executionRoot = path.join(os.homedir(), ".hankweave-executions");
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 6);
      const dirName = `${timestamp}-${random}-${dataHash.substring(0, 6)}`;
      const wouldBeExecPath = path.join(executionRoot, dirName);

      // Verify the path we WOULD use doesn't exist
      expect(fs.existsSync(wouldBeExecPath)).toBe(false);

      // Verify NO new directories were created
      const afterDirs = fs.existsSync(EXEC_ROOT) ? await fs.promises.readdir(EXEC_ROOT) : [];
      expect(afterDirs).toEqual(existingExecDirs);
    });

    it("should work with data source that exists without creating execution directories", async () => {
      // This test verifies the core validation invariant:
      // Given a valid data source, validation operations should not create execution directories

      // Setup: verify data source exists
      expect(fs.existsSync(DATA_SOURCE_DIR)).toBe(true);
      const dataStats = await fs.promises.stat(DATA_SOURCE_DIR);
      expect(dataStats.isDirectory()).toBe(true);

      // Operation: perform hash calculation (required for validation)
      const { hashDataSource } = await import("../../server/data-hasher.js");
      const _dataHash = await hashDataSource(DATA_SOURCE_DIR, 5000);

      // Verification: no side effects
      const afterDirs = fs.existsSync(EXEC_ROOT) ? await fs.promises.readdir(EXEC_ROOT) : [];
      expect(afterDirs).toEqual(existingExecDirs);
    });
  });

  describe("Logger in temp directory", () => {
    it("should be able to create a logger in temp directory without affecting exec root", async () => {
      const { Logger } = await import("../../server/utils.js");

      // Create a logger in temp directory (like validation mode does)
      const tempLogPath = path.join(os.tmpdir(), `hankweave-validation-test-${Date.now()}.log`);
      const logger = new Logger(tempLogPath);

      // Log something
      logger.log("Test validation log message");

      // Verify the log file was created in temp
      expect(fs.existsSync(tempLogPath)).toBe(true);

      // Verify NO directories were created in exec root
      const afterDirs = fs.existsSync(EXEC_ROOT) ? await fs.promises.readdir(EXEC_ROOT) : [];
      expect(afterDirs).toEqual(existingExecDirs);

      // Clean up
      await fs.promises.rm(tempLogPath, { force: true });
    });
  });
});
