import { CodonId, type RunId, SessionId } from "../../server/types/branded-types.js";
import type * as ST from "../../server/types/state-types.js";

export class StateBuilder {
  private state: ST.HankweaveState = {
    runs: [],
    currentRunId: null,
    executionPlan: [],
  };

  withRun(run: Partial<ST.Run> & { runId: RunId }): this {
    const fullRun: ST.Run = {
      runFolder: `/test/runs/${run.runId}`,
      gitBranch: `run-${run.runId}`,
      startingConditions: { type: "fresh" },
      codons: [],
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

  withCodonInRun(runId: RunId, codon: ST.CodonExecution): this {
    const run = this.state.runs.find((r) => r.runId === runId);
    if (run) {
      run.codons.push(codon);
    }
    return this;
  }

  build(): ST.HankweaveState {
    return JSON.parse(JSON.stringify(this.state));
  }
}

export function createCompletedCodon(
  codonId: string,
  sessionId: string,
  cost = 0.1,
): ST.CompletedCodon {
  return {
    codonId: CodonId(codonId),
    startTime: new Date().toISOString(),
    status: "completed",
    endTime: new Date().toISOString(),
    claudeSessionId: SessionId(sessionId),
    claudeLogPath: `codon-${codonId}.log`,
    exitCode: 0,
    finalCost: cost,
    finalTokens: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    resultMessageReceived: true,
    extensionCount: 0,
    completionCheckpoint: "abc123",
  };
}

export function createRunningCodon(
  codonId: string,
  sessionId: string,
  currentCost = 0.05,
): ST.RunningCodon {
  return {
    codonId: CodonId(codonId),
    startTime: new Date().toISOString(),
    status: "running",
    claudePid: 12345,
    claudeLogPath: `codon-${codonId}.log`,
    claudeSessionId: SessionId(sessionId),
    currentCost,
    currentTokens: {
      inputTokens: 500,
      outputTokens: 250,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    assistantMessageCount: 0,
    extensionCount: 0,
  };
}

export function createFailedCodon(
  codonId: string,
  failureReason: ST.FailureReason,
  partialCost = 0.03,
): ST.FailedCodon {
  return {
    codonId: CodonId(codonId),
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
    claudeLogPath: `codon-${codonId}.log`,
  };
}
