# Langton State Management Implementation Guide

This document provides step-by-step instructions for implementing the state management system into the existing Langton codebase.

## Phase 1: Foundation - State Types and Manager

### Step 1.1: Create State Types File

Create `server/state-types.ts` with all the types from our design document.

```typescript
// server/state-types.ts
import type { TokenUsage, FailureReason } from "./types.js";
import type { PhaseId, SessionId } from "./branded-types.js";

// Add RunId to branded-types.ts first:
export type RunId = Branded<string, "RunId">;
export const RunId = (id: string): RunId => id as RunId;

// Then copy all types from the design document...
```

### Step 1.2: Create State Manager Implementation

Create `server/state-manager.ts`:

```typescript
// server/state-manager.ts
import fs from "node:fs";
import path from "node:path";
import { TypedEventEmitter } from "./typed-event-emitter.js";
import type { StateManagerEvents } from "./typed-event-emitter.js";
import { Logger } from "./utils.js";
import type * as ST from "./state-types.js";

// Error types for state management
export class InvalidTransitionError extends Error {
  constructor(from: ST.PhaseStatus, to: ST.PhaseStatus) {
    super(`Invalid transition from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class PersistenceError extends Error {
  constructor(operation: string, cause: Error) {
    super(`State persistence failed during ${operation}: ${cause.message}`);
    this.name = "PersistenceError";
    this.cause = cause;
  }
}

export class StateManager extends TypedEventEmitter<StateManagerEvents> {
  private state: ST.LangtonState;
  private readonly statePath: string;
  private readonly stateBackupPath: string;
  private readonly logger: Logger;

  // Enhanced transition queue system
  private transitionQueue: ST.StateTransition[] = [];
  private isProcessing = false;

  // Running cost tallies for performance
  private costCache = {
    total: 0,
    currentRun: 0,
    lastUpdated: null as string | null,
  };

  constructor(private readonly langtonDir: string, logger: Logger) {
    super();
    this.logger = logger;
    this.statePath = path.join(langtonDir, "state.json");
    this.stateBackupPath = path.join(langtonDir, "state.json.bak");

    // Initialize empty state
    this.state = {
      runs: [],
      currentRunId: null,
    };
  }

  async initialize(): Promise<void> {
    try {
      if (fs.existsSync(this.statePath)) {
        const content = await fs.promises.readFile(this.statePath, "utf-8");
        const parsedState = JSON.parse(content);

        // Validate before using
        const validation = this.validate(parsedState);
        if (!validation.valid) {
          this.logger.log("State validation errors found:", "error");
          validation.errors.forEach((e) =>
            this.logger.log(`  - ${e.type}: ${e.message}`, "error")
          );

          if (validation.errors.some((e) => e.type === "corrupted_data")) {
            throw new Error("State file corrupted");
          }
        }

        // Log warnings but continue
        validation.warnings.forEach((w) =>
          this.logger.log(`Warning - ${w.type}: ${w.message}`, "info")
        );

        this.state = parsedState;
        this.rebuildCostCache();
        this.logger.log("Loaded existing state file");
      } else {
        this.logger.log("No state file found, starting fresh");
      }

      // Detect any crashed runs
      await this.detectCrashedRuns();
    } catch (error) {
      this.logger.log(`Failed to load state: ${error}`, "error");

      // Try backup
      if (fs.existsSync(this.stateBackupPath)) {
        try {
          const content = await fs.promises.readFile(
            this.stateBackupPath,
            "utf-8"
          );
          const parsedState = JSON.parse(content);

          // Validate backup too
          const validation = this.validate(parsedState);
          if (validation.valid) {
            this.state = parsedState;
            this.rebuildCostCache();
            this.logger.log("Recovered from backup state file");
          } else {
            this.logger.log("Backup also invalid, starting fresh", "error");
          }
        } catch {
          this.logger.log("Backup also corrupted, starting fresh", "error");
        }
      }
    }
  }

  getState(): Readonly<ST.LangtonState> {
    return this.state;
  }

  // Public API - fire and forget!
  transition(event: ST.StateTransition): void {
    this.transitionQueue.push(event);
    this.processQueue(); // Don't await - let it run
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;

    while (this.transitionQueue.length > 0) {
      const event = this.transitionQueue.shift()!;

      try {
        this.validateTransition(event);
        const oldState = this.state;
        const newState = this.applyTransition(this.state, event);
        this.state = newState;

        // Update cost cache if needed
        this.updateCostCache(event);

        await this.save();

        // Log transition for debugging
        await this.logTransitionEvent(event);

        // Emit event AFTER state is persisted
        this.emit("stateChanged", event);
        this.logger.log(`State transition: ${event.type}`);

        // Emit specific events for important transitions
        if (event.type === "PhaseTransitioned" && event.data.to === "running") {
          this.emit("phaseRunning", event.data);
        }
      } catch (error) {
        this.logger.log(`State transition failed: ${error}`, "error");
        this.emit("transitionError", { event, error });

        if (error instanceof InvalidTransitionError) {
          continue; // Skip this transition
        } else {
          break; // Fatal error
        }
      }
    }

    this.isProcessing = false;
  }

