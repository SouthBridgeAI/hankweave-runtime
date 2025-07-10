import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CleanupCommand } from "../../server/cleanup-command.js";
import { ManifestBuilder } from "../../server/cleanup/manifest-builder.js";
import { GitOperations } from "../../server/cleanup/git-operations.js";
import type {
  CleanupManifest,
  CleanupOptions,
  CleanupResult,
} from "../../server/cleanup/types.js";
import { PhaseId } from "../../server/branded-types.js";
import * as fs from "fs";
import * as path from "path";
import { rmSync } from "fs";

describe("CleanupCommand", () => {
  let tempDir: string;
  let configPath: string;
  let lockFile: string;

  beforeEach(async () => {
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-test-cleanup-${Date.now()}`
    );
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create source directory for copy operations
    const sourceDir = path.join(tempDir, "source-template");
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(sourceDir, "template.txt"),
      "template content"
    );

    // Create a mock config file
    configPath = path.join(tempDir, "test-config.json");
    const mockConfig = [
      {
        id: "phase-1",
        name: "Phase 1",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test prompt",
        workspaceSetup: [
          {
            type: "copy",
            copy: {
              from: sourceDir,
              to: "copied-dir",
            },
          },
          {
            type: "command",
            command: {
              run: "mkdir -p test-dir",
            },
          },
        ],
      },
    ];
    await fs.promises.writeFile(configPath, JSON.stringify(mockConfig));

    lockFile = path.join(tempDir, ".langton/server.lock");
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("constructor initializes with options", () => {
    const options: CleanupOptions = {
      configPath: "test.json",
      projectPath: "/project",
      skipConfirmation: true,
    };

    const cleanup = new CleanupCommand(options);
    expect(cleanup).toBeInstanceOf(CleanupCommand);
  });

  test("fails if server is running (lock file exists)", async () => {
    // Create lock file
    await fs.promises.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.promises.writeFile(lockFile, "12345");

    const cleanup = new CleanupCommand({
      configPath,
      projectPath: tempDir,
      skipConfirmation: true,
    });

    const result = await cleanup.execute();

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("Server is currently running");
  });

  test("returns error in result on manifest builder failure", async () => {
    const cleanup = new CleanupCommand({
      configPath: "/non-existent/config.json",
      projectPath: tempDir,
      skipConfirmation: true,
    });

    const result = await cleanup.execute();

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("respects skipConfirmation option", async () => {
    // Create a simpler config that doesn't require source paths
    const simpleConfig = [
      {
        id: "phase-1",
        name: "Phase 1",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test prompt",
      },
    ];
    await fs.promises.writeFile(configPath, JSON.stringify(simpleConfig));

    const cleanup = new CleanupCommand({
      configPath,
      projectPath: tempDir,
      skipConfirmation: true,
    });

    const result = await cleanup.execute();

    // Should succeed with minimal manifest
    expect(result.success).toBe(true);
  });

  test("removes copied items from manifest", async () => {
    // Create a copied directory
    const copiedDir = path.join(tempDir, "copied-dir");
    await fs.promises.mkdir(copiedDir, { recursive: true });
    await fs.promises.writeFile(path.join(copiedDir, "test.txt"), "content");

    const cleanup = new CleanupCommand({
      configPath,
      projectPath: tempDir,
      skipConfirmation: true,
    });

    const result = await cleanup.execute();

    // The directory should be removed
    expect(fs.existsSync(copiedDir)).toBe(false);
    expect(result.directoriesRemoved).toContain("copied-dir");
  });

  test("removes .langton directory", async () => {
    // Create .langton directory
    const langtonDir = path.join(tempDir, ".langton");
    await fs.promises.mkdir(path.join(langtonDir, "logs"), { recursive: true });
    await fs.promises.writeFile(
      path.join(langtonDir, "logs", "test.log"),
      "log content"
    );

    const cleanup = new CleanupCommand({
      configPath,
      projectPath: tempDir,
      skipConfirmation: true,
    });

    const result = await cleanup.execute();

    expect(fs.existsSync(langtonDir)).toBe(false);
    expect(result.directoriesRemoved).toContain(".langton");
  });
});
