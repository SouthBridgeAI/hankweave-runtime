# Context Exceeded Handling - Refined Architecture Design

This document addresses refinement questions from `1-prompt.md` and provides a simplified, cleaner architecture for handling context exceeded in looping phases.

## Question 1: Should "continue-previous" be invalid when previous loop terminatesOn context exceeded?

**Answer: No validation needed at config level. Handle dynamically at runtime.**

### Rationale

The `continuationMode` is a **phase-level configuration** that expresses intent: "this phase _should_ continue from previous when possible." This is appropriate for loop phases where you want to accumulate context across iterations.

However, when context is exceeded, continuation becomes **physically impossible** - there's no more room. The right approach is:

1. **Config level**: Allow `continuationMode: "continue-previous"` in loop phases regardless of termination condition
2. **Runtime level**: Override the continuation behavior when the previous iteration terminated with context exceeded

This keeps configs simple and declarative while handling the special case where it matters.

### Implementation

In `TadpoleServer.startPhase()`:

```typescript
private async startPhase(phaseId: PhaseId): Promise<void> {
  const phase = this.stateManager.getPhase(phaseId);

  // Determine session continuation
  let previousSessionId: string | null = null;

  // Check if we need to force fresh session due to context exceeded
  // This overrides the phase's configured continuationMode
  if (this.forceNextPhaseFresh) {
    previousSessionId = null;
    this.forceNextPhaseFresh = false;
    this.logger.log(
      `[TADPOLE-SERVER] Starting ${phaseId} with FRESH session (previous phase exceeded context)`,
      "info"
    );
  } else if (phase.continuationMode === "continue-previous") {
    // Normal continuation logic
    const prevPhaseEntry = this.stateManager.getPreviousPhaseInSequence(phaseId);
    if (prevPhaseEntry?.sessionId) {
      previousSessionId = prevPhaseEntry.sessionId;
    }
  }

  // Start the phase with determined sessionId
  await this.claudeProcessManager.spawn(phase, previousSessionId, logPath);
}
```

**Key point**: The phase _config_ says "continue-previous", but the _runtime_ decides "actually, start fresh this time" based on what happened in the previous phase.

---

## Question 2: Can we express "context exceeded" using StateManager transition?

**Answer: Yes, but indirectly. Don't add a new transition type.**

### Rationale

The existing `StateTransition` types model **state changes**, not **conditions**. "Context exceeded" is a _condition that affects how we interpret other transitions_.

Looking at existing transitions:
- `PhaseCompleted` - phase finished successfully
- `PhaseFailed` - phase failed with error
- `PhaseFinalCostSet` - cost data recorded

Context exceeded should not be a new transition type because it doesn't represent a new state. Instead, it's _metadata_ that affects how we process `PhaseCompleted` or `PhaseFailed`.

### Proposed Approach

**Add optional metadata to existing transitions** rather than creating a new transition:

```typescript
// In state-types.ts

export type StateTransition =
  | {
      type: "PhaseCompleted";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        sessionId: string;
        endTime: string;
        finalCost: number;
        finalTokens: TokenUsage;
        // NEW: Optional metadata for special completion conditions
        contextExceeded?: boolean;  // <-- Add this
      };
    }
  | {
      type: "PhaseFailed";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        failureReason: FailureReason;
        endTime: string;
        contextExceeded?: boolean;  // <-- And this
      };
    }
  // ... other transitions
```

This approach:
1. **Preserves existing state model** - no new states introduced
2. **Tracks metadata** - we know _how_ a phase completed
3. **Enables downstream logic** - state manager can check this flag when deciding loop expansion
4. **Allows event emission** - tadpole server emits "context.exceeded" event but state transition is still "PhaseCompleted"

### Alternative: Don't use transitions at all

Actually, there's an even simpler approach: **Don't track context exceeded in state at all.**

Instead:
1. TadpoleServer detects context exceeded
2. TadpoleServer queries StateManager: "is this acceptable?"
3. TadpoleServer sets `forceNextPhaseFresh = true` (transient flag)
4. TadpoleServer passes `contextExceeded: true` to `expandNextIterationForPhase()`
5. State transitions remain unchanged - just `PhaseCompleted` or `PhaseFailed`

**Recommendation: Use the simpler alternative.** Context exceeded is a transient runtime condition, not persistent state. No need to store it in the state file.

---

## Question 3: Fresh session handling - need new ClaudeProcessManager method?

**Answer: No new method needed. Existing `spawn()` API is perfect.**

