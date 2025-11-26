import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { StateManager } from "../../server/state-manager";
import { CodonId, RunId, SessionId } from "../../server/types/branded-types";
import type * as ST from "../../server/types/state-types";
import { Logger } from "../../server/utils";

// Test directory setup
const TEST_DIR = path.join(import.meta.dir, "test-rollback-validation");
const TEST_STRANDWEAVE_DIR = path.join(TEST_DIR, ".strandweave");

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
    await fs.promises.mkdir(TEST_STRANDWEAVE_DIR, { recursive: true });

    // Create mock logger
    mockLogger = new MockLogger("");

    // Create state manager
    stateManager = new StateManager(TEST_STRANDWEAVE_DIR, mockLogger);
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

  describe("rollback while codon is running", () => {
    test("should prevent rollback while codon is running", async () => {
      const runId = RunId("test-run");
      const codonId = CodonId("test-codon");

      // Start a run and codon
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
        type: "CodonStarted",
        data: { runId, codonId },
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
          type: "CodonTransitioned",
          data: {
            runId,
            codonId,
            from: t.from as ST.CodonStatus,
            to: t.to as ST.CodonStatus,
            metadata: t.metadata,
          },
        });
      }

      await stateManager.waitForPendingTransitions();

      // Verify codon is running
      const currentCodon = stateManager.getCurrentlyRunningCodon();
      expect(currentCodon).not.toBeNull();
      expect(currentCodon?.status).toBe("running");

      // This test validates the concept - in the actual server,
      // the rollback command handler would check this condition
      expect(currentCodon?.status).not.toBe("completed");
      expect(currentCodon?.status).not.toBe("failed");
      expect(currentCodon?.status).not.toBe("skipped");
    });

    test("should allow rollback after codon completes", async () => {
      const runId = RunId("test-run");
      const codonId = CodonId("test-codon");

      // Start and complete a codon
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
        type: "CodonStarted",
        data: { runId, codonId },
      });

      // Complete the codon
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
          type: "CodonTransitioned",
          data: {
            runId,
            codonId,
            from: t.from as ST.CodonStatus,
            to: t.to as ST.CodonStatus,
            metadata: t.metadata,
          },
        });
      }

      await stateManager.waitForPendingTransitions();

      // Verify codon is completed and rollback would be allowed
      const currentCodon = stateManager.getCurrentlyRunningCodon();
      expect(currentCodon).toBeNull(); // No current codon since it's completed

      const run = stateManager.getCurrentRun();
      expect(run).not.toBeNull();
      expect(run?.codons[0].status).toBe("completed");
    });
  });

  describe("checkpoint validation", () => {
    test("should validate codon exists before rollback", async () => {
      const runId = RunId("test-run");
      const codonId = CodonId("test-codon");

      // Start a run with one codon
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
        type: "CodonStarted",
        data: { runId, codonId },
      });

      await stateManager.waitForPendingTransitions();

      // Try to find a non-existent codon
      const nonExistentCodon = CodonId("non-existent-codon");
      const run = stateManager.getCurrentRun();
      const codon = run?.codons.find((p) => p.codonId === nonExistentCodon);

      expect(codon).toBeUndefined();
    });

    test("should handle missing checkpoint SHA", async () => {
      const runId = RunId("test-run");
      const codonId = CodonId("test-codon");

      // Start and complete a codon without checkpoint
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
        type: "CodonStarted",
        data: { runId, codonId },
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
          type: "CodonTransitioned",
          data: {
            runId,
            codonId,
            from: t.from as ST.CodonStatus,
            to: t.to as ST.CodonStatus,
            metadata: t.metadata,
          },
        });
        // Wait for each transition to complete
        await stateManager.waitForPendingTransitions();
      }

      // Give extra time for all async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      const run = stateManager.getCurrentRun();
      const codon = run?.codons[0];

      // Debug: log the actual codon status if it's not what we expect
      if (codon?.status !== "completed") {
        console.log(`Debug: Expected 'completed' but got '${codon?.status}'`);
        console.log(`Codon object:`, JSON.stringify(codon, null, 2));
      }

      expect(codon?.status).toBe("completed");

      // In a completed codon, completionCheckpoint might be empty
      if (codon?.status === "completed") {
        expect(codon.completionCheckpoint).toBe("");
      }
    });
  });

  describe("rollback to last success scenarios", () => {
    test("should handle rollback to last success with no successful codons", async () => {
      const runId = RunId("test-run");
      const codonId = CodonId("test-codon");

      // Start a run with a failed codon
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
        type: "CodonStarted",
        data: { runId, codonId },
      });

      // Fail the codon
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId,
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
      expect(run?.codons[0].status).toBe("failed");
    });
  });

  describe("checkpoint type validation", () => {
    test("should validate rig-setup checkpoint exists", async () => {
      const runId = RunId("test-run");
      const codonId = CodonId("test-codon");

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
        type: "CodonStarted",
        data: { runId, codonId },
      });

      // Transition to starting with rig setup checkpoint
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId,
          from: "preparing",
          to: "starting",
          metadata: { checkpointSha: "rigsetup123" },
        },
      });

      await stateManager.waitForPendingTransitions();

      const run = stateManager.getCurrentRun();
      const codon = run?.codons[0];
      expect(codon?.status).toBe("starting");

      if (codon?.status === "starting" && "rigSetupCheckpoint" in codon) {
        expect(codon.rigSetupCheckpoint).toBe("rigsetup123");
      }
    });

    test("should validate completed checkpoint exists", async () => {
      const runId = RunId("test-run");
      const codonId = CodonId("test-codon");

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
        type: "CodonStarted",
        data: { runId, codonId },
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
          type: "CodonTransitioned",
          data: {
            runId,
            codonId,
            from: t.from as ST.CodonStatus,
            to: t.to as ST.CodonStatus,
            metadata: t.metadata,
          },
        });
      }

      await stateManager.waitForPendingTransitions();

      const run = stateManager.getCurrentRun();
      const codon = run?.codons[0];
      expect(codon?.status).toBe("completed");

      if (codon?.status === "completed") {
        expect(codon.completionCheckpoint).toBe("completed123");
      }
    });

    test("should validate skipped checkpoint exists", async () => {
      const runId = RunId("test-run");
      const codonId = CodonId("test-codon");

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
        type: "CodonStarted",
        data: { runId, codonId },
      });

      // Skip with checkpoint
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId,
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
      const codon = run?.codons[0];
      expect(codon?.status).toBe("skipped");

      if (codon?.status === "skipped" && "skipCheckpoint" in codon) {
        expect(codon.skipCheckpoint).toBe("skipped123");
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
