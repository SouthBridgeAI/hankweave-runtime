import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { StateManager } from "../../server/state-manager.js";
import { PhaseId, RunId } from "../../server/types/branded-types.js";
import type { PhaseConfig } from "../../server/types/types.js";
import { Logger } from "../../server/utils.js";
import { createCompletedPhase, StateBuilder } from "../utils/mock-builders.js";

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
    await fs.promises.mkdir(path.join(tempDir, ".tadpole"), {
      recursive: true,
    });

    const logger = new Logger(path.join(tempDir, "test.log"));
    stateManager = new StateManager(path.join(tempDir, ".tadpole"), logger, mockPhases);
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
        runFolder: path.join(tempDir, ".tadpole", "runs", runId),
        gitBranch: `run-${runId}`,
        startingConditions: { type: "fresh" },
        serverPid: process.pid,
      },
    });

    await stateManager.waitForPendingTransitions();

    const nextPhase = await stateManager.getNextPhaseToExecute();
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
      path.join(tempDir, ".tadpole", "state.json"),
      JSON.stringify(state),
    );
    await stateManager.initialize();

    const nextPhase = await stateManager.getNextPhaseToExecute();
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
      path.join(tempDir, ".tadpole", "state.json"),
      JSON.stringify(state),
    );
    await stateManager.initialize();

    const nextPhase = await stateManager.getNextPhaseToExecute();
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
      path.join(tempDir, ".tadpole", "state.json"),
      JSON.stringify(state),
    );
    await stateManager.initialize();

    const nextPhase = await stateManager.getNextPhaseToExecute();
    expect(nextPhase).toBe(PhaseId("phase-3"));
  });

  test("handles continuation from specific phase", async () => {
    // Create a state with a previous run that has phase-1 completed
    const previousRunId = RunId("previous-run");
    const currentRunId = RunId("test-run-5");

    const state = new StateBuilder()
      // First add the previous run with phase-1 completed
      .withRun({ runId: previousRunId })
      .withPhaseInRun(previousRunId, createCompletedPhase("phase-1", "session-1"))
      // Then add the continuation run
      .withRun({
        runId: currentRunId,
        startingConditions: {
          type: "continuation",
          source: {
            runId: previousRunId,
            afterPhase: PhaseId("phase-1"),
            checkpointSha: "abc123",
          },
        },
      })
      .withCurrentRun(currentRunId)
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".tadpole", "state.json"),
      JSON.stringify(state),
    );
    await stateManager.initialize();

    const nextPhase = await stateManager.getNextPhaseToExecute();
    expect(nextPhase).toBe(PhaseId("phase-2"));
  });
});

describe("StateManager - Cost Calculations", () => {
  let tempDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-state-${Date.now()}`);
    await fs.promises.mkdir(path.join(tempDir, ".tadpole"), {
      recursive: true,
    });

    const logger = new Logger(path.join(tempDir, "test.log"));
    stateManager = new StateManager(path.join(tempDir, ".tadpole"), logger);
    await stateManager.initialize();
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("calculates total cost across all runs", async () => {
    const state = new StateBuilder()
      .withRun({ runId: RunId("run-1") })
      .withPhaseInRun(RunId("run-1"), createCompletedPhase("phase-1", "s1", 0.05))
      .withPhaseInRun(RunId("run-1"), createCompletedPhase("phase-2", "s2", 0.1))
      .withRun({ runId: RunId("run-2") })
      .withPhaseInRun(RunId("run-2"), createCompletedPhase("phase-1", "s3", 0.03))
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".tadpole", "state.json"),
      JSON.stringify(state),
    );
    await stateManager.initialize();

    const totalCost = stateManager.getTotalCost();
    expect(totalCost).toBeCloseTo(0.18, 4);
  });

  test("calculates current run cost", async () => {
    const runId = RunId("current-run");
    const state = new StateBuilder()
      .withRun({ runId: RunId("old-run") })
      .withPhaseInRun(RunId("old-run"), createCompletedPhase("phase-1", "s1", 0.05))
      .withRun({ runId })
      .withCurrentRun(runId)
      .withPhaseInRun(runId, createCompletedPhase("phase-1", "s2", 0.03))
      .withPhaseInRun(runId, createCompletedPhase("phase-2", "s3", 0.07))
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".tadpole", "state.json"),
      JSON.stringify(state),
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
      path.join(tempDir, ".tadpole", "state.json"),
      JSON.stringify(state),
    );
    await stateManager.initialize();

    const cost = stateManager.getCurrentRunCost();
    expect(cost).toBe(0);
  });
});
