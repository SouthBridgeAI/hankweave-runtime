import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSchemaUrl } from "../../server/config.js";
import { isNonInteractive, setupExecutionEnvironment } from "../../server/execution-setup.js";
import { rimrafSimple } from "../utils/test-helpers.js";

describe("Execution Setup - startNew flag", () => {
  const TEST_BASE_DIR = path.join(os.tmpdir(), "hankweave-execution-setup-test");
  const DATA_SOURCE_DIR = path.join(TEST_BASE_DIR, "data-source");
  const EXECUTION_DIR = path.join(TEST_BASE_DIR, "execution");

  // The real ~/.hankweave-executions is machine-global state, and the
  // auto-detect tests below create and scan executions in it.
  // setupExecutionEnvironment resolves that root via getManagedExecutionsRoot()
  // at call time, so point it at a per-file temp dir through
  // HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR: tests see only their own executions
  // and never touch (or get broken by) the real ones.
  const EXEC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-execution-setup-root-"));
  const savedExecBaseDir = process.env.HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR;

  beforeAll(() => {
    process.env.HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR = EXEC_ROOT;
  });

  afterAll(() => {
    if (savedExecBaseDir === undefined) {
      delete process.env.HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR;
    } else {
      process.env.HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR = savedExecBaseDir;
    }
    fs.rmSync(EXEC_ROOT, { recursive: true, force: true });
  });

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

    // Also clean up any executions created in the managed executions root
    const executionRoot = EXEC_ROOT;
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

      expect(meta.version).toBe("1.1.0");
      expect(meta.readOnlySourceDataPath).toBe(DATA_SOURCE_DIR);
      expect(meta.dataHash).toBeTruthy();
      expect(meta.linkType).toBeOneOf(["symlink", "copy"]);
      expect(meta.createdAt).toBeTruthy();
      expect(meta.lastUsed).toBeTruthy();
      expect(meta.hankweaveVersion).toBeTruthy();
      expect(meta.environment).toBeDefined();
      expect(meta.environment.invocationMethod).toBeOneOf(["binary", "bun", "node", "deno"]);
      expect(meta.environment.platform).toBeTruthy();
      expect(meta.environment.arch).toBeTruthy();
      expect(meta.environment.osRelease).toBeTruthy();
      expect(meta.environment.runtime).toMatch(/^(bun|node|deno) /);
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

  describe.skipIf(process.platform === "win32")("hank path validation", () => {
    // The hank hash is computed before hank validation runs (resolveSettings
    // swallows loader errors), so setupExecutionEnvironment must reject a
    // non-regular hank path itself instead of blocking forever reading it.
    it("rejects a FIFO hank path before reading it", async () => {
      const { execSync } = await import("node:child_process");
      const fifoPath = path.join(TEST_BASE_DIR, "hank-pipe.json");
      execSync(`mkfifo ${JSON.stringify(fifoPath)}`);

      await expect(
        setupExecutionEnvironment({
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          executionPath: EXECUTION_DIR,
          startNew: true,
          hankPath: fifoPath,
        }),
      ).rejects.toThrow(/Hank file is not a regular file/);
    });

    it("rejects a directory hank path with a clear error", async () => {
      const dirPath = path.join(TEST_BASE_DIR, "hank-dir");
      await fs.promises.mkdir(dirPath, { recursive: true });

      await expect(
        setupExecutionEnvironment({
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          executionPath: EXECUTION_DIR,
          startNew: true,
          hankPath: dirPath,
        }),
      ).rejects.toThrow(/Hank file is not a regular file/);
    });
  });

  describe("nested execution prevention", () => {
    it("should prevent creating execution inside another execution directory", async () => {
      const nestedPath = path.join(EXEC_ROOT, "existing-exec", "data", "nested");
      await fs.promises.mkdir(nestedPath, { recursive: true });

      // Tier 1 safety: ~/.hankweave-executions/ is reserved for auto-managed executions
      await expect(
        setupExecutionEnvironment({
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          executionPath: nestedPath,
        }),
      ).rejects.toThrow(/reserved for auto-managed executions/);

      // Clean up
      await rimrafSimple(path.join(EXEC_ROOT, "existing-exec"));
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

      const executionRoot = EXEC_ROOT;

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

  describe("hank config change on resume", () => {
    // hank.json lives OUTSIDE the data source dir: editing it must change only
    // the hank hash, not the data hash (a data mismatch would throw earlier).
    const HANK_PATH = path.join(TEST_BASE_DIR, "hank.json");

    const writeHank = (extra: Record<string, unknown> = {}) =>
      fs.promises.writeFile(
        HANK_PATH,
        `${JSON.stringify(
          { $schema: "https://example.com/hank.schema.json", hank: [], ...extra },
          null,
          2,
        )}\n`,
      );

    it("fails closed with a self-contained error on non-interactive resume with changed hank.json", async () => {
      await writeHank();
      const firstRun = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: true,
        hankPath: HANK_PATH,
      });
      expect(firstRun.hankHash).toBeTruthy();

      await writeHank({ changed: true });

      // NODE_ENV=test makes isNonInteractive() true, so the resume must throw
      // the self-contained non-interactive error — not a fake user cancel.
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.join(" "));
      };
      let error: Error | undefined;
      try {
        await setupExecutionEnvironment({
          readOnlySourceDataPath: DATA_SOURCE_DIR,
          executionPath: EXECUTION_DIR,
          hankPath: HANK_PATH,
        });
      } catch (e) {
        error = e as Error;
      } finally {
        console.warn = originalWarn;
      }

      expect(error).toBeDefined();
      expect(error?.message).toMatch(/does not match the configuration recorded/);
      expect(error?.message).toMatch(/refusing to resume in non-interactive mode/);
      expect(error?.message).toContain("-y");
      expect(error?.message).toContain("--start-new");
      expect(error?.message).not.toMatch(/Operation cancelled by user/);
      expect(warnings.join("\n")).not.toContain("skipping confirmation prompt");

      // Fail-closed: the recorded hash must be untouched by the rejected resume
      const meta = JSON.parse(
        await fs.promises.readFile(
          path.join(EXECUTION_DIR, ".hankweave", "execution-meta.json"),
          "utf-8",
        ),
      );
      expect(meta.hankHash).toBe(firstRun.hankHash);
    });

    it("resumes and updates the recorded hash with skipConfirmation (-y)", async () => {
      await writeHank();
      const firstRun = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: true,
        hankPath: HANK_PATH,
      });

      await writeHank({ changed: true });

      const secondRun = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        hankPath: HANK_PATH,
        skipConfirmation: true,
      });

      expect(secondRun.isResuming).toBe(true);
      expect(secondRun.configChanged).toBe(true);
      expect(secondRun.hankHash).toBeTruthy();
      expect(secondRun.hankHash).not.toBe(firstRun.hankHash);

      const meta = JSON.parse(
        await fs.promises.readFile(
          path.join(EXECUTION_DIR, ".hankweave", "execution-meta.json"),
          "utf-8",
        ),
      );
      expect(meta.hankHash).toBe(secondRun.hankHash);
    });

    it("does not report a config change after ensureSchemaUrl rewrote a schema-less hank.json", async () => {
      // Regression: setup hashes hank.json, then index.ts runs ensureSchemaUrl,
      // which rewrites a schema-less file. The recorded hash must reflect the
      // post-rewrite content so an unmodified resume never sees a phantom change.
      await fs.promises.writeFile(HANK_PATH, `${JSON.stringify({ hank: [] }, null, 2)}\n`);

      const firstRun = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: true,
        hankPath: HANK_PATH,
      });

      // index.ts calls ensureSchemaUrl AFTER execution setup — file is rewritten
      expect(ensureSchemaUrl(HANK_PATH)).toBe(true);

      // Unmodified resume, no skipConfirmation: would fail closed under
      // NODE_ENV=test if a config change were (wrongly) detected.
      const secondRun = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        hankPath: HANK_PATH,
      });

      expect(secondRun.isResuming).toBe(true);
      expect(secondRun.configChanged).toBe(false);
      expect(secondRun.hankHash).toBe(firstRun.hankHash);
    });

    it("fails closed on --headless resume with changed hank.json even in an interactive environment", async () => {
      await writeHank();
      await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: true,
        hankPath: HANK_PATH,
      });

      await writeHank({ changed: true });

      // Simulate a real terminal (no CI vars, no NODE_ENV=test, TTY on both
      // ends) so headless alone is what forces the non-interactive path.
      const envKeys = [
        "CI",
        "GITHUB_ACTIONS",
        "GITLAB_CI",
        "JENKINS",
        "CIRCLECI",
        "TRAVIS",
        "NODE_ENV",
      ] as const;
      const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
      const savedStdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      const savedStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      for (const key of envKeys) {
        delete process.env[key];
      }
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

      try {
        // Sanity: the stubs must have taken effect, or this test proves nothing
        expect(isNonInteractive()).toBe(false);

        await expect(
          setupExecutionEnvironment({
            readOnlySourceDataPath: DATA_SOURCE_DIR,
            executionPath: EXECUTION_DIR,
            hankPath: HANK_PATH,
            headless: true,
          }),
        ).rejects.toThrow(/refusing to resume in non-interactive mode/);
      } finally {
        for (const key of envKeys) {
          if (savedEnv[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = savedEnv[key];
          }
        }
        // No own descriptor originally means the stubbed one must be deleted,
        // or both streams would stay marked as TTY for every later test.
        if (savedStdinTty) {
          Object.defineProperty(process.stdin, "isTTY", savedStdinTty);
        } else {
          delete (process.stdin as { isTTY?: boolean }).isTTY;
        }
        if (savedStdoutTty) {
          Object.defineProperty(process.stdout, "isTTY", savedStdoutTty);
        } else {
          delete (process.stdout as { isTTY?: boolean }).isTTY;
        }
      }
    });

    it("does not report a data or config change after ensureSchemaUrl rewrote hank.json inside the data directory", async () => {
      // Regression for the auto-discovery layout: hank.json lives INSIDE the
      // data source, so a post-hash rewrite would change the data hash too and
      // the next resume would fail with "Data source has changed". index.ts
      // therefore runs ensureSchemaUrl BEFORE setupExecutionEnvironment —
      // mirror that order here.
      const hankInDataPath = path.join(DATA_SOURCE_DIR, "hank.json");
      await fs.promises.writeFile(hankInDataPath, `${JSON.stringify({ hank: [] }, null, 2)}\n`);

      expect(ensureSchemaUrl(hankInDataPath)).toBe(true);
      const firstRun = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        startNew: true,
        hankPath: hankInDataPath,
      });

      // Unmodified resume: neither a data mismatch nor a config change
      const secondRun = await setupExecutionEnvironment({
        readOnlySourceDataPath: DATA_SOURCE_DIR,
        executionPath: EXECUTION_DIR,
        hankPath: hankInDataPath,
      });

      expect(secondRun.isResuming).toBe(true);
      expect(secondRun.configChanged).toBe(false);
      expect(secondRun.dataHash).toBe(firstRun.dataHash);
      expect(secondRun.hankHash).toBe(firstRun.hankHash);
    });
  });

  describe("isNonInteractive", () => {
    const interactiveInputs = {
      env: {} as NodeJS.ProcessEnv,
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    };

    it("treats headless as non-interactive even with a full TTY environment", () => {
      expect(isNonInteractive({ ...interactiveInputs, headless: true })).toBe(true);
    });

    it("stays interactive for a TTY environment without headless", () => {
      expect(isNonInteractive({ ...interactiveInputs })).toBe(false);
    });

    it("is non-interactive under CI, test env, or missing TTY", () => {
      expect(isNonInteractive({ ...interactiveInputs, env: { CI: "1" } })).toBe(true);
      expect(isNonInteractive({ ...interactiveInputs, env: { NODE_ENV: "test" } })).toBe(true);
      expect(isNonInteractive({ ...interactiveInputs, stdin: { isTTY: undefined } })).toBe(true);
      expect(isNonInteractive({ ...interactiveInputs, stdout: { isTTY: undefined } })).toBe(true);
    });
  });
});
