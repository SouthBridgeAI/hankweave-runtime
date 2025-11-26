# Looping Phases Implementation Report

## Executive Summary

This report analyzes the requirements for implementing looping phases in Tadpole Runner and provides a detailed architectural plan. The feature will enable defining phases that can execute n times with configurable continuation behavior, moving beyond the current single-execution model to support iterative workflows.

## Feature Analysis

### Current Phase Execution Model

Tadpole currently executes phases in a linear sequence:
1. Phases are defined in `phases.json` as an ordered array
2. Each phase executes exactly once
3. Phase progression is managed by `execution-thread.ts:analyzeExecutionThread()` 
4. Next phase determination follows simple array index progression (`phaseConfigs[currentIndex + 1]`)
5. Continuation modes control conversation context (`fresh` vs `continue-previous`)

### Key Codebase Components

**Phase Configuration (`server/config.ts`, `server/types/types.ts`)**:
- Current `PhaseConfig` interface in `server/types/types.ts:115-140`
- Schema validation in `server/config.ts:122-125`
- Configuration loading and validation

**Phase Execution (`server/tadpole-server.ts`)**:
- `startPhase()` method at line 662 - main phase execution entry point
- Phase lifecycle management and state transitions
- Workspace setup and Claude process spawning

**Phase Sequencing (`server/execution-thread.ts`)**:
- `analyzeExecutionThread()` at line 82 - determines next phase to execute
- `getNextPhaseId()` at line 382 - simple next phase lookup
- Linear progression logic at lines 266-268

**State Management (`server/state-manager.ts`)**:
- `getNextPhaseToExecute()` at line 336 - interfaces with execution thread
- State persistence and transition management

## Clarifications & Assumptions

Based on analysis, I'm making these assumptions for the initial implementation:

1. **Loop Scope**: Looping applies to individual phases, not groups of phases
2. **Continue-Previous**: Maintains current behavior - only affects Claude conversation context
3. **Error Handling**: Failed iterations stop the loop and propagate the error
4. **Loop Control**: Simple count-based iteration (no conditional breaking)
5. **State Tracking**: Each iteration creates a separate phase execution record

## Implementation Plan

### Approach 1: Configuration Extension (Recommended)

Extend the existing `PhaseConfig` interface to support loop parameters while maintaining backward compatibility.

#### Phase 1: Schema and Type Updates

**File: `server/types/types.ts`**
```typescript
// Add to existing PhaseConfig interface around line 140
export interface PhaseConfig {
  // ... existing fields ...
  
  /**
   * Looping configuration for phases that should execute multiple times
   */
  loop?: {
    /** Number of iterations to execute (must be >= 1) */
    iterations: number;
    
    /** 
     * How each iteration should handle continuation
     * - "fresh": Each iteration starts a new conversation
     * - "continue-previous": Each iteration continues from previous iteration
     * - "inherit": Use the phase's continuationMode for first iteration, 
     *   then continue-previous for subsequent iterations
     */
    continuationMode?: "fresh" | "continue-previous" | "inherit";
  };
}
```

**File: `server/config.ts`**
```typescript
// Add to phase schema around line 122
const phaseConfigSchema = z.object({
  // ... existing fields ...
  
  loop: z.optional(
    z.object({
      iterations: z.number().int().min(1).max(100), // Reasonable upper limit
      continuationMode: z.enum(["fresh", "continue-previous", "inherit"]).optional(),
    })
  ),
});

// Add validation logic around line 587
function validatePhaseConfigs(phases: PhaseConfig[]): ValidationIssue[] {
  // ... existing validations ...
  
  // Validate loop configurations
  for (const [index, phase] of phases.entries()) {
    if (phase.loop) {
      if (phase.loop.iterations < 1) {
        issues.push({
          type: "error",
          message: `Phase "${phase.name}" (${phase.id}): loop.iterations must be at least 1`,
        });
      }
      
      if (phase.loop.continuationMode === "continue-previous" && index === 0) {
        issues.push({
          type: "warning", 
          message: `Phase "${phase.name}" (${phase.id}): First phase loop with continuationMode "continue-previous" may not work as expected`,
        });
      }
    }
  }
}
```

#### Phase 2: State Model Updates  

**File: `server/types/state-types.ts`**
```typescript
// Extend PhaseExecution interface around line 680
export interface PhaseExecution {
  // ... existing fields ...
  
  /** Loop iteration data if this is a looping phase */
  loopIteration?: {
    /** Current iteration number (1-based) */
    current: number;
    
    /** Total iterations planned */
    total: number;
    
    /** Session IDs for each completed iteration (for continuation) */
    iterationSessions: SessionId[];
    
    /** Whether this is the final iteration */
    isFinal: boolean;
  };
}

// Add new state transition type
export interface LoopIterationCompleted extends BaseTransition {
  type: "LoopIterationCompleted";
  data: {
    runId: RunId;
    phaseId: PhaseId;
    iterationNumber: number;
    sessionId: SessionId;
    nextIteration?: number; // Present if more iterations remaining
  };
}
```

