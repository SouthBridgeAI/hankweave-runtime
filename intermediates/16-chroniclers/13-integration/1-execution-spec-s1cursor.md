# Chronicler Integration Execution Spec

## Overview

This document details the integration plan for connecting the chronicler system to Tadpole Server. Chroniclers are parallel observation agents that watch the event stream and perform analysis, summarization, or data extraction without interfering with the main workflow.

**Current Status**: Chroniclers are ~90% complete with:
- ✅ Core engine (triggers, execution strategies, templating)
- ✅ LLM provider system with health checks and fallback
- ✅ Conversational mode with history management
- ✅ Structured output (object/array/enum)
- ✅ Output file writing with auto-generation
- ✅ 180+ passing unit/integration/e2e tests
- ⚠️  **NOT INTEGRATED** with TadpoleServer phase execution

**What This Spec Covers**: The final integration that makes chroniclers available to real Tadpole workflows.

---

## 1. Phase Configuration Schema Updates

### 1.1 Add Chroniclers to PhaseConfig

**Location**: `server/types/types.ts` - `PhaseConfig` interface

**New Field**:
```typescript
export interface PhaseConfig {
  // ... existing fields ...

  /**
   * Chroniclers to run during this phase.
   * Chroniclers are parallel observation agents that watch the event stream
   * and perform analysis, summarization, or data extraction.
   */
  chroniclers?: PhaseChroniclerConfig[];
}
```

**Type Definition**:
```typescript
/**
 * Phase-level chronicler configuration.
 * References a chronicler by ID/file and optionally overrides output paths.
 */
export interface PhaseChroniclerConfig {
  /**
   * Reference to chronicler configuration.
   * Can be:
   * - Inline object with full ChroniclerConfig
   * - String path to external .json file (relative to phase config)
   * - Chronicler ID if chroniclers are in a shared directory
   */
  config: string | ChroniclerConfig;

  /**
   * Optional output file paths for this phase.
   * If omitted, chronicler will auto-generate paths in .tadpole/chronicler-outputs/
   */
  outputPaths?: ChroniclerOutputPaths;
}
```

**Confidence**: HIGH
**Rationale**: This follows existing patterns:
- Similar to `outputFiles` which is phase-specific but uses per-phase config
- Separates portable chronicler logic (in config) from execution-specific paths
- Allows flexibility: inline configs for one-off needs, file paths for reusable configs

**Questions**:
1. **Q**: Should we support a shared chroniclers directory like `./chroniclers/*.json` that phases can reference by ID?
   - **A**: YES, but Phase 2. Start with explicit file paths, add auto-discovery later.
   - **Benefit**: Reusability across projects
   - **Risk**: Adds complexity to path resolution

2. **Q**: Should chronicler configs be validated at server startup or lazily when phase starts?
   - **A**: STARTUP validation preferred, LAZY fallback for robustness
   - **Why**: Fail-fast prevents runtime surprises, but shouldn't crash if one chronicler is broken

### 1.2 Schema Validation

**Location**: `server/config.ts` - Add to phase validation

**New Zod Schema**:
```typescript
import { chroniclerConfigSchema } from "./config-validation/chronicler.schema.js";

const phaseChroniclerConfigSchema = z.object({
  config: z.union([
    z.string(), // File path or ID
    chroniclerConfigSchema, // Inline config
  ]),
  outputPaths: z.object({
    logFile: z.string().optional(),
    lastValueFile: z.string().optional(),
  }).optional(),
});

// Add to phaseConfigSchema
const phaseConfigSchema = z.object({
  // ... existing fields ...
  chroniclers: z.array(phaseChroniclerConfigSchema).optional(),
});
```

**Validation Logic**:
```typescript
// In loadPhaseConfig or validatePhaseConfig
for (const phase of phases) {
  if (phase.chroniclers) {
    for (const chrConfig of phase.chroniclers) {
      if (typeof chrConfig.config === 'string') {
        // Resolve file path
        const resolvedPath = path.resolve(configDir, chrConfig.config);
        if (!fs.existsSync(resolvedPath)) {
          validationErrors.push(
            `Phase ${phase.id}: Chronicler config file not found: ${chrConfig.config}`
          );
        }
        // Load and validate
        try {
          const loaded = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
          chroniclerConfigSchema.parse(loaded);
        } catch (error) {
          validationErrors.push(
            `Phase ${phase.id}: Invalid chronicler config in ${chrConfig.config}: ${error.message}`
          );
        }
      } else {
        // Validate inline config
        try {
          chroniclerConfigSchema.parse(chrConfig.config);
        } catch (error) {
          validationErrors.push(
            `Phase ${phase.id}: Invalid inline chronicler config: ${error.message}`
          );
        }
      }
    }
  }
}
```

