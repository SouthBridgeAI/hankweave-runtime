# Looping Phases Implementation Plan

This plan implements support for looping phases in Tadpole, allowing phases to repeat n times with dynamic termination conditions like iteration limits or context exhaustion.

## Overview

**Goals:**

- Support repeating one or more phases a specified number of times
- Enable dynamic termination (contextExceeded, budgetExhausted - future)
- Maintain full resumability from crashes/rollbacks mid-loop
- Keep loop logic isolated and testable

**Approach:**

- Add `Loop` primitive as a discriminated union with `Phase`
- Use **lazy expansion**: expand first iteration at startup, add more as needed
- Generate unique IDs per iteration (`review#0`, `review#1`, etc.)
- Store `loopContext` in state for each phase execution
- Extract planning logic to separate `ExecutionPlanner` module

**Key architectural decision:** Loops flatten at runtime, not at config load time. This enables dynamic termination conditions and keeps the system resumable.

## Step 1: Schema Changes

### Add Loop Primitive to phases.json

**Example configuration:**

```json
{
  "type": "loop",
  "id": "iterative-development-loop",
  "terminateOn": {
    "type": "iterationLimit",
    "limit": 3
  },
  "phases": [
    {
      "id": "write-code",
      "name": "Write Code",
      "model": "sonnet",
      "continuationMode": "continue-previous",
      "promptText": "Based on the plan, write the next part of the feature."
    },
    {
      "id": "write-tests",
      "name": "Write Tests",
      "model": "sonnet",
      "continuationMode": "continue-previous",
      "promptText": "Now, write unit tests for the code you just wrote."
    }
  ]
}
```

### Update Zod Schemas

**File: `server/config.ts` (around line 127-171)**

Add termination schema and update phase config to be discriminated union:

```typescript
// Loop termination conditions
const loopTerminationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("iterationLimit"),
    limit: z.number().int().min(1),
  }),
  z.object({
    type: z.literal("contextExceeded"),
  }),
  // Future: budgetExhausted - see "Future: Budget System" section below
]);

// Single phase schema (existing fields, type defaults to "phase")
const phaseSchema = z.object({
  type: z.literal("phase").optional().default("phase"),
  id: z.string().min(1),
  name: z.string().min(1),
  promptFile: z.union([z.string(), z.array(z.string())]).optional(),
  promptText: z.string().optional(),
  appendSystemPromptFile: z.union([z.string(), z.array(z.string())]).optional(),
  appendSystemPromptText: z.string().optional(),
  model: z.enum(["sonnet", "opus"]),
  continuationMode: z.enum(["fresh", "continue-previous"]),
  workspaceSetup: z.array(workspaceSetupItemSchema).optional(),
  description: z.string().optional(),
  trackedFiles: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  outputFiles: phaseOutputSchema,
}).strict().refine(...);

// Loop schema - only allows Phase children (prevents nesting)
const loopSchema = z.object({
  type: z.literal("loop"),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  terminateOn: loopTerminationSchema,
  phases: z.array(phaseSchema).min(1), // ← Only Phase, not PhaseConfig (no nested loops)
}).strict();

// PhaseConfig is discriminated union of Phase and Loop
const phaseConfigSchema = z.discriminatedUnion("type", [
  phaseSchema,     // type: "phase" (or omitted)
  loopSchema,      // type: "loop"
]);

const phaseConfigArraySchema = z.array(phaseConfigSchema).min(1);
```

**Why prevent nested loops:**

- V1 simplification - nested loops add significant complexity
- Can be added later if needed
- Type-level prevention is cleaner than runtime validation

### Update TypeScript Types

**File: `server/types/types.ts` (around line 171-234)**

Update PhaseConfig to be discriminated union:

```typescript
// Loop termination conditions
export type LoopTermination =
  | { type: "iterationLimit"; limit: number }
  | { type: "contextExceeded" };
  // Future: | { type: "budgetExhausted"; budget: number; budgetType: "tokens" | "time" }

// Single phase - existing interface with optional type field
export interface Phase {
  type?: "phase";  // Optional, defaults to "phase"
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
  outputFiles?: /* existing type */;
}

// Loop - contains terminateOn and nested phases
export interface Loop {
  type: "loop";
  id: PhaseId;
  name: string;
  description?: string;
  terminateOn: LoopTermination;
  phases: Phase[];  // Only Phase, no nested loops
}

// PhaseConfig is union - used everywhere in existing code
export type PhaseConfig = Phase | Loop;
```

**Naming rationale:**

- `Phase` is shorter and canonical term used throughout codebase
- `Loop` parallels `Phase` nicely
- Clear discriminator: things that execute are `Phase`, containers are `Loop`

**Note:** `ServerConfig.phases` remains `PhaseConfig[]` (no type change to existing interfaces)

## Step 2: Config Loading & Validation

**File: `server/config.ts` (in `validatePhaseConfig()` function)**

The current `loadPhaseConfig()` flow works with loops once Step 1 schema changes are done. Only minor updates needed:

### Required Changes

1. **Make path resolution recursive** - Handle `loop.phases` arrays
2. **Make file validation recursive** - Check prompt files in nested phases
3. **Update error messages** - Include loop context in errors
4. **Add workspace setup support for loop phases** - See Step 2a below

**Example error message:**

```
Loop 'iterative-dev' > Phase 'write-code': promptFile not found: prompts/write.md
```

### Implementation Note

`loadPhaseConfig()` returns the **nested structure directly** - no flattening at this stage. Flattening happens at runtime in the execution planner (Step 3).

## Step 2a: Workspace Setup for Loop Phases

**Problem:** Currently workspace setup is disallowed in phases within loops. This is too restrictive - users may need to set up files/dependencies per iteration.

