# Chronicler Integration Execution Spec (FINAL - v3)

**Date**: 2025-02-11
**Status**: Post-Implementation - Lessons Learned

**IMPORTANT**: Code examples in this spec are instructional and should be adapted to your codebase conventions, not copied verbatim. Variable names, error handling patterns, and logging styles should match your existing code.

---

## Executive Summary

This spec details the integration of the Chronicler system into Tadpole Server. Chroniclers are ~90% complete as standalone components. This integration connects them to the phase lifecycle, event stream, and configuration system.

**Core Architecture** (Confirmed):
- ✅ ONE ChroniclerManager instance per TadpoleServer (persists entire server lifetime)
- ✅ Chronicler instances created per phase (destroyed when phase ends)
- ✅ File-based chronicler configs (primary) + inline support (fallback)
- ✅ Fire-and-forget event routing via EventEmitter pattern
- ✅ Non-fatal errors by default (except when `failPhaseIfNotLoaded: true`)

**Key Design Principles**:
1. **Wrapper Pattern**: Chronicler configs wrapped with phase-specific settings (keeps chroniclers reusable)
2. **Clear Naming**: `ChroniclerConfigLoader` (not ChroniclerLoader), `failPhaseIfNotLoaded` (not required), `loadConfigsForPhase` (not loadChroniclersForPhase)
3. **Specific Failure Reasons**: Use "chronicler-load-failure" type (not "unknown")
4. **Config Validation**: Update `server/config.ts` to validate chroniclers field

---

## Table of Contents

