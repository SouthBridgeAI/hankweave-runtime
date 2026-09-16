/**
 * Manual rollback walks the thread codon by codon (PR #242 review, finding 6).
 *
 * rollback.toCodon and rollback.toCheckpoint build their thread through the
 * state manager, with git's checkpoint map. The codon-by-codon walk steps
 * through each intermediate codon's git-confirmed checkpoint and emits a
 * rollback.codonCheckpoint event per codon; a thread built without the map
 * has empty validatedCheckpoints, walks nothing, and emits only the final
 * target event — the work tree ends in the right place, but the TUI shows no
 * progress and the walk differs from automatic recovery's.
 *
 * Three completed codons, roll back to the first: three per-codon events
 * (two intermediates + the target) and the target's file content restored.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { CheckpointGit } from "../../server/checkpoint-git.js";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { HankweaveRuntime } from "../../server/hankweave-runtime.js";
import { StateManager } from "../../server/state-manager.js";
import { CodonId, RunId, SessionId } from "../../server/types/branded-types.js";
import type * as ST from "../../server/types/state-types.js";
import type { ServerEvent } from "../../server/types/types.js";
import { Logger } from "../../server/utils.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

const ids = ["one", "two", "three"];
const codons = ids.map((id) =>
  createTestCodon({ id, name: id, model: "sonnet", continuationMode: "fresh", promptText: id }),
);

let execDir: string;
let hankweaveDir: string;
let runtime: HankweaveRuntime | undefined;

beforeEach(() => {
  fs.mkdirSync(path.resolve("tests", "test-area"), { recursive: true });
  execDir = fs.mkdtempSync(path.resolve("tests", "test-area", "manual-rollback-walk-"));
  hankweaveDir = path.join(execDir, ".hankweave");
  for (const d of ["logs", "events", "runs", "checkpoints"]) {
    fs.mkdirSync(path.join(hankweaveDir, d), { recursive: true });
  }
});

afterEach(async () => {
  try {
    await runtime?.shutdown("test cleanup", false);
  } catch {
    // best-effort
  }
  runtime = undefined;
  fs.rmSync(execDir, { recursive: true, force: true });
});

test("rollback.toCodon emits a rollback.codonCheckpoint event for every codon it walks", async () => {
  const runId = RunId("run-1");

  // 1. Three real completion checkpoints on the run's branch.
  const seed = new CheckpointGit(
    execDir,
    execDir,
    new Logger(path.join(hankweaveDir, "logs/seed.log")),
  );
  await seed.initialize();
  await seed.addPatterns(["*.out"]);
  await seed.switchToBranch(`run-${runId}`);
  const shas: Record<string, string> = {};
  for (const id of ids) {
    fs.writeFileSync(path.join(execDir, `${id}.out`), id);
    shas[id] = (await seed.commit(`completed:${id}`)) as string;
  }

  // 2. state.json through the real state manager: three completed codons.
  const sm = new StateManager(
    new ExecutionLayout(execDir),
    new Logger(path.join(hankweaveDir, "logs/state.log")),
    codons,
  );
  await sm.initialize();
  const fire = (event: unknown) => {
    sm.transition(event as never);
    return sm.waitForPendingTransitions();
  };
  await fire({
    type: "RunStarted",
    data: {
      runId,
      runFolder: path.join(hankweaveDir, "runs", runId),
      gitBranch: `run-${runId}`,
      startingConditions: { type: "fresh" },
      serverPid: 999999,
    },
  });
  for (const id of ids) {
    const codonId = CodonId(id);
    const step = (from: ST.CodonStatus, to: ST.CodonStatus, metadata?: unknown) =>
      fire({ type: "CodonTransitioned", data: { runId, codonId, from, to, metadata } });
    await fire({ type: "CodonStarted", data: { runId, codonId } });
    await step("preparing", "starting");
    await step("starting", "initializing", { claudePid: 1, claudeLogPath: "x.log" });
    await step("initializing", "running", { claudeSessionId: SessionId(`s-${id}`) });
    await step("running", "completed", {
      checkpointSha: shas[id],
      exitCode: 0,
      resultMessageReceived: true,
    });
  }
  await fire({ type: "RunCompleted", data: { runId } });

  // 3. Boot (autostart off), then roll back to the first codon by command.
  runtime = new HankweaveRuntime({
    autostart: false,
    headless: true,
    port: 0,
    cwd: execDir,
    executionPath: execDir,
    agentRootPath: execDir,
    rigArchivePath: path.join(execDir, "rigArchive"),
    dataPathInExecutionDir: execDir,
    readOnlySourceDataPath: execDir,
    dataHash: "test-hash",
    isNewExecution: false,
    isResuming: true,
    linkType: "symlink",
    codons,
    socketLogFile: path.join(hankweaveDir, "logs/socket.jsonl"),
    serverLogFile: path.join(hankweaveDir, "logs/server.log"),
    outputDirectory: execDir,
    sentinel: {
      enablePersistence: false,
      healthCheckGracePeriodMs: 0,
      waitForAllHealthChecks: false,
    },
    logParsingInterval: 5,
    dataHashTimeLimit: 5000,
    toolResultTruncateLength: 2500,
    withoutProxy: true,
    handshakeHistoryLimit: 50,
    version: "1.0.0",
    lockFile: path.join(hankweaveDir, "runtime.lock"),
  });
  const events: ServerEvent[] = [];
  runtime.on("event", (e: ServerEvent) => events.push(e));
  await runtime.start();
  events.length = 0;

  const internals = runtime as unknown as {
    rollbackToCodon: (id: CodonId, type: "completed", autoRestart: boolean) => Promise<void>;
    stateManager: StateManager;
  };
  await internals.rollbackToCodon(CodonId("one"), "completed", false);
  await internals.stateManager.waitForPendingTransitions();

  const errors = events.filter((e) => e.type === "error");
  expect(errors).toEqual([]);

  // Newest first: the two intermediates, then the target.
  const walked = events
    .filter((e) => e.type === "rollback.codonCheckpoint")
    .map((e) => (e as { data: { codonId: string } }).data.codonId);
  expect(walked).toEqual(["three", "two", "one"]);

  // And the work tree is at the target.
  expect(fs.readFileSync(path.join(execDir, "one.out"), "utf-8")).toBe("one");
  const current = internals.stateManager.getState();
  const run = current.runs.find((r) => r.runId === current.currentRunId);
  expect(run?.startingConditions.type).toBe("continuation");
  if (run?.startingConditions.type === "continuation") {
    expect(run.startingConditions.source.checkpointSha).toBe(shas.one);
  }
}, 60_000);