**Solution:** Allow workspace setup in loop phases, but add optional `allowFailure` flag to make operations non-fatal.

### Schema Changes

**File: `server/config.ts` and `server/types/types.ts`**

Add `allowFailure` flag to workspace setup items:

```typescript
// In types.ts - Update WorkspaceSetupItem
export type WorkspaceSetupItem =
  | {
      type: "copy";
      copy: {
        from: string;
        to: string;
      };
      /** If true, failure of this operation won't fail the phase (default: false) */
      allowFailure?: boolean;
    }
  | {
      type: "command";
      command: {
        run: string;
        workingDirectory?: WorkspaceShellCommandWorkingDirectory;
      };
      /** If true, failure of this operation won't fail the phase (default: false) */
      allowFailure?: boolean;
    };

// In config.ts - Update workspaceSetupItemSchema
const workspaceSetupItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("copy"),
    copy: z.object({
      from: z.string().min(1, "Source path cannot be empty"),
      to: z.string().min(1, "Target path cannot be empty"),
    }),
    allowFailure: z.boolean().optional().default(false),
  }),
  workspaceShellCommandSchema.extend({
    allowFailure: z.boolean().optional().default(false),
  }),
]);
```

### Validation Changes

**File: `server/config.ts` (in `validatePhaseConfigRecursive()` and `processPhaseConfig()`)**

Remove the restriction and add a warning if `allowFailure` is not set:

```typescript
// REMOVE these checks (lines 434-440 and 762-768):
// if (isInLoop && config.workspaceSetup && config.workspaceSetup.length > 0) {
//   validationErrors.push(
//     `${context}: workspaceSetup is not allowed in phases within loops...`
//   );
// }

// ADD warning if workspace setup in loop without allowFailure flag:
if (isInLoop && phase.workspaceSetup && phase.workspaceSetup.length > 0) {
  const hasItemsWithoutAllowFailure = phase.workspaceSetup.some(
    (item) => !item.allowFailure
  );

  if (hasItemsWithoutAllowFailure) {
    result.warnings.push(
      `${phaseLabel}: workspaceSetup in loop phase should use 'allowFailure: true' ` +
      `to prevent loop termination on setup failures. This is especially important ` +
      `if subsequent iterations might fail (e.g., trying to copy files to where they already exist).`
    );
  }
}
```

### Execution Changes

**File: `server/tadpole-server.ts` (in workspace setup execution, around line 3700)**

Update workspace setup execution to respect `allowFailure`:

```typescript
// In performWorkspaceSetup() or equivalent method
private async performWorkspaceSetup(
  workspaceSetup: WorkspaceSetupItem[],
  phaseId: PhaseId
): Promise<void> {
  for (const item of workspaceSetup) {
    try {
      if (item.type === "copy") {
        await this.performCopyOperation(item.copy);
      } else {
        await this.performCommandOperation(item.command);
      }
    } catch (error) {
      if (item.allowFailure) {
        // Log but continue
        this.logger.log(
          `Workspace setup operation failed (allowFailure=true): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Emit non-fatal error event
        this.emit("event", {
          // ... workspace setup warning event
        });
      } else {
        // Fatal error - rethrow
        throw error;
      }
    }
  }
}
```

### Test Changes

**File: `tests/unit/config.test.ts`**

Update tests that expect workspace setup to be disallowed in loops:

```typescript
// REMOVE or update tests at lines 757 and 1413 that check for:
// /workspaceSetup is not allowed in phases within loops/

// ADD new tests:
- Test workspace setup allowed in loop phases
- Test allowFailure flag validation
- Test warning emitted when allowFailure is missing in loop phase
- Test workspace setup execution with allowFailure=true continues on error
- Test workspace setup execution with allowFailure=false fails on error
```

### Benefits

**For users:**
- Can set up iteration-specific files/state
- Graceful degradation when setup operations might fail in some iterations
- Clear warning guides them to best practices

**For the system:**
- Workspace setup remains opt-in per operation
- Non-fatal failures don't break loop execution
- Consistent with existing checkpoint system (workspace-setup checkpoint already exists)

**Example use case:**
```json
{
  "type": "loop",
  "id": "test-and-refine",
  "terminateOn": { "type": "iterationLimit", "limit": 3 },
  "phases": [{
    "id": "refine",
    "name": "Refine Code",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "workspaceSetup": [
      {
        "type": "copy",
        "copy": {
          "from": "../test-fixtures/sample-data.json",
          "to": "test-data.json"
        },
        "allowFailure": true  // ← First iteration might not have this file yet
      }
    ],
    "promptText": "Refine the code based on test results"
  }]
}
```

## Step 3: Extract Execution Planner

**Rationale for extraction:**

- `tadpole-server.ts` is already ~3,900 lines
- Planning logic is pure (no side effects), execution is stateful
- Planning is reused in 4+ places (startup, resume, rollback, loop expansion)
- Makes testing much easier (no need to mock websockets/processes)
- Follows industry patterns (Airflow's DagBag, Bazel's Skyframe)

### Create New File: `server/execution-planner.ts`

**Estimated size: ~250-300 lines**

This module handles all "what phases should run" logic, separate from "how to execute phases" logic.

```typescript
import type {
  PhaseConfig,
  Phase,
  Loop,
  LoopTermination,
} from "./types/types.js";
import type { Run, PhaseExecution } from "./types/state-types.js";
import type { PhaseId } from "./types/branded-types.js";

/**
 * Represents a flattened phase in the execution plan.
 * Each entry is a concrete phase that will be executed.
 */
export interface ExecutionPhaseEntry {
  // The actual phase config to execute (always Phase, never Loop)
  phase: Phase;

