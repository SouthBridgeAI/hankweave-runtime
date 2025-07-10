import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ManifestBuilder } from "../../server/cleanup/manifest-builder.js";
import { PhaseId } from "../../server/branded-types.js";
import * as fs from "fs";
import * as path from "path";
import { rmSync } from "fs";

describe("ManifestBuilder", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-test-manifest-${Date.now()}`
    );
    await fs.promises.mkdir(tempDir, { recursive: true });

    configPath = path.join(tempDir, "test-config.json");
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("constructor initializes with paths", () => {
    const builder = new ManifestBuilder(configPath, tempDir);
    expect(builder).toBeInstanceOf(ManifestBuilder);
  });

  test("finds copied items from workspace setup", async () => {
    // Create source files for the test
    const source1 = path.join(tempDir, "source1");
    const source2 = path.join(tempDir, "source2");
    await fs.promises.mkdir(source1, { recursive: true });
    await fs.promises.mkdir(source2, { recursive: true });

    // Create a config with copy operations
    const config = [
      {
        id: "phase-1",
        name: "Phase 1",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test",
        workspaceSetup: [
          {
            type: "copy",
            copy: {
              from: source1,
              to: "target1",
            },
          },
          {
            type: "copy",
            copy: {
              from: source2,
              to: "subdir/target2",
            },
          },
        ],
      },
    ];
    await fs.promises.writeFile(configPath, JSON.stringify(config));

    // Create the copied directories
    await fs.promises.mkdir(path.join(tempDir, "target1"), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, "subdir/target2"), {
      recursive: true,
    });

    const builder = new ManifestBuilder(configPath, tempDir);
    const manifest = await builder.build();

    expect(manifest.copiedItems).toHaveLength(2);
    expect(manifest.copiedItems[0]).toMatchObject({
      type: "directory",
      source: source1,
      destination: "target1",
      exists: true,
      phaseId: "phase-1",
    });
    expect(manifest.copiedItems[1]).toMatchObject({
      type: "directory",
      source: source2,
      destination: "subdir/target2",
      exists: true,
      phaseId: "phase-1",
    });
  });

  test("finds executed commands from workspace setup", async () => {
    const config = [
      {
        id: "phase-1",
        name: "Phase 1",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test",
        workspaceSetup: [
          {
            type: "command",
            command: {
              run: "mkdir -p output",
            },
          },
          {
            type: "command",
            command: {
              run: "npm install",
              workingDirectory: "project",
            },
          },
        ],
      },
    ];
    await fs.promises.writeFile(configPath, JSON.stringify(config));

    const builder = new ManifestBuilder(configPath, tempDir);
    const manifest = await builder.build();

    expect(manifest.executedCommands).toHaveLength(2);
    expect(manifest.executedCommands[0]).toMatchObject({
      command: "mkdir -p output",
      workingDirectory: ".",
      phaseId: "phase-1",
    });
    expect(manifest.executedCommands[0].possibleSideEffects).toContain(
      "May have created directory: output"
    );

    expect(manifest.executedCommands[1]).toMatchObject({
      command: "npm install",
      phaseId: "phase-1",
    });
    expect(manifest.executedCommands[1].possibleSideEffects).toContain(
      "May have created node_modules/ and modified package-lock.json"
    );
  });

  test("analyzes langton directory", async () => {
    // Create .langton directory structure
    const langtonDir = path.join(tempDir, ".langton");
    const logsDir = path.join(langtonDir, "logs");
    const checkpointsDir = path.join(langtonDir, "checkpoints");

    await fs.promises.mkdir(logsDir, { recursive: true });
    await fs.promises.mkdir(checkpointsDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(logsDir, "phase-1.log"),
      "log content"
    );
    await fs.promises.writeFile(
      path.join(logsDir, "phase-2.log"),
      "log content"
    );
    await fs.promises.writeFile(path.join(langtonDir, "server.lock"), "12345");

    // Create minimal config for testing langton directory
    const minimalConfig = [
      {
        id: "minimal-phase",
        name: "Minimal Phase",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test",
      },
    ];
    await fs.promises.writeFile(configPath, JSON.stringify(minimalConfig));

    const builder = new ManifestBuilder(configPath, tempDir);
    const manifest = await builder.build();

    expect(manifest.langtonDir.exists).toBe(true);
    expect(manifest.langtonDir.contents.logs).toContain("phase-1.log");
    expect(manifest.langtonDir.contents.logs).toContain("phase-2.log");
    expect(manifest.langtonDir.contents.checkpoints).toBe(true);
    expect(manifest.langtonDir.contents.other).toContain("server.lock");
    expect(manifest.langtonDir.sizeBytes).toBeGreaterThan(0);
  });

  test("handles non-existent langton directory", async () => {
    const minimalConfig = [
      {
        id: "minimal-phase",
        name: "Minimal Phase",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test",
      },
    ];
    await fs.promises.writeFile(configPath, JSON.stringify(minimalConfig));

    const builder = new ManifestBuilder(configPath, tempDir);
    const manifest = await builder.build();

    expect(manifest.langtonDir.exists).toBe(false);
    expect(manifest.langtonDir.sizeBytes).toBe(0);
    expect(manifest.langtonDir.contents.logs).toEqual([]);
    expect(manifest.langtonDir.contents.checkpoints).toBe(false);
  });

  test("handles lastCopied working directory", async () => {
    // Create source directory
    const sourceProject = path.join(tempDir, "source-project");
    await fs.promises.mkdir(sourceProject, { recursive: true });

    const config = [
      {
        id: "phase-1",
        name: "Phase 1",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test",
        workspaceSetup: [
          {
            type: "copy",
            copy: {
              from: sourceProject,
              to: "my-project",
            },
          },
          {
            type: "command",
            command: {
              run: "npm install",
              workingDirectory: "lastCopied",
            },
          },
        ],
      },
    ];
    await fs.promises.writeFile(configPath, JSON.stringify(config));

    // Create the copied directory
    await fs.promises.mkdir(path.join(tempDir, "my-project"), {
      recursive: true,
    });

    const builder = new ManifestBuilder(configPath, tempDir);
    const manifest = await builder.build();

    // The command should use the last copied directory
    const npmCommand = manifest.executedCommands.find(
      (cmd) => cmd.command === "npm install"
    );
    expect(npmCommand?.workingDirectory).toBe("my-project");
  });

  test("handles non-existent copied items", async () => {
    // Create source but not the target to test non-existent check
    const sourceDir = path.join(tempDir, "source");
    await fs.promises.mkdir(sourceDir, { recursive: true });

    const config = [
      {
        id: "phase-1",
        name: "Phase 1",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test",
        workspaceSetup: [
          {
            type: "copy",
            copy: {
              from: sourceDir,
              to: "non-existent-target",
            },
          },
        ],
      },
    ];
    await fs.promises.writeFile(configPath, JSON.stringify(config));

    const builder = new ManifestBuilder(configPath, tempDir);
    const manifest = await builder.build();

    expect(manifest.copiedItems).toHaveLength(1);
    expect(manifest.copiedItems[0].exists).toBe(false);
    expect(manifest.copiedItems[0].sizeBytes).toBeUndefined();
  });
});
