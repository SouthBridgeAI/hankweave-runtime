import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import {
  type ArchiveResult,
  type LoopIterationCompletion,
  StateManager,
} from "../../server/state-manager.js";
import { CodonId, RunId, SessionId } from "../../server/types/branded-types.js";
import type * as ST from "../../server/types/state-types.js";
import type { CodonConfig } from "../../server/types/types.js";
import { Logger } from "../../server/utils.js";
import { Workspace } from "../../server/workspace/index.js";
import { createTestConfig } from "../utils/test-codon-factory.js";

describe("StateManager archive policy", () => {
  let directory: string;
  let layout: ExecutionLayout;
  let state: StateManager;
  let workspace: Workspace;
  let archives: ArchiveResult[];
  let iterations: LoopIterationCompletion[];
  let notifications: string[];
  const runId = RunId("archive-test");
  const config = {
    id: "work",
    name: "Work",
    model: "haiku",
    continuationMode: "fresh",
    promptText: "Work",
    archiveOnSuccess: ["scratch"],
    checkpointedFiles: ["scratch"],
  };
  const loopConfig = (limit = 1) =>
    createTestConfig({
      type: "loop",
      id: "batch",
      name: "Batch",
      codons: [config],
      terminateOn: { type: "iterationLimit", limit },
      archiveOnSuccess: ["shared.txt"],
    });
  const fire = async (event: ST.StateTransition) => {
    state.transition(event);
    await state.waitForPendingTransitions();
  };
  const initialize = async (configs: CodonConfig[]) => {
    const logger = new Logger(path.join(directory, "test.log"));
    workspace = await Workspace.open(layout, { logger });
    state = new StateManager(layout, logger, configs);
    state.setWorkspace(workspace);
    state.on("archivesProcessed", (result) => {
      archives.push(result);
      notifications.push(`archive:${result.codonId}`);
    });
    state.on("executionPlanChanged", (plan) => {
      expect(JSON.parse(fs.readFileSync(layout.statePath, "utf8")).executionPlan).toEqual(plan);
      notifications.push("plan");
    });
    state.on("loopIterationCompleted", (result) => {
      iterations.push(result);
      notifications.push(`iteration:${result.iteration}`);
    });
    await state.initialize();
    await fire({
      type: "RunStarted",
      data: {
        runId,
        runFolder: path.join(directory, "run"),
        gitBranch: "run-archive-test",
        startingConditions: { type: "fresh" },
        serverPid: process.pid,
      },
    });
  };
  const finish = async (id: string, skipped = false, checkpoint = true) => {
    const codonId = CodonId(id);
    const loopContext = state
      .getState()
      .executionPlan.find((entry) => entry.codonId === codonId)?.loopContext;
    await fire({ type: "CodonStarted", data: { runId, codonId, loopContext } });
    const step = (from: ST.CodonStatus, to: ST.CodonStatus, metadata?: Record<string, unknown>) =>
      fire({
        type: "CodonTransitioned",
        data: { runId, codonId, from, to, metadata },
      } as ST.StateTransition);
    await step("preparing", "starting");
    await step("starting", "initializing", { claudePid: 1, claudeLogPath: "test.log" });
    await step("initializing", "running", { claudeSessionId: SessionId(`session-${id}`) });
    const sha = checkpoint
      ? await state.createCheckpoint({
          status: skipped ? "skipped" : "completed",
          codonId,
          codonName: id,
          runId,
          timestamp: new Date().toISOString(),
        })
      : undefined;
    await step("running", skipped ? "skipped" : "completed", {
      ...(sha ? { checkpointSha: sha } : {}),
      exitCode: 0,
      resultMessageReceived: true,
      ...(skipped ? { skippedDuring: "running" } : {}),
    });
    expect(state.getCodonInCurrentRun(codonId)?.status).toBe(skipped ? "skipped" : "completed");
    return sha;
  };
  const write = (relative: string, body = relative) => {
    const file = path.join(layout.agentRootPath, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const entries = () => JSON.parse(fs.readFileSync(layout.archiveManifestPath, "utf8")).entries;

  beforeEach(() => {
    archives = [];
    iterations = [];
    notifications = [];
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "hw-state-archive-"));
    layout = new ExecutionLayout(directory);
    fs.mkdirSync(layout.agentRootPath, { recursive: true });
  });
  afterEach(async () => {
    mock.restore();
    await state?.waitForPendingTransitions();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("archives configured visible files under their codon owner and persisted checkpoint", async () => {
    await initialize([createTestConfig(config)]);
    write("scratch/result.txt");
    write("scratch/ignored.txt");
    write(".gitignore", "scratch/ignored.txt\n");
    write("keep.txt");
    const checkpoint = await finish("work");
    await state.finalizeCodon(CodonId("work"));
    expect(archives[0]).toEqual({
      codonId: "work",
      outcomes: [{ path: "scratch/result.txt", status: "archived" }],
    });
    expect(fs.existsSync(path.join(layout.agentRootPath, "scratch/result.txt"))).toBe(false);
    expect(fs.existsSync(path.join(layout.agentRootPath, "scratch/ignored.txt"))).toBe(true);
    expect(fs.existsSync(path.join(layout.agentRootPath, "keep.txt"))).toBe(true);
    expect(entries()).toMatchObject([
      {
        sourcePath: "scratch/result.txt",
        archivePath: path.join("rigArchive", "work", "scratch", "result.txt"),
        codonId: "work",
        checkpointSha: checkpoint,
      },
    ]);
    expect(entries()[0].loopContext).toBeUndefined();
  });

  test("keeps iteration and loop ownership separate, archiving shared files only after termination", async () => {
    await initialize([loopConfig(2)]);
    write("scratch/first.txt");
    write("shared.txt");
    await finish("work#0");
    await state.finalizeCodon(CodonId("work#0"));
    expect(archives.map((result) => result.codonId)).toEqual(["work#0"]);
    expect(state.getState().executionPlan.map((entry) => entry.codonId)).toEqual([
      CodonId("work#0"),
      CodonId("work#1"),
    ]);
    expect(iterations[0]).toMatchObject({ loopId: "batch", iteration: 0, isFinal: false });
    expect(fs.existsSync(path.join(layout.agentRootPath, "shared.txt"))).toBe(true);
    write("scratch/second.txt");
    const checkpoint = await finish("work#1");
    await state.finalizeCodon(CodonId("work#1"));
    expect(archives.at(-1)).toEqual({
      codonId: "batch",
      outcomes: [{ path: "shared.txt", status: "archived" }],
    });
    expect(notifications).toEqual([
      "archive:work#0",
      "plan",
      "iteration:0",
      "archive:work#1",
      "plan",
      "archive:batch",
      "iteration:1",
    ]);
    expect(iterations[1]).toMatchObject({
      loopId: "batch",
      iteration: 1,
      isFinal: true,
      terminationReason: "iteration_limit",
    });
    expect(entries()).toMatchObject([
      {
        archivePath: path.join("rigArchive", "batch-0", "work-0", "scratch", "first.txt"),
        loopContext: { loopId: "batch", iteration: 0 },
      },
      {
        archivePath: path.join("rigArchive", "batch-1", "work-1", "scratch", "second.txt"),
        loopContext: { loopId: "batch", iteration: 1 },
      },
      {
        archivePath: path.join("rigArchive", "batch-loop", "shared.txt"),
        codonId: "batch",
        checkpointSha: checkpoint,
      },
    ]);
  });

  for (const checkpoint of [true, false]) {
    test(`skipped codon does not archive its files but can end a loop (${checkpoint ? "checkpoint" : "orphan"})`, async () => {
      await initialize([loopConfig()]);
      write("scratch/result.txt");
      write("shared.txt");
      const sha = await finish("work#0", true, checkpoint);
      await state.finalizeCodon(CodonId("work#0"));
      expect(archives.map((result) => result.codonId)).toEqual(["batch"]);
      expect(fs.existsSync(path.join(layout.agentRootPath, "scratch/result.txt"))).toBe(true);
      expect(entries()).toMatchObject([
        { sourcePath: "shared.txt", checkpointSha: sha ?? "orphan" },
      ]);
    });
  }

  test("ignores unfinished codons and completed codons without archive configuration", async () => {
    await initialize([createTestConfig({ ...config, archiveOnSuccess: undefined })]);
    write("scratch/result.txt");
    await state.finalizeCodon(CodonId("work"));
    expect(archives).toEqual([]);
    await finish("work");
    await state.finalizeCodon(CodonId("work"));
    expect(archives).toEqual([]);
    expect(fs.existsSync(path.join(layout.agentRootPath, "scratch/result.txt"))).toBe(true);
  });

  test("shutdown prevents selection and is forwarded to archive mutations", async () => {
    await initialize([createTestConfig(config)]);
    write("scratch/result.txt");
    await finish("work");
    const select = spyOn(workspace.files, "select");
    await state.finalizeCodon(CodonId("work"), { shouldAbort: () => true });
    expect(notifications).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    const archive = spyOn(workspace.archives, "archive");
    const shouldAbort = () => false;
    await state.finalizeCodon(CodonId("work"), { shouldAbort });
    expect(archive.mock.calls[0][3]?.shouldAbort).toBe(shouldAbort);
  });

  test("enumeration failures remain best effort and per-file failures are returned for reporting", async () => {
    await initialize([createTestConfig(config)]);
    write("scratch/result.txt");
    await finish("work");
    spyOn(workspace.files, "select").mockImplementationOnce(() => {
      throw new Error("cannot enumerate");
    });
    await state.finalizeCodon(CodonId("work"));
    expect(archives).toEqual([]);
    const outcomes = [
      { path: "scratch/result.txt", status: "archived" as const },
      { path: "scratch/other.txt", status: "failed" as const, error: "cannot copy" },
    ];
    spyOn(workspace.archives, "archive").mockResolvedValueOnce(outcomes);
    await state.finalizeCodon(CodonId("work"));
    expect(archives[0]).toEqual({
      codonId: "work",
      outcomes,
    });
    expect(state.getCodonInCurrentRun(CodonId("work"))?.status).toBe("completed");
  });

  test("startup loads archive metadata and rejects a corrupt manifest", async () => {
    fs.mkdirSync(path.dirname(layout.archiveManifestPath), { recursive: true });
    fs.writeFileSync(layout.archiveManifestPath, "broken json");
    await expect(initialize([createTestConfig(config)])).rejects.toThrow();
  });

  test("an unchanged plan mid-iteration does not archive loop files or report iteration completion", async () => {
    await initialize([
      createTestConfig({
        type: "loop",
        id: "batch",
        name: "Batch",
        codons: [config, { ...config, id: "review" }],
        terminateOn: { type: "iterationLimit", limit: 1 },
        archiveOnSuccess: ["shared.txt"],
      }),
    ]);
    write("shared.txt");
    await finish("work#0");
    await state.finalizeCodon(CodonId("work#0"));
    expect(archives.map((result) => result.codonId)).toEqual(["work#0"]);
    expect(iterations).toEqual([]);
    expect(fs.existsSync(path.join(layout.agentRootPath, "shared.txt"))).toBe(true);
    await finish("review#0");
    await state.finalizeCodon(CodonId("review#0"));
    expect(archives.at(-1)?.codonId).toBe("batch");
    expect(iterations).toHaveLength(1);
  });

  for (const stage of ["archivesProcessed", "executionPlanChanged"] as const) {
    test(`shutdown after ${stage} stops the remaining finalization stages`, async () => {
      await initialize([loopConfig()]);
      write("scratch/result.txt");
      write("shared.txt");
      await finish("work#0");
      let shuttingDown = false;
      state.on(stage, () => {
        shuttingDown = true;
      });
      await state.finalizeCodon(CodonId("work#0"), { shouldAbort: () => shuttingDown });
      expect(notifications).toEqual(["archive:work#0", "plan"]);
      expect(fs.existsSync(path.join(layout.agentRootPath, "shared.txt"))).toBe(true);
    });
  }

  test("shutdown during finalization still persists the loop's next iteration", async () => {
    await initialize([loopConfig(3)]);
    write("scratch/result.txt");
    await finish("work#0");
    await state.finalizeCodon(CodonId("work#0"), { shouldAbort: () => true });
    expect(notifications).toEqual(["plan"]);
    expect(state.getState().executionPlan.map((entry) => entry.codonId)).toEqual([
      CodonId("work#0"),
      CodonId("work#1"),
    ]);
    expect(await state.getNextCodonToExecute()).toBe(CodonId("work#1"));
  });

  test("an ignored failure advances and reports its iteration without archiving success files", async () => {
    await initialize([loopConfig()]);
    write("scratch/result.txt");
    write("shared.txt");
    const codonId = CodonId("work#0");
    const loopContext = state.getState().executionPlan[0].loopContext;
    await fire({ type: "CodonStarted", data: { runId, codonId, loopContext } });
    await fire({
      type: "CodonTransitioned",
      data: {
        runId,
        codonId,
        from: "preparing",
        to: "failed",
        metadata: {
          exitCode: 1,
          failedDuring: "preparing",
          failureReason: { type: "unknown", retriable: false, message: "test failure" },
        },
      },
    });
    await state.finalizeCodon(codonId);
    expect(notifications).toEqual([]);
    await state.finalizeCodon(codonId, { failureIgnored: true });
    expect(notifications).toEqual(["plan", "iteration:0"]);
    expect(fs.existsSync(path.join(layout.agentRootPath, "scratch/result.txt"))).toBe(true);
    expect(fs.existsSync(path.join(layout.agentRootPath, "shared.txt"))).toBe(true);
  });

  test("context exhaustion can finish an iteration early and reports state-derived totals", async () => {
    await initialize([
      createTestConfig({
        type: "loop",
        id: "batch",
        name: "Batch",
        codons: [config, { ...config, id: "review" }],
        terminateOn: { type: "contextExceeded" },
        archiveOnSuccess: ["shared.txt"],
      }),
    ]);
    write("shared.txt");
    await finish("work#0");
    const codon = state.getCodonInCurrentRun(CodonId("work#0"));
    if (codon?.status !== "completed") throw new Error("Expected completed codon");
    await state.finalizeCodon(CodonId("work#0"), { contextExceeded: true });
    expect(state.getState().executionPlan.map((entry) => entry.codonId)).toEqual([
      CodonId("work#0"),
    ]);
    expect(iterations).toEqual([
      {
        loopId: CodonId("batch"),
        iteration: 0,
        isFinal: true,
        terminationReason: "context_exceeded",
        costUsd: codon.finalCost,
        tokensUsed: codon.finalTokens.inputTokens + codon.finalTokens.outputTokens,
        durationMs: Math.max(0, Date.parse(codon.endTime) - Date.parse(codon.startTime)),
      },
    ]);
    expect(notifications).toEqual(["archive:work#0", "plan", "archive:batch", "iteration:0"]);
  });
});
