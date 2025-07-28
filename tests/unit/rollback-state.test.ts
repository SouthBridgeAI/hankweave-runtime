import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { PhaseId, RunId, SessionId } from "../../server/branded-types";
import { StateManager } from "../../server/state-manager";
import type { PhaseConfig } from "../../server/types";
import { Logger } from "../../server/utils";

describe("Rollback State Management", () => {
  let stateManager: StateManager;
  let tempDir: string;
  let logger: Logger;

  // Helper function to get phase in a specific run
  function getPhaseInRun(runId: RunId, phaseId: PhaseId) {
    const run = stateManager.getRun(runId);
    if (!run) return null;
    return run.phases.find((p) => p.phaseId === phaseId) || null;
  }

  const testPhases: PhaseConfig[] = [
    {
      id: PhaseId("phase-1"),
      name: "Test Phase 1",
      promptText: "Test prompt 1",
      model: "sonnet",
      continuationMode: "fresh",
      trackedFiles: ["*.txt"],
    },
    {
      id: PhaseId("phase-2"),
      name: "Test Phase 2",
      promptText: "Test prompt 2",
      model: "sonnet",
      continuationMode: "continue-previous",
      trackedFiles: ["*.md"],
    },
    {
      id: PhaseId("phase-3"),
      name: "Test Phase 3",
      promptText: "Test prompt 3",
      model: "opus",
      continuationMode: "fresh",
      trackedFiles: ["src/**/*.ts"],
    },
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
    stateManager = new StateManager(tempDir, logger, testPhases);
    await stateManager.initialize();
  });

  afterEach(async () => {
    // Clean up
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Checkpoint Creation", () => {
    test("should store checkpoint SHA in phase state", async () => {
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

      // Start phase 1
      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId: PhaseId("phase-1") },
      });

      // Transition through states
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId: PhaseId("phase-1"),
          from: "preparing",
          to: "starting",
        },
      });

      // Create workspace setup checkpoint
      const workspaceSha = "abc123workspace";
      stateManager.transition({
        type: "CheckpointCreated",
        data: {
          runId,
          phaseId: PhaseId("phase-1"),
          checkpointType: "workspace-setup",
          sha: workspaceSha,
          branch: `run-${runId}`,
        },
      });

      // Wait for all transitions to complete
      await stateManager.waitForPendingTransitions();

      // Verify checkpoint is stored
      const phase = getPhaseInRun(runId, PhaseId("phase-1"));
      expect(phase).toBeDefined();
      if (phase) {
        expect("workspaceSetupCheckpoint" in phase).toBe(true);
        if ("workspaceSetupCheckpoint" in phase) {
          expect(phase.workspaceSetupCheckpoint).toBe(workspaceSha);
        }
      }

      // Complete the phase - need to go through all states
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId: PhaseId("phase-1"),
          from: "starting",
          to: "initializing",
          metadata: {
            claudePid: 12345,
            claudeLogPath: "/tmp/test.log",
          },
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId: PhaseId("phase-1"),
          from: "initializing",
          to: "running",
          metadata: {
            claudeSessionId: SessionId("test-session"),
          },
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId: PhaseId("phase-1"),
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
      const completedPhase = getPhaseInRun(runId, PhaseId("phase-1"));
      expect(completedPhase?.status).toBe("completed");
      if (completedPhase?.status === "completed") {
        expect(completedPhase.completionCheckpoint).toBe("def456completed");
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

      // Start and fail phase 1
      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId: PhaseId("phase-1") },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId: PhaseId("phase-1"),
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
      const failedPhase = getPhaseInRun(runId, PhaseId("phase-1"));
      expect(failedPhase?.status).toBe("failed");
      if (failedPhase?.status === "failed" && "errorCheckpoint" in failedPhase) {
        expect(failedPhase.errorCheckpoint).toBe("error123");
      }

      // Start and skip phase 2
      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId: PhaseId("phase-2") },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId: PhaseId("phase-2"),
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
      const skippedPhase = getPhaseInRun(runId, PhaseId("phase-2"));
      expect(skippedPhase?.status).toBe("skipped");
      if (skippedPhase?.status === "skipped" && "skipCheckpoint" in skippedPhase) {
        expect(skippedPhase.skipCheckpoint).toBe("skip456");
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

      // Complete phase 1
      stateManager.transition({
        type: "PhaseStarted",
        data: { runId: runId1, phaseId: PhaseId("phase-1") },
      });

      // Need to go through proper state transitions
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: runId1,
          phaseId: PhaseId("phase-1"),
          from: "preparing",
          to: "starting",
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: runId1,
          phaseId: PhaseId("phase-1"),
          from: "starting",
          to: "initializing",
          metadata: {
            claudePid: 12345,
            claudeLogPath: "/tmp/test.log",
          },
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: runId1,
          phaseId: PhaseId("phase-1"),
          from: "initializing",
          to: "running",
          metadata: {
            claudeSessionId: SessionId("test-session"),
          },
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: runId1,
          phaseId: PhaseId("phase-1"),
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
              afterPhase: PhaseId("phase-1"),
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
        expect(run2.startingConditions.source.afterPhase).toBe(PhaseId("phase-1"));
        expect(run2.startingConditions.source.checkpointSha).toBe("completed123");
        expect(run2.startingConditions.reason).toBe("rollback");
      }
    });

    test("should determine next phase correctly for continuation run", async () => {
      // Create initial run with completed phase 1
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
        type: "PhaseStarted",
        data: { runId: runId1, phaseId: PhaseId("phase-1") },
      });

      // Need to go through proper state transitions
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: runId1,
          phaseId: PhaseId("phase-1"),
          from: "preparing",
          to: "starting",
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: runId1,
          phaseId: PhaseId("phase-1"),
          from: "starting",
          to: "initializing",
          metadata: {
            claudePid: 12345,
            claudeLogPath: "/tmp/test.log",
          },
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: runId1,
          phaseId: PhaseId("phase-1"),
          from: "initializing",
          to: "running",
          metadata: {
            claudeSessionId: SessionId("test-session"),
          },
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: runId1,
          phaseId: PhaseId("phase-1"),
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

      // Create continuation run after phase 1
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
              afterPhase: PhaseId("phase-1"),
              checkpointSha: "abc123",
            },
            reason: "rollback",
          },
          serverPid: process.pid,
        },
      });

      // Wait for transitions
      await stateManager.waitForPendingTransitions();

      // Next phase should be phase-2
      const nextPhase = await stateManager.getNextPhaseToExecute();
      expect(nextPhase).toBe(PhaseId("phase-2"));
    });

    test("should handle rollback to workspace setup (null afterPhase)", async () => {
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

      // Start phase 1 with workspace setup checkpoint
      stateManager.transition({
        type: "PhaseStarted",
        data: { runId: runId1, phaseId: PhaseId("phase-1") },
      });

      stateManager.transition({
        type: "CheckpointCreated",
        data: {
          runId: runId1,
          phaseId: PhaseId("phase-1"),
          checkpointType: "workspace-setup",
          sha: "workspace123",
          branch: `run-${runId1}`,
        },
      });

      stateManager.transition({
        type: "RunCompleted",
        data: { runId: runId1 },
      });

      // Create continuation run from workspace setup (null afterPhase)
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
              afterPhase: null, // Continue from beginning of phase
              checkpointSha: "workspace123",
            },
            reason: "rollback",
          },
          serverPid: process.pid,
        },
      });

      // Wait for transitions
      await stateManager.waitForPendingTransitions();

      // Next phase should be phase-1 (starting from beginning)
      const nextPhase = await stateManager.getNextPhaseToExecute();
      expect(nextPhase).toBe(PhaseId("phase-1"));
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

      // Start phase 1
      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId: PhaseId("phase-1") },
      });

      // Need to go through proper state transitions
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId: PhaseId("phase-1"),
          from: "preparing",
          to: "starting",
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId: PhaseId("phase-1"),
          from: "starting",
          to: "initializing",
          metadata: {
            claudePid: 12345,
            claudeLogPath: "/tmp/test.log",
          },
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId: PhaseId("phase-1"),
          from: "initializing",
          to: "running",
          metadata: {
            claudeSessionId: SessionId("session-1"),
          },
        },
      });

      // Force stop - immediate transition to failed
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId: PhaseId("phase-1"),
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

      // Verify phase is failed with retriable error
      const phase = getPhaseInRun(runId, PhaseId("phase-1"));
      expect(phase?.status).toBe("failed");
      if (phase?.status === "failed") {
        expect(phase.failureReason?.retriable).toBe(true);
        expect(phase.failureReason?.message).toContain("Force stopped");
        expect(phase.failedDuring).toBe("running");
      }
    });
  });
});