  // Cost cache management
  private updateCostCache(event: ST.StateTransition): void {
    if (event.type === "CostsUpdated") {
      // Update running tallies
      const phase = this.getPhaseInCurrentRun(event.data.phaseId);
      if (phase && "currentCost" in phase) {
        const delta = event.data.cost - phase.currentCost;
        this.costCache.currentRun += delta;
        this.costCache.total += delta;
      }
    } else if (event.type === "RunStarted") {
      this.costCache.currentRun = 0;
    } else if (event.type === "RunCompleted" || event.type === "RunFailed") {
      // Current run cost already in total, just reset current
      this.costCache.currentRun = 0;
    }
  }

  private rebuildCostCache(): void {
    this.costCache.total = this.state.runs.reduce((total, run) => {
      return (
        total +
        run.phases.reduce((runTotal, phase) => {
          if (phase.status === "completed") return runTotal + phase.finalCost;
          if (phase.status === "failed") return runTotal + phase.partialCost;
          return runTotal;
        }, 0)
      );
    }, 0);

    const currentRun = this.getCurrentRun();
    if (currentRun) {
      this.costCache.currentRun = currentRun.phases.reduce((total, phase) => {
        if ("currentCost" in phase) return total + phase.currentCost;
        if ("finalCost" in phase) return total + phase.finalCost;
        if ("partialCost" in phase) return total + phase.partialCost;
        return total;
      }, 0);
    }
  }

  // Event logging for debugging
  private async logTransitionEvent(event: ST.StateTransition): Promise<void> {
    const eventLog = path.join(this.langtonDir, "events.jsonl");
    const logEntry = {
      timestamp: new Date().toISOString(),
      serverPid: process.pid,
      event,
      resultingState: {
        currentRunId: this.state.currentRunId,
        runCount: this.state.runs.length,
        totalCost: this.costCache.total,
        currentRunCost: this.costCache.currentRun,
      },
    };

    try {
      await fs.promises.appendFile(eventLog, JSON.stringify(logEntry) + "\n");
    } catch (error) {
      // Don't fail transitions due to logging errors
      this.logger.log(`Failed to log event: ${error}`, "debug");
    }
  }

