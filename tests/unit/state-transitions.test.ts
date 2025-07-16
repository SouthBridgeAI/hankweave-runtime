import { describe, test, expect, beforeEach } from "bun:test";
import { RunId, PhaseId, SessionId } from "../../server/branded-types.js";
import type * as ST from "../../server/state-types.js";
import {
  isTerminalPhaseStatus,
  PhaseTransitions,
} from "../../server/state-types.js";

describe("State Transitions", () => {
  describe("PhaseTransitions map", () => {
    test("defines valid transitions for each status", () => {
      // Check all statuses are covered
      const allStatuses: ST.PhaseStatus[] = [
        "preparing",
        "starting",
        "initializing",
        "running",
        "completing",
        "completed",
        "failed",
        "skipped",
      ];

      for (const status of allStatuses) {
        expect(status in PhaseTransitions).toBe(true);
      }
    });

    test("terminal states have no valid transitions", () => {
      expect(PhaseTransitions.completed).toEqual([]);
      expect(PhaseTransitions.failed).toEqual([]);
      expect(PhaseTransitions.skipped).toEqual([]);
    });

    test("non-terminal states can transition to failed or skipped", () => {
      expect(PhaseTransitions.preparing).toContain("failed");
      expect(PhaseTransitions.preparing).toContain("skipped");

      expect(PhaseTransitions.starting).toContain("failed");
      expect(PhaseTransitions.starting).toContain("skipped");

      expect(PhaseTransitions.initializing).toContain("failed");
      expect(PhaseTransitions.initializing).toContain("skipped");

      expect(PhaseTransitions.running).toContain("failed");
      expect(PhaseTransitions.running).toContain("skipped");
    });

    test("completing cannot be skipped", () => {
      expect(PhaseTransitions.completing).toContain("failed");
      expect(PhaseTransitions.completing).not.toContain("skipped");
    });

    test("follows expected happy path", () => {
      expect(PhaseTransitions.preparing).toContain("starting");
      expect(PhaseTransitions.starting).toContain("initializing");
      expect(PhaseTransitions.initializing).toContain("running");
      expect(PhaseTransitions.running).toContain("completing");
      expect(PhaseTransitions.completing).toContain("completed");
    });
  });

  describe("isTerminalPhaseStatus helper", () => {
    test("correctly identifies terminal statuses", () => {
      expect(isTerminalPhaseStatus("completed")).toBe(true);
      expect(isTerminalPhaseStatus("failed")).toBe(true);
      expect(isTerminalPhaseStatus("skipped")).toBe(true);
    });

    test("correctly identifies non-terminal statuses", () => {
      expect(isTerminalPhaseStatus("preparing")).toBe(false);
      expect(isTerminalPhaseStatus("starting")).toBe(false);
      expect(isTerminalPhaseStatus("initializing")).toBe(false);
      expect(isTerminalPhaseStatus("running")).toBe(false);
      expect(isTerminalPhaseStatus("completing")).toBe(false);
    });
  });

  describe("State Transition Types", () => {
    describe("RunStarted", () => {
      test("has required fields", () => {
        const transition: ST.StateTransition = {
          type: "RunStarted",
          data: {
            runId: RunId("test-run"),
            runFolder: "/test/runs/test-run",
            gitBranch: "run-test-run",
            startingConditions: { type: "fresh" },
            serverPid: 12345,
          },
        };

        expect(transition.type).toBe("RunStarted");
        expect(transition.data.runId).toBe(RunId("test-run"));
      });

      test("supports continuation starting conditions", () => {
        const transition: ST.StateTransition = {
          type: "RunStarted",
          data: {
            runId: RunId("test-run-2"),
            runFolder: "/test/runs/test-run-2",
            gitBranch: "run-test-run-2",
            startingConditions: {
              type: "continuation",
              source: {
                runId: RunId("test-run-1"),
                afterPhase: PhaseId("phase-1"),
                checkpointSha: "abc123",
              },
              reason: "retry",
            },
            serverPid: 12345,
          },
        };

        expect(transition.data.startingConditions.type).toBe("continuation");
        if (transition.data.startingConditions.type === "continuation") {
          expect(transition.data.startingConditions.source.runId).toBe(
            RunId("test-run-1")
          );
          expect(transition.data.startingConditions.reason).toBe("retry");
        }
      });
    });

    describe("PhaseStarted", () => {
      test("has required fields", () => {
        const transition: ST.StateTransition = {
          type: "PhaseStarted",
          data: {
            runId: RunId("test-run"),
            phaseId: PhaseId("test-phase"),
          },
        };

        expect(transition.type).toBe("PhaseStarted");
        expect(transition.data.phaseId).toBe(PhaseId("test-phase"));
      });

      // previousSessionId removed - now stored in phase itself
    });

    describe("PhaseTransitioned", () => {
      test("supports all metadata fields", () => {
        const transition: ST.StateTransition = {
          type: "PhaseTransitioned",
          data: {
            runId: RunId("test-run"),
            phaseId: PhaseId("test-phase"),
            from: "starting",
            to: "initializing",
            metadata: {
              claudePid: 12345,
              claudeLogPath: "test.log",
              claudeSessionId: SessionId("session-123"),
              exitCode: 0,
              failureReason: {
                type: "timeout",
                retriable: true,
                message: "API timeout",
              },
              failedDuring: "running",
              skippedDuring: "running",
              resultMessageReceived: true,
              checkpointSha: "def456",
              checkpointBranch: "run-test-run",
            },
          },
        };

        expect(transition.data.from).toBe("starting");
        expect(transition.data.to).toBe("initializing");
        expect(transition.data.metadata?.claudePid).toBe(12345);
      });
    });

    describe("CostsUpdated", () => {
      test("has required fields", () => {
        const transition: ST.StateTransition = {
          type: "CostsUpdated",
          data: {
            runId: RunId("test-run"),
            phaseId: PhaseId("test-phase"),
            cost: 0.15,
            tokens: {
              inputTokens: 1500,
              outputTokens: 750,
              cacheCreationTokens: 100,
              cacheReadTokens: 50,
            },
          },
        };

        expect(transition.type).toBe("CostsUpdated");
        expect(transition.data.cost).toBe(0.15);
        expect(transition.data.tokens.inputTokens).toBe(1500);
      });
    });

    describe("CheckpointCreated", () => {
      test("supports all checkpoint types", () => {
        const checkpointTypes = [
          "workspace-setup",
          "completed",
          "error",
          "skipped",
        ] as const;

        for (const checkpointType of checkpointTypes) {
          const transition: ST.StateTransition = {
            type: "CheckpointCreated",
            data: {
              runId: RunId("test-run"),
              phaseId: PhaseId("test-phase"),
              checkpointType,
              sha: "abc123",
              branch: "run-test-run",
            },
          };

          expect(transition.data.checkpointType).toBe(checkpointType);
        }
      });
    });

    describe("Run lifecycle transitions", () => {
      test("RunCompleted has minimal data", () => {
        const transition: ST.StateTransition = {
          type: "RunCompleted",
          data: {
            runId: RunId("test-run"),
          },
        };

        expect(transition.type).toBe("RunCompleted");
        expect(transition.data.runId).toBe(RunId("test-run"));
      });

      test("RunFailed has minimal data", () => {
        const transition: ST.StateTransition = {
          type: "RunFailed",
          data: {
            runId: RunId("test-run"),
          },
        };

        expect(transition.type).toBe("RunFailed");
      });

      test("RunCrashed includes detection info", () => {
        const transition: ST.StateTransition = {
          type: "RunCrashed",
          data: {
            runId: RunId("test-run"),
            detectedAt: new Date().toISOString(),
            lastPhaseStatus: "running",
          },
        };

        expect(transition.type).toBe("RunCrashed");
        expect(transition.data.lastPhaseStatus).toBe("running");
      });
    });
  });

  describe("Phase Execution Discriminated Union", () => {
    test("PreparingPhase has minimal fields", () => {
      const phase: ST.PreparingPhase = {
        phaseId: PhaseId("test-phase"),
        startTime: new Date().toISOString(),
        status: "preparing",
      };

      expect(phase.status).toBe("preparing");
      expect("claudePid" in phase).toBe(false);
      expect("currentCost" in phase).toBe(false);
    });

    test("StartingPhase adds workspace checkpoint", () => {
      const phase: ST.StartingPhase = {
        phaseId: PhaseId("test-phase"),
        startTime: new Date().toISOString(),
        status: "starting",
        workspaceSetupCheckpoint: "abc123",
      };

      expect(phase.status).toBe("starting");
      expect(phase.workspaceSetupCheckpoint).toBe("abc123");
    });

    test("InitializingPhase adds process info", () => {
      const phase: ST.InitializingPhase = {
        phaseId: PhaseId("test-phase"),
        startTime: new Date().toISOString(),
        status: "initializing",
        workspaceSetupCheckpoint: "abc123",
        claudePid: 12345,
        claudeLogPath: "test.log",
        previousSessionId: SessionId("prev-session"),
      };

      expect(phase.claudePid).toBe(12345);
      expect(phase.claudeLogPath).toBe("test.log");
    });

    test("RunningPhase adds session and cost info", () => {
      const phase: ST.RunningPhase = {
        phaseId: PhaseId("test-phase"),
        startTime: new Date().toISOString(),
        status: "running",
        workspaceSetupCheckpoint: "abc123",
        claudePid: 12345,
        claudeLogPath: "test.log",
        claudeSessionId: SessionId("session-123"),
        currentCost: 0.05,
        currentTokens: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      };

      expect(phase.claudeSessionId).toBe(SessionId("session-123"));
      expect(phase.currentCost).toBe(0.05);
    });

    test("CompletedPhase has all final fields", () => {
      const phase: ST.CompletedPhase = {
        phaseId: PhaseId("test-phase"),
        startTime: new Date().toISOString(),
        status: "completed",
        endTime: new Date().toISOString(),
        claudeSessionId: SessionId("session-123"),
        claudeLogPath: "test.log",
        exitCode: 0,
        finalCost: 0.1,
        finalTokens: {
          inputTokens: 2000,
          outputTokens: 1000,
          cacheCreationTokens: 100,
          cacheReadTokens: 50,
        },
        resultMessageReceived: true,
        workspaceSetupCheckpoint: "abc123",
        completionCheckpoint: "def456",
      };

      expect(phase.status).toBe("completed");
      expect(phase.exitCode).toBe(0);
      expect(phase.finalCost).toBe(0.1);
      expect(phase.completionCheckpoint).toBe("def456");
    });

    test("FailedPhase includes failure details", () => {
      const phase: ST.FailedPhase = {
        phaseId: PhaseId("test-phase"),
        startTime: new Date().toISOString(),
        status: "failed",
        endTime: new Date().toISOString(),
        failedDuring: "running",
        exitCode: 1,
        failureReason: {
          type: "api-error",
          retriable: true,
          message: "Rate limit exceeded",
        },
        partialCost: 0.03,
        partialTokens: {
          inputTokens: 500,
          outputTokens: 250,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        claudePid: 12345,
        claudeSessionId: SessionId("session-123"),
        claudeLogPath: "test.log",
        workspaceSetupCheckpoint: "abc123",
        errorCheckpoint: "error-789",
      };

      expect(phase.failedDuring).toBe("running");
      expect(phase.failureReason.type).toBe("api-error");
      expect(phase.errorCheckpoint).toBe("error-789");
    });

    test("SkippedPhase has zero cost", () => {
      const phase: ST.SkippedPhase = {
        phaseId: PhaseId("test-phase"),
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
        claudePid: 12345,
        claudeSessionId: SessionId("session-123"),
        claudeLogPath: "test.log",
        skipCheckpoint: "skip-xyz",
      };

      expect(phase.partialCost).toBe(0);
      expect(phase.partialTokens.inputTokens).toBe(0);
      expect(phase.skipCheckpoint).toBe("skip-xyz");
    });
  });

  describe("Run State", () => {
    test("Run has all required fields", () => {
      const run: ST.Run = {
        runId: RunId("test-run"),
        runFolder: "/project/.langton/runs/test-run",
        gitBranch: "run-test-run",
        startingConditions: { type: "fresh" },
        phases: [],
        status: "running",
        startTime: new Date().toISOString(),
        serverPid: 12345,
      };

      expect(run.runId).toBe(RunId("test-run"));
      expect(run.status).toBe("running");
      expect(run.phases).toHaveLength(0);
    });

    test("completed run has endTime", () => {
      const run: ST.Run = {
        runId: RunId("test-run"),
        runFolder: "/project/.langton/runs/test-run",
        gitBranch: "run-test-run",
        startingConditions: { type: "fresh" },
        phases: [],
        status: "completed",
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        serverPid: 12345,
      };

      expect(run.status).toBe("completed");
      expect(run.endTime).toBeDefined();
    });
  });

  describe("LangtonState", () => {
    test("has required structure", () => {
      const state: ST.LangtonState = {
        runs: [],
        currentRunId: null,
      };

      expect(state.runs).toBeArray();
      expect(state.currentRunId).toBeNull();
    });

    test("can have active run", () => {
      const runId = RunId("active-run");
      const state: ST.LangtonState = {
        runs: [
          {
            runId,
            runFolder: "/test/runs/active-run",
            gitBranch: "run-active-run",
            startingConditions: { type: "fresh" },
            phases: [],
            status: "running",
            startTime: new Date().toISOString(),
            serverPid: 12345,
          },
        ],
        currentRunId: runId,
      };

      expect(state.currentRunId).toBe(runId);
      expect(state.runs[0].runId).toBe(runId);
    });
  });
});
