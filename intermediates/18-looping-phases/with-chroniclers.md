# Looping Phases Design Adjustments for Chroniclers Integration

## Executive Summary

This document analyzes the upcoming chroniclers integration (as specified in `intermediates/16-chroniclers/13-integration/3-execution-spec-final.md`) and identifies necessary adjustments to the looping phases design to ensure compatibility and avoid conflicts.

**Key Finding**: The two features are largely **orthogonal** and can coexist with **minimal adjustments**. The primary integration points are:
1. Schema coordination for `PhaseConfig` extensions
2. Loop flattening implications for chronicler lifecycle
3. State machine coordination for new phase statuses
4. Cost tracking aggregation across loop iterations

---

## 1. Schema & Configuration Overlap

### 1.1 Current Situation

Both features extend `PhaseConfig`:

**Chroniclers Integration** (from execution-spec-final.md):
```typescript
export interface PhaseConfig {
  // ... existing fields ...

  /**
   * Chroniclers to run during this phase.
   */
  chroniclers?: PhaseChroniclerEntry[];
}
```

**Looping Phases** (from plan.md):
```typescript
// Option A: Discriminated union approach
export type PhaseConfig = SinglePhaseConfig | LoopPhaseConfig;

interface SinglePhaseConfig {
  type?: "phase";
  // ... existing fields + chroniclers ...
}

interface LoopPhaseConfig {
  type: "loop";
  id: PhaseId;
  terminateOn: LoopTermination;
  phases: PhaseConfig[];  // Recursive
}
```

### 1.2 Integration Strategy

**DECISION**: Use the discriminated union approach from `plan.md` with chroniclers support in `SinglePhaseConfig`.

**Rationale**:
- The discriminated union is cleaner and already planned
- Loop blocks themselves don't execute (only their nested phases), so `chroniclers` belongs on `SinglePhaseConfig` only
- Chroniclers can be specified per iteration-phase, giving maximum flexibility

**Updated Schema**:
```typescript
// server/types/types.ts

export type LoopTermination =
  | { type: "iterationLimit"; limit: number }
  | { type: "contextExceeded" };

// Single phase - gets chroniclers field
export interface SinglePhaseConfig {
  type?: "phase";
  id: PhaseId;
  name: string;
  promptFile?: string | string[];
  promptText?: string;
  appendSystemPromptFile?: string | string[];
  appendSystemPromptText?: string;
  model: ModelName;
  continuationMode: ContinuationMode;
  workspaceSetup?: WorkspaceSetupItem[];
  description?: string;
  trackedFiles?: string[];
  env?: Record<string, string>;
  outputFiles?: /* ... */;

  // NEW: Chroniclers integration
  chroniclers?: PhaseChroniclerEntry[];
}

// Loop phase - NO chroniclers field
export interface LoopPhaseConfig {
  type: "loop";
  id: PhaseId;
  name: string;
  description?: string;
  terminateOn: LoopTermination;
  phases: PhaseConfig[];  // Recursive - allows nested loops
}

export type PhaseConfig = SinglePhaseConfig | LoopPhaseConfig;
```

**Zod Schema**:
```typescript
// server/config.ts

const singlePhaseSchema = z.object({
  type: z.literal("phase").optional().default("phase"),
  id: z.string().min(1),
  name: z.string().min(1),
  // ... existing fields ...

  // NEW: Add chroniclers validation
  chroniclers: z.array(phaseChroniclerEntrySchema).optional(),
}).strict().refine(/* ... */);

const loopPhaseSchema = z.object({
  type: z.literal("loop"),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  terminateOn: loopTerminationSchema,
  phases: z.lazy(() => z.array(phaseConfigSchema).min(1)),
}).strict();

const phaseConfigSchema = z.discriminatedUnion("type", [
  singlePhaseSchema,
  loopPhaseSchema,
]);
```

### 1.3 Configuration Loading Coordination

**Impact**: The chroniclers integration adds validation in `server/config.ts` for the `chroniclers` field. With loop flattening, this validation operates on the **flattened** phase array.

**From execution-spec-final.md Section 1.3**:
```typescript
// Validate chroniclers field
for (const phase of phases) {
  if (phase.chroniclers) {
    // Validation logic...
  }
}
```

