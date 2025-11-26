# Context Exceeded Handling Implementation Plan

## Executive Summary

This document provides a comprehensive implementation plan for handling "context exceeded" events in Tadpole's looping phases system. The goal is to gracefully handle context window exhaustion by allowing loops to terminate successfully when configured with `terminateOn: { type: "contextExceeded" }`, while treating context exceeded as an error in all other cases.

## Current State Analysis

### What's Already Implemented

1. **Context Exceeded Detection** (`server/types/types.ts`)
   - `isContextExceeded()` function detects two patterns:
     - Pattern 1: Synthetic terminated messages from Claude (`model: "<synthetic>"`)
     - Pattern 2: Output token maximum exceeded in result messages
   - Comprehensive test coverage in `tests/unit/context-exceeded-detection.test.ts`

2. **Loop Infrastructure**
   - `LoopTermination` type supports `{ type: "contextExceeded" }` (line 193-195 in types.ts)
   - `ExecutionPlanner` handles loop expansion with lazy iteration creation
   - `ExecutionPlanner.shouldContinueLoop()` always returns true for contextExceeded (lines 118-122)
   - Test configuration exists (`tests/config/test-context-exhaustion.config.json`)

3. **Detection Point** (`server/tadpole-server.ts`)
   - Context exceeded detected at line 1923-1929
   - Currently only logs the event - no handling implemented
   - Detection happens during log message processing

### What's Missing

1. **State Manager Integration**
   - No mechanism to notify state manager of context exceeded events
   - No logic to check if current phase is in a loop with contextExceeded termination
   - No way to mark loop as successfully completed vs error

2. **Loop Termination Logic**
   - No code to stop loop expansion when context exceeded
   - No differentiation between "loop complete" vs "loop should continue"
   - No way to prevent next iteration from being created

3. **Fresh Session Management**
   - No mechanism to start next phase with a fresh session after context exhaustion
   - Current continuationMode is per-phase config, not dynamically controlled

4. **Event Emission**
   - No specific event type for context exceeded
   - Clients have no way to be notified about this condition

5. **Testing**
   - No unit/integration tests for state manager context exceeded handling
   - E2E test configuration exists but not integrated with test suite

## Architecture Design

### Core Design Principles

1. **Separation of Concerns**
   - Detection stays in TadpoleServer (log parsing layer)
   - Decision logic goes in StateManager (business logic layer)
   - Loop logic stays in ExecutionPlanner (planning layer)

2. **Explicit State Tracking**
   - Context exceeded should be explicitly tracked in phase state
   - Loop completion reason should be distinguishable (iteration limit vs context exceeded)

3. **Fail-Safe Defaults**
   - Context exceeded is an ERROR by default
   - Only treated as success when explicitly configured in loop termination

### High-Level Flow

```
1. Claude Process → Context Exceeded
2. TadpoleServer detects via isContextExceeded()
3. TadpoleServer checks with StateManager: "Is this acceptable?"
4. StateManager consults ExecutionPlanner/Plan
   a. If in loop with terminateOn=contextExceeded → Mark as success, stop loop
   b. Otherwise → Mark as error
5. If success path:
   - Transition phase to "completed"
   - Do NOT expand next loop iteration
   - Start next phase (outside loop) with FRESH session
6. If error path:
   - Transition phase to "failed"
   - Set failureReason with contextExceeded info
```

### Key Components

#### 1. State Manager Changes

**New Method: `isContextExceededAcceptable(phaseId: PhaseId): boolean`**
- Checks if current phase is part of a loop
- Checks if that loop has `terminateOn.type === "contextExceeded"`
- Returns true only if both conditions met

**Enhanced Method: `expandNextIterationForPhase()`**
- Add guard to check if phase ended due to context exceeded
- Skip expansion if loop terminated due to context exhaustion
- This prevents infinite loop expansion

**New State Tracking:**
- Add optional `contextExceeded?: boolean` flag to PhaseExecution
- Indicates whether phase ended due to context exhaustion
- Used to determine if loop should stop expanding

#### 2. TadpoleServer Changes

**Enhanced Context Exceeded Detection Block** (line 1923-1929)

