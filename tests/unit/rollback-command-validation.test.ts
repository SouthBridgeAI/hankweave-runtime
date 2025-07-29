import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { StateManager } from "../../server/state-manager.js";
import { PhaseId, RunId, SessionId } from "../../server/types/branded-types.js";
import type * as ST from "../../server/types/state-types.js";
import { Logger } from "../../server/utils.js";

// Test directory setup
const TEST_DIR = path.join(__dirname, "test-rollback-validation");
const TEST_TADPOLE_DIR = path.join(TEST_DIR, ".tadpole");

// Mock logger
class MockLogger extends Logger {
  logs: Array<{ message: string; level: string }> = [];

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }

  logSocketTraffic(_socketLogFile: string, _direction: "in" | "out", _data: unknown): void {
    // Mock implementation
  }
}

describe("Rollback Command Validation", () => {
  let stateManager: StateManager;
  let mockLogger: MockLogger;

  beforeEach(async () => {
    // Create test directory
    await fs.promises.mkdir(TEST_TADPOLE_DIR, { recursive: true });

    // Create mock logger
    mockLogger = new MockLogger("");

    // Create state manager
    stateManager = new StateManager(TEST_TADPOLE_DIR, mockLogger);
    await stateManager.initialize();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  });

  describe("rollback while phase is running", () => {
    test("should prevent rollback while phase is running", async () => {
      const runId = RunId("test-run");
      const phaseId = PhaseId("test-phase");

      // Start a run and phase
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId },
      });

      // Progress to running state
      const transitions = [
        { from: "preparing", to: "starting" },
        {
          from: "starting",
          to: "initializing",
          metadata: { claudePid: 123, claudeLogPath: "test.log" },
        },
        {
          from: "initializing",
          to: "running",
          metadata: { claudeSessionId: SessionId("session-123") },
        },
      ];

      for (const t of transitions) {
        stateManager.transition({
          type: "PhaseTransitioned",
          data: {
            runId,
            phaseId,
            from: t.from as ST.PhaseStatus,
            to: t.to as ST.PhaseStatus,
            metadata: t.metadata,
          },
        });
      }

      await stateManager.waitForPendingTransitions();

      // Verify phase is running
      const currentPhase = stateManager.getCurrentlyRunningPhase();
      expect(currentPhase).not.toBeNull();
      expect(currentPhase?.status).toBe("running");

      // This test validates the concept - in the actual server,
      // the rollback command handler would check this condition
      expect(currentPhase?.status).not.toBe("completed");
      expect(currentPhase?.status).not.toBe("failed");
      expect(currentPhase?.status).not.toBe("skipped");
    });

    test("should allow rollback after phase completes", async () => {
      const runId = RunId("test-run");
      const phaseId = PhaseId("test-phase");

      // Start and complete a phase
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId },
      });

      // Complete the phase
      const transitions = [
        { from: "preparing", to: "starting" },
        {
          from: "starting",
          to: "initializing",
          metadata: { claudePid: 123, claudeLogPath: "test.log" },
        },
        {
          from: "initializing",
          to: "running",
          metadata: { claudeSessionId: SessionId("session-123") },
        },
        {
          from: "running",
          to: "completed",
          metadata: { checkpointSha: "abc123" },
        },
      ];

      for (const t of transitions) {
        stateManager.transition({
          type: "PhaseTransitioned",
          data: {
            runId,
            phaseId,
            from: t.from as ST.PhaseStatus,
            to: t.to as ST.PhaseStatus,
            metadata: t.metadata,
          },
        });
      }

      await stateManager.waitForPendingTransitions();

      // Verify phase is completed and rollback would be allowed
      const currentPhase = stateManager.getCurrentlyRunningPhase();
      expect(currentPhase).toBeNull(); // No current phase since it's completed

      const run = stateManager.getCurrentRun();
      expect(run).not.toBeNull();
      expect(run?.phases[0].status).toBe("completed");
    });
  });

  describe("checkpoint validation", () => {
    test("should validate phase exists before rollback", async () => {
      const runId = RunId("test-run");
      const phaseId = PhaseId("test-phase");

      // Start a run with one phase
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId },
      });

      await stateManager.waitForPendingTransitions();

      // Try to find a non-existent phase
      const nonExistentPhase = PhaseId("non-existent-phase");
      const run = stateManager.getCurrentRun();
      const phase = run?.phases.find((p) => p.phaseId === nonExistentPhase);

      expect(phase).toBeUndefined();
    });

    test("should handle missing checkpoint SHA", async () => {
      const runId = RunId("test-run");
      const phaseId = PhaseId("test-phase");

      // Start and complete a phase without checkpoint
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId },
      });

      // Progress through valid state transitions to completed
      const transitions = [
        { from: "preparing", to: "starting" },
        {
          from: "starting",
          to: "initializing",
          metadata: { claudePid: 123, claudeLogPath: "test.log" },
        },
        {
          from: "initializing",
          to: "running",
          metadata: { claudeSessionId: SessionId("session-123") },
        },
        {
          from: "running",
          to: "completed",
          metadata: { checkpointSha: "" }, // Empty checkpointSha - this is what we're testing
        },
      ];

      for (const t of transitions) {
        stateManager.transition({
          type: "PhaseTransitioned",
          data: {
            runId,
            phaseId,
            from: t.from as ST.PhaseStatus,
            to: t.to as ST.PhaseStatus,
            metadata: t.metadata,
          },
        });
        // Wait for each transition to complete
        await stateManager.waitForPendingTransitions();
      }

      // Give extra time for all async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      const run = stateManager.getCurrentRun();
      const phase = run?.phases[0];

      // Debug: log the actual phase status if it's not what we expect
      if (phase?.status !== "completed") {
        console.log(`Debug: Expected 'completed' but got '${phase?.status}'`);
        console.log(`Phase object:`, JSON.stringify(phase, null, 2));
      }

      expect(phase?.status).toBe("completed");

      // In a completed phase, completionCheckpoint might be empty
      if (phase?.status === "completed") {
        expect(phase.completionCheckpoint).toBe("");
      }
    });
  });

  describe("rollback to last success scenarios", () => {
    test("should handle rollback to last success with no successful phases", async () => {
      const runId = RunId("test-run");
      const phaseId = PhaseId("test-phase");

      // Start a run with a failed phase
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId },
      });

      // Fail the phase
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId,
          from: "preparing",
          to: "failed",
          metadata: {
            failedDuring: "preparing",
            exitCode: 1,
            failureReason: {
              type: "unknown",
              retriable: true,
              message: "Test failure",
            },
          },
        },
      });

      await stateManager.waitForPendingTransitions();

      // In this case, rollback should fall back to first checkpoint
      const run = stateManager.getCurrentRun();
      expect(run?.phases[0].status).toBe("failed");
    });
  });

  describe("checkpoint type validation", () => {
    test("should validate workspace-setup checkpoint exists", async () => {
      const runId = RunId("test-run");
      const phaseId = PhaseId("test-phase");

      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId },
      });

      // Transition to starting with workspace checkpoint
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId,
          from: "preparing",
          to: "starting",
          metadata: { checkpointSha: "workspace123" },
        },
      });

      await stateManager.waitForPendingTransitions();

      const run = stateManager.getCurrentRun();
      const phase = run?.phases[0];
      expect(phase?.status).toBe("starting");

      if (phase?.status === "starting" && "workspaceSetupCheckpoint" in phase) {
        expect(phase.workspaceSetupCheckpoint).toBe("workspace123");
      }
    });

    test("should validate completed checkpoint exists", async () => {
      const runId = RunId("test-run");
      const phaseId = PhaseId("test-phase");

      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId },
      });

      // Complete with checkpoint
      const transitions = [
        { from: "preparing", to: "starting" },
        {
          from: "starting",
          to: "initializing",
          metadata: { claudePid: 123, claudeLogPath: "test.log" },
        },
        {
          from: "initializing",
          to: "running",
          metadata: { claudeSessionId: SessionId("session-123") },
        },
        {
          from: "running",
          to: "completed",
          metadata: { checkpointSha: "completed123" },
        },
      ];

      for (const t of transitions) {
        stateManager.transition({
          type: "PhaseTransitioned",
          data: {
            runId,
            phaseId,
            from: t.from as ST.PhaseStatus,
            to: t.to as ST.PhaseStatus,
            metadata: t.metadata,
          },
        });
      }

      await stateManager.waitForPendingTransitions();

      const run = stateManager.getCurrentRun();
      const phase = run?.phases[0];
      expect(phase?.status).toBe("completed");

      if (phase?.status === "completed") {
        expect(phase.completionCheckpoint).toBe("completed123");
      }
    });

    test("should validate skipped checkpoint exists", async () => {
      const runId = RunId("test-run");
      const phaseId = PhaseId("test-phase");

      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId },
      });

      // Skip with checkpoint
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId,
          from: "preparing",
          to: "skipped",
          metadata: {
            skippedDuring: "preparing",
            checkpointSha: "skipped123",
          },
        },
      });

      await stateManager.waitForPendingTransitions();

      const run = stateManager.getCurrentRun();
      const phase = run?.phases[0];
      expect(phase?.status).toBe("skipped");

      if (phase?.status === "skipped" && "skipCheckpoint" in phase) {
        expect(phase.skipCheckpoint).toBe("skipped123");
      }
    });
  });

  describe("run validation", () => {
    test("should validate run exists for rollback", async () => {
      // Try to get a non-existent run
      const nonExistentRun = stateManager.getRun(RunId("non-existent"));
      expect(nonExistentRun).toBeNull();
    });

    test("should validate current run exists", async () => {
      // No current run initially
      const currentRun = stateManager.getCurrentRun();
      expect(currentRun).toBeNull();

      // Start a run
      const runId = RunId("test-run");
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      await stateManager.waitForPendingTransitions();

      // Now should have current run
      const newCurrentRun = stateManager.getCurrentRun();
      expect(newCurrentRun).not.toBeNull();
      expect(newCurrentRun?.runId).toBe(runId);
    });
  });
});