  // Runtime-generated ID (e.g., "review#0", "review#1" for loop iterations)
  phaseId: PhaseId;

  // If from a loop, track context for resume/rollback
  loopContext?: {
    loopId: PhaseId; // ID of the loop this phase belongs to
    iteration: number; // Which iteration (0-indexed: 0 = first, 1 = second, etc.)
    phaseIndexInLoop: number; // Position within loop.phases array
  };
}

/**
 * Handles all execution planning logic.
 * Pure functions - no side effects, just config → plan transformations.
 */
export class ExecutionPlanner {
  constructor(private phaseConfigs: PhaseConfig[]) {}

  /**
   * Build initial execution plan for fresh start.
   * Expands only the first iteration of each loop.
   */
  buildInitialPlan(): ExecutionPhaseEntry[] {
    const plan: ExecutionPhaseEntry[] = [];

    for (let i = 0; i < this.phaseConfigs.length; i++) {
      const config = this.phaseConfigs[i];

      if (config.type === "loop") {
        // Lazy expansion - only first iteration
        plan.push(...this.expandFirstIteration(config, i));
      } else {
        // Regular phase - no loop context
        plan.push({
          phase: config,
          phaseId: config.id,
        });
      }
    }

    return plan;
  }

  /**
   * Rebuild execution plan from persisted state.
   * Reconstructs where we are in loops and what comes next.
   * Used for resume from crash and rollback.
   */
  rebuildFromState(currentRun: Run): ExecutionPhaseEntry[] {
    const plan: ExecutionPhaseEntry[] = [];

    for (let i = 0; i < this.phaseConfigs.length; i++) {
      const config = this.phaseConfigs[i];

      if (config.type === "loop") {
        // Find all executed phases from this loop
        const loopPhases = currentRun.phases.filter(
          (p) => p.loopContext?.loopId === config.id
        );

        if (loopPhases.length > 0) {
          // We were in this loop - figure out where we left off
          plan.push(...this.continueLoop(config, loopPhases));
        } else {
          // Haven't started this loop yet
          plan.push(...this.expandFirstIteration(config, i));
        }
      } else {
        // Regular phase - add if not already done
        const alreadyDone = currentRun.phases.some(
          (p) => p.phaseId === config.id
        );
        if (!alreadyDone) {
          plan.push({ phase: config, phaseId: config.id });
        }
      }
    }

    return plan;
  }

  /**
   * Expand next iteration after phase completion.
   * Returns new plan with next iteration injected (if termination not met).
   * Pure function - doesn't mutate input plan.
   */
  expandNextIteration(
    currentPlan: ExecutionPhaseEntry[],
    completedIndex: number
  ): ExecutionPhaseEntry[] {
    const entry = currentPlan[completedIndex];
    if (!entry?.loopContext) return currentPlan;

    const { loopId, iteration, phaseIndexInLoop } = entry.loopContext;
    const loopConfig = this.phaseConfigs.find(
      (c) => c.type === "loop" && c.id === loopId
    ) as Loop | undefined;

    if (!loopConfig) {
      throw new Error(`Loop not found for ${entry.phaseId}: ${loopId}`);
    }

    // Is this the last phase in the iteration?
    const isLastPhaseInIteration =
      phaseIndexInLoop === loopConfig.phases.length - 1;

    if (isLastPhaseInIteration) {
      // Evaluate termination
      if (this.shouldContinueLoop(loopConfig, iteration)) {
        // Create next iteration and inject into plan
        const nextIteration = this.createIterationPlan(
          loopConfig,
          iteration + 1
        );

        return [
          ...currentPlan.slice(0, completedIndex + 1),
          ...nextIteration,
          ...currentPlan.slice(completedIndex + 1),
        ];
      }
    }

    return currentPlan;
  }

  /**
   * Evaluate loop termination condition.
   * Returns true if loop should continue, false if it should terminate.
   *
   * Note: For contextExceeded, actual detection happens in TadpoleServer
   * when Claude signals exhaustion. This method is called during normal
   * iteration completion - context exhaustion triggers different flow
   * (see Step 5 "Special Case: Context Exhaustion During Loops").
   */
  private shouldContinueLoop(
    loopConfig: Loop,
    currentIteration: number
  ): boolean {
    switch (loopConfig.terminateOn.type) {
      case "iterationLimit":
        return currentIteration < loopConfig.terminateOn.limit;

      case "contextExceeded":
        // Always return true here - context exhaustion is detected
        // by Claude signaling, not by iteration count
        // When exhaustion happens, TadpoleServer triggers rollback + loop exit
        return true;

      default:
        return false;
    }
  }

  /**
   * Validate the execution plan for consistency.
   * Catches configuration errors before execution.
   */
  validatePlan(plan: ExecutionPhaseEntry[]): void {
    // Check for duplicate phase IDs
    const ids = plan.map((e) => e.phaseId);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (duplicates.length > 0) {
      throw new Error(
        `Duplicate phase IDs after loop expansion: ${duplicates.join(", ")}`
      );
    }

    // Validate loop contexts
    for (const entry of plan) {
      if (entry.loopContext) {
        const { loopId, phaseIndexInLoop } = entry.loopContext;
        const config = this.phaseConfigs.find(
          (c) => c.type === "loop" && c.id === loopId
        ) as Loop | undefined;

        if (!config) {
          throw new Error(`Loop not found for phase ${entry.phaseId}: ${loopId}`);
        }

        if (phaseIndexInLoop >= config.phases.length) {
          throw new Error(
            `Phase index ${phaseIndexInLoop} out of bounds for loop ${config.id}`
          );
        }
      }
    }
  }

