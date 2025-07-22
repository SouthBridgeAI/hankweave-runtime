import { describe, expect, test, beforeEach } from "bun:test";
import {
  analyzeExecutionThread,
  getNextPhaseId,
  findContinuationSessionId,
  getPhasesToRollback,
  type ExecutionThread,
} from "../../server/execution-thread.js";
import {
  type LangtonState,
  PhaseId,
  RunId,
  SessionId,
} from "../../server/state-types.js";
import type { PhaseConfig } from "../../server/types.js";
import type { Logger } from "../../server/utils.js";
import fs from "node:fs";
import path from "node:path";

// Test data and utilities
const testPhaseConfigs: PhaseConfig[] = [
  {
    id: "phase-1" as PhaseId,
    name: "Phase 1: TestPhase1",
    promptFile: ["./phase1Prompt1.md", "./phase1Prompt2.md"],
    model: "sonnet",
    continuationMode: "fresh",
    description: "Write three pick one",
    trackedFiles: ["notes/**/*", "*.md"],
  },
  {
    id: "phase-2" as PhaseId,
    name: "Phase 2: Schema Generation",
    promptText: "Can you put your second favorite poem...",
    model: "sonnet",
    continuationMode: "continue-previous",
    description: "Write one more",
    trackedFiles: ["notes/**/*"],
  },
  {
    id: "phase-3" as PhaseId,
    name: "Phase 3: More Validation",
    promptText: "Can you convert the poems...",
    model: "sonnet",
    continuationMode: "fresh",
    description: "Convert poems to code",
    trackedFiles: ["typescript_code/src/**/*.ts"],
  },
];

// Mock logger that captures log messages
class MockLogger {
  public logs: Array<{ message: string; level?: string }> = [];

  log(message: string, level?: "error" | "info" | "debug"): void {
    this.logs.push({ message, level });
  }

  logSocketTraffic(_file: string, _direction: string, _data: unknown): void {
    // Not used in execution thread tests
  }
}

// Helper to create checkpoint data map
function createCheckpointData(
  shas: string[]
): Map<string, { message: string; timestamp: string; branch: string }> {
  const map = new Map();
  shas.forEach((sha, index) => {
    map.set(sha, {
      message: `Checkpoint ${index + 1}`,
      timestamp: new Date(Date.now() + index * 1000).toISOString(),
      branch: "main",
    });
  });
  return map;
}

// Load the real test state
function loadTestState(): LangtonState {
  const testStatePath = path.join(
    __dirname,
    "../test-data/states/execution-state-test-state.json"
  );
  const content = fs.readFileSync(testStatePath, "utf-8");
  return JSON.parse(content) as LangtonState;
}