```typescript
if (isContextExceeded(msg as ClaudeLogMessage)) {
  this.logger.log(
    `[TADPOLE-SERVER] Context exceeded error detected for phase ${phaseId}`,
    "error",
  );

  // Mark that context was exceeded for this phase
  this.contextExceededForCurrentPhase = true;

  // Emit event to notify clients
  this.emit("event", {
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "context.exceeded",
    data: {
      phaseId: phaseId,
      acceptable: this.stateManager.isContextExceededAcceptable(PhaseId(phaseId)),
      message: "Context window exhausted",
    },
  } as ContextExceededEvent);

  // Check if this is acceptable based on loop configuration
  const acceptable = this.stateManager.isContextExceededAcceptable(PhaseId(phaseId));

  if (!acceptable) {
    // Set failure reason for handlePhaseComplete
    this.phaseFailureReason = {
      type: "context-exceeded",
      retriable: false,
      message: "Context window exhausted",
    };
  }
}
```

**Enhanced `handlePhaseComplete()` Method**

Add logic before/after chronicler completion to handle context exceeded:

```typescript
// After determining finalStatus (around line 2375)
// Check if we need to force a fresh session for next phase
let forceNextPhaseFresh = false;

if (this.contextExceededForCurrentPhase) {
  const acceptable = this.stateManager.isContextExceededAcceptable(PhaseId(phaseId));

  if (acceptable) {
    // Context exceeded is acceptable - treat as successful completion
    finalStatus = "completed";
    forceNextPhaseFresh = true; // Next phase MUST start fresh

    // Mark in state that this phase ended due to context exceeded
    // This will prevent loop expansion
    this.contextExceededMarker = true;
  } else {
    // Context exceeded is NOT acceptable - treat as failure
    finalStatus = "failed";
    if (!this.phaseFailureReason) {
      this.phaseFailureReason = {
        type: "context-exceeded",
        retriable: false,
        message: "Context window exhausted",
      };
    }
  }
}
```

**New Instance Variables:**
- `contextExceededForCurrentPhase: boolean` - Tracks if current phase hit context limit
- `contextExceededMarker: boolean` - Used to prevent loop expansion

**Enhanced `cleanupCurrentPhase()` Method:**
- Reset `contextExceededForCurrentPhase` flag
- Reset `contextExceededMarker` flag

#### 3. ExecutionPlanner Changes

**Enhanced `expandNextIteration()` Method**

Add parameter to indicate if phase ended due to context exceeded:

```typescript
expandNextIteration(
  currentPlan: ExecutionPhaseEntry[],
  completedIndex: number,
  contextExceeded?: boolean, // NEW PARAMETER
): ExecutionPhaseEntry[]
```

Logic changes:
```typescript
if (isLastPhaseInIteration) {
  // Check for context exceeded termination BEFORE iteration limit
  if (contextExceeded && loopConfig.terminateOn.type === "contextExceeded") {
    // Loop terminated successfully due to context exhaustion
    // Do NOT expand next iteration
    return currentPlan;
  }

  // Evaluate other termination conditions
  if (this.shouldContinueLoop(loopConfig, iteration)) {
    // Create next iteration...
  }
}
```

#### 4. Fresh Session Management

**Approach 1: Override in startPhase() (RECOMMENDED)**

Modify `TadpoleServer.startPhase()` to check if previous phase ended with context exceeded:

```typescript
private async startPhase(phaseId: PhaseId): Promise<void> {
  // ... existing code ...

  // Determine previousSessionId
  let previousSessionId: string | null = null;

  // Check if we should force fresh session due to context exceeded
  if (this.forceNextPhaseFresh) {
    previousSessionId = null;
    this.forceNextPhaseFresh = false;
    this.logger.log(
      `Starting phase ${phaseId} with FRESH session (previous phase exceeded context)`,
    );
  } else if (phase.continuationMode === "continue-previous") {
    // ... existing continuation logic ...
  }

  // ... rest of startPhase ...
}
```

**Approach 2: Dynamic ContinuationMode (Alternative)**

Add temporary state override:
```typescript
private continuationModeOverride: Map<PhaseId, "fresh" | "continue-previous"> = new Map();
```

Set in `handlePhaseComplete()` when context exceeded acceptably:
```typescript
// Get next phase ID and override its continuation mode
const nextPhaseId = await this.stateManager.getNextPhaseToExecute();
if (nextPhaseId) {
  this.continuationModeOverride.set(nextPhaseId, "fresh");
}
```

Check in `startPhase()`:
```typescript
const effectiveContinuationMode =
  this.continuationModeOverride.get(phaseId) || phase.continuationMode;
```

**Recommendation:** Use Approach 1 (simpler, more explicit)

#### 5. Event Schema Addition

**New Event Type: `context.exceeded`**

Add to `server/schemas/event-schemas.ts`:

