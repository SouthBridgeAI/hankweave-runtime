import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodonFileTracker, type WatchedFileUpdate } from "../../server/codon-file-tracker.js";
import { ExecutionLayout } from "../../server/execution-layout.js";
import type { FileNode } from "../../server/schemas/event-schemas.js";
import { Logger } from "../../server/utils.js";
import { Workspace } from "../../server/workspace/index.js";
import { jsonl, sdkLog, useCodonRunnerSuite } from "../utils/codon-runner-test-harness.js";

describe("CodonFileTracker", () => {
  // Execution dir (holds the shadow checkpoint repo) and the agent root the
  // tracker watches. A real shadow repo, because the tracker's snapshot,
  // tree, and per-tool-use ignore verdicts all come from git (workspace/files.ts).
  // os.tmpdir(), not tests/test-area: real git repos under a sync daemon
  // flake (see checkpoint-git.test.ts).
  let executionDir: string;
  let tempDir: string;
  let workspace: Workspace;

  beforeEach(async () => {
    executionDir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-codon-file-tracker-"));
    tempDir = path.join(executionDir, "agent");
    await fs.promises.mkdir(tempDir, { recursive: true });
    workspace = await Workspace.open(
      new ExecutionLayout(executionDir, { agentRootPath: tempDir }),
      {
        logger: new Logger(path.join(executionDir, "checkpoint-git.log")),
      },
    );
  });

  afterEach(async () => {
    await fs.promises.rm(executionDir, { recursive: true, force: true });
  });

  function makeTracker(patterns?: readonly string[]): CodonFileTracker {
    return new CodonFileTracker({
      logger: new Logger(path.join(executionDir, "tracker.log")),
      files: workspace.files,
      checkpointedFiles: patterns,
    });
  }

  test("initializes existing watched files and records the newest one", async () => {
    const olderPath = path.join(tempDir, "older.txt");
    const newerPath = path.join(tempDir, "newer.txt");
    await fs.promises.writeFile(olderPath, "older contents");
    await fs.promises.writeFile(newerPath, "newer contents");
    const olderTime = new Date("2025-01-01T00:00:00.000Z");
    const newerTime = new Date("2025-01-02T00:00:00.000Z");
    await fs.promises.utimes(olderPath, olderTime, olderTime);
    await fs.promises.utimes(newerPath, newerTime, newerTime);

    const tracker = makeTracker(["*.txt"]);
    const updates: WatchedFileUpdate[] = [];
    const trees: FileNode[][] = [];
    tracker.on("fileUpdated", (data) => updates.push(data));
    tracker.on("fileTreeUpdated", ({ tree }) => trees.push(tree));

    await tracker.initialize();

    expect(updates.map((event) => event.path).sort()).toEqual(["newer.txt", "older.txt"]);
    expect(updates.every((event) => event.action === "created")).toBe(true);
    expect(trees).toHaveLength(1);
    expect(trees[0].map((node) => node.path).sort()).toEqual(["newer.txt", "older.txt"]);
    expect(updates.every((event) => event.source.kind === "codon-start")).toBe(true);
    expect(tracker.getRecentFileAccess()).toEqual({
      path: "newer.txt",
      timestamp: newerTime,
    });

    await tracker.close();
  });

  test("keeps watched patterns and recent-file state isolated per codon", async () => {
    const sourcePatterns = ["*.txt"];
    const trackerA = makeTracker(sourcePatterns);
    const trackerB = makeTracker();
    const updatesA: WatchedFileUpdate[] = [];
    const updatesB: WatchedFileUpdate[] = [];
    trackerA.on("fileUpdated", (data) => updatesA.push(data));
    trackerB.on("fileUpdated", (data) => updatesB.push(data));

    // Mutating the caller-owned list cannot change tracker A's copied scope.
    sourcePatterns.length = 0;

    await Promise.all([trackerA.initialize(), trackerB.initialize()]);

    trackerB.observeToolUse(
      "Write",
      {
        file_path: "created-by-b.txt",
        content: "owned by B",
      },
      "toolu_b1",
    );
    trackerA.observeToolUse(
      "Write",
      {
        file_path: "created-by-a.txt",
        content: "owned by A",
      },
      "toolu_a1",
    );
    await Promise.all([trackerA.drain(), trackerB.drain()]);

    expect(updatesB).toEqual([]);
    expect(trackerB.getRecentFileAccess()).toBeUndefined();
    expect(updatesA).toEqual([
      {
        path: "created-by-a.txt",
        filename: "created-by-a.txt",
        content: "owned by A",
        action: "created",
        source: { kind: "tool_use", toolUseId: "toolu_a1" },
      },
    ]);
    expect(trackerA.getRecentFileAccess()).toMatchObject({
      path: "created-by-a.txt",
    });

    await Promise.all([trackerA.close(), trackerB.close()]);
  });

  test("tool-use matching follows resolution semantics: no basename magic, gitignore applied", async () => {
    await fs.promises.mkdir(path.join(tempDir, "deep", "dir"), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, "output", "tmp"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "output/tmp/\n");

    const tracker = makeTracker(["*.md", "output/**"]);
    const updates: WatchedFileUpdate[] = [];
    tracker.on("fileUpdated", (data) => updates.push(data));
    await tracker.initialize();

    tracker.observeToolUse("Write", { file_path: "root.md", content: "root" }, "toolu_1");
    tracker.observeToolUse("Write", { file_path: "deep/dir/notes.md", content: "deep" }, "toolu_2");
    tracker.observeToolUse(
      "Write",
      { file_path: "output/tmp/no.md", content: "ignored" },
      "toolu_3",
    );
    tracker.observeToolUse("Write", { file_path: "output/keep.md", content: "keep" }, "toolu_4");
    tracker.observeToolUse(
      "Write",
      {
        file_path: path.join(tempDir, "..", "escape.md"),
        content: "outside",
      },
      "toolu_5",
    );
    // Mandatory exclusions and the hard .git rule hold on the tool path too,
    // whatever the patterns say.
    tracker.observeToolUse(
      "Write",
      { file_path: "output/../read_only_data_source/src.md", content: "ro" },
      "toolu_6",
    );
    tracker.observeToolUse("Write", { file_path: ".git/HEAD.md", content: "git" }, "toolu_7");
    await tracker.drain();

    expect(updates.map((event) => event.path)).toEqual(["root.md", "output/keep.md"]);
    // A gitignored Write is invisible everywhere: no event, no recent-file
    // state, and the tree does not list it.
    expect(tracker.getRecentFileAccess()).toMatchObject({ path: "output/keep.md" });
    await tracker.close();
  });

  test("ignore rules are read live: a .gitignore the agent writes mid-run applies to the next tool use", async () => {
    const tracker = makeTracker(["**/*.md"]);
    const updates: WatchedFileUpdate[] = [];
    tracker.on("fileUpdated", (data) => updates.push(data));
    await tracker.initialize();

    tracker.observeToolUse("Write", { file_path: "scratch/a.md", content: "a" }, "toolu_a");
    await tracker.drain();
    expect(updates.map((event) => event.path)).toEqual(["scratch/a.md"]);

    // The agent adds a rule (as a Write would land it on disk).
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "scratch/\n");
    tracker.observeToolUse("Write", { file_path: "scratch/b.md", content: "b" }, "toolu_b");
    await tracker.drain();
    expect(updates.map((event) => event.path)).toEqual(["scratch/a.md"]);

    await tracker.close();
  });

  test("the initial snapshot is git-native: ignored files and mandatory exclusions are skipped", async () => {
    await fs.promises.mkdir(path.join(tempDir, "node_modules", "pkg"), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, "read_only_data_source"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "node_modules/\n");
    await fs.promises.writeFile(path.join(tempDir, "keep.md"), "keep");
    await fs.promises.writeFile(path.join(tempDir, "node_modules", "pkg", "x.md"), "dep");
    await fs.promises.writeFile(path.join(tempDir, "read_only_data_source", "ro.md"), "ro");

    const tracker = makeTracker(["**/*.md"]);
    const updates: WatchedFileUpdate[] = [];
    const trees: FileNode[][] = [];
    tracker.on("fileUpdated", (data) => updates.push(data));
    tracker.on("fileTreeUpdated", ({ tree }) => trees.push(tree));
    await tracker.initialize();

    expect(updates.map((event) => event.path)).toEqual(["keep.md"]);
    expect(trees).toHaveLength(1);
    expect(trees[0].map((node) => node.path)).toEqual(["keep.md"]);
    await tracker.close();
  });

  test("Read of a watched file emits nothing and leaves recent-file state alone", async () => {
    await fs.promises.writeFile(path.join(tempDir, "reference.txt"), "reference body");

    const tracker = makeTracker(["*.txt"]);
    const updates: WatchedFileUpdate[] = [];
    tracker.on("fileUpdated", (data) => updates.push(data));
    await tracker.initialize();

    const snapshotState = tracker.getRecentFileAccess();
    const snapshotCount = updates.length;

    tracker.observeToolUse("Read", { file_path: "reference.txt" }, "toolu_r1");
    tracker.observeToolUse("Read", { file_path: path.join(tempDir, "reference.txt") }, "toolu_r2");
    await tracker.drain();

    expect(updates.length).toBe(snapshotCount);
    expect(tracker.getRecentFileAccess()).toEqual(snapshotState);

    // Control: a genuine mutation on the same file still emits.
    tracker.observeToolUse("Edit", { file_path: "reference.txt" }, "toolu_e1");
    await tracker.drain();
    expect(updates.length).toBe(snapshotCount + 1);
    expect(updates.at(-1)).toMatchObject({
      path: "reference.txt",
      action: "modified",
      source: { kind: "tool_use", toolUseId: "toolu_e1" },
    });

    await tracker.close();
  });

  test("a Write of the empty string fingerprints as empty, never as the file's old contents", async () => {
    // Presence-based capture: "" is a real body. The old truthiness check
    // fell back to reading the pre-write file from disk, emitting the wrong
    // fingerprint entirely.
    await fs.promises.writeFile(path.join(tempDir, "notes.txt"), "old contents that must not leak");

    const tracker = makeTracker(["*.txt"]);
    const updates: WatchedFileUpdate[] = [];
    tracker.on("fileUpdated", (data) => updates.push(data));
    await tracker.initialize();

    tracker.observeToolUse("Write", { file_path: "notes.txt", content: "" }, "toolu_empty");
    await tracker.drain();

    const emitted = updates.at(-1);
    expect(emitted).toMatchObject({ path: "notes.txt", action: "modified", content: "" });
    await tracker.close();
  });

  test("MultiEdit emits modified with the disk body, like Edit (diffs carry no full body)", async () => {
    await fs.promises.writeFile(path.join(tempDir, "notes.txt"), "multiedit target body");

    const tracker = makeTracker(["*.txt"]);
    const updates: WatchedFileUpdate[] = [];
    tracker.on("fileUpdated", (data) => updates.push(data));
    await tracker.initialize();

    tracker.observeToolUse(
      "MultiEdit",
      { file_path: "notes.txt", edits: [{ old_string: "target", new_string: "changed" }] },
      "toolu_me1",
    );
    await tracker.drain();

    expect(updates.at(-1)).toMatchObject({
      path: "notes.txt",
      action: "modified",
      content: "multiedit target body",
      source: { kind: "tool_use", toolUseId: "toolu_me1" },
    });
    await tracker.close();
  });

  test("a Write's emission carries the tool input's body even when the disk still holds the old one", async () => {
    // Attempt-time semantics, pinned: the fingerprint describes what the
    // Write carried, not whatever happens to be on disk at observation time.
    await fs.promises.writeFile(path.join(tempDir, "notes.txt"), "stale disk body");

    const tracker = makeTracker(["*.txt"]);
    const updates: WatchedFileUpdate[] = [];
    tracker.on("fileUpdated", (data) => updates.push(data));
    await tracker.initialize();

    tracker.observeToolUse("Write", { file_path: "notes.txt", content: "fresh body" }, "toolu_w");
    await tracker.drain();

    expect(updates.at(-1)).toMatchObject({ path: "notes.txt", content: "fresh body" });
    await tracker.close();
  });

  test("emits fileUpdated synchronously within observeToolUse", async () => {
    const tracker = makeTracker(["*.txt"]);
    const updates: WatchedFileUpdate[] = [];
    tracker.on("fileUpdated", (data) => updates.push(data));
    await tracker.initialize();

    tracker.observeToolUse("Write", { file_path: "sync.txt", content: "sync" }, "toolu_s1");

    // No await between the call and this assertion: the emit must land before
    // observeToolUse returns, so file.updated keeps preceding assistant.action.
    expect(updates.map((event) => event.path)).toEqual(["sync.txt"]);

    await tracker.drain();
    await tracker.close();
  });

  test("surfaces a trackingError when observed before initialize", async () => {
    const tracker = makeTracker(["*.txt"]);
    const errors: Error[] = [];
    const updates: WatchedFileUpdate[] = [];
    tracker.on("trackingError", (error) => errors.push(error));
    tracker.on("fileUpdated", (data) => updates.push(data));

    tracker.observeToolUse("Write", { file_path: "early.txt", content: "early" }, "toolu_early");
    await tracker.drain();

    expect(updates).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("before initialize()");
    await tracker.close();
  });

  test("stops accepting tool observations after close", async () => {
    const tracker = makeTracker(["*.txt"]);
    const updates: WatchedFileUpdate[] = [];
    tracker.on("fileUpdated", (data) => updates.push(data));

    await tracker.close();
    tracker.observeToolUse("Write", { file_path: "late.txt", content: "late" }, "toolu_late");
    await tracker.drain();

    expect(updates).toEqual([]);
    expect(tracker.getRecentFileAccess()).toBeUndefined();
    await tracker.close();
  });
});