describe("Execution Thread Analysis", () => {
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockLogger = new MockLogger();
  });

  describe("Basic Thread Building", () => {
    test("should handle empty state", async () => {
      const emptyState: LangtonState = {
        runs: [],
        currentRunId: null,
      };

      const thread = await analyzeExecutionThread(
        emptyState,
        testPhaseConfigs,
        undefined,
        undefined,
        mockLogger as unknown as Logger
      );

      expect(thread.phases).toHaveLength(0);
      expect(thread.totalRuns).toBe(0);
      expect(thread.hasRunningPhase).toBe(false);
      expect(thread.nextPhaseId).toBeNull();
      expect(mockLogger.logs).toContainEqual({
        message: "No runs found for execution thread analysis",
        level: "debug",
      });
    });

    test("should handle single run with single phase", async () => {
      const singleRunState: LangtonState = {
        runs: [
          {
            runId: "test-run-1" as RunId,
            runFolder: "/test/runs/test-run-1",
            gitBranch: "run-test-run-1",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "completed",
                endTime: "2025-01-01T00:01:00Z",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                exitCode: 0,
                finalCost: 0.01,
                finalTokens: {
                  inputTokens: 10,
                  outputTokens: 20,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                completionCheckpoint: "checkpoint-1",
              },
            ],
            status: "completed",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-01T00:01:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
      };

      const checkpointData = createCheckpointData(["checkpoint-1"]);
      const thread = await analyzeExecutionThread(
        singleRunState,
        testPhaseConfigs,
        checkpointData,
        undefined,
        mockLogger as unknown as Logger
      );

      expect(thread.phases).toHaveLength(1);
      expect(thread.totalRuns).toBe(1);
      expect(thread.hasRunningPhase).toBe(false);
      expect(thread.nextPhaseId).toBe("phase-2" as PhaseId);

      const phase = thread.phases[0];
      expect(phase.phase.phaseId).toBe("phase-1" as PhaseId);
      expect(phase.runId).toBe("test-run-1" as RunId);
      expect(phase.globalIndex).toBe(0);
      expect(phase.runIndex).toBe(0);
      expect(phase.phaseIndexInRun).toBe(0);
      expect(phase.validatedCheckpoints).toHaveLength(1);
      expect(phase.validatedCheckpoints[0].type).toBe("completed");
      expect(phase.validatedCheckpoints[0].sha).toBe("checkpoint-1");
    });
  });

  describe("Real Test State Analysis", () => {
    test("should correctly analyze the provided test state", async () => {
      const testState = loadTestState();
      const allCheckpoints = [
        "62afd429e800d29ec897c9be2f3de12768c0de31",
        "d20e6dd563da2bb5514973dacefaa3cdf1750f11",
        "ebfcbda24dfd3ad9fe33bea50843389e6b0e4b8c",
        "7765e00e81dde339c850a7be4761a631a15f2424",
        "a7fe1193332dfc671ff7a60f042bf645d2a86421",
        "ff6994a70bc3f396f90eb5a9bfe58ab7e9c67180",
        "099715fb7a406b95b5b98a62d2853643e5c161f4",
        "9157a41052d26b5ec236a2b964116ef46db93870",
      ];
      const checkpointData = createCheckpointData(allCheckpoints);

      const thread = await analyzeExecutionThread(
        testState,
        testPhaseConfigs,
        checkpointData,
        undefined,
        mockLogger as unknown as Logger
      );

      // Should have 3 phases: 2 from continuation run + 1 from original run (phase-1)
      expect(thread.phases).toHaveLength(3);
      expect(thread.totalRuns).toBe(2);
      expect(thread.hasRunningPhase).toBe(false);
      expect(thread.nextPhaseId).toBeNull(); // null because the latest run has failed status

      // Verify phase ordering (latest first)
      expect(thread.phases[0].phase.phaseId).toBe("phase-3" as PhaseId);
      expect(thread.phases[0].runId).toBe("1753110463686-yayna" as RunId);
      expect(thread.phases[0].globalIndex).toBe(0);

      expect(thread.phases[1].phase.phaseId).toBe("phase-2" as PhaseId);
      expect(thread.phases[1].runId).toBe("1753110463686-yayna" as RunId);
      expect(thread.phases[1].globalIndex).toBe(1);

      // Verify checkpoints are validated
      const phase3FromContinuation = thread.phases[0];
      expect(phase3FromContinuation.validatedCheckpoints).toHaveLength(2);
      expect(
        phase3FromContinuation.validatedCheckpoints.some(
          (c) => c.type === "workspace-setup"
        )
      ).toBe(true);
      expect(
        phase3FromContinuation.validatedCheckpoints.some(
          (c) => c.type === "completed"
        )
      ).toBe(true);

      // Verify continuation session ID
      const phase2FromContinuation = thread.phases[1];
      expect(phase2FromContinuation.continuationSessionId).toBe(
        "7dc6f567-ed4d-42d9-ae0a-2cdfb084c14c" as SessionId
      );
    });
  });

  describe("Next Phase Detection", () => {
    test("should return first phase for fresh run with no phases", async () => {
      const freshState: LangtonState = {
        runs: [
          {
            runId: "fresh-run" as RunId,
            runFolder: "/test/runs/fresh-run",
            gitBranch: "run-fresh-run",
            startingConditions: { type: "fresh" },
            phases: [],
            status: "running",
            startTime: "2025-01-01T00:00:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: "fresh-run" as RunId,
      };

      const thread = await analyzeExecutionThread(freshState, testPhaseConfigs);
      expect(thread.nextPhaseId).toBe("phase-1" as PhaseId);
    });

    test("should return next phase after completed phase", async () => {
      const completedPhase1State: LangtonState = {
        runs: [
          {
            runId: "test-run" as RunId,
            runFolder: "/test/runs/test-run",
            gitBranch: "run-test-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "completed",
                endTime: "2025-01-01T00:01:00Z",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                exitCode: 0,
                finalCost: 0.01,
                finalTokens: {
                  inputTokens: 10,
                  outputTokens: 20,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                completionCheckpoint: "checkpoint-1",
              },
            ],
            status: "completed",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-01T00:01:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
      };

      const thread = await analyzeExecutionThread(
        completedPhase1State,
        testPhaseConfigs
      );
      expect(thread.nextPhaseId).toBe("phase-2" as PhaseId);
    });
  });

  describe("Session ID Finding", () => {
    test("should find session ID for continue-previous phase", async () => {
      const testState: LangtonState = {
        runs: [
          {
            runId: "test-run" as RunId,
            runFolder: "/test/runs/test-run",
            gitBranch: "run-test-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "completed",
                endTime: "2025-01-01T00:01:00Z",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                exitCode: 0,
                finalCost: 0.01,
                finalTokens: {
                  inputTokens: 10,
                  outputTokens: 20,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                completionCheckpoint: "checkpoint-1",
              },
            ],
            status: "completed",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-01T00:01:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
      };

      const thread = await analyzeExecutionThread(testState, testPhaseConfigs);
      const sessionId = findContinuationSessionId(
        thread,
        "phase-2" as PhaseId,
        testPhaseConfigs
      );

      expect(sessionId).toBe("session-1" as SessionId);
    });

    test("should return null for fresh phase", async () => {
      const testState: LangtonState = {
        runs: [
          {
            runId: "test-run" as RunId,
            runFolder: "/test/runs/test-run",
            gitBranch: "run-test-run",
            startingConditions: { type: "fresh" },
            phases: [],
            status: "running",
            startTime: "2025-01-01T00:00:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: "test-run" as RunId,
      };

      const thread = await analyzeExecutionThread(testState, testPhaseConfigs);
      const sessionId = findContinuationSessionId(
        thread,
        "phase-1" as PhaseId,
        testPhaseConfigs
      );

      expect(sessionId).toBeNull();
    });
  });

  describe("Rollback Phase Detection", () => {
    test("should get phases to rollback through", async () => {
      const testState = loadTestState();
      const thread = await analyzeExecutionThread(testState, testPhaseConfigs);

      // Thread has: phase-3 (continuation), phase-2 (continuation), phase-1 (original)
      // Since we can't rollback to phase-2 in original (it's not in the thread),
      // let's rollback to phase-1 in original instead
      const phasesToRollback = getPhasesToRollback(
        thread,
        "phase-1" as PhaseId,
        "1753110411854-28u0x" as RunId
      );

      // Should rollback through: phase-3 from continuation, phase-2 from continuation
      expect(phasesToRollback).toHaveLength(2);
      expect(phasesToRollback[0].phase.phaseId).toBe("phase-3" as PhaseId);
      expect(phasesToRollback[0].runId).toBe("1753110463686-yayna" as RunId);
      expect(phasesToRollback[1].phase.phaseId).toBe("phase-2" as PhaseId);
      expect(phasesToRollback[1].runId).toBe("1753110463686-yayna" as RunId);
    });

    test("should return empty array for invalid target", async () => {
      const testState = loadTestState();
      const thread = await analyzeExecutionThread(testState, testPhaseConfigs);

      const phasesToRollback = getPhasesToRollback(
        thread,
        "nonexistent-phase" as PhaseId,
        "nonexistent-run" as RunId
      );

      expect(phasesToRollback).toHaveLength(0);
    });
  });

  describe("Checkpoint Validation", () => {
    test("should only include validated checkpoints", async () => {
      const testState: LangtonState = {
        runs: [
          {
            runId: "test-run" as RunId,
            runFolder: "/test/runs/test-run",
            gitBranch: "run-test-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "completed",
                endTime: "2025-01-01T00:01:00Z",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                exitCode: 0,
                finalCost: 0.01,
                finalTokens: {
                  inputTokens: 10,
                  outputTokens: 20,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                workspaceSetupCheckpoint: "workspace-sha",
                completionCheckpoint: "completion-sha",
              },
            ],
            status: "completed",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-01T00:01:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
      };

      // Only include workspace-sha in checkpoint data
      const checkpointData = createCheckpointData(["workspace-sha"]);
      const thread = await analyzeExecutionThread(
        testState,
        testPhaseConfigs,
        checkpointData
      );

      expect(thread.phases).toHaveLength(1);
      expect(thread.phases[0].validatedCheckpoints).toHaveLength(1);
      expect(thread.phases[0].validatedCheckpoints[0].type).toBe(
        "workspace-setup"
      );
      expect(thread.phases[0].validatedCheckpoints[0].sha).toBe(
        "workspace-sha"
      );
    });

    test("should include no checkpoints when none validated", async () => {
      const testState: LangtonState = {
        runs: [
          {
            runId: "test-run" as RunId,
            runFolder: "/test/runs/test-run",
            gitBranch: "run-test-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "completed",
                endTime: "2025-01-01T00:01:00Z",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                exitCode: 0,
                finalCost: 0.01,
                finalTokens: {
                  inputTokens: 10,
                  outputTokens: 20,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                completionCheckpoint: "completion-sha",
              },
            ],
            status: "completed",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-01T00:01:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
      };

      // No checkpoint data provided - should have no validated checkpoints
      const thread = await analyzeExecutionThread(testState, testPhaseConfigs);

      expect(thread.phases).toHaveLength(1);
      expect(thread.phases[0].validatedCheckpoints).toHaveLength(0);
    });
  });

  describe("Query Functions", () => {
    test("getNextPhaseId should return thread nextPhaseId", () => {
      const mockThread: ExecutionThread = {
        phases: [],
        totalRuns: 0,
        hasRunningPhase: false,
        nextPhaseId: "phase-2" as PhaseId,
      };

      const result = getNextPhaseId(mockThread);
      expect(result).toBe("phase-2" as PhaseId);
    });

    test("getNextPhaseId should return null when no next phase", () => {
      const mockThread: ExecutionThread = {
        phases: [],
        totalRuns: 0,
        hasRunningPhase: false,
        nextPhaseId: null,
      };

      const result = getNextPhaseId(mockThread);
      expect(result).toBeNull();
    });
  });

  describe("Complex Continuation Scenarios", () => {
    test("should handle workspace-setup continuation correctly", async () => {
      // This tests the critical case where we rollback to a workspace-setup checkpoint
      // and need to re-run the same phase
      const state: LangtonState = {
        runs: [
          {
            runId: "continuation-run" as RunId,
            runFolder: "/test/runs/continuation-run",
            gitBranch: "run-continuation-run",
            startingConditions: {
              type: "continuation",
              source: {
                runId: "original-run" as RunId,
                afterPhase: "phase-2" as PhaseId,
                checkpointSha: "workspace-sha-123",
              },
              reason: "rollback",
            },
            phases: [], // No phases executed yet in continuation
            status: "running",
            startTime: "2025-01-01T02:00:00Z",
            serverPid: 12345,
          },
          {
            runId: "original-run" as RunId,
            runFolder: "/test/runs/original-run",
            gitBranch: "run-original-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "completed",
                endTime: "2025-01-01T00:01:00Z",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                exitCode: 0,
                finalCost: 0.01,
                finalTokens: {
                  inputTokens: 10,
                  outputTokens: 20,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                completionCheckpoint: "checkpoint-1",
              },
              {
                phaseId: "phase-2" as PhaseId,
                startTime: "2025-01-01T00:02:00Z",
                status: "completed",
                endTime: "2025-01-01T00:03:00Z",
                claudeSessionId: "session-2" as SessionId,
                claudeLogPath: "test2.log",
                exitCode: 0,
                finalCost: 0.02,
                finalTokens: {
                  inputTokens: 20,
                  outputTokens: 30,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                workspaceSetupCheckpoint: "workspace-sha-123", // This is the checkpoint we're continuing from
                completionCheckpoint: "checkpoint-2",
              },
            ],
            status: "completed",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-01T00:03:00Z",
            serverPid: 12344,
          },
        ],
        currentRunId: "continuation-run" as RunId,
      };

      const thread = await analyzeExecutionThread(state, testPhaseConfigs);

      // Should only include phase-1 from original run (phase-2 excluded due to workspace-setup)
      expect(thread.phases).toHaveLength(1);
      expect(thread.phases[0].phase.phaseId).toBe("phase-1" as PhaseId);
      expect(thread.totalRuns).toBe(2);

      // Next phase should be phase-2 (re-running it)
      expect(thread.nextPhaseId).toBe("phase-2" as PhaseId);
    });

    test("should handle multiple continuation runs correctly", async () => {
      // Test a chain of continuations: original -> continuation1 -> continuation2
      const state: LangtonState = {
        runs: [
          {
            runId: "continuation-2" as RunId,
            runFolder: "/test/runs/continuation-2",
            gitBranch: "run-continuation-2",
            startingConditions: {
              type: "continuation",
              source: {
                runId: "continuation-1" as RunId,
                afterPhase: "phase-2" as PhaseId,
                checkpointSha: "checkpoint-2",
              },
              reason: "retry",
            },
            phases: [
              {
                phaseId: "phase-3" as PhaseId,
                startTime: "2025-01-01T04:00:00Z",
                status: "running",
                claudePid: 12347,
                claudeLogPath: "test.log",
                claudeSessionId: "session-5" as SessionId,
                currentCost: 0.01,
                currentTokens: {
                  inputTokens: 5,
                  outputTokens: 10,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                assistantMessageCount: 1,
              },
            ],
            status: "running",
            startTime: "2025-01-01T04:00:00Z",
            serverPid: 12347,
          },
          {
            runId: "continuation-1" as RunId,
            runFolder: "/test/runs/continuation-1",
            gitBranch: "run-continuation-1",
            startingConditions: {
              type: "continuation",
              source: {
                runId: "original-run" as RunId,
                afterPhase: "phase-1" as PhaseId,
                checkpointSha: "checkpoint-1",
              },
              reason: "continue",
            },
            phases: [
              {
                phaseId: "phase-2" as PhaseId,
                startTime: "2025-01-01T02:00:00Z",
                status: "completed",
                endTime: "2025-01-01T02:01:00Z",
                claudeSessionId: "session-3" as SessionId,
                claudeLogPath: "test.log",
                previousSessionId: "session-1" as SessionId,
                exitCode: 0,
                finalCost: 0.02,
                finalTokens: {
                  inputTokens: 20,
                  outputTokens: 30,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                completionCheckpoint: "checkpoint-2",
              },
            ],
            status: "completed",
            startTime: "2025-01-01T02:00:00Z",
            endTime: "2025-01-01T02:01:00Z",
            serverPid: 12346,
          },
          {
            runId: "original-run" as RunId,
            runFolder: "/test/runs/original-run",
            gitBranch: "run-original-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "completed",
                endTime: "2025-01-01T00:01:00Z",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                exitCode: 0,
                finalCost: 0.01,
                finalTokens: {
                  inputTokens: 10,
                  outputTokens: 20,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                completionCheckpoint: "checkpoint-1",
              },
            ],
            status: "completed",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-01T00:01:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: "continuation-2" as RunId,
      };

      const thread = await analyzeExecutionThread(state, testPhaseConfigs);

      // Should have all 3 phases
      expect(thread.phases).toHaveLength(3);
      expect(thread.totalRuns).toBe(3);
      expect(thread.hasRunningPhase).toBe(true);

      // Verify phase ordering (latest first)
      expect(thread.phases[0].phase.phaseId).toBe("phase-3" as PhaseId);
      expect(thread.phases[0].runId).toBe("continuation-2" as RunId);
      expect(thread.phases[0].phase.status).toBe("running");

      expect(thread.phases[1].phase.phaseId).toBe("phase-2" as PhaseId);
      expect(thread.phases[1].runId).toBe("continuation-1" as RunId);

      expect(thread.phases[2].phase.phaseId).toBe("phase-1" as PhaseId);
      expect(thread.phases[2].runId).toBe("original-run" as RunId);

      // No next phase since one is running
      expect(thread.nextPhaseId).toBeNull();
    });

    test("should handle skipped phase with session for continuation", async () => {
      // Test that a skipped phase with assistant messages can be used for continuation
      const state: LangtonState = {
        runs: [
          {
            runId: "test-run" as RunId,
            runFolder: "/test/runs/test-run",
            gitBranch: "run-test-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "skipped",
                endTime: "2025-01-01T00:01:00Z",
                skippedDuring: "running",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                assistantMessageCount: 3, // Has messages, so valid for continuation
                partialCost: 0.005,
                partialTokens: {
                  inputTokens: 5,
                  outputTokens: 10,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                skipCheckpoint: "skip-checkpoint-1",
              },
            ],
            status: "completed",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-01T00:01:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
      };

      const thread = await analyzeExecutionThread(state, testPhaseConfigs);

      // Find session for phase-2 which needs to continue from phase-1
      const sessionId = findContinuationSessionId(
        thread,
        "phase-2" as PhaseId,
        testPhaseConfigs
      );

      expect(sessionId).toBe("session-1" as SessionId);
    });

    test("should not use skipped phase without messages for continuation", async () => {
      // Test that a skipped phase without assistant messages cannot be used for continuation
      const state: LangtonState = {
        runs: [
          {
            runId: "test-run" as RunId,
            runFolder: "/test/runs/test-run",
            gitBranch: "run-test-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "skipped",
                endTime: "2025-01-01T00:01:00Z",
                skippedDuring: "initializing",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                assistantMessageCount: 0, // No messages, so not valid for continuation
                partialCost: 0,
                partialTokens: {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
              },
            ],
            status: "completed",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-01T00:01:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
      };

      const thread = await analyzeExecutionThread(state, testPhaseConfigs);

      // Find session for phase-2 which needs to continue from phase-1
      const sessionId = findContinuationSessionId(
        thread,
        "phase-2" as PhaseId,
        testPhaseConfigs
      );

      expect(sessionId).toBeNull();
    });

    test("should handle continuation from beginning (null afterPhase)", async () => {
      // Test continuation from the very beginning of a run
      const state: LangtonState = {
        runs: [
          {
            runId: "continuation-run" as RunId,
            runFolder: "/test/runs/continuation-run",
            gitBranch: "run-continuation-run",
            startingConditions: {
              type: "continuation",
              source: {
                runId: "original-run" as RunId,
                afterPhase: null, // Continue from beginning
                checkpointSha: "initial-checkpoint",
              },
              reason: "rollback",
            },
            phases: [],
            status: "running",
            startTime: "2025-01-01T02:00:00Z",
            serverPid: 12346,
          },
          {
            runId: "original-run" as RunId,
            runFolder: "/test/runs/original-run",
            gitBranch: "run-original-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "completed",
                endTime: "2025-01-01T00:01:00Z",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                exitCode: 0,
                finalCost: 0.01,
                finalTokens: {
                  inputTokens: 10,
                  outputTokens: 20,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                completionCheckpoint: "checkpoint-1",
              },
            ],
            status: "completed",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-01T00:01:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: "continuation-run" as RunId,
      };

      const thread = await analyzeExecutionThread(state, testPhaseConfigs);

      // Should not include any phases from original run (continuing from beginning)
      expect(thread.phases).toHaveLength(0);
      expect(thread.totalRuns).toBe(2);

      // Next phase should be phase-1 (starting from beginning)
      expect(thread.nextPhaseId).toBe("phase-1" as PhaseId);
    });
  });

  describe("Edge Cases", () => {
    test("should handle failed phase in continuation chain", async () => {
      const state: LangtonState = {
        runs: [
          {
            runId: "test-run" as RunId,
            runFolder: "/test/runs/test-run",
            gitBranch: "run-test-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "completed",
                endTime: "2025-01-01T00:01:00Z",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                exitCode: 0,
                finalCost: 0.01,
                finalTokens: {
                  inputTokens: 10,
                  outputTokens: 20,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                completionCheckpoint: "checkpoint-1",
              },
              {
                phaseId: "phase-2" as PhaseId,
                startTime: "2025-01-01T00:02:00Z",
                status: "failed",
                endTime: "2025-01-01T00:03:00Z",
                failedDuring: "running",
                claudeSessionId: "session-2" as SessionId,
                claudeLogPath: "test2.log",
                exitCode: 1,
                failureReason: {
                  type: "timeout",
                  retriable: true,
                  message: "API timeout",
                },
                partialCost: 0.005,
                partialTokens: {
                  inputTokens: 5,
                  outputTokens: 10,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                errorCheckpoint: "error-checkpoint-1",
              },
            ],
            status: "failed",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-01T00:03:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: null,
      };

      const thread = await analyzeExecutionThread(state, testPhaseConfigs);

      expect(thread.phases).toHaveLength(2);
      expect(thread.phases[0].phase.status).toBe("failed");
      expect(thread.phases[1].phase.status).toBe("completed");

      // Next phase should be null because the run has failed status
      expect(thread.nextPhaseId).toBeNull();
    });

    test("should handle running phase detection", async () => {
      const state: LangtonState = {
        runs: [
          {
            runId: "test-run" as RunId,
            runFolder: "/test/runs/test-run",
            gitBranch: "run-test-run",
            startingConditions: { type: "fresh" },
            phases: [
              {
                phaseId: "phase-1" as PhaseId,
                startTime: "2025-01-01T00:00:00Z",
                status: "completed",
                endTime: "2025-01-01T00:01:00Z",
                claudeSessionId: "session-1" as SessionId,
                claudeLogPath: "test.log",
                exitCode: 0,
                finalCost: 0.01,
                finalTokens: {
                  inputTokens: 10,
                  outputTokens: 20,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 0,
                },
                resultMessageReceived: true,
                completionCheckpoint: "checkpoint-1",
              },
              {
                phaseId: "phase-2" as PhaseId,
                startTime: "2025-01-01T00:02:00Z",
                status: "initializing",
                claudePid: 12346,
                claudeLogPath: "test2.log",
                previousSessionId: "session-1" as SessionId,
              },
            ],
            status: "running",
            startTime: "2025-01-01T00:00:00Z",
            serverPid: 12345,
          },
        ],
        currentRunId: "test-run" as RunId,
      };

      const thread = await analyzeExecutionThread(state, testPhaseConfigs);

      expect(thread.phases).toHaveLength(2);
      expect(thread.hasRunningPhase).toBe(true);
      expect(thread.phases[0].phase.status).toBe("initializing");

      // No next phase when something is running
      expect(thread.nextPhaseId).toBeNull();
    });
  });
});
