import { expect, test } from "bun:test";
import type { PhaseCompletedEvent, PhaseStartedEvent } from "../../../server/types/types.js";

interface TestState {
  phase1Started: PhaseStartedEvent | null;
  phase1Completed: PhaseCompletedEvent | null;
  phase2Started: PhaseStartedEvent | null;
  phase2Completed: PhaseCompletedEvent | null;
  phase3Started: PhaseStartedEvent | null;
  phase3Completed: PhaseCompletedEvent | null;
}

export function runPhaseExecutionTests(testState: TestState) {
  test("Phase 1 started", () => {
    expect(testState.phase1Started?.data.phaseId).toBe("phase-1");
  });

  test("Phase 1 completed successfully", () => {
    expect(testState.phase1Completed?.data.success).toBe(true);
  });

  test("Phase 2 completed successfully", () => {
    expect(testState.phase2Completed?.data.success).toBe(true);
  });

  test("Phase 2 continued from Phase 1", () => {
    expect(testState.phase2Started?.data.previousSessionId).toBeDefined();
  });

  test("Phase 3 completed successfully", () => {
    expect(testState.phase3Completed?.data.success).toBe(true);
  });
}
