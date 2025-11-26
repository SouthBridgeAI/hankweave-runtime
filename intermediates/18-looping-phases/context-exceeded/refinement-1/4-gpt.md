# Design Notes: Context-Exceeded Handling (Refinement 1)

## Key Positions
- **No continue-previous after context-exceeded loop**: If a loop’s `terminateOn` is `contextExceeded`, the subsequent phase must ignore any prior session. Treat configurations that try `continuationMode: "continue-previous"` after such a loop as invalid at plan-build time (or auto-coerce to fresh with a warning).
- **StateManager transition**: Introduce a dedicated `ContextExceeded` transition that carries `runId`, `phaseId`, and loop context. This keeps the server thin and moves the acceptability decision + plan mutation into StateManager.
- **Reuse spawn for fresh sessions**: We do not need a new Claude process manager API. Call `spawn(phase, null, logPath)` when a fresh session is required; StateManager decisioning should surface a `forceFreshSession` bit to TadpoleServer’s start-phase path.

## StateManager + Plan Manipulation
- Accept `ContextExceeded` transition:
  - Compute `acceptable = loop.terminateOn?.type === "contextExceeded"` for the phase’s loop context.
  - If acceptable: mark the phase execution with `endedByContextExceeded = true`, mark the loop as completed, prevent additional iterations from being appended, and set a `forceFreshSessionForNextPhase` marker.
  - If not acceptable: mark the phase failed with reason `contextExceeded`.
- Update execution-plan hooks (e.g., `expandNextIterationForPhase`):
  - Guard against adding further iterations when the completed iteration has `endedByContextExceeded`.
  - Preserve loop bookkeeping (iteration indexes) so downstream events can include loop context as before.
- Validate configuration early:
  - When building the plan, if a phase immediately following a context-exceeded-terminating loop requests `continue-previous`, flag error or auto-switch to fresh + warning.

## TadpoleServer Trigger
- On context-exceeded detection:
  - Emit `ContextExceeded` transition to StateManager with `runId`, `phaseId`, loop context (if present), and message.
  - Emit a client-facing event (`context.exceeded`) from the response of that transition (includes `acceptable`).
- In `handlePhaseComplete` (or equivalent):
  - Use the StateManager’s stored phase state (`endedByContextExceeded`) to decide final status: success when acceptable, failure otherwise.
  - When acceptable, request a fresh session for the next phase by passing `previousSessionId = null` into `spawn`; when not, surface the failure reason.
  - Reset per-phase flags on cleanup as today.

## Claude Process Manager Interaction
- No new API: rely on existing `spawn(phase, previousSessionId, logPath?)`.
- Wire the `previousSessionId` choice from StateManager’s decision (fresh vs continue) so TadpoleServer stays stateless about the policy.

## Loop Context in Events
- Continue to include `loopContext` on `PhaseStarted` and add it (if available) to the new `context.exceeded` event payload to aid debugging and clients’ UIs.
