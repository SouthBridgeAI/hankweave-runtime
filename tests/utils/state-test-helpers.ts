import path from "node:path";
import type {
  LangtonState,
  PhaseExecution,
  PhaseStatus,
} from "../../server/state-types.js";
import { StateManager } from "../../server/state-manager.js";
import { Logger } from "../../server/utils.js";
import { PhaseId } from "../../server/branded-types.js";
import type { PhaseConfig } from "../../server/types.js";

export function waitForPhaseStatus(
  stateManager: StateManager,
  phaseId: string,
  status: PhaseStatus,
  timeout = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      const phase = stateManager.getPhaseInCurrentRun(PhaseId(phaseId));
      if (phase?.status === status) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(
          new Error(
            `Timeout waiting for phase ${phaseId} to reach status ${status}`
          )
        );
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

export function createMockState(
  overrides?: Partial<LangtonState>
): LangtonState {
  return {
    runs: [],
    currentRunId: null,
    ...overrides,
  };
}

export function createTestStateManager(
  testDir: string,
  phaseConfigs?: PhaseConfig[]
): StateManager {
  const logger = new Logger(path.join(testDir, "test.log"));
  return new StateManager(path.join(testDir, ".langton"), logger, phaseConfigs);
}

export function getCompletedPhasesFromState(state: LangtonState): Array<{
  phaseId: string;
  cost: number;
  sessionId: string;
}> {
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  if (!currentRun) return [];

  return currentRun.phases
    .filter((p) => p.status === "completed")
    .map((p) => ({
      phaseId: p.phaseId,
      cost: "finalCost" in p ? p.finalCost : 0,
      sessionId: "claudeSessionId" in p ? p.claudeSessionId : "unknown",
    }));
}