### Current API

```typescript
// In claude-process-manager.ts
async spawn(
  phase: Phase,
  previousSessionId: string | null,  // <-- Already supports null!
  logPath?: string
): Promise<void>
```

The API already supports:
- `previousSessionId = "abc123"` → Continue from session abc123
- `previousSessionId = null` → Start fresh session

### Why This Works

When context is exceeded and we need to start fresh, TadpoleServer simply:

```typescript
// In startPhase()
let previousSessionId: string | null = null;  // Force fresh

if (this.forceNextPhaseFresh) {
  previousSessionId = null;  // Explicitly fresh
} else if (phase.continuationMode === "continue-previous") {
  previousSessionId = this.getPreviousSessionId(phaseId);  // Normal continuation
}

await this.claudeProcessManager.spawn(phase, previousSessionId, logPath);
```

**No changes to ClaudeProcessManager needed.** The abstraction is already correct - `null` means "fresh session", and that's what we want.

---

## Question 4: Architecture from Ground Up

Here's the complete architecture for context exceeded handling, designed for simplicity and clarity.

### Core Principles

1. **Detect early, decide fast** - detect in TadpoleServer, consult StateManager, act immediately
2. **No state pollution** - don't store transient conditions in persistent state
3. **Explicit overrides** - use temporary flags for one-time behavior changes
4. **Leverage existing APIs** - reuse ClaudeProcessManager and ExecutionPlanner as-is

### System Components & Responsibilities

```
┌─────────────────┐
│ TadpoleServer   │  - Detects context exceeded (isContextExceeded)
│                 │  - Queries acceptability (StateManager.isContextExceededAcceptable)
│                 │  - Emits events (context.exceeded)
│                 │  - Sets transient flags (forceNextPhaseFresh)
│                 │  - Controls loop expansion (passes contextExceeded flag)
└────────┬────────┘
         │
         ├──────> ClaudeProcessManager.spawn(phase, sessionId, logPath)
         │        • No changes needed
         │        • Already supports null sessionId for fresh sessions
         │
         ├──────> StateManager.isContextExceededAcceptable(phaseId) : boolean
         │        • NEW METHOD
         │        • Checks if phase is in loop with contextExceeded termination
         │        • Pure query - no state changes
         │
         └──────> StateManager.expandNextIterationForPhase(phaseId, contextExceeded)
                  • MODIFIED SIGNATURE - add contextExceeded param
                  • Passes flag to ExecutionPlanner
                  • Decides whether to create next iteration

┌─────────────────┐
│ StateManager    │  - Queries execution plan for loop config
│                 │  - Coordinates with ExecutionPlanner for loop expansion
│                 │  - Makes business logic decisions
└────────┬────────┘
         │
         └──────> ExecutionPlanner.expandNextIteration(plan, index, contextExceeded)
                  • MODIFIED SIGNATURE - add contextExceeded param
                  • Stops expansion if contextExceeded && terminateOn=contextExceeded
                  • Returns modified plan

┌─────────────────┐
│ ExecutionPlanner│  - Pure logic for plan manipulation
│                 │  - No state management
│                 │  - Implements termination conditions
└─────────────────┘
```

### Data Flow: Context Exceeded in Loop