**Confidence**: MEDIUM-HIGH
**Concerns**:
- Validation errors should be warnings, not hard failures (graceful degradation)
- Need to handle circular references if chroniclers can reference other chroniclers (they can't, but schema should prevent it)

---

## 2. TadpoleServer Integration Points

### 2.1 ChroniclerManager Lifecycle

**When to Initialize**: TadpoleServer constructor, after StateManager initialization

**Location**: `server/tadpole-server.ts` - Add to class properties

```typescript
export class TadpoleServer extends TypedEventEmitter<ServerInternalEvents> {
  // ... existing properties ...

  // Chronicler management
  private chroniclerManager: ChroniclerManager | null = null;
  private currentPhaseChroniclers: Set<string> = new Set(); // Track active chronicler IDs
}
```

**Constructor Addition**:
```typescript
constructor(config: ServerConfig) {
  // ... existing initialization ...

  // Initialize ChroniclerManager
  this.chroniclerManager = new ChroniclerManager({
    logger: this.logger,
    enablePersistence: true,
    healthCheckGracePeriodMs: 300, // Quick startup
  });

  // Initialize shared directory
  await this.chroniclerManager.initialize();
}
```

**Confidence**: HIGH
**Rationale**: Manager should be available for entire server lifecycle, not per-phase
- Allows provider health checks to run once at startup
- Enables cross-phase cost tracking if needed
- Simpler than creating/destroying manager per phase

**Questions**:
1. **Q**: Should ChroniclerManager be optional (graceful degradation if init fails)?
   - **A**: YES. Log warning, set to null, server continues without chroniclers
   - **Why**: Chroniclers are observability, not core functionality

2. **Q**: Should we wait for provider health checks before starting first phase?
   - **A**: NO, use grace period (300ms) then continue
   - **Why**: Don't block workflow start for optional feature
   - **Trade-off**: First chronicler might fail if provider not ready, but will retry

### 2.2 Loading Chroniclers Per Phase

**When**: During `startPhase()`, AFTER workspace setup, BEFORE starting Claude process

**Location**: `server/tadpole-server.ts` - Inside `startPhase()` method

```typescript
private async startPhase(phase: PhaseConfig, skipPreCommands: boolean = false): Promise<void> {
  try {
    // ... existing workspace setup code ...

    // Transition to starting
    this.stateManager.transition({
      type: "PhaseTransitioned",
      data: { ... },
    });

    // === NEW: Load chroniclers for this phase ===
    await this.loadChroniclersForPhase(phase);

    // ... existing code to spawn Claude process ...

  } catch (error) {
    // ... error handling ...
  }
}

private async loadChroniclersForPhase(phase: PhaseConfig): Promise<void> {
  if (!this.chroniclerManager) {
    this.logger.log("ChroniclerManager not available, skipping chroniclers", "debug");
    return;
  }

  if (!phase.chroniclers || phase.chroniclers.length === 0) {
    this.logger.log(`Phase ${phase.id} has no chroniclers configured`, "debug");
    return;
  }

  try {
    this.logger.log(`Loading ${phase.chroniclers.length} chronicler(s) for phase ${phase.id}`, "info");

    // Resolve chronicler configs
    const configs: ChroniclerConfig[] = [];
    const outputPathsMap: Map<string, ChroniclerOutputPaths> = new Map();
    const configDir = path.dirname(this.config.phasesConfigPath || '.');

    for (const chrConfig of phase.chroniclers) {
      let config: ChroniclerConfig;

      if (typeof chrConfig.config === 'string') {
        // Load from file
        const resolvedPath = path.resolve(configDir, chrConfig.config);
        const loaded = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
        config = chroniclerConfigSchema.parse(loaded);
      } else {
        // Use inline config
        config = chrConfig.config;
      }

      configs.push(config);

      // Store output paths if provided
      if (chrConfig.outputPaths) {
        outputPathsMap.set(config.id, chrConfig.outputPaths);
      }
    }

    // Create LLM call adapter
    const llmCall = this.createChroniclerLLMCall();
    const llmObjectCall = this.createChroniclerLLMObjectCall();

    // Load chroniclers
    await this.chroniclerManager.loadChroniclersForPhase(
      configs,
      phase.id as PhaseId,
      llmCall,
      configDir,
      new Date(), // Current run start time
      undefined, // onExecute (only for testing)
      llmObjectCall,
      this.config.executionPath,
      // TODO: Pass output paths map
    );

    // Track loaded chronicler IDs
    this.currentPhaseChroniclers.clear();
    for (const config of configs) {
      this.currentPhaseChroniclers.add(config.id);
    }

    this.logger.log(`Successfully loaded ${configs.length} chronicler(s)`, "info");

  } catch (error) {
    // Non-fatal: Log error but continue phase execution
    this.logger.log(
      `Failed to load chroniclers for phase ${phase.id}: ${error}. Continuing without chroniclers.`,
      "warn"
    );

    // Send error event
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: `Failed to load chroniclers: ${error}`,
        context: `Phase ${phase.id}`,
        phase: phase.id,
        fatal: false,
        severity: ErrorSeverity.WARNING,
      },
    } as ErrorEvent);
  }
}

private createChroniclerLLMCall(): (
  id: string,
  options: TadpoleGenerateTextOptions
) => Promise<TadpoleGenerateTextResult> {
  return async (id: string, options: TadpoleGenerateTextOptions) => {
    // This will be handled by ChroniclerManager's provider registry
    // But we need to provide this signature for the interface
    throw new Error("LLM call should be handled by ChroniclerManager");
  };
}

private createChroniclerLLMObjectCall(): (
  id: string,
  options: TadpoleGenerateObjectOptions
) => Promise<TadpoleGenerateObjectResult<unknown>> {
  return async (id: string, options: TadpoleGenerateObjectOptions) => {
    throw new Error("LLM object call should be handled by ChroniclerManager");
  };
}
```

**Confidence**: MEDIUM
**Concerns**:
1. **Loading is async**: This adds latency to phase start. Need to measure impact.
   - **Mitigation**: Provider health checks mostly done at startup
   - **Estimate**: +50-200ms per phase (file I/O + validation)

2. **Error handling**: Need clear policy on what happens if chroniclers fail to load
   - **Decision**: NON-FATAL. Log warning, continue phase without chroniclers
   - **Why**: Phase execution is more important than observation

3. **Output paths**: Current `loadChroniclersForPhase` signature doesn't support per-chronicler paths
   - **TODO**: Update ChroniclerManager.loadChroniclersForPhase to accept `Map<string, ChroniclerOutputPaths>`
   - **Alternative**: Add to Chronicler constructor, pass through manager

**Questions**:
1. **Q**: Should we load chroniclers in parallel with starting Claude process?
   - **A**: NO, sequential is safer
   - **Why**: Chroniclers need to catch early events (phase.started). Parallel risks race conditions.

2. **Q**: What if a chronicler config is invalid at runtime but passed validation?
   - **A**: ChroniclerManager already handles this with ChroniclerFatalError
   - **Behavior**: Log error, skip that chronicler, load others

### 2.3 Routing Events to Chroniclers

**When**: Every time an event is emitted through TadpoleServer.emit()

**Location**: `server/tadpole-server.ts` - Inside `emit()` method

```typescript
emit<K extends keyof ServerInternalEvents>(
  event: K,
  data: ServerInternalEvents[K][0],
  target?: ServerWebSocket<ClientData>,
): boolean {
  if (event !== "event") {
    throw new Error(`Unsupported event type: ${event}`);
  }

  const serverEvent = data as ServerEvent;
  const isServerState = isServerStateEvent(serverEvent);
  const isAgenticBackbone = isAgenticBackboneEvent(serverEvent);
  const isConnectionState = isConnectionStateEvent(serverEvent);

  // ... existing validation ...

  // === NEW: Route to chroniclers (fire-and-forget) ===
  this.routeEventToChroniclers(serverEvent);

  // ... existing journal and broadcast logic ...

  return true;
}

private routeEventToChroniclers(event: ServerEvent): void {
  // Don't route connection state events to chroniclers
  if (isConnectionStateEvent(event)) {
    return;
  }

  if (!this.chroniclerManager) {
    return;
  }

  // Fire-and-forget event handling
  // Chroniclers process events asynchronously via their queues
  this.chroniclerManager.handleEvent(event);
}
```

**Confidence**: HIGH
**Rationale**:
- Simple integration point
- Fire-and-forget means zero blocking
- Connection state events filtered out (they're client-specific, not domain events)

**Edge Cases**:
1. **High event rate**: ChroniclerManager has queue limits (MAX_QUEUE_SIZE = 100)
   - **Behavior**: Oldest events dropped when queue full
   - **Monitoring**: Log warning when queue is >80% full

2. **Chronicler crashes**: Handled by ChroniclerManager's error handling
   - **Behavior**: Chronicler unloaded after threshold consecutive failures
   - **Impact**: Other chroniclers continue normally

**Questions**:
1. **Q**: Should we filter events by phase ID before routing?
   - **A**: NO, let chroniclers decide through their triggers
   - **Why**: A chronicler might want cross-phase events (e.g., track cost across all phases)
   - **How**: Chroniclers can use conditions on `phaseId` if needed

2. **Q**: Should we route events that happened before chroniclers were loaded?
   - **A**: Phase 2 feature (historical event replay)
   - **Current**: Chroniclers only see events after they're loaded
   - **Why**: Complex to implement, limited value for v1

### 2.4 Cleanup on Phase End

**When**: Multiple points:
1. Phase completes successfully
2. Phase fails
3. Phase is skipped
4. Server shutdown

**Location**: `server/tadpole-server.ts` - Various cleanup points

```typescript
// Add to cleanupCurrentPhase()
private cleanupCurrentPhase(): void {
  // ... existing cleanup ...

  // Unload current phase chroniclers
  this.unloadPhaseChroniclers();

  this.currentPhase = undefined;
}

private async unloadPhaseChroniclers(): Promise<void> {
  if (!this.chroniclerManager || this.currentPhaseChroniclers.size === 0) {
    return;
  }

  try {
    this.logger.log(
      `Unloading ${this.currentPhaseChroniclers.size} chronicler(s) for current phase`,
      "info"
    );

    // Flush any pending work
    await this.chroniclerManager.completeAllWork();

    // Unload by phase (ChroniclerManager tracks by phase ID)
    if (this.currentPhase?.phase.id) {
      this.chroniclerManager.unloadChroniclersForPhase(this.currentPhase.phase.id as PhaseId);
    }

    this.currentPhaseChroniclers.clear();

  } catch (error) {
    this.logger.log(`Error unloading chroniclers: ${error}`, "warn");
    // Non-fatal, continue cleanup
  }
}

// Add to shutdown()
async shutdown(): Promise<void> {
  // ... existing shutdown logic ...

  // Graceful chronicler shutdown
  if (this.chroniclerManager) {
    try {
      this.logger.log("Shutting down ChroniclerManager...", "info");
      await this.chroniclerManager.shutdown();
      this.logger.log("ChroniclerManager shut down successfully", "info");
    } catch (error) {
      this.logger.log(`Error shutting down ChroniclerManager: ${error}`, "warn");
    }
  }

  // ... rest of shutdown ...
}
```

**Confidence**: HIGH
**Rationale**: Follows existing cleanup patterns in TadpoleServer

**Edge Cases**:
1. **Chronicler still processing**: `completeAllWork()` waits for queue to empty
   - **Timeout**: None currently. Should we add one?
   - **Risk**: Shutdown could hang if chronicler is stuck
   - **Mitigation**: Add 10s timeout in Phase 2

2. **Phase fails before chroniclers load**: unloadPhaseChroniclers() is no-op (safe)

3. **Rollback**: Current implementation unloads on phase end
   - **Behavior**: Chroniclers unloaded, new ones loaded when phase restarts
   - **Question**: Should chroniclers persist across rollback? (Probably NO - clean slate)

---

## 3. ChroniclerManager Enhancements

### 3.1 Output Paths Support

**Current State**: ChroniclerManager.loadChroniclersForPhase doesn't accept per-chronicler output paths

**Required Change**:
```typescript
// server/chroniclers/chronicler-manager.ts

public async loadChroniclersForPhase(
  configs: ChroniclerConfig[],
  phaseId: PhaseId,
  llmCall: ...,
  configDirectory?: string,
  runStartTime?: Date,
  onExecute?: (id: string, events: ServerEvent[]) => void,
  llmObjectCall?: ...,
  executionPath?: string,
  outputPathsMap?: Map<string, ChroniclerOutputPaths>, // NEW
): Promise<void> {
  // Inside loop:
  const outputPaths = outputPathsMap?.get(config.id);

  const chronicler = new Chronicler(
    config,
    phaseId,
    llmCall,
    this.logger,
    this.chroniclerDir,
    configDirectory,
    runStartTime,
    onExecute,
    modelCost,
    llmObjectCall,
    executionPath,
    outputPaths, // Pass through
  );
}
```

**Confidence**: HIGH
**Rationale**: Straightforward parameter addition, backwards compatible (undefined = auto-generate)

### 3.2 Phase-Scoped Unloading

**Current State**: ChroniclerManager.unloadChroniclersForPhase exists

**Verification Needed**: Does it properly:
1. Wait for all chroniclers to flush?
2. Close file handles?
3. Save conversation history?

**Action**: Review implementation, add Phase 2 if needed:
- Add explicit flush timeout
- Log warnings for orphaned resources

**Confidence**: MEDIUM-HIGH (assuming current implementation is correct based on tests)

---

## 4. Configuration Management Refactoring

### 4.1 Store Phase Config Path

**Problem**: TadpoleServer doesn't currently store the path to phases.json

**Why Needed**: To resolve relative chronicler config paths

**Solution**: Add to ServerConfig
```typescript
export interface ServerConfig {
  // ... existing fields ...

  /**
   * Path to the phases configuration file.
   * Used for resolving relative paths in chronicler configs.
   */
  phasesConfigPath?: string;
}
```

**Update in index.ts**:
```typescript
const serverConfig = {
  // ... existing fields ...
  phasesConfigPath: absoluteConfigPath,
};
```

**Confidence**: HIGH
**Rationale**: Simple, follows existing pattern for configPath

---

## 5. Event Limit Considerations

### 5.1 Current Limit: 1000 Events

**Where**: `server/chroniclers/prompt-templating-engine.ts` - Template context limits events to 1000

**Question**: Should we increase or remove this limit now that we have:
1. File-based event journal (not memory-limited)
2. Structured event storage (JSONL)
3. Lazy loading (events loaded on demand)

**Analysis**:

**Arguments for keeping limit**:
- Template rendering performance (1000 events = fast)
- LLM context window limits (even with 1M tokens, don't waste on old events)
- Chronicler typically only needs recent events

**Arguments for increasing**:
- Better chronicler capabilities (can analyze longer patterns)
- File journal makes this feasible
- Different chroniclers have different needs

**Recommendation**: CONFIGURABLE per chronicler
```typescript
export interface ChroniclerConfig {
  // ... existing fields ...

  /**
   * Maximum number of events to include in template context.
   * Default: 1000. Increase for chroniclers that need longer history.
   * Warning: Very large values may impact performance.
   */
  maxEventHistory?: number;
}
```

**Default**: 1000 (current behavior)
**Maximum**: 10,000 (safety limit)

**Implementation**:
```typescript
// server/chroniclers/prompt-templating-engine.ts
const effectiveMax = config.maxEventHistory || 1000;
const limitedEvents = events.slice(-effectiveMax);
```

**Confidence**: MEDIUM
**Trade-offs**: More flexibility vs more config surface area
**Decision**: Phase 2 - start with hard limit, add config if needed

### 5.2 Event Journal Pagination

**Current**: ChroniclerManager receives events via handleEvent (push model)

**Future Enhancement**: Allow chroniclers to pull from event journal
- **Use Case**: Chronicler loads mid-phase, needs historical events
- **Use Case**: Replayable chroniclers (see section 8)

**Implementation Sketch**:
```typescript
// Future API
class ChroniclerManager {
  async getEventsForPhase(phaseId: PhaseId, limit?: number): Promise<ServerEvent[]> {
    // Query event journal filtered by phaseId
    return this.eventJournal.getEvents({
      filter: { phaseId },
      limit: limit || 1000,
    });
  }
}
```

**Decision**: NOT for v1 integration
**Why**: Adds complexity, unclear value for initial launch

---

## 6. Testing Strategy

### 6.1 Unit Tests (New)

**Location**: `tests/unit/tadpole-server-chronicler-integration.test.ts`

**What to Test**:
1. ✅ loadChroniclersForPhase with inline configs
2. ✅ loadChroniclersForPhase with file configs
3. ✅ loadChroniclersForPhase with invalid configs (graceful failure)
4. ✅ routeEventToChroniclers filters connection events
5. ✅ routeEventToChroniclers handles no manager
6. ✅ unloadPhaseChroniclers cleanup
7. ✅ Output paths passed to chroniclers

**Test Pattern**:
```typescript
describe("TadpoleServer Chronicler Integration", () => {
  it("should load chroniclers from phase config", async () => {
    const phase: PhaseConfig = {
      id: "test-phase",
      chroniclers: [{
        config: {
          id: "test-chronicler",
          trigger: { type: "event", on: ["assistant.action"] },
          execution: { strategy: "immediate" },
          userPromptText: "Test",
          model: "sonnet",
        },
      }],
      // ... other required fields ...
    };

    const server = new TadpoleServer({ phases: [phase], /* ... */ });
    // Assert chronicler loaded
  });
});
```

**Confidence**: HIGH
**Rationale**: Unit tests with mocks, fast, isolated

### 6.2 Integration Tests (New)

**Location**: `tests/integration/chronicler-phase-integration.test.ts`

**What to Test**:
1. ✅ Chroniclers receive events during phase execution
2. ✅ Chroniclers write output files
3. ✅ Chroniclers unload at phase end
4. ✅ Multiple chroniclers in same phase
5. ✅ Chroniclers across multiple phases (cross-phase narrative)
6. ✅ Conversational chronicler maintains history

**Test Pattern**:
```typescript
it("should run chronicler during phase execution", async () => {
  const testConfig = {
    phases: [{
      id: "test-phase",
      chroniclers: [{
        config: {
          id: "narrator",
          trigger: { type: "event", on: ["*"] },
          execution: { strategy: "debounce", milliseconds: 1000 },
          userPromptText: "Count events: <%= it.events.length %>",
          model: "sonnet",
        },
      }],
      // ... minimal phase to execute ...
    }],
  };

  const manager = new ChroniclerManager({ /* mock provider */ });
  // Execute phase
  // Assert events captured
  // Assert output written
});
```

### 6.3 E2E Tests (Modify Existing)

**Update**: `tests/e2e/happy-path-e2e.test.ts`

**Add**:
1. Phase with one simple chronicler (narrator)
2. Verify chronicler output file created
3. Verify chronicler events in journal (or websocket log)

**Example Phase Config Addition**:
```json
{
  "id": "phase-1",
  "name": "Test Phase with Chronicler",
  "chroniclers": [{
    "config": {
      "id": "simple-narrator",
      "name": "Simple Narrator",
      "trigger": { "type": "event", "on": ["assistant.action"] },
      "execution": { "strategy": "debounce", "milliseconds": 2000 },
      "userPromptText": "Summarize: <%= it.events.length %> events",
      "model": "sonnet"
    }
  }],
  "promptFile": "./phase1Prompt.md",
  "model": "sonnet",
  "continuationMode": "fresh"
}
```

**Verification**:
```typescript
// After phase completes
const chroniclerOutputDir = path.join(executionDir, ".tadpole/chronicler-outputs/simple-narrator");
expect(fs.existsSync(chroniclerOutputDir)).toBe(true);

const files = fs.readdirSync(chroniclerOutputDir);
expect(files.length).toBeGreaterThan(0);
expect(files[0]).toMatch(/simple-narrator-phase-1-\d+\.md/);
```

**Confidence**: MEDIUM
**Concern**: E2E tests are slow, should we add this much?
**Decision**: Add ONE simple test to verify end-to-end. Keep it minimal.

### 6.4 Rollback Tests (New)

**Location**: `tests/e2e/chronicler-rollback.test.ts`

**What to Test**:
1. ✅ Chroniclers unload after rollback
2. ✅ New chroniclers load when phase restarts
3. ✅ Chronicler output files from rolled-back phase are preserved (or not?)
4. ✅ Rollback doesn't interfere with chronicler cleanup

**Edge Case**: If chronicler is mid-write when rollback happens
**Expected**: File write completes, then chronicler unloads
**Why**: Atomic writes prevent corruption

**Confidence**: MEDIUM-LOW
**Complexity**: Rollback system is already complex, adding chroniclers increases surface area

---

## 7. Edge Cases and Error Handling

### 7.1 Chronicler Failures

**Scenarios**:
1. Chronicler config invalid → Skip, log error, continue
2. LLM call fails → Retry (managed by ChroniclerManager)
3. Too many consecutive failures → Unload chronicler
4. Fatal error (config, schema, model) → Unload immediately

**Current Behavior**: Already handled by ChroniclerFatalError system ✅

**Integration Impact**: None. TadpoleServer just needs to not crash when chronicler fails.

**Verification**:
```typescript
// In loadChroniclersForPhase
try {
  await this.chroniclerManager.loadChroniclersForPhase(...);
} catch (error) {
  // Log, emit error event, continue
  // Never throw - chroniclers are optional
}
```

### 7.2 Missing Dependencies

**Scenario**: Phase config references chronicler file that doesn't exist

**Current Validation**: Caught at server startup (in validatePhaseConfig) ✅

**Fallback**: If validation skipped (e.g., --no-validate), caught at runtime
```typescript
if (typeof chrConfig.config === 'string') {
  const resolvedPath = path.resolve(configDir, chrConfig.config);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Chronicler config file not found: ${chrConfig.config}`);
  }
}
```

**Confidence**: HIGH

### 7.3 Provider Unavailability

**Scenario**: Model specified in chronicler config not available

**Current Handling**: ChroniclerManager checks provider status at load time ✅

**Behavior**:
- If provider unhealthy: Wait for grace period (300ms), retry
- If still unavailable: Throw ChroniclerFatalError, skip chronicler

**Question**: Should we fail hard or soft?
**Answer**: SOFT. Log warning, skip chronicler, continue phase.
**Why**: Phase execution >> observation

### 7.4 High Event Rate

**Scenario**: TadpoleServer emits events faster than chroniclers can process

**Current Protection**:
- ChroniclerManager has MAX_QUEUE_SIZE = 100
- When full, oldest events dropped

**Enhancement**: Add queue saturation warning
```typescript
// In ChroniclerManager.handleEvent
if (this.triggerQueue.length > MAX_QUEUE_SIZE * 0.8) {
  this.logger?.log(
    `[ChroniclerManager] Queue approaching limit: ${this.triggerQueue.length}/${MAX_QUEUE_SIZE}`,
    "warn"
  );
}
```

**Confidence**: MEDIUM
**Why**: Rare in practice (phases are usually not that busy), but good safeguard

### 7.5 Disk Space Exhaustion

**Scenario**: Chronicler output files fill disk

**Current Protection**: None

**Recommendation**: Phase 2 - add file size limits
```typescript
export interface ChroniclerConfig {
  maxOutputFileSize?: number; // In bytes, default 10MB
}
```

**Mitigation**: Log files are append-only, will fail gracefully on write error

**Confidence**: LOW priority for v1

---

## 8. Replayable Chroniclers (Future)

**User's Question**: "Can we have a chronicler pretend this is a real execution and replay?"

**Use Cases**:
1. Debugging: Replay phase execution through chronicler lens
2. Testing: Verify chronicler behavior without running full phase
3. Analysis: Retrospective analysis of past executions

**Requirements**:
1. Read events from `.tadpole/events/events.jsonl`
2. Filter by phase ID or time range
3. Feed events to chronicler in order
4. Optionally throttle to simulate real-time

**Integration Sketch**:
```typescript
// New command: tadpole replay
async function replayChronicler(options: {
  chroniclerConfig: string;
  eventLog: string; // Path to events.jsonl
  phaseId?: string; // Filter by phase
  realtimeSpeed?: number; // 1.0 = real-time, 0 = as fast as possible
}) {
  // 1. Load events from JSONL
  const events = loadEventsFromJournal(options.eventLog, options.phaseId);

  // 2. Create chronicler manager (no provider needed for replay)
  const manager = new ChroniclerManager({
    enablePersistence: false, // Don't write during replay
  });

  // 3. Load chronicler with mock LLM (or real for analysis)
  const config = loadChroniclerConfig(options.chroniclerConfig);
  await manager.loadChroniclersForPhase([config], ...);

  // 4. Replay events
  for (const event of events) {
    manager.handleEvent(event);

    // Optional: Wait to simulate real-time
    if (options.realtimeSpeed && options.realtimeSpeed > 0) {
      await sleep(calculateDelay(event, options.realtimeSpeed));
    }
  }

  // 5. Flush and report
  await manager.completeAllWork();
  console.log("Replay complete");
}
```

**Integration Points**:
1. Event journal needs to be readable (already is ✅)
2. ChroniclerManager needs to work without TadpoleServer (already does ✅)
3. Need CLI command or separate tool

**Implementation Difficulty**: MEDIUM
**Estimated Effort**: 1-2 days
**Priority**: Phase 2 (valuable but not essential)

**Design Decision**: Build this as separate tool, not integrated into TadpoleServer
**Why**: Different use case, cleaner separation, easier to test

---

## 9. Configuration Schema Questions

### 9.1 Should Chroniclers Be Phase-Level or Server-Level?

**Current Decision**: Phase-level (in PhaseConfig)

**Rationale**:
- ✅ Different phases have different observation needs
- ✅ Consistent with trackedFiles, outputFiles (also phase-level)
- ✅ Allows "narrator for planning phase, metrics for execution phase"
- ❌ More config duplication if same chronicler used across phases

**Alternative**: Server-level with phase activation
```json
{
  "chroniclers": [
    {
      "id": "global-narrator",
      "activeInPhases": ["phase-1", "phase-2"]
    }
  ],
  "phases": [...]
}
```

**Why Rejected**:
- More complex (need to track what's active when)
- Harder to reason about
- Doesn't match existing patterns

**Confidence**: HIGH on current decision

### 9.2 ChroniclerManager Config Location

**Question**: Should ChroniclerManager config (grace periods, queue limits, etc.) be:
1. Server-level in ServerConfig
2. Phase-level in PhaseConfig
3. Chronicler-level in ChroniclerConfig

**Analysis**:
- `healthCheckGracePeriodMs`: Server-level (one-time at startup)
- `MAX_QUEUE_SIZE`: Server-level (applies to all chroniclers)
- `maxConsecutiveFailures`: Chronicler-level (already is ✅)
- `maxEventHistory`: Chronicler-level (proposed)

**Decision**: Mostly correct as-is. Only server-level config is initialization.

**Action**: Add to ServerConfig if we want to expose:
```typescript
export interface ServerConfig {
  // ... existing fields ...