1. [Configuration Schema](#1-configuration-schema)
2. [Server Configuration Updates](#2-server-configuration-updates)
3. [Chronicler Config Loading System](#3-chronicler-config-loading-system)
4. [TadpoleServer Integration](#4-tadpoleserver-integration)
5. [Event Routing](#5-event-routing)
6. [State Management](#6-state-management)
7. [Cost Tracking](#7-cost-tracking)
8. [Phase Failure Handling](#8-phase-failure-handling)
9. [Testing Strategy](#9-testing-strategy)
10. [Implementation Checklist](#10-implementation-checklist)
11. [Future Enhancements](#11-future-enhancements)

---

## 1. Configuration Schema

### 1.1 Phase Config Extension

**File**: `server/types/types.ts`

```typescript
export interface PhaseConfig {
  // ... existing fields ...

  /**
   * Chroniclers to run during this phase.
   * Chroniclers are parallel observation agents that process the event stream.
   *
   * Each entry is a wrapper object with:
   * - chroniclerConfig: Portable chronicler configuration (file or inline)
   * - settings: Phase-specific settings (output paths, load requirements)
   *
   * This wrapper pattern keeps chronicler configs reusable across phases.
   */
  chroniclers?: PhaseChroniclerEntry[];
}

/**
 * Phase-level chronicler entry.
 * Wraps chronicler config with phase-specific settings.
 *
 * This separation keeps chronicler configs reusable across phases
 * while allowing phase-specific configuration.
 */
export interface PhaseChroniclerEntry {
  /**
   * Chronicler configuration.
   * Can be:
   * - File path (string): "./chroniclers/narrator.json"
   * - Inline config (object): Full ChroniclerConfig
   */
  chroniclerConfig: string | ChroniclerConfig;

  /**
   * Phase-specific settings for this chronicler.
   */
  settings?: {
    /**
     * Fail the phase if this chronicler fails to load.
     *
     * IMPORTANT: This only affects LOAD-TIME failures (config errors, file not found, etc).
     * Does NOT fail the phase if:
     * - Chronicler needs to be unloaded mid-execution (due to errors)
     * - Chronicler LLM calls fail (those are handled by error thresholds)
     * - Chronicler queue overflows
     *
     * Use for mission-critical chroniclers where phase cannot proceed without them.
     * Default: false (chroniclers are optional)
     */
    failPhaseIfNotLoaded?: boolean;

    /**
     * Output file paths for this chronicler in this phase.
     * If omitted, chronicler auto-generates paths in .tadpole/chronicler-outputs/
     * You can use filenames to join together logs from different chroniclers.
     * Path convention:
     * - Filename only (no '/'): .tadpole/chronicler-outputs/{id}/{filename}
     * - Path with '/': {executionPath}/{path}
     */
    outputPaths?: {
      logFile?: string;
      lastValueFile?: string;
    };
  };
}
```

**Example Configurations**:

```json
{
  "id": "phase-1",
  "name": "Analysis Phase",
  "chroniclers": [
    {
      "chroniclerConfig": "./chroniclers/narrator.json"
    },
    {
      "chroniclerConfig": "./chroniclers/security-audit.json",
      "settings": {
        "failPhaseIfNotLoaded": true
      }
    },
    {
      "chroniclerConfig": {
        "id": "quick-counter",
        "name": "Event Counter",
        "trigger": { "type": "event", "on": ["*"] },
        "execution": { "strategy": "count", "threshold": 10 },
        "userPromptText": "Count: <%= it.events.length %>",
        "model": "anthropic/claude-3-5-haiku-20241022"
      }
    },
    {
      "chroniclerConfig": "./chroniclers/metrics.json",
      "settings": {
        "outputPaths": {
          "logFile": "metrics/phase-1-metrics.ndjson",
          "lastValueFile": "metrics/current.json"
        }
      }
    }
  ]
}
```

**Key Points**:
- ✅ Wrapper keeps chronicler configs portable (no phase-specific data in config)
- ✅ Settings live at phase level (output paths, load requirements)
- ✅ File references are primary, inline is fallback
- ✅ Clear naming (`failPhaseIfNotLoaded` not `required`)

### 1.2 Validation Schema

**File**: `server/config-validation/chronicler.schema.ts` (update)

```typescript
// Phase-specific settings schema
export const phaseChroniclerSettingsSchema = z.object({
  failPhaseIfNotLoaded: z.boolean().optional(),
  outputPaths: z.object({
    logFile: z.string().optional(),
    lastValueFile: z.string().optional(),
  }).optional(),
}).optional();

// Phase chronicler entry schema (wrapper pattern)
export const phaseChroniclerEntrySchema = z.object({
  chroniclerConfig: z.union([
    z.string(),  // File path
    chroniclerConfigSchema,  // Inline config
  ]),
  settings: phaseChroniclerSettingsSchema,
});

// Export type
export type PhaseChroniclerSettings = z.infer<typeof phaseChroniclerSettingsSchema>;
```

### 1.3 Config.ts Validation Update

**File**: `server/config.ts`

**IMPORTANT**: Add validation for the new `chroniclers` field to catch errors at startup

```typescript
// Import new schemas
import { phaseChroniclerEntrySchema } from "./config-validation/chronicler.schema.js";

// Add to phase validation schema
const phaseConfigSchema = z.object({
  // ... existing fields ...
  chroniclers: z.array(phaseChroniclerEntrySchema).optional(),
});
```

**Additional Validation Checks**:
The schema alone isn't enough. Also validate:
1. File paths exist (if using file references)
2. No duplicate chronicler IDs within a phase
3. If failPhaseIfNotLoaded is used, config must be valid

**Implementation Example**:
```typescript
// Example validation logic for config.ts
for (const phase of phases) {
  if (phase.chroniclers) {
    const seenIds = new Set<string>();

    for (const entry of phase.chroniclers) {
      // Validate schema
      const validationResult = phaseChroniclerEntrySchema.safeParse(entry);
      if (!validationResult.success) {
        errors.push(`Phase ${phase.id}: Invalid chronicler entry - ${validationResult.error}`);
        continue;
      }

      // Check file exists (if file reference)
      if (typeof entry.chroniclerConfig === 'string') {
        const resolvedPath = path.resolve(configDir, entry.chroniclerConfig);
        if (!fs.existsSync(resolvedPath)) {
          const severity = entry.settings?.failPhaseIfNotLoaded ? 'ERROR' : 'WARNING';
          errors.push(`Phase ${phase.id}: Chronicler config not found: ${entry.chroniclerConfig} [${severity}]`);
        }
      }

      // Check for duplicates (extract ID from config)
      const config = typeof entry.chroniclerConfig === 'string'
        ? JSON.parse(fs.readFileSync(path.resolve(configDir, entry.chroniclerConfig), 'utf-8'))
        : entry.chroniclerConfig;

      if (seenIds.has(config.id)) {
        errors.push(`Phase ${phase.id}: Duplicate chronicler ID '${config.id}'`);
      }
      seenIds.add(config.id);
    }
  }
}
```

---

## 2. Server Configuration Updates

### 2.1 Add ChroniclerManager Options

**File**: `server/types/types.ts`

```typescript
export interface ServerConfig {
  // ... existing fields ...

  /**
   * Chronicler system configuration.
   * Controls behavior of ChroniclerManager for all phases.
   */
  chronicler: {
    /**
     * Enable filesystem persistence for chronicler outputs and history.
     * Default: true
     */
    enablePersistence: boolean;

    /**
     * Grace period to wait for provider health checks before loading chroniclers.
     * Allows some providers to become available without blocking phase start.
     * Default: 2000ms (2 seconds)
     */
    healthCheckGracePeriodMs: number;

    /**
     * Whether to wait for ALL provider health checks before proceeding.
     * If false, uses grace period then continues.
     * Default: false (don't block)
     */
    waitForAllHealthChecks: boolean;
  };
}
```

### 2.2 Default Configuration

**File**: `server/config.ts`

```typescript
export const DEFAULT_CONFIG = {
  // ... existing defaults ...

  chronicler: {
    enablePersistence: true,
    healthCheckGracePeriodMs: 2000,  // 2 seconds
    waitForAllHealthChecks: false,
  },
} as const;
```

---

## 3. Chronicler Config Loading System

### 3.1 ChroniclerConfigLoader Utility

**New File**: `server/chroniclers/chronicler-config-loader.ts`

**RENAMED**: From `ChroniclerLoader` → `ChroniclerConfigLoader` (clearer that it loads configs, not chronicler instances)

```typescript
import fs from "node:fs";
import path from "node:path";
import type { ChroniclerConfig } from "../types/chronicler-types.js";
import type { PhaseChroniclerEntry } from "../types/types.js";
import { chroniclerConfigSchema } from "../config-validation/chronicler.schema.js";

/**
 * Loaded chronicler config with metadata.
 */
export interface LoadedChroniclerConfig {
  config: ChroniclerConfig;
  failPhaseIfNotLoaded: boolean;
  outputPaths?: {
    logFile?: string;
    lastValueFile?: string;
  };
  source: "file" | "inline";
  sourcePath?: string;  // For file-based configs
  configDirectory: string;  // For resolving relative paths (promptFile, schemaFile, etc.)
}

/**
 * Result of loading chronicler configs.
 */
export interface ChroniclerConfigLoadResult {
  configs: LoadedChroniclerConfig[];
  errors: Array<{
    ref: string;
    error: string;
    fatal: boolean;  // True if failPhaseIfNotLoaded was set
  }>;
}

/**
 * Loads and validates chronicler configurations from files or inline objects.
 * Caches file-based configs to avoid redundant reads.
 *
 * RENAMED from ChroniclerLoader to clarify it loads CONFIGS, not Chronicler instances.
 */
export class ChroniclerConfigLoader {
  private configCache: Map<string, ChroniclerConfig> = new Map();

  constructor(
    private logger?: { log: (msg: string, level?: string) => void },
  ) {}

  /**
   * Load chronicler configs for a phase.
   *
   * RENAMED from loadChroniclersForPhase to loadConfigsForPhase (clearer naming).
   *
   * @param entries - Array of chronicler entries (wrapper objects)
   * @param phaseId - ID of the phase (for error messages)
   * @param phaseConfigDir - Directory containing phases.json (for resolving relative paths)
   * @returns Load result with successful configs and errors
   */
  loadConfigsForPhase(
    entries: PhaseChroniclerEntry[],
    phaseId: string,
    phaseConfigDir: string,
  ): ChroniclerConfigLoadResult {
    const configs: LoadedChroniclerConfig[] = [];
    const errors: ChroniclerConfigLoadResult["errors"] = [];
    const seenIds = new Set<string>();

    for (const entry of entries) {
      try {
        let config: ChroniclerConfig;
        let configDir: string;
        let source: "file" | "inline";
        let sourcePath: string | undefined;

        // Extract settings from wrapper
        const failPhaseIfNotLoaded = entry.settings?.failPhaseIfNotLoaded ?? false;
        const outputPaths = entry.settings?.outputPaths;

        if (typeof entry.chroniclerConfig === "string") {
          // File reference
          const resolvedPath = path.isAbsolute(entry.chroniclerConfig)
            ? entry.chroniclerConfig
            : path.resolve(phaseConfigDir, entry.chroniclerConfig);

          // Check cache first
          if (this.configCache.has(resolvedPath)) {
            config = this.configCache.get(resolvedPath)!;
            this.logger?.log(
              `Using cached chronicler config: ${path.basename(resolvedPath)}`,
              "debug"
            );
          } else {
            // Load and validate
            if (!fs.existsSync(resolvedPath)) {
              throw new Error(`Config file not found: ${entry.chroniclerConfig}`);
            }

            const content = fs.readFileSync(resolvedPath, "utf-8");
            const parsed = JSON.parse(content);
            config = chroniclerConfigSchema.parse(parsed);

            // Cache for reuse
            this.configCache.set(resolvedPath, config);
            this.logger?.log(
              `Loaded and cached chronicler config: ${path.basename(resolvedPath)}`,
              "debug"
            );
          }

          configDir = path.dirname(resolvedPath);
          source = "file";
          sourcePath = resolvedPath;
        } else {
          // Inline config
          config = chroniclerConfigSchema.parse(entry.chroniclerConfig);
          configDir = phaseConfigDir;
          source = "inline";
        }

        // Check for duplicate IDs
        if (seenIds.has(config.id)) {
          throw new Error(
            `Duplicate chronicler ID '${config.id}' in phase ${phaseId}`
          );
        }
        seenIds.add(config.id);

        configs.push({
          config,
          failPhaseIfNotLoaded,
          outputPaths,
          source,
          sourcePath,
          configDirectory: configDir,
        });

        this.logger?.log(
          `Loaded chronicler config '${config.id}' (${source})${failPhaseIfNotLoaded ? " [REQUIRED]" : ""}`,
          "debug"
        );
      } catch (error) {
        const refStr = typeof entry.chroniclerConfig === "string"
          ? entry.chroniclerConfig
          : `inline:${(entry.chroniclerConfig as any).id || "unknown"}`;
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isFatal = entry.settings?.failPhaseIfNotLoaded ?? false;

        errors.push({
          ref: refStr,
          error: errorMsg,
          fatal: isFatal,
        });

        this.logger?.log(
          `Failed to load chronicler config ${refStr}: ${errorMsg}${isFatal ? " [FATAL]" : ""}`,
          isFatal ? "error" : "warn"
        );
      }
    }

    return { configs, errors };
  }

  /**
   * Clear the config cache.
   * Useful for testing or hot-reload scenarios.
   */
  clearCache(): void {
    this.configCache.clear();
    this.logger?.log("Chronicler config cache cleared", "debug");
  }
}
```

**Benefits**:
1. ✅ Caching prevents redundant file reads
2. ✅ Supports both file and inline configs
3. ✅ Clear error handling with fatal vs non-fatal
4. ✅ Duplicate ID detection
5. ✅ Stateful (can be reused across phases)
6. ✅ Clear naming (loads CONFIGS not instances)

---

## 4. TadpoleServer Integration

### 4.1 Constructor Changes

**File**: `server/tadpole-server.ts`

```typescript
import { ChroniclerManager } from "./chroniclers/chronicler-manager.js";
import { ChroniclerConfigLoader } from "./chroniclers/chronicler-config-loader.js";

export class TadpoleServer extends TypedEventEmitter<ServerInternalEvents> {
  // ... existing properties ...

  // Chronicler system
  private chroniclerManager: ChroniclerManager;
  private chroniclerConfigLoader: ChroniclerConfigLoader;
  private currentPhaseChroniclers = new Set<string>();

  constructor(config: ServerConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as ServerConfig;

    // ... existing initialization ...

    // Initialize chronicler config loader (stateful, with cache)
    this.chroniclerConfigLoader = new ChroniclerConfigLoader(this.logger);

    // Initialize ChroniclerManager
    this.chroniclerManager = new ChroniclerManager({
      logger: this.logger,
      enablePersistence: this.config.chronicler.enablePersistence,
      healthCheckGracePeriodMs: this.config.chronicler.healthCheckGracePeriodMs,
      waitForHealthChecks: this.config.chronicler.waitForAllHealthChecks,
    });

    // Initialize manager (creates .tadpole/chroniclers directory)
    await this.chroniclerManager.initialize();

    // Set up event routing
    this.setupChroniclerEventRouting();
  }

  /**
   * Set up event routing to chroniclers using EventEmitter pattern.
   * Listening on the server's own "event" emissions is cleaner than
   * modifying the emit() override method.
   */
  private setupChroniclerEventRouting(): void {
    this.on("event", (event) => {
      // Only route Server State and Agentic Backbone events
      // Connection State events are client-specific
      if (isServerStateEvent(event) || isAgenticBackboneEvent(event)) {
        // Fire-and-forget pattern - don't block event emission
        this.chroniclerManager.handleEvent(event).catch((error) => {
          this.logger.log(
            `Error in chronicler event handling: ${error}`,
            "error"
          );
        });
      }
    });
  }
}
```

**Implementation Notes**:
- ChroniclerConfigLoader is stateful (caching), created once in constructor
- ChroniclerManager configured from server.config.chronicler section
- Event routing uses EventEmitter pattern (listening on "event" emissions)
- currentPhaseChroniclers Set tracks active chronicler IDs for cost retrieval and cleanup

### 4.2 Phase Start Integration

**Location**: `TadpoleServer.startPhase()`
**After**: Workspace setup, **before** starting Claude

```typescript
private async startPhase(phaseId: PhaseId, skipPreCommands?: boolean): Promise<void> {
  const phase = this.config.phases.find((p) => p.id === phaseId);
  if (!phase) {
    await this.handleError(/* ... */);
    return;
  }

  // ... existing workspace setup logic ...

  // Transition to starting
  this.stateManager.transition({
    type: "PhaseTransitioned",
    data: {
      runId: this.currentRunId,
      phaseId: phase.id,
      from: "preparing",
      to: "starting",
    },
  });

  // Load chroniclers for this phase
  const chroniclerResult = await this.loadChroniclersForPhase(phase);

  // Check for fatal chronicler load failures
  const fatalFailures = chroniclerResult.errors.filter((e) => e.fatal);
  if (fatalFailures.length > 0) {
    const failedChroniclers = fatalFailures.map((e) => e.ref).join(", ");
    const errorMsg = `Required chroniclers failed to load (failPhaseIfNotLoaded=true): ${failedChroniclers}`;

    // Use specific failure reason type
    this.phaseFailureReason = {
      type: "chronicler-load-failure",
      retriable: false,
      message: errorMsg,
      chroniclerRefs: fatalFailures.map((e) => e.ref),  // Include for debugging
    };

    this.stateManager.transition({
      type: "PhaseTransitioned",
      data: {
        runId: this.currentRunId!,
        phaseId: phase.id,
        from: "starting",
        to: "failed",
        metadata: {
          failedDuring: "starting",
          failureReason: this.phaseFailureReason,
        },
      },
    });

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: errorMsg,
        context: `Failed chroniclers: ${failedChroniclers}`,
        phase: phase.id,
        fatal: true,
        severity: ErrorSeverity.PHASE,
        code: "CHRONICLER_LOAD_FAILURE",
      },
    } as ErrorEvent);

    this.cleanupCurrentPhase();
    return;
  }

  // Log warnings for non-fatal failures
  for (const error of chroniclerResult.errors.filter((e) => !e.fatal)) {
    this.logger.log(
      `Non-required chronicler failed to load (${error.ref}): ${error.error}`,
      "warn"
    );
  }

  // ... continue with Claude process spawn ...
}
```

### 4.3 Chronicler Loading Method

```typescript
/**
 * Load chroniclers for a phase.
 * Parses configs, passes to ChroniclerManager for instantiation.
 *
 * @returns Result with loaded configs and any errors
 */
private async loadChroniclersForPhase(
  phase: PhaseConfig
): Promise<{ loaded: LoadedChroniclerConfig[]; errors: ChroniclerConfigLoadResult["errors"] }> {
  if (!phase.chroniclers || phase.chroniclers.length === 0) {
    return { loaded: [], errors: [] };
  }

  this.logger.log(
    `Loading ${phase.chroniclers.length} chronicler config(s) for phase ${phase.id}`,
    "info"
  );

  // Use config loader to parse and validate
  const phaseConfigDir = path.dirname(this.config.configPath || this.config.cwd);
  const loadResult = this.chroniclerConfigLoader.loadConfigsForPhase(
    phase.chroniclers,
    phase.id,
    phaseConfigDir
  );

  if (loadResult.errors.length > 0) {
    this.logger.log(
      `${loadResult.errors.length} chronicler config(s) failed to load`,
      "warn"
    );
  }

  if (loadResult.configs.length === 0) {
    this.logger.log("No chroniclers loaded for this phase", "info");
    return { loaded: [], errors: loadResult.errors };
  }

  // Pass to ChroniclerManager for instantiation
  try {
    const configs = loadResult.configs.map((lc) => lc.config);
    const configDirs = loadResult.configs.map((lc) => lc.configDirectory);
    const outputPathsMap = new Map(
      loadResult.configs
        .filter((lc) => lc.outputPaths)
        .map((lc) => [lc.config.id, lc.outputPaths!])
    );

    // ChroniclerManager internally unloads previous phase's chroniclers
    await this.chroniclerManager.loadChroniclersForPhase(
      configs,
      phase.id as PhaseId,
      this.createFallbackLlmCall(),  // Fallback when no providers available
      configDirs[0],  // Primary config directory
      new Date(),  // Run start time
      undefined,  // onExecute (for testing)
      this.createFallbackLlmObjectCall(),
      this.config.executionPath,
      outputPathsMap.size > 0 ? outputPathsMap : undefined,
    );

    // Track loaded chronicler IDs
    this.currentPhaseChroniclers.clear();
    for (const config of configs) {
      this.currentPhaseChroniclers.add(config.id);
    }

    this.logger.log(
      `Successfully loaded ${configs.length} chronicler instance(s)`,
      "info"
    );

    return { loaded: loadResult.configs, errors: loadResult.errors };
  } catch (error) {
    const errorMsg = `Failed to instantiate chroniclers in ChroniclerManager: ${error}`;

    // Treat as fatal if all loaded configs had failPhaseIfNotLoaded=true
    const allRequired = loadResult.configs.every((lc) => lc.failPhaseIfNotLoaded);

    return {
      loaded: [],
      errors: [
        {
          ref: "ChroniclerManager",
          error: errorMsg,
          fatal: allRequired,
        },
      ],
    };
  }
}

/**
 * Create fallback LLM call function.
 * Throws error when called (ChroniclerManager will skip the chronicler).
 */
private createFallbackLlmCall() {
  return async (
    chroniclerId: string,
    options: TadpoleGenerateTextOptions,
  ): Promise<TadpoleGenerateTextResult> => {
    throw new Error(`No LLM providers available for chronicler ${chroniclerId}`);
  };
}

private createFallbackLlmObjectCall() {
  return async (
    chroniclerId: string,
    options: TadpoleGenerateObjectOptions,
  ): Promise<TadpoleGenerateObjectResult<unknown>> => {
    throw new Error(`No LLM providers available for chronicler ${chroniclerId}`);
  };
}
```

**Design Decisions**:

1. **Renamed to ChroniclerConfigLoader**
   - Clearer that it loads configs, not Chronicler instances
   - Manager handles actual instantiation

2. **Method renamed to loadConfigsForPhase**
   - More accurate naming (loads configs, not chroniclers)

3. **Fallback functions throw errors (temporary)**
   - **User Decision**: Keep optional for now (for test compatibility)
   - Will refactor out post-integration (ChroniclerManager should use its own registry)
   - Vestigial from test architecture, not needed in production
   - **TODO**: Remove fallback params after all integration tests pass

4. **Wrapper pattern enforced**
   - `chroniclerConfig` + `settings` separation
   - Keeps chronicler configs portable

---

## 5. Event Routing

**Already handled in constructor** via `setupChroniclerEventRouting()`.

**Events Routed to Chroniclers**:

**Server State Events**:
- `phase.started`
- `phase.completed`
- `state.snapshot`
- `server.idle`
- `token.usage`
- `info`
- `error`
- `checkpoint.list`
- `rollback.*` events
- `state.transition`

**Agentic Backbone Events**:
- `assistant.action`
- `tool.result`
- `file.updated`
- `filetree.updated`

**NOT Routed** (Connection State):
- `server.ready`
- `pong`
- `history.batch`
- `incomplete.phase`

---

## 6. State Management

### 6.1 New State: `completing-chroniclers`

**User Decision**: Add `completing-chroniclers` state for visibility

**Why**: Chronicler work completion can take time (queue draining), and it's important to signal "agent done, chroniclers still working"

**State Machine Update**:

```
preparing
    ↓
starting → [load chronicler configs - no new state] → [spawn Claude]
    ↓
initializing
    ↓
running → [chroniclers process events in parallel]
    ↓
completing-chroniclers → [completeAllWork(), get costs] → completed/failed/skipped
```

**Key Points**:
- ✅ NO state for chronicler loading (fast enough, happens during `starting`)
- ✅ YES state for chronicler completion (can be slow, needs visibility)
- ✅ ALWAYS transition through `completing-chroniclers` (even for 0 chroniclers)
- ✅ Include metadata: chronicler count, remaining work

### 6.2 Phase Status Type Update

**File**: `server/types/state-types.ts`

```typescript
export type PhaseStatus =
  | "preparing"
  | "starting"
  | "initializing"
  | "running"
  | "completing-chroniclers"
  | "completed"
  | "failed"
  | "skipped";

// Update isTerminalPhaseStatus helper
export function isTerminalPhaseStatus(status: PhaseStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

// CRITICAL: Update PhaseTransitions map to allow running → completing-chroniclers
export const PhaseTransitions: Record<PhaseStatus, PhaseStatus[]> = {
  // ... existing transitions ...
  running: ["completing-chroniclers", "completed", "failed", "skipped"],
  "completing-chroniclers": ["completed", "failed", "skipped"],
  // ...
};
```

**ACTUAL BUG ENCOUNTERED**: During implementation, forgot to allow `running → completed` as fallback. The transition map MUST allow both paths:
- `running → completing-chroniclers → completed` (normal path)
- `running → completed` (direct path for compatibility)

### 6.3 State Transition Implementation

**Location**: `TadpoleServer.handlePhaseComplete()`

**IMPLEMENTATION NOTE**: The completing-chroniclers transition is currently NOT implemented in the actual code. The state and transitions are added to support it, but the current implementation goes directly from `running → completed`. This section shows how to add it when ready.

```typescript
private async handlePhaseComplete(exitCode: number): Promise<void> {
  if (!this.currentPhase) return;

  const phaseId = this.currentPhase.phase.id;

  // Get current phase from state
  const currentPhase = this.stateManager.getPhaseInCurrentRun(PhaseId(phaseId));
  if (!currentPhase || isTerminalPhaseStatus(currentPhase.status)) return;

  // Wait for log parsing
  await new Promise((resolve) => setTimeout(resolve, this.config.logParsingInterval * 2));

  // Transition to completing-chroniclers (optional but recommended for visibility)
  const chroniclerCount = this.currentPhaseChroniclers.size;

  this.stateManager.transition({
    type: "PhaseTransitioned",
    data: {
      runId: this.currentRunId!,
      phaseId,
      from: currentPhase.status,
      to: "completing-chroniclers",
      metadata: {
        chroniclerCount,
        chroniclerIds: Array.from(this.currentPhaseChroniclers),
      },
    },
  });

  // Send event so clients see the transition
  this.emit("event", {
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "info",
    data: {
      message: chroniclerCount > 0
        ? `Completing work for ${chroniclerCount} chronicler(s)...`
        : "No chroniclers to complete",
    },
  } as InfoEvent);

  // Complete chronicler work (this may take time for large queues)
  if (this.chroniclerManager) {
    await this.chroniclerManager.completeAllWork();

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "info",
      data: {
        message: chroniclerCount > 0
          ? `Chronicler work completed (${chroniclerCount} chronicler(s))`
          : "Chronicler completion phase complete",
      },
    } as InfoEvent);
  }

  // Get chronicler costs
  let chroniclerCostMap: Record<string, number> = {};
  if (this.chroniclerManager && chroniclerCount > 0) {
    const costs = this.chroniclerManager.getChroniclerCosts();
    for (const [id, cost] of costs) {
      chroniclerCostMap[id] = cost;
    }

    const totalChroniclerCost = Object.values(chroniclerCostMap).reduce((a, b) => a + b, 0);
    this.logger.log(
      `Chronicler costs: ${JSON.stringify(chroniclerCostMap)} (total: $${totalChroniclerCost.toFixed(6)})`,
      "info"
    );
  }

  // ... rest of handlePhaseComplete (determine final status, create checkpoint, final transition) ...
}
```

**State Metadata**:
```typescript
// When transitioning TO completing-chroniclers
metadata: {
  chroniclerCount: number;
  chroniclerIds: string[];
}
```

**Benefits**:
1. ✅ Clients can show "completing chroniclers" status
2. ✅ Clear signal: agent done, chroniclers working
3. ✅ Consistent state machine (always go through this state)
4. ✅ Metadata provides visibility into what's happening

---

## 7. Cost Tracking

### 7.1 Include Chronicler Info in Phase Events

**User Feedback**: "Costs and status should show up in phase.started and phase.completed"

#### After Chroniclers Load (in phase.started region)

```typescript
// In TadpoleServer.loadChroniclersForPhase()
if (loadResult.configs.length > 0) {
  const chroniclerIds = loadResult.configs.map((c) => c.config.id).join(", ");

  this.emit("event", {
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "info",
    data: {
      message: `Loaded ${loadResult.configs.length} chronicler(s): ${chroniclerIds}`,
    },
  } as InfoEvent);
}
```

#### Phase Completed

```typescript
// In TadpoleServer.handlePhaseComplete()
private async handlePhaseComplete(exitCode: number): Promise<void> {
  // ... existing logic ...

  // Complete chronicler work BEFORE getting costs
  await this.chroniclerManager?.completeAllWork();

  // Get chronicler costs (requires new API in ChroniclerManager)
  let chroniclerTotalCost = 0;
  const chroniclerCostMap: Record<string, number> = {};

  if (this.chroniclerManager && this.currentPhaseChroniclers.size > 0) {
    const costs = this.chroniclerManager.getChroniclerCosts();
    for (const [id, cost] of costs) {
      chroniclerCostMap[id] = cost;
      chroniclerTotalCost += cost;
    }

    this.logger.log(
      `Phase ${phaseId} chronicler costs: ${JSON.stringify(chroniclerCostMap)} (total: $${chroniclerTotalCost.toFixed(6)})`,
      "info"
    );
  }

  // ... create checkpoint, state transitions ...

  // Send phase.completed
  this.emit("event", {
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "phase.completed",
    data: {
      phaseId,
      success: finalStatus === "completed",
      cost: reportedCost,  // Main phase cost (chronicler costs separate)
      duration: Date.now() - startTime,
      exitStatus: /* ... */,
    },
  } as PhaseCompletedEvent);

  // Chronicler costs logged separately (see above)
  // Future: Add chroniclers field to phase.completed event
}
```

### 7.2 Chronicler Cost API (IMPLEMENT NOW)

**File**: `server/chroniclers/chronicler-manager.ts`

**CRITICAL**: This must be implemented, not deferred.

```typescript
/**
 * Get total cost for each currently loaded chronicler.
 *
 * IMPORTANT: Only returns costs for chroniclers loaded in the CURRENT phase.
 * When loadChroniclersForPhase() is called for a new phase, previous chroniclers
 * are unloaded and their cost data is lost. If you need historical costs,
 * capture them before phase completion.
 *
 * @returns Map of chronicler ID to total accumulated cost
 */
public getChroniclerCosts(): Map<string, number> {
  const costs = new Map<string, number>();
  for (const chronicler of this.chroniclers) {
    costs.set(chronicler.getId(), chronicler.getTotalCost());
  }
  return costs;
}
```

**Usage Pattern**:
```typescript
// In handlePhaseComplete(), AFTER completeAllWork()
const costs = this.chroniclerManager.getChroniclerCosts();
// Map is ready to use - no remapping needed
for (const [id, cost] of costs) {
  this.logger.log(`Chronicler ${id}: $${cost.toFixed(6)}`);
}
```

**Cost Scope**:
- Returns costs for **current phase only** (active chroniclers)
- Previous phases' chronicler costs are **NOT retained**
- Costs must be captured in handlePhaseComplete() before next phase loads

**Optional Future**: Add chronicler metrics to `phase.completed` event schema:

```typescript
// In event-schemas.ts
export const phaseCompletedEventDataSchema = z.object({
  // ... existing fields ...
  chroniclers: z.object({
    count: z.number(),
    totalCost: z.number(),
    costs: z.record(z.string(), z.number()),  // Map of ID → cost
  }).optional(),
});
```

---

## 8. Phase Failure Handling

### 8.1 New Failure Reason Type

**User Feedback**: "phaseFailureReason shouldn't be 'unknown' - we know which chroniclers failed"

**File**: `server/schemas/event-schemas.ts` (or wherever FailureReason is defined)

```typescript
// Update FailureReason schema
const failureReasonSchema = z.object({
  type: z.enum([
    "timeout",
    "rate-limit",
    "api-error",
    "chronicler-load-failure",  // NEW: Specific type for chronicler failures
    "unknown"
  ]),
  retriable: z.boolean(),
  message: z.string().optional(),
  chroniclerRefs: z.array(z.string()).optional(),  // NEW: Which chroniclers failed
});
```

### 8.2 Implementation in TadpoleServer

**Already shown in Section 4.2** - uses specific type:

```typescript
this.phaseFailureReason = {
  type: "chronicler-load-failure",  // NOT "unknown"
  retriable: false,
  message: errorMsg,
  chroniclerRefs: fatalFailures.map((e) => e.ref),
};
```

**Benefits**:
- ✅ Clear reason in logs and events
- ✅ Debuggable (includes which chroniclers failed)
- ✅ Distinct from other failure types
- ✅ Shows chroniclers are a solid part of Tadpole

---

## 9. Comprehensive Testing Strategy

This section maps all behaviors, quirks, and edge cases to specific test types.

### 9.1 Unit Tests

#### ChroniclerConfigLoader (`tests/unit/chronicler-config-loader.test.ts`)

**Basic Loading**:
- ✅ Load chronicler config from file path (absolute)
- ✅ Load chronicler config from file path (relative to phase config)
- ✅ Load chronicler config from inline object
- ✅ Load mixed: some file, some inline

**Caching Behavior**:
- ✅ First load reads from disk
- ✅ Second load of same file uses cache
- ✅ Cache hit logs debug message
- ✅ clearCache() clears cache
- ✅ After clearCache(), file is read again

**Wrapper Pattern Parsing**:
- ✅ Extract `chroniclerConfig` from wrapper
- ✅ Extract `settings.failPhaseIfNotLoaded` (defaults to false)
- ✅ Extract `settings.outputPaths` (undefined if not provided)
- ✅ File reference with no settings (settings = undefined)
- ✅ Inline config with all settings
- ✅ Settings without failPhaseIfNotLoaded (just outputPaths)

**Error Handling**:
- ✅ File not found → error with fatal=false (unless failPhaseIfNotLoaded)
- ✅ File not found with failPhaseIfNotLoaded=true → fatal=true
- ✅ Invalid JSON → error with clear message
- ✅ Zod validation error → error with schema details
- ✅ Duplicate chronicler ID within phase → error
- ✅ First chronicler succeeds, second fails → first in configs, second in errors
- ✅ Multiple errors accumulated correctly

**Config Directory Resolution**:
- ✅ File reference → configDirectory is dirname of file
- ✅ Inline reference → configDirectory is phaseConfigDir
- ✅ Absolute path → resolved correctly
- ✅ Relative path → resolved relative to phaseConfigDir

#### TadpoleServer Integration (`tests/unit/tadpole-server-chronicler-integration.test.ts`)

**Initialization**:
- ✅ ChroniclerManager created in constructor with correct options
- ✅ ChroniclerConfigLoader created in constructor
- ✅ currentPhaseChroniclers Set initialized empty
- ✅ setupChroniclerEventRouting() sets up listener

**Event Routing**:
- ✅ Server State events routed to manager
- ✅ Agentic Backbone events routed to manager
- ✅ Connection State events NOT routed
- ✅ Event routing errors caught and logged (don't crash)

**Phase Loading**:
- ✅ loadChroniclersForPhase() called during startPhase
- ✅ Called AFTER workspace setup
- ✅ Called BEFORE Claude process spawn
- ✅ currentPhaseChroniclers Set populated with loaded IDs

**Failure Handling**:
- ✅ failPhaseIfNotLoaded=true → phase fails with "chronicler-load-failure"
- ✅ failPhaseIfNotLoaded=false → phase continues, warning logged
- ✅ Multiple fatal failures → all listed in error message
- ✅ Mixed fatal/non-fatal → phase fails, non-fatal warnings logged
- ✅ FailureReason.chroniclerRefs contains correct refs
- ✅ Error event has code "CHRONICLER_LOAD_FAILURE"

**Cost Tracking**:
- ✅ getChroniclerCosts() called in handlePhaseComplete
- ✅ Costs logged with chronicler IDs
- ✅ Zero chroniclers → no cost logging

**Cleanup**:
- ✅ shutdown() calls manager.shutdown()
- ✅ Shutdown waits for manager shutdown to complete

### 9.2 Integration Tests

#### Chronicler Phase Integration (`tests/integration/chronicler-phase-integration.test.ts`)

**Config Loading Patterns**:
- ✅ Single file-based chronicler with wrapper
- ✅ Single inline chronicler with wrapper
- ✅ Multiple file-based chroniclers
- ✅ Multiple inline chroniclers
- ✅ Mixed file and inline in same phase
- ✅ File reference with custom output paths
- ✅ Inline config with custom output paths

**Caching Across Phases**:
- ✅ Phase 1 loads chronicler from file (cache miss)
- ✅ Phase 2 loads same chronicler (cache hit)
- ✅ Phase 2 loads different chronicler (cache miss)
- ✅ Cache persists across phase boundaries

**Requirement Enforcement**:
- ✅ failPhaseIfNotLoaded=true with missing file → phase fails
- ✅ failPhaseIfNotLoaded=true with invalid JSON → phase fails
- ✅ failPhaseIfNotLoaded=true with Zod error → phase fails
- ✅ failPhaseIfNotLoaded=false with errors → phase continues
- ✅ Multiple chroniclers, one required fails → phase fails
- ✅ Multiple chroniclers, one non-required fails → phase continues

**Duplicate Detection**:
- ✅ Two chroniclers with same ID in one phase → error
- ✅ Same chronicler ID in different phases → allowed
- ✅ Duplicate in file-based configs → detected
- ✅ Duplicate in inline configs → detected
- ✅ Duplicate across file and inline → detected

**Event Flow**:
- ✅ Server State events reach chroniclers
- ✅ Agentic Backbone events reach chroniclers
- ✅ Connection State events don't reach chroniclers
- ✅ Events reach correct chroniclers (not others)
- ✅ Fire-and-forget doesn't block emission

**Output Files**:
- ✅ Auto-generated paths created correctly
- ✅ Custom output paths created correctly
- ✅ Directory creation for nested paths
- ✅ File writes succeed
- ✅ Multiple chroniclers don't conflict

**Cost Tracking**:
- ✅ getChroniclerCosts() returns correct Map
- ✅ Costs accumulate during phase
- ✅ Costs retrievable after completeAllWork()
- ✅ Zero chroniclers → empty Map

**Queue Draining**:
- ✅ completeAllWork() waits for queued triggers
- ✅ Debounce strategy flushed
- ✅ Count strategy processes remaining events
- ✅ TimeWindow strategy stopped and flushed
- ✅ No events lost during completion

**Config Directory Resolution**:
- ✅ File-based: prompt files resolve relative to chronicler config dir
- ✅ Inline: prompt files resolve relative to phase config dir
- ✅ Schema files follow same pattern
- ✅ Mixed configs resolve correctly

**State Transitions**:
- ✅ Phase transitions to `completing-chroniclers` before final state
- ✅ completing-chroniclers metadata includes chroniclerCount
- ✅ completing-chroniclers metadata includes chroniclerIds
- ✅ Transition happens even for 0 chroniclers
- ✅ Info events emitted during transition

### 9.3 E2E Tests

#### Happy Path Extension (`tests/e2e/happy-path-e2e.test.ts`)

**Basic Integration**:
- ✅ Phase with one file-based narrator chronicler
- ✅ Chronicler uses wrapper pattern
- ✅ Output file created in `.tadpole/chronicler-outputs/{id}/`
- ✅ Output file contains expected content
- ✅ Chronicler didn't block phase execution
- ✅ Phase completed successfully
- ✅ Cost logging includes chronicler costs

#### Full Chronicler E2E (`tests/e2e/chronicler-full-e2e.test.ts`)

**Multi-Phase Workflow**:
- ✅ Phase 1 with chronicler A (file-based)
- ✅ Phase 2 with chronicler B (inline)
- ✅ Phase 3 with both A and B (cache hit for A)
- ✅ All phases complete successfully
- ✅ Each chronicler writes to correct location
- ✅ Costs tracked per phase

**Chronicler Types**:
- ✅ Text output chronicler (markdown)
- ✅ Structured output chronicler (NDJSON)
- ✅ Conversational chronicler (maintains history)
- ✅ Non-conversational chronicler (fresh each trigger)
- ✅ All types work in same phase

**Trigger Strategies**:
- ✅ Immediate strategy fires on every event
- ✅ Debounce strategy batches bursts
- ✅ Count strategy batches by threshold
- ✅ TimeWindow strategy batches by time
- ✅ Mixed strategies in same phase

**Requirement Enforcement**:
- ✅ Phase with failPhaseIfNotLoaded=true and valid config → phase succeeds
- ✅ Phase with failPhaseIfNotLoaded=true and invalid config → phase fails immediately
- ✅ Phase with failPhaseIfNotLoaded=false and invalid config → phase continues
- ✅ Error message clearly states which chroniclers failed
- ✅ Failure type is "chronicler-load-failure"

**Rollback Scenarios**:
- ✅ Phase with chronicler completes successfully
- ✅ Rollback to earlier checkpoint
- ✅ Phase restarts, chronicler loads again
- ✅ BOTH chronicler outputs exist (before and after rollback)
- ✅ Timestamped filenames prevent conflicts
- ✅ Rollback doesn't delete chronicler outputs
- ✅ Rollback doesn't interfere with chronicler history files

**Server Shutdown**:
- ✅ Phase running with active chroniclers
- ✅ Server shutdown requested
- ✅ completeAllWork() waits for queues
- ✅ Manager shutdown completes
- ✅ All output files written
- ✅ No data loss
- ✅ Graceful cleanup

**Resumed Executions**:
- ✅ Phase fails mid-execution
- ✅ Server restarts
- ✅ Phase resumes from checkpoint
- ✅ Chroniclers load fresh
- ✅ Conversational chronicler loads history from disk
- ✅ Non-conversational chronicler starts fresh
- ✅ State carryover works for conversational

**Edge Cases**:
- ✅ Zero chroniclers configured → phase works normally
- ✅ Zero chroniclers → completing-chroniclers state still happens
- ✅ Provider health check incomplete → chroniclers skip unavailable models
- ✅ Provider health check complete → all chroniclers load
- ✅ Provider becomes unhealthy mid-phase → chronicler errors handled
- ✅ Large chronicler queue (>100 triggers) → oldest dropped, warning logged
- ✅ Very long completeAllWork() (>30s) → visible in completing-chroniclers state
- ✅ Chronicler outputs to nested directory → directories created
- ✅ Two chroniclers with same model → both work
- ✅ Chronicler with broken template → fatal error, unloaded
- ✅ Chronicler with broken schema → fatal error, unloaded

**Performance**:
- ✅ Measure phase startup latency with 0 chroniclers
- ✅ Measure phase startup latency with 1 chronicler
- ✅ Measure phase startup latency with 5 chroniclers
- ✅ Measure cache hit vs cache miss time
- ✅ Measure completing-chroniclers duration
- ✅ Large queue (1000 events) → completion time acceptable

**Observability**:
- ✅ completing-chroniclers state visible in events
- ✅ Chronicler count in state metadata
- ✅ Chronicler IDs in state metadata
- ✅ Info events during completion
- ✅ Cost logging after completion
- ✅ Debug logs for cache hits
- ✅ Warning logs for non-fatal failures
- ✅ Error logs for fatal failures

### 9.4 Test Coverage Matrix

| Behavior/Edge Case | Unit | Integration | E2E | Priority |
|--------------------|------|-------------|-----|----------|
| **Config Loading** |
| File-based loading | ✅ | ✅ | ✅ | HIGH |
| Inline loading | ✅ | ✅ | ✅ | HIGH |
| Config caching | ✅ | ✅ | ✅ | HIGH |
| Cache miss → read | ✅ | | | MEDIUM |
| Cache hit → skip read | ✅ | ✅ | | MEDIUM |
| **Wrapper Pattern** |
| Extract chroniclerConfig | ✅ | | | HIGH |
| Extract settings | ✅ | | | HIGH |
| Settings undefined | ✅ | | | MEDIUM |
| **Validation** |
| Duplicate ID same phase | ✅ | ✅ | | HIGH |
| Duplicate ID different phases | | ✅ | | MEDIUM |
| File not found | ✅ | ✅ | | HIGH |
| Invalid JSON | ✅ | | | HIGH |
| Zod validation error | ✅ | | | HIGH |
| **Requirement Enforcement** |
| failPhaseIfNotLoaded=true | ✅ | ✅ | ✅ | HIGH |
| failPhaseIfNotLoaded=false | ✅ | ✅ | | HIGH |
| Mixed required/optional | | ✅ | | MEDIUM |
| **Event Routing** |
| Server State events | ✅ | ✅ | | HIGH |
| Agentic Backbone events | ✅ | ✅ | | HIGH |
| Connection events filtered | ✅ | | | HIGH |
| Fire-and-forget pattern | ✅ | | | HIGH |
| **State Machine** |
| completing-chroniclers transition | | ✅ | ✅ | HIGH |
| Metadata includes count | | ✅ | | MEDIUM |
| Metadata includes IDs | | ✅ | | MEDIUM |
| Zero chroniclers | | ✅ | | MEDIUM |
| **Costs** |
| getChroniclerCosts() API | ✅ | ✅ | | HIGH |
| Cost accumulation | | ✅ | ✅ | MEDIUM |
| Cost logging | | ✅ | ✅ | MEDIUM |
| **Outputs** |
| Auto-generated paths | | ✅ | ✅ | HIGH |
| Custom paths | | ✅ | | MEDIUM |
| Directory creation | | ✅ | | MEDIUM |
| **Multi-Phase** |
| Cache across phases | | ✅ | ✅ | HIGH |
| Different chroniclers per phase | | ✅ | ✅ | MEDIUM |
| Same chronicler multiple phases | | ✅ | | MEDIUM |
| **Chronicler Types** |
| Text output | | | ✅ | HIGH |
| Structured output | | | ✅ | HIGH |
| Conversational | | | ✅ | HIGH |
| Non-conversational | | | ✅ | MEDIUM |
| **Trigger Strategies** |
| Immediate | | ✅ | | MEDIUM |
| Debounce | | ✅ | ✅ | MEDIUM |
| Count | | ✅ | | MEDIUM |
| TimeWindow | | ✅ | | MEDIUM |
| **Rollback** |
| Outputs persist | | | ✅ | HIGH |
| History preserved (conversational) | | | ✅ | HIGH |
| Timestamped filenames | | | ✅ | MEDIUM |
| **Shutdown** |
| Graceful with active chroniclers | | | ✅ | HIGH |
| completeAllWork() waits | | ✅ | ✅ | HIGH |
| No data loss | | | ✅ | HIGH |
| **Resume** |
| Resume after failure | | | ✅ | HIGH |
| History loaded (conversational) | | | ✅ | MEDIUM |
| Fresh start (non-conversational) | | | ✅ | MEDIUM |
| **Provider Health** |
| Grace period timing | ✅ | | | MEDIUM |
| Unavailable model skipped | | ✅ | | MEDIUM |
| Model becomes available | | ✅ | | LOW |
| **Queue Management** |
| completeAllWork drains queue | | ✅ | | HIGH |
| Large queue handled | | | ✅ | MEDIUM |
| Queue overflow warning | | | | LOW |
| **Error Cases** |
| Template error → unload | | ✅ | | MEDIUM |
| Schema error → unload | | ✅ | | MEDIUM |
| LLM call failure → retry | | ✅ | | MEDIUM |
| Consecutive failures → unload | | ✅ | | MEDIUM |
| **Performance** |
| Startup latency measurement | | | ✅ | MEDIUM |
| Cache performance | ✅ | | | LOW |
| Queue drain performance | | | ✅ | LOW |

### 9.5 Critical Quirks & Edge Cases to Test

**Quirk 1: completing-chroniclers with 0 chroniclers**
- **What**: State transition happens even with no chroniclers
- **Why**: Consistency in state machine
- **Test**: Integration - verify transition, metadata shows count=0
- **Priority**: HIGH (breaking this breaks state machine assumptions)

**Quirk 2: Rollback outputs persist**
- **What**: Chronicler outputs NOT rolled back
- **Why**: Observational logs, not execution state
- **Test**: E2E - verify both files exist after rollback
- **Priority**: HIGH (key design decision)

**Quirk 3: Cache across phase boundaries**
- **What**: Config cache persists when same file used in multiple phases
- **Why**: Performance optimization
- **Test**: Integration - verify second load is cache hit
- **Priority**: MEDIUM (nice to have, not critical)

**Quirk 4: Config directory resolution differs by source**
- **What**: File configs use their directory, inline use phase directory
- **Why**: Prompt file resolution needs correct context
- **Test**: Integration - verify prompt files load from correct location
- **Priority**: HIGH (breaks prompt loading if wrong)

**Quirk 5: failPhaseIfNotLoaded scope**
- **What**: Only load-time failures, not mid-execution unloading
- **Why**: Too complex to fail phase mid-execution
- **Test**: Unit + Integration - verify scope is correct
- **Priority**: HIGH (key design constraint)

**Quirk 6: Fallback LLM functions (temporary)**
- **What**: Present but should never be called in production
- **Why**: Vestigial from test architecture
- **Test**: Unit - verify they throw when called
- **Priority**: MEDIUM (will be removed later)

**Quirk 7: Conversational history persists across phase restarts**
- **What**: History saved to disk, loaded on resume
- **Why**: State continuity for conversational chroniclers
- **Test**: E2E - verify history carries over
- **Priority**: MEDIUM (already implemented, just verify)

**Quirk 8: completing-chroniclers can take significant time**
- **What**: Queue draining might take 30+ seconds
- **Why**: Large queues, slow LLM calls
- **Test**: E2E - simulate large queue, measure time
- **Priority**: LOW (optimization, not correctness)

**Edge Case 1: All chroniclers fail to load**
- **What**: All failPhaseIfNotLoaded=false → phase continues with 0 active
- **Test**: Integration - verify phase succeeds
- **Priority**: MEDIUM

**Edge Case 2: Provider unhealthy at load time**
- **What**: Chronicler skipped with warning
- **Test**: Integration - mock unhealthy provider
- **Priority**: MEDIUM

**Edge Case 3: Chronicler output path collision**
- **What**: Two chroniclers write to same file
- **Test**: Should be prevented by duplicate ID check (can't have same ID)
- **Priority**: LOW (shouldn't be possible)

**Edge Case 4: Very long chronicler config file**
- **What**: Large JSON file (>1MB)
- **Test**: Unit - verify parsing doesn't timeout
- **Priority**: LOW (unlikely)

**Edge Case 5: Chronicler loaded but provider becomes unhealthy**
- **What**: Loaded successfully, then provider fails
- **Test**: Integration - LLM call fails, error handled
- **Priority**: LOW (existing error handling covers this)

---

## 10. Implementation Checklist

### Phase 1: Core Integration (Day 1)

**Schema & Types**:
- [ ] Add `PhaseChroniclerEntry` type to `server/types/types.ts`
- [ ] Update `PhaseConfig.chroniclers` field
- [ ] Add `chronicler` config section to `ServerConfig`
- [ ] Update `DEFAULT_CONFIG` in `server/config.ts`
- [ ] Add `phaseChroniclerEntrySchema` to `server/config-validation/chronicler.schema.ts`
- [ ] Add `phaseChroniclerSettingsSchema`
- [ ] Update `FailureReason` type to include "chronicler-load-failure"

**Config.ts Validation**:
- [ ] Import `phaseChroniclerEntrySchema`
- [ ] Add `chroniclers` field to phase validation
- [ ] Add duplicate ID check
- [ ] Add file existence check
- [ ] Add severity based on `failPhaseIfNotLoaded`

**Chronicler Config Loader**:
- [ ] Create `server/chroniclers/chronicler-config-loader.ts`
- [ ] Implement file loading with caching
- [ ] Implement inline config support
- [ ] Implement wrapper pattern parsing
- [ ] Add duplicate ID detection
- [ ] Add `failPhaseIfNotLoaded` handling
- [ ] Implement `loadConfigsForPhase()` method

**State Machine Updates**:
- [ ] Add `completing-chroniclers` to PhaseStatus type
- [ ] Update `isTerminalPhaseStatus()` (should NOT include completing-chroniclers)
- [ ] Add state transition guard for `running` → `completing-chroniclers`
- [ ] Add state transition guard for `completing-chroniclers` → `completed/failed/skipped`

**TadpoleServer Integration**:
- [ ] Add `chroniclerManager` property
- [ ] Add `chroniclerConfigLoader` property
- [ ] Add `currentPhaseChroniclers` Set
- [ ] Initialize manager in constructor
- [ ] Add `setupChroniclerEventRouting()` method
- [ ] Add `loadChroniclersForPhase()` method
- [ ] Add fallback LLM call functions (optional, for tests - will refactor out later)
- [ ] Integrate into `startPhase()` (after workspace setup, during `starting` state)
- [ ] Handle `failPhaseIfNotLoaded` failures with specific error type
- [ ] Update `handlePhaseComplete()`:
  - [ ] Transition to `completing-chroniclers` state
  - [ ] Emit info events (starting/completed chronicler work)
  - [ ] Call `completeAllWork()` with timing
  - [ ] Get chronicler costs via `getChroniclerCosts()`
  - [ ] Log costs
  - [ ] Transition to final state (completed/failed/skipped)
- [ ] Add to `shutdown()` (call manager.shutdown)

**ChroniclerManager API Addition**:
- [ ] Add `getChroniclerCosts()` method to ChroniclerManager

**Config Path Tracking**:
- [ ] Add `configPath` to `ServerConfig`
- [ ] Pass from `index.ts` during initialization

### Phase 2: Testing (Day 2)

**Unit Tests**:
- [ ] `chronicler-config-loader.test.ts`:
  - [ ] File loading
  - [ ] Inline loading
  - [ ] Cache behavior
  - [ ] Duplicate detection
  - [ ] Wrapper pattern
  - [ ] failPhaseIfNotLoaded handling
- [ ] `tadpole-server-chronicler-integration.test.ts`:
  - [ ] Manager/loader instantiation
  - [ ] Event routing setup
  - [ ] Phase failure on fatal errors
  - [ ] Phase continues on non-fatal
  - [ ] Correct failure reason type

**Integration Tests**:
- [ ] `chronicler-phase-integration.test.ts`:
  - [ ] File-based with wrapper
  - [ ] Inline with wrapper
  - [ ] Mixed configs
  - [ ] Cache hits
  - [ ] failPhaseIfNotLoaded enforcement
  - [ ] Duplicate ID rejection
  - [ ] Event delivery
  - [ ] Output writing
  - [ ] Cost tracking

**E2E Tests**:
- [ ] Extend `happy-path-e2e.test.ts`
- [ ] Create `chronicler-full-e2e.test.ts`
- [ ] Test rollback behavior
- [ ] Test server shutdown

### Phase 3: Documentation & Polish (Day 3)

**Documentation Updates**:
- [ ] Update `documentation/chronicler-system.md` with integration section
- [ ] Update `documentation/phase-configuration-guide.md`:
  - [ ] Add chroniclers field documentation
  - [ ] Show wrapper pattern examples
  - [ ] Explain `failPhaseIfNotLoaded`
  - [ ] Show output path configuration
- [ ] Update `README.md` feature list
- [ ] Create example chronicler configs in `tests/config/chronicler-triggers/`

**Code Quality**:
- [ ] Run linter and fix issues
- [ ] Add JSDoc comments to all new code
- [ ] Review error messages for clarity
- [ ] Performance testing (measure phase startup latency)

---

## 11. Future Enhancements

### 11.1 Chronicler Events (Phase 2)

**User Feedback**: "Skip for now - figure out what needs to go back to event stream"

**Deferred Events**:
```typescript
"chronicler.loaded"   // When chronicler successfully loads
"chronicler.executed" // When trigger fires and LLM completes
"chronicler.unloaded" // When chronicler cleanup happens
"chronicler.error"    // When chronicler encounters error
```

**Integration Prep** (build now):
- Add optional `emitEvent` callback to Chronicler constructor
- TadpoleServer can pass `(event) => this.emit("event", event)`
- Chroniclers can then emit back to main stream

**Implementation in Phase 2**.

### 11.2 Cross-Phase Chroniclers (Phase 2)

**Use Case**: Cost tracking across entire run

**Config** (future):
```json
{
  "chroniclerConfig": "./chroniclers/cost-tracker.json",
  "settings": {
    "scope": "run"  // NEW: Persist across phases
  }
}
```

**Implementation**: Add scope to settings, handle in ChroniclerManager

### 11.3 Hot Reload (Phase 3)

**Low priority** - Complex, unclear value for v1

---

## 12. Key Implementation Notes

### 12.1 Wrapper Pattern Rationale

**User Feedback #4**: "We're making outputFiles part of chronicler config when we wanted to keep it at phase level"

**Solution**: Wrapper pattern separates concerns

**Before (bad - not reusable)**:
```json
{
  "id": "narrator",
  "outputPaths": { ... },  // Phase-specific in config
  "trigger": { ... }
}
```

**After (good - reusable)**:
```json
{
  "chroniclerConfig": "./narrator.json",  // Portable config
  "settings": {
    "outputPaths": { ... }  // Phase-specific settings
  }
}
```

**Benefits**:
- Chronicler configs can be shared across projects
- Phase controls where outputs go
- Clear separation of portable vs execution-specific

### 12.2 failPhaseIfNotLoaded Scope

**User Feedback #3**: "Only failing on load, not if chronicler has to be unloaded"

**Scope Definition**:

**WILL fail phase**:
- ✅ Config file not found
- ✅ Config JSON parse error
- ✅ Config validation error (Zod)
- ✅ Duplicate chronicler ID
- ✅ Model not available (provider unhealthy)

**Will NOT fail phase**:
- ❌ Chronicler unloaded mid-execution (hit error threshold)
- ❌ LLM call fails (handled by error thresholds)
- ❌ Queue overflow (handled by backpressure)
- ❌ Output file write errors (logged, not fatal)

**Implementation**: Check in Section 4.2 handles this correctly (only load-time errors)

### 12.3 Naming Improvements

**User Feedback #6**: "ChroniclerLoader is loading configs, not chroniclers"

**Renames Applied**:
- ❌ `ChroniclerLoader` → ✅ `ChroniclerConfigLoader`
- ❌ `loadChroniclersForPhase()` → ✅ `loadConfigsForPhase()`
- ❌ `LoadedChronicler` → ✅ `LoadedChroniclerConfig`
- ❌ `ChroniclerLoadResult` → ✅ `ChroniclerConfigLoadResult`

**Clarity**: Makes it explicit that this utility parses configs, ChroniclerManager creates instances.

### 12.4 Config.ts Updates Required

**User Feedback #1**: "Remember to update config.ts"

**Required Changes**:
1. Import `phaseChroniclerEntrySchema`
2. Add to phase config validation
3. Check file existence
4. Check duplicate IDs
5. Severity based on `failPhaseIfNotLoaded`

**See Section 1.3** for implementation details.

### 12.5 Execution Directory Passing

**CRITICAL**: Chroniclers need executionPath to write output files correctly

**What**: The `executionPath` parameter in `ChroniclerManager.loadChroniclersForPhase()`
**Why**: Chroniclers resolve output paths relative to execution directory, not project directory
**Where**: Pass from `TadpoleServer.config.executionPath`

**In loadChroniclersForPhase()**:
```typescript
await this.chroniclerManager.loadChroniclersForPhase(
  configs,
  phase.id as PhaseId,
  fallbackLlmCall,
  configDir,
  runStartTime,
  undefined,
  fallbackObjectCall,
  this.config.executionPath,  // CRITICAL: Pass execution directory
  outputPathsMap
);
```

**Impact if Wrong**:
- Chroniclers write to wrong directory (user's project instead of execution)
- Breaks execution isolation
- Files appear in wrong location

### 12.6 Error Handling Conventions

**IMPORTANT**: Tadpole and Chroniclers use different error patterns

**Tadpole Error Convention**:
- Uses `ErrorEvent` with `fatal: boolean` property
- Example: `{ type: "error", data: { message, fatal: true } }`
- `fatal` is a property of the event data

**Chronicler Error Convention**:
- Uses `ChroniclerFatalError` class (extends Error)
- Properties: `errorType`, `shouldUnload`, `retryable`
- Thrown errors, not event properties

**Don't Mix Them**:
```typescript
// ❌ Wrong - using chronicler pattern in server
throw new ChroniclerFatalError(id, "error", "template");

// ✅ Right - using server pattern
this.emit("event", {
  type: "error",
  data: { message: "error", fatal: true }
});
```

**Where They Meet**:
In `loadChroniclersForPhase()`, chronicler load failures are caught and converted to server error events with `fatal` property from `failPhaseIfNotLoaded` setting.

### 12.7 ChroniclerManager.loadChroniclersForPhase() Signature

**Important**: This method already exists and handles cleanup

**Existing Behavior**:
- Unloads previous phase's chroniclers automatically
- Accepts configs array
- Accepts config directories
- Accepts output paths map
- Accepts execution path for file resolution

**Integration Adds**:
- Better config parsing (via ChroniclerConfigLoader)
- Wrapper pattern support
- failPhaseIfNotLoaded enforcement in TadpoleServer

---

## 13. Pre-Implementation Checklist

**Verify Before Starting**:

- [ ] ChroniclerManager.loadChroniclersForPhase() signature is compatible
- [ ] ChroniclerManager.getTotalCost() exists (for costs)
- [ ] ServerConfig can be extended with chronicler section
- [ ] Event categorization functions are exported
- [ ] ChroniclerConfig type is exported
- [ ] Can add new file to server/chroniclers/
- [ ] Can create test files in tests/unit/, tests/integration/, tests/e2e/

---

## 14. Post-Implementation Verification

**Must Verify**:

- [ ] Server boots with wrapped chronicler entries
- [ ] File-based configs load and cache
- [ ] Inline configs work
- [ ] Events route to chroniclers correctly
- [ ] Output files appear in expected locations
- [ ] failPhaseIfNotLoaded=true fails phase with specific error
- [ ] failPhaseIfNotLoaded=false continues phase
- [ ] Duplicate IDs rejected
- [ ] Config directory resolution works (file vs inline)
- [ ] Chronicler costs retrievable
- [ ] Rollback doesn't affect chronicler outputs
- [ ] Server shutdown is graceful
- [ ] All new tests pass
- [ ] No regressions in existing tests
- [ ] config.ts validates chroniclers field

---

## 15. Success Criteria

### Must Have (v1 Integration)

- ✅ Wrapper pattern (chroniclerConfig + settings)
- ✅ File and inline loading
- ✅ Config caching
- ✅ Duplicate ID detection
- ✅ failPhaseIfNotLoaded enforcement
- ✅ Specific failure reason types
- ✅ Event routing
- ✅ Output file writing
- ✅ Phase completes with chroniclers
- ✅ Graceful shutdown
- ✅ All tests pass
- ✅ config.ts validation

### Should Have (v1 or Phase 2)

- ⚠️ Chronicler cost API (getChroniclerCosts)
- ⚠️ Costs in phase.completed logs
- ⚠️ Backpressure warnings

### Nice to Have (Phase 2+)

- ❌ Chronicler events
- ❌ Costs in phase.completed event data
- ❌ Cross-phase scope

---

## 16. Confidence Assessment

| Component | Confidence | Risk | Notes |
|-----------|-----------|------|-------|
| Wrapper pattern | HIGH | LOW | Clear separation of concerns |
| ChroniclerConfigLoader | HIGH | LOW | Straightforward file/inline loading |
| TadpoleServer integration | HIGH | LOW | Clear integration points |
| Event routing | HIGH | LOW | Using proven EventEmitter pattern |
| failPhaseIfNotLoaded | HIGH | LOW | Well-defined scope (load-time only) |
| Cost tracking | MEDIUM | LOW | Need to add getChroniclerCosts() |
| Specific failure types | HIGH | LOW | Simple enum addition |
| Config.ts validation | MEDIUM | LOW | Need to integrate with existing validation |
| Testing strategy | HIGH | MEDIUM | Comprehensive but time-consuming |

**Overall Confidence**: **HIGH** (9/10)

**Biggest Risks**:
1. Config.ts validation integration (existing code unknown)
2. getChroniclerCosts() API addition to ChroniclerManager

**Mitigations**:
1. Follow existing validation patterns in config.ts
2. Simple API addition (just expose chronicler.getTotalCost())

---

## 17. Implementation Timeline

### Day 1: Types, Loader, Validation (6-7 hours)

1. Update type definitions (1 hour)
2. Update config.ts validation (1.5 hours)
3. Implement ChroniclerConfigLoader (2 hours)
4. Write loader unit tests (2 hours)
5. Update server config defaults (30 mins)

**Deliverable**: ChroniclerConfigLoader working and tested, config validation updated

### Day 2: TadpoleServer Integration (6-7 hours)

1. Add properties to TadpoleServer (30 mins)
2. Implement constructor changes (1 hour)
3. Implement setupChroniclerEventRouting() (30 mins)
4. Implement loadChroniclersForPhase() (1.5 hours)
5. Integrate into startPhase() with failure handling (1.5 hours)
6. Add getChroniclerCosts() to ChroniclerManager (30 mins)
7. Add to handlePhaseComplete() with cost logging (1 hour)
8. Add to shutdown() (30 mins)
9. Write integration tests (2 hours)

**Deliverable**: Full integration working with cost tracking

### Day 3: E2E & Documentation (6-7 hours)

1. Extend happy-path test (1 hour)
2. Write comprehensive E2E test (2 hours)
3. Test rollback scenario (1 hour)
4. Update documentation (2 hours)
5. Performance testing (30 mins)
6. Code review & cleanup (30 mins)

**Deliverable**: Production-ready, documented, tested integration

---

## Conclusion

This spec provides a **production-ready integration plan** that:

1. **Wrapper Pattern** - Keeps chronicler configs reusable (config + settings separation)
2. **Clear Naming** - ChroniclerConfigLoader, loadConfigsForPhase, failPhaseIfNotLoaded
3. **Specific Errors** - "chronicler-load-failure" type with chronicler refs
4. **Config Validation** - Updates to config.ts for startup validation
5. **Simple Architecture** - ONE manager, per-phase instances, EventEmitter routing
6. **User Feedback** - All 6 points addressed comprehensively

**Ready for Implementation**: ✅

**Estimated Timeline**: 2-3 days (18-21 hours total)
**Confidence**: HIGH (9/10)
**Risk**: LOW
