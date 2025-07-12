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

export class StateManager extends TypedEventEmitter<StateManagerEvents> {
  private state: ST.LangtonState;
  private readonly statePath: string;
  private readonly stateBackupPath: string;
  private readonly logger: Logger;

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
        this.state = JSON.parse(content);
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
          this.state = JSON.parse(content);
          this.logger.log("Recovered from backup state file");
        } catch {
          this.logger.log("Backup also corrupted, starting fresh", "error");
        }
      }
    }
  }

  getState(): Readonly<ST.LangtonState> {
    return this.state;
  }

  async transition(event: ST.StateTransition): Promise<void> {
    // Validate transition
    this.validateTransition(event);

    // Apply transition
    const newState = this.applyTransition(this.state, event);

    // Update state
    this.state = newState;

    // Persist immediately
    await this.save();

    // Emit event
    this.emit("stateChanged", event);

    this.logger.log(`State transition: ${event.type}`);
  }

  // ... implement all other methods from interface
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
  [key: string]: unknown[];
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
  private stateManager: StateManager;
  private currentRunId: RunId | null = null;

  constructor(config: ...) {
    // ... existing code

    // Initialize state manager
    const langtonDir = path.join(this.config.projectPath, '.langton');
    this.stateManager = new StateManager(langtonDir, this.logger);
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
    const lockData = JSON.parse(fs.readFileSync(this.config.lockFile, 'utf-8'));

    // Check if it's our current run
    const state = this.stateManager.getState();
    if (state.currentRunId && state.currentRunId === lockData.runId) {
      // We're recovering from a crash
      this.currentRunId = RunId(lockData.runId);
    } else {
      throw new Error(`Server already running (PID: ${lockData.pid}, Run: ${lockData.runId})`);
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
  const runId = RunId(`${Date.now()}-${Math.random().toString(36).substr(2, 5)}`);
  const runFolder = path.join(this.config.projectPath, '.langton', 'runs', runId);

  await this.stateManager.transition({
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

  // Update lock file with runId
  const lockData = {
    pid: process.pid,
    runId: runId,
    startTime: new Date().toISOString()
  };
  fs.writeFileSync(this.config.lockFile, JSON.stringify(lockData));
}
```

### Step 2.3: Remove loadPreviousState Method

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

  // Create phase started transition
  await this.stateManager.transition({
    type: "PhaseStarted",
    data: {
      runId: this.currentRunId!,
      phaseId: phase.id,
      previousSessionId: this.getPreviousSessionId(phase.id)
    }
  });

  // Run workspace setup if needed
  if (!skipPreCommands && phase.workspaceSetup) {
    await this.stateManager.transition({
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

      await this.stateManager.transition({
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

    // Transition to initializing
    await this.stateManager.transition({
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
    // Transition to failed
    await this.stateManager.transition({
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
      await this.stateManager.transition({
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
    await this.stateManager.transition({
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

      // Update with final costs
      if (resultMsg.usage) {
        await this.stateManager.transition({
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

  // Create checkpoint if needed
  let checkpointSha: string | undefined;
  if (this.checkpointingEnabled) {
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
  }

  // Final transition
  await this.stateManager.transition({
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
      // Non-retriable failure - shut down run
      await this.stateManager.transition({
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
5. Delete: `loadPhaseStateFromLog` from `claude-log-parser.ts`

### State File Location

The state file will be at `.langton/state.json` with this structure:

```
.langton/
├── state.json          # All run state
├── state.json.bak      # Backup
├── server.lock         # Enhanced with runId
└── runs/               # New directory
    ├── 1234567890-abc/
    │   ├── phase-research-claude.log
    │   └── phase-implement-claude.log
    └── 1234567891-def/
        └── phase-research-claude.log
```