#### Phase 3: Execution Logic Updates

**File: `server/execution-thread.ts`** 
```typescript
// Update next phase determination logic around line 265
function determineNextPhase(
  phases: ThreadPhase[], 
  phaseConfigs: PhaseConfig[]
): PhaseId | null {
  if (phases.length === 0) {
    return phaseConfigs[0]?.id || null;
  }
  
  const latestPhase = phases[0];
  const phaseConfig = phaseConfigs.find(c => c.id === latestPhase.phase.phaseId);
  
  // Check if current phase has remaining loop iterations
  if (phaseConfig?.loop && latestPhase.phase.loopIteration) {
    const { current, total } = latestPhase.phase.loopIteration;
    if (current < total) {
      return latestPhase.phase.phaseId; // Continue same phase
    }
  }
  
  // Move to next phase in sequence
  const phaseIndex = phaseConfigs.findIndex(c => c.id === latestPhase.phase.phaseId);
  if (phaseIndex >= 0 && phaseIndex < phaseConfigs.length - 1) {
    return phaseConfigs[phaseIndex + 1].id as PhaseId;
  }
  
  return null; // No more phases
}

// Add function to determine continuation session for loop iterations  
export function getLoopContinuationSession(
  phase: PhaseExecution,
  phaseConfig: PhaseConfig
): SessionId | null {
  if (!phase.loopIteration || !phaseConfig.loop) {
    return null;
  }
  
  const { current, iterationSessions } = phase.loopIteration;
  const continuationMode = phaseConfig.loop.continuationMode || "fresh";
  
  switch (continuationMode) {
    case "fresh":
      return null; // Each iteration starts fresh
      
    case "continue-previous":
      return iterationSessions[current - 2] || null; // Previous iteration's session
      
    case "inherit":
      if (current === 1) {
        // First iteration uses phase's continuationMode
        return phaseConfig.continuationMode === "continue-previous" 
          ? /* find previous phase session */ null
          : null;
      } else {
        // Subsequent iterations continue from previous iteration
        return iterationSessions[current - 2] || null;
      }
      
    default:
      return null;
  }
}
```

**File: `server/tadpole-server.ts`**
```typescript
// Update startPhase method around line 662
private async startPhase(phaseId: PhaseId, skipPreCommands?: boolean): Promise<void> {
  const phase = this.config.phases.find((p) => p.id === phaseId);
  if (!phase) {
    // ... error handling
    return;
  }

  // Check if this is a loop iteration
  const currentRun = this.stateManager.getCurrentRun();
  const existingPhase = currentRun?.phases.find(p => p.phaseId === phaseId);
  
  let loopIteration: PhaseExecution['loopIteration'];
  
  if (phase.loop) {
    if (existingPhase?.loopIteration) {
      // Continuing a loop
      loopIteration = {
        current: existingPhase.loopIteration.current + 1,
        total: phase.loop.iterations,
        iterationSessions: existingPhase.loopIteration.iterationSessions,
        isFinal: existingPhase.loopIteration.current + 1 >= phase.loop.iterations,
      };
    } else {
      // Starting a new loop
      loopIteration = {
        current: 1,
        total: phase.loop.iterations,
        iterationSessions: [],
        isFinal: phase.loop.iterations === 1,
      };
    }
  }

  // Create phase started transition with loop metadata
  this.stateManager.transition({
    type: "PhaseStarted",
    data: {
      runId: this.currentRunId,
      phaseId: phase.id,
      loopIteration,
    },
  });

  // ... rest of phase startup logic
  
  // Determine continuation session for loop iterations
  let previousSessionId: string | null = null;
  if (loopIteration) {
    previousSessionId = getLoopContinuationSession(
      { loopIteration } as PhaseExecution, 
      phase
    );
  } else if (phase.continuationMode === "continue-previous") {
    // ... existing continuation logic
  }

  // ... continue with Claude process startup
}

// Update phase completion handler to manage loop iterations
private async handlePhaseCompletion(sessionId: SessionId): Promise<void> {
  // ... existing completion logic
  
  const currentPhase = this.stateManager.getCurrentlyRunningPhase();
  const phaseConfig = this.config.phases.find(p => p.id === currentPhase?.phaseId);
  
  if (currentPhase?.loopIteration && phaseConfig?.loop) {
    const { current, total, isFinal } = currentPhase.loopIteration;
    
    // Record iteration completion
    this.stateManager.transition({
      type: "LoopIterationCompleted",
      data: {
        runId: this.currentRunId!,
        phaseId: currentPhase.phaseId,
        iterationNumber: current,
        sessionId,
        nextIteration: isFinal ? undefined : current + 1,
      },
    });
    
    if (!isFinal) {
      // Start next iteration
      this.logger.log(`Starting loop iteration ${current + 1}/${total} for phase ${phaseConfig.name}`);
      await this.startPhase(currentPhase.phaseId, true); // Skip pre-commands for iterations
      return;
    }
  }
  
  // Phase completely finished, transition to completed
  this.stateManager.transition({
    type: "PhaseTransitioned", 
    data: {
      runId: this.currentRunId!,
      phaseId: currentPhase!.phaseId,
      from: "running",
      to: "completed",
    },
  });
  
  // ... continue with next phase logic
}
```

