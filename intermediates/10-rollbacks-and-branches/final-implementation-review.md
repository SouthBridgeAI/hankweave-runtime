# State Management Implementation Analysis

## Overview

This document captures the systematic review of the state management system implementation in the Langton Runner project.

## Analysis Process

1. Review git status to see all changed files
2. Examine git diff to understand specific changes
3. Review new state management files
4. Identify patterns and architectural changes
5. Document remaining legacy code
6. Note problems and issues

---

## Git Status

### New Files (A)

- `server/state-manager.ts` - Core state management
- `server/state-transition-guards.ts` - State transition validation
- `server/state-types.ts` - State type definitions
- `tests/e2e/crash-recovery-e2e.test.ts` - Crash recovery tests
- `tests/e2e/state-persistence-e2e.test.ts` - State persistence tests
- `tests/unit/state-manager.test.ts` - State manager unit tests
- `tests/unit/state-transitions.test.ts` - State transition unit tests
- `tests/utils/mock-builders.ts` - Mock utilities
- `tests/utils/state-assertions.ts` - State assertion helpers
- `tests/utils/state-test-helpers.ts` - State test utilities
- `tests/utils/state-types-helper.ts` - State type helpers

### Modified Files (M)

- Core server files: `langton-server.ts`, `claude-process-manager.ts`, `claude-log-parser.ts`
- Supporting files: `branded-types.ts`, `typed-event-emitter.ts`, `utils.ts`
- Cleanup system: `cleanup-command.ts`, `cleanup/manifest-builder.ts`, `cleanup/types.ts`
- Test infrastructure: Multiple e2e and unit test files
- Configuration: `tsconfig.json`, `bun.lockb`

---

## Core State Management System

### state-types.ts Analysis

This file defines the complete type system for state management:

#### Key Design Patterns

1. **Discriminated Unions for Phase States**

   - Uses TypeScript's discriminated union pattern with `status` field
   - 8 distinct phase states: preparing, starting, initializing, running, completing, completed, failed, skipped
   - Each state has specific fields relevant to that state only

2. **State Machine with Legal Transitions**

   - `PhaseTransitions` map defines which state transitions are legal
   - Terminal states (completed/failed/skipped) have no valid transitions
   - Can skip or fail from any non-terminal state

3. **Branded Types Integration**

   - Uses `PhaseId`, `RunId`, `SessionId` from branded-types.ts
   - Provides type safety at compile time
   - Prevents mixing up different ID types

4. **Immutable Terminal States**
   - CompletedPhase, FailedPhase, SkippedPhase are terminal
   - All fields are final once reached
   - To retry, must start a new run

#### Core Types

1. **PhaseExecution Union**

   ```typescript
   type PhaseExecution =
     | PreparingPhase
     | StartingPhase
     | InitializingPhase
     | RunningPhase
     | CompletingPhase
     | CompletedPhase
     | FailedPhase
     | SkippedPhase;
   ```

2. **Run Type**

   - Represents one server lifecycle (start → shutdown)
   - Contains ordered list of phase executions
   - Tracks starting conditions (fresh vs continuation)
   - Has run status: running, completed, failed, crashed

3. **LangtonState Root**

   - Contains all runs (newest first)
   - Tracks current active run ID
   - No denormalized costs (computed on demand)

4. **StateTransition Events**
   - RunStarted, RunCompleted, RunFailed, RunCrashed
   - PhaseStarted, PhaseTransitioned
   - CostsUpdated, CheckpointCreated
   - These are the ONLY way to modify state

#### Notable Design Decisions

1. **No Version Field** - Per user request, no state version tracking
2. **Computed Costs** - Costs/tokens computed from runs when needed to avoid sync issues
3. **Append-Only History** - Runs are never removed from history
4. **Single State File** - Uses .langton/state.json instead of per-run files
5. **Git Integration** - Checkpoint SHAs stored in phase states

#### Edge Cases Handled

- Process might be dead when we have PID
- Checkpoint creation might fail
- Result message might timeout (30 second wait)
- State file corruption (backup and recovery)
- Orphaned run folders

---

## State Manager Implementation

### state-manager.ts Analysis

The central state management implementation with sophisticated features:

#### Key Architecture Features

1. **Queue-Based Transition System**

   - Transitions are queued and processed sequentially
   - Fire-and-forget API: `transition()` returns immediately
   - Prevents race conditions with single processing loop
   - Ensures state consistency across async operations

2. **Cost Caching System**

   ```typescript
   private costCache = {
     total: 0,
     currentRun: 0,
     lastUpdated: null as string | null,
   };
   ```

   - Maintains running tallies for performance
   - Rebuilds cache when costs change
   - Avoids recalculating on every query

