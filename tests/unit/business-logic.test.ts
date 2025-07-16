import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { rmSync } from "fs";
import { StateManager } from "../../server/state-manager.js";
import { PhaseId, RunId, SessionId } from "../../server/branded-types.js";
import { Logger } from "../../server/utils.js";
import type { PhaseConfig } from "../../server/types.js";
import { StateBuilder, createCompletedPhase } from "../utils/mock-builders.js";

describe("StateManager - getNextPhaseToExecute", () => {
  let tempDir: string;
  let stateManager: StateManager;
  const mockPhases: PhaseConfig[] = [
    {
      id: PhaseId("phase-1"),
      name: "Phase 1",
      model: "sonnet",
      continuationMode: "fresh",
    },
    {
      id: PhaseId("phase-2"),
      name: "Phase 2",
      model: "sonnet",
      continuationMode: "fresh",
    },
    {
      id: PhaseId("phase-3"),
      name: "Phase 3",
      model: "sonnet",
      continuationMode: "fresh",
    },
  ];

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-state-${Date.now()}`);
    await fs.promises.mkdir(path.join(tempDir, ".langton"), {
      recursive: true,
    });

    const logger = new Logger(path.join(tempDir, "test.log"));
    stateManager = new StateManager(
      path.join(tempDir, ".langton"),
      logger,
      mockPhases
    );
    await stateManager.initialize();
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns first phase when no phases completed", async () => {
    // Start a new run
    const runId = RunId("test-run-1");
    stateManager.transition({
      type: "RunStarted",
      data: {
        runId,
        runFolder: path.join(tempDir, ".langton", "runs", runId),
        gitBranch: `run-${runId}`,
        startingConditions: { type: "fresh" },
        serverPid: process.pid,
      },
    });

    await stateManager.waitForPendingTransitions();

    const nextPhase = stateManager.getNextPhaseToExecute();
    expect(nextPhase).toBe(PhaseId("phase-1"));
  });

  test("returns next phase after one completed", async () => {
    // Start a run with one completed phase
    const runId = RunId("test-run-2");
    const state = new StateBuilder()
      .withRun({ runId })
      .withCurrentRun(runId)
      .withPhaseInRun(runId, createCompletedPhase("phase-1", "session-1"))
      .build();

    // Directly set the state (for testing)
    await fs.promises.writeFile(
      path.join(tempDir, ".langton", "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const nextPhase = stateManager.getNextPhaseToExecute();
    expect(nextPhase).toBe(PhaseId("phase-2"));
  });

  test("returns null when all phases completed", async () => {
    // Start a run with all phases completed
    const runId = RunId("test-run-3");
    const state = new StateBuilder()
      .withRun({ runId })
      .withCurrentRun(runId)
      .withPhaseInRun(runId, createCompletedPhase("phase-1", "session-1"))
      .withPhaseInRun(runId, createCompletedPhase("phase-2", "session-2"))
      .withPhaseInRun(runId, createCompletedPhase("phase-3", "session-3"))
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".langton", "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const nextPhase = stateManager.getNextPhaseToExecute();
    expect(nextPhase).toBeNull();
  });

  test("handles skipped phases correctly", async () => {
    // Run with phase-2 skipped
    const runId = RunId("test-run-4");
    const state = new StateBuilder()
      .withRun({ runId })
      .withCurrentRun(runId)
      .withPhaseInRun(runId, createCompletedPhase("phase-1", "session-1"))
      .withPhaseInRun(runId, {
        phaseId: PhaseId("phase-2"),
        startTime: new Date().toISOString(),
        status: "skipped",
        endTime: new Date().toISOString(),
        skippedDuring: "running",
        partialCost: 0,
        partialTokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      })
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".langton", "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const nextPhase = stateManager.getNextPhaseToExecute();
    expect(nextPhase).toBe(PhaseId("phase-3"));
  });

  test("handles continuation from specific phase", async () => {
    // Run that continues from phase-1
    const runId = RunId("test-run-5");
    const state = new StateBuilder()
      .withRun({
        runId,
        startingConditions: {
          type: "continuation",
          source: {
            runId: RunId("previous-run"),
            afterPhase: PhaseId("phase-1"),
            checkpointSha: "abc123",
          },
        },
      })
      .withCurrentRun(runId)
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".langton", "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const nextPhase = stateManager.getNextPhaseToExecute();
    expect(nextPhase).toBe(PhaseId("phase-2"));
  });
});

describe("StateManager - getLastSuccessfulPhase", () => {
  let tempDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-state-${Date.now()}`);
    await fs.promises.mkdir(path.join(tempDir, ".langton"), {
      recursive: true,
    });

    const logger = new Logger(path.join(tempDir, "test.log"));
    stateManager = new StateManager(path.join(tempDir, ".langton"), logger);
    await stateManager.initialize();
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns null when no successful executions", async () => {
    const result = stateManager.getLastSuccessfulPhase(PhaseId("phase-1"));
    expect(result).toBeNull();
  });

  test("finds last successful phase across runs", async () => {
    // Create state with multiple runs
    const state = new StateBuilder()
      .withRun({ runId: RunId("run-1") })
      .withPhaseInRun(
        RunId("run-1"),
        createCompletedPhase("phase-1", "session-1")
      )
      .withPhaseInRun(RunId("run-1"), {
        phaseId: PhaseId("phase-2"),
        startTime: new Date().toISOString(),
        status: "failed",
        endTime: new Date().toISOString(),
        failedDuring: "running",
        exitCode: 1,
        failureReason: { type: "unknown", retriable: false },
        partialCost: 0.05,
        partialTokens: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      })
      .withRun({ runId: RunId("run-2") })
      .withPhaseInRun(
        RunId("run-2"),
        createCompletedPhase("phase-1", "session-2")
      )
      .withPhaseInRun(
        RunId("run-2"),
        createCompletedPhase("phase-2", "session-3")
      )
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".langton", "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = stateManager.getLastSuccessfulPhase(PhaseId("phase-2"));
    expect(result).not.toBeNull();
    expect(result!.run.runId).toBe(RunId("run-2"));
    expect(result!.phase.claudeSessionId).toBe(SessionId("session-3"));
  });

  test("returns most recent successful execution", async () => {
    // Create state with multiple successful executions
    const state = new StateBuilder()
      .withRun({ runId: RunId("run-1") })
      .withPhaseInRun(
        RunId("run-1"),
        createCompletedPhase("phase-1", "old-session")
      )
      .withRun({ runId: RunId("run-2") })
      .withPhaseInRun(
        RunId("run-2"),
        createCompletedPhase("phase-1", "new-session")
      )
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".langton", "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = stateManager.getLastSuccessfulPhase(PhaseId("phase-1"));
    expect(result).not.toBeNull();
    expect(result!.phase.claudeSessionId).toBe(SessionId("new-session"));
  });
});

