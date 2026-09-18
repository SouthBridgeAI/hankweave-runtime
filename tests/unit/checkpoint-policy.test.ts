import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { StateManager } from "../../server/state-manager.js";
import { CodonId, RunId, SessionId } from "../../server/types/branded-types.js";
import type { CodonStatus, StateTransition } from "../../server/types/state-types.js";
import type { CheckpointInfo, CodonConfig } from "../../server/types/types.js";
import { Logger } from "../../server/utils.js";
import type { CheckpointId } from "../../server/workspace/checkpoints.js";
import { Workspace } from "../../server/workspace/index.js";
import { createTestCodon, createTestConfig } from "../utils/test-codon-factory.js";

describe("checkpoint policy follows the execution position", () => {
  let directory: string;
  let layout: ExecutionLayout;
  let workspace: Workspace;
  let state: StateManager;
  let logger: Logger;
  let configs: CodonConfig[];

  async function reopen(): Promise<void> {
    workspace = await Workspace.open(layout, { logger });

    state = new StateManager(layout, logger, configs);
    state.setWorkspace(workspace);
    await state.initialize();
  }

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-checkpoint-policy-"));
    layout = new ExecutionLayout(directory);
    fs.mkdirSync(layout.agentRootPath, { recursive: true });
    logger = new Logger(path.join(directory, "test.log"));
    const codon = (id: string, checkpointedFiles: string[]) =>
      ({
        id,
        name: id,
        model: "haiku",
        continuationMode: "fresh",
        promptText: id,
        checkpointedFiles,
      }) as const;
    configs = [
      createTestCodon(codon("empty", [])),
      createTestCodon(codon("collect", ["*.txt"])),
      createTestConfig({
        type: "loop",
        id: "loop",
        name: "Loop",
        codons: [codon("work", ["*.py", "notes/**/*", "!report.txt"])],
        terminateOn: { type: "iterationLimit", limit: 3 },
      }),
    ];
    await reopen();
    state.transition({
      type: "RunStarted",
      data: {
        runId: RunId("initial"),
        runFolder: path.join(directory, "initial"),
        gitBranch: "run-initial",
        startingConditions: { type: "fresh" },
        serverPid: process.pid,
      },
    });
    await state.waitForPendingTransitions();
  });

  afterEach(async () => {
    await state?.waitForPendingTransitions();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const put = (file: string, content: string) =>
    fs.writeFileSync(path.join(layout.agentRootPath, file), content);

  function git(...args: string[]): string {
    const result = Bun.spawnSync(
      [
        "git",
        `--git-dir=${path.join(layout.checkpointsPath, ExecutionLayout.CHECKPOINT_GIT)}`,
        ...args,
      ],
      { cwd: directory },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }

  async function checkpoint(
    codonId: string,
    status: CheckpointInfo["status"] = "completed",
  ): Promise<CheckpointId> {
    const run = state.getCurrentRun();
    if (!run) throw new Error("Test checkpoint requires a current run");
    const id = await state.createCheckpoint({
      codonId: CodonId(codonId),
      codonName: codonId,
      runId: run.runId,
      status,
      timestamp: new Date().toISOString(),
    });
    await state.waitForPendingTransitions();
    return id;
  }

  async function completeCodon(id: string, checkpointSha: CheckpointId): Promise<void> {
    const runId = RunId("initial");
    const codonId = CodonId(id);
    const fire = async (event: StateTransition) => {
      state.transition(event);
      await state.waitForPendingTransitions();
    };
    await fire({ type: "CodonStarted", data: { runId, codonId } });
    const step = (from: CodonStatus, to: CodonStatus, metadata?: Record<string, unknown>) =>
      fire({
        type: "CodonTransitioned",
        data: { runId, codonId, from, to, metadata },
      } as StateTransition);
    await step("preparing", "starting");
    await step("starting", "initializing", { claudePid: 1, claudeLogPath: "test.log" });
    await step("initializing", "running", { claudeSessionId: SessionId(`session-${id}`) });
    await step("running", "completed", { checkpointSha, exitCode: 0, resultMessageReceived: true });
  }

  test("rollback drops later inclusions and exclusions, with the same result after reopening", async () => {
    put("report.txt", "v1");
    const first = await checkpoint("collect");
    await completeCodon("collect", first);
    put("report.txt", "excluded edit");
    put("script.py", "later output");
    const later = await checkpoint("work#0");
    await completeCodon("work#0", later);
    expect(git("show", `${later}:report.txt`)).toBe("v1");
    expect(git("show", `${later}:script.py`)).toBe("later output");

    await state.rollback({ type: "checkpoint", id: first });
    state.transition({
      type: "RunStarted",
      data: {
        runId: RunId("rollback"),
        runFolder: path.join(directory, "rollback"),
        gitBranch: "run-rollback",
        startingConditions: {
          type: "continuation",
          source: { runId: RunId("initial"), afterCodon: null, checkpointSha: first },
          reason: "rollback",
        },
        serverPid: process.pid,
      },
    });
    await state.waitForPendingTransitions();

    put("report.txt", "v2");
    put("script.py", "outside the current policy");
    const live = await checkpoint("collect", "rig-setup");
    expect(git("show", `${live}:report.txt`)).toBe("v2");
    expect(git("ls-tree", "-r", "--name-only", live)).not.toContain("script.py");

    await reopen();
    const restarted = await checkpoint("collect", "rig-setup");
    expect(git("rev-parse", `${restarted}^{tree}`)).toBe(git("rev-parse", `${live}^{tree}`));
  });

  test("an empty effective policy records deletions but no file additions or edits", async () => {
    put("report.txt", "v1");
    put("deleted.txt", "delete me");
    await checkpoint("collect");
    put("report.txt", "v2");
    put("new.txt", "do not stage");
    fs.rmSync(path.join(layout.agentRootPath, "deleted.txt"));

    const empty = await checkpoint("empty");
    expect(git("ls-tree", "-r", "--name-only", empty)).toBe("report.txt");
    expect(git("show", `${empty}:report.txt`)).toBe("v1");
  });

  test("every checkpoint status includes the current loop iteration's policy after restart", async () => {
    await state.expandNextIterationForCodon({ codonId: CodonId("work#0") });
    await reopen();
    put("earlier.txt", "from the preceding codon");
    put("report.txt", "excluded by the loop");

    for (const status of ["rig-setup", "completed", "error", "skipped", "exit"] as const) {
      put("script.py", status);
      const id = await checkpoint("work#1", status);
      expect(git("show", `${id}:earlier.txt`)).toBe("from the preceding codon");
      expect(git("show", `${id}:script.py`)).toBe(status);
      expect(git("ls-tree", "-r", "--name-only", id)).not.toContain("report.txt");
    }
  });

  test("a codon missing from the plan fails before creating a checkpoint or switching branches", async () => {
    const head = await workspace.checkpoints.history("run-initial").tip();
    const branch = git("branch", "--show-current");
    await expect(checkpoint("missing")).rejects.toThrow("not in the execution plan");
    expect(await workspace.checkpoints.history("run-initial").tip()).toBe(head);
    expect(git("branch", "--show-current")).toBe(branch);
  });

  test.skipIf(process.platform === "win32")(
    "a crashed planner cannot become a fourth candidate after reopening and walking checkpoints",
    async () => {
      // The source checkpoint predates the loop's notes/**/* ownership.
      const target = await checkpoint("empty");
      await completeCodon("empty", target);
      state.transition({
        type: "CodonStarted",
        data: { runId: RunId("initial"), codonId: CodonId("work#0") },
      });
      await state.waitForPendingTransitions();
      const rig = await checkpoint("work#0", "rig-setup");
      fs.mkdirSync(path.join(layout.agentRootPath, "notes"));
      put("notes/plan.md", "plan from crashed attempt");
      put("report.txt", "excluded by the failed loop's policy");
      put("scratch.md", "not checkpoint-owned");
      state.transition({
        type: "RunCrashed",
        data: {
          runId: RunId("initial"),
          detectedAt: new Date().toISOString(),
          lastCodonStatus: "preparing",
        },
      });
      await state.waitForPendingTransitions();
      await reopen();

      let snapshotId: CheckpointId | undefined;
      const result = await state.rollback(
        { type: "checkpoint", id: target },
        {
          onProgress: (event) => {
            if (event.type === "snapshot") snapshotId = event.snapshot.snapshotId;
          },
        },
      );
      expect(snapshotId).toBeDefined();
      expect(result?.checkpoint).toBe(target);
      expect(await workspace.checkpoints.history("run-initial").tip()).toBe(rig);
      expect(fs.existsSync(path.join(layout.agentRootPath, "notes/plan.md"))).toBe(false);
      expect(git("show", `${snapshotId}:notes/plan.md`)).toBe("plan from crashed attempt");
      expect(fs.readFileSync(path.join(layout.agentRootPath, "report.txt"), "utf8")).toBe(
        "excluded by the failed loop's policy",
      );
      expect(fs.existsSync(path.join(layout.agentRootPath, "scratch.md"))).toBe(true);

      state.transition({
        type: "RunStarted",
        data: {
          runId: RunId("retry"),
          runFolder: path.join(directory, "retry"),
          gitBranch: "run-retry",
          startingConditions: {
            type: "continuation",
            source: { runId: RunId("initial"), afterCodon: null, checkpointSha: target },
            reason: "rollback",
          },
          serverPid: process.pid,
        },
      });
      await state.waitForPendingTransitions();

      // The actual v6-planloop rig command, run before each planner and once
      // before consolidation. The next filename depends on what survived.
      const rigSetup = () =>
        execFileSync(
          "sh",
          [
            "-c",
            "mkdir -p notes/candidates; if [ -f notes/plan.md ]; then n=$(( $(ls notes/candidates 2>/dev/null | wc -l) + 1 )); mv notes/plan.md notes/candidates/plan_$n.md; fi",
          ],
          { cwd: layout.agentRootPath },
        );
      for (let iteration = 0; iteration < 3; iteration++) {
        rigSetup();
        await checkpoint(`work#${iteration}`, "rig-setup");
        put("notes/plan.md", `successful plan ${iteration}`);
        await checkpoint(`work#${iteration}`);
        await state.expandNextIterationForCodon({ codonId: CodonId(`work#${iteration}`) });
      }
      rigSetup();
      const candidates = path.join(layout.agentRootPath, "notes/candidates");
      expect(fs.readdirSync(candidates).sort()).toEqual(["plan_1.md", "plan_2.md", "plan_3.md"]);
      for (let iteration = 0; iteration < 3; iteration++) {
        expect(fs.readFileSync(path.join(candidates, `plan_${iteration + 1}.md`), "utf8")).toBe(
          `successful plan ${iteration}`,
        );
      }
    },
  );
});