**Adjustment**: This validation loop operates on the **flattened** phase array after loop preprocessing. Each iteration-phase is validated independently (e.g., `review#1`, `review#2`, `review#3` are separate phases).

---

## 2. Loop Flattening and Chronicler Lifecycle

### 2.1 Loop Flattening Approach

**Decision**: Loops are flattened during config loading into a flat `PhaseConfig[]` array.

**Example**:
- Config: Loop with `id: "review"`, 3 iterations, containing phases `review` and `refine`
- Runtime sees: `spec`, `review#1`, `refine#1`, `review#2`, `refine#2`, `review#3`, `refine#3`, `finalize`
- Each iteration-phase is a separate phase with a unique ID

### 2.2 Chronicler Implications

**From execution-spec-final.md Section 4.2**:
> ChroniclerManager internally unloads previous phase's chroniclers

**Key Insight**: Chroniclers are loaded **per phase** and unloaded when a new phase starts.

**Benefits of Flattening for Chroniclers**:
- ✅ Each iteration-phase (`review#1`, `review#2`, `review#3`) is a separate phase
- ✅ Chroniclers are naturally loaded/unloaded per iteration
- ✅ Each iteration can have different chronicler configs (via templating or per-iteration config)
- ✅ No changes needed to ChroniclerManager
- ✅ Cost tracking remains per-phase-ID as designed
- ⚠️ Chronicler config referenced from shared file (cache hits on iterations 2+)
- ⚠️ Cost tracking must aggregate across iteration-phases in UI layer

### 2.3 Chronicler Config Patterns for Flattened Loops

**Pattern 1: Shared chronicler config file**
```json
{
  "type": "loop",
  "id": "review-loop",
  "iterations": 3,
  "phases": [
    {
      "id": "review",
      "name": "Review Code",
      "model": "sonnet",
      "chroniclers": [
        {
          "chroniclerConfig": "./chroniclers/narrator.json"
        }
      ]
    }
  ]
}
```
Result after flattening:
- `review#1` has narrator chronicler (loads `./chroniclers/narrator.json`)
- `review#2` has narrator chronicler (cache hit! Same file)
- `review#3` has narrator chronicler (cache hit! Same file)

**Pattern 2: Iteration-specific output paths**
```json
{
  "chroniclerConfig": "./chroniclers/narrator.json",
  "settings": {
    "outputPaths": {
      "logFile": "review-${iteration}.md"
    }
  }
}
```

**MISSING FEATURE**: Template variable substitution for `outputPaths`.

**RECOMMENDATION**: Add template support to ChroniclerConfigLoader for iteration-aware output paths.

**Implementation**:
```typescript
// In TadpoleServer.loadChroniclersForPhase()
// Extract iteration number from phase ID (e.g., "review#2" → 2)
const iterationMatch = phase.id.match(/#(\d+)$/);
const iteration = iterationMatch ? parseInt(iterationMatch[1], 10) : undefined;

// Pass to ChroniclerManager for template substitution
const outputPathsMap = new Map(
  loadResult.configs
    .filter((lc) => lc.outputPaths)
    .map((lc) => {
      const paths = lc.outputPaths!;
      const substitutedPaths = iteration ? {
        logFile: paths.logFile?.replace('${iteration}', iteration.toString()),
        lastValueFile: paths.lastValueFile?.replace('${iteration}', iteration.toString()),
      } : paths;
      return [lc.config.id, substitutedPaths];
    })
);
```

---

## 3. State Machine Coordination

### 3.1 New Phase Status: `completing-chroniclers`

**From execution-spec-final.md Section 6.1**:
```
running → completing-chroniclers → completed/failed/skipped
```

**Looping Phases Impact**: Each flattened iteration-phase will go through this state independently.

**No Conflict**: The state machine addition is orthogonal to looping. Whether a phase is `review#1` or `review#3`, it still transitions through the same states.

**Validation**: Ensure state transition guards allow:
```typescript
running → completing-chroniclers → completed → [next iteration phase starts → preparing → starting → ...]
```

### 3.2 Loop Termination and Chronicler Completion

**Question**: What happens if a loop terminates while chroniclers are completing work?

**Scenarios**:
1. **Normal loop completion**: Final iteration completes → `completing-chroniclers` → `completed` → next phase (or run ends)
2. **Context exceeded termination**: Mid-loop, context limit hit → current phase completes → loop terminates

