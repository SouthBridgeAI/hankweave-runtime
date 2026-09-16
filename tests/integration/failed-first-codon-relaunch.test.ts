/**
 * Relaunch after the FIRST codon failed (PR #242 review, finding 1).
 *
 * The everyday "it failed, run it again" workflow, through the real `start()`:
 *
 *   - codon `one` has a rig; it ran (rig-setup checkpoint), then the codon
 *     failed naturally (error checkpoint). No codon has ever completed.
 *   - the run ended as failed; the user relaunches.
 *
 * Recovery must retry `one`, not continue past it: roll back to one's
 * rig-setup checkpoint, record the continuation as afterCodon: null, and
 * name `one` as the next codon to execute (with the rig skipped, since the
 * work tree is already in the post-rig state). Rolling back to the error
 * checkpoint instead records afterCodon: one and silently skips to `two`.
 *
 * This reads the outcome, not the mechanism; findRollbackTarget's unit tests
 * pin the target choice.
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
import { Logger } from "../../server/utils.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

const codons = [
  createTestCodon({
    id: "one",
    name: "One",
    model: "sonnet",
    continuationMode: "fresh",
    promptText: "1",
    rigSetup: [{ type: "copy", copy: { from: "rig-template", to: "one-rig" } }],
  }),
  createTestCodon({
    id: "two",
    name: "Two",
    model: "sonnet",
    continuationMode: "fresh",
    promptText: "2",
  }),
  createTestCodon({
    id: "three",
    name: "Three",
    model: "sonnet",
    continuationMode: "fresh",
    promptText: "3",
  }),
];

let execDir: string;
let hankweaveDir: string;
let runtime: HankweaveRuntime | undefined;

beforeEach(() => {
  fs.mkdirSync(path.resolve("tests", "test-area"), { recursive: true });
  execDir = fs.mkdtempSync(path.resolve("tests", "test-area", "failed-first-codon-"));
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

test("relaunch after the first codon failed retries that codon, not the next one", async () => {
  const runId = RunId("run-incident");
  const one = CodonId("one");

  // 1. Two real checkpoints on the run's branch: rig-setup:one, then error:one.
  const seed = new CheckpointGit(
    execDir,
    execDir,
    new Logger(path.join(hankweaveDir, "logs/seed.log")),
  );
  await seed.initialize();
  await seed.addPatterns(["*.out"]);
  await seed.switchToBranch(`run-${runId}`);
  fs.writeFileSync(path.join(execDir, "one.out"), "after rig");
  const RIG = (await seed.commit("rig-setup:one")) as string;
  fs.writeFileSync(path.join(execDir, "one.out"), "partial work before failure");
  const ERR = (await seed.commit("error:one")) as string;

  // 2. state.json through the real state manager, in the order the runtime
  //    fires the transitions: rig ran → `starting` carries the rig-setup SHA →
  //    CheckpointCreated(rig-setup) → … → failed with the error SHA.
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
  const step = (from: ST.CodonStatus, to: ST.CodonStatus, metadata?: unknown) =>
    fire({ type: "CodonTransitioned", data: { runId, codonId: one, from, to, metadata } });

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
  await fire({ type: "CodonStarted", data: { runId, codonId: one } });
  await step("preparing", "starting", { checkpointSha: RIG });
  await fire({
    type: "CheckpointCreated",
    data: { runId, codonId: one, checkpointType: "rig-setup", sha: RIG, branch: `run-${runId}` },
  });
  await step("starting", "initializing", { claudePid: 1, claudeLogPath: "x.log" });
  await step("initializing", "running", { claudeSessionId: SessionId("s-one") });
  await step("running", "failed", {
    exitCode: 1,
    failureReason: { type: "unknown", retriable: false, message: "boom" },
    failedDuring: "running",
    checkpointSha: ERR,
  });
  await fire({ type: "RunFailed", data: { runId } });

  const persisted = JSON.parse(
    fs.readFileSync(path.join(hankweaveDir, "state.json"), "utf-8"),
  ) as ST.HankweaveState;
  expect(persisted.runs[0].codons[0]).toMatchObject({
    status: "failed",
    rigSetupCheckpoint: RIG,
    errorCheckpoint: ERR,
  });

  // 3. Relaunch. autostart is off so the recovery decision can be inspected
  //    instead of a codon being started.
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
  await runtime.start();

  const internals = runtime as unknown as { stateManager: StateManager };
  await internals.stateManager.waitForPendingTransitions();
  const state = internals.stateManager.getState();
  const current = state.runs.find((r) => r.runId === state.currentRunId);
  expect(current?.startingConditions.type).toBe("continuation");
  const source =
    current?.startingConditions.type === "continuation" ? current.startingConditions.source : null;

  // Rolled back to the rig-setup checkpoint, recorded as "from the beginning",
  // and the failed codon is the one to run next.
  expect(source?.checkpointSha).toBe(RIG);
  expect(source?.afterCodon).toBeNull();
  expect(await internals.stateManager.getNextCodonToExecute()).toBe(one);

  // The work tree is at the post-rig state, not the mid-failure state.
  expect(fs.readFileSync(path.join(execDir, "one.out"), "utf-8")).toBe("after rig");
}, 60_000);