```typescript
export const contextExceededEventDataSchema = z.object({
  phaseId: z.string(),
  acceptable: z.boolean(), // true if in loop with contextExceeded termination
  message: z.string(),
});

export const contextExceededEventSchema = baseEventSchema.extend({
  type: z.literal("context.exceeded"),
  data: contextExceededEventDataSchema,
});

export type ContextExceededEvent = z.infer<typeof contextExceededEventSchema>;
```

Add to discriminated union in `serverEventSchema`:
```typescript
export const serverEventSchema = z.discriminatedUnion("type", [
  // ... existing events ...
  contextExceededEventSchema,
]);
```

#### 6. Failure Reason Type Addition

Update `failureReasonSchema` in `event-schemas.ts`:

```typescript
const failureReasonSchema = z.object({
  type: z.enum([
    "timeout",
    "rate-limit",
    "api-error",
    "chronicler-load-failure",
    "context-exceeded", // NEW
    "unknown"
  ]),
  retriable: z.boolean(),
  message: z.string().optional(),
  chroniclerRefs: z.array(z.string()).optional(),
});
```

## Implementation Steps

### Phase 1: State Manager Foundation (1-2 hours)

**Files to modify:**
- `server/state-manager.ts`
- `server/execution-planner.ts`

**Tasks:**

1. Add `isContextExceededAcceptable(phaseId: PhaseId): boolean` to StateManager
   - Get phase entry from execution plan
   - Check if phase has loopContext
   - Get loop config from phaseConfigs
   - Return true only if loop.terminateOn.type === "contextExceeded"

2. Update ExecutionPlanner.expandNextIteration()
   - Add optional `contextExceeded?: boolean` parameter
   - Add early return if contextExceeded && loop terminates on contextExceeded
   - Preserve existing iteration limit logic

3. Write unit tests for StateManager
   - Test `isContextExceededAcceptable()` with various configs:
     - Phase in loop with contextExceeded termination → true
     - Phase in loop with iterationLimit termination → false
     - Phase not in loop → false
     - Phase ID not found → false

4. Write unit tests for ExecutionPlanner
   - Test `expandNextIteration()` with contextExceeded flag:
     - contextExceeded=true, terminateOn=contextExceeded → no expansion
     - contextExceeded=true, terminateOn=iterationLimit → expansion continues
     - contextExceeded=false → normal behavior

### Phase 2: Event Schema Updates (30 minutes)

**Files to modify:**
- `server/schemas/event-schemas.ts`
- `server/types/types.ts`

**Tasks:**

1. Add `context.exceeded` event schema
2. Add `"context-exceeded"` to failure reason enum
3. Export new types
4. Verify schema compilation with `bun tc`

### Phase 3: TadpoleServer Integration (2-3 hours)

**Files to modify:**
- `server/tadpole-server.ts`

**Tasks:**

1. Add instance variables:
   ```typescript
   private contextExceededForCurrentPhase = false;
   private forceNextPhaseFresh = false;
   ```

2. Enhance context exceeded detection block (line ~1923):
   - Set `contextExceededForCurrentPhase = true`
   - Emit `context.exceeded` event
   - Check acceptability and set failure reason if not acceptable

3. Enhance `handlePhaseComplete()` method:
   - After determining finalStatus, check `contextExceededForCurrentPhase`
   - If acceptable: set finalStatus="completed", forceNextPhaseFresh=true
   - If not acceptable: set finalStatus="failed"
   - Pass context exceeded info to expandNextIterationForPhase call

4. Enhance `startPhase()` method:
   - Check `forceNextPhaseFresh` before determining previousSessionId
   - Log when forcing fresh session due to context exceeded
   - Reset flag after use

5. Update `cleanupCurrentPhase()`:
   - Reset `contextExceededForCurrentPhase`
   - Reset `forceNextPhaseFresh`

6. Update StateManager.expandNextIterationForPhase() call:
   ```typescript
   // In handlePhaseComplete, around line 2534
   if (finalStatus === "completed" || finalStatus === "skipped") {
     const contextExceeded = this.contextExceededForCurrentPhase &&
       this.stateManager.isContextExceededAcceptable(PhaseId(phaseId));
     this.stateManager.expandNextIterationForPhase(
       phaseId,
       contextExceeded
     );
   }
   ```

### Phase 4: StateManager expandNextIteration Update (1 hour)

**Files to modify:**
- `server/state-manager.ts`

**Tasks:**

