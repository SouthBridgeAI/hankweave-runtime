# Chronicler Integration Execution Spec

This document outlines the plan for integrating the Chronicler system into the Tadpole Server. The goal is to create a seamless integration that is robust, performant, and aligned with the existing architecture of the Tadpole server.

## 1. Phase Config Loading and Chronicler Initialization

**Goal:** Load and initialize chroniclers on a per-phase basis, driven by the phase configuration.

**Analysis:**

- `TadpoleServer` is the central orchestrator and manages the lifecycle of phases.
- The `startPhase` method in `TadpoleServer` is the entry point for executing a phase. It handles `workspaceSetup` and spawning the Claude process. This is the ideal place to manage the chronicler lifecycle for a phase.
- The `ChroniclerManager` is designed to manage multiple chroniclers and has a `loadChroniclersForPhase` method, which is exactly what we need.
- To manage providers and health checks efficiently, a single `ChroniclerManager` instance should be created per `TadpoleServer` instance. This manager will then be used for all phases, loading and unloading chroniclers as needed.

**Proposed Implementation:**

1.  **Instantiate `ChroniclerManager` in `TadpoleServer`:**

    - In the `TadpoleServer` constructor, create a new instance of `ChroniclerManager`.
    - This will be stored as a private property, e.g., `this.chroniclerManager: ChroniclerManager`.
    - The `ChroniclerManager` constructor will kick off the LLM provider health checks in the background.

    ```typescript:server/tadpole-server.ts
    // ... imports ...
    import { ChroniclerManager } from "./chroniclers/chronicler-manager.js";

    export class TadpoleServer extends TypedEventEmitter<ServerInternalEvents> {
      // ... existing properties ...
      private chroniclerManager: ChroniclerManager;

      constructor(...) {
        // ... existing constructor logic ...
        this.chroniclerManager = new ChroniclerManager({
          logger: this.logger,
          // other options from config
        });
        this.chroniclerManager.initialize(); // Creates .tadpole/chroniclers dir
      }
      // ...
    }
    ```

2.  **Extend Phase Configuration:**

    - Update the `PhaseConfig` type in `server/types/types.ts` to include an optional `chroniclers` property, which will be an array of `ChroniclerConfig`.
    - Update the Zod schema for phase configuration (`server/command-schemas.ts`) to validate the new property.

3.  **Load Chroniclers in `startPhase`:**

    - Inside `TadpoleServer.startPhase`, after the phase object is retrieved and before the Claude process is spawned, check if the phase config has chroniclers defined.
    - If it does, call `this.chroniclerManager.loadChroniclersForPhase(...)`.
    - We will also need a corresponding `shutdown` for the chroniclers of a phase. The `_completePhase` private method in `TadpoleServer` is the perfect place to call `this.chroniclerManager.shutdown()`. This ensures that all buffered chronicler events are processed and resources are cleaned up when a phase ends (either completed, failed, or skipped).

    ```typescript:server/tadpole-server.ts
    private async startPhase(phaseId: PhaseId, skipPreCommands?: boolean): Promise<void> {
      // ... existing logic to get phase config ...

      if (phase.chroniclers) {
        await this.chroniclerManager.loadChroniclersForPhase(
          phase.chroniclers,
          phase.id,
          // ... mock/fallback LLM calls for testing ...
          this.config.configDir,
          this.stateManager.getCurrentRun()?.startTime,
          undefined, // onExecute for tests
          undefined, // mock LLM object call
          this.executionPath // NEW: for path resolution in chroniclers
        );
      }

      // ... rest of startPhase logic ...
    }

    private async _completePhase(
      phaseExecution: PhaseExecution,
      completionType: "completed" | "failed" | "skipped",
    ): Promise<void> {
      // ... existing logic ...

      // Shutdown chroniclers for the phase
      if (this.chroniclerManager) {
        await this.chroniclerManager.shutdown();
      }

      // ... existing logic ...
    }
    ```

**Considerations:**

- **Path Resolution:** Chronicler configs can reference files (e.g., `promptFile`, `schemaFile`). The `loadChroniclersForPhase` method already accepts a `configDirectory` and `executionPath`. We must ensure we pass the correct paths from `TadpoleServer` so that relative paths in chronicler configs are resolved correctly. The `executionPath` should be passed to the `ChroniclerManager` so it can resolve paths relative to the execution directory.

## 2. ChroniclerManager Configuration