**RECOMMENDATION**: Always wait for `completing-chroniclers` to finish before evaluating loop termination conditions.

**Implementation Note**: Loop termination logic should check status **after** `completing-chroniclers` state completes:

```typescript
// Pseudo-code for loop termination check
async function handlePhaseComplete(phaseId: PhaseId) {
  // ... existing logic ...

  // Transition to completing-chroniclers
  await transitionToCompletingChroniclers();

  // Complete chronicler work
  await chroniclerManager.completeAllWork();

  // NOW check loop termination
  if (isLoopPhase(phaseId)) {
    const shouldContinue = evaluateLoopTermination(phaseId);
    if (shouldContinue) {
      startNextIteration();
    } else {
      completeLoop();
    }
  }
}
```

---

## 4. Cost Tracking Across Loop Iterations

### 4.1 Current Chronicler Cost Tracking

**From execution-spec-final.md Section 7.2**:
```typescript
public getChroniclerCosts(): Map<string, number> {
  const costs = new Map<string, number>();
  for (const chronicler of this.chroniclers) {
    costs.set(chronicler.getId(), chronicler.getTotalCost());
  }
  return costs;
}
```

**Limitation**: Returns costs for **currently loaded chroniclers only**. When a new phase loads, previous chroniclers are unloaded and their costs are lost.

### 4.2 Looping Implications

**Challenge**: With flattening, each iteration is a separate phase with unique ID. Costs must be tracked across multiple phase IDs:
- `review#1`: narrator cost = $0.50
- `review#2`: narrator cost = $0.30 (new instance, separate tracking)
- `review#3`: narrator cost = $0.20

Total cost for "review loop" = $1.00, but current system loses `review#1` and `review#2` costs when `review#3` loads.

**RECOMMENDATION**: Enhance cost tracking in one of two ways:

**Option 1: Per-phase cost accumulation (minimal change)**
```typescript
// In TadpoleServer.handlePhaseComplete()
private async handlePhaseComplete(exitCode: number): Promise<void> {
  // ... existing logic ...

  // Get chronicler costs BEFORE completing phase
  let chroniclerCostMap: Record<string, number> = {};
  if (this.chroniclerManager && this.currentPhaseChroniclers.size > 0) {
    const costs = this.chroniclerManager.getChroniclerCosts();
    for (const [id, cost] of costs) {
      chroniclerCostMap[id] = cost;
    }
  }

  // Store in phase completion metadata
  this.stateManager.transition({
    type: "PhaseTransitioned",
    data: {
      runId: this.currentRunId!,
      phaseId: currentPhase.phaseId,
      from: currentPhase.status,
      to: "completed",
      metadata: {
        chroniclerCosts: chroniclerCostMap,  // NEW: Store per-phase
      },
    },
  });
}
```

Then aggregate costs per loop in UI/reporting layer.

**DECISION**: Use **Option 1** (per-phase cost storage). Keep ChroniclerManager simple (no loop awareness needed), aggregate in UI layer.

### 4.3 Cost Aggregation for Loop Reporting

**Recommendation**: Add helper method to aggregate costs across loop iterations:

