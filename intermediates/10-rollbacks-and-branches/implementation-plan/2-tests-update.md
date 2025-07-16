The user is asking about updating tests for the state management refactoring. Looking at the implementation and test files, I need to identify:

1. What tests need to be updated due to the refactoring
2. What new tests need to be added
3. What test patterns should change

From the implementation plan (`implementation-plan/tests-implementation.md`), there's already a comprehensive test update plan. Let me analyze what's actually been done vs what's needed.

Looking at the current test files:

- `tests/unit/state-manager.test.ts` - Good coverage for state manager
- `tests/unit/state-transitions.test.ts` - Good coverage for transitions
- Tests still use old patterns in many places

Key issues I see:

1. E2E tests likely still use old state inspection methods
2. Tests that check `completedPhases` array need updating
3. Tests that rely on `currentPhase` need updating
4. Need integration tests for the full flow
5. Test helpers need updating
   Looking at the test situation, here's a comprehensive update plan based on what I see implemented vs what's needed:

## 🔍 Current Test Status

### ✅ What's Already Done

- `tests/unit/state-manager.test.ts` - Excellent unit test coverage
- `tests/unit/state-transitions.test.ts` - Good transition validation
- Basic test helpers exist

### ❌ What Needs Updating

## 📝 Test Updates Required

### 1. **Create State Test Helpers**

**File: `tests/utils/state-test-helpers.ts`** (NEW)

```typescript
import type { LangtonState, PhaseExecution } from "../../server/state-types.js";
import { StateManager } from "../../server/state-manager.js";
import { Logger } from "../../server/utils.js";
import { PhaseId } from "../../server/branded-types.js";

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

export function createTestStateManager(testDir: string): StateManager {
  const logger = new Logger(path.join(testDir, "test.log"));
  // Need to pass phase configs here once StateManager is fixed
  return new StateManager(path.join(testDir, ".langton"), logger);
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
```

### 2. **Update E2E Test Base**

**File: `tests/e2e/test-utils/test-helpers.ts`** (UPDATE)

```typescript
// Add state inspection helpers
export async function getServerState(
  server: LangtonServer
): Promise<LangtonState> {
  return server.stateManager.getState();
}

export async function waitForRunStatus(
  server: LangtonServer,
  status: "running" | "completed" | "failed" | "crashed",
  timeout = 5000
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const state = server.stateManager.getState();
    const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
    if (currentRun?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for run status ${status}`);
}
```

### 3. **Update Happy Path Tests**

**File: `tests/e2e/happy-path-e2e.test.ts`** (UPDATE)

Replace all instances of:

```typescript
// OLD
testState.completedPhases = testState.client
  .getEvents()
  .filter(isPhaseCompletedEvent)
  .filter((e) => e.data.success)
  .map((e) => ({
    phaseId: e.data.phaseId,
    // ...
  }));

// NEW
const finalState = await getServerState(testState.serverProcess);
testState.completedPhases = getCompletedPhasesFromState(finalState);
```

Update phase counting:

```typescript
// OLD
expect(testState.completedPhases).toHaveLength(3);

