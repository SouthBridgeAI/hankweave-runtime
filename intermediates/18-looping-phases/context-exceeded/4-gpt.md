# Plan: Looping Phases Context-Exceeded Handling

## Objectives
- Treat `contextExceeded` as a first-class termination path: success when loop `terminateOn` is `contextExceeded`, otherwise an error.
- Notify StateManager and clients, and ensure the next phase after a context-exhausted loop starts with a fresh session.
- Cover the flow with fast unit/integration tests and a long-running e2e.

## Implementation Steps
1) **Types & Events**
   - Add a `ContextExceededEvent` payload to shared event defs (likely `server/types/types.ts` or adjacent) with `phaseId`, `acceptable`, and message.
   - Extend phase/loop state to record `endedByContextExceeded?: boolean` to drive loop expansion decisions.

2) **State Manager Logic**
   - Add `isContextExceededAcceptable(phaseId)` that checks the active loop config (`terminateOn.type === "contextExceeded"`).
   - Add `markPhaseContextExceeded(phaseId)` to persist the flag on the phase execution row/state snapshot.
   - Update `expandNextIterationForPhase` (or equivalent planner entry point) to skip creating the next iteration when the completed iteration has `endedByContextExceeded === true`.

3) **Execution Planner**
   - Thread a `contextExceeded?: boolean` input into the iteration-expansion path so the planner knows to stop loop expansion.
   - Ensure the planner records a loop-completion reason (context exceeded vs iteration limit) for logging/debugging.

4) **Tadpole Server Integration**
   - In `server/tadpole-server.ts` context-exceeded detection block:
     - Call `stateManager.isContextExceededAcceptable(...)`.
     - Emit the new `context.exceeded` event for clients with acceptability info.
     - Record a per-phase flag (e.g., `contextExceededForCurrentPhase`) for downstream handling.
   - In `handlePhaseComplete`:
     - If the phase hit context-exceeded and it is acceptable, force `finalStatus = "completed"`, set the phase state flag via `markPhaseContextExceeded`, and prevent loop expansion.
     - If not acceptable, set failure reason `context-exceeded` and fail the phase.
     - Set a `forceFreshSessionForNextPhase` indicator used when starting the next phase.
   - In phase cleanup, reset the per-phase context-exceeded flags.

5) **Fresh Session Handling**
   - Extend the Claude process manager/session creation API to support a forced-fresh session flag.
   - In `startPhase` (or the phase launch path), if the previous phase completed via acceptable context-exceeded, request a new session before running the next phase.
   - Log when a fresh session is forced due to context exhaustion.

6) **Testing**
   - Unit/Integration (fast):
     - StateManager: acceptable vs unacceptable context-exceeded decisions; loop expansion skipped when flagged.
     - TadpoleServer handler: acceptable path marks completion & fresh-session flag; unacceptable path fails phase.
   - E2E (tests/long-running):
     - Config with loop `terminateOn: contextExceeded`; drive a context-exceeded event; assert loop ends successfully, next phase runs with fresh session, and event emitted.
     - Negative case: context-exceeded outside such a loop triggers failure.

## Deliverables/Checks
- New event type and logging in `server/tadpole-server.ts`.
- StateManager/planner state flag to halt loop expansion after context exhaustion.
- Forced fresh session semantics wired through phase start.
- Automated coverage: unit/integration + long-running e2e cases added.
