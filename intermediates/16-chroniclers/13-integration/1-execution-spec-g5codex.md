# Chronicler Integration Execution Spec (GPT-5 Codex)

## Current Context

- Chronicler runtime is feature-complete in isolation: trigger engine, queueing strategies, conversational history persistence, structured output generation, output file management, and LLM provider integration already ship with extensive coverage under `server/chroniclers/**` and `tests/**`.
- Tadpole Server centralises event emission inside `TadpoleServer.emit()`, journalling and broadcasting every `ServerEvent` after the latest event-system refactor. Phase lifecycle is orchestrated by `startPhase()`, `handlePhaseComplete()`, `cleanupCurrentPhase()`, rollback helpers, and `shutdown()`.
- Phase configuration loading (`validatePhaseConfig` / `loadPhaseConfig` in `server/config.ts`) resolves prompt paths and runs validation but has no notion of chroniclers.
- Event persistence now exists via `EventJournal` + `FileEventStorage`, giving us an append-only log for later replay or offline analysis.

## Integration Goals (mapped to user asks)

1. **Phase surface** – allow phases to declare chroniclers, including output path overrides that rely on workspace-setup artefacts. Load chroniclers only after workspace setup completes.
2. **Manager options** – evaluate where to expose `ChroniclerManagerOptions` such as persistence and health-check timing, and document the rationale.
3. **Lifecycle wiring** – initialise chroniclers alongside Tadpole Server, load/unload them at the right phase boundaries, and ensure graceful shutdown.
4. **Event propagation** – route the streamlined server event stream into chroniclers without breaking journalling or causing regressions from the earlier event refactor.
5. **Queue limits** – revisit hard-coded queues now that events are persisted to disk; decide whether to raise limits or make them configurable.
6. **Testing** – cover boot success, phase execution, shutdown, and rollback with chroniclers active (unit + integration + e2e).
7. **E2E alignment** – extend existing e2e suites so chroniclers observe real phases (events, structured outputs, shutdown and rollback paths).
8. **Replay story** – keep the integration compatible with future “replay chronicler from event log” work.

## Proposed Architecture & Flow

### Phase Configuration Shape

- Extend `PhaseConfig` with an optional `chroniclers` array. Each entry is resolved during config validation into a runtime structure containing:
  - `config: ChroniclerConfig` – validated chronicler definition.
  - `configSourcePath?: string` – file path metadata for diagnostics.
  - `configDirectory: string` – base path for resolving prompt/schema files (defaults to phases config directory for inline definitions).
  - `outputPaths?: ChroniclerOutputPaths` – phase-level overrides for `logFile` / `lastValueFile`, applying the documented convention (filename-only → `.tadpole/chronicler-outputs/{id}/`, path-with-slash → execution-dir relative).
  - `persistence?: boolean` – optional per-chronicler toggle to opt out of persistence.
- Resolution rules inside `validatePhaseConfig`:
  1. Accept either inline objects or string references. Strings are treated as JSON files relative to the phase config file.
  2. Parse & validate via `chroniclerConfigSchema`. File read/parse errors become validation errors.
  3. Inline configs use the same schema path for consistency.
  4. Collect warnings instead of hard failures so a single chronicler misconfiguration does not block the workflow; warn and skip at runtime if validation fails.
  5. Return an enriched result `{ phases: PhaseConfigWithChroniclers[], warnings, configDirectory }` so Tadpole Server retains the base directory for downstream path resolution.

### ChroniclerManager Lifecycle in Tadpole Server

- Instantiate a single `ChroniclerManager` in the server constructor once logging/state managers exist. Inject:
  - `logger: this.logger` for consistent logging.
  - `enablePersistence`, `healthCheckGracePeriodMs`, `waitForHealthChecks` populated from env/config (see option strategy below).
- Wrap construction in try/catch. If initialisation fails (e.g., registry missing), log, set `this.chroniclerManager = null`, and continue without chroniclers.
- Maintain the manager instance across phases so provider health status and pricing information are reused.

### Phase Start Flow (`startPhase`)