1. Update `expandNextIterationForPhase()` signature:
   ```typescript
   expandNextIterationForPhase(
     phaseId: PhaseId,
     contextExceeded = false
   ): void
   ```

2. Pass contextExceeded flag to planner:
   ```typescript
   const newPlan = this.planner.expandNextIteration(
     plan,
     currentIndex,
     contextExceeded
   );
   ```

3. Add logging for context exceeded loop termination:
   ```typescript
   if (contextExceeded && newPlan.length === plan.length) {
     this.logger.log(
       `Loop terminated for phase ${phaseId} due to context exceeded`,
       "info"
     );
   }
   ```

### Phase 5: Testing - Unit & Integration (2-3 hours)

**Files to create/modify:**
- `tests/unit/state-manager-context-exceeded.test.ts` (NEW)
- `tests/unit/execution-planner.test.ts` (MODIFY)
- `tests/integration/context-exceeded-loop.test.ts` (NEW)

**Unit Tests for State Manager:**

```typescript
describe("StateManager - Context Exceeded Handling", () => {
  test("isContextExceededAcceptable returns true for loop with contextExceeded termination", () => {
    // Setup state manager with loop config
    // Call isContextExceededAcceptable for phase in loop
    // Assert true
  });

  test("isContextExceededAcceptable returns false for loop with iterationLimit", () => {
    // Setup with different termination
    // Assert false
  });

  test("isContextExceededAcceptable returns false for standalone phase", () => {
    // Setup with non-loop phase
    // Assert false
  });

  test("expandNextIterationForPhase stops expansion when contextExceeded=true", () => {
    // Setup state with loop
    // Call expandNextIterationForPhase with contextExceeded=true
    // Assert plan length unchanged
  });

  test("expandNextIterationForPhase continues expansion when contextExceeded=false", () => {
    // Setup state with loop (iteration limit not reached)
    // Call expandNextIterationForPhase with contextExceeded=false
    // Assert plan expanded
  });
});
```

**Unit Tests for ExecutionPlanner:**

Add to existing `tests/unit/execution-planner.test.ts`:

```typescript
describe("ExecutionPlanner - Context Exceeded", () => {
  test("expandNextIteration stops when contextExceeded=true and terminateOn=contextExceeded", () => {
    const planner = new ExecutionPlanner([loopWithContextExceededTermination]);
    const plan = planner.buildInitialPlan();
    const newPlan = planner.expandNextIteration(plan, lastPhaseIndex, true);
    expect(newPlan.length).toBe(plan.length);
  });

  test("expandNextIteration continues when contextExceeded=true but terminateOn=iterationLimit", () => {
    const planner = new ExecutionPlanner([loopWithIterationLimit]);
    const plan = planner.buildInitialPlan();
    const newPlan = planner.expandNextIteration(plan, lastPhaseIndex, true);
    expect(newPlan.length).toBeGreaterThan(plan.length);
  });
});
```

**Integration Test (Mocked):**

Create `tests/integration/context-exceeded-loop.test.ts`:

```typescript
describe("Context Exceeded Loop - Integration", () => {
  test("loop completes successfully when context exceeded with proper termination", async () => {
    // Create mock TadpoleServer with context exceeded loop config
    // Simulate phase execution
    // Inject context exceeded message
    // Assert:
    //   - Phase marked as completed
    //   - Loop expansion stopped
    //   - Next phase (outside loop) starts with fresh session
    //   - Context exceeded event emitted with acceptable=true
  });

  test("phase fails when context exceeded outside configured loop", async () => {
    // Create mock with non-context-exceeded loop
    // Inject context exceeded message
    // Assert:
    //   - Phase marked as failed
    //   - Failure reason is context-exceeded
    //   - Context exceeded event emitted with acceptable=false
  });
});
```

### Phase 6: E2E Testing (3-4 hours)

**Files to create/modify:**
- `tests/e2e/context-exceeded-loop.test.ts` (NEW - in tests/long-running)

**E2E Test Strategy:**

Since this will be expensive and long-running:

1. Create test in `tests/long-running/` directory (not run by default)
2. Use existing `test-context-exhaustion.config.json` or create simpler version
3. Test configuration:
   - Phase 1: Generate moderate content (10k words)
   - Loop (terminateOn: contextExceeded):
     - Phase A: Continue previous, read all + generate 15k words
     - Phase B: Continue previous, analyze all (should hit context limit by iteration 2-3)
   - Phase 2: Fresh session, simple summary

**E2E Test Implementation:**