  // Private helper methods
  private expandFirstIteration(
    config: Loop
  ): ExecutionPhaseEntry[] {
    /* ... */
  }
  private createIterationPlan(
    config: Loop,
    iteration: number
  ): ExecutionPhaseEntry[] {
    /* ... */
  }
  private continueLoop(
    config: Loop,
    executedPhases: PhaseExecution[]
  ): ExecutionPhaseEntry[] {
    /* ... */
  }
}
```

### Integration with TadpoleServer

**File: `server/tadpole-server.ts`**

Add planner as class member and use it for all planning decisions:

```typescript
export class TadpoleServer {
  // NEW: Execution planner
  private planner: ExecutionPlanner;
  private executionPlan: ExecutionPhaseEntry[] = [];

  constructor(config: ServerConfig) {
    // ... existing initialization ...
    this.planner = new ExecutionPlanner(this.config.phases);
  }

  // Use planner in startNewRun
  private async startNewRun(
    startingConditions?: StartingConditions
  ): Promise<void> {
    // ... existing run creation logic ...
    this.executionPlan = this.planner.buildInitialPlan();
  }

  // Use planner for resume (see Step 4)
  async start(): Promise<void> {
    // ... initialization ...
    const currentRun = this.stateManager.getCurrentRun();
    if (currentRun?.status === "running") {
      this.executionPlan = this.planner.rebuildFromState(currentRun);
    }
  }

  // Use planner for loop expansion
  private async handlePhaseComplete(): Promise<void> {
    // ... completion logic ...
    const currentIndex = this.executionPlan.findIndex(
      (e) => e.phaseId === phaseId
    );
    this.executionPlan = this.planner.expandNextIteration(
      this.executionPlan,
      currentIndex
    );
  }
}
```

## Step 4: Runtime Execution Plan

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ Config Loading (server/config.ts)                       │
│ - Loads phases.json                                     │
│ - Validates schema (allows Loop)                        │
│ - Returns PhaseConfig[] (may contain loops)             │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ ExecutionPlanner (pure planning logic)                  │
│ - buildInitialPlan()                                    │
│ - rebuildFromState()                                    │
│ - expandNextIteration()                                 │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ TadpoleServer (maintains TWO arrays)                   │
│                                                          │
│ this.config.phases:  PhaseConfig[]                      │
│   - Original config (may have Loop)                     │
│   - Never modified                                      │
│   - Used for loop definitions                           │
│                                                          │
│ this.executionPlan:  ExecutionPhaseEntry[]             │
│   - Flattened, runtime-generated                       │
│   - Contains only Phase objects                         │
│   - Grows as loops expand                               │
│   - This is what phase execution uses                   │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Existing Phase Execution (minimal changes)              │
│ - startPhase(phaseId) looks up in executionPlan       │
│ - execution-thread uses executionPlan                  │
│ - State manager stores loop context per phase          │
│ - Rollback/resume reconstruct executionPlan           │
└─────────────────────────────────────────────────────────┘
```

### 1. Modify startPhase to Use Execution Plan

**File: `server/tadpole-server.ts` (in `startPhase()` method)**

```typescript
  private async startPhase(phaseId: PhaseId, skipPreCommands?: boolean): Promise<void> {
    // OLD: const phase = this.config.phases.find((p) => p.id === phaseId);

  // NEW: Look up in execution plan (handles generated IDs like "review#0", "review#1")
    const entry = this.executionPlan.find((e) => e.phaseId === phaseId);
    if (!entry) {
      await this.handleError(
        new Error(`Unknown phase: ${phaseId}`),
        "startPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    const phase = entry.phase;
    const loopContext = entry.loopContext;

  // Store loop context in state transition (see Step 6)
    // ... rest of existing startPhase logic unchanged ...
  }
```

### 2. Expand Loop on Phase Completion

**File: `server/tadpole-server.ts` (in `handlePhaseComplete()` method)**

Add loop expansion logic after phase completes:

```typescript
  private async handlePhaseComplete(exitCode: number): Promise<void> {
    // ... existing completion logic ...

  // NEW: Check if this phase is part of a loop
  const currentIndex = this.executionPlan.findIndex(e => e.phaseId === this.currentPhase!.phase.id);

  // Delegate to planner for expansion decision
  this.executionPlan = this.planner.expandNextIteration(
    this.executionPlan,
    currentIndex
  );

  // ... rest of existing completion logic ...
}
```

**Note:** All the complex loop logic is in `ExecutionPlanner.expandNextIteration()`. The server just calls it.

### 3. Handle Context Exhaustion

**File: `server/tadpole-server.ts` (in error handling or log parser event handling)**

Detect when Claude signals context exhaustion and handle loop termination:

```typescript
private async handleContextExhaustion(phaseId: PhaseId): Promise<void> {
  const entry = this.executionPlan.find(e => e.phaseId === phaseId);

  if (entry?.loopContext) {
    // We're in a loop with contextExceeded termination
    const { loopId } = entry.loopContext;
    const loopConfig = this.config.phases.find(
      (c) => c.type === "loop" && c.id === loopId
    ) as Loop | undefined;

    if (loopConfig && loopConfig.terminateOn.type === "contextExceeded") {
      this.logger.log(`Context exhausted in loop '${loopConfig.id}', terminating loop gracefully`);

      // Find the first phase of this loop (iteration 0, phase 0)
      const loopStartPhase = this.executionPlan.find(e =>
        e.loopContext?.loopId === loopId &&
        e.loopContext?.iteration === 0 &&
        e.loopContext?.phaseIndexInLoop === 0
      );

      if (loopStartPhase) {
        // Rollback to before the loop started
        // This preserves session continuity for phases after the loop
        await this.rollbackToPhase(
          loopStartPhase.phaseId,
          "workspace-setup", // Or appropriate checkpoint
          true // autoRestart
        );

        // After rollback, remove all future iterations from execution plan
        // The loop will not expand further - it's terminated
        return;
      }
    }
  }

  // If not in a loop or different termination type, handle as normal error
  await this.handlePhaseFailure(/* ... */);
}
```