1. **Prep**: before workspace setup, ensure prior chroniclers are torn down via `await this.chroniclerManager?.shutdown()` and clear `this.currentPhaseChroniclers` to avoid cross-phase bleed.
2. Execute workspace setup as usual.
3. After transitioning to `starting` but before spawning Claude, resolve the phase’s chroniclers:
   - Gather `phase.chroniclers ?? []`. For each entry build:
     - `config` and `configDirectory` from the resolved validation output.
     - `outputOverrides` map keyed by chronicler ID.
     - Optional per-chronicler persistence toggle.
   - Invoke an updated `ChroniclerManager.loadChroniclersForPhase` signature:
     ```ts
     loadChroniclersForPhase(
       configs: ChroniclerConfig[],
       phaseId: PhaseId,
       fallbackTextCall,
       configDirectories: string[],
       runStartTime: Date,
       onExecute?: (...),
       fallbackObjectCall?,
       executionPath?: string,
       outputOverrides?: Map<string, ChroniclerOutputPaths>,
       persistenceOverrides?: Map<string, boolean>,
     )
     ```
   - Record loaded IDs in `this.currentPhaseChroniclers` for later logging/metrics.
4. Failure handling: log + emit `error` event with `fatal: false` and continue the phase without that chronicler. Other chroniclers still run.

### Event Routing (`emit` override)

- Insert a `routeEventToChroniclers(serverEvent)` call inside the overridden `emit()` prior to journalling/broadcasting. Behaviour:
  - Ignore connection-state events (`server.ready`, ping/pong, handshake errors) because chroniclers don’t benefit.
  - If no active chroniclers for the current phase, return immediately.
  - Fire-and-forget: `void this.chroniclerManager?.handleEvent(serverEvent).catch(...)`. Manager already wraps internal errors; the outer catch handles cases where the manager was cleared after scheduling.
  - Retain journalling/broadcast logic unchanged so clients continue to see identical traffic.

### Phase Completion & Cleanup (`handlePhaseComplete`, `cleanupCurrentPhase`, `shutdown`)

- After emitting `phase.completed`, `await this.chroniclerManager?.completeAllWork()` to flush debounce/count/timeWindow buffers. Then `await this.chroniclerManager?.shutdown()` to destroy timers and clear state before running `cleanupCurrentPhase()`.
- Ensure other exit paths clean up:
  - `cleanupCurrentPhase()` should invoke `void this.chroniclerManager?.shutdown()` as a best-effort guard (non awaited).
  - `shutdown()` must `await this.chroniclerManager?.shutdown()` before tearing down clients/loggers.
  - Rollback helpers that call `cleanupCurrentPhase()` or spawn a new phase should explicitly unload chroniclers before proceeding.
- Optional enhancement: after `completeAllWork`, read `getChroniclerCount()` / `getTotalCost()` for logging or inclusion in future summary events.

### Error & Telemetry Surface

- When chroniclers fail to load or are unloaded due to fatal errors, emit warning events including `chroniclerId`, `phaseId`, `errorType`, and `unloaded` boolean. This keeps clients aware without treating the situation as fatal.
- Retain logging inside `ChroniclerManager` so cost and health information remains visible in server logs.

## ChroniclerManager Option Strategy (requirement 2)

- Options considered: `enablePersistence`, `waitForHealthChecks`, `healthCheckGracePeriodMs`.
- **Decision**: keep these global to the server, not per-phase. Exposing them per phase introduces lifecycle churn (changing persistence mid-run means recreating the manager). Instead:
  - Allow overrides via environment variables (e.g., `TADPOLE_CHRONICLER_PERSISTENCE=0`, `TADPOLE_CHRONICLER_HEALTHCHECK_GRACE_MS=1000`). Document defaults and override flow.
  - Honour per-chronicler persistence opt-out via the wrapper described above (sets `persistenceOverrides` when loading). This keeps the manager global while giving fine-grained control when needed (e.g., temp/debug chroniclers that shouldn’t touch disk).
  - Keep `waitForHealthChecks` defaulting to `false`; rely on a short grace period (500 ms) so startup is not blocked but logs still show provider readiness.
- Rationale: manager-level options affect shared resources (filesystem, provider registry) and are better controlled at deployment/environment level. Chronicler-specific adjustments (like disabling persistence) are already best handled per chronicler.

