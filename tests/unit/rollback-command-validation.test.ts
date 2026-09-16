import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout";
import { StateManager } from "../../server/state-manager";
import { CodonId, RunId, SessionId } from "../../server/types/branded-types";
import type * as ST from "../../server/types/state-types";
import { Logger } from "../../server/utils";

// Test directory setup
const TEST_DIR = path.join(import.meta.dir, "test-rollback-validation");
const TEST_HANKWEAVE_DIR = path.join(TEST_DIR, ".hankweave");

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
    await fs.promises.mkdir(TEST_HANKWEAVE_DIR, { recursive: true });

    // Create mock logger
    mockLogger = new MockLogger("");

    // Create state manager
    stateManager = new StateManager(new ExecutionLayout(TEST_DIR), mockLogger);
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

    // A completed codon must carry a non-empty checkpoint SHA. The transition
    // guard rejects "" at write time (a swallowed checkpoint failure can no
    // longer mint it), and state.json written by older builds that does carry
    // "" is refused as a rollback target at load time.
    async function driveCodonToRunning(sm: StateManager): Promise<void> {
      const runId = RunId("test-run");
      const codonId = CodonId("test-codon");
      sm.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });
      sm.transition({ type: "CodonStarted", data: { runId, codonId } });
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
        sm.transition({
          type: "CodonTransitioned",
          data: {
            runId,
            codonId,
            from: t.from as ST.CodonStatus,
            to: t.to as ST.CodonStatus,
            metadata: t.metadata,
          },
        });
        await sm.waitForPendingTransitions();
      }
    }

    test.each([
      ["a blank checkpoint SHA", { checkpointSha: "" }],
      ["no checkpoint SHA", {}],
    ])("completing a codon with %s is rejected", async (_label, metadata) => {
      await driveCodonToRunning(stateManager);

      const errors: Error[] = [];
      stateManager.on("transitionError", ({ error }) => errors.push(error));
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: RunId("test-run"),
          codonId: CodonId("test-codon"),
          from: "running",
          to: "completed",
          metadata,
        },
      });
      await stateManager.waitForPendingTransitions();

      expect(errors).toHaveLength(1);
      expect(errors[0].name).toBe("MetadataValidationError");
      expect(errors[0].message).toContain("checkpointSha");
      // The codon never became completed, so nothing can continue from it.
      const codon = stateManager.getCurrentRun()?.codons[0];
      expect(codon?.status).toBe("running");
      expect(stateManager.canContinueFrom(RunId("test-run"), CodonId("test-codon"))).toBe(false);
    });

    test("a completed codon with a real SHA is accepted", async () => {
      await driveCodonToRunning(stateManager);
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: RunId("test-run"),
          codonId: CodonId("test-codon"),
          from: "running",
          to: "completed",
          metadata: { checkpointSha: "abc123" },
        },
      });
      await stateManager.waitForPendingTransitions();
      const codon = stateManager.getCurrentRun()?.codons[0];
      expect(codon?.status).toBe("completed");
      if (codon?.status === "completed") expect(codon.completionCheckpoint).toBe("abc123");
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
