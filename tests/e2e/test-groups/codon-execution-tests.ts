import { expect, test } from "bun:test";
import type { CodonCompletedEvent, CodonStartedEvent } from "../../../server/types/types.js";

interface TestState {
  codon1Started: CodonStartedEvent | null;
  codon1Completed: CodonCompletedEvent | null;
  codon2Started: CodonStartedEvent | null;
  codon2Completed: CodonCompletedEvent | null;
  codon3Started: CodonStartedEvent | null;
  codon3Completed: CodonCompletedEvent | null;
}

export function runCodonExecutionTests(testState: TestState) {
  test("Codon 1 started", () => {
    expect(testState.codon1Started?.data.codonId).toBe("codon-1");
  });

  test("Codon 1 completed successfully", () => {
    expect(testState.codon1Completed?.data.success).toBe(true);
  });

  test("Codon 2 completed successfully", () => {
    expect(testState.codon2Completed?.data.success).toBe(true);
  });

  test("Codon 2 continued from Codon 1", () => {
    expect(testState.codon2Started?.data.previousSessionId).toBeDefined();
  });

  test("Codon 3 completed successfully", () => {
    expect(testState.codon3Completed?.data.success).toBe(true);
  });
}
