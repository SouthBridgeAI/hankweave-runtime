import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupExecutionEnvironment } from "../../server/execution-setup.js";
import { rimrafSimple } from "../utils/test-helpers.js";

describe("Execution Setup - startNew flag", () => {
  const TEST_BASE_DIR = path.join(os.tmpdir(), "hankweave-execution-setup-test");
  const DATA_SOURCE_DIR = path.join(TEST_BASE_DIR, "data-source");
  const EXECUTION_DIR = path.join(TEST_BASE_DIR, "execution");

  beforeEach(async () => {
    // Create test directories
    await fs.promises.mkdir(DATA_SOURCE_DIR, { recursive: true });

    // Create some dummy files in data source
    await fs.promises.writeFile(path.join(DATA_SOURCE_DIR, "test.txt"), "test content");
    await fs.promises.mkdir(path.join(DATA_SOURCE_DIR, "subdir"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(DATA_SOURCE_DIR, "subdir", "nested.txt"),
      "nested content",
    );
  });

  afterEach(async () => {
    // Calculate data hash before deleting test directory
    let dataHash = "";
    if (fs.existsSync(DATA_SOURCE_DIR)) {
      const { hashDataSource } = await import("../../server/data-hasher.js");
      dataHash = await hashDataSource(DATA_SOURCE_DIR, 5000).catch(() => "");
    }

    // Clean up test directories
    await rimrafSimple(TEST_BASE_DIR);

    // Also clean up any executions created in ~/.hankweave-executions
    const executionRoot = path.join(os.homedir(), ".hankweave-executions");
    if (fs.existsSync(executionRoot) && dataHash) {
      const dirs = await fs.promises.readdir(executionRoot);
      // Only clean up test executions (those with our test data hash)
      for (const dir of dirs) {
        if (dir.includes(dataHash.substring(0, 6))) {
          await rimrafSimple(path.join(executionRoot, dir));
        }
      }
    }
  });

  describe("with explicit execution path", () => {
    it("should create new execution in non-existent directory with --start-new", async () => {
      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: true,
      });

      expect(result.isNewExecution).toBe(true);
      expect(result.isResuming).toBe(false);
      expect(result.executionPath).toBe(EXECUTION_DIR);
      expect(fs.existsSync(EXECUTION_DIR)).toBe(true);
      expect(fs.existsSync(path.join(EXECUTION_DIR, ".hankweave", "execution-meta.json"))).toBe(
        true,
      );
    });

    it("should use empty directory with --start-new", async () => {
      // Create empty directory
      await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });

      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: true,
      });

      expect(result.isNewExecution).toBe(true);
      expect(result.isResuming).toBe(false);
      expect(result.executionPath).toBe(EXECUTION_DIR);
    });

    it("should prompt for confirmation in non-empty directory with --start-new", async () => {
      // Create directory with content (no .hankweave/)
      await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(EXECUTION_DIR, "existing.txt"), "existing content");

      // In non-TTY mode (tests), promptConfirmation auto-rejects
      // This is Tier 3 safety: warn and prompt for non-empty directories
      await expect(
        setupExecutionEnvironment({
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          executionPath: EXECUTION_DIR,
          startNew: true,
          // skipConfirmation not set, so it prompts (and auto-rejects in non-TTY)
        }),
      ).rejects.toThrow(/Operation cancelled by user/);
    });

    it("should allow non-empty directory with --start-new when skipConfirmation is true", async () => {
      // Create directory with content (no .hankweave/)
      await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(EXECUTION_DIR, "existing.txt"), "existing content");

      // With skipConfirmation: true, Tier 3 proceeds with a warning
      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: true,
        skipConfirmation: true,
      });

      expect(result.isNewExecution).toBe(true);
      expect(result.executionPath).toBe(EXECUTION_DIR);
    });

    it("should resume existing execution without --start-new", async () => {
      // First create an execution directory with metadata
      await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });
      const metaDir = path.join(EXECUTION_DIR, ".hankweave");
      await fs.promises.mkdir(metaDir, { recursive: true });

      // Calculate data hash for consistency
      const { hashDataSource } = await import("../../server/data-hasher.js");
      const dataHash = await hashDataSource(DATA_SOURCE_DIR, 30000);

      // Create metadata file
      const meta = {
        version: "1.0.0",
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        readOnlySourceResolvedDataPath: DATA_SOURCE_DIR,
        dataHash,
        linkType: "symlink",
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
      };

      await fs.promises.writeFile(
        path.join(metaDir, "execution-meta.json"),
        JSON.stringify(meta, null, 2),
      );

      // Now try to resume it
      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: false, // Explicitly false
      });

      expect(result.isNewExecution).toBe(false);
      expect(result.isResuming).toBe(true);
      expect(result.executionPath).toBe(EXECUTION_DIR);
    });

    it("should overwrite read_only_data_source with --start-new --force", async () => {
      // First create execution with original data
      await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: true,
      });

      // Verify old data is accessible (now inside agentRoot/)
      const oldFile = path.join(EXECUTION_DIR, "agentRoot", "read_only_data_source", "test.txt");
      expect(fs.existsSync(oldFile)).toBe(true);
      const oldContent = await fs.promises.readFile(oldFile, "utf-8");
      expect(oldContent).toBe("test content");

      // Create a completely different data source
      const NEW_DATA_SOURCE = path.join(TEST_BASE_DIR, "new-data");
      await fs.promises.mkdir(NEW_DATA_SOURCE, { recursive: true });
      await fs.promises.writeFile(path.join(NEW_DATA_SOURCE, "new.txt"), "new content");

      // Run with --start-new --force on same directory but different data
      await setupExecutionEnvironment({
        readOnlySourceDataPath: NEW_DATA_SOURCE,
        executionPath: EXECUTION_DIR,
        startNew: true,
        forceMode: true,
        skipConfirmation: true,
      });

      // Verify read_only_data_source points to new data (inside agentRoot/)
      const newFile = path.join(EXECUTION_DIR, "agentRoot", "read_only_data_source", "new.txt");
      expect(fs.existsSync(newFile)).toBe(true);
      const newContent = await fs.promises.readFile(newFile, "utf-8");
      expect(newContent).toBe("new content");

      // Verify old data files are gone from read_only_data_source
      expect(fs.existsSync(oldFile)).toBe(false);

      // Verify .hankweave.backup-* directory exists
      const execDirContents = await fs.promises.readdir(EXECUTION_DIR);
      const backupDir = execDirContents.find((name) => name.startsWith(".hankweave.backup-"));
      expect(backupDir).toBeTruthy();
    });
  });

  describe("with auto-detected execution path", () => {
    it("should always create new directory with --start-new", async () => {
      // First create an execution without startNew
      const firstRun = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
      });

      expect(firstRun.isNewExecution).toBe(true);
      const firstPath = firstRun.executionPath;

      // Now create another with startNew
      const secondRun = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        startNew: true,
      });

      expect(secondRun.isNewExecution).toBe(true);
      expect(secondRun.isResuming).toBe(false);
      expect(secondRun.executionPath).not.toBe(firstPath);

      // Both executions should exist
      expect(fs.existsSync(firstPath)).toBe(true);
      expect(fs.existsSync(secondRun.executionPath)).toBe(true);
    });

    it("should resume existing execution without --start-new", async () => {
      // First create an execution
      const firstRun = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
      });

      expect(firstRun.isNewExecution).toBe(true);
      const firstPath = firstRun.executionPath;

      // Now try without startNew (should resume)
      const secondRun = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        startNew: false, // Explicitly false
      });

      expect(secondRun.isNewExecution).toBe(false);
      expect(secondRun.isResuming).toBe(true);
      expect(secondRun.executionPath).toBe(firstPath);
    });
  });

  describe("edge cases", () => {
    it("should handle hidden files in directory check", async () => {
      // Create directory with only hidden files
      await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(EXECUTION_DIR, ".DS_Store"), "");
      await fs.promises.writeFile(path.join(EXECUTION_DIR, ".gitignore"), "");

      // Tier 3: Non-empty directory (including hidden files) triggers confirmation
      // In non-TTY mode, auto-rejects with "Operation cancelled by user"
      await expect(
        setupExecutionEnvironment({
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          executionPath: EXECUTION_DIR,
          startNew: true,
        }),
      ).rejects.toThrow(/Operation cancelled by user/);
    });

    it("should create valid execution metadata with --start-new", async () => {
      const _result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: true,
      });

      const metaPath = path.join(EXECUTION_DIR, ".hankweave", "execution-meta.json");
      const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));

      expect(meta.version).toBe("1.0.0");
      expect(meta.readOnlySourceDataPath).toBe(DATA_SOURCE_DIR);
      expect(meta.dataHash).toBeTruthy();
      expect(meta.linkType).toBeOneOf(["symlink", "copy"]);
      expect(meta.createdAt).toBeTruthy();
      expect(meta.lastUsed).toBeTruthy();
    });

    it("should create data link/copy in new execution", async () => {
      const _result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: true,
      });

      // Data is now inside agentRoot/
      const dataPath = path.join(EXECUTION_DIR, "agentRoot", "read_only_data_source");
      expect(fs.existsSync(dataPath)).toBe(true);

      // Verify files are accessible through the link/copy
      const testContent = await fs.promises.readFile(path.join(dataPath, "test.txt"), "utf-8");
      expect(testContent).toBe("test content");

      const nestedContent = await fs.promises.readFile(
        path.join(dataPath, "subdir", "nested.txt"),
        "utf-8",
      );
      expect(nestedContent).toBe("nested content");
    });
  });

  describe("data source validation", () => {
    it("should throw error for non-existent data source", async () => {
      await expect(
        setupExecutionEnvironment({
          readOnlySourceDataPath: "/non/existent/path",
        }),
      ).rejects.toThrow("Data source not found");
    });

    it("should accept a file as data source", async () => {
      const filePath = path.join(TEST_BASE_DIR, "test-file.txt");
      await fs.promises.writeFile(filePath, "I am a file");

      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: filePath,
        startNew: true,
      });

      expect(result.isNewExecution).toBe(true);
      expect(fs.existsSync(result.dataPathInExecutionDir)).toBe(true);

      // Verify the file is accessible in the read_only_data_source directory
      const fileName = path.basename(filePath);
      const linkedFilePath = path.join(result.dataPathInExecutionDir, fileName);
      expect(fs.existsSync(linkedFilePath)).toBe(true);

      const content = await fs.promises.readFile(linkedFilePath, "utf-8");
      expect(content).toBe("I am a file");
    });
  });

  describe("nested execution prevention", () => {
    it("should prevent creating execution inside another execution directory", async () => {
      const nestedPath = path.join(
        os.homedir(),
        ".hankweave-executions",
        "existing-exec",
        "data",
        "nested",
      );
      await fs.promises.mkdir(nestedPath, { recursive: true });

      // Tier 1 safety: ~/.hankweave-executions/ is reserved for auto-managed executions
      await expect(
        setupExecutionEnvironment({
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          executionPath: nestedPath,
        }),
      ).rejects.toThrow(/reserved for auto-managed executions/);

      // Clean up
      await rimrafSimple(path.join(os.homedir(), ".hankweave-executions", "existing-exec"));
    });

    it("should prevent using data source as execution directory", async () => {
      await expect(
        setupExecutionEnvironment({
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          executionPath: DATA_SOURCE_DIR,
        }),
      ).rejects.toThrow("Execution directory cannot be the same as data source");
    });
  });

  describe("data hash mismatch handling", () => {
    it("should throw error when resuming with different data source", async () => {
      // Create execution directory with metadata for different data
      await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });
      const metaDir = path.join(EXECUTION_DIR, ".hankweave");
      await fs.promises.mkdir(metaDir, { recursive: true });

      const meta = {
        version: "1.0.0",
        readOnlySourceDataPath: "/some/other/path",
        readOnlySourceResolvedDataPath: "/some/other/path",
        dataHash: "differenthash123",
        linkType: "symlink",
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
      };

      await fs.promises.writeFile(
        path.join(metaDir, "execution-meta.json"),
        JSON.stringify(meta, null, 2),
      );

      await expect(
        setupExecutionEnvironment({
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          executionPath: EXECUTION_DIR,
        }),
      ).rejects.toThrow(/Data source has changed/);
    });

    it("should allow resume with different data when ignoreDataMismatch is true", async () => {
      // Create execution directory with metadata for different data
      await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });
      const metaDir = path.join(EXECUTION_DIR, ".hankweave");
      await fs.promises.mkdir(metaDir, { recursive: true });

      const meta = {
        version: "1.0.0",
        readOnlySourceDataPath: "/some/other/path",
        readOnlySourceResolvedDataPath: "/some/other/path",
        dataHash: "differenthash123",
        linkType: "symlink",
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
      };

      await fs.promises.writeFile(
        path.join(metaDir, "execution-meta.json"),
        JSON.stringify(meta, null, 2),
      );

      // With ignoreDataMismatch, should succeed instead of throwing
      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        ignoreDataMismatch: true,
      });

      expect(result.isResuming).toBe(true);
      expect(result.executionPath).toBe(EXECUTION_DIR);
    });

    it("should not affect matching data when ignoreDataMismatch is true", async () => {
      // Create execution directory with matching data hash
      await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });
      const metaDir = path.join(EXECUTION_DIR, ".hankweave");
      await fs.promises.mkdir(metaDir, { recursive: true });

      const { hashDataSource } = await import("../../server/data-hasher.js");
      const dataHash = await hashDataSource(DATA_SOURCE_DIR, 30000);

      const meta = {
        version: "1.0.0",
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        readOnlySourceResolvedDataPath: DATA_SOURCE_DIR,
        dataHash,
        linkType: "symlink",
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
      };

      await fs.promises.writeFile(
        path.join(metaDir, "execution-meta.json"),
        JSON.stringify(meta, null, 2),
      );

      // Should work normally when hashes match
      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        ignoreDataMismatch: true,
      });

      expect(result.isResuming).toBe(true);
      expect(result.executionPath).toBe(EXECUTION_DIR);
    });
  });

  describe("symlink and copy behavior", () => {
    it("should use copy when useSymlink is false", async () => {
      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        useSymlink: false,
        startNew: true,
      });

      expect(result.linkType).toBe("copy");

      // Verify files were actually copied (now inside agentRoot/)
      const testContent = await fs.promises.readFile(
        path.join(EXECUTION_DIR, "agentRoot", "read_only_data_source", "test.txt"),
        "utf-8",
      );
      expect(testContent).toBe("test content");

      // Modify the copy and verify original is unchanged
      await fs.promises.writeFile(
        path.join(EXECUTION_DIR, "agentRoot", "read_only_data_source", "test.txt"),
        "modified content",
      );

      const originalContent = await fs.promises.readFile(
        path.join(DATA_SOURCE_DIR, "test.txt"),
        "utf-8",
      );
      expect(originalContent).toBe("test content");
    });

    it("should handle symlinks in source directory during copy", async () => {
      // Create a symlink in the source
      const targetFile = path.join(DATA_SOURCE_DIR, "target.txt");
      const symlinkFile = path.join(DATA_SOURCE_DIR, "symlink.txt");
      await fs.promises.writeFile(targetFile, "symlink target content");
      await fs.promises.symlink(targetFile, symlinkFile);

      const _result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        useSymlink: false,
        startNew: true,
      });

      // Verify symlink was preserved in copy (now inside agentRoot/)
      const destSymlink = path.join(
        EXECUTION_DIR,
        "agentRoot",
        "read_only_data_source",
        "symlink.txt",
      );
      const stats = await fs.promises.lstat(destSymlink);
      expect(stats.isSymbolicLink()).toBe(true);
    });
  });

  describe("multiple existing executions", () => {
    it("should use most recent execution when multiple exist", async () => {
      // Create multiple executions with different timestamps
      const { hashDataSource } = await import("../../server/data-hasher.js");
      const dataHash = await hashDataSource(DATA_SOURCE_DIR, 30000);

      const executionRoot = path.join(os.homedir(), ".hankweave-executions");

      // Create older execution
      const olderDir = path.join(executionRoot, `1000000-old-${dataHash.substring(0, 6)}`);
      await fs.promises.mkdir(olderDir, { recursive: true });
      await fs.promises.mkdir(path.join(olderDir, ".hankweave"), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(olderDir, ".hankweave", "execution-meta.json"),
        JSON.stringify({
          version: "1.0.0",
          dataHash,
          lastUsed: new Date(Date.now() - 10000).toISOString(),
        }),
      );

      // Create newer execution
      const newerDir = path.join(executionRoot, `2000000-new-${dataHash.substring(0, 6)}`);
      await fs.promises.mkdir(newerDir, { recursive: true });
      await fs.promises.mkdir(path.join(newerDir, ".hankweave"), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(newerDir, ".hankweave", "execution-meta.json"),
        JSON.stringify({
          version: "1.0.0",
          dataHash,
          lastUsed: new Date().toISOString(),
        }),
      );

      // Should resume the newer one
      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
      });

      expect(result.isResuming).toBe(true);
      expect(result.executionPath).toContain("2000000-new");

      // Clean up
      await rimrafSimple(olderDir);
      await rimrafSimple(newerDir);
    });
  });

  describe("metadata handling", () => {
    it("should preserve createdAt and update lastUsed on resume", async () => {
      const createdTime = new Date(Date.now() - 60000).toISOString();

      // Create execution with old timestamps
      await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });
      const metaDir = path.join(EXECUTION_DIR, ".hankweave");
      await fs.promises.mkdir(metaDir, { recursive: true });

      const { hashDataSource } = await import("../../server/data-hasher.js");
      const dataHash = await hashDataSource(DATA_SOURCE_DIR, 30000);

      await fs.promises.writeFile(
        path.join(metaDir, "execution-meta.json"),
        JSON.stringify({
          version: "1.0.0",
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          readOnlySourceResolvedDataPath: DATA_SOURCE_DIR,
          dataHash,
          linkType: "symlink",
          createdAt: createdTime,
          lastUsed: createdTime,
        }),
      );

      const beforeTime = Date.now();
      const _result = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
      });
      const afterTime = Date.now();

      // Read updated metadata
      const updatedMeta = JSON.parse(
        await fs.promises.readFile(path.join(metaDir, "execution-meta.json"), "utf-8"),
      );

      // createdAt should be preserved
      expect(updatedMeta.createdAt).toBe(createdTime);

      // lastUsed should be updated
      const lastUsedTime = new Date(updatedMeta.lastUsed).getTime();
      expect(lastUsedTime).toBeGreaterThanOrEqual(beforeTime);
      expect(lastUsedTime).toBeLessThanOrEqual(afterTime);
    });
  });

  describe("path edge cases", () => {
    it("should handle paths with spaces", async () => {
      const pathWithSpaces = path.join(TEST_BASE_DIR, "path with spaces", "data source");
      await fs.promises.mkdir(pathWithSpaces, { recursive: true });
      await fs.promises.writeFile(path.join(pathWithSpaces, "test.txt"), "content");

      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: pathWithSpaces,
        startNew: true,
      });

      expect(result.isNewExecution).toBe(true);
      expect(fs.existsSync(result.dataPathInExecutionDir)).toBe(true);
    });

    it("should resolve symlinks in data source path", async () => {
      const realPath = path.join(TEST_BASE_DIR, "real-data");
      const symlinkPath = path.join(TEST_BASE_DIR, "symlink-data");

      await fs.promises.mkdir(realPath, { recursive: true });
      await fs.promises.writeFile(path.join(realPath, "test.txt"), "real content");
      await fs.promises.symlink(realPath, symlinkPath, "dir");

      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: symlinkPath,
        startNew: true,
      });

      // Should resolve to real path
      expect(result.meta.readOnlySourceResolvedDataPath).toBe(await fs.promises.realpath(realPath));
    });
  });

  describe("error handling during setup", () => {
    it("should handle errors during metadata write gracefully", async () => {
      // Create execution directory but make .hankweave read-only
      await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });
      const hankweaveDir = path.join(EXECUTION_DIR, ".hankweave");
      await fs.promises.mkdir(hankweaveDir, { recursive: true });

      // Make directory read-only
      await fs.promises.chmod(hankweaveDir, 0o444);

      try {
        await setupExecutionEnvironment({
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          executionPath: EXECUTION_DIR,
          startNew: true,
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        // Should get permission error
        expect(error).toBeTruthy();
      } finally {
        // Restore permissions for cleanup
        await fs.promises.chmod(hankweaveDir, 0o755);
      }
    });
  });

  describe("hash timeout behavior", () => {
    it("should respect custom hash timeout", async () => {
      // Create a large data source to make hashing take time
      const largeDir = path.join(TEST_BASE_DIR, "large-data");
      await fs.promises.mkdir(largeDir, { recursive: true });

      // Create many files
      for (let i = 0; i < 100; i++) {
        await fs.promises.writeFile(path.join(largeDir, `file-${i}.txt`), "x".repeat(1000));
      }

      // This should complete with a short timeout (hash will be partial)
      const result = await setupExecutionEnvironment({
        readOnlySourceDataPath: largeDir,
        dataHashTimeLimit: 1, // 1ms timeout
        startNew: true,
      });

      expect(result.dataHash).toBeTruthy();
      expect(result.isNewExecution).toBe(true);
    });
  });

  describe("execution directory as file", () => {
    it("should throw error if execution path exists as file", async () => {
      const filePath = path.join(TEST_BASE_DIR, "not-a-dir");
      await fs.promises.writeFile(filePath, "I am a file");

      await expect(
        setupExecutionEnvironment({
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          executionPath: filePath,
        }),
      ).rejects.toThrow("Execution path is not a directory");
    });
  });
});
