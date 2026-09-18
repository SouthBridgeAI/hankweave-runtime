/**
 * Crash-safe recovery (intermediates/66-crash-safe-checkpoints).
 *
 * Replays the on-disk footprint of the superbench incident (block
 * SDR/NSF 25-320, GitHub #239) through the real `start()`:
 *
 *   - the checkpoint repository was killed between `git init` and its first
 *     commit (a folder with no refs, no objects, no index);
 *   - state.json holds a run whose first codon is `completed` with a
 *     checkpoint reference the torn repository cannot hold, and whose second
 *     codon was `running`;
 *   - runtime.lock names a dead pid, so the run is detected as crashed.
 *
 * On develop this boot died with "Checkpoint  not found in repository" and
 * the process exited 1. Now it must: rebuild the repo, refuse the dangling
 * reference as a rollback target, snapshot the work tree, announce the
 * degradation, and start a fresh run — with an answer still possible.
 *
 * The repository is reused whole or rebuilt empty, never partially, so every
 * reference dangles together: there is no "older confirmed checkpoint" case.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { HankweaveRuntime } from "../../server/hankweave-runtime.js";
import { StateManager } from "../../server/state-manager.js";
import { CodonId, RunId, SessionId } from "../../server/types/branded-types.js";
import type * as ST from "../../server/types/state-types.js";
import type { ServerEvent } from "../../server/types/types.js";
import { Logger } from "../../server/utils.js";
import { CheckpointStorageError, GitWorkspaceStorage } from "../../server/workspace/git-storage.js";
import { Workspace } from "../../server/workspace/index.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

const codons = [
  createTestCodon({
    id: "transform",
    name: "Transform",
    model: "sonnet",
    continuationMode: "fresh",
    promptText: "t",
  }),
  createTestCodon({
    id: "catalog",
    name: "Catalog",
    model: "sonnet",
    continuationMode: "fresh",
    promptText: "c",
  }),
  createTestCodon({
    id: "emit",
    name: "Emit",
    model: "sonnet",
    continuationMode: "fresh",
    promptText: "e",
  }),
];

describe("Runtime: crash-safe recovery from a torn checkpoint repo", () => {
  let execDir: string;
  let hankweaveDir: string;
  let runtime: HankweaveRuntime | undefined;

  const gitDir = () => path.join(hankweaveDir, "checkpoints", ".hankweavecheckpoints");

  const makeRuntime = (): HankweaveRuntime =>
    new HankweaveRuntime({
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

  async function git(args: string[]): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: execDir,
      env: { ...process.env, GIT_DIR: gitDir(), GIT_WORK_TREE: execDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out: out.trim() };
  }

  /**
   * Drive a StateManager through real transitions so state.json has the
   * production shape.
   */
  async function writeState(
    build: (
      sm: StateManager,
      helpers: {
        complete: (id: string, sha: string) => Promise<void>;
        run: (id: string) => Promise<void>;
      },
    ) => Promise<void>,
  ): Promise<RunId> {
    const runId = RunId("run-incident");
    const sm = new StateManager(
      new ExecutionLayout(execDir),
      new Logger(path.join(hankweaveDir, "logs/state.log")),
      codons,
    );
    await sm.initialize();
    sm.transition({
      type: "RunStarted",
      data: {
        runId,
        runFolder: path.join(hankweaveDir, "runs", runId),
        gitBranch: `run-${runId}`,
        startingConditions: { type: "fresh" },
        serverPid: 999999,
      },
    });
    const step = async (codonId: CodonId, t: { from: string; to: string; metadata?: unknown }) => {
      sm.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId,
          from: t.from as ST.CodonStatus,
          to: t.to as ST.CodonStatus,
          metadata: t.metadata as never,
        },
      });
      await sm.waitForPendingTransitions();
    };
    const run = async (id: string) => {
      const codonId = CodonId(id);
      sm.transition({ type: "CodonStarted", data: { runId, codonId } });
      await sm.waitForPendingTransitions();
      await step(codonId, { from: "preparing", to: "starting" });
      await step(codonId, {
        from: "starting",
        to: "initializing",
        metadata: { claudePid: 1, claudeLogPath: "x.log" },
      });
      await step(codonId, {
        from: "initializing",
        to: "running",
        metadata: { claudeSessionId: SessionId(`s-${id}`) },
      });
    };
    const complete = async (id: string, sha: string) => {
      await run(id);
      await step(CodonId(id), {
        from: "running",
        to: "completed",
        metadata: { checkpointSha: sha, exitCode: 0, resultMessageReceived: true },
      });
    };
    await build(sm, { complete, run });
    await sm.waitForPendingTransitions();
    return runId;
  }

  /**
   * Read state.json as the next boot would see it. StateManager.transition()
   * is fire-and-forget (a queue that saves to disk asynchronously), so a read
   * straight after start() can race the RunStarted save on a slow disk.
   */
  async function readPersistedState(): Promise<ST.HankweaveState> {
    await (
      runtime as unknown as { stateManager: StateManager }
    ).stateManager.waitForPendingTransitions();
    return JSON.parse(
      fs.readFileSync(path.join(hankweaveDir, "state.json"), "utf-8"),
    ) as ST.HankweaveState;
  }

  /** A well-formed checkpoint reference that no repository in these tests holds. */
  const DANGLING_SHA = "0123456789abcdef0123456789abcdef01234567";

  function deadLock(runId: RunId): void {
    fs.writeFileSync(
      path.join(hankweaveDir, "runtime.lock"),
      JSON.stringify({
        pid: 999999,
        runId,
        lastHeartbeat: new Date(Date.now() - 600_000).toISOString(),
      }),
    );
  }

  beforeEach(() => {
    fs.mkdirSync(path.resolve("tests", "test-area"), { recursive: true });
    execDir = fs.mkdtempSync(path.resolve("tests", "test-area", "crash-safe-recovery-"));
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

  test("the incident: torn repo + completed codon + crashed run boots and starts fresh", async () => {
    // 1. The repo as a kill between `git init` and the first commit leaves it.
    expect((await git(["init", "--initial-branch=main"])).code).toBe(0);
    expect((await git(["rev-parse", "--verify", "--quiet", "HEAD"])).code).not.toBe(0);

    // 2. The state: transform completed (its checkpoint died with the repo),
    //    catalog still running.
    const runId = await writeState(async (_sm, { complete, run }) => {
      await complete("transform", DANGLING_SHA);
      await run("catalog");
    });
    deadLock(runId);

    // Work the crashed run left behind — must survive the fresh-run fallback.
    fs.writeFileSync(path.join(execDir, "notes.md"), "uncheckpointed work from the crashed run");

    // 3. Boot.
    runtime = makeRuntime();
    const events: ServerEvent[] = [];
    runtime.on("event", (e: ServerEvent) => events.push(e));
    await runtime.start();

    // The repo was rebuilt, not trusted.
    expect((await git(["rev-parse", "--verify", "--quiet", "HEAD"])).code).toBe(0);
    const serverLog = fs.readFileSync(path.join(hankweaveDir, "logs/server.log"), "utf-8");
    expect(serverLog).toContain("has no resolvable HEAD; removing it and building a fresh one");
    // The crash was detected and the thread treated as failed.
    expect(serverLog).toContain("Execution thread failed, rolling back");
    // The dangling reference was refused as a target, loudly.
    expect(serverLog).toContain("has no git-confirmed completion checkpoint");
    expect(serverLog).toContain("Recovery degraded");
    // Nothing died: a new run exists and it is fresh.
    const state = await readPersistedState();
    expect(state.runs).toHaveLength(2);
    expect(state.runs.find((r) => r.runId === runId)?.status).toBe("crashed");
    const current = state.runs.find((r) => r.runId === state.currentRunId);
    expect(current?.runId).not.toBe(runId);
    expect(current?.startingConditions.type).toBe("fresh");
    // The work tree was snapshotted before the fallback, and the file is still there.
    const branches = (await git(["branch", "--list", "recovery/*", "--format=%(refname:short)"]))
      .out;
    expect(branches).toMatch(/^recovery\//);
    const snapshotFiles = (await git(["ls-tree", "-r", "--name-only", branches.split("\n")[0]]))
      .out;
    expect(snapshotFiles).toContain("notes.md");
    expect(fs.existsSync(path.join(execDir, "notes.md"))).toBe(true);
    // And the degraded recovery was announced as an event.
    const messages = events
      .filter((e) => e.type === "error")
      .map((e) => (e.data as { message: string }).message);
    expect(messages.some((m) => m.includes("Recovery degraded"))).toBe(true);
  }, 60_000);

  test("unreadable checkpoint storage stops the boot instead of starting fresh", async () => {
    const seed = await Workspace.open(new ExecutionLayout(execDir, { agentRootPath: execDir }), {
      logger: new Logger(path.join(hankweaveDir, "logs/seed.log")),
    });

    fs.writeFileSync(path.join(execDir, "transform.out"), "v1");
    const parent = await seed.checkpoints.history("main").tip();
    if (!parent) throw new Error("Missing initial checkpoint");
    const transformSha = await seed.checkpoints.history("run-run-incident").checkpoint({
      parent,
      message: "completed:transform",
      patterns: ["*.out"],
    });
    await writeState(async (_sm, { complete }) => {
      await complete("transform", transformSha as string);
    });

    // Enumeration fails after the repo was attached (a permissions problem at
    // init time makes HEAD unresolvable, and the repo is rebuilt instead).
    // Without the preflight, validation would be empty and start() would
    // snapshot and start fresh.
    const original = GitWorkspaceStorage.prototype.listSnapshots;
    GitWorkspaceStorage.prototype.listSnapshots = async () => {
      throw new CheckpointStorageError("injected: could not enumerate checkpoints");
    };
    try {
      runtime = makeRuntime();
      await expect(runtime.start()).rejects.toThrow(/checkpoint storage could not be read/);
    } finally {
      GitWorkspaceStorage.prototype.listSnapshots = original;
    }
    const state = await readPersistedState();
    expect(state.runs.length).toBe(1); // no fresh run was created
  }, 60_000);

  test("a non-failed history with no git-confirmed seed snapshots the work tree before a fresh run", async () => {
    // The newest codon is `completed` (terminal), so the thread is not failed
    // and the rollback ladder never runs; but git does not hold its
    // reference, so nothing can seed a continuation. A fresh run's rig setup
    // deletes copy.to directories — the pre-recovery work tree must be on a
    // recovery/* branch first.
    await Workspace.open(new ExecutionLayout(execDir, { agentRootPath: execDir }), {
      logger: new Logger(path.join(hankweaveDir, "logs/seed.log")),
    });

    fs.writeFileSync(path.join(execDir, "transform.out"), "uncheckpointed");

    await writeState(async (_sm, { complete }) => {
      await complete("transform", DANGLING_SHA);
    });

    runtime = makeRuntime();
    const events: ServerEvent[] = [];
    runtime.on("event", (e: ServerEvent) => events.push(e));
    await runtime.start();

    const state = await readPersistedState();
    const current = state.runs.find((r) => r.runId === state.currentRunId);
    expect(current?.startingConditions.type).toBe("fresh");
    const serverLog = fs.readFileSync(path.join(hankweaveDir, "logs/server.log"), "utf-8");
    expect(serverLog).toContain("newest completed codon transform");
    expect(serverLog).toContain("starting fresh instead");
    expect(
      events.some(
        (e) =>
          e.type === "error" &&
          (e.data as { message: string }).message.includes("Recovery degraded"),
      ),
    ).toBe(true);
    const branches = (await git(["branch", "--list", "recovery/*", "--format=%(refname:short)"]))
      .out;
    expect(branches).toMatch(/^recovery\//);
    expect((await git(["show", `${branches.split("\n")[0]}:transform.out`])).out).toBe(
      "uncheckpointed",
    );
  }, 60_000);
});
