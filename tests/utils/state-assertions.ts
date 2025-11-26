import { expect } from "bun:test";
import type { StrandweaveState } from "../../server/types/state-types";

export function assertCodonCompleted(state: StrandweaveState, codonId: string): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();

  const codon = currentRun?.codons.find((p) => p.codonId === codonId);
  expect(codon).toBeDefined();
  expect(codon?.status).toBe("completed");
}

export function assertRunStatus(
  state: StrandweaveState,
  status: "running" | "completed" | "failed" | "crashed",
): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();
  expect(currentRun?.status).toBe(status);
}

export function assertCodonCount(
  state: StrandweaveState,
  expectedCount: number,
  status?: "completed" | "failed" | "skipped",
): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();

  if (status) {
    const codons = currentRun?.codons.filter((p) => p.status === status);
    expect(codons).toHaveLength(expectedCount);
  } else {
    expect(currentRun?.codons).toHaveLength(expectedCount);
  }
}

export function assertCodonCost(state: StrandweaveState, codonId: string, minCost: number): void {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  expect(currentRun).toBeDefined();

  const codon = currentRun?.codons.find((p) => p.codonId === codonId);
  expect(codon).toBeDefined();

  let cost = 0;
  if (codon?.status === "completed" && codon && "finalCost" in codon) {
    cost = codon.finalCost;
  } else if (codon?.status === "failed" && codon && "partialCost" in codon) {
    cost = codon.partialCost;
  } else if (codon?.status === "running" && codon && "currentCost" in codon) {
    cost = codon.currentCost;
  }

  expect(cost).toBeGreaterThanOrEqual(minCost);
}

export function assertStateHasRuns(state: StrandweaveState, expectedCount: number): void {
  expect(state.runs).toHaveLength(expectedCount);
}