**Goal:** Decide how to configure the `ChroniclerManager` and whether to expose these settings in the phase config.

**Analysis:**

- `ChroniclerManagerOptions` includes `waitForHealthChecks`, `healthCheckGracePeriodMs`, and `enablePersistence`.
- These seem like server-level or execution-level settings, not phase-specific ones. Exposing them in each phase config would be verbose and could lead to inconsistent behavior between phases.
- A better approach is to have these as server-wide settings, configured via command-line arguments or a server config file (if one exists in the future).

**Proposed Implementation:**

1.  **Server-level Configuration:**

    - For now, we will use sensible defaults in the `TadpoleServer` constructor when creating the `ChroniclerManager`.
    - We can add command-line arguments to `server/index.ts` to control these settings if needed later.
    - Example defaults:
      - `waitForHealthChecks`: `false` (don't block server startup)
      - `healthCheckGracePeriodMs`: `500` (allow half a second for fast health checks)
      - `enablePersistence`: `true` (always on, unless in a test environment)

    ```typescript:server/tadpole-server.ts
    // In TadpoleServer constructor
    this.chroniclerManager = new ChroniclerManager({
      logger: this.logger,
      healthCheckGracePeriodMs: 500, // Sensible default
    });
    ```

**Conclusion:** Keep `ChroniclerManager` configuration at the server level. Do not add it to the phase configuration.

## 3. Provider and Chronicler Initiation

**Goal:** Ensure providers and chroniclers are initialized correctly.

**Analysis:**

- My proposal in point 1 (creating `ChroniclerManager` in `TadpoleServer` constructor) already handles this.
- The `ChroniclerManager` constructor calls `initializeProviderRegistry`, which starts the async health checks.
- `loadChroniclersForPhase` in `startPhase` handles the creation of individual `Chronicler` instances for that phase.
- The `shutdown` call in `_completePhase` will handle cleanup.

**Proposed Implementation:**

- The implementation described in point 1 is sufficient. No additional changes are needed here. The lifecycle is:
  1.  `TadpoleServer` starts -> `ChroniclerManager` is created -> Provider registry is initialized, health checks start in background.
  2.  Phase starts -> `loadChroniclersForPhase` is called -> Chroniclers for that phase are created.
  3.  Phase ends -> `shutdown` is called -> Chroniclers for that phase are cleaned up.

## 4. Event Handling

**Goal:** Pass events from `TadpoleServer` to the active chroniclers.

**Analysis:**

- `TadpoleServer` uses a typed `EventEmitter`. The central event is `"event"`. All server events are emitted through this.
- The `EventJournal` already subscribes to these events to persist them. We can use the same mechanism.
- We need to subscribe to the `"event"` event and forward the `ServerEvent` object to `this.chroniclerManager.handleEvent(event)`.

**Proposed Implementation:**

1.  **Subscribe to Events in `TadpoleServer`:**

    - In the `TadpoleServer` constructor, after the `chroniclerManager` is created, we'll add a listener.
    - The `ServerInternalEvents` in `typed-event-emitter.ts` is defined as: `"event": (data: { event: ServerEvent; targetClient?: WebSocket | string }) => void;`. The listener will receive an object with an `event` property.

    ```typescript:server/tadpole-server.ts
    // In TadpoleServer constructor
    constructor(...) {
      // ...
      this.chroniclerManager = new ChroniclerManager(...);
      this.chroniclerManager.initialize();

      // Forward events to the chronicler manager
      this.on("event", (eventData) => {
        if (this.chroniclerManager) {
          this.chroniclerManager.handleEvent(eventData.event);
        }
      });
    }
    ```

**Conflict Analysis:**

- The user mentioned a "big refactor" on how events happen. The current system using a typed `EventEmitter` and an `EventJournal` is clean and centralized. The chronicler system was designed to consume `ServerEvent` objects, so it is perfectly compatible with the current event system. I don't foresee any major conflicts. The event schemas are well-defined and validated with Zod, which the chronicler system also uses.

## 5. Increasing the Event Limit

**Goal:** Evaluate if the new event system allows for increasing the event limit for chroniclers.

**Analysis:**

- The current event limit is a performance safeguard within the Eta templating engine in `chronicler.ts` (hardcoded to 1000 events). It's not a limitation of the event system itself.
- The `EventJournal` provides a complete, persisted history of all events. This opens up new possibilities.

**Proposed Implementation / Strategy:**

1.  **Short-term:** The 1000-event limit for real-time processing is a reasonable safeguard against long-running, blocking template execution. We should keep it for now but make it configurable in the `ChroniclerConfig` with a sensible default.

    - Add `maxEventsInTemplate?: number` to `ChroniclerConfig`.

2.  **Long-term (for Replayability):** The `EventJournal` is the key. We can design chroniclers to have two modes:
    - **Live mode:** Subscribes to the real-time event stream (as implemented above).
    - **Batch/Replay mode:** Instead of listening for live events, it could be given an event log file (from `.tadpole/events/events.jsonl`) and process all events at once. This would be ideal for summarization chroniclers that need the full context of a completed phase. This fits perfectly with the "replayable chroniclers" goal.

**Conclusion:** For this integration, we will focus on the live event stream. The event system itself doesn't impose a limit. The template limit is a separate performance concern that can be made configurable if needed. The foundation for handling a larger number of events via the `EventJournal` is solid for future work.

## 6. Unit and Integration Tests

**Goal:** Add tests for the new integration points and functionality.

**Proposed Tests:**

1.  **Unit Tests (`/tests/unit`):**

    - `tadpole-server.test.ts`:
      - Test that `ChroniclerManager` is created in the `TadpoleServer` constructor.
      - Test that `chroniclerManager.loadChroniclersForPhase` is called when a phase with chroniclers starts.
      - Test that `chroniclerManager.shutdown` is called when a phase completes.
      - Test that server events are correctly forwarded to `chroniclerManager.handleEvent`.

2.  **Integration Tests (`/tests/integration`):**
    - `chronicler-integration.test.ts` (new file):
      - Test a full phase execution with a simple chronicler config.
      - Verify that the chronicler is loaded.
      - Simulate server events and verify the chronicler's trigger is activated.
      - Use a mock LLM call to verify that the chronicler's `onExecute` is called with the correct events.
      - Verify that the chronicler's output file is created in `.tadpole/chronicler-outputs/` with the expected content.
      - Test both text and structured output chroniclers.
      - Test that if a phase has no chroniclers, the `ChroniclerManager` is not loaded with any chroniclers.

## 7. End-to-End (E2E) Tests

**Goal:** Modify existing E2E tests to validate chroniclers in a full workflow.

**Proposed Modifications:**

1.  **`happy-path-e2e.test.ts`:**

    - Create a new test config based on `happy-path.json` named `happy-path-with-chroniclers.json`.
    - Add a simple "narrator" chronicler to one of the phases in the new config. This chronicler could trigger on `assistant.action` and `tool.result` events and write a summary to a file.
    - Add a new test case that runs the server with this new config.
    - In the test assertions, check for the existence of the chronicler's output file in the execution directory's `.tadpole/chronicler-outputs/` directory.
    - Assert that the file content is not empty and, if possible, matches an expected pattern.

2.  **Other E2E Tests:**
    - Consider adding a chronicler to the rollback test (`rollback-e2e.test.ts`) to ensure that chroniclers are correctly loaded and shut down during rollbacks and subsequent phase executions. A simple chronicler that just logs phase start/end would be sufficient to verify its lifecycle is correct.

## 8. Replayable Chroniclers

**Goal:** Design the integration to support future replayability.

**Analysis:**

- The current architecture is already well-suited for this.
- The `EventJournal` creates a persisted log of all `ServerEvent`s.
- `ChroniclerManager` consumes `ServerEvent`s via its `handleEvent` method. It is decoupled from the source of the events.

**Design for the Future:**

- The integration I've proposed maintains this decoupling. `TadpoleServer` is just one possible source of events.
- In the future, we can create a simple "replay" script/tool. This tool would:
  1.  Read a `events.jsonl` file from a completed execution.
  2.  Instantiate a `ChroniclerManager`.
  3.  Load a set of chronicler configs.
  4.  Iterate through the events from the file and feed them one-by-one to `chroniclerManager.handleEvent(event)`.
  5.  Call `chroniclerManager.shutdown()` at the end to finalize outputs.

This requires no changes to the core `ChroniclerManager` or `Chronicler` classes. The integration I've laid out is therefore future-proof for replayability.

This completes my execution spec. I've covered all the points you raised, from immediate implementation details to testing and future extensibility. I'm confident this plan provides a clear path forward for integrating the chronicler system.
