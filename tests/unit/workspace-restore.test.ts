import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { Workspace } from "../../server/workspace/index.js";
import { requireHistoryTip } from "../utils/checkpoint-history.js";

describe("Workspace restores the absence of checkpoint-owned files", () => {
  let directory: string;
  let layout: ExecutionLayout;
  let workspace: Workspace;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-restore-"));
    layout = new ExecutionLayout(directory);
    fs.mkdirSync(layout.agentRootPath, { recursive: true });
    workspace = await Workspace.open(layout);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function put(file: string, content = file): void {
    const absolute = path.join(layout.agentRootPath, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }

  const exists = (file: string) => fs.existsSync(path.join(layout.agentRootPath, file));
  const read = (file: string) => fs.readFileSync(path.join(layout.agentRootPath, file), "utf8");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        `--git-dir=${path.join(layout.checkpointsPath, ExecutionLayout.CHECKPOINT_GIT)}`,
        `--work-tree=${layout.agentRootPath}`,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();

  test("removes new owned files, restores edits and deletions, and keeps the recovery copy", async () => {
    put("notes/existing.md", "original");
    put("notes/deleted.md", "restore me");
    const target = await workspace.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(workspace.checkpoints.history("main")),
      message: "before planner",
      patterns: ["notes/**/*"],
    });
    put("notes/existing.md", "failed edit");
    fs.unlinkSync(path.join(layout.agentRootPath, "notes/deleted.md"));
    put("notes/plan.md", "failed plan");
    put("notes/space in name.md");
    put("notes/[literal].md");
    put("scratch.txt", "outside checkpoint ownership");
    const proof = await workspace.recovery.prepare({
      target,
      baseline: await requireHistoryTip(workspace.checkpoints.history("main")),
      reason: "planner crash",
      patterns: ["notes/**/*"],
    });

    await proof.restore();
    expect(exists("notes/plan.md")).toBe(false);
    expect(exists("notes/space in name.md")).toBe(false);
    expect(exists("notes/[literal].md")).toBe(false);
    expect(read("notes/existing.md")).toBe("original");
    expect(read("notes/deleted.md")).toBe("restore me");
    expect(read("scratch.txt")).toBe("outside checkpoint ownership");
    expect(git("show", `${proof.snapshot.snapshotId}:notes/plan.md`)).toBe("failed plan");
    expect(git("show", `${proof.snapshot.snapshotId}:notes/existing.md`)).toBe("failed edit");
    expect(await workspace.checkpoints.history("main").tip()).toBe(target);

    // The same proof covers the whole walk and is safe to reuse.
    await proof.restore();
    expect(exists("notes/plan.md")).toBe(false);
  });

  test("preserves ignored, pattern-excluded, protected, and unsnapshotted files", async () => {
    const target = await workspace.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(workspace.checkpoints.history("main")),
      message: "empty",
      patterns: [],
    });
    put(".gitignore", "notes/ignored.md\n");
    put("notes/ignored.md");
    put("notes/excluded.md");
    put("notes/plan.md");
    put("read_only_data_source/data.csv");
    put("rigArchive/saved.md");
    const proof = await workspace.recovery.prepare({
      target,
      baseline: await requireHistoryTip(workspace.checkpoints.history("main")),
      reason: "crash",
      patterns: ["**/*", "!notes/excluded.md"],
    });
    put("notes/after-snapshot.md", "not backed up");

    await proof.restore();
    expect(exists("notes/plan.md")).toBe(false);
    for (const file of [
      "notes/ignored.md",
      "notes/excluded.md",
      "read_only_data_source/data.csv",
      "rigArchive/saved.md",
      "notes/after-snapshot.md",
    ]) {
      expect(exists(file)).toBe(true);
    }
  });

  test("an empty policy removes only files already tracked at snapshot time", async () => {
    const target = await workspace.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(workspace.checkpoints.history("main")),
      message: "empty",
      patterns: [],
    });
    put("tracked.txt");
    await workspace.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(workspace.checkpoints.history("main")),
      message: "later",
      patterns: ["tracked.txt"],
    });
    put("untracked.txt");
    put(".gitignore", "tracked.txt\n");
    const proof = await workspace.recovery.prepare({
      target,
      baseline: await requireHistoryTip(workspace.checkpoints.history("main")),
      reason: "rollback",
      patterns: [],
    });
    await proof.restore();
    expect(exists("tracked.txt")).toBe(false);
    expect(exists("untracked.txt")).toBe(true);
    expect(exists(".gitignore")).toBe(true);
    expect(git("show", `${proof.snapshot.snapshotId}:tracked.txt`)).toBe("tracked.txt");
  });

  test("a missing target fails before removing any saved files", async () => {
    put("notes/plan.md");
    const proof = await workspace.recovery.preserve({
      baseline: await requireHistoryTip(workspace.checkpoints.history("main")),
      reason: "crash",
      patterns: ["notes/**/*"],
    });
    await expect(
      workspace.recovery.prepare({
        target: "missing",
        baseline: proof.snapshotId,
        reason: "missing target",
        patterns: ["notes/**/*"],
      }),
    ).rejects.toThrow("not found");
    expect(exists("notes/plan.md")).toBe(true);
  });

  test("an interrupted removal can be retried after reopening", async () => {
    const target = await workspace.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(workspace.checkpoints.history("main")),
      message: "before planner",
      patterns: [],
    });
    put("notes/a.md");
    put("notes/b.md");
    const proof = await workspace.recovery.prepare({
      target,
      baseline: await requireHistoryTip(workspace.checkpoints.history("main")),
      reason: "crash",
      patterns: ["notes/**/*"],
    });
    const unlink = fs.unlinkSync;
    const failure = spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (file === path.join(layout.agentRootPath, "notes/b.md")) {
        throw new Error("injected removal failure");
      }
      return unlink(file);
    });
    try {
      await expect(proof.restore()).rejects.toThrow("injected removal failure");
    } finally {
      failure.mockRestore();
    }
    expect(exists("notes/a.md")).toBe(false);
    expect(exists("notes/b.md")).toBe(true);
    expect(git("show", `${proof.snapshot.snapshotId}:notes/a.md`)).toBe("notes/a.md");
    expect(git("show", `${proof.snapshot.snapshotId}:notes/b.md`)).toBe("notes/b.md");

    workspace = await Workspace.open(layout);

    const retry = await workspace.recovery.prepare({
      target,
      baseline: await requireHistoryTip(workspace.checkpoints.history("main")),
      reason: "retry interrupted rollback",
      patterns: ["notes/**/*"],
    });
    await retry.restore();
    expect(exists("notes/b.md")).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "never follows a replaced ancestor into another tree",
    async () => {
      const target = await workspace.checkpoints.history("main").checkpoint({
        parent: await requireHistoryTip(workspace.checkpoints.history("main")),
        message: "before planner",
        patterns: [],
      });
      put("notes/plan.md");
      const proof = await workspace.recovery.prepare({
        target,
        baseline: await requireHistoryTip(workspace.checkpoints.history("main")),
        reason: "crash",
        patterns: ["notes/**/*"],
      });
      fs.renameSync(path.join(layout.agentRootPath, "notes"), path.join(directory, "outside"));
      fs.symlinkSync(path.join(directory, "outside"), path.join(layout.agentRootPath, "notes"));
      await expect(proof.restore()).rejects.toThrow("ancestor is not a real directory");
      expect(fs.readFileSync(path.join(directory, "outside/plan.md"), "utf8")).toBe(
        "notes/plan.md",
      );
    },
  );

  test("never recursively removes a directory replacing a saved file", async () => {
    const target = await workspace.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(workspace.checkpoints.history("main")),
      message: "before planner",
      patterns: [],
    });
    put("notes/plan.md");
    const proof = await workspace.recovery.prepare({
      target,
      baseline: await requireHistoryTip(workspace.checkpoints.history("main")),
      reason: "crash",
      patterns: ["notes/**/*"],
    });
    fs.unlinkSync(path.join(layout.agentRootPath, "notes/plan.md"));
    put("notes/plan.md/new-data.txt", "not backed up");
    await expect(proof.restore()).rejects.toThrow("no longer a regular file");
    expect(read("notes/plan.md/new-data.txt")).toBe("not backed up");
  });
});
