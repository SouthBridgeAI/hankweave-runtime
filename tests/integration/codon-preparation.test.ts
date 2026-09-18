import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PreparationProgress, PrepareCodonOptions } from "../../server/codon-preparation.js";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { HankDir } from "../../server/hank-dir.js";
import { StateManager } from "../../server/state-manager.js";
import { CodonId, RunId } from "../../server/types/branded-types.js";
import type { StartingConditions, StateTransition } from "../../server/types/state-types.js";
import { Logger } from "../../server/utils.js";
import { Workspace } from "../../server/workspace/index.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

// Real hank filtering, shell commands, state persistence, and git checkpoints.
// Only sentinel services are supplied by the caller, as in the runtime.
describe("StateManager codon preparation", () => {
  let temp: string;
  let layout: ExecutionLayout;
  let hank: HankDir;
  let workspace: Workspace;
  let manager: StateManager;
  let progress: PreparationProgress[];
  const codonId = CodonId("prepare");

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "hw-prepare-"));
    const hankRoot = path.join(temp, "hank");
    fs.mkdirSync(path.join(hankRoot, "template"), { recursive: true });
    fs.writeFileSync(path.join(hankRoot, "hank.json"), "{}");
    fs.writeFileSync(path.join(hankRoot, ".gitignore"), "excluded.txt\n");
    fs.writeFileSync(path.join(hankRoot, "template", "included.txt"), "included");
    fs.writeFileSync(path.join(hankRoot, "template", "excluded.txt"), "excluded");
    hank = HankDir.forConfig(path.join(hankRoot, "hank.json"));
    layout = new ExecutionLayout(path.join(temp, "execution"));
    fs.mkdirSync(layout.agentRootPath, { recursive: true });
    fs.mkdirSync(path.dirname(layout.statePath), { recursive: true });
    progress = [];
  });

  afterEach(async () => {
    await manager?.waitForPendingTransitions();
    hank.dispose();
    mock.restore();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const shell = (code: string, workingDirectory: "project" | "lastCopied" = "project") => ({
    type: "command",
    command: { run: `node -e ${JSON.stringify(code)}`, workingDirectory },
  });
  const write = (file: string, value = "done") =>
    shell(`require('node:fs').writeFileSync('${file}', '${value}')`);
  const read = (file: string) => fs.readFileSync(path.join(layout.agentRootPath, file), "utf8");
  const exists = (file: string) => fs.existsSync(path.join(layout.agentRootPath, file));
  const fire = async (event: StateTransition) => {
    manager.transition(event);
    await manager.waitForPendingTransitions();
  };
  const startRun = async (
    id: string,
    startingConditions: StartingConditions = { type: "fresh" },
  ) => {
    await fire({
      type: "RunStarted",
      data: {
        runId: RunId(id),
        runFolder: path.join(temp, id),
        gitBranch: `run-${id}`,
        startingConditions,
        serverPid: process.pid,
      },
    });
  };
  async function initialize(rigSetup: unknown[] = [write("rig.txt")], id = codonId) {
    const codon = createTestCodon({
      id,
      name: "Prepare",
      model: "sonnet",
      continuationMode: "fresh",
      promptText: "test",
      checkpointedFiles: ["**/*"],
      env: { RIG_VALUE: "from-codon" },
      rigSetup,
    });
    for (const item of codon.rigSetup ?? []) {
      if (item.type === "copy") item.copy.from = hank.ref(item.copy.from).path;
    }
    const logger = new Logger(path.join(temp, "state.log"));
    workspace = await Workspace.open(layout, { logger });
    manager = new StateManager(layout, logger, [codon]);
    manager.setWorkspace(workspace);
    await manager.initialize();
    await startRun("first");
  }
  const prepare = (options: Partial<PrepareCodonOptions> = {}, id = codonId) =>
    manager.prepareCodon(id, {
      hankDir: hank,
      onProgress: (event) => progress.push(event),
      loadSentinels: async () => ({ loaded: [], errors: [] }),
      ...options,
    });
  const failAttempt = async (id = codonId) => {
    const current = manager.getCurrentlyRunningCodon();
    const run = manager.getCurrentRun();
    if (!current || !run) throw new Error("Missing active attempt");
    await fire({
      type: "CodonTransitioned",
      data: {
        runId: run.runId,
        codonId: id,
        from: current.status,
        to: "failed",
        metadata: {
          exitCode: 1,
          failedDuring: current.status,
          failureReason: { type: "unknown", retriable: true, message: "test retry" },
        },
      },
    });
  };

  test("copies with hank rules, runs with lastCopied/env, loads sentinels before checkpointing", async () => {
    await initialize([
      { type: "copy", copy: { from: "template", to: "rig" } },
      shell(
        "require('node:fs').writeFileSync('env.txt', process.env.RIG_VALUE); console.log('rig ready')",
        "lastCopied",
      ),
    ]);
    const result = await prepare({
      loadSentinels: async () => {
        expect(read("rig/env.txt")).toBe("from-codon");
        expect(exists("rig/excluded.txt")).toBe(false);
        expect(manager.getCurrentlyRunningCodon()?.status).toBe("starting");
        expect(manager.getRigSetupCheckpointInRun(codonId, RunId("first"))).toBeNull();
        fs.writeFileSync(path.join(layout.agentRootPath, "sentinel.txt"), "loaded");
        return {
          loaded: ["watcher"],
          errors: [],
          sentinelStates: [
            {
              id: "watcher",
              model: "test",
              loadedAt: new Date().toISOString(),
              llmCallCount: 0,
              failedLLMCalls: 0,
              totalTriggers: 0,
              totalCost: 0,
              status: "active",
            },
          ],
        };
      },
    });
    expect(result.status).toBe("ready");
    expect(manager.getRigSetupCheckpointInRun(codonId, RunId("first"))).toBeTruthy();
    expect(manager.getCurrentlyRunningCodon()).toMatchObject({
      sentinels: { loaded: [{ id: "watcher" }] },
    });
    expect(progress.some((p) => p.type === "rig-output" && p.line === "rig ready")).toBe(true);
    expect(progress.at(-1)?.type).toBe("rig-completed");
    const checkpoint = await manager.currentCheckpoint();
    if (!checkpoint) throw new Error("Missing checkpoint");
    const recovery = await workspace.recovery.prepare({
      baseline: checkpoint,
      target: checkpoint,
      reason: "test",
      patterns: ["**/*"],
    });
    fs.writeFileSync(path.join(layout.agentRootPath, "sentinel.txt"), "changed");
    await recovery.restore();
    expect(read("sentinel.txt")).toBe("loaded");
  });

  test.each(["normal", "loop#2"])(
    "reuses checkpoint on %s retry but reloads sentinels",
    async (id) => {
      const runtimeId = CodonId(id);
      await initialize([shell("require('node:fs').appendFileSync('count.txt', 'x')")], runtimeId);
      await prepare({}, runtimeId);
      const sha = manager.getRigSetupCheckpointInRun(runtimeId, RunId("first"));
      if (!sha) throw new Error("Missing rig checkpoint");
      await failAttempt(runtimeId);
      const loadSentinels = mock(async () => ({ loaded: [], errors: [] }));
      const checkpoint = spyOn(manager, "createCheckpoint");
      expect(await prepare({ loadSentinels }, runtimeId)).toEqual({
        status: "ready",
        checkpointSha: sha,
      });
      expect(read("count.txt")).toBe("x");
      expect(loadSentinels).toHaveBeenCalledTimes(1);
      expect(checkpoint).not.toHaveBeenCalled();
    },
  );

  test("an earlier run's checkpoint does not skip setup in a new continuation", async () => {
    await initialize([shell("require('node:fs').appendFileSync('count.txt', 'x')")]);
    await prepare();
    await failAttempt();
    await fire({ type: "RunCompleted", data: { runId: RunId("first") } });
    await startRun("second", {
      type: "continuation",
      reason: "retry",
      source: {
        runId: RunId("first"),
        afterCodon: null,
        checkpointSha: "",
      },
    });
    await prepare();
    expect(read("count.txt")).toBe("xx");
  });

  test("rollback to a rig checkpoint reuses it even when start is delayed", async () => {
    await initialize([shell("require('node:fs').appendFileSync('count.txt', 'x')")]);
    await prepare();
    const sha = manager.getRigSetupCheckpointInRun(codonId, RunId("first"));
    if (!sha) throw new Error("Missing rig checkpoint");
    await failAttempt();
    const rollback = await manager.rollback({ type: "checkpoint", id: sha });
    if (!rollback) throw new Error("Missing rollback result");
    await startRun("second", rollback.continuation);
    expect(await prepare()).toEqual({ status: "ready", checkpointSha: sha });
    expect(read("count.txt")).toBe("x");
  });

  test.each(["replay", "skip", "empty"])("%s creates no rig checkpoint", async (mode) => {
    await initialize(mode === "empty" ? [] : undefined);
    const checkpoint = spyOn(manager, "createCheckpoint");
    const loadSentinels = mock(async () => ({ loaded: [], errors: [] }));
    const result = await prepare({
      replay: mode === "replay",
      skipRequested: mode === "skip",
      loadSentinels,
    });
    expect(result.status).toBe("ready");
    expect(exists("rig.txt")).toBe(false);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(loadSentinels).toHaveBeenCalledTimes(mode === "replay" ? 0 : 1);
  });

  test("rollback matches the exact rig checkpoint when history has multiple attempts", async () => {
    await initialize([shell("require('node:fs').appendFileSync('count.txt', 'x')")]);
    await prepare();
    await failAttempt();
    await prepare();
    // Older runtimes could create another rig checkpoint on a retry.
    const sha = await manager.createCheckpoint({
      status: "rig-setup",
      codonId,
      codonName: "Prepare",
      runId: RunId("first"),
      timestamp: new Date().toISOString(),
    });
    await manager.waitForPendingTransitions();
    await failAttempt();
    const rollback = await manager.rollback({ type: "checkpoint", id: sha });
    if (!rollback) throw new Error("Missing rollback result");
    await startRun("second", rollback.continuation);
    expect(await prepare()).toEqual({ status: "ready", checkpointSha: sha });
    expect(read("count.txt")).toBe("x");
  });

  test.each(["operation", "global"])(
    "%s ignored failures continue through checkpoint",
    async (mode) => {
      await initialize([
        { ...shell("process.exit(7)"), allowFailure: mode === "operation" },
        write("after.txt"),
      ]);
      expect((await prepare({ ignoreRigFailures: mode === "global" })).status).toBe("ready");
      expect(read("after.txt")).toBe("done");
      expect(progress).toContainEqual(
        expect.objectContaining({
          type: "rig-operation-failed",
          ignored: true,
          exitCode: 7,
          failureType: "command_failed",
        }),
      );
      expect(manager.getRigSetupCheckpointInRun(codonId, RunId("first"))).toBeTruthy();
    },
  );

  test("rig failures record preparing and retry the entire list", async () => {
    await initialize([
      shell("require('node:fs').appendFileSync('count.txt', 'x')"),
      shell("if (!require('node:fs').existsSync('allow.txt')) process.exit(7)"),
    ]);
    const loadSentinels = mock(async () => ({ loaded: [], errors: [] }));
    expect(await prepare({ loadSentinels })).toMatchObject({
      status: "failed",
      phase: "rig",
      exitCode: 7,
    });
    expect(loadSentinels).not.toHaveBeenCalled();
    expect(progress).toContainEqual(
      expect.objectContaining({
        type: "rig-operation-failed",
        ignored: false,
        exitCode: 7,
        failureType: "command_failed",
      }),
    );
    expect(manager.getCodonInCurrentRun(codonId)).toMatchObject({
      status: "failed",
      failedDuring: "preparing",
    });
    fs.writeFileSync(path.join(layout.agentRootPath, "allow.txt"), "");
    expect((await prepare()).status).toBe("ready");
    expect(read("count.txt")).toBe("xx");
    expect(manager.getCodonInCurrentRun(codonId)).toMatchObject({
      rigSetupCheckpoint: expect.any(String),
    });
    await failAttempt();
    expect((await prepare()).status).toBe("ready");
    expect(read("count.txt")).toBe("xx");
  });

  test("copy failure progress omits the exit code while failed state uses -1", async () => {
    await initialize([{ type: "copy", copy: { from: "template", to: "no-parent/target" } }]);
    expect(await prepare()).toMatchObject({ status: "failed", phase: "rig", exitCode: -1 });
    const failure = progress.find((event) => event.type === "rig-operation-failed");
    expect(failure).toMatchObject({ failureType: "other", ignored: false });
    expect(failure?.exitCode).toBeUndefined();
    expect(manager.getCodonInCurrentRun(codonId)).toMatchObject({
      status: "failed",
      failedDuring: "preparing",
      exitCode: -1,
    });
  });

  test.each([true, false])(
    "sentinel fatal=%s controls whether setup gets a checkpoint",
    async (fatal) => {
      await initialize();
      const result = await prepare({
        loadSentinels: async () => ({
          loaded: [],
          errors: [{ ref: "watcher", error: "cannot load", fatal }],
        }),
      });
      expect(result.status).toBe(fatal ? "failed" : "ready");
      if (fatal) {
        expect(result).toMatchObject({ phase: "sentinels", failureReason: { retriable: false } });
        expect(manager.getCodonInCurrentRun(codonId)).toMatchObject({ failedDuring: "starting" });
        expect(manager.getRigSetupCheckpointInRun(codonId, RunId("first"))).toBeNull();
      } else {
        expect(progress).toContainEqual(expect.objectContaining({ type: "sentinel-warning" }));
        expect(manager.getRigSetupCheckpointInRun(codonId, RunId("first"))).toBeTruthy();
      }
    },
  );

  test("checkpoint errors fail preparation before reporting completion", async () => {
    await initialize();
    spyOn(manager, "createCheckpoint").mockRejectedValue(new Error("disk full"));
    expect(await prepare()).toMatchObject({ status: "failed", phase: "checkpoint" });
    expect(manager.getCodonInCurrentRun(codonId)).toMatchObject({ failedDuring: "starting" });
    expect(progress.some((p) => p.type === "rig-completed")).toBe(false);
  });

  test.each(["rig", "sentinels"])(
    "shutdown during %s stops preparation without checkpointing",
    async (phase) => {
      await initialize([write("rig.txt"), write("later.txt")]);
      let shutdown = false;
      if (phase === "rig") {
        const original = workspace.rigs.runCommand.bind(workspace.rigs);
        spyOn(workspace.rigs, "runCommand").mockImplementation(async (...args) => {
          await original(...args);
          shutdown = true;
        });
      }
      const result = await prepare({
        shouldAbort: () => shutdown,
        loadSentinels: async () => {
          shutdown = true;
          return { loaded: [], errors: [] };
        },
      });
      expect(result.status).toBe("aborted");
      if (phase === "rig") expect(exists("later.txt")).toBe(false);
      expect(manager.getRigSetupCheckpointInRun(codonId, RunId("first"))).toBeNull();
      expect(progress.some((p) => p.type === "rig-completed")).toBe(false);
    },
  );
});
