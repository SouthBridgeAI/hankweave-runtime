// Helper types for tests to avoid using 'any'
// These are simplified versions for test assertions

export interface TestRun {
  runId: string;
  status: "running" | "completed" | "failed" | "crashed";
  phases: TestPhaseExecution[];
  endTime?: string;
  startTime: string;
  runFolder: string;
  gitBranch: string;
  serverPid: number;
  startingConditions: { type: string; [key: string]: unknown };
}

export interface TestPhaseExecution {
  phaseId: string;
  status: string;
  finalCost?: number;
  partialCost?: number;
  failureReason?: {
    message?: string;
  };
  claudeSessionId?: string;
  previousSessionId?: string;
  startTime: string;
}