**When to call this:**

- Detect in log parser when Claude returns context exhaustion error
- Or when API returns 400 with context length exceeded
- Trigger `handleContextExhaustion()` instead of normal failure flow

**See also:** Step 5 "Special Case: Context Exhaustion During Loops"

## Step 5: Resume Path (Missing from Original Plan)

**File: `server/tadpole-server.ts` (in `start()` method, around line 407)**

Add explicit resume logic to handle crash recovery:

```typescript
async start(): Promise<void> {
  // ... proxy, checkpoints, state manager init (lines 312-339) ...

  const thread = await this.stateManager.getExecutionThread();

  if (thread?.failed) {
    // Rollback case (existing code)
    await this.rollbackToLastSuccess(this.config.autostart);
  }

  // NEW: Add explicit resume path for crashed runs
    const currentRun = this.stateManager.getCurrentRun();

  if (currentRun && currentRun.status === "running") {
    // Resuming from crash - rebuild execution plan from state
    this.currentRunId = currentRun.runId;
    this.executionPlan = this.planner.rebuildFromState(currentRun);
    this.logger.log(
      `Resumed run ${this.currentRunId}, reconstructed execution plan from state`
    );
  } else if (!this.currentRunId) {
    // Fresh start - build initial plan
    await this.startNewRun();  // This calls planner.buildInitialPlan()
  }

  // ... rest of startup (websocket server, etc.) ...
}
```

**Why this is needed:**

- Original plan only handles rollback (when thread.failed)
- Doesn't handle resume from crash (run.status === "running" but server restarted)
- `rebuildFromState()` reconstructs execution plan from persisted loop context

### Special Case: Context Exhaustion During Loops

**Scenario:** A loop with `terminateOn: { type: "contextExceeded" }` hits Claude's context limit mid-iteration.

**Detection points:**

- Claude CLI signals context exhaustion in logs
- API returns 400 error with "context_length_exceeded"
- Detected in `ClaudeLogParser` or error handling

**Behavior when detected:**

1. **Preserve session IDs:** Keep all session IDs from loop iterations for resume capability
2. **Rollback to loop start:** Find the checkpoint before iteration #1 began
3. **Terminate loop:** Remove all loop iterations from execution plan
4. **Continue workflow:** Resume with the phase immediately after the loop
5. **Maintain session:** The next phase can `continue-previous` from before the loop started

**Why rollback to loop start:**

- The loop's iterations consumed context but didn't complete the loop goal
- Rolling back preserves the session from before the loop for subsequent phases
- Completed iterations are still in state history (preserved for debugging)
- Subsequent phases get a clean session without the loop's context overhead

**Implementation:** See Step 4.3 "Handle Context Exhaustion" for the `handleContextExhaustion()` method.

**Example execution flow:**

```
Initial plan: [setup, review#0, refine#0, finalize]
After iteration 0: [setup, review#0 ✓, refine#0 ✓, review#1, refine#1, finalize]
After iteration 1: [setup, ..., review#1 ✓, refine#1 ✓, review#2, refine#2, finalize]
Context exhausted during review#2:
  → Rollback to checkpoint before review#0
  → Remove all loop phases from plan
  → New plan: [setup, finalize]
  → Continue with finalize using session from setup
```

**Key insight:** Context exhaustion is a **graceful loop termination**, not a failure. The workflow continues after the loop with preserved session state.

## Step 6: State Changes

**File: `server/types/state-types.ts`**

Add loop context to all phase states:

```typescript
interface BasePhase {
  phaseId: PhaseId;
  startTime: string;

  // NEW: Loop context for phases within loops
  /**
   * If this phase is part of a loop, track loop context.
   * Used for rollback/resume to reconstruct execution plan.
   */
  loopContext?: {
    loopId: PhaseId; // ID of the loop this phase belongs to
    iteration: number; // Which iteration (0-indexed: 0 = first, 1 = second, etc.)
    phaseIndexInLoop: number; // Position within loop.phases array
  };
}
```

### Update State Transitions

**File: `server/state-manager.ts` (or wherever PhaseStarted transition is handled)**

Store loop context when phase starts:

```typescript
this.stateManager.transition({
  type: "PhaseStarted",
  data: {
    runId: this.currentRunId,
    phaseId: entry.phaseId, // Generated ID like "review#0", "review#1"
    loopContext: entry.loopContext, // NEW: Store loop context
  },
});
```

This allows `rebuildFromState()` to know:

- Which loop this phase came from
- Which iteration we're in
- Where in the iteration we are

## Step 7: Add Loop Events

**File: `server/schemas/event-schemas.ts`**

Add new event types for loop observability and monitoring:

### New Event Schemas

