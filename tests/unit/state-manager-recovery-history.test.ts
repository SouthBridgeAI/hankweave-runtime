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
import type { StateTransition } from "../../server/types/state-types.js";
import { Logger } from "../../server/utils.js";
import { type CheckpointId, CheckpointStorageError } from "../../server/workspace/checkpoints.js";
import { Workspace } from "../../server/workspace/index.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

describe("StateManager recovery with explicit checkpoint histories", () => {
  let directory: string;
  let layout: ExecutionLayout;
  let manager: StateManager;
  let workspace: Workspace;
  let ids: Record<string, CheckpointId>;
  const runId = RunId("original");
  const target = { type: "codon", codonId: CodonId("one"), checkpointType: "completed" } as const;
  const fire = async (event: StateTransition) => {
    manager.transition(event);
    await manager.waitForPendingTransitions();
  };
  const readOutput = () => fs.readFileSync(path.join(layout.agentRootPath, "output.txt"), "utf8");
  const startRun = (id: RunId) =>
    fire({
      type: "RunStarted",
      data: {
        runId: id,
        runFolder: path.join(directory, id),
        gitBranch: `run-${id}`,
        startingConditions: { type: "fresh" },
        serverPid: process.pid,
      },
    });
  async function completeCodon(id: string): Promise<CheckpointId> {
    const codonId = CodonId(id);
    await fire({ type: "CodonStarted", data: { runId, codonId } });
    await fire({
      type: "CodonTransitioned",
      data: { runId, codonId, from: "preparing", to: "starting" },
    });
    await fire({
      type: "CodonTransitioned",
      data: {
        runId,
        codonId,
        from: "starting",
        to: "initializing",
        metadata: { claudePid: 1, claudeLogPath: "test.log" },
      },
    });
    await fire({
      type: "CodonTransitioned",
      data: {
        runId,
        codonId,
        from: "initializing",
        to: "running",
        metadata: { claudeSessionId: SessionId(`session-${id}`) },
      },
    });
    fs.writeFileSync(path.join(layout.agentRootPath, "output.txt"), id);
    const checkpoint = await manager.createCheckpoint({
      status: "completed",
      codonId,
      codonName: id,
      runId,
      timestamp: new Date().toISOString(),
    });
    await fire({
      type: "CodonTransitioned",
      data: {
        runId,
        codonId,
        from: "running",
        to: "completed",
        metadata: { checkpointSha: checkpoint, exitCode: 0, resultMessageReceived: true },
      },
    });
    return checkpoint;
  }
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "hw-recovery-history-"));
    layout = new ExecutionLayout(directory);
    fs.mkdirSync(layout.agentRootPath, { recursive: true });
    const logger = new Logger(path.join(directory, "test.log"));
    workspace = await Workspace.open(layout, { logger });
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
    manager = new StateManager(layout, logger, configs);
    manager.setWorkspace(workspace);
    await manager.initialize();
    await startRun(runId);
    ids = {};
    for (const id of ["one", "two", "three"]) ids[id] = await completeCodon(id);
    fs.mkdirSync(path.join(layout.agentRootPath, "cache"));
    fs.writeFileSync(path.join(layout.agentRootPath, "cache", "dirty.txt"), "keep until cleanup");
  });
  afterEach(async () => {
    mock.restore();
    await manager?.waitForPendingTransitions();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  test("preserves before planning, restores the thread in order, and persists its continuation", async () => {
    const events: RollbackProgress[] = [];
    const prepare = spyOn(workspace.recovery, "prepare");
    const originalPlan = workspace.archives.planRestore.bind(workspace.archives);
    spyOn(workspace.archives, "planRestore").mockImplementation(async (history) => {
      expect(events.map((event) => event.type)).toEqual(["snapshot"]);
      expect(readOutput()).toBe("three");
      expect(history.abandoned.has(ids.three)).toBe(true);
      return originalPlan(history);
    });
    const result = await manager.rollback(target, { onProgress: (event) => events.push(event) });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.type === "checkpoint").map((event) => event.codonId),
    ).toEqual([CodonId("three"), CodonId("two"), CodonId("one")]);
    expect(readOutput()).toBe("one");
    expect(fs.existsSync(path.join(layout.agentRootPath, "cache"))).toBe(false);
    expect(await manager.currentCheckpoint()).toBe(ids.one);
    expect(result?.continuation).toEqual({
      type: "continuation",
      reason: "rollback",
      source: { runId, afterCodon: CodonId("one"), checkpointSha: ids.one },
    });
    expect(JSON.parse(fs.readFileSync(layout.statePath, "utf8")).runs[0].status).toBe("completed");
  });
  test("rejects an unknown checkpoint before snapshotting or mutating files", async () => {
    const prepare = spyOn(workspace.recovery, "prepare");
    await expect(manager.rollback({ type: "checkpoint", id: "missing" })).rejects.toBeInstanceOf(
      RollbackRejectedError,
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(readOutput()).toBe("three");
    expect(manager.getCurrentRun()?.status).toBe("running");
  });
  test("cancellation after an intermediate restore prevents rig cleanup and run completion", async () => {
    let aborted = false;
    const remove = spyOn(workspace.rigs, "removePath");
    await expect(
      manager.rollback(target, {
        shouldAbort: () => aborted,
        onProgress: (event) => {
          if (event.type === "checkpoint" && !event.final) aborted = true;
        },
      }),
    ).rejects.toBeInstanceOf(RollbackMutatedWorkspaceError);
    expect(remove).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(layout.agentRootPath, "cache", "dirty.txt"))).toBe(true);
    expect(manager.getCurrentRun()?.status).toBe("running");
  });
  test("snapshot failure leaves the work tree and current run intact", async () => {
    spyOn(workspace.recovery, "prepare").mockRejectedValueOnce(new Error("snapshot unavailable"));
    const plan = spyOn(workspace.archives, "planRestore");
    await expect(manager.rollback(target)).rejects.toBeInstanceOf(CheckpointStorageError);
    expect(plan).not.toHaveBeenCalled();
    expect(readOutput()).toBe("three");
    expect(manager.getCurrentRun()?.status).toBe("running");
  });
  test("a checkpoint outside the current thread restores directly", async () => {
    await fire({ type: "RunCompleted", data: { runId } });
    await startRun(RunId("fresh"));
    const events: RollbackProgress[] = [];
    const result = await manager.rollback(
      { type: "checkpoint", id: ids.one },
      { onProgress: (event) => events.push(event) },
    );
    expect(
      events.filter((event) => event.type === "checkpoint").map((event) => event.codonId),
    ).toEqual([CodonId("one")]);
    expect(readOutput()).toBe("one");
    expect(result?.continuation).toEqual({
      type: "continuation",
      reason: "rollback",
      source: { runId, afterCodon: CodonId("one"), checkpointSha: ids.one },
    });
    expect(result?.fromRun).toBe(RunId("fresh"));
  });
});