```typescript
// In StateManager or new utility
function getLoopChroniclerCosts(
  phases: PhaseExecution[],
  loopId: string
): Record<string, number> {
  const aggregated: Record<string, number> = {};

  for (const phase of phases) {
    // Match phases belonging to this loop (e.g., "review#1", "review#2")
    if (phase.phaseId.startsWith(`${loopId}#`)) {
      const metadata = phase.metadata as { chroniclerCosts?: Record<string, number> };
      if (metadata?.chroniclerCosts) {
        for (const [chroniclerId, cost] of Object.entries(metadata.chroniclerCosts)) {
          aggregated[chroniclerId] = (aggregated[chroniclerId] || 0) + cost;
        }
      }
    }
  }

  return aggregated;
}
```

---

## 5. Config Validation Coordination

### 5.1 Chronicler Validation (from execution-spec-final.md Section 1.3)

**Required Checks**:
1. File paths exist (if using file references)
2. No duplicate chronicler IDs within a phase
3. If `failPhaseIfNotLoaded` is used, config must be valid

### 5.2 Loop Validation (from plan.md)

**Required Checks**:
1. Positive iteration count
2. Non-empty phases array
3. No nested loops (v1 limitation)
4. Valid continuation modes

### 5.3 Integrated Validation Flow

**RECOMMENDATION**: Validation order:
```
1. Parse JSON
2. Validate schema (Zod) - includes both loop structure and chroniclers field
3. Resolve file paths (prompts, chronicler configs)
4. Validate file existence
5. Validate chronicler configs recursively
6. Check for duplicate chronicler IDs within each phase
7. Validate loop structure (no nesting, positive counts)
```

**Implementation Note**: With loop flattening, chronicler validation runs on the **flattened** phase array:

```typescript
// In server/config.ts validation
function validatePhaseConfigs(phases: PhaseConfig[]): ValidationError[] {
  const errors: ValidationError[] = [];

  // Phases are already flattened (review#1, review#2, review#3, etc.)
  for (const phase of phases) {
    // Validate single phase (including chroniclers)
    if (phase.chroniclers) {
      // ... existing chronicler validation from execution-spec-final.md ...
    }
  }

  return errors;
}
```

**Note**: Validation of the loop structure (before flattening) happens earlier in the config loading pipeline. After flattening, all phases are `SinglePhaseConfig` instances.

---

## 6. Event Routing and Loop Phases

### 6.1 Chronicler Event Filtering

**From execution-spec-final.md Section 5**:
> Only route Server State and Agent Backbone events. Connection State events are client-specific.

**Looping Impact**: None. Event routing is based on event type, not phase type.

**Validation**: Ensure loop-related events (if any are added) are properly categorized:
- `LoopIterationCompleted` → Server State event? Or new category?

**RECOMMENDATION**: Add loop events to Server State category:

```typescript
// In event categorization
export function isServerStateEvent(event: ServerEvent): boolean {
  return (
    event.type === "phase.started" ||
    event.type === "phase.completed" ||
    event.type === "loop.iteration.completed" ||  // NEW
    // ... existing types ...
  );
}
```

---

## 7. Failure Handling Coordination

### 7.1 Chronicler Load Failures

**From execution-spec-final.md Section 8**:
- `failPhaseIfNotLoaded=true` → phase fails with "chronicler-load-failure"
- Phase transitions to `failed` during `starting` state

### 7.2 Loop Failure Handling

**From 3-gemini.md**:
> If a phase within a loop fails, the execution should halt. The system should not automatically skip to the next iteration.

**Integration**: These behaviors are compatible. If a phase in iteration 2 fails to load a required chronicler:
1. Phase fails during `starting` state
2. Loop halts (no automatic retry to iteration 3)
3. User can inspect, fix, and resume

**No changes needed**.

### 7.3 Failure Reason Extension

**From execution-spec-final.md Section 8.1**:
```typescript
const failureReasonSchema = z.object({
  type: z.enum([
    "timeout",
    "rate-limit",
    "api-error",
    "chronicler-load-failure",
    "unknown"
  ]),
  // ...
});
```

**Potential Addition**: Add loop-specific failure types?
```typescript
type: z.enum([
  // ... existing types ...
  "chronicler-load-failure",
  "loop-termination-exceeded",  // NEW: Context exceeded in loop
])
```

**RECOMMENDATION**: Defer loop-specific failure types to v2. Use existing types for v1.

---

## 8. Implementation Coordination Plan

### 8.1 Phase 1: Schema Integration (Day 1)

**Tasks**:
1. ✅ Define discriminated union `PhaseConfig = SinglePhaseConfig | LoopPhaseConfig`
2. ✅ Add `chroniclers?: PhaseChroniclerEntry[]` to `SinglePhaseConfig` only
3. ✅ Update Zod schemas for both features
4. ✅ Update validation to be recursive (handle nested loop phases)
5. ⚠️ **NEW**: Add template variable support for chronicler `outputPaths` (e.g., `${iteration}`)

**Coordination Point**: Both teams agree on final `PhaseConfig` shape before proceeding.

### 8.2 Phase 2: Config Loading & Validation (Day 2)

**Tasks**:
1. ✅ Implement loop parsing and validation (from plan.md)
2. ✅ Implement loop flattening during config loading
3. ✅ Implement chronicler validation (from execution-spec-final.md Section 1.3)
4. ⚠️ **NEW**: Run chronicler validation on flattened phase array
5. ✅ Validate no duplicate chronicler IDs within each flattened phase

### 8.3 Phase 3: State Management (Day 3)

**Tasks**:
1. ✅ Add `completing-chroniclers` state (from execution-spec-final.md Section 6)
2. ✅ Add loop termination logic (from plan.md Step 2)
3. ⚠️ **NEW**: Store chronicler costs in phase completion metadata
4. ⚠️ **NEW**: Coordinate loop termination with chronicler completion

### 8.4 Phase 4: Runtime Integration (Day 4-5)

**Tasks**:
1. ✅ Implement loop execution (from plan.md Step 2)
2. ✅ Integrate ChroniclerManager (from execution-spec-final.md Section 4)
3. ⚠️ **NEW**: Extract iteration number from phase ID for template substitution
4. ⚠️ **NEW**: Test chroniclers across loop iterations (cache hits, separate costs)

### 8.5 Phase 5: Cost Tracking & Reporting (Day 6)

**Tasks**:
1. ✅ Implement per-phase chronicler cost capture (Option 1 from Section 4.2)
2. ⚠️ **NEW**: Add loop cost aggregation helper
3. ⚠️ **NEW**: Update TUI/UI to show aggregated loop costs

---

## 9. Testing Strategy Updates

### 9.1 Unit Tests

**Existing Chronicler Tests** (from execution-spec-final.md Section 9.1):
- ✅ ChroniclerConfigLoader tests
- ⚠️ **ADD**: Test loading chronicler configs from phases within loops

**Existing Loop Tests** (from plan.md):
- ✅ Loop config parsing and validation
- ⚠️ **ADD**: Test loops with chroniclers field

**New Integration Tests**:
- ✅ Validate chroniclers field within loop phases
- ✅ Duplicate ID detection across loop iterations
- ✅ Cache behavior when same chronicler file used across iterations

### 9.2 Integration Tests

**New Test Suite**: `tests/integration/loop-chronicler-integration.test.ts`

**Test Cases**:
1. **Basic loop with chroniclers**
   - 3-iteration loop
   - Each iteration has narrator chronicler (same config file)
   - Verify cache hits on iterations 2 and 3
   - Verify separate output files for each iteration

2. **Loop with iteration-specific output paths**
   - Chronicler config uses `${iteration}` template variable
   - Verify outputs created with correct names: `review-1.md`, `review-2.md`, `review-3.md`

3. **Loop with required chronicler**
   - `failPhaseIfNotLoaded=true` on iteration 2
   - Chronicler config invalid
   - Verify loop halts at iteration 2, does not proceed to iteration 3

4. **Cost tracking across iterations**
   - 3-iteration loop with narrator
   - Verify costs stored per iteration-phase
   - Verify aggregation helper returns total loop cost

5. **Chronicler completion before loop termination**
   - Large chronicler queue in final iteration
   - Verify loop waits for `completing-chroniclers` before terminating

### 9.3 E2E Tests

**Extend existing E2E**: `tests/e2e/chronicler-full-e2e.test.ts`

**Add Test Case**:
```typescript
test("Chroniclers in looping phases - full workflow", async () => {
  // Config with 3-iteration review loop, each iteration has narrator
  const config = {
    phases: [
      { id: "setup", /* ... */ },
      {
        type: "loop",
        id: "review",
        terminateOn: { type: "iterationLimit", limit: 3 },
        phases: [
          {
            id: "review-phase",
            chroniclers: [
              {
                chroniclerConfig: "./chroniclers/narrator.json",
                settings: {
                  outputPaths: {
                    logFile: "review-${iteration}.md"
                  }
                }
              }
            ],
            // ... rest of phase config ...
          }
        ]
      },
      { id: "finalize", /* ... */ }
    ]
  };

  // Run server
  // Verify 3 output files created: review-1.md, review-2.md, review-3.md
  // Verify costs tracked separately per iteration
  // Verify total run cost includes all chronicler costs
});
```

---

## 10. Open Questions & Decisions Needed

### 10.1 Template Variable Substitution

**Question**: Should chronicler `outputPaths` support template variables like `${iteration}`?

**Recommendation**: **YES**. Essential for distinguishing chronicler outputs across loop iterations.

**Implementation**: Add substitution in `TadpoleServer.loadChroniclersForPhase()` (see Section 2.3).

**Scope**: Support `${iteration}` only in v1. Defer advanced templating (e.g., `${loopId}`, `${phaseId}`) to v2.

### 10.2 Chronicler Config Caching Across Iterations

**Question**: Should the config cache persist across loop iterations?

**Current Behavior** (from execution-spec-final.md Section 3.1): ChroniclerConfigLoader caches configs by file path.

**Impact on Loops**: If the same chronicler file is used in iterations 1, 2, and 3:
- Iteration 1: Cache miss, reads from disk
- Iteration 2: Cache hit
- Iteration 3: Cache hit

**Recommendation**: **Keep existing caching behavior**. It's beneficial for performance in loops.

**Validation**: Add integration test to verify cache hits (see Section 9.2).

### 10.3 Loop Cost Metadata Schema

**Question**: Should `PhaseTransitioned` metadata include chronicler costs?

**Recommendation**: **YES**. Update state-types.ts:

```typescript
// In PhaseTransitionedData metadata
metadata?: {
  failedDuring?: string;
  failureReason?: FailureReason;
  chroniclerCosts?: Record<string, number>;  // NEW: Per-chronicler costs
  // ... other fields ...
}
```

**Alternative**: Add to `phase.completed` event instead. Defer decision to chroniclers integration owner.

### 10.4 Loop Termination Event Categorization

**Question**: Should `loop.iteration.completed` events be routed to chroniclers?

**Options**:
1. **Route as Server State event**: Chroniclers can observe loop progress
2. **Don't route**: Chroniclers don't need to know about loop structure

**Recommendation**: **Route as Server State event**. Allows chroniclers to track loop progress (useful for loop-aware summaries).

**Implementation**: Add to `isServerStateEvent()` (see Section 6.1).

---

## 11. Risk Assessment

### 11.1 Low Risk (Well Understood)

✅ **Schema coordination**: Discriminated union approach clearly separates concerns
✅ **Event routing**: Orthogonal to loop structure
✅ **Failure handling**: Compatible behaviors

### 11.2 Medium Risk (Requires Coordination)

⚠️ **Config validation**: Must run in correct sequence (parse → validate loop structure → flatten → validate chroniclers)
⚠️ **Cost tracking**: Requires per-phase storage + aggregation layer
⚠️ **Template variables**: New feature, needs testing

### 11.3 Medium-High Risk (Requires Careful Implementation)

🟡 **State machine complexity**: Multiple new states (`completing-chroniclers`) + loop logic = complex interaction space. **Mitigation**: Extensive integration testing of state transitions across loop iterations.

🟡 **Flattened phase ID patterns**: Template substitution relies on parsing iteration numbers from phase IDs (e.g., `review#2` → `2`). Must be consistent and well-tested. **Mitigation**: Establish clear ID pattern conventions and comprehensive unit tests.