```typescript
// Loop iteration completed event data
export const loopIterationCompletedEventDataSchema = z.object({
  loopId: z.string(), // ID from config (e.g., "review-loop")
  loopName: z.string(), // Human-readable name
  iteration: z.number(), // Which iteration just completed (0-indexed: 0 = first, 1 = second, etc.)
  totalIterations: z.number().optional(), // Total if iterationLimit, undefined if contextExceeded
  phasesInIteration: z.array(z.string()), // Phase IDs that were part of this iteration
  iterationCost: z.number(), // Cost of this iteration
  iterationDuration: z.number(), // Duration in milliseconds
});

// Loop terminated event data
export const loopTerminatedEventDataSchema = z.object({
  loopId: z.string(),
  loopName: z.string(),
  completedIterations: z.number(), // How many iterations completed
  terminationReason: z.enum([
    "iterationLimit", // Completed all planned iterations
    "contextExceeded", // Hit context limit
    "budgetExhausted", // Future: hit budget limit
  ]),
  totalCost: z.number(), // Total cost across all iterations
  totalDuration: z.number(), // Total duration in milliseconds
  wasRolledBack: z.boolean(), // True if terminated via context exhaustion + rollback
});

// Full event schemas
export const loopIterationCompletedEventSchema = baseEventSchema.extend({
  type: z.literal("loop.iteration.completed"),
  data: loopIterationCompletedEventDataSchema,
});

export const loopTerminatedEventSchema = baseEventSchema.extend({
  type: z.literal("loop.terminated"),
  data: loopTerminatedEventDataSchema,
});
```

### Add to ServerEvent Union

```typescript
// In the ServerEvent union type
export type ServerEvent =
  | ServerReadyEvent
  | StateSnapshotEvent
  // ... existing events ...
  | LoopIterationCompletedEvent // NEW
  | LoopTerminatedEvent // NEW
  | StateTransitionEvent;
```

### Add to Event Categorization

```typescript
// In isServerStateEvent() function
export function isServerStateEvent(event: ServerEvent): boolean {
  return (
    event.type === "server.ready" ||
    event.type === "state.snapshot" ||
    event.type === "phase.started" ||
    event.type === "phase.completed" ||
    event.type === "loop.iteration.completed" ||  // NEW
    event.type === "loop.terminated" ||           // NEW
    // ... rest of server state events
  );
}
```

### Emit Loop Events in TadpoleServer

**File: `server/tadpole-server.ts`**

#### 1. Emit `loop.iteration.completed` after iteration finishes

```typescript
// In handlePhaseComplete(), after checking isLastPhaseInIteration
if (isLastPhaseInIteration) {
  // Calculate iteration metrics
  const iterationPhases = currentRun.phases.filter(
    (p) =>
      p.loopContext?.loopId === loopConfig.id &&
      p.loopContext?.iteration === iteration
  );

  const iterationCost = iterationPhases.reduce(
    (sum, p) => sum + getPhaseCost(p),
    0
  );
  const iterationStart = iterationPhases[0]?.startTime;
  const iterationEnd = iterationPhases[iterationPhases.length - 1]?.endTime;
  const iterationDuration =
    iterationStart && iterationEnd
      ? new Date(iterationEnd).getTime() - new Date(iterationStart).getTime()
      : 0;

  // Emit iteration completed event
  const loopIterationEvent: LoopIterationCompletedEvent = {
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "loop.iteration.completed",
    data: {
      loopId: loopConfig.id,
      loopName: loopConfig.name,
      iteration,
      totalIterations:
        loopConfig.terminateOn.type === "iterationLimit"
          ? loopConfig.terminateOn.limit
          : undefined,
      phasesInIteration: iterationPhases.map((p) => p.phaseId),
      iterationCost,
      iterationDuration,
    },
  };

  this.emit("event", loopIterationEvent);

  // Check termination
  const shouldContinue = this.planner.shouldContinueLoop(loopConfig, iteration);

  if (!shouldContinue) {
    // Calculate total loop metrics
    const allLoopPhases = currentRun.phases.filter(
      (p) => p.loopContext?.loopId === loopConfig.id
    );

    const totalCost = allLoopPhases.reduce(
      (sum, p) => sum + getPhaseCost(p),
      0
    );
    const loopStart = allLoopPhases[0]?.startTime;
    const loopEnd = allLoopPhases[allLoopPhases.length - 1]?.endTime;
    const totalDuration =
      loopStart && loopEnd
        ? new Date(loopEnd).getTime() - new Date(loopStart).getTime()
        : 0;

    // Emit loop terminated event
    const loopTerminatedEvent: LoopTerminatedEvent = {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "loop.terminated",
      data: {
        loopId: loopConfig.id,
        loopName: loopConfig.name,
        completedIterations: iteration,
        terminationReason:
          loopConfig.terminateOn.type === "iterationLimit"
            ? "iterationLimit"
            : "contextExceeded",
        totalCost,
        totalDuration,
        wasRolledBack: false,
      },
    };

    this.emit("event", loopTerminatedEvent);
    this.logger.log(
      `Loop '${loopConfig.id}' completed all ${iteration} iterations`
    );
  }
}
```

#### 2. Emit `loop.terminated` in context exhaustion handler

```typescript
// In handleContextExhaustion(), after rollback
this.emit("event", {
  id: EventId(generateId()),
  timestamp: new Date().toISOString(),
  type: "loop.terminated",
  data: {
    loopId: loopConfig.id,
    loopName: loopConfig.name,
    completedIterations: lastCompletedIteration,
    terminationReason: "contextExceeded",
    totalCost: calculateLoopCost(loopId),
    totalDuration: calculateLoopDuration(loopId),
    wasRolledBack: true, // Important: indicates cleanup happened
  },
});
```

### Benefits

**For clients/UIs:**

- Can display "Iteration 3 of 5 completed" (iteration 2, which is the 3rd iteration) directly
- Show per-iteration progress bars
- Display loop-level metrics without manual aggregation
- Distinguish normal completion from context exhaustion

**For debugging:**

- Clear visibility into loop lifecycle
- Easy to identify which loops are expensive
- Track iteration-level performance

**Consistent with Tadpole patterns:**

- Follows same granular event philosophy as rollback.\* events
- Server State events (journaled and broadcast to all clients)

## Step 8: Update execution-thread.ts

**File: `server/execution-thread.ts`**

