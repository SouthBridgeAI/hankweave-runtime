import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { StateManager } from "../../server/state-manager";
import { CodonId, RunId, SessionId } from "../../server/types/branded-types";
import type { CodonConfig } from "../../server/types/types";
import { Logger } from "../../server/utils";
import { createTestCodon } from "../utils/test-codon-factory.js";

describe("Rollback State Management", () => {
  let stateManager: StateManager;
  let tempDir: string;
  let logger: Logger;

  // Helper function to get codon in a specific run
  function getCodonInRun(runId: RunId, codonId: CodonId) {
    const run = stateManager.getRun(runId);
    if (!run) return null;
    return run.codons.find((p) => p.codonId === codonId) || null;
  }

  const testCodons: CodonConfig[] = [
    createTestCodon({
      id: "codon-1",
      name: "Test Codon 1",
      promptText: "Test prompt 1",
      model: "sonnet",
      continuationMode: "fresh",
      trackedFiles: ["*.txt"],
    }),
    createTestCodon({
      id: "codon-2",
      name: "Test Codon 2",
      promptText: "Test prompt 2",
      model: "sonnet",
      continuationMode: "continue-previous",
      trackedFiles: ["*.md"],
    }),
    createTestCodon({
      id: "codon-3",
      name: "Test Codon 3",
      promptText: "Test prompt 3",
      model: "opus",
      continuationMode: "fresh",
      trackedFiles: ["src/**/*.ts"],
    }),
  ];

  beforeEach(async () => {
    // Create temp directory in the proper test area
    const testAreaPath = path.join(__dirname, "..", "test-area");
    await fs.promises.mkdir(testAreaPath, { recursive: true });
    tempDir = path.join(testAreaPath, `test-state-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create logger
    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    // Create state manager
    stateManager = new StateManager(tempDir, logger, testCodons);
    await stateManager.initialize();
  });

  afterEach(async () => {
    // Clean up
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Checkpoint Creation", () => {
    test("should store checkpoint SHA in codon state", async () => {
      // Start a run
      const runId = RunId("test-run-1");
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: path.join(tempDir, "runs", runId),
          gitBranch: `run-${runId}`,
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      // Wait for state to persist
      await stateManager.waitForPendingTransitions();

      // Start codon 1
      stateManager.transition({
        type: "CodonStarted",
        data: { runId, codonId: CodonId("codon-1") },
      });

      // Transition through states
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId: CodonId("codon-1"),
          from: "preparing",
          to: "starting",
        },
      });

      // Create rig setup checkpoint
      const rigSetupSha = "abc123rigsetup";
      stateManager.transition({
        type: "CheckpointCreated",
        data: {
          runId,
          codonId: CodonId("codon-1"),
          checkpointType: "rig-setup",
          sha: rigSetupSha,
          branch: `run-${runId}`,
        },
      });

      // Wait for all transitions to complete
      await stateManager.waitForPendingTransitions();

      // Verify checkpoint is stored
      const codon = getCodonInRun(runId, CodonId("codon-1"));
      expect(codon).toBeDefined();
      if (codon) {
        expect("rigSetupCheckpoint" in codon).toBe(true);
        if ("rigSetupCheckpoint" in codon) {
          expect(codon.rigSetupCheckpoint).toBe(rigSetupSha);
        }
      }

      // Complete the codon - need to go through all states
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId: CodonId("codon-1"),
          from: "starting",
          to: "initializing",
          metadata: {
            claudePid: 12345,
            claudeLogPath: "/tmp/test.log",
          },
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId: CodonId("codon-1"),
          from: "initializing",
          to: "running",
          metadata: {
            claudeSessionId: SessionId("test-session"),
          },
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId: CodonId("codon-1"),
          from: "running",
          to: "completed",
          metadata: {
            checkpointSha: "def456completed",
          },
        },
      });

      // Wait for completion transition
      await stateManager.waitForPendingTransitions();

      // Verify completion checkpoint
      const completedCodon = getCodonInRun(runId, CodonId("codon-1"));
      expect(completedCodon?.status).toBe("completed");
      if (completedCodon?.status === "completed") {
        expect(completedCodon.completionCheckpoint).toBe("def456completed");
      }
    });

    test("should handle error and skip checkpoints", async () => {
      const runId = RunId("test-run-2");
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: path.join(tempDir, "runs", runId),
          gitBranch: `run-${runId}`,
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      // Start and fail codon 1
      stateManager.transition({
        type: "CodonStarted",
        data: { runId, codonId: CodonId("codon-1") },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId: CodonId("codon-1"),
          from: "preparing",
          to: "failed",
          metadata: {
            checkpointSha: "error123",
            failureReason: {
              type: "unknown",
              retriable: true,
              message: "Test error",
            },
            failedDuring: "preparing",
            exitCode: 1,
          },
        },
      });

      // Wait for transitions
      await stateManager.waitForPendingTransitions();

      // Verify error checkpoint
      const failedCodon = getCodonInRun(runId, CodonId("codon-1"));
      expect(failedCodon?.status).toBe("failed");
      if (failedCodon?.status === "failed" && "errorCheckpoint" in failedCodon) {
        expect(failedCodon.errorCheckpoint).toBe("error123");
      }

      // Start and skip codon 2
      stateManager.transition({
        type: "CodonStarted",
        data: { runId, codonId: CodonId("codon-2") },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId: CodonId("codon-2"),
          from: "preparing",
          to: "skipped",
          metadata: {
            checkpointSha: "skip456",
            skippedDuring: "preparing",
          },
        },
      });

      // Wait for transitions
      await stateManager.waitForPendingTransitions();

      // Verify skip checkpoint
      const skippedCodon = getCodonInRun(runId, CodonId("codon-2"));
      expect(skippedCodon?.status).toBe("skipped");
      if (skippedCodon?.status === "skipped" && "skipCheckpoint" in skippedCodon) {
        expect(skippedCodon.skipCheckpoint).toBe("skip456");
      }
    });
  });

  describe("Continuation Runs", () => {
    test("should create continuation run with proper starting conditions", async () => {
      // Create initial run
      const runId1 = RunId("test-run-1");
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: runId1,
          runFolder: path.join(tempDir, "runs", runId1),
          gitBranch: `run-${runId1}`,
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      // Complete codon 1
      stateManager.transition({
        type: "CodonStarted",
        data: { runId: runId1, codonId: CodonId("codon-1") },
      });

      // Need to go through proper state transitions
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: runId1,
          codonId: CodonId("codon-1"),
          from: "preparing",
          to: "starting",
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: runId1,
          codonId: CodonId("codon-1"),
          from: "starting",
          to: "initializing",
          metadata: {
            claudePid: 12345,
            claudeLogPath: "/tmp/test.log",
          },
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: runId1,
          codonId: CodonId("codon-1"),
          from: "initializing",
          to: "running",
          metadata: {
            claudeSessionId: SessionId("test-session"),
          },
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: runId1,
          codonId: CodonId("codon-1"),
          from: "running",
          to: "completed",
          metadata: {
            checkpointSha: "completed123",
          },
        },
      });

      // Complete the run
      stateManager.transition({
        type: "RunCompleted",
        data: { runId: runId1 },
      });

      // Create continuation run
      const runId2 = RunId("test-run-2");
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: runId2,
          runFolder: path.join(tempDir, "runs", runId2),
          gitBranch: `run-${runId2}`,
          startingConditions: {
            type: "continuation",
            source: {
              runId: runId1,
              afterCodon: CodonId("codon-1"),
              checkpointSha: "completed123",
            },
            reason: "rollback",
          },
          serverPid: process.pid,
        },
      });

      // Wait for transitions
      await stateManager.waitForPendingTransitions();

      // Verify continuation run
      const run2 = stateManager.getRun(runId2);
      expect(run2).toBeDefined();
      expect(run2?.startingConditions.type).toBe("continuation");
      if (run2?.startingConditions.type === "continuation") {
        expect(run2.startingConditions.source.runId).toBe(runId1);
        expect(run2.startingConditions.source.afterCodon).toBe(CodonId("codon-1"));
        expect(run2.startingConditions.source.checkpointSha).toBe("completed123");
        expect(run2.startingConditions.reason).toBe("rollback");
      }
    });

    test("should determine next codon correctly for continuation run", async () => {
      // Create initial run with completed codon 1
      const runId1 = RunId("test-run-1");
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: runId1,
          runFolder: path.join(tempDir, "runs", runId1),
          gitBranch: `run-${runId1}`,
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "CodonStarted",
        data: { runId: runId1, codonId: CodonId("codon-1") },
      });

      // Need to go through proper state transitions
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: runId1,
          codonId: CodonId("codon-1"),
          from: "preparing",
          to: "starting",
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: runId1,
          codonId: CodonId("codon-1"),
          from: "starting",
          to: "initializing",
          metadata: {
            claudePid: 12345,
            claudeLogPath: "/tmp/test.log",
          },
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: runId1,
          codonId: CodonId("codon-1"),
          from: "initializing",
          to: "running",
          metadata: {
            claudeSessionId: SessionId("test-session"),
          },
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: runId1,
          codonId: CodonId("codon-1"),
          from: "running",
          to: "completed",
          metadata: {
            checkpointSha: "completed-sha",
          },
        },
      });

      stateManager.transition({
        type: "RunCompleted",
        data: { runId: runId1 },
      });

      // Create continuation run after codon 1
      const runId2 = RunId("test-run-2");
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: runId2,
          runFolder: path.join(tempDir, "runs", runId2),
          gitBranch: `run-${runId2}`,
          startingConditions: {
            type: "continuation",
            source: {
              runId: runId1,
              afterCodon: CodonId("codon-1"),
              checkpointSha: "abc123",
            },
            reason: "rollback",
          },
          serverPid: process.pid,
        },
      });

      // Wait for transitions
      await stateManager.waitForPendingTransitions();

      // Next codon should be codon-2
      const nextCodon = await stateManager.getNextCodonToExecute();
      expect(nextCodon).toBe(CodonId("codon-2"));
    });

    test("should handle rollback to rig setup (null afterCodon)", async () => {
      // Create initial run
      const runId1 = RunId("test-run-1");
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: runId1,
          runFolder: path.join(tempDir, "runs", runId1),
          gitBranch: `run-${runId1}`,
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      // Start codon 1 with rig setup checkpoint
      stateManager.transition({
        type: "CodonStarted",
        data: { runId: runId1, codonId: CodonId("codon-1") },
      });

      stateManager.transition({
        type: "CheckpointCreated",
        data: {
          runId: runId1,
          codonId: CodonId("codon-1"),
          checkpointType: "rig-setup",
          sha: "rigsetup123",
          branch: `run-${runId1}`,
        },
      });

      stateManager.transition({
        type: "RunCompleted",
        data: { runId: runId1 },
      });

      // Create continuation run from rig setup (null afterCodon)
      const runId2 = RunId("test-run-2");
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: runId2,
          runFolder: path.join(tempDir, "runs", runId2),
          gitBranch: `run-${runId2}`,
          startingConditions: {
            type: "continuation",
            source: {
              runId: runId1,
              afterCodon: null, // Continue from beginning of codon
              checkpointSha: "rigsetup123",
            },
            reason: "rollback",
          },
          serverPid: process.pid,
        },
      });

      // Wait for transitions
      await stateManager.waitForPendingTransitions();

      // Next codon should be codon-1 (starting from beginning)
      const nextCodon = await stateManager.getNextCodonToExecute();
      expect(nextCodon).toBe(CodonId("codon-1"));
    });
  });

  describe("Force Stop Behavior", () => {
    test("should immediately transition to failed on force stop", async () => {
      const runId = RunId("test-run-1");
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: path.join(tempDir, "runs", runId),
          gitBranch: `run-${runId}`,
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      // Start codon 1
      stateManager.transition({
        type: "CodonStarted",
        data: { runId, codonId: CodonId("codon-1") },
      });

      // Need to go through proper state transitions
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId: CodonId("codon-1"),
          from: "preparing",
          to: "starting",
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId: CodonId("codon-1"),
          from: "starting",
          to: "initializing",
          metadata: {
            claudePid: 12345,
            claudeLogPath: "/tmp/test.log",
          },
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId: CodonId("codon-1"),
          from: "initializing",
          to: "running",
          metadata: {
            claudeSessionId: SessionId("session-1"),
          },
        },
      });

      // Force stop - immediate transition to failed
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId: CodonId("codon-1"),
          from: "running",
          to: "failed",
          metadata: {
            exitCode: -1,
            failureReason: {
              type: "unknown",
              retriable: true,
              message: "Force stopped: user request",
            },
            failedDuring: "running",
          },
        },
      });

      // Wait for transitions
      await stateManager.waitForPendingTransitions();

      // Verify codon is failed with retriable error
      const codon = getCodonInRun(runId, CodonId("codon-1"));
      expect(codon?.status).toBe("failed");
      if (codon?.status === "failed") {
        expect(codon.failureReason?.retriable).toBe(true);
        expect(codon.failureReason?.message).toContain("Force stopped");
        expect(codon.failedDuring).toBe("running");
      }
    });
  });
});
