import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import type { CleanupOptions } from "../../server/cleanup-command.js";
import { CleanupCommand } from "../../server/cleanup-command.js";
import { hashDataSource } from "../../server/data-hasher.js";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { RuntimeLock } from "../../server/runtime-lock.js";

describe("CleanupCommand", () => {
  let tempDir: string;
  let executionRoot: string;
  let dataSourcePath: string;
  const savedExecutionRoot = process.env.HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-cleanup-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create mock execution root
    executionRoot = path.join(tempDir, ".hankweave-executions");
    await fs.promises.mkdir(executionRoot, { recursive: true });

    process.env.HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR = executionRoot;

    // Create mock data source
    dataSourcePath = path.join(tempDir, "data-source");
    await fs.promises.mkdir(dataSourcePath, { recursive: true });
    await fs.promises.writeFile(path.join(dataSourcePath, "file1.txt"), "content 1");
    await fs.promises.writeFile(path.join(dataSourcePath, "file2.txt"), "content 2");
  });

  afterEach(async () => {
    if (savedExecutionRoot === undefined) {
      delete process.env.HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR;
    } else {
      process.env.HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR = savedExecutionRoot;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("constructor initializes with options", () => {
    const options: CleanupOptions = {
      executionPath: "/some/path",
      skipConfirmation: true,
    };

    const cleanup = new CleanupCommand(options);
    expect(cleanup).toBeInstanceOf(CleanupCommand);
  });

  test("returns success when the execution directory does not exist", async () => {
    const cleanup = new CleanupCommand({
      executionPath: path.join(executionRoot, "missing-execution"),
      skipConfirmation: true,
    });

    const result = await cleanup.execute();

    expect(result.success).toBe(true);
    expect(result.directoriesRemoved).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("removes execution directory by path", async () => {
    // Create a mock execution directory
    const executionDir = path.join(executionRoot, "1234567-abc-def123");
    const hankweaveDir = path.join(executionDir, ".hankweave");
    await fs.promises.mkdir(hankweaveDir, { recursive: true });

    // Create execution metadata
    const meta = {
      version: "1.0.0",
      readOnlySourceDataPath: dataSourcePath,
      readOnlySourceResolvedDataPath: dataSourcePath,
      dataHash: "def123",
      linkType: "symlink",
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    };
    await fs.promises.writeFile(
      path.join(hankweaveDir, "execution-meta.json"),
      JSON.stringify(meta, null, 2),
    );

    const cleanup = new CleanupCommand({
      executionPath: executionDir,
      skipConfirmation: true,
    });

    const result = await cleanup.execute();

    expect(result.success).toBe(true);
    expect(result.directoriesRemoved).toContain(executionDir);
    expect(fs.existsSync(executionDir)).toBe(false);
  });

  test("skips execution directory with running server", async () => {
    // Create a mock execution directory with lock file
    const executionDir = path.join(executionRoot, "1234567-abc-def123");
    const hankweaveDir = path.join(executionDir, ".hankweave");
    await fs.promises.mkdir(hankweaveDir, { recursive: true });

    const ownership = await RuntimeLock.acquire(executionDir);

    const cleanup = new CleanupCommand({
      executionPath: executionDir,
      skipConfirmation: true,
    });

    const result = await cleanup.execute().finally(() => ownership.release());

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("in use");
    expect(result.directoriesRemoved).not.toContain(executionDir);
    expect(fs.existsSync(executionDir)).toBe(true);
  });

  test("removes an execution with an expired lease", async () => {
    const executionDir = path.join(executionRoot, "expired-execution");
    await fs.promises.mkdir(path.join(executionDir, ".hankweave"), { recursive: true });
    await fs.promises.mkdir(new ExecutionLayout(executionDir).runtimeLockPath);
    await fs.promises.utimes(
      new ExecutionLayout(executionDir).runtimeLockPath,
      new Date(0),
      new Date(0),
    );
    const result = await new CleanupCommand({
      executionPath: executionDir,
      skipConfirmation: true,
    }).execute();
    expect(result.success).toBe(true);
    expect(fs.existsSync(executionDir)).toBe(false);
    expect(fs.existsSync(new ExecutionLayout(executionDir).runtimeLockPath)).toBe(false);
  });

  test("handles errors gracefully", async () => {
    const cleanup = new CleanupCommand({
      executionPath: executionRoot,
      dataSourcePath: "/non-existent/path",
      skipConfirmation: true,
    });

    const result = await cleanup.execute();

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("lists other matching executions but removes only the resolved target", async () => {
    // Create multiple execution directories
    const execDir1 = path.join(executionRoot, "1000000-aaa-abc123");
    const execDir2 = path.join(executionRoot, "2000000-bbb-def456");

    const dataHash = await hashDataSource(dataSourcePath);
    for (const dir of [execDir1, execDir2]) {
      const hankweaveDir = path.join(dir, ".hankweave");
      await fs.promises.mkdir(hankweaveDir, { recursive: true });

      const meta = {
        version: "1.0.0",
        readOnlySourceDataPath: dataSourcePath,
        readOnlySourceResolvedDataPath: dataSourcePath,
        dataHash,
        linkType: "symlink",
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
      };
      await fs.promises.writeFile(
        path.join(hankweaveDir, "execution-meta.json"),
        JSON.stringify(meta, null, 2),
      );
    }

    // Select the older execution to ensure listing never changes the target.
    const cleanup = new CleanupCommand({
      executionPath: execDir1,
      dataSourcePath,
      skipConfirmation: true,
    });

    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await cleanup.execute();

      expect(result.success).toBe(true);
      expect(result.directoriesRemoved).toEqual([execDir1]);
      expect(fs.existsSync(execDir1)).toBe(false);
      expect(fs.existsSync(execDir2)).toBe(true);
      expect(log).toHaveBeenCalledWith("Other execution directories (will NOT be removed):");
      expect(log).toHaveBeenCalledWith(`  - ${execDir2}`);
      expect(log).not.toHaveBeenCalledWith(`  - ${execDir1}`);
    } finally {
      log.mockRestore();
    }
  });
});