Modify to accept execution plan instead of nested config:

```typescript
// OLD signature:
export async function analyzeExecutionThread(
  state: TadpoleState,
  phaseConfigs: PhaseConfig[],  // ← Nested structure (may have loops)
  checkpointData?: Map<...>,
  targetRunId?: RunId,
  logger?: Logger,
)

// NEW signature:
export async function analyzeExecutionThread(
  state: TadpoleState,
  executionPlan: ExecutionPhaseEntry[],  // ← Flat structure (loops already expanded)
  checkpointData?: Map<...>,
  targetRunId?: RunId,
  logger?: Logger,
)
```

### Update Next Phase Calculation

**Location: Around line 272 in `analyzeExecutionThread()` function**

```typescript
// OLD:
const phaseConfigIndex = phaseConfigs.findIndex(
  (c) => c.id === latestPhase.phase.phaseId
);
if (phaseConfigIndex >= 0 && phaseConfigIndex < phaseConfigs.length - 1) {
  nextPhaseId = phaseConfigs[phaseConfigIndex + 1].id as PhaseId;
}

// NEW:
const entryIndex = executionPlan.findIndex(
  (e) => e.phaseId === latestPhase.phase.phaseId
);
if (entryIndex >= 0 && entryIndex < executionPlan.length - 1) {
  nextPhaseId = executionPlan[entryIndex + 1].phaseId;
}
```

**Similar changes needed in other locations:**

- Fresh run start logic (~line 317)
- Workspace-setup continuation logic (~line 310)
- All places that index into `phaseConfigs`

### Update StateManager Call

**File: `server/state-manager.ts` (in `getExecutionThread()` method)**

```typescript
// OLD:
async getExecutionThread(): Promise<ExecutionThread> {
  return analyzeExecutionThread(
    this.state,
    this.phaseConfigs || [],  // ← Nested configs
    // ...
  );
}

// NEW:
async getExecutionThread(): Promise<ExecutionThread> {
  // Get execution plan from TadpoleServer
  // This requires either:
  // 1. Pass executionPlan to StateManager from TadpoleServer, OR
  // 2. Make StateManager build its own plan using ExecutionPlanner

  // Recommended: StateManager should not own planning logic
  // Instead, TadpoleServer should pass executionPlan when calling getExecutionThread()
}
```

**Alternative approach - pass execution plan from TadpoleServer:**

```typescript
// In TadpoleServer
const thread = await this.stateManager.getExecutionThread(this.executionPlan);

// In StateManager
async getExecutionThread(executionPlan: ExecutionPhaseEntry[]): Promise<ExecutionThread> {
  return analyzeExecutionThread(
    this.state,
    executionPlan,  // ← Flat plan from server
    // ...
  );
}
```

**Why this works:**

- `executionPlan` is already flat (loops expanded by ExecutionPlanner)
- Execution thread just finds next entry in the sequence
- No need for execution-thread.ts to understand loop structure
- Keeps loop logic isolated in ExecutionPlanner

## Future: Budget System

**This section documents how the budget system will integrate when implemented later.**

### Overview

Allow setting global budgets (tokens or time) with weight-based allocation to phases and loops. Phases terminate early if budget exceeded.

### Schema Extensions (v2)

```typescript
// Add to LoopTermination
export type LoopTermination =
  | { type: "iterationLimit"; limit: number }
  | { type: "contextExceeded" }
  | { type: "budgetExhausted"; budget: number; budgetType: "tokens" | "time" }; // NEW

// Add to Phase
export interface Phase {
  // ... existing fields ...
  weight?: number; // Default: 1, for budget allocation
}

// Add to Loop
export interface Loop {
  // ... existing fields ...
  weight?: number; // Default: sum of child weights * iteration limit
  budgetMode?: "divide" | "pool"; // Default: "pool"
}

// Add to ServerConfig
export interface ServerConfig {
  // ... existing fields ...
  budget?: {
    type: "tokens" | "time";
    limit: number;
    enforceMode: "soft" | "hard"; // soft = warn, hard = terminate
  };
}
```

### Budget Modes

**"divide" mode:** Split budget evenly across iterations

```
Loop budget: 1000 tokens
Iterations: 3
Per-iteration budget: 333 tokens
```

**"pool" mode (default):** Share budget pool across iterations

```
Loop budget: 1000 tokens
Iteration 0 uses: 400 tokens (600 remaining)
Iteration 1 uses: 450 tokens (150 remaining)
Iteration 2 terminates early: not enough budget
```

### Why Flattening Makes This Easy

Because loops flatten to individual phases with unique IDs:

1. Each `review#0`, `review#1` tracks its own cost
2. Loop budget is just sum of iteration costs
3. Budget enforcement happens at phase level (existing code path)
4. No special loop-aware budget tracking needed

### Implementation Notes

- Budget allocation happens in `ExecutionPlanner.buildInitialPlan()`
- Budget checking happens in `handlePhaseComplete()`
- The flattening approach makes budgets straightforward

**Example:**

```typescript
// In ExecutionPlanner
function allocateBudget(plan: ExecutionPhaseEntry[], globalBudget: number) {
  const totalWeight = plan.reduce((sum, e) => sum + (e.phase.weight ?? 1), 0);

  for (const entry of plan) {
    const weight = entry.phase.weight ?? 1;
    entry.budget = (weight / totalWeight) * globalBudget;
  }
}
```

## Implementation Order

Follow these steps in sequence:

1. **Schema changes** (Step 1)

   - Update `server/config.ts` with Phase/Loop schemas
   - Update `server/types/types.ts` with type definitions
   - Prevent nested loops in schema