---

## 12. Final Recommendations

### 12.1 Schema & Config

1. ✅ Use discriminated union `PhaseConfig = SinglePhaseConfig | LoopPhaseConfig`
2. ✅ Add `chroniclers` field to `SinglePhaseConfig` only (not `LoopPhaseConfig`)
3. ✅ Run chronicler validation after loop flattening
4. ⚠️ **NEW**: Add `${iteration}` template variable support for `outputPaths`

### 12.2 Execution Model

1. ✅ Use **flattening approach** for loops
   - Keeps ChroniclerManager simple (no loop awareness needed)
   - Each iteration-phase gets unique ID (e.g., `review#1`, `review#2`)
   - Chroniclers naturally load/unload per iteration
   - No changes to core phase execution logic
2. ✅ Wait for `completing-chroniclers` before evaluating loop termination
3. ✅ Store chronicler costs in phase completion metadata

### 12.3 Cost Tracking

1. ✅ Store per-phase chronicler costs in `PhaseTransitioned` metadata
2. ✅ Add loop cost aggregation helper for UI/reporting
3. ✅ Document that chronicler costs are per-iteration-phase

### 12.4 Testing

1. ✅ Add loop-specific tests to ChroniclerConfigLoader suite
2. ✅ Create `loop-chronicler-integration.test.ts` integration test suite
3. ✅ Extend E2E tests with loop + chroniclers scenarios
4. ✅ Test cache behavior, cost tracking, and output path templating