#### Phase 4: State Manager Updates

**File: `server/state-manager.ts`**
```typescript
// Add transition handler around line 200
case "LoopIterationCompleted": {
  const { runId, phaseId, iterationNumber, sessionId, nextIteration } = transition.data;
  const run = newState.runs.find(r => r.runId === runId);
  const phase = run?.phases.find(p => p.phaseId === phaseId);
  
  if (run && phase && phase.loopIteration) {
    // Record session ID for this iteration
    phase.loopIteration.iterationSessions.push(sessionId);
    
    if (nextIteration) {
      // Update for next iteration
      phase.loopIteration.current = nextIteration;
      phase.loopIteration.isFinal = nextIteration >= phase.loopIteration.total;
      // Keep status as 'running' for next iteration
    } else {
      // Loop completed, will be transitioned to 'completed' separately
    }
  }
  break;
}
```

#### Phase 5: User Interface Updates  

**Event Schema Updates (`server/schemas/event-schemas.ts`)**:
```typescript
// Add loop iteration event
export const loopIterationCompletedEventSchema = z.object({
  id: eventIdSchema,
  timestamp: timestampSchema,
  type: z.literal("loop.iteration.completed"),
  data: z.object({
    phaseId: z.string(),
    phaseName: z.string(),
    iteration: z.number(),
    totalIterations: z.number(),
    isFinal: z.boolean(),
  }),
});

export type LoopIterationCompletedEvent = z.infer<typeof loopIterationCompletedEventSchema>;
```

**TUI Updates**: Display loop progress in basic TUI mode showing "Phase 1 (2/5)" format.

### Approach 2: Virtual Phase Expansion (Alternative)

An alternative approach would expand looping phases into multiple virtual phases at configuration load time:

**Pros**: 
- Minimal changes to execution logic
- Clear audit trail with individual phase records
- Simple rollback behavior

**Cons**:
- More complex configuration processing
- Potential confusion in UI (many similar phases)
- Harder to implement dynamic loop control

### Configuration Examples

**Simple Loop**:
```json
{
  "id": "iterative-refinement",
  "name": "Iterative Code Refinement",
  "model": "sonnet",
  "continuationMode": "fresh", 
  "promptText": "Review and improve the code, focusing on one aspect",
  "loop": {
    "iterations": 3,
    "continuationMode": "continue-previous"
  },
  "trackedFiles": ["src/**/*.ts"]
}
```

**Complex Workflow Example**:
```json
[
  {
    "id": "analysis", 
    "name": "Initial Analysis",
    "model": "opus",
    "continuationMode": "fresh",
    "promptText": "Analyze the codebase structure"
  },
  {
    "id": "iterative-improvement",
    "name": "Iterative Code Improvement", 
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "Apply one focused improvement to the code",
    "loop": {
      "iterations": 5,
      "continuationMode": "continue-previous"  
    },
    "trackedFiles": ["src/**/*.ts"]
  },
  {
    "id": "final-review",
    "name": "Final Review",
    "model": "opus", 
    "continuationMode": "continue-previous",
    "promptText": "Conduct final code review and documentation"
  }
]
```

## Implementation Timeline

**Phase 1** (Schema/Config): 2-3 days
- Type definitions and schema updates
- Configuration validation  
- Unit tests for config loading

**Phase 2** (State Model): 2-3 days  
- State type updates
- Transition definitions
- State manager updates

**Phase 3** (Execution Logic): 3-4 days
- Execution thread updates
- Phase startup logic
- Loop iteration handling

**Phase 4** (Integration): 1-2 days
- End-to-end testing
- UI updates for loop display
- Documentation updates

**Total Estimate**: 8-12 days

## Testing Strategy

1. **Unit Tests**: Configuration validation, state transitions, execution thread logic
2. **Integration Tests**: Full loop execution with different continuation modes
3. **E2E Tests**: Complex workflows mixing regular and looping phases
4. **Error Scenarios**: Failed iterations, invalid configurations, edge cases

## Risks and Considerations

1. **State Size**: Loop iterations create additional state data - may need periodic cleanup
2. **UI Complexity**: Displaying loop progress without cluttering interface
3. **Checkpoint Behavior**: How rollbacks interact with partially completed loops
4. **Performance**: Many iterations may impact execution time and resource usage
5. **Backward Compatibility**: Ensure existing configurations continue working

## Conclusion

The recommended approach extends the existing configuration schema to support looping while maintaining backward compatibility. The implementation leverages Tadpole's existing event-driven architecture and state management system, requiring focused changes to core execution logic without major architectural modifications.

The feature will enable powerful iterative workflows while maintaining the system's robustness and type safety. The modular design allows for incremental implementation and testing of each component.