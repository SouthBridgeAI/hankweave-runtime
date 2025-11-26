# Refined Design for "Context Exceeded" Handling

This document presents a refined architectural design for handling "context exceeded" events, building upon the initial plan and addressing the specific questions raised.

## 1. Architectural Flow

The proposed architecture is centered around a clear separation of concerns: the `TadpoleServer` detects the event, the `StateManager` decides on the outcome, and the `ExecutionThread` enacts the decision.

Here is the step-by-step flow:

1.  **Detection (`TadpoleServer`)**: The `TadpoleServer` monitors the output from the `claude-process`. When its `isContextExceeded()` check returns `true`, it immediately dispatches a dedicated transition event to the `StateManager`.

2.  **Decision (`StateManager`)**: The `StateManager` receives this event and performs the core decision-making logic. It checks if the active phase is configured to handle this event as a valid termination condition.

3.  **Execution (`ExecutionThread`)**: Based on the `StateManager`'s decision, the `ExecutionThread` either proceeds to the next phase (with specific instructions for session handling) or halts execution.

## 2. Answering Design Questions

Let's address each point from the prompt.

### Point 1: Handling `continuePrevious` After Context Exhaustion

> Should "continue-previous" be invalid when defining phases where previous loop "terminatesOn" with context exceeded?

**Yes, it's implicitly invalid.** Continuing a session that has run out of context is not possible.

**Design:** Instead of relying on ahead-of-time validation, we will handle this at runtime.

-   When the `StateManager` successfully terminates a loop due to `contextExceeded`, it will instruct the `ExecutionThread` to start the *next* phase with a **`forceNewSession: true`** flag.
-   The `ExecutionThread`, upon receiving this flag, will **ignore** the `continuePrevious: true` setting of the upcoming phase and explicitly start a new session by calling `claudeProcessManager.spawn(..., null, ...)`.
-   A warning should be logged to inform the developer that `continuePrevious` was overridden due to the preceding context exhaustion. This provides a robust, self-correcting mechanism.

### Point 2: Expressing "Context Exceeded" as a State Transition

> On the state manager level, can we express "context exceeded" using transition...

**Yes, this is the ideal approach.** It aligns perfectly with the existing event-driven architecture of the `StateManager`.

**Design:**

-   The `TadpoleServer`, upon detection, will call:
    ```typescript
    // in tadpole-server.ts
    this.stateManager.transition({
        type: "ContextExceeded", 
        data: {
            runId: this.currentRunId,
            phaseId: PhaseId(phaseId), // The ID of the phase where context was exceeded
        },
    });
    ```
-   The `StateManager`'s main reducer will have a `case` for the `"ContextExceeded"` type. This keeps the logic centralized and predictable.

### Point 3: Simplifying Fresh Session Creation

> As far as claude process manager is concerned, maybe we do not need to introduce a new method for "fresh session", we just call spawn again without session id...

**Correct, no new method is needed.** Reusing the existing `spawn` method is cleaner and more elegant.

**Design:**

-   A "fresh session" is functionally equivalent to calling `claudeProcessManager.spawn(phase, null, logPath)`.
-   The `ExecutionThread`, when it receives the `forceNewSession: true` directive from the `StateManager`, will simply call `spawn` with `previousSessionId` explicitly set to `null`. This cleanly integrates into the existing `ExecutionThread` logic.

### Point 4: A Ground-Up Architectural Plan

Here is the synthesized architecture, incorporating the answers above.

#### **A. `TadpoleServer` (Detector)**

-   **Responsibility**: Detect the `contextExceeded` error message from the running `claude-process`.
-   **Action**: Upon detection, immediately invoke `this.stateManager.transition({ type: "ContextExceeded", ... })`. It does nothing more.

#### **B. `StateManager` (Decider)**

-   **Responsibility**: Process the `ContextExceeded` event and orchestrate the system's response.
-   **Logic within the `transition` handler (case `ContextExceeded`):**
    1.  Get the current state and identify the active phase (`currentPhase`) using the `phaseId` from the event. The `loopContext` on the phase state will be crucial for identifying if we are in a loop.
    2.  **Check Configuration**: Look up the configuration for `currentPhase` (or its parent loop if inside one) and inspect its `terminateOn` array.
    3.  **Decision Branch**:
        -   **If `terminateOn` includes `"contextExceeded"`:**
            -   This is a **successful termination**.
            -   Transition the phase's state to `completed` (with a reason like `CONTEXT_EXCEEDED`).
            -   Emit a `PhaseCompleted` event to the client with the same reason.
            -   Instruct the `ExecutionThread` to proceed to the next phase, passing a `forceNewSession: true` directive.
        -   **Else (not a valid termination condition):**
            -   This is a **fatal error**.
            -   Transition the entire run's state to `fatal_error`.
            -   Emit a `FatalError` event to the client with a descriptive message.

#### **C. `ExecutionThread` (Executor)**

-   **Responsibility**: Execute phases as directed by the `StateManager`.
-   **Enhanced Logic**:
    1.  When instructed to run a phase, it will check for the `forceNewSession` directive from the `StateManager`.
    2.  **If `forceNewSession` is `true`**:
        -   It will call `this.claudeProcessManager.spawn(nextPhase, null)`.
        -   It will log a warning if `nextPhase.continuePrevious` was `true`, noting that the setting was ignored.
    3.  **If `forceNewSession` is `false` or absent** (the default case):
        -   It will proceed with the normal logic, respecting `nextPhase.continuePrevious` and passing the `previousSessionId` as needed.

This design provides a robust, decoupled, and maintainable solution for handling context exhaustion events.