// NEW
const state = await getServerState(testState.serverProcess);
const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
expect(currentRun?.phases.filter((p) => p.status === "completed")).toHaveLength(
  3
);
```

### 4. **Add State Persistence Tests**

**File: `tests/e2e/state-persistence-e2e.test.ts`** (NEW)

```typescript
describe("State Persistence E2E", () => {
  test("state survives server restart", async () => {
    const testDir = await prepareTestDirectory();

    // Start server and run a phase
    const server1 = await startTestServer(testDir);
    await server1.startPhase(PhaseId("phase-1"));
    await waitForPhaseStatus(server1.stateManager, "phase-1", "completed");

    const stateBeforeShutdown = server1.stateManager.getState();
    const runId = stateBeforeShutdown.currentRunId;

    await server1.shutdown("test");

    // Start new server in same directory
    const server2 = await startTestServer(testDir);
    const stateAfterRestart = server2.stateManager.getState();

    // Verify state was preserved
    expect(stateAfterRestart.runs).toHaveLength(1);
    expect(stateAfterRestart.runs[0].runId).toBe(runId);
    expect(stateAfterRestart.runs[0].phases).toHaveLength(1);
    expect(stateAfterRestart.runs[0].phases[0].status).toBe("completed");
  });

  test("concurrent updates don't corrupt state", async () => {
    const server = await startTestServer();

    // Fire many transitions rapidly
    const promises = [];
    for (let i = 0; i < 10; i++) {
      server.stateManager.transition({
        type: "PhaseStarted",
        data: {
          runId: server.stateManager.getState().currentRunId!,
          phaseId: PhaseId(`phase-${i}`),
        },
      });
    }

    await server.stateManager.waitForPendingTransitions();

    const state = server.stateManager.getState();
    expect(state.runs[0].phases).toHaveLength(10);
  });
});
```

### 5. **Add Phase Transition Tests**

**File: `tests/e2e/phase-transitions-e2e.test.ts`** (NEW)

```typescript
describe("Phase Transitions E2E", () => {
  test("normal flow: preparing → starting → ... → completed", async () => {
    const { server, client } = await setupTestEnvironment();

    // Start a phase
    await client.sendCommand({
      id: "test-1",
      type: "phase.start",
      data: { phaseId: "phase-1" },
    });

    // Track state transitions
    const transitions: string[] = [];
    server.stateManager.on("stateChanged", (event) => {
      if (event.type === "PhaseTransitioned") {
        transitions.push(`${event.data.from} → ${event.data.to}`);
      }
    });

    await waitForPhaseStatus(server.stateManager, "phase-1", "completed");

    expect(transitions).toEqual([
      "preparing → starting",
      "starting → initializing",
      "initializing → running",
      "running → completing",
      "completing → completed",
    ]);
  });

  test("skip from each state", async () => {
    // Test skipping from preparing, starting, initializing, running
    for (const skipFrom of [
      "preparing",
      "starting",
      "initializing",
      "running",
    ]) {
      const { server, client } = await setupTestEnvironment();

      // Set up a mock that will pause at the desired state
      // Then send skip command
      // Verify transition to "skipped"
    }
  });
});
```

### 6. **Update Cost Tracking Tests**

**File: `tests/e2e/test-groups/cost-tracking-tests.ts`** (UPDATE)

```typescript
export const costTrackingTests = (getTestState: () => TestState) => {
  test("tracks costs correctly", async () => {
    const testState = getTestState();
    const server = testState.serverProcess;

    // Wait for phases to complete
    await waitForAllPhasesComplete(server);

    // Get costs from state manager
    const totalCost = server.stateManager.getTotalCost();
    const currentRunCost = server.stateManager.getCurrentRunCost();

    expect(totalCost).toBeGreaterThan(0);
    expect(currentRunCost).toBe(totalCost); // First run

    // Verify individual phase costs
    const state = server.stateManager.getState();
    const currentRun = state.runs.find((r) => r.runId === state.currentRunId);

    for (const phase of currentRun!.phases) {
      if (phase.status === "completed") {
        expect(phase.finalCost).toBeGreaterThan(0);
      }
    }
  });
};
```

### 7. **Add Crash Recovery Tests**

**File: `tests/e2e/crash-recovery-e2e.test.ts`** (NEW)

```typescript
describe("Crash Recovery", () => {
  test("detects and marks crashed runs", async () => {
    const testDir = await prepareTestDirectory();

    // Start server with a phase running
    const server1 = await startTestServer(testDir);
    await server1.startPhase(PhaseId("phase-1"));
    await waitForPhaseStatus(server1.stateManager, "phase-1", "running");

    const runId = server1.stateManager.getState().currentRunId!;

    // Simulate crash (kill without cleanup)
    process.kill(server1.processId, "SIGKILL");

    // Start new server
    const server2 = await startTestServer(testDir);
    await new Promise((resolve) => setTimeout(resolve, 200)); // Let crash detection run

    const state = server2.stateManager.getState();
    const crashedRun = state.runs.find((r) => r.runId === runId);

    expect(crashedRun?.status).toBe("crashed");
    expect(crashedRun?.phases[0].status).toBe("failed");
  });
});
```

### 8. **Update Mock Builders**

**File: `tests/utils/mock-builders.ts`** (UPDATE/NEW)

```typescript
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
    this.state.runs.push(fullRun);
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
```

### 9. **Update Integration Tests**

**File: `tests/integration/state-integration.test.ts`** (NEW)

```typescript
describe("State Manager Integration", () => {
  test("full lifecycle with real server", async () => {
    // This tests the integration between LangtonServer and StateManager
    const server = new LangtonServer({
      projectPath: testDir,
      phases: TEST_PHASES,
    });

    await server.start();

    // Verify state manager was initialized
    const state = server.stateManager.getState();
    expect(state.currentRunId).not.toBeNull();

    // Start a phase through the server
    await server.startPhase(PhaseId("phase-1"));

    // Verify state transitions happened
    await waitForPhaseStatus(server.stateManager, "phase-1", "running");

    // Verify cost updates
    // ... etc
  });
});
```

### 10. **Test Cleanup Updates**

**File: `tests/unit/cleanup-integration.test.ts`** (UPDATE)

Add state file cleanup verification:

```typescript
test("cleanup removes state.json", async () => {
  // Create state file
  const statePath = path.join(testDir, ".langton", "state.json");
  await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
  await fs.promises.writeFile(
    statePath,
    JSON.stringify({
      runs: [],
      currentRunId: null,
    })
  );

  const result = await executeTestCleanup({
    testDir,
    phasesConfig: configPath,
  });

  expect(fs.existsSync(statePath)).toBe(false);
});
```

## 🔧 Test Infrastructure Updates

### 1. **Update Test Server Factory**

```typescript
// tests/utils/test-server-factory.ts
export async function createTestServer(
  testDir: string,
  phases: PhaseConfig[]
): Promise<LangtonServer> {
  const server = new LangtonServer({
    projectPath: testDir,
    phases,
    // Make sure state manager gets phases
  });

  await server.start();

  // Wait for state initialization
  await server.stateManager.waitForPendingTransitions();

  return server;
}
```

### 2. **Add State Assertions**

```typescript
// tests/utils/state-assertions.ts
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
```

## 📋 Test Migration Checklist

1. **Unit Tests** (Lower Priority)

   - [x] `state-manager.test.ts` - Already done
   - [x] `state-transitions.test.ts` - Already done
   - [ ] Update `business-logic.test.ts` - Remove old state logic
   - [ ] Update `claude-log-parser.test.ts` - Remove state recovery tests

2. **E2E Tests** (High Priority)

   - [ ] Update `happy-path-e2e.test.ts` - Use state manager queries
   - [ ] Update `skip-phase-continue-e2e.test.ts` - Use state manager
   - [ ] Update `server-shutdown-e2e.test.ts` - Verify state persistence
   - [ ] Add `state-persistence-e2e.test.ts` - New test file
   - [ ] Add `phase-transitions-e2e.test.ts` - New test file
   - [ ] Add `crash-recovery-e2e.test.ts` - New test file

3. **Test Groups** (Medium Priority)

   - [ ] Update all files in `tests/e2e/test-groups/`
   - [ ] Replace event-based state inspection with state manager queries
   - [ ] Add state consistency checks

4. **Test Infrastructure** (High Priority)
   - [ ] Create `state-test-helpers.ts`
   - [ ] Update `test-helpers.ts` with state utilities
   - [ ] Create `mock-builders.ts` for state
   - [ ] Update test server creation

## 🚨 Critical Test Changes

1. **Stop using `completedPhases` array** - Query state manager instead
2. **Stop checking `currentPhase` directly** - Use `getCurrentPhase()`
3. **Add `waitForPendingTransitions()` after state changes** in tests
4. **Test state persistence** across server restarts
5. **Test crash recovery** scenarios

The test updates are essential for validating that the new state management system works correctly and maintains data integrity across all scenarios.