### 12.5 Implementation Sequence

**Recommendation**: Implement features in this order:
1. **Looping phases first** (without chroniclers)
   - Validates loop structure, flattening, state machine
   - Establishes phase ID patterns (e.g., `review#1`, `review#2`)
2. **Chroniclers integration second** (without loop testing)
   - Validates chronicler loading, events, costs
   - Establishes per-phase lifecycle
3. **Integration third**
   - Add `${iteration}` template support
   - Add cost aggregation
   - Integration & E2E tests

**Rationale**: De-risks each feature independently before combining.

---

## 13. Summary of Changes to Original Plans

### 13.1 Chroniclers Integration Spec Changes

**File**: `intermediates/16-chroniclers/13-integration/3-execution-spec-final.md`

**Required Updates**:

1. **Section 1.1 (Configuration Schema)**: Update `PhaseConfig` interface to be discriminated union
   ```typescript
   export interface SinglePhaseConfig {  // RENAMED from PhaseConfig
     type?: "phase";  // NEW
     // ... existing fields ...
     chroniclers?: PhaseChroniclerEntry[];
   }

   export type PhaseConfig = SinglePhaseConfig | LoopPhaseConfig;  // NEW union
   ```

2. **Section 1.3 (Config.ts Validation Update)**: Validate after flattening
   ```typescript
   // UPDATED: Validation runs on flattened phase array
   function validatePhaseConfigs(phases: PhaseConfig[], errors: string[]): void {
     // Phases already flattened at this point
     for (const phase of phases) {
       if (phase.chroniclers) {
         // ... existing chronicler validation ...
       }
     }
   }
   ```

   **Note**: Loop structure validation (before flattening) happens in separate step during config loading.