  chroniclerHealthCheckGracePeriodMs?: number; // Default: 300
}
```

**Confidence**: MEDIUM
**Trade-off**: More config surface vs more control
**Recommendation**: Phase 2 - start with hard-coded defaults

---

## 10. Performance Considerations

### 10.1 Phase Startup Latency

**Question**: How much does chronicler loading add to phase startup time?

**Components**:
1. File I/O: Load chronicler configs (~10ms per file)
2. Validation: Zod schema parse (~5ms per config)
3. Provider check: Already done at server start (~0ms)
4. Chronicler construction: Prompt loading (~20ms per chronicler)

**Estimate**: +50-100ms per chronicler
**Impact**: 2 chroniclers = +100-200ms to phase start

**Mitigation**:
- Cache parsed configs (Phase 2)
- Parallel loading if multiple chroniclers (Phase 2)
- Accept the cost (it's reasonable)

**Measurement Plan**: Add timing logs
```typescript
const startTime = Date.now();
await this.loadChroniclersForPhase(phase);
const elapsed = Date.now() - startTime;
this.logger.log(`Chroniclers loaded in ${elapsed}ms`, "debug");
```

**Confidence**: MEDIUM
**Decision**: Measure in testing, optimize only if >500ms

### 10.2 Event Routing Overhead

**Question**: Does routeEventToChroniclers add latency to event emission?

**Analysis**:
```typescript
this.routeEventToChroniclers(serverEvent); // Fire-and-forget
```

**Answer**: NO blocking overhead
- ChroniclerManager.handleEvent is synchronous but just adds to queue
- Actual processing happens asynchronously
- Queue operations are O(1)

**Overhead**: ~0.1ms per event (negligible)

**Confidence**: HIGH

### 10.3 Memory Usage

**Question**: How much memory do chroniclers use?

**Components**:
1. Event queues: 100 events × ~1KB = 100KB per chronicler
2. Conversation history: ~10 turns × ~2KB = 20KB per conversational chronicler
3. Template cache: ~5KB per prompt

**Estimate**: ~125KB per chronicler, ~500KB for 4 chroniclers

**Comparison**: TadpoleServer state.json is ~100-500KB, event journal is 10-100MB
**Impact**: Negligible

**Confidence**: HIGH

---

## 11. Documentation Updates Needed

### 11.1 User-Facing Docs

**Files to Update**:
1. ✅ `documentation/chronicler-system.md` - Add integration section
2. ✅ `documentation/phase-configuration-guide.md` - Add chroniclers field
3. ✅ `README.md` - Update feature list
4. ⚠️ `documentation/event-journal.md` - Note that chroniclers consume events

**New Content Needed**:
```markdown
## Using Chroniclers in Phases