```
Step 1: Detection
-----------------
Claude process outputs message with context exceeded marker
   ↓
TadpoleServer.onLogMessage() receives message
   ↓
isContextExceeded(msg) returns true
   ↓
Set: this.contextExceededForCurrentPhase = true


Step 2: Query Acceptability
---------------------------
TadpoleServer queries: this.stateManager.isContextExceededAcceptable(phaseId)
   ↓
StateManager:
  - Gets phase entry from execution plan
  - Checks if phase.loopContext exists
  - If yes, looks up loop config
  - Returns (loop.terminateOn.type === "contextExceeded")


Step 3: Emit Event
------------------
TadpoleServer emits event:
  {
    type: "context.exceeded",
    data: {
      phaseId,
      acceptable: <result from step 2>,
      message: "Context window exhausted"
    }
  }


Step 4: Handle Phase Completion
-------------------------------
When phase completes, in handlePhaseComplete():

if (this.contextExceededForCurrentPhase) {
  const acceptable = this.stateManager.isContextExceededAcceptable(phaseId);

  if (acceptable) {
    // Context exceeded is OK - this loop terminates on it
    finalStatus = "completed";
    this.forceNextPhaseFresh = true;  // Next phase MUST start fresh
  } else {
    // Context exceeded is ERROR - not configured to handle it
    finalStatus = "failed";
    this.phaseFailureReason = {
      type: "context-exceeded",
      retriable: false,
      message: "Context window exhausted"
    };
  }
}


Step 5: Loop Expansion Control
------------------------------
If finalStatus === "completed":

  this.stateManager.expandNextIterationForPhase(
    phaseId,
    this.contextExceededForCurrentPhase  // Pass the flag
  );

StateManager receives flag and passes to ExecutionPlanner:

  const newPlan = this.planner.expandNextIteration(
    currentPlan,
    completedIndex,
    contextExceeded  // Pass the flag
  );

ExecutionPlanner logic:

  if (isLastPhaseInIteration) {
    // Check context exceeded termination FIRST (before iteration limit)
    if (contextExceeded && loop.terminateOn.type === "contextExceeded") {
      // Don't expand - loop is done
      return currentPlan;
    }

    // Check iteration limit
    if (iteration < loop.terminateOn.limit) {
      // Expand next iteration
      return [...currentPlan, ...newIteration];
    }
  }


Step 6: Start Next Phase Fresh
------------------------------
When next phase starts (could be next phase in plan, outside the loop):

TadpoleServer.startPhase(nextPhaseId):

  let previousSessionId = null;

  if (this.forceNextPhaseFresh) {
    // Previous phase hit context limit - start fresh
    previousSessionId = null;
    this.forceNextPhaseFresh = false;  // Reset flag
    this.logger.log("Starting with FRESH session (previous exceeded context)");
  } else if (phase.continuationMode === "continue-previous") {
    // Normal continuation
    previousSessionId = this.getPreviousSessionId(nextPhaseId);
  }

  await this.claudeProcessManager.spawn(phase, previousSessionId, logPath);
```

### Key Implementation Details

#### 1. StateManager: New Query Method

```typescript
// In state-manager.ts

/**
 * Checks if context exceeded is an acceptable termination condition
 * for the given phase.
 *
 * Returns true only if:
 * - Phase is part of a loop (has loopContext)
 * - That loop terminates on contextExceeded
 *
 * @param phaseId - The phase to check
 * @returns true if context exceeded is acceptable, false otherwise
 */
isContextExceededAcceptable(phaseId: PhaseId): boolean {
  const run = this.getCurrentRun();
  if (!run) return false;

  const phaseEntry = run.executionPlan.find(p => p.phaseId === phaseId);
  if (!phaseEntry?.loopContext) {
    // Not in a loop - context exceeded is never acceptable
    return false;
  }

  // Find the loop configuration
  const loopId = phaseEntry.loopContext.loopId;
  const loopConfig = this.phases.find(p => p.type === "loop" && p.id === loopId);

  if (!loopConfig || loopConfig.type !== "loop") {
    return false;
  }

  // Check if loop terminates on context exceeded
  return loopConfig.terminateOn.type === "contextExceeded";
}
```

#### 2. StateManager: Modified Loop Expansion

```typescript
// In state-manager.ts

expandNextIterationForPhase(
  phaseId: PhaseId,
  contextExceeded = false  // NEW PARAMETER
): void {
  const run = this.getCurrentRun();
  if (!run) return;

  const plan = run.executionPlan;
  const currentIndex = plan.findIndex(p => p.phaseId === phaseId);
  if (currentIndex === -1) return;

  // Pass contextExceeded flag to planner
  const newPlan = this.planner.expandNextIteration(
    plan,
    currentIndex,
    contextExceeded
  );

  if (newPlan.length > plan.length) {
    this.logger.log(
      `[STATE-MANAGER] Expanded loop - added ${newPlan.length - plan.length} phases`,
      "info"
    );
  } else if (contextExceeded) {
    this.logger.log(
      `[STATE-MANAGER] Loop terminated for ${phaseId} due to context exceeded`,
      "info"
    );
  }

  // Update plan in state
  run.executionPlan = newPlan;
}
```

#### 3. ExecutionPlanner: Modified Expansion Logic

