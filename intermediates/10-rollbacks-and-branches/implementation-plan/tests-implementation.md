# Comprehensive Test Update Plan for State Management Refactoring

## Overview

The state management refactoring touches nearly every aspect of the system, so most tests will need updates. Here's a phased approach that matches the implementation phases.

## Phase-by-Phase Test Updates

### Phase 1: Foundation - State Types and Manager (Add New Tests First)

#### 1.1 Create New Unit Tests for State Manager

**Create `tests/unit/state-manager.test.ts`**:

```typescript
describe("StateManager", () => {
  describe("initialization", () => {
    test("creates new state when no file exists");
    test("loads existing state from disk");
    test("recovers from backup when main file corrupted");
    test("detects crashed runs on startup");
    test("handles concurrent file access gracefully");
  });

  describe("state transitions", () => {
    test("validates legal transitions");
    test("rejects invalid transitions");
    test("persists after each transition");
    test("maintains immutability of terminal states");
    test("handles rapid transitions without corruption");
  });

  describe("queries", () => {
    test("getCurrentRun returns active run");
    test("getCurrentPhase returns running phase");
    test("getNextPhaseToExecute handles continuations");
    test("getLastSuccessfulPhase searches all runs");
    test("cost calculations sum correctly");
  });

  describe("persistence", () => {
    test("atomic writes with backup");
    test("handles disk full errors");
    test("validates state integrity");
  });
});
```

**Create `tests/unit/state-transitions.test.ts`**:

```typescript
describe("State Transitions", () => {
  test("RunStarted creates new run");
  test("PhaseStarted adds phase to current run");
  test("PhaseTransitioned updates phase status");
  test("CostsUpdated accumulates correctly");
  test("CheckpointCreated sets SHA");
  test("RunCompleted/Failed/Crashed set terminal state");
});
```

### Phase 2: Replace In-Memory State

#### 2.1 Update Existing Unit Tests

**Update `tests/unit/business-logic.test.ts`**:

- `getNextPhaseIndex`: Replace with calls to `stateManager.getNextPhaseToExecute()`
- `getPreviousSessionId`: Update to use `stateManager.getLastSuccessfulPhase()`
- Remove tests for in-memory state arrays

**Update `tests/unit/claude-log-parser.test.ts`**:

- Remove `loadPhaseStateFromLog` tests (this function is being deleted)
- Keep log parsing tests but update to not rely on state recovery

#### 2.2 Create Integration Test for State Recovery

**Create `tests/e2e/state-recovery-e2e.test.ts`**:

```typescript
describe("State Recovery E2E", () => {
  test("recovers from crash mid-phase");
  test("continues from previous successful run");
  test("handles corrupted state file");
  test("detects orphaned run folders");
});
```

### Phase 3: Update Phase Lifecycle

#### 3.1 Update E2E Test Helpers

**Update `tests/utils/test-helpers.ts`**:

```typescript
// Add state inspection helpers
export async function waitForPhaseStatus(
  server: LangtonServer,
  phaseId: string,
  status: PhaseStatus
): Promise<void> {
  // Poll state manager instead of events
}

export function getServerState(server: LangtonServer): LangtonState {
  return server.stateManager.getState();
}
```

#### 3.2 Update Happy Path Tests

**Update `tests/e2e/happy-path-e2e.test.ts`**:

In `setupAndRunPhases()`:

```typescript
// Replace:
// testState.completedPhases = testState.client.getEvents()...

// With:
const finalState = getServerState(testState.serverProcess);
testState.completedPhases = finalState.runs[0].phases.filter(
  (p) => p.status === "completed"
);
```

Update all test groups:

- **Phase Execution tests**: Check phase transitions through states
- **Cost Tracking tests**: Use `stateManager.getCurrentRunCost()`
- **State Snapshot tests**: Verify computed from state.json
- **Dual ID System tests**: Verify phaseExecutionId is gone

### Phase 4: Update State Snapshot Tests

**Update all snapshot-related tests** to verify:

- Costs are computed, not stored
- Current phase reflects state manager
- Completed phases match state.json

### Phase 5: Update Query Tests

**Update `tests/e2e/test-groups/session-continuity-tests.ts`**:

- Test uses new continuation mechanism
- Verify parent run tracking

**Update `tests/e2e/test-groups/state-consistency-tests.ts`**:

- Verify state.json consistency
- Test state transitions are atomic

### Phase 6: Update Process Manager Tests

**Update `tests/unit/claude-process-manager.test.ts`**:

- Add tests for custom log path parameter
- Verify logs written to run folders

### Phase 7: Update Checkpoint Tests

**Update `tests/e2e/test-groups/checkpoint-system-tests.ts`**:

- Verify one branch per run (not per phase)
- Test branch naming matches runId
- Verify checkpoint SHA storage in state

**Update `tests/unit/checkpoint-git.test.ts`**:

- Test branch creation/switching behavior

### Phase 8: Update Cleanup Tests

