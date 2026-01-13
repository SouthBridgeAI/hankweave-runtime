import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import type { CleanupOptions } from "../../server/cleanup-command.js";
import { CleanupCommand } from "../../server/cleanup-command.js";

describe("CleanupCommand", () => {
  let tempDir: string;
  let executionRoot: string;
  let dataSourcePath: string;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-cleanup-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create mock execution root
    executionRoot = path.join(tempDir, ".hankweave-executions");
    await fs.promises.mkdir(executionRoot, { recursive: true });

    // Create mock data source
    dataSourcePath = path.join(tempDir, "data-source");
    await fs.promises.mkdir(dataSourcePath, { recursive: true });
    await fs.promises.writeFile(path.join(dataSourcePath, "file1.txt"), "content 1");
    await fs.promises.writeFile(path.join(dataSourcePath, "file2.txt"), "content 2");
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("constructor initializes with options", () => {
    const options: CleanupOptions = {
      dataSourcePath: "/some/path",
      skipConfirmation: true,
    };

    const cleanup = new CleanupCommand(options);
    expect(cleanup).toBeInstanceOf(CleanupCommand);
  });

  test("returns success when no execution directories found", async () => {
    // Create a data source that won't have any execution directories
    const uniqueDataPath = path.join(tempDir, `unique-data-${Date.now()}`);
    await fs.promises.mkdir(uniqueDataPath, { recursive: true });
    await fs.promises.writeFile(path.join(uniqueDataPath, "unique.txt"), "unique content");

    const cleanup = new CleanupCommand({
      dataSourcePath: uniqueDataPath,
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

    // Create lock file with a DIFFERENT process pid (not our own)
    // This simulates a running server in a different process
    const differentPid = process.pid + 9999;
    await fs.promises.writeFile(
      path.join(hankweaveDir, "runtime.lock"),
      JSON.stringify({
        pid: differentPid,
        runId: "test-run",
        startTime: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      }),
    );

    const cleanup = new CleanupCommand({
      executionPath: executionDir,
      skipConfirmation: true,
    });

    const result = await cleanup.execute();

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("Server is running");
    expect(result.directoriesRemoved).not.toContain(executionDir);
    expect(fs.existsSync(executionDir)).toBe(true);
  });

  test("handles errors gracefully", async () => {
    const cleanup = new CleanupCommand({
      dataSourcePath: "/non-existent/path",
      skipConfirmation: true,
    });

    const result = await cleanup.execute();

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("removes specific execution directory when multiple exist", async () => {
    // Create multiple execution directories
    const execDir1 = path.join(executionRoot, "1000000-aaa-abc123");
    const execDir2 = path.join(executionRoot, "2000000-bbb-def456");

    for (const dir of [execDir1, execDir2]) {
      const hankweaveDir = path.join(dir, ".hankweave");
      await fs.promises.mkdir(hankweaveDir, { recursive: true });

      const meta = {
        version: "1.0.0",
        readOnlySourceDataPath: dataSourcePath,
        readOnlySourceResolvedDataPath: dataSourcePath,
        dataHash: path.basename(dir).split("-")[2], // Extract hash from dir name
        linkType: "symlink",
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
      };
      await fs.promises.writeFile(
        path.join(hankweaveDir, "execution-meta.json"),
        JSON.stringify(meta, null, 2),
      );
    }

    // Test removing specific execution directory
    const cleanup = new CleanupCommand({
      executionPath: execDir2,
      skipConfirmation: true,
    });

    const result = await cleanup.execute();

    expect(result.success).toBe(true);
    expect(result.directoriesRemoved).toHaveLength(1);
    expect(result.directoriesRemoved[0]).toBe(execDir2);
    expect(fs.existsSync(execDir1)).toBe(true); // First one remains
    expect(fs.existsSync(execDir2)).toBe(false); // Second one removed
  });
});
