import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  StateManager,
  InvalidTransitionError,
  PersistenceError,
} from "../../server/state-manager.js";
import { RunId, PhaseId, SessionId } from "../../server/branded-types.js";
import type * as ST from "../../server/state-types.js";
import { Logger } from "../../server/utils.js";

// Test directory setup
const TEST_DIR = path.join(__dirname, "test-state-manager");
const TEST_LANGTON_DIR = path.join(TEST_DIR, ".langton");

// Mock logger - extends Logger to handle private property
class MockLogger extends Logger {
  logs: Array<{ message: string; level: string }> = [];

  constructor(logFile: string) {
    super(logFile);
  }

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }

  logSocketTraffic(
    socketLogFile: string,
    direction: "in" | "out",
    data: unknown
  ): void {
    // Mock implementation
  }
}

describe("StateManager", () => {
  let stateManager: StateManager;
  let mockLogger: MockLogger;

  beforeEach(async () => {
    // Create test directory
    await fs.promises.mkdir(TEST_LANGTON_DIR, { recursive: true });

    // Create mock logger
    mockLogger = new MockLogger("");

    // Create state manager
    stateManager = new StateManager(TEST_LANGTON_DIR, mockLogger);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  });

  describe("initialization", () => {
    test("creates new state when no file exists", async () => {
      await stateManager.initialize();

      const state = stateManager.getState();
      expect(state.runs).toEqual([]);
      expect(state.currentRunId).toBeNull();

      // Check log messages
      expect(
        mockLogger.logs.some((log) =>
          log.message.includes("No state file found")
        )
      ).toBe(true);
    });

    test("loads existing state from disk", async () => {
      // Create a state file
      const existingState: ST.LangtonState = {
        runs: [
          {
            runId: RunId("test-run-1"),
            runFolder: "/test/runs/test-run-1",
            gitBranch: "run-test-run-1",
            startingConditions: { type: "fresh" },
            phases: [],
            status: "completed",
            startTime: "2024-01-01T00:00:00Z",
            endTime: "2024-01-01T01:00:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
      };

      const statePath = path.join(TEST_LANGTON_DIR, "state.json");
      await fs.promises.writeFile(statePath, JSON.stringify(existingState));

      await stateManager.initialize();

      const state = stateManager.getState();
      expect(state.runs).toHaveLength(1);
      expect(state.runs[0].runId).toBe(RunId("test-run-1"));

      expect(
        mockLogger.logs.some((log) =>
          log.message.includes("Loaded existing state file")
        )
      ).toBe(true);
    });

    test("recovers from backup when main file corrupted", async () => {
      // Create corrupted main file
      const statePath = path.join(TEST_LANGTON_DIR, "state.json");
      await fs.promises.writeFile(statePath, "{ invalid json");

      // Create valid backup
      const backupState: ST.LangtonState = {
        runs: [
          {
            runId: RunId("backup-run"),
            runFolder: "/test/runs/backup-run",
            gitBranch: "run-backup-run",
            startingConditions: { type: "fresh" },
            phases: [],
            status: "completed",
            startTime: "2024-01-01T00:00:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
      };

      const backupPath = path.join(TEST_LANGTON_DIR, "state.json.bak");
      await fs.promises.writeFile(backupPath, JSON.stringify(backupState));

      await stateManager.initialize();

      const state = stateManager.getState();
      expect(state.runs).toHaveLength(1);
      expect(state.runs[0].runId).toBe(RunId("backup-run"));

      expect(
        mockLogger.logs.some((log) =>
          log.message.includes("Recovered from backup state file")
        )
      ).toBe(true);
    });

    test("detects crashed runs on startup", async () => {
      // Create state with running run from dead process
      const existingState: ST.LangtonState = {
        runs: [
          {
            runId: RunId("crashed-run"),
            runFolder: "/test/runs/crashed-run",
            gitBranch: "run-crashed-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: PhaseId("test-phase"),
                startTime: "2024-01-01T00:00:00Z",
                status: "running",
                claudeSessionId: SessionId("test-session"),
                claudeLogPath: "test.log",
                claudePid: 99999,
                currentCost: 0,
                currentTokens: {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
              },
            ],
            status: "running",
            startTime: "2024-01-01T00:00:00Z",
            serverPid: 99999, // Non-existent process
          },
        ],
        currentRunId: null,
      };

      const statePath = path.join(TEST_LANGTON_DIR, "state.json");
      await fs.promises.writeFile(statePath, JSON.stringify(existingState));

      await stateManager.initialize();

      // Wait for async transition to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = stateManager.getState();
      expect(state.runs[0].status).toBe("crashed");
      expect(state.runs[0].phases[0].status).toBe("failed");
    });
  });

  describe("state transitions", () => {
    beforeEach(async () => {
      await stateManager.initialize();
    });

    test("validates legal transitions", async () => {
      // Start a run
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      // Start a phase
      stateManager.transition({
        type: "PhaseStarted",
        data: {
          runId: RunId("test-run"),
          phaseId: PhaseId("test-phase"),
        },
      });

      // Transition through states
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: RunId("test-run"),
          phaseId: PhaseId("test-phase"),
          from: "preparing",
          to: "starting",
        },
      });

      // Wait for transitions to process
      await stateManager.waitForPendingTransitions();

      const state = stateManager.getState();
      expect(state.currentRunId).toBe(RunId("test-run"));
      expect(state.runs[0].phases[0].status).toBe("starting");
    });

    test("rejects invalid transitions", async () => {
      // Start a run and phase
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: {
          runId: RunId("test-run"),
          phaseId: PhaseId("test-phase"),
        },
      });

      // Try invalid transition
      let errorEmitted = false;
      stateManager.on("transitionError", ({ error }) => {
        expect(error).toBeInstanceOf(InvalidTransitionError);
        errorEmitted = true;
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: RunId("test-run"),
          phaseId: PhaseId("test-phase"),
          from: "preparing",
          to: "completed", // Invalid: can't go directly to completed
        },
      });

      await stateManager.waitForPendingTransitions();
      expect(errorEmitted).toBe(true);
    });

    test("persists after each transition", async () => {
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      await stateManager.waitForPendingTransitions();

      // Check that state file exists
      const statePath = path.join(TEST_LANGTON_DIR, "state.json");
      expect(fs.existsSync(statePath)).toBe(true);

      // Load and verify content
      const savedState = JSON.parse(
        await fs.promises.readFile(statePath, "utf-8")
      );
      expect(savedState.currentRunId).toBe("test-run");
      expect(savedState.runs).toHaveLength(1);
    });

    test("maintains immutability of terminal states", async () => {
      // Create a completed phase
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: {
          runId: RunId("test-run"),
          phaseId: PhaseId("test-phase"),
        },
      });

      // Progress through to completed
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
        { from: "running", to: "completing" },
        {
          from: "completing",
          to: "completed",
          metadata: { checkpointSha: "abc123" },
        },
      ];

      for (const t of transitions) {
        stateManager.transition({
          type: "PhaseTransitioned",
          data: {
            runId: RunId("test-run"),
            phaseId: PhaseId("test-phase"),
            from: t.from as ST.PhaseStatus,
            to: t.to as ST.PhaseStatus,
            metadata: t.metadata,
          },
        });
      }

      await stateManager.waitForPendingTransitions();

      // Try to transition from completed (should fail)
      let errorEmitted = false;
      stateManager.on("transitionError", () => {
        errorEmitted = true;
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: RunId("test-run"),
          phaseId: PhaseId("test-phase"),
          from: "completed",
          to: "failed",
        },
      });

      await stateManager.waitForPendingTransitions();
      expect(errorEmitted).toBe(true);

      // Verify phase is still completed
      const state = stateManager.getState();
      expect(state.runs[0].phases[0].status).toBe("completed");
    });

    test("handles rapid transitions without corruption", async () => {
      // Fire many transitions rapidly
      const runId = RunId("rapid-test");

      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/rapid-test",
          gitBranch: "run-rapid-test",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      // Start 5 phases rapidly
      for (let i = 0; i < 5; i++) {
        stateManager.transition({
          type: "PhaseStarted",
          data: {
            runId,
            phaseId: PhaseId(`phase-${i}`),
          },
        });
      }

      await stateManager.waitForPendingTransitions();

      const state = stateManager.getState();
      expect(state.runs[0].phases).toHaveLength(5);

      // Verify state file is valid
      const statePath = path.join(TEST_LANGTON_DIR, "state.json");
      const savedState = JSON.parse(
        await fs.promises.readFile(statePath, "utf-8")
      );
      expect(savedState.runs[0].phases).toHaveLength(5);
    });
  });

  describe("queries", () => {
    const runId = RunId("query-test");
    const phaseId = PhaseId("test-phase");

    beforeEach(async () => {
      await stateManager.initialize();

      // Set up a run with phases
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/query-test",
          gitBranch: "run-query-test",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: { runId, phaseId },
      });

      await stateManager.waitForPendingTransitions();
    });

    test("getCurrentRun returns active run", () => {
      const currentRun = stateManager.getCurrentRun();
      expect(currentRun).not.toBeNull();
      expect(currentRun!.runId).toBe(runId);
    });

    test("getCurrentPhase returns running phase", async () => {
      // Progress to running state
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId,
          from: "preparing",
          to: "starting",
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId,
          from: "starting",
          to: "initializing",
          metadata: { claudePid: 123, claudeLogPath: "test.log" },
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId,
          from: "initializing",
          to: "running",
          metadata: { claudeSessionId: SessionId("session-123") },
        },
      });

      await stateManager.waitForPendingTransitions();

      const currentPhase = stateManager.getCurrentPhase();
      expect(currentPhase).not.toBeNull();
      expect(currentPhase!.status).toBe("running");
      expect(currentPhase!.phaseId).toBe(phaseId);
    });

    test("getLastSuccessfulPhase searches all runs", async () => {
      // Complete current phase
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
        { from: "running", to: "completing" },
        {
          from: "completing",
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

      // Complete the run
      stateManager.transition({
        type: "RunCompleted",
        data: { runId },
      });

      await stateManager.waitForPendingTransitions();

      // Start a new run
      const newRunId = RunId("new-run");
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: newRunId,
          runFolder: "/test/runs/new-run",
          gitBranch: "run-new-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      await stateManager.waitForPendingTransitions();

      // Search for last successful
      const result = stateManager.getLastSuccessfulPhase(phaseId);
      expect(result).not.toBeNull();
      expect(result!.run.runId).toBe(runId);
      expect(result!.phase.status).toBe("completed");
    });

    test("cost calculations sum correctly", async () => {
      // Update costs
      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId,
          from: "preparing",
          to: "starting",
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId,
          from: "starting",
          to: "initializing",
          metadata: { claudePid: 123, claudeLogPath: "test.log" },
        },
      });

      stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId,
          phaseId,
          from: "initializing",
          to: "running",
          metadata: { claudeSessionId: SessionId("session-123") },
        },
      });

      // Add some costs
      stateManager.transition({
        type: "CostsUpdated",
        data: {
          runId,
          phaseId,
          cost: 0.05,
          tokens: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        },
      });

      await stateManager.waitForPendingTransitions();

      expect(stateManager.getCurrentRunCost()).toBe(0.05);
      expect(stateManager.getTotalCost()).toBe(0.05);

      // Add more cost
      stateManager.transition({
        type: "CostsUpdated",
        data: {
          runId,
          phaseId,
          cost: 0.1,
          tokens: {
            inputTokens: 2000,
            outputTokens: 1000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        },
      });

      await stateManager.waitForPendingTransitions();

      expect(stateManager.getCurrentRunCost()).toBe(0.1);
      expect(stateManager.getTotalCost()).toBe(0.1);
    });
  });

  describe("persistence", () => {
    beforeEach(async () => {
      await stateManager.initialize();
    });

    test("atomic writes with backup", async () => {
      // Create initial state
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: RunId("persist-test"),
          runFolder: "/test/runs/persist-test",
          gitBranch: "run-persist-test",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      await stateManager.waitForPendingTransitions();

      const statePath = path.join(TEST_LANGTON_DIR, "state.json");
      const backupPath = path.join(TEST_LANGTON_DIR, "state.json.bak");

      // First save creates state file, no backup yet
      expect(fs.existsSync(statePath)).toBe(true);
      expect(fs.existsSync(backupPath)).toBe(false);

      // Second transition creates backup
      stateManager.transition({
        type: "PhaseStarted",
        data: {
          runId: RunId("persist-test"),
          phaseId: PhaseId("test-phase"),
        },
      });

      await stateManager.waitForPendingTransitions();

      expect(fs.existsSync(statePath)).toBe(true);
      expect(fs.existsSync(backupPath)).toBe(true);

      // Backup should contain previous state
      const backupState = JSON.parse(
        await fs.promises.readFile(backupPath, "utf-8")
      );
      expect(backupState.runs[0].phases).toHaveLength(0);

      // Current state should have phase
      const currentState = JSON.parse(
        await fs.promises.readFile(statePath, "utf-8")
      );
      expect(currentState.runs[0].phases).toHaveLength(1);
    });

    test("validates state integrity", () => {
      // Test with valid state
      const validState: ST.LangtonState = {
        runs: [],
        currentRunId: null,
      };

      const validation = stateManager.validate(validState);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);

      // Test with corrupted state
      const corruptedValidation = stateManager.validate({
        invalid: "structure",
      });
      expect(corruptedValidation.valid).toBe(false);
      expect(
        corruptedValidation.errors.some((e) => e.type === "corrupted_data")
      ).toBe(true);

      // Test with missing run reference
      const missingRunState: ST.LangtonState = {
        runs: [],
        currentRunId: RunId("non-existent"),
      };

      const missingValidation = stateManager.validate(missingRunState);
      expect(missingValidation.valid).toBe(false);
      expect(
        missingValidation.errors.some((e) => e.type === "missing_run")
      ).toBe(true);
    });
  });

  describe("event emission", () => {
    beforeEach(async () => {
      await stateManager.initialize();
    });

    test("emits stateChanged after transitions", async () => {
      let eventEmitted = false;

      stateManager.on("stateChanged", (event) => {
        expect(event.type).toBe("RunStarted");
        eventEmitted = true;
      });

      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: RunId("event-test"),
          runFolder: "/test/runs/event-test",
          gitBranch: "run-event-test",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      await stateManager.waitForPendingTransitions();
      expect(eventEmitted).toBe(true);
    });

    test("emits phaseRunning when phase starts running", async () => {
      let phaseRunningEmitted = false;

      stateManager.on("phaseRunning", (data) => {
        expect(data.phaseId).toBe(PhaseId("test-phase"));
        expect(data.to).toBe("running");
        phaseRunningEmitted = true;
      });

      // Set up run and phase
      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: RunId("event-test"),
          runFolder: "/test/runs/event-test",
          gitBranch: "run-event-test",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      stateManager.transition({
        type: "PhaseStarted",
        data: {
          runId: RunId("event-test"),
          phaseId: PhaseId("test-phase"),
        },
      });

      // Progress through states
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
            runId: RunId("event-test"),
            phaseId: PhaseId("test-phase"),
            from: t.from as ST.PhaseStatus,
            to: t.to as ST.PhaseStatus,
            metadata: t.metadata,
          },
        });
      }

      await stateManager.waitForPendingTransitions();
      expect(phaseRunningEmitted).toBe(true);
    });
  });

  describe("recovery scenarios", () => {
    test("handles missing state file gracefully", async () => {
      // Initialize with no state file
      await stateManager.initialize();

      const state = stateManager.getState();
      expect(state.runs).toEqual([]);
      expect(state.currentRunId).toBeNull();
    });

    test("continues after persistence errors", async () => {
      await stateManager.initialize();

      // Make directory read-only to cause save error
      const statePath = path.join(TEST_LANGTON_DIR, "state.json");
      await fs.promises.writeFile(statePath, "dummy");
      await fs.promises.chmod(TEST_LANGTON_DIR, 0o444); // Read-only

      let errorEmitted = false;
      stateManager.on("transitionError", ({ error }) => {
        expect(error).toBeInstanceOf(PersistenceError);
        errorEmitted = true;
      });

      stateManager.transition({
        type: "RunStarted",
        data: {
          runId: RunId("error-test"),
          runFolder: "/test/runs/error-test",
          gitBranch: "run-error-test",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      await stateManager.waitForPendingTransitions();

      // Restore permissions
      await fs.promises.chmod(TEST_LANGTON_DIR, 0o755);

      // State should still be updated in memory despite save error
      const state = stateManager.getState();
      expect(state.currentRunId).toBe(RunId("error-test"));
    });
  });
});
