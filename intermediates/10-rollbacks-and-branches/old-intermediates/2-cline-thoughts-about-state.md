FROM AI:

# Thoughts About State System for Rollback and Branching

## Current State Analysis

### What Currently Exists

1. **In-Memory State (Ephemeral)**

   - `currentPhase`: Only tracks the actively running phase
   - `completedPhases`: Array of successful phases only
   - `runId`: Single ID for the entire server lifecycle
   - Various flags (`isShuttingDown`, `isSkippingPhase`)
   - Result message promises
   - Total cost accumulation

2. **Persistent State (Scattered)**

   - Claude logs: `.langton/logs/log-{phase-id}.jsonl`
   - Server logs: `.langton/logs/server.log`
   - Git checkpoints: `.langton/checkpoints/`
   - Lock file: `.langton/server.lock`

3. **State Recovery Limitations**
   - `loadPreviousState()` only recovers successful phases
   - Lost information: Failed attempts, retries, skip reasons
   - No relationship tracking between attempts
   - No awareness of execution branches or paths

## Current Claude Log Dependencies

### Where Claude logs are used as source of truth:

1. **Startup Recovery** (`loadPhaseStateFromLog` in claude-log-parser.ts)

   - Extracts session ID from init message
   - Determines success from result message
   - Calculates costs from token usage
   - **Problem**: Only captures final successful attempt per phase

2. **Real-time Parsing** (ClaudeLogParser class)

   - Streams events during execution
   - Updates costs incrementally
   - **Problem**: No persistent state updates, just event emission

3. **Session ID Extraction** (`extractSessionIdFromLog` in utils.ts)
   - Gets Claude's UUID for continuation
   - **Problem**: Tightly coupled to log format

### Why Claude logs shouldn't be the source of truth:

- They're Claude's internal format, could change
- Only contain Claude's view, not our orchestration decisions
- No relationship tracking between attempts
- Can't store our metadata (branch info, parent attempts, etc.)

## Append-Only vs Mutable State

### Option 1: Append-Only Log

```typescript
// Each state change appends a new event
type StateEvent =
  | {
      type: "RunStarted";
      runId: string;
      timestamp: string;
      projectPath: string;
    }
  | {
      type: "AttemptStarted";
      attemptId: string;
      phaseId: string;
      parentAttemptId?: string;
    }
  | {
      type: "AttemptCompleted";
      attemptId: string;
      success: boolean;
      cost: number;
    }
  | { type: "TokensUsed"; attemptId: string; tokens: TokenUsage };
// ... etc
```

**Pros:**

- Natural audit trail
- Can replay to any point
- No lost updates
- Crash recovery is simple (replay from beginning)

**Cons:**

- Must replay entire log on startup
- Queries require scanning
- File grows unbounded
- Need compaction strategy

### Option 2: Mutable State File

```typescript
interface RunState {
  runId: string;
  projectPath: string;
  currentAttemptId: string | null;
  attempts: Record<string, AttemptState>;
  // ... other fields
}
```

**Pros:**

- Fast reads (no replay needed)
- Bounded size (with cleanup)
- Direct queries
- Simple mental model

**Cons:**

- Need atomic writes
- Potential for corruption
- Lost update risk
- Harder crash recovery

### Hybrid Approach (Recommended)

Use mutable state file with write-ahead logging:

1. **Primary State**: `.langton/runs/{runId}/state.json`

   - Current complete state
   - Atomic write-rename updates
   - Fast startup reads

2. **Write-Ahead Log**: `.langton/runs/{runId}/wal.jsonl`
   - Append-only for crash recovery
   - Truncated after state snapshot
   - Small, recent changes only

## Strong Typing Strategy

```typescript
// Branded types for IDs
type RunId = Brand<string, "RunId">;
type AttemptId = Brand<string, "AttemptId">;
type PhaseId = Brand<string, "PhaseId">;

// Discriminated unions for states
type AttemptState =
  | { status: "initializing"; startTime: string }
  | { status: "running"; startTime: string; sessionId: string }
  | { status: "completed"; startTime: string; endTime: string; cost: number }
  | { status: "failed"; startTime: string; endTime: string; error: string }
  | { status: "skipped"; startTime: string; endTime: string };

// Zod schemas for validation
const runStateSchema = z.object({
  version: z.literal(1), // Schema version for migrations
  runId: z.string(),
  attempts: z.record(attemptStateSchema),
  // ...
});
```

