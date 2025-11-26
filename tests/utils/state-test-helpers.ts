import path from "node:path";
import { StateManager } from "../../server/state-manager";
import { CodonId } from "../../server/types/branded-types";
import type { CodonStatus, StrandweaveState } from "../../server/types/state-types";
import type { CodonConfig } from "../../server/types/types";
import { Logger } from "../../server/utils";

export function waitForCodonStatus(
  stateManager: StateManager,
  codonId: string,
  status: CodonStatus,
  timeout = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      const codon = stateManager.getCodonInCurrentRun(CodonId(codonId));
      if (codon?.status === status) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error(`Timeout waiting for codon ${codonId} to reach status ${status}`));
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

export function createMockState(overrides?: Partial<StrandweaveState>): StrandweaveState {
  return {
    runs: [],
    currentRunId: null,
    executionPlan: [],
    ...overrides,
  };
}

export function createTestStateManager(
  testDir: string,
  codonConfigs?: CodonConfig[],
): StateManager {
  const logger = new Logger(path.join(testDir, "test.log"));
  return new StateManager(path.join(testDir, ".strandweave"), logger, codonConfigs);
}

export function getCompletedCodonsFromState(state: StrandweaveState): Array<{
  codonId: string;
  cost: number;
  sessionId: string;
}> {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  if (!currentRun) return [];

  return currentRun.codons
    .filter((p) => p.status === "completed")
    .map((p) => ({
      codonId: p.codonId,
      cost: "finalCost" in p ? p.finalCost : 0,
      sessionId: "claudeSessionId" in p ? p.claudeSessionId : "unknown",
    }));
}