```typescript
describe("Context Exceeded E2E", () => {
  test.skip("loop terminates gracefully on context exceeded", async () => {
    // Start Tadpole server with context exhaustion config
    // Run until completion (with timeout of 10 minutes)
    // Assert:
    //   - Loop phases completed at least once
    //   - Loop terminated due to context exceeded
    //   - Final phase (outside loop) executed with fresh session
    //   - No fatal errors
    //   - Context exceeded event was emitted
  }, 600000); // 10 minute timeout
});
```

This test should be:
- Marked as `.skip` by default
- Run manually or in CI separately from main test suite
- Have generous timeout
- Include detailed logging

### Phase 7: Documentation & Review (1 hour)

**Files to create/modify:**
- `docs/context-exceeded.md` (NEW)
- `README.md` (UPDATE with link to docs)

**Documentation Content:**

1. Overview of context exceeded handling
2. How to configure loops with contextExceeded termination
3. What happens when context is exceeded
4. Event types emitted
5. Testing considerations
6. Troubleshooting guide

## Testing Strategy Summary

### Unit Tests (Fast, Run Always)
- **Target:** 10-15 tests
- **Duration:** < 1 second
- **Coverage:**
  - StateManager.isContextExceededAcceptable()
  - ExecutionPlanner.expandNextIteration() with contextExceeded flag
  - Failure reason type validation
  - Event schema validation

### Integration Tests (Moderate, Run Always)
- **Target:** 3-5 tests
- **Duration:** < 10 seconds
- **Coverage:**
  - End-to-end flow through TadpoleServer (mocked Claude process)
  - State transitions for context exceeded scenarios
  - Event emission verification
  - Fresh session startup after context exceeded

### E2E Tests (Expensive, Run Manually/CI Separate)
- **Target:** 1-2 tests
- **Duration:** 5-10 minutes
- **Coverage:**
  - Real Claude process hitting context limits
  - Multi-iteration loop termination
  - Fresh session continuation
  - Cost tracking accuracy

**Run Strategy:**
```bash
# Fast tests (during development)
bun test

# Integration tests with specific tags
bun test --grep "integration"

# E2E tests (manual or CI)
bun test tests/long-running/context-exceeded-loop.test.ts
```

## Risk Analysis & Mitigation

### Risk 1: Incorrect Loop Termination Detection
**Impact:** High - Could cause infinite loops or premature termination
**Mitigation:**
- Comprehensive unit tests for `isContextExceededAcceptable()`
- Add defensive logging at every decision point
- Add plan validation after loop termination

### Risk 2: Session Continuation Issues
**Impact:** High - Fresh session might not start properly
**Mitigation:**
- Test both fresh and continuation modes thoroughly
- Add explicit logging when forcing fresh session
- Verify previousSessionId is null when starting fresh

### Risk 3: Race Conditions in State Transitions
**Impact:** Medium - State might be inconsistent during context exceeded handling
**Mitigation:**
- Use existing `waitForPendingTransitions()` where needed
- Maintain existing transition queue system
- Add logging to track transition timing

### Risk 4: Cost Tracking Accuracy
**Impact:** Medium - Costs might not be properly attributed
**Mitigation:**
- Use existing cost tracking infrastructure
- Ensure phase completion follows normal path
- Test cost accumulation in integration tests

### Risk 5: E2E Test Flakiness
**Impact:** Low - Test might not consistently hit context limit
**Mitigation:**
- Design test to aggressively accumulate context
- Add generous timeouts
- Make test skippable by default
- Document expected behavior

## Open Questions & Decisions Needed

### Q1: Should we add context exceeded info to phase state?
**Options:**
- A) Add `contextExceeded?: boolean` to PhaseExecution types
- B) Only track in failure reason
- C) Add to loop metadata

**Recommendation:** Option A - Makes state more explicit, helps with debugging

### Q2: How to handle context exceeded in chroniclers?
**Scope:** This plan assumes chroniclers won't hit context limits independently
**Decision:** Handle in future work if needed

### Q3: Should we emit event before or after acceptability check?
**Options:**
- A) Emit immediately upon detection (current plan)
- B) Emit only after determining acceptability
- C) Emit twice (detection + resolution)

**Recommendation:** Option A - Clients can see raw detection, acceptability included in event data

### Q4: Should next phase override be persistent?
**Current Plan:** Use transient flag `forceNextPhaseFresh`
**Alternative:** Store in state or execution plan

**Recommendation:** Keep transient - simpler, doesn't pollute state

## Success Criteria

Implementation is complete when:

