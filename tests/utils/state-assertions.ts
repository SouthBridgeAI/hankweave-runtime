import type { LangtonState } from "../../server/state-types.js";
import { expect } from "bun:test";

export function assertPhaseCompleted(
  state: LangtonState,
  phaseId: string
): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();

  const phase = currentRun!.phases.find((p) => p.phaseId === phaseId);
  expect(phase).toBeDefined();
  expect(phase!.status).toBe("completed");
}

export function assertRunStatus(
  state: LangtonState,
  status: "running" | "completed" | "failed" | "crashed"
): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();
  expect(currentRun!.status).toBe(status);
}

export function assertPhaseCount(
  state: LangtonState,
  expectedCount: number,
  status?: "completed" | "failed" | "skipped"
): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();

  if (status) {
    const phases = currentRun!.phases.filter((p) => p.status === status);
    expect(phases).toHaveLength(expectedCount);
  } else {
    expect(currentRun!.phases).toHaveLength(expectedCount);
  }
}

export function assertPhaseCost(
  state: LangtonState,
  phaseId: string,
  minCost: number
): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();

  const phase = currentRun!.phases.find((p) => p.phaseId === phaseId);
  expect(phase).toBeDefined();

  let cost = 0;
  if (phase!.status === "completed" && "finalCost" in phase!) {
    cost = phase.finalCost;
  } else if (phase!.status === "failed" && "partialCost" in phase!) {
    cost = phase.partialCost;
  } else if (phase!.status === "running" && "currentCost" in phase!) {
    cost = phase.currentCost;
  }

  expect(cost).toBeGreaterThanOrEqual(minCost);
}

export function assertStateHasRuns(
  state: LangtonState,
  expectedCount: number
): void {
  expect(state.runs).toHaveLength(expectedCount);
}