2. **Config loading and workspace setup** (Step 2 & 2a)

   - Add recursive path resolution for loops
   - Update error messages to include loop context
   - Add `allowFailure` flag to workspace setup schema
   - Remove workspace setup restrictions for loop phases
   - Add validation warnings for loop phases without `allowFailure`
   - Update workspace setup execution to respect `allowFailure` flag
   - Update tests for new workspace setup behavior

3. **Extract ExecutionPlanner** (Step 3)

   - Create `server/execution-planner.ts`
   - Implement `buildInitialPlan()`, `rebuildFromState()`, `expandNextIteration()`
   - Add plan validation

4. **Update TadpoleServer** (Step 4)

   - Add `planner` and `executionPlan` fields
   - Modify `startPhase()` to use execution plan
   - Add loop expansion in `handlePhaseComplete()`
   - Add context exhaustion handler for loops

5. **Add resume path** (Step 5)

   - Update `start()` method to handle crash recovery
   - Call `planner.rebuildFromState()` for resumed runs

6. **State changes** (Step 6)

   - Add `loopContext` to `BasePhase` in state-types.ts
   - Update `PhaseStarted` transition to store loop context

7. **Add loop events** (Step 7)

   - Add event schemas to `event-schemas.ts`
   - Add to ServerEvent union type
   - Add to event categorization (isServerStateEvent)
   - Emit events in `handlePhaseComplete()` and `handleContextExhaustion()`

8. **Update execution-thread** (Step 8)

   - Change signature to accept `executionPlan` instead of `phaseConfigs`
   - Update next phase logic to use flat plan
   - Update StateManager to pass execution plan

9. **Testing** (see Testing section below)

   - Unit tests for ExecutionPlanner
   - Integration tests for loop execution
   - E2E tests for full workflows

10. **Documentation**

    - Update phase configuration guide
    - Add loop examples to README
    - Document loop behavior in architecture docs

## Testing

### Unit Tests

**New file: `tests/unit/execution-planner.test.ts`**

Test the pure planning logic:

```typescript
- buildInitialPlan() expands only first iteration (iteration 0)
- buildInitialPlan() handles mixed phases and loops
- expandNextIteration() adds next iteration correctly
- expandNextIteration() stops at iteration limit
- rebuildFromState() reconstructs from mid-loop
- rebuildFromState() handles multiple loops in config
- validatePlan() catches duplicate IDs
- validatePlan() catches invalid loop contexts
- shouldContinueLoop() evaluates iterationLimit correctly (0-indexed)
```

**Update existing file: `tests/unit/event-schemas.test.ts`**

Test new event schemas:

```typescript
- loopIterationCompletedEventSchema validates correctly
- loopTerminatedEventSchema validates correctly
- ServerEvent union includes loop events
- isServerStateEvent returns true for loop events
```

### Integration Tests

**New file: `tests/integration/loop-execution.test.ts`**

Test loop execution with state and events:

```typescript
- Simple 3-iteration loop completes all iterations
- Loop events emitted correctly (iteration.completed, terminated)
- Iteration metrics calculated correctly (cost, duration)
- contextExceeded terminates loop early with rollback
- contextExceeded emits loop.terminated with wasRolledBack=true
- Resume from crash at iteration 3 of 5
- Rollback to phase inside loop iteration 2
- continue-previous works across loop iterations
- Loop termination reason recorded correctly in event
- Workspace setup in loop phase with allowFailure=true continues on error
- Workspace setup in loop phase with allowFailure=false fails on error
- Workspace setup checkpoint created correctly in loop iterations
```

### E2E Tests

**New file: `tests/e2e/loops-e2e.test.ts`**

Test complete loop workflows end-to-end:

```typescript
- Full loop workflow with real Claude execution (mocked)
- Loop termination conditions evaluated correctly
- State persists correctly mid-loop
- Resume reconstructs execution plan correctly
- Loop events received by WebSocket clients
- loop.iteration.completed event includes correct metrics
- loop.terminated event emitted for both normal and context exhaustion
- Multiple clients receive loop events (Server State event broadcasting)
```

## Summary of Key Decisions

### What's New vs Original Plan

**Architecture changes:**

- ✅ Extracted `ExecutionPlanner` to separate module (addresses tadpole-server.ts size)
- ✅ Added explicit resume path for crash recovery (was missing)
- ✅ Added loop events for observability (loop.iteration.completed, loop.terminated)
- ✅ Added context exhaustion handling with graceful loop termination

**Naming changes:**

- ✅ `Phase` and `Loop` instead of `SinglePhaseConfig` and `LoopPhaseConfig`
- ✅ Schema updated to use shorter, cleaner names

**Implementation additions:**

- ✅ Plan validation in ExecutionPlanner
- ✅ Nested loop prevention at schema level (type-safe)
- ✅ Context exhaustion as graceful termination (not failure)
- ✅ Loop event categorization as Server State events

### Unchanged from Original Plan

- ✅ Lazy expansion approach (expand first iteration, add more as needed)
- ✅ Generated phase IDs with iteration suffix (`review#0`, `review#1`)
- ✅ `loopContext` stored in state per phase
- ✅ Two-array architecture (config.phases + executionPlan)
- ✅ Loop logic isolated from existing phase execution code

### Future Extensions Documented

- 📋 Budget system (tokens/time limits with weight-based allocation)
- 📋 Budget modes ("divide" vs "pool" for loop budgets)
- 📋 Nested loops (can be added in v2 if needed)

## References

- **Current phase system:** See `documentation/phase-system.md`
- **State management:** See `server/state-manager.ts`
- **Execution thread:** See `server/execution-thread.ts`
- **Config validation:** See `server/config.ts`
- **Event schemas:** See `server/schemas/event-schemas.ts`