Chroniclers are configured per-phase in your `phases.json`:

```json
{
  "id": "my-phase",
  "name": "My Phase",
  "chroniclers": [
    {
      "config": "./chroniclers/narrator.json",
      "outputPaths": {
        "logFile": "summaries.md"
      }
    }
  ],
  // ... other phase config
}
```

Chronicler configs can be:
- **Inline**: Full chronicler config in phases.json
- **File**: Path to external .json file
- **Shared**: Reference to config in shared directory
```

### 11.2 Developer Docs

**New File**: `documentation/chronicler-integration.md`

**Contents**:
- TadpoleServer integration points
- Event routing flow
- Lifecycle management
- Error handling
- Testing patterns
- Performance considerations

---

## 12. Migration Path (if needed)

**Question**: Are there any existing Tadpole installations that need migration?

**Answer**: NO - chroniclers are new feature
**Impact**: None. Backwards compatible by default (chroniclers is optional field)

**Validation**: Existing phase configs without chroniclers will work unchanged

---

## 13. Open Questions

### Critical (must answer before implementation)

1. **Q**: How should we handle ChroniclerManager initialization failure?
   - **A**: Log warning, set to null, continue without chroniclers
   - **Why**: Non-fatal, graceful degradation
   - **Confidence**: HIGH

2. **Q**: Should chronicler output paths support template variables (e.g., `<%PHASE_ID%>`)?
   - **A**: YES, Phase 2
   - **Current**: Use auto-generation with phase ID in filename
   - **Future**: Add template support for custom patterns
   - **Confidence**: MEDIUM (nice-to-have, not essential)

3. **Q**: What happens if two chroniclers write to same output file?
   - **A**: Last write wins (file conflict)
   - **Mitigation**: Validate at config load time - warn if duplicate paths
   - **Better**: Auto-generate should prevent this (includes chronicler ID)
   - **Confidence**: MEDIUM (edge case, but should handle)

### Important (answer during implementation)

4. **Q**: Should we emit chronicler-specific events (e.g., `chronicler.started`, `chronicler.completed`)?
   - **A**: YES, for observability
   - **Events**: `chronicler.loaded`, `chronicler.unloaded`, `chronicler.error`
   - **Why**: Debug visibility, client UI can show chronicler status
   - **Confidence**: MEDIUM-HIGH

5. **Q**: Should chronicler errors go to error event stream or separate log?
   - **A**: Both - error events for important failures, debug logs for details
   - **Why**: Error events are for actionable problems, logs are for diagnosis
   - **Confidence**: HIGH

6. **Q**: How do we handle chroniclers in `--cleanup` mode?
   - **A**: Skip chroniclers entirely (don't load or unload)
   - **Why**: Cleanup is about state management, not observation
   - **Confidence**: HIGH

### Nice-to-have (defer to Phase 2)

7. **Q**: Should we support chronicler hot-reload?
   - **A**: No for v1, maybe Phase 2
   - **Why**: Complex, unclear value
   - **Use Case**: Developer wants to modify chronicler config without restarting phase
   - **Confidence**: LOW priority

8. **Q**: Should chroniclers have access to phase config?
   - **A**: Not for v1, maybe Phase 2 via template context
   - **Why**: Templates already have `it.phase`, could add `it.phase.config`
   - **Use Case**: Chronicler behavior changes based on phase settings
   - **Confidence**: LOW priority

---

## 14. Implementation Phases

### Phase 1: Core Integration (This Spec)

**Goal**: Chroniclers work in real Tadpole phases

**Deliverables**:
1. ✅ Phase config schema updates
2. ✅ TadpoleServer integration (load, route, cleanup)
3. ✅ ChroniclerManager output paths support
4. ✅ Unit + integration tests
5. ✅ Updated documentation
6. ✅ One E2E test with chronicler

**Estimated Effort**: 3-4 days
**Risk**: MEDIUM (integration points are well-defined)

### Phase 2: Polish & Features

**Goal**: Production-ready with advanced features

**Features**:
1. Chronicler-specific events (loaded, unloaded, error)
2. Queue saturation warnings
3. Template variable support in output paths
4. Hot-reload support
5. Enhanced error reporting
6. Performance optimization

**Estimated Effort**: 2-3 days
**Priority**: After Phase 1 proven stable

### Phase 3: Replay & Analysis

**Goal**: Replayable chroniclers for debugging

**Features**:
1. Replay command/tool
2. Historical event filtering
3. Real-time simulation
4. Analysis mode (no LLM calls, just pattern matching)

**Estimated Effort**: 2-3 days
**Priority**: After user feedback on Phase 1

---

## 15. Risk Assessment

### High Risk

1. **Event routing performance**: Too many chroniclers could slow event emission
   - **Mitigation**: Fire-and-forget, queue limits
   - **Monitoring**: Add timing logs
   - **Fallback**: Disable chroniclers if >100ms latency

2. **Chronicler failures breaking phases**: Bug in integration could crash phase
   - **Mitigation**: Comprehensive try-catch, non-fatal errors
   - **Testing**: Failure injection tests
   - **Fallback**: Disable chroniclers if too many errors

### Medium Risk

3. **Configuration complexity**: Users struggle with nested config
   - **Mitigation**: Good docs, examples, validation errors
   - **Testing**: User testing with sample configs
   - **Fallback**: Provide pre-built chronicler templates

4. **Provider health check delays**: Slow startup if providers unhealthy
   - **Mitigation**: Grace period (300ms), continue if not ready
   - **Testing**: Simulate slow/failing providers
   - **Fallback**: Skip health checks with flag

### Low Risk

5. **File I/O failures**: Disk full, permissions, etc.
   - **Mitigation**: Already handled by Chronicler output file system
   - **Testing**: Permission tests
   - **Impact**: Chronicler fails, phase continues

6. **Memory leaks**: Chroniclers hold references, don't cleanup
   - **Mitigation**: Explicit cleanup in unloadPhaseChroniclers
   - **Testing**: Memory profiling tests (Phase 2)
   - **Impact**: Gradual degradation over long runs

---

## 16. Success Criteria

### Must Have (v1)
- ✅ Chroniclers load from phase config
- ✅ Chroniclers receive all relevant events
- ✅ Chroniclers write output files to correct location
- ✅ Chroniclers cleanup on phase end
- ✅ Phase execution unaffected by chronicler failures
- ✅ Tests pass (unit, integration, E2E)
- ✅ Documentation updated

### Should Have (v1 or Phase 2)
- ⚠️ Chronicler-specific events for observability
- ⚠️ Performance monitoring/logs
- ⚠️ Queue saturation warnings
- ⚠️ Duplicate path validation

### Nice to Have (Phase 2+)
- ❌ Hot-reload
- ❌ Replay tool
- ❌ Template variables in paths
- ❌ Advanced filtering

---

## 17. Final Recommendations

### Do Now (v1 Integration)

1. **Start with phase config schema** - Clearest path, minimal risk
2. **Add TadpoleServer.loadChroniclersForPhase** - Core integration point
3. **Route events in emit()** - Simple, non-blocking
4. **Add cleanup hooks** - Prevent resource leaks
5. **Write tests** - Unit first, then integration, finally one E2E
6. **Update docs** - Users need examples

### Do Soon (Phase 2)

1. **Add chronicler events** - Important for observability
2. **Add path validation** - Prevent duplicate file conflicts
3. **Add queue monitoring** - Warn on saturation
4. **Performance profiling** - Measure actual impact

### Do Later (Phase 3+)

1. **Replay tool** - Useful for debugging
2. **Hot-reload** - Developer experience
3. **Template variables** - Nice-to-have
4. **Advanced config** - As needed based on usage

---

## 18. Confidence Levels Summary

| Area | Confidence | Risk | Notes |
|------|-----------|------|-------|
| Phase config schema | HIGH | LOW | Straightforward addition |
| TadpoleServer integration | MEDIUM-HIGH | MEDIUM | Well-defined, but multiple points |
| Event routing | HIGH | LOW | Fire-and-forget, simple |
| Cleanup/lifecycle | HIGH | LOW | Follows existing patterns |
| Output paths | MEDIUM | LOW | Needs manager API update |
| Error handling | HIGH | LOW | Already robust in chronicler system |
| Performance | MEDIUM | MEDIUM | Need to measure, likely fine |
| Testing | HIGH | LOW | Clear test strategy |
| Documentation | HIGH | LOW | Straightforward updates |
| Replayability | MEDIUM | MEDIUM | Future feature, design is clear |

**Overall Confidence**: MEDIUM-HIGH
**Overall Risk**: LOW-MEDIUM

**Recommendation**: PROCEED with Phase 1 integration
**Estimated Timeline**: 3-4 days for implementation + testing + docs

---

## 19. Things I Need You to Answer

### Configuration Questions
1. Should we enforce unique chronicler IDs within a phase, or allow duplicates?
   - **Implication**: Duplicate IDs could cause output file conflicts

2. Should chronicler configs support includes/imports (like prompt files do)?
   - **Use case**: `"config": { "$include": "./base-chronicler.json", "trigger": { ... } }`

3. Should we add a `enabled: boolean` field to phase chronicler config?
   - **Use case**: Temporarily disable without removing config

### Integration Questions
4. Should chroniclers see events from other phases in same run?
   - **Current**: They would (events routed to all active chroniclers)
   - **Alternative**: Filter by phase ID in routing

5. Should we add a server-level flag `--disable-chroniclers`?
   - **Use case**: Testing, debugging, or when chroniclers cause problems

6. How should we handle chroniclers in resumed executions?
   - **Current**: Chroniclers only see events after they load
   - **Alternative**: Offer to replay historical events?

### Output/Observability Questions
7. Should chronicler outputs be included in phase `outputFiles`?
   - **Current**: Separate - chronicler outputs stay in .tadpole
   - **Alternative**: Allow copying chronicler outputs to tadpole-results

8. Should chronicler errors be visible in Basic TUI?
   - **Current**: Only in logs
   - **Alternative**: Show warning in TUI

### Testing Questions
9. Should we add chroniclers to ALL e2e tests or just one?
   - **Trade-off**: Coverage vs test speed

10. Should we test chroniclers with mock LLM or real API calls?
    - **Current**: E2E uses real, unit/integration use mock
    - **Alternative**: Add flag to use real in integration tests

### Performance Questions
11. What's the acceptable latency budget for chronicler loading?
    - **Current estimate**: 50-200ms per chronicler
    - **Question**: Is 500ms total acceptable?

12. Should we add rate limiting for chronicler LLM calls?
    - **Use case**: Prevent chroniclers from overwhelming API
    - **Current**: No limit (provider handles it)

### Future Features
13. Should replayable chroniclers be a priority?
    - **Effort**: 2-3 days
    - **Value**: High for debugging, medium for normal use

14. Should we build a chronicler marketplace/library?
    - **Vision**: Shared chronicler configs for common tasks
    - **Scope**: Way beyond integration

---

## 20. Overengineering Watch

**Things to Avoid**:

1. ❌ **Don't**: Add chronicler-to-chronicler communication
   - **Why**: Complex, unclear use case
   - **If needed**: Phase 3+

2. ❌ **Don't**: Add chronicler priorities/ordering
   - **Why**: Order doesn't matter (parallel processing)
   - **If needed**: Phase 2 if real use case emerges

3. ❌ **Don't**: Add chronicler dependency graph
   - **Why**: Chroniclers should be independent
   - **If needed**: Probably never

4. ❌ **Don't**: Add chronicler lifecycle hooks (onLoad, onUnload, onEvent)
   - **Why**: Triggers already provide this
   - **If needed**: Phase 2+ if really needed

5. ❌ **Don't**: Add chronicler state persistence across runs
   - **Why**: Unclear semantics, high complexity
   - **If needed**: Phase 3+ with careful design

6. ❌ **Don't**: Add chronicler clustering/distribution
   - **Why**: Premature optimization
   - **If needed**: Never for v1

**Keep It Simple**: Chroniclers should be stateless observers that react to events. The current design is good. Don't add complexity without clear use cases.

---

## 21. Intention and Spirit

**Core Principles**:

1. **Non-Invasive**: Chroniclers should never interfere with phase execution
   - All operations are fire-and-forget
   - Failures are logged, not thrown
   - Resources are cleaned up proactively

2. **Observable**: Users should know what chroniclers are doing
   - Clear logs at info level
   - Error events for failures
   - Output files in predictable locations

3. **Flexible**: Chroniclers should be easy to add/remove/modify
   - Phase-level configuration for granular control
   - File-based configs for reusability
   - Sensible defaults (auto-generated paths)

4. **Performant**: Chroniclers should have minimal overhead
   - Async processing via queues
   - Lazy loading of events
   - Configurable limits to prevent runaway

5. **Testable**: Integration should be easy to verify
   - Mock-friendly design
   - Clear interfaces
   - Isolated components

**The Vision**: A user should be able to drop a pre-built chronicler config into their phase and immediately get useful observations without thinking about the plumbing.

---

## Conclusion

This integration is straightforward conceptually but has many small decisions to make. The good news:

✅ **Core system is solid**: Chroniclers work well in isolation
✅ **Integration points are clear**: Load, route, cleanup
✅ **Error handling is robust**: Failures are already graceful
✅ **Tests are comprehensive**: Just need integration layer tests

The main work is:
1. Schema updates (1 day)
2. TadpoleServer integration (1-2 days)
3. Testing (1 day)
4. Documentation (0.5 day)

**Total estimate**: 3.5-4.5 days

**Biggest risks**:
- Performance impact (need to measure)
- Edge cases in lifecycle management (need thorough testing)

**Biggest unknowns**:
- User experience with nested config
- Real-world chronicler failure modes

**Recommendation**: Build it, test it thoroughly, get feedback before declaring done.