3. **Section 4.2 (Phase Start Integration)**: Add iteration extraction logic
   ```typescript
   // NEW: Extract iteration number for template substitution
   const iterationMatch = phase.id.match(/#(\d+)$/);
   const iteration = iterationMatch ? parseInt(iterationMatch[1], 10) : undefined;
   ```

4. **Section 6.3 (State Transition Implementation)**: Store chronicler costs in metadata
   ```typescript
   metadata: {
     chroniclerCount,
     chroniclerIds: Array.from(this.currentPhaseChroniclers),
     chroniclerCosts: chroniclerCostMap,  // NEW
   }
   ```

### 13.2 Looping Phases Plan Changes

**File**: `intermediates/18-looping-phases/plan.md`

**Required Updates**:

1. **Step 1 (Schema changes)**: Add chroniclers field to `SinglePhaseConfig`
   ```typescript
   export interface SinglePhaseConfig {
     // ... existing fields ...
     chroniclers?: PhaseChroniclerEntry[];  // NEW
   }
   ```

2. **Step 2 (Loading config)**: Add note about chronicler validation
   ```
   - Run chronicler validation AFTER loop flattening
   - Validate no duplicate chronicler IDs within each flattened phase
   - Each iteration-phase validated independently (e.g., review#1, review#2)
   ```

3. **NEW Step 2.5**: Template Variable Support
   ```
   - Support ${iteration} in chronicler outputPaths
   - Extract iteration number from phase ID during chronicler loading
   - Substitute variables before passing to ChroniclerManager
   ```

4. **Step 3 (TadpoleServer Integration)**: Coordinate with chronicler completion
   ```
   - Wait for completing-chroniclers state before loop termination check
   - Store chronicler costs in phase completion metadata
   - Pass iteration number to ChroniclerManager for template substitution
   ```

---

## 14. Conclusion

The looping phases and chroniclers integration features are **highly compatible** with **minimal adjustments required**. The key integration points are:

1. **Schema**: Use discriminated union, add chroniclers to `SinglePhaseConfig`
2. **Validation**: Run chronicler validation after loop flattening
3. **Execution**: Use flattening approach, maintain per-phase chronicler lifecycle
4. **State**: Coordinate `completing-chroniclers` with loop termination
5. **Costs**: Store per-phase, aggregate in UI layer
6. **Templates**: Add `${iteration}` support for output paths

**Risk Level**: **LOW** - Both features are well-designed and orthogonal. The identified adjustments are straightforward and low-risk.

**Recommended Implementation Order**: Looping phases → Chroniclers → Integration testing

**No blockers identified**. Proceed with confidence. 🎯
