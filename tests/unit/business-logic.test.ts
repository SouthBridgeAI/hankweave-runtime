import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { StateManager } from "../../server/state-manager.js";
import { CodonId, RunId } from "../../server/types/branded-types.js";
import type { Codon } from "../../server/types/types.js";
import { Logger } from "../../server/utils.js";
import { createCompletedCodon, StateBuilder } from "../utils/mock-builders.js";

describe("StateManager - getNextCodonToExecute", () => {
  let tempDir: string;
  let stateManager: StateManager;
  const mockCodons: Codon[] = [
    {
      id: CodonId("codon-1"),
      name: "Codon 1",
      model: "sonnet",
      continuationMode: "fresh",
    },
    {
      id: CodonId("codon-2"),
      name: "Codon 2",
      model: "sonnet",
      continuationMode: "fresh",
    },
    {
      id: CodonId("codon-3"),
      name: "Codon 3",
      model: "sonnet",
      continuationMode: "fresh",
    },
  ];

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-state-${Date.now()}`);
    await fs.promises.mkdir(path.join(tempDir, ".strandweave"), {
      recursive: true,
    });

    const logger = new Logger(path.join(tempDir, "test.log"));
    stateManager = new StateManager(path.join(tempDir, ".strandweave"), logger, mockCodons);
    await stateManager.initialize();
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns first codon when no codons completed", async () => {
    // Start a new run
    const runId = RunId("test-run-1");
    stateManager.transition({
      type: "RunStarted",
      data: {
        runId,
        runFolder: path.join(tempDir, ".strandweave", "runs", runId),
        gitBranch: `run-${runId}`,
        startingConditions: { type: "fresh" },
        serverPid: process.pid,
      },
    });

    await stateManager.waitForPendingTransitions();

    const nextCodon = await stateManager.getNextCodonToExecute();
    expect(nextCodon).toBe(CodonId("codon-1"));
  });

  test("returns next codon after one completed", async () => {
    // Start a run with one completed codon
    const runId = RunId("test-run-2");
    const state = new StateBuilder()
      .withRun({ runId })
      .withCurrentRun(runId)
      .withCodonInRun(runId, createCompletedCodon("codon-1", "session-1"))
      .build();

    // Directly set the state (for testing)
    await fs.promises.writeFile(
      path.join(tempDir, ".strandweave", "state.json"),
      JSON.stringify(state),
    );
    await stateManager.initialize();

    const nextCodon = await stateManager.getNextCodonToExecute();
    expect(nextCodon).toBe(CodonId("codon-2"));
  });

  test("returns null when all codons completed", async () => {
    // Start a run with all codons completed
    const runId = RunId("test-run-3");
    const state = new StateBuilder()
      .withRun({ runId })
      .withCurrentRun(runId)
      .withCodonInRun(runId, createCompletedCodon("codon-1", "session-1"))
      .withCodonInRun(runId, createCompletedCodon("codon-2", "session-2"))
      .withCodonInRun(runId, createCompletedCodon("codon-3", "session-3"))
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".strandweave", "state.json"),
      JSON.stringify(state),
    );
    await stateManager.initialize();

    const nextCodon = await stateManager.getNextCodonToExecute();
    expect(nextCodon).toBeNull();
  });

  test("handles skipped codons correctly", async () => {
    // Run with codon-2 skipped
    const runId = RunId("test-run-4");
    const state = new StateBuilder()
      .withRun({ runId })
      .withCurrentRun(runId)
      .withCodonInRun(runId, createCompletedCodon("codon-1", "session-1"))
      .withCodonInRun(runId, {
        codonId: CodonId("codon-2"),
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
      path.join(tempDir, ".strandweave", "state.json"),
      JSON.stringify(state),
    );
    await stateManager.initialize();

    const nextCodon = await stateManager.getNextCodonToExecute();
    expect(nextCodon).toBe(CodonId("codon-3"));
  });

  test("handles continuation from specific codon", async () => {
    // Create a state with a previous run that has codon-1 completed
    const previousRunId = RunId("previous-run");
    const currentRunId = RunId("test-run-5");

    const state = new StateBuilder()
      // First add the previous run with codon-1 completed
      .withRun({ runId: previousRunId })
      .withCodonInRun(previousRunId, createCompletedCodon("codon-1", "session-1"))
      // Then add the continuation run
      .withRun({
        runId: currentRunId,
        startingConditions: {
          type: "continuation",
          source: {
            runId: previousRunId,
            afterCodon: CodonId("codon-1"),
            checkpointSha: "abc123",
          },
        },
      })
      .withCurrentRun(currentRunId)
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".strandweave", "state.json"),
      JSON.stringify(state),
    );
    await stateManager.initialize();

    const nextCodon = await stateManager.getNextCodonToExecute();
    expect(nextCodon).toBe(CodonId("codon-2"));
  });
});

describe("StateManager - Cost Calculations", () => {
  let tempDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-state-${Date.now()}`);
    await fs.promises.mkdir(path.join(tempDir, ".strandweave"), {
      recursive: true,
    });

    const logger = new Logger(path.join(tempDir, "test.log"));
    stateManager = new StateManager(path.join(tempDir, ".strandweave"), logger);
    await stateManager.initialize();
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("calculates total cost across all runs", async () => {
    const state = new StateBuilder()
      .withRun({ runId: RunId("run-1") })
      .withCodonInRun(RunId("run-1"), createCompletedCodon("codon-1", "s1", 0.05))
      .withCodonInRun(RunId("run-1"), createCompletedCodon("codon-2", "s2", 0.1))
      .withRun({ runId: RunId("run-2") })
      .withCodonInRun(RunId("run-2"), createCompletedCodon("codon-1", "s3", 0.03))
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".strandweave", "state.json"),
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
      .withCodonInRun(RunId("old-run"), createCompletedCodon("codon-1", "s1", 0.05))
      .withRun({ runId })
      .withCurrentRun(runId)
      .withCodonInRun(runId, createCompletedCodon("codon-1", "s2", 0.03))
      .withCodonInRun(runId, createCompletedCodon("codon-2", "s3", 0.07))
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".strandweave", "state.json"),
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
      .withCodonInRun(runId, {
        codonId: CodonId("codon-1"),
        startTime: new Date().toISOString(),
        status: "preparing",
      })
      .build();

    await fs.promises.writeFile(
      path.join(tempDir, ".strandweave", "state.json"),
      JSON.stringify(state),
    );
    await stateManager.initialize();

    const cost = stateManager.getCurrentRunCost();
    expect(cost).toBe(0);
  });
});