## Program States

### 1. Server Lifecycle States

```
┌─────────────┐
│   STARTUP   │──────► Check lock file
└─────────────┘        Load state file
        │              Validate & migrate
        ▼
┌─────────────┐
│    READY    │──────► Accept client
└─────────────┘        Auto-start phases
        │
        ▼
┌─────────────┐
│   RUNNING   │──────► Execute phases
└─────────────┘        Update state
        │
        ▼
┌─────────────┐
│  SHUTDOWN   │──────► Save final state
└─────────────┘        Clean up resources
```

### 2. Phase Execution States

```
IDLE ──► PREPARING ──► RUNNING ──► COMPLETING ──► IDLE
           │             │            │
           ▼             ▼            ▼
        FAILED       SKIPPING     ERROR
```

### 3. State Consistency States

```
CONSISTENT ──► UPDATING ──► CONSISTENT
                  │
                  ▼
              CORRUPTED ──► RECOVERING
```

## Conflicts and Edge Cases

### 1. Recoverable Conflicts

**Stale Lock File**

- Detection: PID in lock doesn't exist
- Resolution: Remove and proceed
- Prevention: Check PID validity

**Incomplete State Write**

- Detection: state.json.tmp exists
- Resolution: Use WAL to recover
- Prevention: Atomic writes

**Version Mismatch**

- Detection: Schema version differs
- Resolution: Run migrations
- Prevention: Backward compatible changes

### 2. Non-Recoverable Conflicts

**Corrupted State File**

- Detection: JSON parse fails, schema validation fails
- Mitigation: Backup previous state
- User Action: Restore from backup or start fresh

**Multiple Writers**

- Detection: Lock file with valid PID
- Mitigation: Refuse to start
- User Action: Stop other instance

### 3. Edge Cases

**Crash During State Write**

```
1. Write to WAL ✓
2. Write to state.tmp ✗ CRASH
3. Rename to state.json (never happens)

Recovery: Replay WAL entries on startup
```

**Clock Goes Backward**

```
- Use monotonic counters for ordering
- Store both wall time and monotonic time
- Detect and warn about time jumps
```

**Disk Full**

```
- Pre-allocate space for critical writes
- Detect before write attempt
- Graceful degradation (read-only mode?)
```

**Rapid State Changes**

```
- Batch updates (e.g., token usage)
- Debounce file writes
- Keep recent changes in memory
```

## State Update Patterns

### Critical Updates (Immediate Write)

- Attempt started/completed
- Phase transitions
- Error states
- Cost finalization

### Batched Updates (Periodic Write)

- Token usage accumulation
- File change tracking
- Progress percentages

### Async Updates (Eventually Consistent)

- Git checkpoint commits
- File tree updates
- WebSocket event emissions

## Migration Strategy

1. **Phase 1**: Add state system alongside existing

   - Keep Claude logs as fallback
   - Dual-write to both systems
   - Compare outputs for validation

2. **Phase 2**: Make state system primary

   - Read from state file first
   - Fall back to Claude logs if missing
   - Add migration command

3. **Phase 3**: Remove Claude log dependency
   - State file is sole source of truth
   - Claude logs for debugging only
   - Clean migration path

## Implementation Plan

1. **Define Types** (server/state-types.ts)

   - Branded ID types
   - State interfaces
   - Zod schemas
   - Type guards

2. **State Manager** (server/state-manager.ts)

   - CRUD operations
   - Atomic writes
   - WAL management
   - Recovery logic

3. **Integration Points**

   - Replace `completedPhases` array
   - Update `loadPreviousState()`
   - Hook phase lifecycle
   - Add state events

4. **Testing**
   - Unit tests for state manager
   - Integration tests for recovery
   - Chaos testing (crash scenarios)
   - Migration testing

The key is to build incrementally, maintaining backward compatibility while moving toward a more robust state system.