1. ✅ Unit tests pass for StateManager.isContextExceededAcceptable()
2. ✅ Unit tests pass for ExecutionPlanner with contextExceeded flag
3. ✅ Integration tests pass for full context exceeded flow
4. ✅ Event schema compiles and validates
5. ✅ Manual E2E test successfully terminates loop on context exceeded
6. ✅ Fresh session starts correctly after context exceeded loop
7. ✅ No regressions in existing loop tests
8. ✅ `bun lint:fix` passes with no new issues
9. ✅ `bun tc` passes with no type errors
10. ✅ Documentation is complete and clear

## Estimated Timeline

- **Phase 1 (State Manager):** 1-2 hours
- **Phase 2 (Event Schema):** 30 minutes
- **Phase 3 (TadpoleServer):** 2-3 hours
- **Phase 4 (StateManager Update):** 1 hour
- **Phase 5 (Unit/Integration Tests):** 2-3 hours
- **Phase 6 (E2E Tests):** 3-4 hours
- **Phase 7 (Documentation):** 1 hour

**Total Estimated Time:** 11-15 hours

## Implementation Notes

### Code Style Guidelines
- Follow existing patterns in StateManager and TadpoleServer
- Use fire-and-forget for state transitions (existing pattern)
- Add comprehensive logging at debug level for decision points
- Keep methods focused and single-responsibility

### Testing Guidelines
- Keep unit tests fast (<100ms each)
- Mock external dependencies in integration tests
- Use descriptive test names that explain the scenario
- Include both positive and negative test cases

### Documentation Guidelines
- Include code examples for loop configuration
- Document event payload structure
- Provide troubleshooting steps
- Link to related documentation

## Appendix A: File Change Summary

### Modified Files
1. `server/state-manager.ts`
   - Add `isContextExceededAcceptable()` method
   - Update `expandNextIterationForPhase()` signature
   - Add logging for context exceeded termination

2. `server/execution-planner.ts`
   - Update `expandNextIteration()` with contextExceeded parameter
   - Add early return for context exceeded loop termination

3. `server/tadpole-server.ts`
   - Add instance variables for context exceeded tracking
   - Enhance context exceeded detection block
   - Update `handlePhaseComplete()` with context exceeded logic
   - Update `startPhase()` with fresh session forcing
   - Update `cleanupCurrentPhase()` to reset flags

4. `server/schemas/event-schemas.ts`
   - Add `ContextExceededEvent` schema
   - Add "context-exceeded" to failure reason enum

### New Files
1. `tests/unit/state-manager-context-exceeded.test.ts`
2. `tests/integration/context-exceeded-loop.test.ts`
3. `tests/long-running/context-exceeded-loop.test.ts`
4. `docs/context-exceeded.md`

### Updated Files
1. `tests/unit/execution-planner.test.ts` (add new tests)
2. `README.md` (add link to docs)

## Appendix B: Key Code Locations

### Detection
- `isContextExceeded()`: `server/types/types.ts` (implementation exists)
- Detection point: `server/tadpole-server.ts:1923-1929`

### Loop Logic
- `LoopTermination` type: `server/types/types.ts:193-195`
- `ExecutionPlanner`: `server/execution-planner.ts`
- Loop expansion: `server/state-manager.ts:184-202`

### Phase Completion
- `handlePhaseComplete()`: `server/tadpole-server.ts:2256-2535`
- Phase transition: `server/state-manager.ts:205-257`

### Session Management
- `startPhase()`: `server/tadpole-server.ts` (search for "private async startPhase")
- `ClaudeProcessManager.spawn()`: `server/claude-process-manager.ts:37-129`

## Appendix C: Test Data Structures

### Sample Loop Config (Context Exceeded)
```json
{
  "type": "loop",
  "id": "content-loop",
  "terminateOn": { "type": "contextExceeded" },
  "phases": [
    {
      "id": "generate",
      "continuationMode": "continue-previous",
      "promptText": "Generate 20k words..."
    }
  ]
}
```

### Sample Loop Config (Iteration Limit)
```json
{
  "type": "loop",
  "id": "review-loop",
  "terminateOn": { "type": "iterationLimit", "limit": 3 },
  "phases": [
    {
      "id": "review",
      "continuationMode": "continue-previous",
      "promptText": "Review code..."
    }
  ]
}
```

### Expected Event Payload
```typescript
{
  type: "context.exceeded",
  data: {
    phaseId: "generate#2",
    acceptable: true,
    message: "Context window exhausted"
  }
}
```
