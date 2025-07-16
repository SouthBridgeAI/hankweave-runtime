import { RunId, PhaseId, SessionId } from "../../server/branded-types.js";
import type * as ST from "../../server/state-types.js";

export class StateBuilder {
  private state: ST.LangtonState = {
    runs: [],
    currentRunId: null,
  };

  withRun(run: Partial<ST.Run> & { runId: RunId }): this {
    const fullRun: ST.Run = {
      runFolder: `/test/runs/${run.runId}`,
      gitBranch: `run-${run.runId}`,
      startingConditions: { type: "fresh" },
      phases: [],
      status: "running",
      startTime: new Date().toISOString(),
      serverPid: process.pid,
      ...run,
    };
    this.state.runs.unshift(fullRun); // Add to beginning to match StateManager ordering
    return this;
  }

  withCurrentRun(runId: RunId): this {
    this.state.currentRunId = runId;
    return this;
  }

  withPhaseInRun(runId: RunId, phase: ST.PhaseExecution): this {
    const run = this.state.runs.find((r) => r.runId === runId);
    if (run) {
      run.phases.push(phase);
    }
    return this;
  }

  build(): ST.LangtonState {
    return JSON.parse(JSON.stringify(this.state));
  }
}

export function createCompletedPhase(
  phaseId: string,
  sessionId: string,
  cost = 0.1
): ST.CompletedPhase {
  return {
    phaseId: PhaseId(phaseId),
    startTime: new Date().toISOString(),
    status: "completed",
    endTime: new Date().toISOString(),
    claudeSessionId: SessionId(sessionId),
    claudeLogPath: `phase-${phaseId}.log`,
    exitCode: 0,
    finalCost: cost,
    finalTokens: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    resultMessageReceived: true,
    completionCheckpoint: "abc123",
  };
}

export function createRunningPhase(
  phaseId: string,
  sessionId: string,
  currentCost = 0.05
): ST.RunningPhase {
  return {
    phaseId: PhaseId(phaseId),
    startTime: new Date().toISOString(),
    status: "running",
    claudePid: 12345,
    claudeLogPath: `phase-${phaseId}.log`,
    claudeSessionId: SessionId(sessionId),
    currentCost,
    currentTokens: {
      inputTokens: 500,
      outputTokens: 250,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  };
}

export function createFailedPhase(
  phaseId: string,
  failureReason: ST.FailureReason,
  partialCost = 0.03
): ST.FailedPhase {
  return {
    phaseId: PhaseId(phaseId),
    startTime: new Date().toISOString(),
    status: "failed",
    endTime: new Date().toISOString(),
    failedDuring: "running",
    exitCode: 1,
    failureReason,
    partialCost,
    partialTokens: {
      inputTokens: 300,
      outputTokens: 150,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    claudePid: 12345,
    claudeSessionId: SessionId("failed-session"),
    claudeLogPath: `phase-${phaseId}.log`,
  };
}