3. **Atomic Persistence**

   - Creates backup before save
   - Writes to temp file first
   - Atomic rename to final path
   - Recovery from backup if main corrupted

4. **Event System Integration**
   - Extends TypedEventEmitter for type-safe events
   - Emits `stateChanged` after each transition
   - Special event for `phaseRunning` status
   - Error events for failed transitions

#### Implementation Patterns

1. **Validation Pipeline**

   - Structural validation of state
   - Transition legality checking
   - Metadata validation via state-transition-guards
   - Referential integrity checks

2. **Immutable State Updates**

   - Deep clones state before modifications
   - Pure function approach in `applyTransition`
   - Original state never mutated

3. **Crash Detection**

   - Checks process existence with `process.kill(pid, 0)`
   - Marks orphaned runs as crashed
   - Handles partial state writes

4. **Debug Support**
   - Logs all transitions to events.jsonl
   - Includes resulting state summary
   - Non-blocking logging (failures don't break transitions)

#### Notable Implementation Details

1. **Phase Finding Logic**

   ```typescript
   // Prefers non-terminal phases when multiple exist
   for (let i = run.phases.length - 1; i >= 0; i--) {
     const phase = run.phases[i];
     if (
       phase.phaseId === event.data.phaseId &&
       !isTerminalPhaseStatus(phase.status)
     ) {
       phaseIndex = i;
       break;
     }
   }
   ```

2. **State File Locations**

   - Main: `.langton/state.json`
   - Backup: `.langton/state.json.bak`
   - Events: `.langton/events.jsonl`

3. **Error Handling**
   - InvalidTransitionError for illegal state changes
   - PersistenceError for save failures
   - Graceful degradation on logging errors

#### Potential Issues

1. **Memory Growth** - events.jsonl grows unbounded
2. **Race Condition** - Small window between state change and persistence
3. **Recovery Limited** - Only "fresh start" recovery implemented
4. **No State Migration** - No versioning despite complex state structure

---

## State Transition Guards

### state-transition-guards.ts Analysis

A focused module for validating state transition metadata:

#### Key Design Patterns

1. **Type-Safe Metadata Interfaces**

   - Separate interface for each transition type
   - InitializingMetadata, RunningMetadata, CompletedMetadata, etc.
   - Ensures compile-time safety for transition data

2. **Type Guard Functions**

   - Runtime validation matching TypeScript types
   - Defensive checks for null/undefined
   - Property existence and type checking

3. **Centralized Validation**
   - Single `validateTransitionMetadata` function
   - Throws descriptive errors with missing fields
   - Used by StateManager before applying transitions

#### Implementation Details

1. **Type Guard Pattern**

   ```typescript
   export function hasInitializingMetadata(
     metadata: unknown
   ): metadata is InitializingMetadata {
     return (
       typeof metadata === "object" &&
       metadata !== null &&
       "claudePid" in metadata &&
       "claudeLogPath" in metadata &&
       typeof (metadata as Record<string, unknown>).claudePid === "number" &&
       typeof (metadata as Record<string, unknown>).claudeLogPath === "string"
     );
   }
   ```

2. **Error Reporting**

   - MetadataValidationError with specific missing fields
   - Makes debugging transition failures easier
   - Clear error messages for developers

3. **Transition Requirements**
   - preparing → initializing: Needs claudePid, claudeLogPath
   - initializing → running: Needs claudeSessionId
   - - → completed: Needs checkpointSha
   - - → failed: Needs exitCode, failureReason, failedDuring
   - - → skipped: Needs skippedDuring

#### Benefits

- Type safety at runtime boundaries
- Clear separation of validation logic
- Easy to extend for new transitions
- Consistent error handling

---

## Integration with LangtonServer

### langton-server.ts Analysis

The main server integrates deeply with the state management system:

#### State Manager Integration Points

1. **Initialization**

   ```typescript
   // Initialize state manager
   const langtonDir = path.join(this.config.projectPath, ".langton");
   this._stateManager = new StateManager(
     langtonDir,
     this.logger,
     this.config.phases
   );

   // Set up state manager listeners
   this.setupStateManagerListeners();
   ```

2. **Event Listeners**

   - Listens to `phaseRunning` event to send WebSocket phase.started
   - Listens to `transitionError` for fatal persistence errors
   - Bridges state changes to WebSocket events

3. **State Transitions Fired**
   - `RunStarted` - When server starts a new run
   - `RunCompleted` - When all phases finish successfully
   - `RunFailed` - When run fails or is interrupted
   - `RunCrashed` - When detecting stale lock files
   - `PhaseStarted` - When phase begins execution
   - `PhaseTransitioned` - Throughout phase lifecycle
   - `CostsUpdated` - When Claude reports token usage
   - `CheckpointCreated` - After git checkpoints

#### Phase Lifecycle Implementation

The server follows the state machine precisely:

1. **Phase Start**

   ```
   PhaseStarted → preparing
   [workspace setup]
   preparing → starting
   [spawn Claude]
   starting → initializing (with PID, log path)
   [wait for session ID]
   initializing → running (with session ID)
   ```

2. **Phase Completion**

   ```
   running → completing
   [wait for result message]
   completing → completed (with final costs)
   ```

3. **Skip/Failure Paths**
   - Can transition to `skipped` or `failed` from most states
   - Proper metadata included (failedDuring, skippedDuring)

#### Key Integration Patterns

1. **Fire-and-Forget Transitions**

   - All state transitions use fire-and-forget pattern
   - Server doesn't await transition completion
   - Prevents blocking on state persistence

2. **Dual State Tracking**

   - Maintains local `currentPhase` for backward compatibility
   - Uses StateManager as single source of truth
   - Bridges old event system with new state system

3. **Cost Management**

   - Accumulates costs during phase execution
   - Updates state with `CostsUpdated` transitions
   - Final costs from result message override accumulated

4. **Checkpoint Integration**
   - Creates checkpoints at key moments
   - Stores SHA in state via `CheckpointCreated` transition
   - Handles checkpoint failures gracefully

#### Notable Implementation Details

1. **Lock File Enhancement**

   ```typescript
   interface LockFile {
     pid: number;
     runId: string;
     startTime: string;
     lastHeartbeat: string;
   }
   ```

   - Heartbeat system prevents stale locks
   - Detects crashed runs on startup

2. **Result Message Handling**

   - Uses promises with timeouts for result messages
   - Maps phase execution ID to result promises
   - Graceful handling of timeouts

3. **Error Severity System**

   - FATAL: Triggers shutdown
   - PHASE: Fails current phase only
   - OPERATION: Logs but continues
   - WARNING: Just informational

4. **Checkpoint Accumulation**
   - Patterns accumulate across phases
   - Ensures resume works correctly
   - Only tracks files matching patterns

#### Potential Issues

1. **State Synchronization**

   - Dual tracking (local + StateManager) could diverge
   - Heavy reliance on timing for state updates
   - Some await delays (100-200ms) seem arbitrary

2. **Error Handling Gaps**

   - Some transitions don't check currentRunId
   - Checkpoint failures might not be handled consistently
   - State transitions in error paths could fail

3. **Legacy Code Remnants**

   - `getCompletedPhasesForSnapshot` maintains old API
   - Local phase state duplicates StateManager data
   - Some cost calculations happen in multiple places

4. **Race Conditions**
   - Small window between phase completion and state update
   - Result message timeout vs phase completion race
   - Checkpoint creation vs state transition timing

---

## Supporting Infrastructure

### typed-event-emitter.ts Analysis

Type-safe event system that bridges state management with the rest of the application:

#### Key Design Features

1. **Generic Type Safety**

   ```typescript
   export class TypedEventEmitter<T extends Record<string, unknown[]>> {
     private emitter = new EventEmitter();
     // Type-safe wrappers for all EventEmitter methods
   }
   ```

2. **Event Maps Defined**

   - `ServerInternalEvents` - For server lifecycle events
   - `ProcessEvents` - For Claude process management
   - `StateManagerEvents` - For state transitions

3. **State Manager Events**
   ```typescript
   export interface StateManagerEvents {
     stateChanged: [StateTransition];
     phaseRunning: [
       {
         runId: RunId;
         phaseId: PhaseId;
         from: PhaseStatus;
         to: "running";
         metadata?: Record<string, unknown>;
       }
     ];
     transitionError: [{ event: StateTransition; error: Error }];
   }
   ```

#### Benefits

- Compile-time type checking for events
- Prevents typos in event names
- Ensures correct argument types
- Maintains Node.js EventEmitter compatibility

---

## Branded Types Enhancement

### branded-types.ts Analysis

Provides compile-time type safety through branded types:

#### Implementation Pattern

```typescript
type Branded<T, Brand> = T & { __brand: Brand };
```

#### Branded Types Defined

1. **PhaseId** - References a phase configuration
2. **SessionId** - Claude's session UUID
3. **RunId** - Unique identifier for a server run
4. **EventId** - Unique identifier for WebSocket events
5. **PhaseExecutionId** - DEPRECATED (marked for removal)

#### Benefits

- Prevents mixing up string types
- Compile-time type checking
- Self-documenting code
- Zero runtime overhead

#### Usage Example

```typescript
// Can't accidentally pass a RunId where PhaseId expected
const phaseId = PhaseId("phase-1");
const runId = RunId("run-123");
// startPhase(runId); // TypeScript error!
startPhase(phaseId); // OK
```

---

## Test Infrastructure

### Unit Tests

#### state-manager.test.ts Analysis

Comprehensive unit tests for the StateManager:

##### Test Coverage

1. **Initialization Tests**

   - Creates new state when no file exists
   - Loads existing state from disk
   - Recovers from backup when main file corrupted
   - Detects crashed runs on startup (checks non-existent PIDs)

2. **State Transition Tests**

   - Validates legal transitions through the state machine
   - Rejects invalid transitions (e.g., preparing → completed)
   - Persists after each transition
   - Maintains immutability of terminal states
   - Handles rapid transitions without corruption

3. **Query Tests**

   - getCurrentRun returns active run
   - getCurrentPhase returns running phase
   - getLastSuccessfulPhase searches all runs
   - Cost calculations sum correctly

4. **Persistence Tests**

   - Atomic writes with backup creation
   - State validation for integrity
   - Handles missing state files gracefully
   - Continues after persistence errors (read-only directory test)

5. **Event Emission Tests**
   - emits stateChanged after transitions
   - emits phaseRunning when phase starts running

##### Notable Test Patterns

1. **Mock Logger**

   ```typescript
   class MockLogger extends Logger {
     logs: Array<{ message: string; level: string }> = [];
     // Captures log messages for verification
   }
   ```

2. **Test Directory Management**

   - Creates isolated test directory for each test suite
   - Cleans up after tests
   - Tests file system operations directly

3. **Async Handling**

   - Uses `waitForPendingTransitions()` to ensure queue processing
   - Small delays for crash detection tests
   - Proper async/await throughout

4. **Edge Case Testing**
   - Corrupted JSON files
   - Read-only directories
   - Non-existent processes
   - Rapid state changes

---

## Modified Files Analysis

### utils.ts Changes

**Removed**: `extractSessionIdFromLog` function

- This functionality is now handled by the state management system
- Session IDs are tracked in state rather than extracted from logs
- Cleaner separation of concerns

### claude-process-manager.ts Changes

**Enhanced**: `spawn` method now accepts custom log path

```typescript
async spawn(
  phase: PhaseConfig,
  previousSessionId: string | null,
  logPath?: string,  // New parameter
): Promise<string>
```

**Purpose**:

- Enables run-specific log folders
- Logs now stored in `.langton/runs/{runId}/phase-{phaseId}-claude.log`
- Better organization and isolation between runs

---

## Key Observations

### checkpoint-git.ts Changes

**Improved Branch Management**:

- Now remembers original branch before switching
- Checks if branch exists before creating
- Always returns to original branch after commit
- Better logging of branch operations

**Key Changes**:

```typescript
// Remember current branch
const currentBranchInfo = await this.git.branch();
originalBranch = currentBranchInfo.current;

// Check if branch exists before creating
if (!branches.all.includes(options.branch)) {
  await this.git.checkoutLocalBranch(options.branch);
} else {
  await this.git.checkout(options.branch);
}
```

**Purpose**:

- Prevents errors from trying to create existing branches
- Maintains proper git state by returning to original branch
- Essential for run-specific branches in state management

---

## More Changes to Review

### claude-log-parser.ts Changes

**Major Cleanup**: Removed `loadPhaseStateFromLog` function

**What was removed**:

- 112 lines of code for parsing log files to recover state
- Token usage accumulation from assistant messages
- Cost calculation from logs
- Session ID extraction logic

**Why removed**:

- State is now managed by the StateManager, not derived from logs
- Session IDs, costs, and tokens are tracked in real-time via state transitions
- No need to reconstruct state from logs - it's persisted properly
- Cleaner separation of concerns

**Impact**:

- ClaudeLogParser now focused solely on streaming log parsing
- State recovery happens through state.json, not log parsing
- More reliable state management
- Faster server startup (no log parsing needed)

---

## Summary and Findings

### New E2E Tests

#### state-persistence-e2e.test.ts Analysis

Tests the state persistence functionality across server restarts:

##### Test Scenarios

1. **State Survives Server Restart**

   - Starts server, runs phase 1, skips phase 2
   - Gracefully shuts down server
   - Restarts server and verifies state is preserved
   - Checks that runs and phases are still in state

2. **Phase History is Preserved**

   - Verifies phase 1 is marked as completed
   - Verifies phase 2 is marked as skipped
   - Checks costs are preserved correctly

3. **New Run Created After Restart**

   - Confirms new runId is generated on restart
   - Verifies both runs exist in state

4. **Run Folders are Preserved**

   - Checks `.langton/runs/{runId}` folders exist
   - Verifies Claude log files are in correct locations

5. **State File Backup Exists**
   - Verifies `.langton/state.json.bak` is created
   - Checks backup contains valid state data

##### Notable Patterns

- Uses `TestLangtonState`, `TestRun`, `TestPhaseExecution` types for type safety
- Tests both graceful shutdown and restart scenarios
- Some tests are skipped (marked with `.skip`) for future features:
  - Session continuity preservation
  - Cost calculation after restart with continuation
  - Rollback/continuation feature not yet implemented

##### Key Finding

**Current Behavior**: When server restarts after graceful shutdown, it starts a new run from phase 1 rather than continuing from the last completed phase. The test notes this is expected behavior until rollback/continuation is implemented.

---

## More Test Analysis

#### crash-recovery-e2e.test.ts Analysis

Tests the crash detection and recovery functionality:

##### Test Scenarios

1. **Server Recovers from Crash Mid-Phase**

   - Starts server and begins phase 1
   - Kills server with SIGKILL (simulating crash)
   - Starts new server instance
   - Verifies the crashed run is detected and continued
   - Confirms currentRunId remains the same

2. **Crashed Run Has Proper Metadata**

   - Looks for runs with status="crashed"
   - Verifies endTime is set
   - Checks that running phase is marked as failed
   - Confirms failure reason mentions "crashed"

3. **Lock File is Updated After Recovery**

   - Verifies lock file persists through crash
   - Checks that runId stays the same (continuation)
   - Confirms PID and heartbeat are updated
   - Validates heartbeat is recent (< 1 minute old)

4. **Run Folders Exist**

   - Checks `.langton/runs/{runId}` folders exist
   - Verifies crashed run folder is preserved

5. **State File Structure Validation**
   - Validates state.json has proper structure
   - Checks all required fields exist
   - Verifies arrays are properly formatted

##### Key Implementation Detail

The test reveals an important behavior: **When recovering from a crash, the server continues the same run rather than starting a new one**. This is different from graceful restart where a new run is created.

```typescript
// The current run ID should be the same as before the crash
expect(state.currentRunId).toBe(testState.runId1);
```

This matches the crash detection logic in StateManager which marks crashed runs but allows recovery to continue them.

---

## Final Summary

### State Management System Overview

The new state management system represents a significant architectural improvement:

#### Core Architecture

1. **Centralized State Management**

   - Single source of truth in `.langton/state.json`
   - All state modifications go through StateManager
   - Type-safe state transitions with validation

2. **Event-Driven Updates**

   - Fire-and-forget transition API
   - Queue-based processing prevents race conditions
   - Events emitted after successful persistence

3. **Crash Resilience**

   - Atomic file operations with backup
   - Process existence checking on startup
   - Heartbeat system in lock files
   - Graceful recovery from crashes

4. **Type Safety**
   - Discriminated unions for phase states
   - Branded types prevent ID confusion
   - Runtime validation of transitions
   - Compile-time event type checking

#### Key Benefits

1. **Reliability**

   - State persists through crashes
   - No more log parsing for recovery
   - Backup files prevent data loss

2. **Performance**

   - Cost caching reduces calculations
   - No startup log parsing overhead
   - Efficient state queries

3. **Maintainability**

   - Clear separation of concerns
   - Extensive test coverage
   - Self-documenting type system

4. **Extensibility**
   - Easy to add new state transitions
   - Type-safe event system
   - Clear patterns for new features

#### Areas for Future Improvement

1. **Rollback/Continuation Feature**

   - Currently starts new run after graceful restart
   - Should offer to continue from last checkpoint
   - Tests already written, awaiting implementation

2. **State Migration**

   - No versioning system yet
   - Will be needed as state structure evolves
   - Consider adding version field

3. **Memory Management**

   - events.jsonl grows unbounded
   - Consider rotation or archival strategy

4. **Legacy Code Cleanup**
   - Remove duplicate state tracking in server
   - Eliminate PhaseExecutionId branded type
   - Consolidate cost calculations

#### Migration Impact

The implementation shows careful consideration for backward compatibility:

- WebSocket API remains unchanged
- Old event system still works
- Gradual migration path for legacy code

Overall, this state management system provides a solid foundation for the Langton Runner project, with clear patterns for reliability, type safety, and future extensibility.
