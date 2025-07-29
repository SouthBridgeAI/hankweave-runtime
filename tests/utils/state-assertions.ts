import { expect } from "bun:test";
import type { TadpoleState } from "../../server/types/state-types.js";

export function assertPhaseCompleted(state: TadpoleState, phaseId: string): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();

  const phase = currentRun?.phases.find((p) => p.phaseId === phaseId);
  expect(phase).toBeDefined();
  expect(phase?.status).toBe("completed");
}

export function assertRunStatus(
  state: TadpoleState,
  status: "running" | "completed" | "failed" | "crashed",
): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();
  expect(currentRun?.status).toBe(status);
}

export function assertPhaseCount(
  state: TadpoleState,
  expectedCount: number,
  status?: "completed" | "failed" | "skipped",
): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();

  if (status) {
    const phases = currentRun?.phases.filter((p) => p.status === status);
    expect(phases).toHaveLength(expectedCount);
  } else {
    expect(currentRun?.phases).toHaveLength(expectedCount);
  }
}

export function assertPhaseCost(state: TadpoleState, phaseId: string, minCost: number): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();

  const phase = currentRun?.phases.find((p) => p.phaseId === phaseId);
  expect(phase).toBeDefined();

  let cost = 0;
  if (phase?.status === "completed" && phase && "finalCost" in phase) {
    cost = phase.finalCost;
  } else if (phase?.status === "failed" && phase && "partialCost" in phase) {
    cost = phase.partialCost;
  } else if (phase?.status === "running" && phase && "currentCost" in phase) {
    cost = phase.currentCost;
  }

  expect(cost).toBeGreaterThanOrEqual(minCost);
}

export function assertStateHasRuns(state: TadpoleState, expectedCount: number): void {
  expect(state.runs).toHaveLength(expectedCount);
}