describe("CodonRunner watched-file ownership", () => {
  const suite = useCodonRunnerSuite("file-tracking");

  test("only the runner configured with matching patterns emits file events", async () => {
    const log = jsonl(
      sdkLog.assistantToolUse("Write", {
        file_path: "created-by-tool.txt",
        content: "tool contents",
      }),
    );
    const runnerA = await suite.makeRunner({
      log,
      codon: { id: "watched-a", checkpointedFiles: ["*.txt"] },
    });
    const runnerB = await suite.makeRunner({
      log,
      codon: { id: "unwatched-b" },
    });
    const updatesA: string[] = [];
    const updatesB: string[] = [];
    const orderA: string[] = [];

    runnerA.runner.on("fileUpdated", (data) => {
      updatesA.push(data.path);
      orderA.push("file.updated");
    });
    runnerB.runner.on("fileUpdated", (data) => updatesB.push(data.path));

    // The runner no longer pre-scans messages for file tools; the runtime
    // calls observeToolUse() per tool_use item while handling the forwarded
    // assistantMessage. Mimic that dispatch here, for both runners, so the
    // ownership question (whose tracker emits?) is exercised the way
    // production drives it.
    for (const handle of [runnerA, runnerB]) {
      handle.runner.on("assistantMessage", (msg) => {
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const item of content) {
          if (item.type === "tool_use") {
            handle.runner.observeToolUse(item.name, item.input, item.id);
            if (handle === runnerA) orderA.push(`tool_use:${item.name}`);
          }
        }
      });
    }

    // run() initializes the tracker before spawning; parseLog() bypasses
    // run(), so mirror that lifecycle step explicitly.
    await Promise.all([
      runnerA.internals.fileTracker.initialize(),
      runnerB.internals.fileTracker.initialize(),
    ]);
    await Promise.all([runnerA.parseLog(), runnerB.parseLog()]);

    expect(updatesA).toEqual(["created-by-tool.txt"]);
    expect(updatesB).toEqual([]);
    // The tracker emits synchronously inside observeToolUse, so file.updated
    // lands immediately before the tool's own dispatch point.
    expect(orderA).toEqual(["file.updated", "tool_use:Write"]);
    expect(runnerA.runner.getRecentFileAccess()).toMatchObject({
      path: "created-by-tool.txt",
    });
    expect(runnerB.runner.getRecentFileAccess()).toBeUndefined();
  });

  test("does not emit final exit until watched-file work has drained", async () => {
    const handle = await suite.makeRunner();
    let releaseDrain: (() => void) | undefined;
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    let drainStarted = false;
    handle.internals.fileTracker.drain = async () => {
      drainStarted = true;
      await drainGate;
    };

    handle.internals.processManager.emit("exit", 0, false);
    await Promise.resolve();

    expect(drainStarted).toBe(true);
    expect(handle.events.exits).toEqual([]);

    releaseDrain?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handle.events.exits).toEqual([{ code: 0, contextExceeded: false, extensionCount: 0 }]);
  });
});
