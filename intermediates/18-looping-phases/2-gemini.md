# Architectural Design and Implementation Plan: Looping Phases

This document outlines the design and step-by-step plan for implementing a looping phase feature in Tadpole. The feature will allow users to define a sequence of phases and execute it a specified number of times.

## 1. Feature Analysis

The core requirement is to allow a set of one or more phases to be repeated `n` times. This introduces a non-linear execution flow that the current system, designed for a simple sequential progression of phases, does not support.

Key considerations:
- **Configuration:** How will users define a loop in `phases.json`? It must be intuitive and integrate with the existing structure.
- **State Management:** How will the application's state track the progress of a loop (e.g., the current iteration)?
- **Execution Logic:** How will the `ExecutionThread` determine the next phase to run when dealing with loops?
- **Context Continuity:** How will `continue-previous` work across loop iterations?

## 2. Proposed Architecture

I propose a solution centered around introducing a new explicit `loop` type into the phase configuration. This approach is favored for its clarity, scalability, and ease of validation over alternatives that would involve adding special properties to existing phase structures.

### 2.1. Configuration Schema (`phases.json`)

A new `loop` object will be added to the top-level phase array. This object will contain the phases to be looped and the iteration count.

```json
[
  {
    "id": "phase-1-setup",
    "name": "Initial Setup",
    "model": "sonnet",
    "continuationMode": "fresh",
    "promptText": "Set up the project structure."
  },
  {
    "type": "loop",
    "id": "iterative-development-loop",
    "count": 3,
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
  },
  {
    "id": "phase-3-cleanup",
    "name": "Final Cleanup",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "All iterations are complete. Refactor and clean up the entire feature."
  }
]
```

**Design Rationale:**
- **Explicitness:** The `type: "loop"` declaration makes the configuration's intent clear.
- **Encapsulation:** The loop and its constituent phases are grouped, making the structure easy to read and manage.
- **Scalability:** This design can be extended in the future to support other loop types (e.g., `while`, `until`) by changing the loop's properties.

### 2.2. State Management (`server/types/state-types.ts`)

To track loop executions, the `PhaseExecution` state will be augmented with an optional `loopContext`.

```typescript
// In server/types/state-types.ts

interface LoopContext {
  /** The ID of the loop block from the configuration. */
  loopId: string;
  /** The 1-based index of the current iteration. */
  iteration: number;
}

// Add to BasePhase to ensure all phase states can have this context
interface BasePhase {
  phaseId: PhaseId;
  startTime: string;
  /** Context if the phase is part of a loop execution. */
  loopContext?: LoopContext;
}
```

This allows any part of the system that inspects a `PhaseExecution` object to know if it was part of a loop and which iteration it belonged to.

### 2.3. Execution Logic (`server/execution-thread.ts`)

The `ExecutionThread` is the core of the change. It must be updated to navigate the nested loop structure. The current implementation assumes a flat array of phases; this will be refactored.

A helper function will be created to "flatten" the phase configuration into a logical sequence, while retaining the loop metadata for each phase.

**`getNextPhaseId` Logic:**
The logic for determining the next phase will be significantly updated:
1.  Identify the most recently executed phase.
2.  If it was part of a loop:
    a.  Check if it was the last phase in the iteration.
    b.  If yes, check if `current_iteration < loop_count`.
        i.  If yes, the next phase is the *first* phase of the loop, with `iteration` incremented.
        ii. If no, the loop is finished. The next phase is the one following the `loop` block in the configuration.
    c.  If no, the next phase is simply the next phase within the current loop iteration.
3.  If it was not part of a loop, the logic proceeds as it does now, but it must be able to enter a loop if the next item in the config is a `loop` block.

**`findContinuationSessionId` Logic:**
This function must also be updated. When the first phase of a loop iteration (where `iteration > 1`) requests `continue-previous`, the predecessor is the *last* phase of the *previous* iteration. The function will need to traverse the `ExecutionThread`'s phase history to find the correct preceding phase execution.

## 3. Step-by-Step Implementation Plan

1.  **Update Type Definitions:**
    - Modify `server/types/types.ts` (or equivalent) to define `PhaseConfig` as a discriminated union that includes the existing phase structure and the new `LoopConfig` type.
    - Add the `loopContext` to the `BasePhase` interface in `server/types/state-types.ts`.

2.  **Update Config Loading and Validation:**
    - In `server/config.ts`, update the configuration loader to parse and validate the new `loop` structure.
    - The validator must check for a positive `count`, a non-empty `phases` array within the loop, and reject nested loops for the initial implementation.

3.  **Refactor `ExecutionThread`:**
    - This is the most substantial task. In `server/execution-thread.ts`:
    - Create a utility that traverses the `phaseConfigs` and produces a flat, ordered list of all executable phases, with each phase object annotated with its `loopContext` if applicable.
    - Rewrite the core loop in `analyzeExecutionThread` that determines `nextPhaseId` to correctly handle transitions into, within, and out of loops.
    - Update `findContinuationSessionId` to correctly identify the predecessor phase across loop iteration boundaries.

4.  **Update State Manager:**
    - When a `PhaseStarted` event is dispatched, the logic that creates the initial `PreparingPhase` object must be updated. It will receive the `loopContext` (if any) from the `ExecutionThread`'s determination and include it in the new phase's state.

5.  **Write Tests:**
    - **Unit Tests:** Add a new test file or suite in `tests/unit/` for `execution-thread.test.ts` that specifically targets loop logic.
        - Test starting a loop.
        - Test transitioning between phases inside an iteration.
        - Test `continue-previous` on the first phase of a new iteration.
        - Test completing the final iteration and exiting the loop.
        - Test rollback to a phase within a loop.
    - **End-to-End Tests:** Create a new test file in `tests/e2e/`.
        - Create a `looping-phases.config.json` with a representative loop.
        - Write a test that runs the server with this config and asserts that the phases execute the correct number of times and in the correct order.
        - Verify that `continue-previous` maintains context across iterations.

## 4. Summary of Affected Files

- **`server/types/types.ts`**: Configuration type definitions.
- **`server/types/state-types.ts`**: State structure definitions.
- **`server/config.ts`**: Configuration loading and validation.
- **`server/execution-thread.ts`**: Core execution logic.
- **`server/state-manager.ts`**: State transition handling.
- **`tests/unit/execution-thread.test.ts`**: New unit tests.
- **`tests/e2e/looping-phases.e2e.test.ts`**: New E2E test (new file).
- **`tests/config/looping-phases.config.json`**: New test config (new file).

This plan provides a clear path forward for implementing the looping phases feature in a robust and scalable manner.