**Update `tests/unit/cleanup-command.test.ts`**:

- Test cleanup of run folders
- Test state.json removal warning
- Verify cleanup finds all run artifacts

**Update `tests/e2e/cleanup integration tests`**:

- Verify all run folders removed
- Test cleanup with multiple runs

## New Tests to Add

### 1. State Persistence Tests

**Create `tests/e2e/state-persistence-e2e.test.ts`**:

```typescript
describe("State Persistence E2E", () => {
  test("state survives server restart");
  test("concurrent updates don't corrupt state");
  test("rollback creates proper continuation");
  test("run folders match state.json");
});
```

### 2. Run Management Tests

**Create `tests/unit/run-management.test.ts`**:

```typescript
describe("Run Management", () => {
  test("generates unique run IDs");
  test("creates run folders correctly");
  test("tracks parent relationships");
  test("handles missing run folders");
});
```

### 3. Phase Transition Tests

**Create `tests/e2e/phase-transitions-e2e.test.ts`**:

```typescript
describe("Phase Transitions E2E", () => {
  test("normal flow: preparing → starting → ... → completed");
  test("skip from each state");
  test("fail from each state");
  test("crash recovery from each state");
});
```

### 4. Cost Computation Tests

**Create `tests/unit/cost-computation.test.ts`**:

```typescript
describe("Cost Computation", () => {
  test("sums costs across phases in run");
  test("excludes skipped phases");
  test("includes partial costs from failed phases");
  test("calculates total across all runs");
});
```

## Test Execution Order

### Stage 1: Unit Tests First (Safe to run anytime)

1. Create new state manager unit tests
2. Create state transition unit tests
3. Create cost computation unit tests
4. Update existing unit tests that don't spawn servers

### Stage 2: Integration Preparation

1. Update test helpers with state inspection
2. Create mock state builder utilities
3. Update cleanup integration tests

### Stage 3: E2E Updates (After core implementation)

1. Update happy-path-e2e.test.ts incrementally:
   - First just state reading
   - Then phase tracking
   - Then cost verification
2. Update skip-phase-continue-e2e.test.ts
3. Update server-shutdown-e2e.test.ts
4. Add new state-persistence-e2e.test.ts
5. Add new phase-transitions-e2e.test.ts

## Specific Test Updates by File

### Files Needing Major Updates

1. **`happy-path-e2e.test.ts`** (173 tests):

   - Replace `completedPhases` array checks
   - Update cost verification to use state manager
   - Add phase transition verification
   - Update checkpoint tests for run branches

2. **`skip-phase-continue-e2e.test.ts`** (45 tests):

   - Verify skip transitions
   - Check skipped phase costs are 0
   - Verify state persistence of skips

3. **`server-shutdown-e2e.test.ts`** (59 tests):

   - Test crash detection on recovery
   - Verify exit transitions
   - Check state file after shutdown

4. **All `test-groups/*.ts` files**:
   - Update state inspection methods
   - Replace event-based state checks
   - Add transition verification

### Files Needing Minor Updates

1. **`cleanup-*.test.ts`**:

   - Add run folder cleanup
   - Test state.json handling

2. **`checkpoint-*.test.ts`**:
   - Update for run-based branches
   - Test SHA storage in state

### Files That Can Stay Mostly Unchanged

1. **`type-guards.test.ts`** - Events still exist
2. **`file-resolver*.test.ts`** - Unaffected
3. **`real-claude-logs.test.ts`** - Log format unchanged

## Test Data Helpers

Create `tests/utils/state-test-builder.ts`:

```typescript
export class StateTestBuilder {
  private state: LangtonState = { runs: [], currentRunId: null };

  withRun(run: Partial<Run>): this {
    // Builder pattern for test states
  }

  withPhase(phase: Partial<PhaseExecution>): this {
    // Add phase to current run
  }

  build(): LangtonState {
    return this.state;
  }
}
```

## Migration Strategy

1. **Keep both systems working initially**:

   - State manager writes state.json
   - Keep in-memory state for existing tests
   - Add feature flag to enable/disable state manager

2. **Parallel test suites**:

   - Run existing tests with legacy mode
   - Run new tests with state manager
   - Gradually migrate tests

3. **Incremental updates**:
   - Start with read-only state queries
   - Then update state modifications
   - Finally remove legacy code

## Key Testing Principles

1. **Test state transitions, not implementation**:

   - Focus on observable state changes
   - Don't test internal state structure

2. **Use real state files when possible**:

   - E2E tests should use actual state.json
   - Unit tests can use in-memory state

3. **Test error scenarios thoroughly**:

   - Corrupted state files
   - Missing run folders
   - Concurrent modifications
   - Disk full scenarios

4. **Verify backwards compatibility**:
   - WebSocket events unchanged
   - Client compatibility maintained

## Success Criteria

- All existing tests pass with new state system
- State persists correctly across restarts
- Crash recovery works reliably
- Performance not degraded
- No race conditions in state updates