  // State validation implementation
  private validate(state: unknown): ST.StateValidation {
    const errors: ST.ValidationError[] = [];
    const warnings: ST.ValidationWarning[] = [];

    // Type structure validation
    if (!this.isValidStateStructure(state)) {
      errors.push({
        type: "corrupted_data",
        message: "State file has invalid structure",
      });
      return { valid: false, errors, warnings };
    }

    // Referential integrity
    const typedState = state as ST.LangtonState;
    if (
      typedState.currentRunId &&
      !typedState.runs.find((r) => r.runId === typedState.currentRunId)
    ) {
      errors.push({
        type: "missing_run",
        message: `Current run ${typedState.currentRunId} not found`,
      });
    }

    // Check for orphaned run folders
    const runsDir = path.join(this.langtonDir, "runs");
    if (fs.existsSync(runsDir)) {
      const runFolders = fs.readdirSync(runsDir);
      const stateRunIds = new Set(typedState.runs.map((r) => r.runId));

      for (const folder of runFolders) {
        if (!stateRunIds.has(folder as ST.RunId)) {
          warnings.push({
            type: "orphaned_folder",
            message: `Found run folder without state entry: ${folder}`,
          });
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  private isValidStateStructure(state: unknown): state is ST.LangtonState {
    // Basic type checking - can be expanded
    if (!state || typeof state !== "object") return false;
    const s = state as any;
    return (
      Array.isArray(s.runs) &&
      (s.currentRunId === null || typeof s.currentRunId === "string")
    );
  }

  // Query methods with cached costs
  getCurrentRunCost(): number {
    return this.costCache.currentRun;
  }

  getTotalCost(): number {
    return this.costCache.total;
  }

  // Implement all methods from the StateManager interface in state.md:
  //
  // Query methods (needed by Phase 2):
  // - getCurrentRun(): Run | null
  // - getCurrentPhase(): PhaseExecution | null
  // - getPhaseInCurrentRun(phaseId): PhaseExecution | null
  // - getNextPhaseToExecute(): PhaseId | null
  // - getLastSuccessfulPhase(phaseId): { run, phase } | null
  // - getCostSince(runId): number
  // - getRun(runId): Run | null
  // - getPhaseHistory(phaseId): Array<{ run, phase }>
  // - canContinueFrom(runId, afterPhase): boolean
  // - getCheckpointForContinuation(runId, afterPhase): string | null
  //
  // State modification internals:
  // - validateTransition(event): void - Use PhaseTransitions map from state.md
  // - applyTransition(state, event): LangtonState - Pure function, deep clone state
  // - save(): Promise<void> - Atomic write with backup
  // - detectCrashedRuns(): Promise<void> - Check for orphaned "running" status
  // - recover(): Promise<RecoveryResult>
  //
  // See state.md for full interface specification and method documentation

  // Wait for all pending transitions during shutdown
  async waitForPendingTransitions(): Promise<void> {
    while (this.isProcessing || this.transitionQueue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
```

### Step 1.4: Add Helper Functions

Add to `server/state-types.ts` or `server/utils.ts`:

```typescript
// Helper to check if a phase status is terminal (no further transitions possible)
export function isTerminalPhaseStatus(status: PhaseStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}
```

### Step 1.3: Update TypedEventEmitter

Add state manager events to `server/typed-event-emitter.ts`:

```typescript
// Add to ServerInternalEvents interface:
export interface ServerInternalEvents {
  // ... existing events
  stateChanged: [ST.StateTransition];
}

// Add new interface for StateManager:
export interface StateManagerEvents {
  stateChanged: [ST.StateTransition];
  phaseRunning: [
    {
      runId: RunId;
      phaseId: PhaseId;
      from: PhaseStatus;
      to: "running";
      metadata?: any;
    }
  ];
  transitionError: [{ event: ST.StateTransition; error: Error }];
}
```

## Phase 2: Replace In-Memory State

### Step 2.1: Update LangtonServer Constructor

In `server/langton-server.ts`, add StateManager:

```typescript
// Add import
import { StateManager } from "./state-manager.js";
import { RunId } from "./state-types.js";

export class LangtonServer {
  // Remove these in-memory state fields:
  // - private currentPhase: PhaseState | undefined;
  // - private completedPhases: CompletedPhase[] = [];
  // - private totalCost = 0;
  // - private runId: string;

  // Add state manager:
  private _stateManager: StateManager;
  private currentRunId: RunId | null = null;
  private heartbeatInterval?: NodeJS.Timeout;

  // Public getter for tests and external access
  public get stateManager(): Readonly<StateManager> {
    return this._stateManager;
  }

  constructor(config: ...) {
    // ... existing code

    // Initialize state manager
    const langtonDir = path.join(this.config.projectPath, '.langton');
    this._stateManager = new StateManager(langtonDir, this.logger);

    // Set up state manager listeners
    this.setupStateManagerListeners();
  }

  private setupStateManagerListeners(): void {
    this.stateManager.on('phaseRunning', (data) => {
      // State is already saved when we get here
      const phase = this.stateManager.getCurrentPhase();
      if (phase && 'claudeSessionId' in phase) {
        const phaseConfig = this.config.phases.find(p => p.id === data.phaseId);
        if (phaseConfig) {
          this.sendEvent({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "phase.started",
            data: {
              phaseId: data.phaseId,
              phaseName: phaseConfig.name,
              phaseDescription: phaseConfig.description,
              sessionId: phase.claudeSessionId,
              previousSessionId: phase.previousSessionId,
              startTime: phase.startTime,
            }
          });
        }
      }
    });

    this.stateManager.on('transitionError', ({ event, error }) => {
      if (error instanceof PersistenceError) {
        // Can't save state - this is fatal
        this.handleError(error, 'state-persistence', ErrorSeverity.FATAL);
      }
    });
  }
}
```

### Step 2.2: Update Server Start Method

Replace state loading in `start()` method:

```typescript
async start(): Promise<void> {
  this.logger.log(`Starting Langton Server v${this.config.version} in ${this.config.projectPath}`);

  // Initialize checkpoint system (keep existing)
  await this.initializeCheckpoints();

  // Initialize state manager (NEW)
  await this.stateManager.initialize();

  // Check for existing lock file (modify to include runId)
  if (fs.existsSync(this.config.lockFile)) {
    const lockData: LockFile = JSON.parse(fs.readFileSync(this.config.lockFile, 'utf-8'));

    // Check heartbeat age
    const heartbeatAge = Date.now() - new Date(lockData.lastHeartbeat).getTime();
    if (heartbeatAge > 120000) { // 2 minutes
      this.logger.log(`Found stale lock file (heartbeat age: ${heartbeatAge}ms), removing...`);
      fs.unlinkSync(this.config.lockFile);

      // Mark the run as crashed (fire-and-forget)
      if (lockData.runId) {
        this.stateManager.transition({
          type: "RunCrashed",
          data: {
            runId: RunId(lockData.runId),
            detectedAt: new Date().toISOString(),
            lastPhaseStatus: "unknown" as PhaseStatus
          }
        });
      }
    } else {
      // Check if it's our current run
      const state = this.stateManager.getState();
      if (state.currentRunId && state.currentRunId === lockData.runId) {
        // We're recovering from a crash - continue the same run
        this.currentRunId = RunId(lockData.runId);

        // Create new log files for this server session
        const currentRun = this.stateManager.getCurrentRun();
        if (currentRun) {
          await this.createSessionLogs(currentRun.runFolder, true);
        }
      } else {
        throw new Error(`Server already running (PID: ${lockData.pid}, Run: ${lockData.runId})`);
      }
    }
  }

  // Start a new run if needed
  if (!this.currentRunId) {
    await this.startNewRun();
  }

  // Remove the old loadPreviousState() call
  // await this.loadPreviousState();  // DELETE THIS

  // ... rest of server start
}

private async startNewRun(): Promise<void> {
  const runId = RunId(`${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
  const runFolder = path.join(this.config.projectPath, '.langton', 'runs', runId);

  // Create run folder
  await fs.promises.mkdir(runFolder, { recursive: true });

  // Create session logs for new run
  await this.createSessionLogs(runFolder, false);

  this.stateManager.transition({
    type: "RunStarted",
    data: {
      runId,
      runFolder,
      gitBranch: `run-${runId}`,
      startingConditions: { type: "fresh" }, // TODO: Handle continuations
      serverPid: process.pid
    }
  });

  this.currentRunId = runId;

  // Update lock file with runId and heartbeat
  const lockData: LockFile = {
    pid: process.pid,
    runId: runId,
    startTime: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString()
  };
  fs.writeFileSync(this.config.lockFile, JSON.stringify(lockData));

  // Start heartbeat
  this.heartbeatInterval = setInterval(() => {
    this.updateHeartbeat();
  }, 30000); // Every 30 seconds
}

private updateHeartbeat(): void {
  try {
    if (fs.existsSync(this.config.lockFile)) {
      const lock: LockFile = JSON.parse(fs.readFileSync(this.config.lockFile, 'utf-8'));
      lock.lastHeartbeat = new Date().toISOString();
      fs.writeFileSync(this.config.lockFile, JSON.stringify(lock));
    }
  } catch (error) {
    this.logger.log(`Failed to update heartbeat: ${error}`, 'error');
  }
}

private async createSessionLogs(runFolder: string, isRecovery: boolean): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Create unique log names for this server session
  const serverLogPath = path.join(runFolder, `server-${timestamp}.log`);
  const socketLogPath = path.join(runFolder, `websocket-${timestamp}.log`);

  // Update logger
  this.logger = new Logger(serverLogPath);

  // Update config paths
  this.config.serverLogFile = serverLogPath;
  this.config.socketLogFile = socketLogPath;

  // Log header information
  this.logger.log("===========================================");
  this.logger.log(`Langton Server v${this.config.version}`);
  this.logger.log(`Run ID: ${this.currentRunId || 'determining...'}`);
  this.logger.log(`Session Start: ${new Date().toISOString()}`);
  this.logger.log(`Server PID: ${process.pid}`);

  if (isRecovery) {
    this.logger.log("Type: RECOVERY FROM CRASH");

    // List previous log files in this run
    const files = await fs.promises.readdir(runFolder);
    const previousLogs = files.filter(f => f.startsWith('server-') || f.startsWith('websocket-'));

    if (previousLogs.length > 0) {
      this.logger.log("Previous session logs:");
      for (const log of previousLogs.sort()) {
        this.logger.log(`  - ${log}`);
      }
    }
  } else {
    this.logger.log("Type: NEW RUN");
  }

  this.logger.log("===========================================");
}
```

### Step 2.3: Update Logger Class

In `server/utils.ts`, the Logger class remains unchanged since we'll create new instances:

```typescript
export class Logger {
  constructor(private logFile: string) {}

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    // ... existing implementation unchanged
  }

  logSocketTraffic(
    socketLogFile: string,
    direction: "in" | "out",
    data: unknown
  ): void {
    // ... existing implementation unchanged
    // Note: This already takes the log file as a parameter, so it works with our new approach
  }
}
```

### Step 2.4: Remove loadPreviousState Method

Delete the entire `loadPreviousState()` method from `langton-server.ts` - we don't need it anymore.

### Step 2.4: Update State Queries

Replace all state queries throughout `langton-server.ts`:

```typescript
// OLD: if (this.currentPhase) { ... }
// NEW:
const currentPhase = this.stateManager.getCurrentPhase();
if (currentPhase) { ... }

// OLD: this.completedPhases.find(...)
// NEW:
const lastSuccessful = this.stateManager.getLastSuccessfulPhase(phaseId);

// OLD: this.totalCost
// NEW:
const totalCost = this.stateManager.getTotalCost();
```

## Phase 3: Update Phase Lifecycle

### Step 3.1: Replace startPhase Method

Update phase starting logic:

```typescript
private async startPhase(phaseId: PhaseId, skipPreCommands?: boolean): Promise<void> {
  const phase = this.config.phases.find((p) => p.id === phaseId);
  if (!phase) {
    await this.handleError(
      new Error(`Unknown phase: ${phaseId}`),
      "startPhase",
      ErrorSeverity.OPERATION,
    );
    return;
  }

  // Check if phase already running via state manager
  const currentPhase = this.stateManager.getCurrentPhase();
  if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
    await this.handleError(
      new Error(`Phase already running: ${currentPhase.phaseId}`),
      "startPhase",
      ErrorSeverity.OPERATION,
    );
    return;
  }

  this.logger.log(`Starting phase: ${phase.name}`);

  // Create phase started transition (fire-and-forget)
  this.stateManager.transition({
    type: "PhaseStarted",
    data: {
      runId: this.currentRunId!,
      phaseId: phase.id,
      previousSessionId: this.getPreviousSessionId(phase.id)
    }
  });

  // Run workspace setup if needed
  if (!skipPreCommands && phase.workspaceSetup) {
    this.stateManager.transition({
      type: "PhaseTransitioned",
      data: {
        runId: this.currentRunId!,
        phaseId: phase.id,
        from: "preparing",
        to: "starting"
      }
    });

    // ... existing workspace setup code ...

    // After workspace setup success:
    if (this.checkpointingEnabled) {
      const sha = await this.createCheckpoint({
        status: "workspace-setup",
        phaseId: phase.id,
        phaseName: phase.name,
        runId: this.currentRunId!,
        timestamp: new Date().toISOString(),
      });

      this.stateManager.transition({
        type: "CheckpointCreated",
        data: {
          runId: this.currentRunId!,
          phaseId: phase.id,
          checkpointType: "workspace-setup",
          sha,
          branch: `run-${this.currentRunId}`
        }
      });
    }
  }

  // ... rest of phase starting
}
```

### Step 3.2: Update Claude Process Spawning

In `startClaudeProcess()`:

```typescript
private async startClaudeProcess(
  phase: PhaseConfig,
  previousSessionId: string | null,
): Promise<void> {
  // Create process manager
  this.processManager = new ClaudeProcessManager(
    this.config.projectPath,
    this.logger,
    this.config.anthropicBaseURL,
  );

  // Set up event handlers (keep existing)
  // ...

  try {
    // Get run folder from state
    const currentRun = this.stateManager.getCurrentRun();
    const runFolder = currentRun!.runFolder;

    // Ensure run folder exists
    await fs.promises.mkdir(runFolder, { recursive: true });

    // Modify log path to use run folder
    const logPath = path.join(runFolder, `phase-${phase.id}-claude.log`);

    // Spawn process (modify ClaudeProcessManager to accept logPath)
    await this.processManager.spawn(phase, previousSessionId, logPath);

    // Transition to initializing (fire-and-forget)
    this.stateManager.transition({
      type: "PhaseTransitioned",
      data: {
        runId: this.currentRunId!,
        phaseId: phase.id,
        from: "starting",
        to: "initializing",
        metadata: {
          claudePid: this.processManager.getPid()!,
          claudeLogPath: path.relative(this.config.projectPath, logPath)
        }
      }
    });

    // Set up log parsing with delay
    setTimeout(() => {
      this.setupLogParsing(logPath, phase.id);
    }, TIMEOUTS.LOG_PARSER_DELAY_MS);
  } catch (error) {
    // Transition to failed (fire-and-forget)
    this.stateManager.transition({
      type: "PhaseTransitioned",
      data: {
        runId: this.currentRunId!,
        phaseId: phase.id,
        from: "starting",
        to: "failed",
        metadata: {
          failedDuring: "starting",
          failureReason: {
            type: "unknown",
            retriable: false,
            message: error.message
          }
        }
      }
    });
    throw error;
  }
}
```

### Step 3.3: Update Log Parsing Handlers

Update all message handlers to use state transitions:

```typescript
private handleSystemMessage(msg: SystemMessage, phaseId: string): void {
  if (msg.subtype === "init" && msg.session_id) {
    // Transition to running
    // Note: No await here because this is a synchronous callback handler
    // The state manager's mutex ensures transitions are processed sequentially
    // even when called without await from multiple callbacks
    this.stateManager.transition({
      type: "PhaseTransitioned",
      data: {
        runId: this.currentRunId!,
        phaseId: PhaseId(phaseId),
        from: "initializing",
        to: "running",
        metadata: {
          claudeSessionId: SessionId(msg.session_id)
        }
      }
    });

    // Send phase.started event to client
    const currentPhase = this.stateManager.getCurrentPhase();
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "phase.started",
      data: {
        phaseId: phase.id,
        phaseName: phase.name,
        phaseDescription: phase.description,
        sessionId: msg.session_id,
        previousSessionId: currentPhase?.previousSessionId,
        startTime: currentPhase!.startTime,
      },
    } as PhaseStartedEvent);
  }
}

private handleAssistantMessage(msg: AssistantMessage, phaseId: string): void {
  // ... existing timeout detection ...

  if (msg.message.usage) {
    const usage: TokenUsage = {
      inputTokens: msg.message.usage.input_tokens || 0,
      outputTokens: msg.message.usage.output_tokens || 0,
      cacheCreationTokens: msg.message.usage.cache_creation_input_tokens || 0,
      cacheReadTokens: msg.message.usage.cache_read_input_tokens || 0,
    };

    const currentPhase = this.stateManager.getCurrentPhase();
    if (currentPhase && currentPhase.status === "running") {
      // Calculate new totals
      const newCost = currentPhase.currentCost + calculateCost(usage, this.config.costsPerMTok);
      const newTokens = {
        inputTokens: currentPhase.currentTokens.inputTokens + usage.inputTokens,
        outputTokens: currentPhase.currentTokens.outputTokens + usage.outputTokens,
        cacheCreationTokens: currentPhase.currentTokens.cacheCreationTokens + usage.cacheCreationTokens,
        cacheReadTokens: currentPhase.currentTokens.cacheReadTokens + usage.cacheReadTokens,
      };

      // Update state
      // Note: No await here because this is a synchronous callback handler
      this.stateManager.transition({
        type: "CostsUpdated",
        data: {
          runId: this.currentRunId!,
          phaseId: PhaseId(phaseId),
          cost: newCost,
          tokens: newTokens
        }
      });
    }

    // ... rest of existing code for events
  }

  // ... rest of method
}
```

### Step 3.4: Update Phase Completion

Replace `handlePhaseComplete()`:

```typescript
private async handlePhaseComplete(exitCode: number): Promise<void> {
  const currentPhase = this.stateManager.getCurrentPhase();
  if (!currentPhase || isTerminalPhaseStatus(currentPhase.status)) return;

  const phaseId = currentPhase.phaseId;
  const wasSkipped = this.isSkippingPhase;

  // Transition to completing (unless skipped)
  if (!wasSkipped && exitCode === 0 && !this.isShuttingDown) {
    this.stateManager.transition({
      type: "PhaseTransitioned",
      data: {
        runId: this.currentRunId!,
        phaseId,
        from: currentPhase.status,
        to: "completing"
      }
    });

    // Wait for result message
    try {
      const resultMsg = await this.waitForResultMessage(
        `${this.currentRunId}-${phaseId}`,
        TIMEOUTS.RESULT_MESSAGE_MS
      );

      // Update with final costs (fire-and-forget)
      if (resultMsg.usage) {
        this.stateManager.transition({
          type: "CostsUpdated",
          data: {
            runId: this.currentRunId!,
            phaseId,
            cost: resultMsg.total_cost_usd || calculateCost(resultMsg.usage, this.config.costsPerMTok),
            tokens: {
              inputTokens: resultMsg.usage.input_tokens || 0,
              outputTokens: resultMsg.usage.output_tokens || 0,
              cacheCreationTokens: resultMsg.usage.cache_creation_input_tokens || 0,
              cacheReadTokens: resultMsg.usage.cache_read_input_tokens || 0,
            }
          }
        });
      }
    } catch (error) {
      this.logger.log(`Result message timeout for phase ${phaseId}: ${error}`, "info");
    }
  }

  // Determine final status
  const finalStatus = wasSkipped ? "skipped" :
                     exitCode === 0 ? "completed" :
                     "failed";

  // Create checkpoint BEFORE state transition
  let checkpointSha: string | undefined;
  if (this.checkpointingEnabled && shouldCreateCheckpoint) {
    try {
      const checkpointType = finalStatus === "completed" ? "completed" :
                            finalStatus === "skipped" ? "skipped" :
                            "error";

      checkpointSha = await this.createCheckpoint({
        status: checkpointType,
        phaseId,
        phaseName: phase.name,
        runId: this.currentRunId!,
        timestamp: new Date().toISOString(),
        duration: Date.now() - new Date(currentPhase.startTime).getTime()
      });
    } catch (error) {
      this.logger.log(`Checkpoint creation failed: ${error}`, 'error');
      // Decide: fail the phase or continue without checkpoint?
      if (finalStatus === 'completed') {
        // For completed phases, checkpoint failure is critical
        finalStatus = 'failed';
        this.phaseFailureReason = {
          type: 'unknown',
          retriable: false,
          message: `Checkpoint creation failed: ${error.message}`
        };
      }
    }
  }

  // Final transition (fire-and-forget)
  this.stateManager.transition({
    type: "PhaseTransitioned",
    data: {
      runId: this.currentRunId!,
      phaseId,
      from: currentPhase.status,
      to: finalStatus,
      metadata: {
        exitCode,
        resultMessageReceived: currentPhase.status === "completing",
        checkpointSha,
        ...(finalStatus === "failed" && {
          failedDuring: currentPhase.status,
          failureReason: this.phaseFailureReason || {
            type: "unknown",
            retriable: false
          }
        }),
        ...(finalStatus === "skipped" && {
          skippedDuring: currentPhase.status
        })
      }
    }
  });

  // Send phase.completed event
  const updatedPhase = this.stateManager.getPhaseInCurrentRun(phaseId);
  const phaseCost = this.calculatePhaseCost(updatedPhase!);

  this.sendEvent({
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "phase.completed",
    data: {
      phaseId,
      success: finalStatus === "completed",
      cost: phaseCost,
      duration: Date.now() - new Date(currentPhase.startTime).getTime(),
      exitStatus: exitCode === 0 ? { type: "success" } : { type: "error", code: exitCode },
      failureReason: finalStatus === "failed" ? this.phaseFailureReason : undefined,
    },
  } as PhaseCompletedEvent);

  // Clean up
  this.cleanupCurrentPhase();

  // Send state snapshot
  this.sendStateSnapshot();

  // Handle next steps
  if (finalStatus === "completed" && !this.isShuttingDown) {
    await this.autoStartNextPhase();
  } else if (finalStatus === "failed" && !this.isShuttingDown) {
    if (this.phaseFailureReason?.retriable) {
      this.logger.log(`Phase failed with retriable error. Server remains active.`);
    } else {
      // Non-retriable failure - shut down run (fire-and-forget)
      this.stateManager.transition({
        type: "RunFailed",
        data: { runId: this.currentRunId! }
      });
      await this.shutdown("phase failure");
    }
  }
}
```

## Phase 4: Update State Snapshot

### Step 4.1: Replace sendStateSnapshot

```typescript
private sendStateSnapshot(): void {
  const state = this.stateManager.getState();
  const currentRun = this.stateManager.getCurrentRun();
  const currentPhase = this.stateManager.getCurrentPhase();

  // Calculate costs
  const totalCost = this.stateManager.getTotalCost();
  const currentRunCost = currentRun ? this.stateManager.getCurrentRunCost() : 0;

  const totalTime = this.serverStartTime ?
    Date.now() - this.serverStartTime.getTime() : 0;

  this.sendEvent({
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "state.snapshot",
    data: {
      currentPhase: currentPhase ? this.convertToLegacyPhaseState(currentPhase) : undefined,
      completedPhases: this.getCompletedPhasesForSnapshot(),
      fileTree: [], // Keep existing
      totalCost,
      totalTime,
      recentFileAccess: this.recentFileAccess,
    },
  } as StateSnapshotEvent);
}

// Helper to maintain backward compatibility
private convertToLegacyPhaseState(phase: PhaseExecution): PhaseState {
  // Convert new phase state to old format for clients
  // This is temporary until clients are updated
}
```

## Phase 5: Update Queries

### Step 5.1: Replace getPreviousSessionId

```typescript
private getPreviousSessionId(currentPhaseId: string): SessionId | undefined {
  const currentIndex = this.config.phases.findIndex((p) => p.id === currentPhaseId);
  if (currentIndex <= 0) return undefined;

  const previousPhaseId = this.config.phases[currentIndex - 1].id;
  const lastSuccessful = this.stateManager.getLastSuccessfulPhase(PhaseId(previousPhaseId));

  return lastSuccessful?.phase.claudeSessionId;
}
```

### Step 5.2: Update getNextPhaseIndex

```typescript
private getNextPhaseIndex(): number {
  const nextPhaseId = this.stateManager.getNextPhaseToExecute();
  if (!nextPhaseId) return -1;

  return this.config.phases.findIndex(p => p.id === nextPhaseId);
}
```

## Phase 6: Update ClaudeProcessManager

### Step 6.1: Modify spawn to accept log path

In `server/claude-process-manager.ts`:

```typescript
async spawn(phase: PhaseConfig, previousSessionId: string | null, logPath: string): Promise<string> {
  if (this.process) {
    throw new Error("Process already running");
  }

  // Remove the logPath calculation - use the provided one
  // const logPath = path.join(this.projectPath, `.langton/logs/log-${phase.id}.jsonl`);

  // Ensure log directory exists
  const logsDir = path.dirname(logPath);
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // ... rest of method unchanged
}
```

## Phase 7: Update Checkpoint System

### Step 7.1: Create git branch per run

In `server/checkpoint-git.ts`, update the `commit` method:

```typescript
async commit(
  message: string,
  options?: { branch?: string; allowEmpty?: boolean },
): Promise<string | null> {
  if (!this.git) return null;

  // Always use the branch from options if provided
  if (options?.branch) {
    // Check if branch exists
    const branches = await this.git.branch();
    if (!branches.all.includes(options.branch)) {
      // Create new branch from current HEAD
      await this.git.checkoutLocalBranch(options.branch);
      this.logger.log(`Created branch: ${options.branch}`);
    } else {
      // Switch to existing branch
      await this.git.checkout(options.branch);
      this.logger.log(`Switched to branch: ${options.branch}`);
    }
  }

  // ... rest of method unchanged
}
```

### Step 2.5: Update Shutdown Method

Add waiting for pending transitions during shutdown:

```typescript
private async shutdown(reason: string): Promise<void> {
  // ... existing cleanup ...

  // Wait for any pending state transitions
  await this.stateManager.waitForPendingTransitions();

  // Clear heartbeat interval
  if (this.heartbeatInterval) {
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = undefined;
  }

  // ... rest of shutdown
}
```

## Phase 8: Cleanup Integration

### Step 8.1: Update cleanup to handle runs

In `server/cleanup-command.ts`:

```typescript
private async removeLangtonDir(manifest: CleanupManifest, result: CleanupResult): Promise<void> {
  if (!manifest.langtonDir.exists) return;

  const langtonPath = path.join(this.options.projectPath, manifest.langtonDir.path);

  try {
    console.log(`🗑️  Removing .langton directory...`);

    // Special handling for state.json - maybe ask user?
    const statePath = path.join(langtonPath, 'state.json');
    if (fs.existsSync(statePath)) {
      console.log(`  Note: This will delete all run history in state.json`);
    }

    await fs.promises.rm(langtonPath, { recursive: true, force: true });
    result.directoriesRemoved.push(".langton");
    console.log("  ✓ Removed .langton directory");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`Failed to remove .langton: ${message}`);
    console.log(`  ✗ Failed: ${message}`);
  }
}
```

## Phase 9: Tests Updates

### Step 9.1: Update test utilities

Create `tests/utils/state-test-helpers.ts`:

```typescript
import type { LangtonState, PhaseExecution } from "../../server/state-types.js";

export function waitForPhaseStatus(
  stateManager: StateManager,
  phaseId: string,
  status: PhaseStatus
): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const phase = stateManager.getPhaseInCurrentRun(PhaseId(phaseId));
      if (phase?.status === status) {
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

export function createMockState(
  overrides?: Partial<LangtonState>
): LangtonState {
  return {
    runs: [],
    currentRunId: null,
    ...overrides,
  };
}
```

### Step 9.2: Update existing tests

In all test files, replace state checks:

```typescript
// OLD:
expect(testState.completedPhases).toHaveLength(3);

// NEW:
const state = server.stateManager.getState();
const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
const completedPhases =
  currentRun?.phases.filter((p) => p.status === "completed") || [];
expect(completedPhases).toHaveLength(3);
```

## Migration Notes

### Order of Implementation

1. **Phase 1-2**: Create state system alongside existing code
2. **Phase 3-4**: Hook into phase lifecycle without removing old code
3. **Phase 5-6**: Update queries and process management
4. **Phase 7-8**: Update supporting systems
5. **Phase 9**: Update tests
6. **Final**: Remove old state code after everything works

### Key Files to Modify

1. `langton-server.ts`: Most changes here
2. `claude-process-manager.ts`: Accept log path parameter
3. `checkpoint-git.ts`: Branch per run
4. `cleanup-command.ts`: Handle run folders
5. `utils.ts`: Update Logger class to support changing paths
6. Delete: `loadPhaseStateFromLog` from `claude-log-parser.ts`

### Configuration Notes

The `serverLogFile` and `socketLogFile` in ServerConfig will now be dynamically updated per run:

- Initial values are used for startup logs
- Once a run starts, paths are updated to `runs/{runId}/server.log` and `runs/{runId}/websocket.log`
- Logger instance is updated to write to new location
- This keeps all run-related files together

### State File Location

The state file will be at `.langton/state.json` with this structure:

```
.langton/
├── state.json          # All run state
├── state.json.bak      # Backup
├── server.lock         # Enhanced with runId
├── logs/               # Global logs (if any)
│   └── (might be empty or contain pre-migration logs)
├── checkpoints/        # Git repository for checkpoints
│   └── .git/
└── runs/               # New directory - one folder per run
    ├── 1234567890-abc/
    │   ├── server-2024-01-15T10-30-00-000Z.log      # First server session
    │   ├── websocket-2024-01-15T10-30-00-000Z.log   # First session websocket
    │   ├── server-2024-01-15T14-45-30-000Z.log      # After crash recovery
    │   ├── websocket-2024-01-15T14-45-30-000Z.log   # After crash recovery
    │   ├── phase-research-claude.log                 # Claude logs
    │   └── phase-implement-claude.log
    └── 1234567891-def/
        ├── server-2024-01-16T09-00-00-000Z.log
        ├── websocket-2024-01-16T09-00-00-000Z.log
        └── phase-research-claude.log
```

This organization ensures:

- Each run is completely self-contained
- Each server session has distinct logs with timestamps
- Recovery sessions reference previous logs in their headers
- Claude logs remain per-phase (not per-session) since they're cumulative
- Easy to trace the history of a run through multiple server sessions