```typescript
// In execution-planner.ts

expandNextIteration(
  currentPlan: ExecutionPhaseEntry[],
  completedIndex: number,
  contextExceeded = false  // NEW PARAMETER
): ExecutionPhaseEntry[] {
  const completedPhase = currentPlan[completedIndex];

  if (!completedPhase.loopContext) {
    return currentPlan;  // Not in a loop
  }

  const { loopId, iteration, phaseIndexInLoop } = completedPhase.loopContext;
  const loopConfig = this.phases.find(p => p.id === loopId && p.type === "loop");

  if (!loopConfig || loopConfig.type !== "loop") {
    return currentPlan;
  }

  // Check if this is the last phase in the current iteration
  const isLastPhaseInIteration =
    phaseIndexInLoop === loopConfig.phases.length - 1;

  if (!isLastPhaseInIteration) {
    return currentPlan;  // Not time to expand yet
  }

  // ============================================================
  // Check context exceeded termination FIRST
  // ============================================================
  if (contextExceeded && loopConfig.terminateOn.type === "contextExceeded") {
    // Loop terminates successfully on context exceeded
    // Do NOT create next iteration
    return currentPlan;
  }

  // ============================================================
  // Check iteration limit termination
  // ============================================================
  if (loopConfig.terminateOn.type === "iterationLimit") {
    const { limit } = loopConfig.terminateOn;

    if (iteration >= limit) {
      // Reached iteration limit - don't expand
      return currentPlan;
    }
  }

  // ============================================================
  // Create next iteration
  // ============================================================
  const nextIteration = iteration + 1;
  const newPhases = loopConfig.phases.map((phase, index) =>
    this.createPhaseEntry(phase, loopId, nextIteration, index)
  );

  // Insert new phases after the completed phase
  return [
    ...currentPlan.slice(0, completedIndex + 1),
    ...newPhases,
    ...currentPlan.slice(completedIndex + 1)
  ];
}
```

#### 4. TadpoleServer: Transient State

```typescript
// In tadpole-server.ts

export class TadpoleServer {
  // Existing fields...

  // NEW: Transient flags for context exceeded handling
  private contextExceededForCurrentPhase = false;
  private forceNextPhaseFresh = false;

  // ... rest of class
}
```

#### 5. TadpoleServer: Detection Block

```typescript
// In tadpole-server.ts, in onLogMessage handler

if (isContextExceeded(msg as ClaudeLogMessage)) {
  this.logger.log(
    `[TADPOLE-SERVER] Context exceeded detected for phase ${phaseId}`,
    "error"
  );

  // Mark that context was exceeded
  this.contextExceededForCurrentPhase = true;

  // Check if this is acceptable
  const acceptable = this.stateManager.isContextExceededAcceptable(
    PhaseId(phaseId)
  );

  // Emit event to notify clients
  this.emit("event", {
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "context.exceeded",
    data: {
      phaseId,
      acceptable,
      message: "Context window exhausted"
    }
  } as ContextExceededEvent);

  // If not acceptable, set failure reason
  if (!acceptable) {
    this.phaseFailureReason = {
      type: "context-exceeded",
      retriable: false,
      message: "Context window exhausted"
    };
  }
}
```

#### 6. TadpoleServer: handlePhaseComplete

```typescript
// In tadpole-server.ts, in handlePhaseComplete()

// After determining initial finalStatus (around line 2375)
if (this.contextExceededForCurrentPhase) {
  const acceptable = this.stateManager.isContextExceededAcceptable(
    PhaseId(phaseId)
  );

  if (acceptable) {
    // Context exceeded is OK - loop terminates successfully
    finalStatus = "completed";
    this.forceNextPhaseFresh = true;
    this.logger.log(
      `[TADPOLE-SERVER] Phase ${phaseId} completed with context exceeded (acceptable)`,
      "info"
    );
  } else {
    // Context exceeded is ERROR
    finalStatus = "failed";
    if (!this.phaseFailureReason) {
      this.phaseFailureReason = {
        type: "context-exceeded",
        retriable: false,
        message: "Context window exhausted"
      };
    }
  }
}

// ... later, when expanding loop ...
if (finalStatus === "completed" || finalStatus === "skipped") {
  this.stateManager.expandNextIterationForPhase(
    phaseId,
    this.contextExceededForCurrentPhase  // Pass the flag
  );
}
```

#### 7. TadpoleServer: cleanupCurrentPhase

```typescript
// In tadpole-server.ts

private cleanupCurrentPhase(): void {
  // ... existing cleanup ...

  // Reset context exceeded tracking
  this.contextExceededForCurrentPhase = false;
  // Note: forceNextPhaseFresh is reset in startPhase after use
}
```

#### 8. TadpoleServer: startPhase

