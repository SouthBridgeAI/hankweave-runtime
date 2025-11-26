# Plan for Handling "Context Exceeded" Events

This document outlines a detailed plan to implement robust handling for "context exceeded" events within the Tadpole server, focusing on looping phases as the primary use case.

## 1. Core Concepts & Goals

The primary objective is to gracefully handle "context exceeded" errors from the LLM. Instead of treating it as a hard failure, the system will recognize it as a potential termination condition for certain phases, particularly loops.

-   **Loop Termination:** A loop can be configured to terminate successfully upon a `contextExceeded` event.
-   **State Management:** The `StateManager` will be the central orchestrator for handling this event and transitioning the system state appropriately.
-   **Error Handling:** If a `contextExceeded` event occurs outside of a phase configured to handle it, it will be treated as a fatal error.
-   **Session Refresh:** Upon successful termination of a loop due to `contextExceeded`, subsequent phases will run in a new, clean LLM session to avoid carrying over the large context.

## 2. Implementation Plan

The implementation will be broken down into the following phases:

### Phase 1: Event and State Infrastructure

1.  **Define a New State Manager Event:**
    -   In `server/state-manager.ts`, introduce a new event type to signal context exhaustion.
    -   We will add a new method `handleContextExceeded(phaseId: string)` to the `StateManager`.

2.  **Update `TadpoleServer` to Dispatch the Event:**
    -   Modify `server/tadpole-server.ts`.
    -   The existing logic that detects `isContextExceeded` will be updated to call the new `stateManager.handleContextExceeded(phaseId)` method instead of just logging an error.

    ```typescript
    // server/tadpole-server.ts (conceptual change)
    if (isContextExceeded(msg as ClaudeLogMessage)) {
      this.logger.log(
        `[TADPOLE-SERVER] Context exceeded error detected for phase ${phaseId}`,
        "info",
      );
      // New implementation: notify the state manager
      this.stateManager.handleContextExceeded(phaseId);
    }
    ```

### Phase 2: StateManager Logic

1.  **Implement `handleContextExceeded` in `StateManager`:**
    -   This new method in `server/state-manager.ts` will contain the core logic.
    -   It must retrieve the configuration for the currently active phase (`phaseId`).
    -   It will check if the phase is a loop and if its `terminateOn` array includes the string `"contextExceeded"`.

2.  **Conditional State Transitions:**
    -   **Success Case (Loop Termination):**
        -   If `terminateOn` includes `"contextExceeded"`, the `StateManager` will:
            1.  Transition the current looping phase to `completed`.
            2.  Emit a client-facing event, such as `PhaseCompleted`, with a reason indicating context exhaustion.
            3.  Signal the `ExecutionThread` to proceed to the next phase in the execution plan.
            4.  As part of proceeding, instruct the `ExecutionThread` to request a fresh session.
    -   **Error Case:**
        -   If the event occurs in a phase *not* configured to handle it, the `StateManager` will:
            1.  Transition the system to a `fatal_error` state.
            2.  Emit a `FatalError` event with details about the unexpected context exhaustion.

### Phase 3: Fresh Session Management

1.  **Introduce a "Fresh Session" Mechanism:**
    -   A mechanism will be added to `server/claude-process-manager.ts` to provide a new, clean session. This could be a new method like `startNewSession(): Promise<string>`. This would effectively kill the old claude process and start a new one, returning the new session ID.
    -   The `ExecutionThread` will be updated to call this method when beginning a phase that requires a fresh start.

2.  **Triggering the Session Refresh:**
    -   When the `StateManager` handles a successful `contextExceeded` termination, it will set a flag or pass an option to the `ExecutionThread` for the next phase execution.
    -   The `ExecutionThread`, before executing the next phase, will check for this flag and, if present, call `claudeProcessManager.startNewSession()` and use the new session ID for all subsequent LLM interactions.

### Phase 4: Client-Facing Notifications

1.  **Define a New Client Event:**
    -   To provide better observability for clients, we will consider adding a specific event like `PhaseTerminatedOnContextExceeded`.
    -   This event will be emitted by the `StateManager` in the success case. It will carry the `phaseId`. This allows the UI to show not just that a loop finished, but *why* it finished.

### Phase 5: Testing Strategy

1.  **Unit & Integration Tests (`StateManager`):**
    -   Location: `tests/unit/state-manager.test.ts` (or a new dedicated file).
    -   **Test 1 (Success):**
        -   Mock an execution plan with a looping phase where `terminateOn: ['contextExceeded']`.
        -   Set the `StateManager` to be in this active phase.
        -   Call `stateManager.handleContextExceeded()`.
        -   Assert that the phase state transitions to `completed`.
        -   Assert that the `ExecutionThread` is called to proceed.
        -   Assert that the "fresh session" mechanism is invoked.
    -   **Test 2 (Error):**
        -   Mock an execution plan *without* `contextExceeded` in `terminateOn`.
        -   Set the `StateManager` to be in this active phase.
        -   Call `stateManager.handleContextExceeded()`.
        -   Assert that the system state transitions to `fatal_error`.

2.  **End-to-End Tests (`long-running`):**
    -   Location: `tests/long-running/context-exceeded.test.ts`.
    -   This test will construct a phase plan designed to fail.
    -   **Mocking the LLM:** The test will need to mock the output from the `claude-process` to include the specific "context exceeded" error message that `isContextExceeded` detects. This is the most critical part of the e2e test setup.
    -   **Test Scenario:**
        1.  Define a phase plan with a loop that has `terminateOn: ['contextExceeded']` and a simple follow-up phase (e.g., a `userInput`).
        2.  The loop's prompt will be irrelevant, as we will mock the response.
        3.  Start the server and run the phase plan.
        4.  In the test, after the loop phase starts, inject a mocked LLM response that triggers the `isContextExceeded` check.
        5.  Assert that:
            -   The server logs the context exceeded event.
            -   The loop phase completes successfully.
            -   A new session is started.
            -   The server transitions to the next `userInput` phase.
            -   The appropriate client-side events are received.
