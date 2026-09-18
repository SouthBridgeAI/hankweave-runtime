import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import {
  RollbackMutatedWorkspaceError,
  type RollbackProgress,
  RollbackRejectedError,
} from "../../server/rollback-types.js";
import { StateManager } from "../../server/state-manager.js";
import { CodonId, RunId, SessionId } from "../../server/types/branded-types.js";
import type * as ST from "../../server/types/state-types.js";
import { Logger } from "../../server/utils.js";
import { type CheckpointId, CheckpointStorageError } from "../../server/workspace/checkpoints.js";
import { GitWorkspaceStorage } from "../../server/workspace/git-storage.js";
import { Workspace } from "../../server/workspace/index.js";
import { requireHistoryTip } from "../utils/checkpoint-history.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

describe("StateManager rollback", () => {
  let directory: string;
  let layout: ExecutionLayout;
  let state: StateManager;
  let workspace: Workspace;
  let storage: GitWorkspaceStorage;
  let ids: Record<string, CheckpointId>;
  const runId = RunId("original");
  const target = { type: "codon", codonId: CodonId("one"), checkpointType: "completed" } as const;
  const fire = async (event: ST.StateTransition) => {
    state.transition(event);
    await state.waitForPendingTransitions();
  };
  const startRun = (id: string) =>
    fire({
      type: "RunStarted",
      data: {
        runId: RunId(id),
        runFolder: path.join(directory, id),
        gitBranch: `run-${id}`,
        startingConditions: { type: "fresh" },
        serverPid: process.pid,
      },
    });

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "hw-state-rollback-"));
    layout = new ExecutionLayout(directory);
    fs.mkdirSync(layout.agentRootPath, { recursive: true });
    const logger = new Logger(path.join(directory, "test.log"));
    storage = new GitWorkspaceStorage(
      { checkpointDir: layout.checkpointsPath, workTree: layout.agentRootPath },
      logger,
    );
    workspace = await Workspace.open(layout, { logger, storage });
    const configs = ["one", "two", "three"].map((id) =>
      createTestCodon({
        id,
        name: id,
        model: "haiku",
        continuationMode: "fresh",
        promptText: id,
        checkpointedFiles: ["*.txt"],
        rigSetup:
          id === "three" ? [{ type: "copy", copy: { from: "input", to: "cache" } }] : undefined,
      }),
    );
    state = new StateManager(layout, logger, configs);
    state.setWorkspace(workspace);
    await state.initialize();
    await startRun(runId);
    const history = workspace.checkpoints.history("run-original");
    let parent = await requireHistoryTip(workspace.checkpoints.history("main"));
    ids = {};
    for (const id of ["one", "two", "three"]) {
      fs.writeFileSync(path.join(layout.agentRootPath, "output.txt"), id);
      ids[id] = await history.checkpoint({
        parent,
        message: `completed:${id}`,
        patterns: ["*.txt"],
      });
      parent = ids[id];
      const codonId = CodonId(id);
      await fire({ type: "CodonStarted", data: { runId, codonId } });
      const step = (from: ST.CodonStatus, to: ST.CodonStatus, metadata?: Record<string, unknown>) =>
        fire({
          type: "CodonTransitioned",
          data: { runId, codonId, from, to, metadata },
        } as ST.StateTransition);
      await step("preparing", "starting");
      await step("starting", "initializing", { claudePid: 1, claudeLogPath: "test.log" });
      await step("initializing", "running", { claudeSessionId: SessionId(`s-${id}`) });
      await step("running", "completed", {
        checkpointSha: ids[id],
        exitCode: 0,
        resultMessageReceived: true,
      });
    }
    fs.mkdirSync(path.join(layout.agentRootPath, "cache"));
    fs.writeFileSync(path.join(layout.agentRootPath, "cache", "dirty.txt"), "preserve me");
  });

  afterEach(async () => {
    mock.restore();
    await state?.waitForPendingTransitions();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("preserves once, plans before restoring, walks the thread, and returns a persisted continuation", async () => {
    const order: string[] = [];
    const snapshots = spyOn(workspace.recovery, "prepare");
    const originalPlan = workspace.archives.planRestore.bind(workspace.archives);
    spyOn(workspace.archives, "planRestore").mockImplementation(async (history) => {
      order.push("plan");
      expect(await workspace.checkpoints.history("run-original").tip()).toBe(ids.three);
      expect(history.abandoned.has(ids.three)).toBe(true);
      return originalPlan(history);
    });
    const originalRestore = storage.restoreSnapshot.bind(storage);
    const proofs: unknown[] = [];
    spyOn(storage, "restoreSnapshot").mockImplementation(async (id, proof) => {
      order.push(`restore:${id}`);
      proofs.push(proof);
      expect(state.getCurrentRun()?.status).toBe("running");
      return originalRestore(id, proof);
    });
    const events: RollbackProgress[] = [];
    const result = await state.rollback(target, {
      onProgress: (event) => {
        events.push(event);
        if (event.type === "snapshot") order.push("snapshot");
      },
    });
    expect(order).toEqual([
      "snapshot",
      "plan",
      `restore:${ids.three}`,
      `restore:${ids.two}`,
      `restore:${ids.one}`,
    ]);
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(proofs.every((proof) => proof === proofs[0])).toBe(true);
    expect(
      events.filter((event) => event.type === "checkpoint").map((event) => event.codonId),
    ).toEqual([CodonId("three"), CodonId("two"), CodonId("one")]);
    expect(fs.existsSync(path.join(layout.agentRootPath, "cache"))).toBe(false);
    expect(fs.readFileSync(path.join(layout.agentRootPath, "output.txt"), "utf8")).toBe("one");
    expect(result?.continuation).toEqual({
      type: "continuation",
      reason: "rollback",
      source: {
        runId,
        afterCodon: CodonId("one"),
        checkpointSha: ids.one,
      },
    });
    expect(state.getState().runs).toHaveLength(1);
    const persisted = JSON.parse(fs.readFileSync(layout.statePath, "utf8"));
    expect(persisted.runs[0].status).toBe("completed");
  });

  test("rejects a missing target before creating a safety snapshot or changing the run", async () => {
    const snapshots = spyOn(workspace.recovery, "prepare");
    await expect(state.rollback({ type: "checkpoint", id: "missing" })).rejects.toBeInstanceOf(
      RollbackRejectedError,
    );
    expect(snapshots).not.toHaveBeenCalled();
    expect(state.getCurrentRun()?.status).toBe("running");
  });

  test("snapshot or archive planning failure leaves files and run untouched", async () => {
    const restore = spyOn(storage, "restoreSnapshot");
    const snapshot = spyOn(workspace.recovery, "prepare").mockRejectedValueOnce(
      new Error("cannot preserve"),
    );
    await expect(state.rollback(target)).rejects.toBeInstanceOf(CheckpointStorageError);
    snapshot.mockRestore();
    spyOn(workspace.archives, "planRestore").mockRejectedValueOnce(new Error("cannot plan"));
    await expect(state.rollback(target)).rejects.toThrow("cannot plan");
    expect(restore).not.toHaveBeenCalled();
    expect(state.getCurrentRun()?.status).toBe("running");
    expect(fs.existsSync(path.join(layout.agentRootPath, "cache", "dirty.txt"))).toBe(true);
  });

  test("cancellation during an intermediate restore prevents rig cleanup and run completion", async () => {
    let abort = false;
    const restore = storage.restoreSnapshot.bind(storage);
    const calls = spyOn(storage, "restoreSnapshot").mockImplementation(async (id, proof) => {
      await restore(id, proof);
      abort = true;
    });
    const remove = spyOn(workspace.rigs, "removePath");
    await expect(state.rollback(target, { shouldAbort: () => abort })).rejects.toBeInstanceOf(
      RollbackMutatedWorkspaceError,
    );
    expect(calls).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(state.getCurrentRun()?.status).toBe("running");
  });

  test("cancellation before recovery prevents even a safety snapshot", async () => {
    const snapshot = spyOn(workspace.recovery, "prepare");
    await expect(state.rollback(target, { shouldAbort: () => true })).rejects.toThrow("aborted");
    expect(snapshot).not.toHaveBeenCalled();
    expect(state.getCurrentRun()?.status).toBe("running");
  });

  test("rejects a second rollback while the first is preparing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plan = workspace.archives.planRestore.bind(workspace.archives);
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    spyOn(workspace.archives, "planRestore").mockImplementation(async (history) => {
      entered();
      await gate;
      return plan(history);
    });
    const pending = state.rollback(target);
    await preparing;
    try {
      await expect(state.rollback(target)).rejects.toBeInstanceOf(RollbackRejectedError);
    } finally {
      release();
      await pending;
    }
  });

  test("historical rollback restores directly and completes the current run only after success", async () => {
    await fire({ type: "RunCompleted", data: { runId } });
    await startRun("other-timeline");
    const restore = spyOn(storage, "restoreSnapshot").mockRejectedValueOnce(
      new Error("restore failed"),
    );
    await expect(state.rollback({ type: "checkpoint", id: ids.one })).rejects.toBeInstanceOf(
      RollbackMutatedWorkspaceError,
    );
    expect(state.getCurrentRun()?.status).toBe("running");
    restore.mockRestore();
    const restored = spyOn(storage, "restoreSnapshot");
    const result = await state.rollback({ type: "checkpoint", id: ids.one });
    expect(restored).toHaveBeenCalledTimes(1);
    expect(result?.continuation).toMatchObject({ source: { runId, checkpointSha: ids.one } });
    expect(state.getState().runs.find((run) => run.runId === RunId("other-timeline"))?.status).toBe(
      "completed",
    );
  });

  test("run persistence failure after restoration blocks continuation", async () => {
    spyOn(state, "save").mockRejectedValueOnce(new Error("disk full"));
    await expect(state.rollback(target)).rejects.toBeInstanceOf(RollbackMutatedWorkspaceError);
  });

  test("cancellation during the final restore prevents archives and run completion", async () => {
    let abort = false;
    spyOn(workspace.archives, "planRestore").mockResolvedValue({ count: 1 });
    const archives = spyOn(workspace.archives, "restore");
    const restore = storage.restoreSnapshot.bind(storage);
    spyOn(storage, "restoreSnapshot").mockImplementation(async (id, proof) => {
      await restore(id, proof);
      if (id === ids.one) abort = true;
    });
    await expect(state.rollback(target, { shouldAbort: () => abort })).rejects.toBeInstanceOf(
      RollbackMutatedWorkspaceError,
    );
    expect(archives).not.toHaveBeenCalled();
    expect(state.getCurrentRun()?.status).toBe("running");
  });

  test("fresh fallback reuses its safety snapshot until a new run starts", async () => {
    spyOn(state, "getAllCheckpoints").mockResolvedValue([]);
    const preserve = spyOn(workspace.recovery, "preserve");
    expect(await state.rollback({ type: "last-success" })).toBeNull();
    expect(await state.prepareRunFromHistory()).toBeUndefined();
    expect(preserve).toHaveBeenCalledTimes(1);
    expect(state.getCurrentRun()?.status).toBe("running");
    await startRun("fresh");
    expect(await state.prepareRunFromHistory()).toBeUndefined();
    expect(preserve).toHaveBeenCalledTimes(2);
  });

  test("partial rig cleanup remains a reported outcome and recovery continues", async () => {
    spyOn(workspace.rigs, "removePath").mockRejectedValueOnce(new Error("cannot remove cache"));
    const events: RollbackProgress[] = [];
    const result = await state.rollback(target, {
      onProgress: (event) => {
        events.push(event);
      },
    });
    expect(result?.checkpoint).toBe(ids.one);
    expect(events).toContainEqual({
      type: "rig-cleanup",
      codonId: CodonId("three"),
      codonName: "three",
      directories: ["cache"],
      status: "failed",
      successfulCleanups: [],
      failedCleanups: [{ directory: "cache", error: "cannot remove cache" }],
    });
  });
});