## Queue Limits & Backpressure (requirement 5)

- Current defaults in `Chronicler`:
  - `MAX_QUEUE_SIZE = 100` triggers.
  - `MAX_BUFFER_SIZE = 10_000` events across pending triggers.
  - Hard cap not configurable.
- New persistence (event log + chronicler output auto-generation) reduces risk of data loss, but chroniclers that lag could still spiral. Proposed adjustments:
  1. Increase defaults to `MAX_QUEUE_SIZE = 500`, `MAX_BUFFER_SIZE = 50_000` to accommodate longer runs.
  2. Surface optional chronicler-level overrides via a new config section:
     ```json
     "limits": {
       "maxQueuedTriggers": 500,
       "maxBufferedEvents": 50000
     }
     ```
     When omitted, use elevated defaults.
  3. Emit backpressure warnings earlier (e.g., at 50 % / 75 %) so operators see impending overflow in logs.
  4. Document best practices for long-running/deep chroniclers (e.g., prefer timeWindow to produce steady cadence).
- No change required in Tadpole Server beyond passing new limit values when instantiating `Chronicler`.

## Testing Strategy (requirement 6 & 7)

1. **Unit tests**
   - `server/config.test.ts`: ensure chronicler references (inline + file) validate correctly and output overrides resolve as expected.
   - `ChroniclerManager.loadChroniclersForPhase` new signature: verify per-config directories & output overrides are honoured.
   - `TadpoleServer.emit`: confirm `routeEventToChroniclers` is invoked, and connection events are skipped.
2. **Integration tests**
   - Add a focused integration test that spins up `TadpoleServer` with a simple phase + mock chronicler config, asserts that events reach the chronicler (using test harness `tests/utils/chronicler-test-harness.ts`).
   - Test error handling path: broken chronicler config triggers warning but phase still starts.
   - Validate persistence opt-out path (per-chronicler `persistence: false`).
3. **E2E tests**
   - Extend existing e2e flows (e.g., `tests/e2e/happy-path-e2e.test.ts`) with chronicler-enabled phases. Assertions:
     - Server boots with chroniclers configured.
     - Output files appear in `.tadpole/chronicler-outputs/...` or overridden paths.
     - Debounce/timeWindow strategies honour event batching.
     - Shutdown/rollback sequences do not throw and chroniclers are unloaded.
   - Add coverage for structured-output chronicler in a real Tadpole run to ensure JSON lines are produced and accessible to tests.

## Replayable Chroniclers (requirement 8)

- Leverage existing `EventJournal` + `FileEventStorage` to seed future replay work.
- Integration adjustments now to ease replay later:
  - When chroniclers load, record the event cursor (`EventJournal.getTotalEvents()`) in logging so we can later fast-forward during replay.
  - Keep chronicler loading logic pure (fully driven by config + execution path) so a replay driver can re-use `loadChroniclersForPhase` with a synthetic `executionPath` pointing to archived outputs.
  - Document a future hook: expose a `replayChroniclersFromLog(logPath, chroniclerConfigs, options)` helper that reuses `ChroniclerManager` to process historical events sequentially. No implementation now, but ensure no assumptions in the server integration prevent it (e.g., avoid direct dependencies on `this.currentPhase`).

## Open Questions & Follow-ups

1. **Config duplication** – Do we need a global chronicler registry outside phases (e.g., `chroniclers/` directory auto-loaded)? Current plan requires explicit references per phase; revisit once we see repetition in real configs.
2. **Cost tracking exposure** – Should chronicler costs appear in public events (e.g., `phase.completed`)? For now we keep them in logs until we have a UX requirement.
3. **Environment knobs** – Confirm desired names/defaults for env overrides controlling persistence & health checks.
4. **Replay tooling** – When we implement replay, do we want CLI entry points (`bun run server --replay ...`) or a library API? Worth aligning with user expectations.
5. **Performance monitoring** – We may want lightweight metrics (number of chronicler triggers executed per phase) surfaced via debug events once real workloads land.

---

This execution plan keeps chroniclers optional but production-ready: phases gain a declarative way to attach observers, events are streamed without regressing the new server pipeline, shutdown is graceful, and we leave hooks for future replay work.