```typescript
// In tadpole-server.ts

private async startPhase(phaseId: PhaseId): Promise<void> {
  // ... existing setup ...

  let previousSessionId: string | null = null;

  // Check if previous phase exceeded context
  if (this.forceNextPhaseFresh) {
    previousSessionId = null;
    this.forceNextPhaseFresh = false;  // Reset after use
    this.logger.log(
      `[TADPOLE-SERVER] Starting ${phaseId} with FRESH session (previous phase exceeded context)`,
      "info"
    );
  } else if (phase.continuationMode === "continue-previous") {
    // Normal continuation logic
    const prevPhaseEntry = this.stateManager.getPreviousPhaseInSequence(phaseId);
    if (prevPhaseEntry?.sessionId && prevPhaseEntry.status === "completed") {
      previousSessionId = prevPhaseEntry.sessionId;
      this.logger.log(
        `[TADPOLE-SERVER] Starting ${phaseId} with continuation from ${prevPhaseEntry.phaseId}`,
        "info"
      );
    }
  }

  // Spawn Claude process
  await this.claudeProcessManager.spawn(phase, previousSessionId, logPath);
}
```

### Event Schema Updates

```typescript
// In server/schemas/event-schemas.ts

// Add to failure reason enum
const failureReasonSchema = z.object({
  type: z.enum([
    "timeout",
    "rate-limit",
    "api-error",
    "chronicler-load-failure",
    "context-exceeded",  // NEW
    "unknown"
  ]),
  retriable: z.boolean(),
  message: z.string().optional(),
  chroniclerRefs: z.array(z.string()).optional(),
});

// New context exceeded event
export const contextExceededEventDataSchema = z.object({
  phaseId: z.string(),
  acceptable: z.boolean(),
  message: z.string(),
});

export const contextExceededEventSchema = baseEventSchema.extend({
  type: z.literal("context.exceeded"),
  data: contextExceededEventDataSchema,
});

export type ContextExceededEvent = z.infer<typeof contextExceededEventSchema>;

// Add to discriminated union
export const serverEventSchema = z.discriminatedUnion("type", [
  // ... existing events ...
  contextExceededEventSchema,
]);
```

### Summary of Changes

| Component | Change | Rationale |
|-----------|--------|-----------|
| StateManager | Add `isContextExceededAcceptable()` | Query method to check if context exceeded is OK for a phase |
| StateManager | Modify `expandNextIterationForPhase()` | Add `contextExceeded` parameter to control expansion |
| ExecutionPlanner | Modify `expandNextIteration()` | Add `contextExceeded` parameter to implement termination |
| TadpoleServer | Add transient flags | Track context exceeded state without polluting persistent state |
| TadpoleServer | Enhance detection block | Emit event, check acceptability, set failure reason |
| TadpoleServer | Modify `handlePhaseComplete()` | Handle context exceeded completion/failure |
| TadpoleServer | Modify `startPhase()` | Force fresh session when previous phase exceeded context |
| TadpoleServer | Modify `cleanupCurrentPhase()` | Reset context exceeded flags |
| Event Schemas | Add `ContextExceededEvent` | New event type for client notification |
| Event Schemas | Add "context-exceeded" failure reason | New failure type for non-loop context exceeded |
| ClaudeProcessManager | **No changes** | Existing API already supports fresh sessions via null |

### Testing Strategy

1. **Unit Tests**
   - `StateManager.isContextExceededAcceptable()` with various loop configs
   - `ExecutionPlanner.expandNextIteration()` with contextExceeded flag
   - Event schema validation

2. **Integration Tests**
   - Full flow through TadpoleServer with mocked Claude process
   - Loop expansion stopping on context exceeded
   - Fresh session startup after context exceeded

3. **E2E Tests** (long-running, manual)
   - Real Claude process hitting context limits
   - Multi-iteration loop termination
   - Verify costs, events, and state consistency

### Advantages of This Design

1. **Simplicity**: No new state transition types, no complex state tracking
2. **Clarity**: Transient flags make temporary behavior explicit
3. **Reusability**: Existing APIs (ClaudeProcessManager, ExecutionPlanner) unchanged
4. **Testability**: Pure query methods easy to unit test
5. **Debuggability**: Extensive logging at every decision point
6. **Type Safety**: All type checks remain intact, no loosening needed

### Open Questions

1. **Should we log loop context in the "context.exceeded" event?**
   - Could add `loopIteration` and `loopId` to event data
   - Useful for debugging, but not critical

2. **Should we track context exceeded count per loop?**
   - Could be useful for analytics
   - Not needed for MVP

3. **How to handle context exceeded in chroniclers?**
   - Out of scope for this design
   - Handle in future work if needed