describe("StateManager - Cost Calculations", () => {
  let tempDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-state-${Date.now()}`);
    await fs.promises.mkdir(path.join(tempDir, ".langton"), {
      recursive: true,
    });

    const logger = new Logger(path.join(tempDir, "test.log"));
    stateManager = new StateManager(path.join(tempDir, ".langton"), logger);
    await stateManager.initialize();
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("calculates total cost across all runs", async () => {
    const state = new StateBuilder()
      .withRun({ runId: RunId("run-1") })
      .withPhaseInRun(
        RunId("run-1"),
        createCompletedPhase("phase-1", "s1", 0.05)
      )
      .withPhaseInRun(
        RunId("run-1"),
        createCompletedPhase("phase-2", "s2", 0.1)
      )
      .withRun({ runId: RunId("run-2") })
      .withPhaseInRun(
        RunId("run-2"),
        createCompletedPhase("phase-1", "s3", 0.03)
      )
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".langton", "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const totalCost = stateManager.getTotalCost();
    expect(totalCost).toBeCloseTo(0.18, 4);
  });

  test("calculates current run cost", async () => {
    const runId = RunId("current-run");
    const state = new StateBuilder()
      .withRun({ runId: RunId("old-run") })
      .withPhaseInRun(
        RunId("old-run"),
        createCompletedPhase("phase-1", "s1", 0.05)
      )
      .withRun({ runId })
      .withCurrentRun(runId)
      .withPhaseInRun(runId, createCompletedPhase("phase-1", "s2", 0.03))
      .withPhaseInRun(runId, createCompletedPhase("phase-2", "s3", 0.07))
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".langton", "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const currentRunCost = stateManager.getCurrentRunCost();
    expect(currentRunCost).toBeCloseTo(0.1, 4);
  });

  test("handles missing cost fields gracefully", async () => {
    const runId = RunId("test-run");
    const state = new StateBuilder()
      .withRun({ runId })
      .withCurrentRun(runId)
      .withPhaseInRun(runId, {
        phaseId: PhaseId("phase-1"),
        startTime: new Date().toISOString(),
        status: "preparing",
      })
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".langton", "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const cost = stateManager.getCurrentRunCost();
    expect(cost).toBe(0);
  });
});
