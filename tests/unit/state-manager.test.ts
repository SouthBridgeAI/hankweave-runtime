import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { InvalidTransitionError, PersistenceError, StateManager } from "../../server/state-manager";
import { CodonId, RunId, SessionId } from "../../server/types/branded-types";
import type * as ST from "../../server/types/state-types";
import { Logger } from "../../server/utils";
import { createTestCodon, createTestConfig } from "../utils/test-codon-factory.js";

// Test directory setup
const TEST_DIR = path.join(import.meta.dir, "test-state-manager");
const TEST_HANKWEAVE_DIR = path.join(TEST_DIR, ".hankweave");

// Mock logger - extends Logger to handle private property
class MockLogger extends Logger {
  logs: Array<{ message: string; level: string }> = [];

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }

  logSocketTraffic(_socketLogFile: string, _direction: "in" | "out", _data: unknown): void {
    // Mock implementation
  }
}

describe("StateManager", () => {
  let stateManager: StateManager;
  let mockLogger: MockLogger;

  beforeEach(async () => {
    // Create test directory
    await fs.promises.mkdir(TEST_HANKWEAVE_DIR, { recursive: true });

    // Create mock logger
    mockLogger = new MockLogger("");

    // Create state manager
    stateManager = new StateManager(TEST_HANKWEAVE_DIR, mockLogger);
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
      expect(mockLogger.logs.some((log) => log.message.includes("No state file found"))).toBe(true);
    });

    test("loads existing state from disk", async () => {
      // Create a state file
      const existingState: ST.HankweaveState = {
        runs: [
          {
            runId: RunId("test-run-1"),
            runFolder: "/test/runs/test-run-1",
            gitBranch: "run-test-run-1",
            startingConditions: { type: "fresh" },
            codons: [],
            status: "completed",
            startTime: "2024-01-01T00:00:00Z",
            endTime: "2024-01-01T01:00:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
        executionPlan: [],
      };

      const statePath = path.join(TEST_HANKWEAVE_DIR, "state.json");
      await fs.promises.writeFile(statePath, JSON.stringify(existingState));

      await stateManager.initialize();

      const state = stateManager.getState();
      expect(state.runs).toHaveLength(1);
      expect(state.runs[0].runId).toBe(RunId("test-run-1"));

      expect(
        mockLogger.logs.some((log) => log.message.includes("Loaded existing state file")),
      ).toBe(true);
    });

    test("recovers from backup when main file corrupted", async () => {
      // Create corrupted main file
      const statePath = path.join(TEST_HANKWEAVE_DIR, "state.json");
      await fs.promises.writeFile(statePath, "{ invalid json");

      // Create valid backup
      const backupState: ST.HankweaveState = {
        runs: [
          {
            runId: RunId("backup-run"),
            runFolder: "/test/runs/backup-run",
            gitBranch: "run-backup-run",
            startingConditions: { type: "fresh" },
            codons: [],
            status: "completed",
            startTime: "2024-01-01T00:00:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
        executionPlan: [],
      };

      const backupPath = path.join(TEST_HANKWEAVE_DIR, "state.json.bak");
      await fs.promises.writeFile(backupPath, JSON.stringify(backupState));

      await stateManager.initialize();

      const state = stateManager.getState();
      expect(state.runs).toHaveLength(1);
      expect(state.runs[0].runId).toBe(RunId("backup-run"));

      expect(
        mockLogger.logs.some((log) => log.message.includes("Recovered from backup state file")),
      ).toBe(true);
    });

    test("detects crashed runs on startup", async () => {
      // Ensure directory structure exists for atomic writes
      await fs.promises.mkdir(TEST_HANKWEAVE_DIR, { recursive: true });

      // Create state with running run from dead process
      const existingState: ST.HankweaveState = {
        runs: [
          {
            runId: RunId("crashed-run"),
            runFolder: "/test/runs/crashed-run",
            gitBranch: "run-crashed-run",
            startingConditions: { type: "fresh" },
            codons: [
              {
                codonId: CodonId("test-codon"),
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
                assistantMessageCount: 0,
                extensionCount: 0,
              },
            ],
            status: "running",
            startTime: "2024-01-01T00:00:00Z",
            serverPid: 99999, // Non-existent process
          },
        ],
        currentRunId: null,
        executionPlan: [],
      };

      const statePath = path.join(TEST_HANKWEAVE_DIR, "state.json");
      await fs.promises.writeFile(statePath, JSON.stringify(existingState));

      await stateManager.initialize();

      // Wait for async transition to process and persist
      await stateManager.waitForPendingTransitions();

      const state = stateManager.getState();
      expect(state.runs[0].status).toBe("crashed");
      expect(state.runs[0].codons[0].status).toBe("failed");
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

      // Start a codon
      stateManager.transition({
        type: "CodonStarted",
        data: {
          runId: RunId("test-run"),
          codonId: CodonId("test-codon"),
        },
      });

      // Transition through states
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: RunId("test-run"),
          codonId: CodonId("test-codon"),
          from: "preparing",
          to: "starting",
        },
      });

      // Wait for transitions to process
      await stateManager.waitForPendingTransitions();

      const state = stateManager.getState();
      expect(state.currentRunId).toBe(RunId("test-run"));
      expect(state.runs[0].codons[0].status).toBe("starting");
    });

    test("rejects invalid transitions", async () => {
      // Start a run and codon
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
        type: "CodonStarted",
        data: {
          runId: RunId("test-run"),
          codonId: CodonId("test-codon"),
        },
      });

      // Try invalid transition
      let errorEmitted = false;
      stateManager.on("transitionError", ({ error }) => {
        expect(error).toBeInstanceOf(InvalidTransitionError);
        errorEmitted = true;
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: RunId("test-run"),
          codonId: CodonId("test-codon"),
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
      const statePath = path.join(TEST_HANKWEAVE_DIR, "state.json");
      expect(fs.existsSync(statePath)).toBe(true);

      // Load and verify content
      const savedState = JSON.parse(await fs.promises.readFile(statePath, "utf-8"));
      expect(savedState.currentRunId).toBe("test-run");
      expect(savedState.runs).toHaveLength(1);
    });

    test("maintains immutability of terminal states", async () => {
      // Create a completed codon
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
        type: "CodonStarted",
        data: {
          runId: RunId("test-run"),
          codonId: CodonId("test-codon"),
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
            runId: RunId("test-run"),
            codonId: CodonId("test-codon"),
            from: t.from as ST.CodonStatus,
            to: t.to as ST.CodonStatus,
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
        type: "CodonTransitioned",
        data: {
          runId: RunId("test-run"),
          codonId: CodonId("test-codon"),
          from: "completed",
          to: "failed",
        },
      });

      await stateManager.waitForPendingTransitions();
      expect(errorEmitted).toBe(true);

      // Verify codon is still completed
      const state = stateManager.getState();
      expect(state.runs[0].codons[0].status).toBe("completed");
    });

    test("getCodonInCurrentRun returns the LATEST record after a retry (not the stale failed one)", async () => {
      // Regression a post-retry wedge: a retried codon
      // appends a SECOND execution record (CodonStarted pushes) while the failed
      // attempt's record stays terminal. getCodonInCurrentRun must return the
      // latest (the live retry), not find-first the terminal "failed" record —
      // otherwise handleCodonComplete sees a terminal status and early-returns,
      // wedging the run after the retry SUCCEEDS.
      const runId = RunId("retry-run");
      const codonId = CodonId("analyze#4");

      stateManager.transition({
        type: "RunStarted",
        data: {
          runId,
          runFolder: "/test/runs/retry-run",
          gitBranch: "run-retry-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });

      // Attempt 1: drive to a terminal "failed" record.
      stateManager.transition({
        type: "CodonStarted",
        data: { runId, codonId },
      });
      const toFailed: Array<{
        from: string;
        to: string;
        metadata?: Record<string, unknown>;
      }> = [
        { from: "preparing", to: "starting" },
        {
          from: "starting",
          to: "initializing",
          metadata: { claudePid: 1, claudeLogPath: "a.log" },
        },
        {
          from: "initializing",
          to: "running",
          metadata: { claudeSessionId: SessionId("s-1") },
        },
        {
          from: "running",
          to: "failed",
          metadata: {
            failedDuring: "running",
            exitCode: 1,
            failureReason: {
              type: "api-error",
              retriable: true,
              message: "transient socket drop",
            },
          },
        },
      ];
      for (const t of toFailed) {
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

      // Attempt 2 (the retry): a fresh record is pushed for the SAME codonId.
      stateManager.transition({
        type: "CodonStarted",
        data: { runId, codonId },
      });
      await stateManager.waitForPendingTransitions();

      // Two records exist: [failed, preparing]. The helper must return the latest.
      const records = stateManager.getCurrentRun()?.codons.filter((c) => c.codonId === codonId);
      expect(records?.length).toBe(2);
      expect(records?.[0].status).toBe("failed");

      const current = stateManager.getCodonInCurrentRun(codonId);
      expect(current?.status).toBe("preparing");
      expect(current?.status).not.toBe("failed");
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

      // Start 5 codons rapidly
      for (let i = 0; i < 5; i++) {
        stateManager.transition({
          type: "CodonStarted",
          data: {
            runId,
            codonId: CodonId(`codon-${i}`),
          },
        });
      }

      await stateManager.waitForPendingTransitions();

      const state = stateManager.getState();
      expect(state.runs[0].codons).toHaveLength(5);

      // Verify state file is valid
      const statePath = path.join(TEST_HANKWEAVE_DIR, "state.json");
      const savedState = JSON.parse(await fs.promises.readFile(statePath, "utf-8"));
      expect(savedState.runs[0].codons).toHaveLength(5);
    });
  });

  describe("queries", () => {
    const runId = RunId("query-test");
    const codonId = CodonId("test-codon");

    beforeEach(async () => {
      await stateManager.initialize();

      // Set up a run with codons
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
        type: "CodonStarted",
        data: { runId, codonId },
      });

      await stateManager.waitForPendingTransitions();
    });

    test("getCurrentRun returns active run", () => {
      const currentRun = stateManager.getCurrentRun();
      expect(currentRun).not.toBeNull();
      expect(currentRun?.runId).toBe(runId);
    });

    test("getCurrentlyRunningCodon returns running codon", async () => {
      // Progress to running state
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId,
          from: "preparing",
          to: "starting",
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId,
          from: "starting",
          to: "initializing",
          metadata: { claudePid: 123, claudeLogPath: "test.log" },
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId,
          from: "initializing",
          to: "running",
          metadata: { claudeSessionId: SessionId("session-123") },
        },
      });

      await stateManager.waitForPendingTransitions();

      const currentCodon = stateManager.getCurrentlyRunningCodon();
      expect(currentCodon).not.toBeNull();
      expect(currentCodon?.status).toBe("running");
      expect(currentCodon?.codonId).toBe(codonId);
    });

    test("cost calculations sum correctly", async () => {
      // Update costs
      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId,
          from: "preparing",
          to: "starting",
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId,
          from: "starting",
          to: "initializing",
          metadata: { claudePid: 123, claudeLogPath: "test.log" },
        },
      });

      stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId,
          codonId,
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
          codonId,
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
          codonId,
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

      const statePath = path.join(TEST_HANKWEAVE_DIR, "state.json");
      const backupPath = path.join(TEST_HANKWEAVE_DIR, "state.json.bak");

      // First save creates state file, no backup yet
      expect(fs.existsSync(statePath)).toBe(true);
      expect(fs.existsSync(backupPath)).toBe(false);

      // Second transition creates backup
      stateManager.transition({
        type: "CodonStarted",
        data: {
          runId: RunId("persist-test"),
          codonId: CodonId("test-codon"),
        },
      });

      await stateManager.waitForPendingTransitions();

      expect(fs.existsSync(statePath)).toBe(true);
      expect(fs.existsSync(backupPath)).toBe(true);

      // Backup should contain previous state
      const backupState = JSON.parse(await fs.promises.readFile(backupPath, "utf-8"));
      expect(backupState.runs[0].codons).toHaveLength(0);

      // Current state should have codon
      const currentState = JSON.parse(await fs.promises.readFile(statePath, "utf-8"));
      expect(currentState.runs[0].codons).toHaveLength(1);
    });

    test("validates state integrity", () => {
      // Test with valid state
      const validState: ST.HankweaveState = {
        runs: [],
        currentRunId: null,
        executionPlan: [],
      };

      const validation = stateManager.validate(validState);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);

      // Test with corrupted state
      const corruptedValidation = stateManager.validate({
        invalid: "structure",
      });
      expect(corruptedValidation.valid).toBe(false);
      expect(corruptedValidation.errors.some((e) => e.type === "corrupted_data")).toBe(true);

      // Test with missing run reference
      const missingRunState: ST.HankweaveState = {
        runs: [],
        currentRunId: RunId("non-existent"),
        executionPlan: [],
      };

      const missingValidation = stateManager.validate(missingRunState);
      expect(missingValidation.valid).toBe(false);
      expect(missingValidation.errors.some((e) => e.type === "missing_run")).toBe(true);
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

    test("emits codonRunning when codon starts running", async () => {
      let codonRunningEmitted = false;

      stateManager.on("codonRunning", (data) => {
        expect(data.codonId).toBe(CodonId("test-codon"));
        expect(data.to).toBe("running");
        codonRunningEmitted = true;
      });

      // Set up run and codon
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
        type: "CodonStarted",
        data: {
          runId: RunId("event-test"),
          codonId: CodonId("test-codon"),
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
          type: "CodonTransitioned",
          data: {
            runId: RunId("event-test"),
            codonId: CodonId("test-codon"),
            from: t.from as ST.CodonStatus,
            to: t.to as ST.CodonStatus,
            metadata: t.metadata,
          },
        });
      }

      await stateManager.waitForPendingTransitions();
      expect(codonRunningEmitted).toBe(true);
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
      const statePath = path.join(TEST_HANKWEAVE_DIR, "state.json");
      await fs.promises.writeFile(statePath, "dummy");
      await fs.promises.chmod(TEST_HANKWEAVE_DIR, 0o444); // Read-only

      let _errorEmitted = false;
      stateManager.on("transitionError", ({ error }) => {
        expect(error).toBeInstanceOf(PersistenceError);
        _errorEmitted = true;
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
      await fs.promises.chmod(TEST_HANKWEAVE_DIR, 0o755);

      // State should still be updated in memory despite save error
      const state = stateManager.getState();
      expect(state.currentRunId).toBe(RunId("error-test"));
    });
  });

  describe("expandNextIterationForCodon", () => {
    test("passes contextExceeded flag to planner", async () => {
      const codonConfigs = [
        createTestConfig({
          type: "loop",
          id: "test-loop",
          name: "Test Loop",
          codons: [
            {
              id: "work",
              name: "Work",
              model: "sonnet",
              continuationMode: "fresh",
              promptText: "Do work",
            },
          ],
          terminateOn: { type: "contextExceeded" },
        }),
      ];

      // Create state manager with codon configs
      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, codonConfigs);
      await smWithConfigs.initialize();

      // Trigger RunStarted to build initial plan
      smWithConfigs.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });
      await smWithConfigs.waitForPendingTransitions();

      // Verify initial plan has one codon (work#0)
      const initialState = smWithConfigs.getState();
      expect(initialState.executionPlan).toHaveLength(1);
      expect(initialState.executionPlan[0].codonId).toBe(CodonId("work#0"));

      // Expand without context exceeded - should add iteration 1
      await smWithConfigs.expandNextIterationForCodon({
        codonId: CodonId("work#0"),
        contextExceeded: false,
      });
      const expandedState = smWithConfigs.getState();
      expect(expandedState.executionPlan).toHaveLength(2);
      expect(expandedState.executionPlan[1].codonId).toBe(CodonId("work#1"));

      // Expand with context exceeded - should NOT add iteration 2
      await smWithConfigs.expandNextIterationForCodon({
        codonId: CodonId("work#1"),
        contextExceeded: true,
      });
      const finalState = smWithConfigs.getState();
      expect(finalState.executionPlan).toHaveLength(2); // No new iteration
    });

    test("persists updated plan after expansion", async () => {
      const codonConfigs = [
        createTestConfig({
          type: "loop",
          id: "test-loop",
          name: "Test Loop",
          codons: [
            {
              id: "codon",
              name: "Codon",
              model: "sonnet",
              continuationMode: "fresh",
              promptText: "Test",
            },
          ],
          terminateOn: { type: "iterationLimit", limit: 3 },
        }),
      ];

      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, codonConfigs);
      await smWithConfigs.initialize();

      // Trigger RunStarted to build initial plan
      smWithConfigs.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });
      await smWithConfigs.waitForPendingTransitions();

      // Expand iteration
      await smWithConfigs.expandNextIterationForCodon({
        codonId: CodonId("codon#0"),
      });

      // Verify plan was updated in memory
      const state = smWithConfigs.getState();
      expect(state.executionPlan).toHaveLength(2);

      // Create new state manager and load from disk to verify persistence
      const smReloaded = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, codonConfigs);
      await smReloaded.initialize();

      const reloadedState = smReloaded.getState();
      expect(reloadedState.executionPlan).toHaveLength(2);
      expect(reloadedState.executionPlan[1].codonId).toBe(CodonId("codon#1"));
    });

    test("validates plan after expansion", async () => {
      const codonConfigs = [
        createTestConfig({
          type: "loop",
          id: "loop",
          name: "Loop",
          codons: [
            {
              id: "p",
              name: "P",
              model: "sonnet",
              continuationMode: "fresh",
              promptText: "P",
            },
          ],
          terminateOn: { type: "iterationLimit", limit: 3 },
        }),
      ];

      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, codonConfigs);
      await smWithConfigs.initialize();

      // Trigger RunStarted to build initial plan
      smWithConfigs.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });
      await smWithConfigs.waitForPendingTransitions();

      // Expansion should succeed with valid plan
      await expect(async () => {
        await smWithConfigs.expandNextIterationForCodon({
          codonId: CodonId("p#0"),
        });
      }).not.toThrow();
    });

    test("handles codon not found in plan", async () => {
      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, []);
      await smWithConfigs.initialize();

      // Try to expand non-existent codon - should return early without error
      await smWithConfigs.expandNextIterationForCodon({
        codonId: CodonId("nonexistent"),
      });

      // Execution plan should remain unchanged
      const state = smWithConfigs.getState();
      expect(state.executionPlan).toHaveLength(0);
    });

    test("default contextExceeded=false continues loop", async () => {
      const codonConfigs = [
        createTestConfig({
          type: "loop",
          id: "loop",
          name: "Loop",
          codons: [
            {
              id: "p",
              name: "P",
              model: "sonnet",
              continuationMode: "fresh",
              promptText: "P",
            },
          ],
          terminateOn: { type: "contextExceeded" },
        }),
      ];

      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, codonConfigs);
      await smWithConfigs.initialize();

      // Trigger RunStarted to build initial plan
      smWithConfigs.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });
      await smWithConfigs.waitForPendingTransitions();

      // Call without contextExceeded parameter (defaults to false)
      await smWithConfigs.expandNextIterationForCodon({
        codonId: CodonId("p#0"),
      });

      // Should expand (not terminate)
      expect(smWithConfigs.getState().executionPlan).toHaveLength(2);
    });
  });

  describe("isContextExceededAcceptable", () => {
    test("returns true for codon in loop with contextExceeded termination", async () => {
      const codonConfigs = [
        createTestConfig({
          type: "loop",
          id: "context-loop",
          name: "Context Loop",
          codons: [
            {
              id: "work",
              name: "Work",
              model: "sonnet",
              continuationMode: "fresh",
              promptText: "Do work",
            },
          ],
          terminateOn: { type: "contextExceeded" },
        }),
      ];

      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, codonConfigs);
      await smWithConfigs.initialize();

      // Trigger RunStarted to build initial plan
      smWithConfigs.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });
      await smWithConfigs.waitForPendingTransitions();

      // Check if context exceeded is acceptable for this codon
      const acceptable = smWithConfigs.isContextExceededAcceptable(CodonId("work#0"));
      expect(acceptable).toBe(true);
    });

    test("returns false for codon in loop with iterationLimit termination", async () => {
      const codonConfigs = [
        createTestConfig({
          type: "loop",
          id: "limited-loop",
          name: "Limited Loop",
          codons: [
            {
              id: "work",
              name: "Work",
              model: "sonnet",
              continuationMode: "fresh",
              promptText: "Do work",
            },
          ],
          terminateOn: { type: "iterationLimit", limit: 3 },
        }),
      ];

      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, codonConfigs);
      await smWithConfigs.initialize();

      // Trigger RunStarted to build initial plan
      smWithConfigs.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });
      await smWithConfigs.waitForPendingTransitions();

      // Context exceeded NOT acceptable for iterationLimit loops
      const acceptable = smWithConfigs.isContextExceededAcceptable(CodonId("work#0"));
      expect(acceptable).toBe(false);
    });

    test("returns false for regular codon (not in loop)", async () => {
      const codonConfigs = [
        createTestCodon({
          id: "regular",
          name: "Regular Codon",
          model: "sonnet",
          continuationMode: "fresh",
          promptText: "Do work",
        }),
      ];

      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, codonConfigs);
      await smWithConfigs.initialize();

      // Trigger RunStarted to build initial plan
      smWithConfigs.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });
      await smWithConfigs.waitForPendingTransitions();

      // Regular codons don't accept context exceeded
      const acceptable = smWithConfigs.isContextExceededAcceptable(CodonId("regular"));
      expect(acceptable).toBe(false);
    });

    test("returns false for codon not found in plan", async () => {
      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, []);
      await smWithConfigs.initialize();

      // Codon doesn't exist in plan
      const acceptable = smWithConfigs.isContextExceededAcceptable(CodonId("nonexistent"));
      expect(acceptable).toBe(false);
    });

    test("returns false if no codon configs provided", async () => {
      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger);
      await smWithConfigs.initialize();

      // No codon configs means no loops
      const acceptable = smWithConfigs.isContextExceededAcceptable(CodonId("any-codon"));
      expect(acceptable).toBe(false);
    });

    test("works correctly for different codons in same loop", async () => {
      const codonConfigs = [
        createTestConfig({
          type: "loop",
          id: "multi-codon-loop",
          name: "Multi Codon Loop",
          codons: [
            {
              id: "codon1",
              name: "Codon 1",
              model: "sonnet",
              continuationMode: "fresh",
              promptText: "P1",
            },
            {
              id: "codon2",
              name: "Codon 2",
              model: "sonnet",
              continuationMode: "fresh",
              promptText: "P2",
            },
          ],
          terminateOn: { type: "contextExceeded" },
        }),
      ];

      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, codonConfigs);
      await smWithConfigs.initialize();

      // Trigger RunStarted to build initial plan
      smWithConfigs.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });
      await smWithConfigs.waitForPendingTransitions();

      // Both codons in the same loop should accept context exceeded
      expect(smWithConfigs.isContextExceededAcceptable(CodonId("codon1#0"))).toBe(true);
      expect(smWithConfigs.isContextExceededAcceptable(CodonId("codon2#0"))).toBe(true);
    });

    test("works correctly for multiple loops with different termination types", async () => {
      const codonConfigs = [
        createTestConfig({
          type: "loop",
          id: "context-loop",
          name: "Context Loop",
          codons: [
            {
              id: "work1",
              name: "Work 1",
              model: "sonnet",
              continuationMode: "fresh",
              promptText: "W1",
            },
          ],
          terminateOn: { type: "contextExceeded" },
        }),
        createTestConfig({
          type: "loop",
          id: "limited-loop",
          name: "Limited Loop",
          codons: [
            {
              id: "work2",
              name: "Work 2",
              model: "sonnet",
              continuationMode: "fresh",
              promptText: "W2",
            },
          ],
          terminateOn: { type: "iterationLimit", limit: 2 },
        }),
      ];

      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, codonConfigs);
      await smWithConfigs.initialize();

      // Trigger RunStarted to build initial plan
      smWithConfigs.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });
      await smWithConfigs.waitForPendingTransitions();

      // First loop accepts context exceeded
      expect(smWithConfigs.isContextExceededAcceptable(CodonId("work1#0"))).toBe(true);

      // Second loop does NOT accept context exceeded
      expect(smWithConfigs.isContextExceededAcceptable(CodonId("work2#0"))).toBe(false);
    });

    test("works correctly after loop expansion", async () => {
      const codonConfigs = [
        createTestConfig({
          type: "loop",
          id: "loop",
          name: "Loop",
          codons: [
            {
              id: "p",
              name: "P",
              model: "sonnet",
              continuationMode: "fresh",
              promptText: "P",
            },
          ],
          terminateOn: { type: "contextExceeded" },
        }),
      ];

      const smWithConfigs = new StateManager(TEST_HANKWEAVE_DIR, mockLogger, codonConfigs);
      await smWithConfigs.initialize();

      // Trigger RunStarted to build initial plan
      smWithConfigs.transition({
        type: "RunStarted",
        data: {
          runId: RunId("test-run"),
          runFolder: "/test/runs/test-run",
          gitBranch: "run-test-run",
          startingConditions: { type: "fresh" },
          serverPid: process.pid,
        },
      });
      await smWithConfigs.waitForPendingTransitions();

      // Expand to create p#1
      await smWithConfigs.expandNextIterationForCodon({
        codonId: CodonId("p#0"),
      });

      // Both iterations should accept context exceeded
      expect(smWithConfigs.isContextExceededAcceptable(CodonId("p#0"))).toBe(true);
      expect(smWithConfigs.isContextExceededAcceptable(CodonId("p#1"))).toBe(true);
    });
  });
});
