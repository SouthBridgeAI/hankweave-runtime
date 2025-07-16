# Langton Rollback Implementation Plan

## Overview & Reasoning

The rollback feature enables users to restore the project state to any checkpoint created during phase execution. This is essential for:

1. **Recovery from failures**: Roll back to last known good state
2. **Experimentation**: Try different approaches from the same checkpoint
3. **Debugging**: Reproduce issues by rolling back to specific states

### Key Design Decisions

1. **Autostart Parameter**: Add `--no-autostart` flag to prevent automatic phase progression. Default behavior (autostart=true) maintains backward compatibility.

2. **Command-Based Rollback**: Rollback is a server command, not a startup parameter. This allows:

   - Querying available checkpoints before deciding
   - Clear separation of concerns
   - Better user control and feedback

3. **Safety First**: Cannot rollback while a phase is running - must force stop first with immediate state transition.

4. **New Run on Rollback**: Each rollback creates a new continuation run, preserving history.

5. **Checkpoint Repository Reuse**: Detects and reuses existing checkpoint repositories when starting in a directory with prior runs.

### Key Improvements Made

- **Server Idle Events**: New `server.idle` event type instead of parsing info messages
- **Checkpoint Aliases**: "start" and "end" aliases for easier navigation
- **Force Stop State Management**: Immediate state transition instead of waiting for process exit
- **Rollback to Start**: Falls back to first checkpoint if no successful phases exist
- **Pattern Restoration**: Checkpoint patterns properly restored after rollback
- **Repository Detection**: Won't reinitialize existing checkpoint repositories

## Functionality to Implement

### 1. Autostart Control

- Add `--no-autostart` CLI flag
- When disabled:
  - Server starts but doesn't auto-run first phase
  - After phase completion, waits for next command (no auto-progression)
  - Server doesn't shut down after last phase
  - Emits `server.idle` event instead of info messages

### 2. Checkpoint Query

- List all checkpoints in current (or specified) run
- Show phase name, checkpoint type, SHA, and status
- Essential for users to know what rollback targets exist

### 3. Force Stop

- Immediately stop running phase
- Mark as failed with retriable status through state transition
- Clean up resources
- Required before rollback

### 4. Rollback

- Support multiple targeting methods:
  - By checkpoint SHA
  - By phase + checkpoint type (including "start" and "end" aliases)
  - To last successful phase (or start if none)
- Creates new continuation run
- Resets git to checkpoint
- Restores checkpoint patterns
- Optional auto-restart

### 5. Checkpoint Repository Management

- Detect existing checkpoint repositories on startup
- Switch to correct branch for current run
- Initialize only if needed

## Implementation Details

### 1. CLI Flag for Autostart

#### File: `server/index.ts`

Add flag parsing:

```typescript
// In main() function, after existing args parsing:
const noAutostart = args.includes("--no-autostart");

// Update server config:
const serverConfig: Partial<ServerConfig> & {
  projectPath: string;
  phases: PhaseConfig[];
} = {
  projectPath: process.cwd(),
  phases,
  anthropicBaseURL,
  autostart: !noAutostart, // New property
};

// Update help text:
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
    // ... existing options ...
    --no-autostart            Don't automatically start phases (wait for commands)
    // ... rest of help ...
  `);
}
```

#### File: `server/types.ts`

Update ServerConfig:

```typescript
export interface ServerConfig {
  // ... existing properties ...

  /** Whether to automatically start phases (default: true) */
  autostart: boolean;
}
```

#### File: `server/config.ts`

Update DEFAULT_CONFIG:

```typescript
export const DEFAULT_CONFIG: Omit<ServerConfig, "projectPath" | "phases"> = {
  // ... existing properties ...
  autostart: true, // Default to current behavior
};
```

### 2. Update Autostart Behavior

#### File: `server/langton-server.ts`

Update constructor to store autostart setting:

```typescript
export class LangtonServer extends TypedEventEmitter<ServerInternalEvents> {
  // ... existing properties ...

  constructor(config: /*...*/) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.logger = new Logger(this.config.serverLogFile);
    this.serverStartTime = new Date();

    // Initialize state manager
    const langtonDir = path.join(this.config.projectPath, ".langton");
    this._stateManager = new StateManager(langtonDir, this.logger, this.config.phases);

    // Set up state manager listeners
    this.setupStateManagerListeners();
  }
}
```

Update `handleConnection`:

```typescript
private handleConnection(ws: ServerWebSocket<ClientData>): void {
  // ... existing connection setup ...

  // Check for incomplete phases
  this.checkIncompletePhases();

  // Only auto-start if enabled
  if (this.autostart) {
    this.autoStartNextPhase();
  } else {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "server.idle",
      data: {
        reason: "startup",
        message: "Server ready. Waiting for commands (autostart disabled).",
      },
    } as ServerIdleEvent);
  }
}
```

Update `handlePhaseComplete`:

```typescript
private async handlePhaseComplete(exitCode: number): Promise<void> {
  // ... existing phase completion logic ...

  // Handle next steps
  if ((finalStatus === "completed" || finalStatus === "skipped") && !this.isShuttingDown) {
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (this.autostart) {
      await this.autoStartNextPhase();
    } else {
      // Emit idle event
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "server.idle",
        data: {
          reason: "phase-completed",
          message: `Phase ${phaseId} ${finalStatus}. Use 'phase.next' to continue.`,
        },
      } as ServerIdleEvent);
    }
  }
  // ... rest of method
}
```

Update `autoStartNextPhase`:

```typescript
private async autoStartNextPhase(): Promise<void> {
  // ... existing checks ...

  const nextPhaseIndex = this.getNextPhaseIndex();
  if (nextPhaseIndex === -1) {
    this.logger.log("All phases completed");

    if (this.autostart) {
      // Current behavior - shut down
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: "All phases completed successfully. Server shutting down.",
        },
      } as InfoEvent);

      setTimeout(() => {
        this.shutdown("all phases completed");
      }, 2000);
    } else {
      // New behavior - stay running and emit idle
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "server.idle",
        data: {
          reason: "all-phases-completed",
          message: "All phases completed. Server remains active.",
        },
      } as ServerIdleEvent);
    }
    return;
  }

  // ... rest of method
}
```

### 3. New Command Types

#### File: `server/command-schemas.ts`

Add new command schemas:

```typescript
import { z } from "zod";
import { PhaseId } from "./branded-types.js";

const phaseIdSchema = z.string().transform((id) => PhaseId(id));

export const clientCommandSchema = z.discriminatedUnion("type", [
  // ... existing commands ...

  // Query checkpoints
  z.object({
    id: z.string(),
    type: z.literal("checkpoint.list"),
    data: z
      .object({
        runId: z.string().optional(), // Defaults to current run
      })
      .optional(),
  }),

  // Force stop current phase
  z.object({
    id: z.string(),
    type: z.literal("phase.forceStop"),
    data: z
      .object({
        reason: z.string().optional(),
      })
      .optional(),
  }),

  // Rollback to specific checkpoint
  z.object({
    id: z.string(),
    type: z.literal("rollback.toCheckpoint"),
    data: z.object({
      checkpointSha: z.string(),
      autoRestart: z.boolean().optional().default(false),
    }),
  }),

  // Rollback to phase + checkpoint type
  z.object({
    id: z.string(),
    type: z.literal("rollback.toPhase"),
    data: z.object({
      phaseId: phaseIdSchema,
      checkpointType: z.enum([
        "start",
        "end",
        "workspace-setup",
        "completed",
        "error",
        "skipped",
      ]),
      autoRestart: z.boolean().optional().default(false),
    }),
  }),

  // Rollback to last successful phase
  z.object({
    id: z.string(),
    type: z.literal("rollback.toLastSuccess"),
    data: z
      .object({
        autoRestart: z.boolean().optional().default(false),
      })
      .optional(),
  }),
]);
```

### 4. Server Event Types

#### File: `server/types.ts`

Add new event types:

```typescript
/**
 * Server idle notification
 */
export interface ServerIdleEvent extends ServerEvent {
  type: "server.idle";
  data: {
    reason: "startup" | "phase-completed" | "all-phases-completed";
    message: string;
  };
}

/**
 * Checkpoint information for query responses
 */
export interface CheckpointInfo {
  phaseId: string;
  phaseName: string;
  checkpointType: "workspace-setup" | "completed" | "error" | "skipped";
  sha: string;
  status: PhaseStatus;
  timestamp: string;
}

/**
 * Response to checkpoint.list command
 */
export interface CheckpointListEvent extends ServerEvent {
  type: "checkpoint.list";
  data: {
    runId: string;
    checkpoints: CheckpointInfo[];
    currentBranch: string;
  };
}

/**
 * Rollback completed notification
 */
export interface RollbackCompletedEvent extends ServerEvent {
  type: "rollback.completed";
  data: {
    fromRun: string;
    toRun: string;
    checkpoint: string;
    phaseId: string;
    phaseName: string;
    checkpointType: string;
    autoRestart: boolean;
  };
}
```

### 5. Command Handlers

#### File: `server/langton-server.ts`

Add necessary imports:

```typescript
import type {
  // ... existing imports ...
  ServerIdleEvent,
  CheckpointListEvent,
  RollbackCompletedEvent,
  StartingConditions,
} from "./types.js";
```

Update `handleCommand`:

```typescript
async handleCommand(command: ClientCommand): Promise<void> {
  this.logger.log(`Handling command: ${command.type}`);

  switch (command.type) {
    // ... existing cases ...

    case "checkpoint.list":
      await this.listCheckpoints(command.data?.runId);
      break;

    case "phase.forceStop":
      await this.forceStopPhase(command.data?.reason);
      break;

    case "rollback.toCheckpoint":
      await this.rollbackToCheckpoint(
        command.data.checkpointSha,
        command.data.autoRestart ?? false
      );
      break;

    case "rollback.toPhase":
      await this.rollbackToPhase(
        command.data.phaseId,
        command.data.checkpointType,
        command.data.autoRestart ?? false
      );
      break;

    case "rollback.toLastSuccess":
      await this.rollbackToLastSuccess(command.data?.autoRestart ?? false);
      break;

    default:
      assertNever(command);
  }
}
```

Implement new methods:

```typescript
/**
 * List available checkpoints
 */
private async listCheckpoints(runId?: string): Promise<void> {
  const targetRun = runId
    ? this._stateManager.getRun(RunId(runId))
    : this._stateManager.getCurrentRun();

  if (!targetRun) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: runId ? `Run ${runId} not found` : "No active run",
        fatal: false
      },
    } as ErrorEvent);
    return;
  }

  const checkpoints: CheckpointInfo[] = [];

  for (const phase of targetRun.phases) {
    const phaseConfig = this.config.phases.find(p => p.id === phase.phaseId);
    const phaseName = phaseConfig?.name || phase.phaseId;

    // Workspace setup checkpoint
    if ('workspaceSetupCheckpoint' in phase && phase.workspaceSetupCheckpoint) {
      checkpoints.push({
        phaseId: phase.phaseId,
        phaseName,
        checkpointType: 'workspace-setup',
        sha: phase.workspaceSetupCheckpoint,
        status: phase.status,
        timestamp: phase.startTime,
      });
    }

    // Completion checkpoint
    if (phase.status === 'completed' && phase.completionCheckpoint) {
      checkpoints.push({
        phaseId: phase.phaseId,
        phaseName,
        checkpointType: 'completed',
        sha: phase.completionCheckpoint,
        status: phase.status,
        timestamp: phase.endTime,
      });
    }

    // Error checkpoint
    if (phase.status === 'failed' && 'errorCheckpoint' in phase && phase.errorCheckpoint) {
      checkpoints.push({
        phaseId: phase.phaseId,
        phaseName,
        checkpointType: 'error',
        sha: phase.errorCheckpoint,
        status: phase.status,
        timestamp: phase.endTime,
      });
    }

    // Skip checkpoint
    if (phase.status === 'skipped' && 'skipCheckpoint' in phase && phase.skipCheckpoint) {
      checkpoints.push({
        phaseId: phase.phaseId,
        phaseName,
        checkpointType: 'skipped',
        sha: phase.skipCheckpoint,
        status: phase.status,
        timestamp: phase.endTime,
      });
    }
  }

  this.sendEvent({
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "checkpoint.list",
    data: {
      runId: targetRun.runId,
      checkpoints,
      currentBranch: targetRun.gitBranch,
    },
  } as CheckpointListEvent);
}

/**
 * Force stop the current running phase
 */
private async forceStopPhase(reason?: string): Promise<void> {
  const currentPhase = this._stateManager.getCurrentPhase();
  if (!currentPhase || isTerminalPhaseStatus(currentPhase.status)) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: "No running phase to stop",
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  this.logger.log(`Force stopping phase ${currentPhase.phaseId}: ${reason || "user request"}`);

  // Set failure reason
  this.phaseFailureReason = {
    type: "unknown",
    retriable: true,
    message: `Force stopped: ${reason || "user request"}`,
  };

  // Immediate state transition to failed
  if (this.currentRunId) {
    this._stateManager.transition({
      type: "PhaseTransitioned",
      data: {
        runId: this.currentRunId,
        phaseId: currentPhase.phaseId,
        from: currentPhase.status,
        to: "failed",
        metadata: {
          exitCode: -1,
          failureReason: this.phaseFailureReason,
          failedDuring: currentPhase.status,
        },
      },
    });
  }

  // Kill the process (if exists)
  if (this.processManager) {
    await this.processManager.kill("SIGTERM");
  }

  // Clean up phase state
  this.cleanupCurrentPhase();

  // Send confirmation
  this.sendEvent({
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "info",
    data: {
      message: `Phase ${currentPhase.phaseId} force stopped`,
    },
  } as InfoEvent);
}

/**
 * Rollback to a specific checkpoint SHA
 */
private async rollbackToCheckpoint(sha: string, autoRestart: boolean): Promise<void> {
  // Check if phase is running
  const currentPhase = this._stateManager.getCurrentPhase();
  if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: "Cannot rollback while phase is running. Use 'phase.forceStop' first.",
        phase: currentPhase.phaseId,
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  const currentRun = this._stateManager.getCurrentRun();
  if (!currentRun) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: "No active run",
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  // Find the phase and checkpoint type for this SHA
  let targetPhase: PhaseExecution | null = null;
  let checkpointType: string | null = null;

  for (const phase of currentRun.phases) {
    if ('workspaceSetupCheckpoint' in phase && phase.workspaceSetupCheckpoint === sha) {
      targetPhase = phase;
      checkpointType = 'workspace-setup';
      break;
    }
    if (phase.status === 'completed' && phase.completionCheckpoint === sha) {
      targetPhase = phase;
      checkpointType = 'completed';
      break;
    }
    if (phase.status === 'failed' && 'errorCheckpoint' in phase && phase.errorCheckpoint === sha) {
      targetPhase = phase;
      checkpointType = 'error';
      break;
    }
    if (phase.status === 'skipped' && 'skipCheckpoint' in phase && phase.skipCheckpoint === sha) {
      targetPhase = phase;
      checkpointType = 'skipped';
      break;
    }
  }

  if (!targetPhase || !checkpointType) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: `Checkpoint ${sha} not found in current run`,
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  await this.executeRollback(targetPhase, sha, checkpointType, autoRestart);
}

/**
 * Rollback to a phase + checkpoint type
 */
private async rollbackToPhase(
  phaseId: PhaseId,
  checkpointType: "start" | "end" | "workspace-setup" | "completed" | "error" | "skipped",
  autoRestart: boolean
): Promise<void> {
  // Check if phase is running
  const currentPhase = this._stateManager.getCurrentPhase();
  if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: "Cannot rollback while phase is running. Use 'phase.forceStop' first.",
        phase: currentPhase.phaseId,
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  const currentRun = this._stateManager.getCurrentRun();
  if (!currentRun) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: "No active run",
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  // Find the phase
  const targetPhase = currentRun.phases.find(p => p.phaseId === phaseId);
  if (!targetPhase) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: `Phase ${phaseId} not found in current run`,
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  // Resolve checkpoint type aliases
  let actualCheckpointType: "workspace-setup" | "completed" | "error" | "skipped";
  let sha: string | null = null;

  if (checkpointType === "start") {
    // Find first checkpoint in phase
    if ('workspaceSetupCheckpoint' in targetPhase && targetPhase.workspaceSetupCheckpoint) {
      sha = targetPhase.workspaceSetupCheckpoint;
      actualCheckpointType = 'workspace-setup';
    } else if (targetPhase.status === 'completed' && targetPhase.completionCheckpoint) {
      sha = targetPhase.completionCheckpoint;
      actualCheckpointType = 'completed';
    } else if (targetPhase.status === 'failed' && 'errorCheckpoint' in targetPhase && targetPhase.errorCheckpoint) {
      sha = targetPhase.errorCheckpoint;
      actualCheckpointType = 'error';
    } else if (targetPhase.status === 'skipped' && 'skipCheckpoint' in targetPhase && targetPhase.skipCheckpoint) {
      sha = targetPhase.skipCheckpoint;
      actualCheckpointType = 'skipped';
    }
  } else if (checkpointType === "end") {
    // Find last checkpoint in phase based on status
    if (targetPhase.status === 'completed' && targetPhase.completionCheckpoint) {
      sha = targetPhase.completionCheckpoint;
      actualCheckpointType = 'completed';
    } else if (targetPhase.status === 'failed' && 'errorCheckpoint' in targetPhase && targetPhase.errorCheckpoint) {
      sha = targetPhase.errorCheckpoint;
      actualCheckpointType = 'error';
    } else if (targetPhase.status === 'skipped' && 'skipCheckpoint' in targetPhase && targetPhase.skipCheckpoint) {
      sha = targetPhase.skipCheckpoint;
      actualCheckpointType = 'skipped';
    } else if ('workspaceSetupCheckpoint' in targetPhase && targetPhase.workspaceSetupCheckpoint) {
      // Fallback to workspace setup if no end checkpoint
      sha = targetPhase.workspaceSetupCheckpoint;
      actualCheckpointType = 'workspace-setup';
    }
  } else {
    // Direct checkpoint type specified
    actualCheckpointType = checkpointType;

    switch (checkpointType) {
      case 'workspace-setup':
        sha = 'workspaceSetupCheckpoint' in targetPhase ? targetPhase.workspaceSetupCheckpoint : null;
        break;
      case 'completed':
        sha = targetPhase.status === 'completed' ? targetPhase.completionCheckpoint : null;
        break;
      case 'error':
        sha = targetPhase.status === 'failed' && 'errorCheckpoint' in targetPhase
          ? targetPhase.errorCheckpoint : null;
        break;
      case 'skipped':
        sha = targetPhase.status === 'skipped' && 'skipCheckpoint' in targetPhase
          ? targetPhase.skipCheckpoint : null;
        break;
    }
  }

  if (!sha) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: `No ${checkpointType} checkpoint found for phase ${phaseId}`,
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  await this.executeRollback(targetPhase, sha, actualCheckpointType, autoRestart);
}

/**
 * Rollback to last successful phase
 */
private async rollbackToLastSuccess(autoRestart: boolean): Promise<void> {
  // Check if phase is running
  const currentPhase = this._stateManager.getCurrentPhase();
  if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: "Cannot rollback while phase is running. Use 'phase.forceStop' first.",
        phase: currentPhase.phaseId,
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  const currentRun = this._stateManager.getCurrentRun();
  if (!currentRun) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: "No active run",
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  // Find last completed phase
  let lastCompleted: PhaseExecution | null = null;
  for (let i = currentRun.phases.length - 1; i >= 0; i--) {
    if (currentRun.phases[i].status === 'completed') {
      lastCompleted = currentRun.phases[i];
      break;
    }
  }

  if (lastCompleted && lastCompleted.status === 'completed') {
    // Rollback to last successful phase
    await this.executeRollback(
      lastCompleted,
      lastCompleted.completionCheckpoint,
      'completed',
      autoRestart
    );
  } else {
    // No successful phases - rollback to start
    // Find the first checkpoint in the run
    let firstCheckpoint: { phase: PhaseExecution; sha: string; type: string } | null = null;

    for (const phase of currentRun.phases) {
      if ('workspaceSetupCheckpoint' in phase && phase.workspaceSetupCheckpoint) {
        firstCheckpoint = {
          phase,
          sha: phase.workspaceSetupCheckpoint,
          type: 'workspace-setup'
        };
        break;
      }
      // Check other checkpoint types if no workspace setup
      if (phase.status === 'completed' && phase.completionCheckpoint) {
        firstCheckpoint = {
          phase,
          sha: phase.completionCheckpoint,
          type: 'completed'
        };
        break;
      }
      if (phase.status === 'failed' && 'errorCheckpoint' in phase && phase.errorCheckpoint) {
        firstCheckpoint = {
          phase,
          sha: phase.errorCheckpoint,
          type: 'error'
        };
        break;
      }
      if (phase.status === 'skipped' && 'skipCheckpoint' in phase && phase.skipCheckpoint) {
        firstCheckpoint = {
          phase,
          sha: phase.skipCheckpoint,
          type: 'skipped'
        };
        break;
      }
    }

    if (firstCheckpoint) {
      this.logger.log("No successful phases found, rolling back to start");
      await this.executeRollback(
        firstCheckpoint.phase,
        firstCheckpoint.sha,
        firstCheckpoint.type,
        autoRestart
      );
    } else {
      this.sendEvent({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "No checkpoints found in current run",
          fatal: false,
        },
      } as ErrorEvent);
    }
  }
}

/**
 * Execute the actual rollback
 */
private async executeRollback(
  targetPhase: PhaseExecution,
  sha: string,
  checkpointType: string,
  autoRestart: boolean
): Promise<void> {
  const currentRun = this._stateManager.getCurrentRun();
  if (!currentRun) throw new Error("No active run");

  const phaseConfig = this.config.phases.find(p => p.id === targetPhase.phaseId);
  const phaseName = phaseConfig?.name || targetPhase.phaseId;

  this.logger.log(
    `Rolling back to ${checkpointType} checkpoint ${sha} ` +
    `in phase ${targetPhase.phaseId} (${phaseName})`
  );

  // 1. Clean up current phase state
  this.cleanupCurrentPhase();

  // 2. Complete current run
  this._stateManager.transition({
    type: "RunCompleted",
    data: { runId: currentRun.runId },
  });

  // 3. Wait for state transition to complete
  await this._stateManager.waitForPendingTransitions();

  // 4. Do the git reset
  if (!this.checkpointGit) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: "Checkpoint system not initialized",
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  try {
    await this.checkpointGit.resetToCheckpoint(sha);
  } catch (error) {
    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: `Git reset failed: ${toError(error).message}`,
        fatal: false,
      },
    } as ErrorEvent);
    return;
  }

  // 5. Start new continuation run
  const afterPhase = checkpointType === 'workspace-setup'
    ? null // Continue from beginning of the phase
    : targetPhase.phaseId; // Continue after the phase

  await this.startNewRun({
    type: "continuation",
    source: {
      runId: currentRun.runId,
      afterPhase: afterPhase ? PhaseId(afterPhase) : null,
      checkpointSha: sha,
    },
    reason: "rollback",
  });

  // 6. Restore checkpoint patterns up to rollback point
  const targetPhaseIndex = this.config.phases.findIndex(p => p.id === targetPhase.phaseId);
  if (targetPhaseIndex >= 0) {
    // If rolling back to workspace-setup, include patterns up to and including target phase
    // If rolling back to completion/error/skip, include patterns up to target phase
    const includeTarget = checkpointType === 'workspace-setup';
    const maxIndex = includeTarget ? targetPhaseIndex : targetPhaseIndex - 1;

    for (let i = 0; i <= maxIndex; i++) {
      const phase = this.config.phases[i];
      if (phase.trackedFiles?.length) {
        await this.addCheckpointPatterns(phase.trackedFiles);
      }
    }
  }

  // 7. Send confirmation
  this.sendEvent({
    id: EventId(generateId()),
    timestamp: new Date().toISOString(),
    type: "rollback.completed",
    data: {
      fromRun: currentRun.runId,
      toRun: this.currentRunId || "",
      checkpoint: sha,
      phaseId: targetPhase.phaseId,
      phaseName,
      checkpointType,
      autoRestart,
    },
  } as RollbackCompletedEvent);

  // 8. Send state snapshot
  this.sendStateSnapshot();

  // 9. Auto-restart if requested
  if (autoRestart && this.autostart) {
    const nextPhase = this._stateManager.getNextPhaseToExecute();
    if (nextPhase) {
      await this.startPhase(nextPhase);
    }
  }
}
```

### 6. CheckpointGit Updates

#### File: `server/checkpoint-git.ts`

Update initialize method to handle existing repositories:

```typescript
/**
 * Initialize the shadow git repository
 */
async initialize(): Promise<void> {
  // Create checkpoint directory
  await fs.promises.mkdir(this.checkpointPath, { recursive: true });

  // Check if repository already exists
  const gitDir = path.join(this.checkpointPath, ".git");
  const repoExists = fs.existsSync(gitDir);

  if (repoExists) {
    // Repository exists - just set up git instance
    this.git = simpleGit(this.projectPath, {
      config: [
        `core.worktree=${this.projectPath}`,
        `core.gitdir=${path.join(this.checkpointPath, ".git")}`,
      ],
    }).env({
      GIT_DIR: path.join(this.checkpointPath, ".git"),
      GIT_WORK_TREE: this.projectPath,
      HOME: this.checkpointPath,
      XDG_CONFIG_HOME: this.checkpointPath,
    });

    this.logger.log("Using existing shadow git repository");
    return;
  }

  // Create git config to isolate from user preferences
  const gitConfigPath = path.join(this.checkpointPath, ".gitconfig");
  const gitConfigContent = `[user]
  name = Langton Runner
  email = froggie@southbridge.ai
[commit]
  gpgsign = false
`;
  await fs.promises.writeFile(gitConfigPath, gitConfigContent);

  // Initialize git with proper environment
  this.git = simpleGit(this.projectPath, {
    config: [
      `core.worktree=${this.projectPath}`,
      `core.gitdir=${path.join(this.checkpointPath, ".git")}`,
    ],
  }).env({
    GIT_DIR: path.join(this.checkpointPath, ".git"),
    GIT_WORK_TREE: this.projectPath,
    HOME: this.checkpointPath,
    XDG_CONFIG_HOME: this.checkpointPath,
  });

  // Initialize repository
  await this.git.init(false, { "--initial-branch": "main" });
  await this.git.addConfig("user.name", "Langton Runner");
  await this.git.addConfig("user.email", "froggie@southbridge.ai");
  await this.git.addConfig("commit.gpgsign", "false");

  // Initial empty commit (don't add .gitignore to avoid conflicts with user's project)
  await this.git.commit("Initial checkpoint setup", {
    "--allow-empty": null,
  });

  this.logger.log("Shadow git repository initialized");
}

/**
 * Switch to a specific branch
 */
async switchToBranch(branchName: string): Promise<void> {
  if (!this.git) {
    throw new Error("Git repository not initialized");
  }

  try {
    const branches = await this.git.branch();
    if (branches.all.includes(branchName)) {
      await this.git.checkout(branchName);
      this.logger.log(`Switched to existing branch: ${branchName}`);
    } else {
      // Branch doesn't exist - this shouldn't happen for existing runs
      this.logger.log(`Warning: Branch ${branchName} not found`, "error");
    }
  } catch (error) {
    this.logger.log(`Failed to switch branch: ${error}`, "error");
  }
}

/**
 * Reset to a specific checkpoint
 */
async resetToCheckpoint(sha: string): Promise<void> {
  if (!this.git) {
    throw new Error("Git repository not initialized");
  }

  // Verify SHA exists
  try {
    const log = await this.git.log();
    const commit = log.all.find(c => c.hash.startsWith(sha));

    if (!commit) {
      throw new Error(`Checkpoint ${sha} not found in repository`);
    }

    // Hard reset to preserve exact file state
    await this.git.reset(['--hard', sha]);

    this.logger.log(`Reset to checkpoint ${sha}: ${commit.message}`);
  } catch (error) {
    throw new Error(`Failed to reset to checkpoint: ${toError(error).message}`);
  }
}
```

### 7. StartNewRun Updates

#### File: `server/langton-server.ts`

Update `startNewRun` to accept starting conditions:

```typescript
private async startNewRun(
  startingConditions?: StartingConditions
): Promise<void> {
  const runId = RunId(`${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
  const runFolder = path.join(this.config.projectPath, ".langton", "runs", runId);

  // Create run folder
  await fs.promises.mkdir(runFolder, { recursive: true });

  // Create run in state
  this._stateManager.transition({
    type: "RunStarted",
    data: {
      runId,
      runFolder,
      gitBranch: `run-${runId}`,
      startingConditions: startingConditions || { type: "fresh" },
      serverPid: process.pid,
    },
  });

  this.currentRunId = runId;

  // Update lock file
  const lockData = {
    pid: process.pid,
    runId,
    startTime: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  };

  const lockDir = path.dirname(this.config.lockFile);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }
  fs.writeFileSync(this.config.lockFile, JSON.stringify(lockData));

  // Start heartbeat
  this.heartbeatInterval = setInterval(() => {
    this.updateHeartbeat();
  }, 30000);

  this.logger.log(`Started new run: ${runId}`);
}
```

### 8. Checkpoint Initialization on Startup

#### File: `server/langton-server.ts`

Update `initializeCheckpoints` to handle branch switching:

```typescript
/**
 * Initialize checkpoint system - check git availability and switch branch
 */
private async initializeCheckpoints(): Promise<void> {
  // Check if git is available
  if (!(await this.isGitAvailable())) {
    this.logger.log("Git is not available. Checkpointing disabled.", "info");
    this.checkpointingEnabled = false;
    return;
  }

  // Initialize checkpoint git
  this.checkpointGit = new CheckpointGit(this.config.projectPath, this.logger);
  await this.checkpointGit.initialize();

  this.logger.log("Checkpoint system initialized");
}
```

Update the `start` method to initialize checkpoints before state manager:

```typescript
async start(): Promise<void> {
  this.logger.log(
    `Starting Langton Server v${this.config.version} in ${this.config.projectPath}`,
  );

  // Initialize checkpoint system first (checks for existing .langton)
  await this.initializeCheckpoints();

  // Initialize state manager
  await this._stateManager.initialize();

  // ... rest of start method ...

  // After starting a new run, switch to its branch if we have checkpoints
  if (!this.currentRunId) {
    await this.startNewRun();

    // Now switch to the new run's branch
    const currentRun = this._stateManager.getCurrentRun();
    if (currentRun && currentRun.gitBranch && this.checkpointGit) {
      try {
        await this.checkpointGit.switchToBranch(currentRun.gitBranch);
      } catch (error) {
        this.logger.log(`Failed to switch to run branch: ${error}`, "error");
      }
    }
  }
}
```

### 8. BasicTUI Integration

#### File: `server/basic-tui.ts`

Add imports for new event types:

```typescript
import type {
  // ... existing imports ...
  ServerIdleEvent,
  CheckpointListEvent,
  RollbackCompletedEvent,
} from "./types.js";
```

Add new keyboard shortcuts and handlers:

```typescript
private setupKeyboardInput(): void {
  console.log("\n📌 Commands:");
  console.log("  [n] next phase");
  console.log("  [s] skip current");
  console.log("  [f] force stop");
  console.log("  [l] list checkpoints");
  console.log("  [r] rollback menu");
  console.log("  [q] quit\n");

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", async (key: string) => {
    switch (key) {
      case "n":
        console.log("\n⏭️  Advancing to next phase...");
        this.sendCommand({
          id: generateId(),
          type: "phase.next",
        } as NextPhaseCommand);
        break;

      case "s":
        console.log("\n⏩ Skipping current phase...");
        this.sendCommand({
          id: generateId(),
          type: "phase.skip",
        } as SkipPhaseCommand);
        break;

      case "f":
        console.log("\n⛔ Force stopping current phase...");
        this.sendCommand({
          id: generateId(),
          type: "phase.forceStop",
          data: { reason: "User requested from TUI" },
        });
        break;

      case "l":
        console.log("\n📋 Requesting checkpoint list...");
        this.sendCommand({
          id: generateId(),
          type: "checkpoint.list",
        });
        break;

      case "r":
        await this.showRollbackMenu();
        break;

      case "q":
      case "\u0003": // Ctrl+C
        console.log("\n👋 Shutting down...");
        if (this.ws) {
          this.ws.close();
        }
        this.server.shutdown("user request");
        break;
    }
  });
}

/**
 * Show interactive rollback menu
 */
private async showRollbackMenu(): Promise<void> {
  console.log("\n🔄 Rollback Options:");
  console.log("  [1] Rollback to last successful phase");
  console.log("  [2] List checkpoints and select");
  console.log("  [c] Cancel");

  const response = await this.waitForKey();

  switch (response) {
    case "1":
      await this.confirmAndRollback("last successful phase", async () => {
        this.sendCommand({
          id: generateId(),
          type: "rollback.toLastSuccess",
          data: { autoRestart: false },
        });
      });
      break;

    case "2":
      // First list checkpoints
      this.sendCommand({
        id: generateId(),
        type: "checkpoint.list",
      });
      console.log("\n⏳ Fetching checkpoints...");
      // Note: In real implementation, would need to wait for response
      // and show interactive selection
      break;

    case "c":
      console.log("\n❌ Rollback cancelled");
      break;
  }
}

/**
 * Confirm rollback with effects
 */
private async confirmAndRollback(
  target: string,
  action: () => Promise<void>
): Promise<void> {
  console.log(`\n⚠️  Rollback to: ${target}`);
  console.log("\nThis will:");
  console.log("  - End the current run");
  console.log("  - Reset project files to checkpoint state");
  console.log("  - Start a new continuation run");
  console.log("  - Preserve all history in state.json");
  console.log("\nContinue? (y/N): ");

  const response = await this.waitForKey();

  if (response === "y" || response === "Y") {
    await action();
  } else {
    console.log("\n❌ Rollback cancelled");
  }
}

/**
 * Wait for a single key press
 */
private waitForKey(): Promise<string> {
  return new Promise((resolve) => {
    const handler = (key: string) => {
      process.stdin.removeListener("data", handler);
      resolve(key);
    };
    process.stdin.once("data", handler);
  });
}

/**
 * Handle new server events
 */
private handleServerEvent(event: ServerEvent): void {
  const timestamp = new Date(event.timestamp).toLocaleTimeString();

  switch (event.type) {
    // ... existing cases ...

    case "server.idle": {
      const data = (event as ServerIdleEvent).data;
      console.log(`\n⏸️  [${timestamp}] Server idle: ${data.reason}`);
      console.log(`   ${data.message}`);
      break;
    }

    case "checkpoint.list": {
      const data = (event as CheckpointListEvent).data;
      console.log(`\n📋 [${timestamp}] Checkpoints in run ${data.runId}:`);

      if (data.checkpoints.length === 0) {
        console.log("   No checkpoints found");
      } else {
        data.checkpoints.forEach((cp, index) => {
          console.log(
            `   [${index + 1}] ${cp.phaseName} - ${cp.checkpointType} ` +
            `(${cp.sha.substring(0, 7)})`
          );
        });
      }
      break;
    }

    case "rollback.completed": {
      const data = (event as RollbackCompletedEvent).data;
      console.log(
        `\n✅ [${timestamp}] Rollback completed!\n` +
        `   From run: ${data.fromRun}\n` +
        `   To run: ${data.toRun}\n` +
        `   Phase: ${data.phaseName} (${data.checkpointType})\n` +
        `   Checkpoint: ${data.checkpoint.substring(0, 7)}`
      );
      break;
    }

    // ... rest of cases
  }
}
```

## Testing Strategy

### Unit Tests

1. **Command Validation**: Test new command schemas
2. **State Queries**: Test checkpoint finding logic
3. **Rollback Logic**: Test phase/checkpoint matching
4. **Checkpoint Aliases**: Test "start" and "end" resolution

### E2E Tests

```typescript
// tests/e2e/rollback-e2e.test.ts

test("force stop and rollback", async () => {
  // 1. Start server with --no-autostart
  // 2. Start phase manually
  // 3. Wait for running state
  // 4. Force stop
  // 5. Verify phase marked as failed immediately
  // 6. List checkpoints
  // 7. Rollback to previous checkpoint
  // 8. Verify new run created
  // 9. Verify git state reset
});

test("rollback to last success with auto-restart", async () => {
  // 1. Run successful phase
  // 2. Start phase that will fail
  // 3. After failure, rollback to last success
  // 4. Verify rollback and auto-restart
});

test("rollback to start when no success", async () => {
  // 1. Start phase that fails immediately
  // 2. Rollback to last success
  // 3. Verify it rolls back to first checkpoint
});

test("prevent rollback while running", async () => {
  // 1. Start phase
  // 2. Try to rollback while running
  // 3. Verify error message
  // 4. Force stop
  // 5. Try rollback again
  // 6. Verify success
});

test("checkpoint aliases", async () => {
  // 1. Create phases with multiple checkpoints
  // 2. Test rollback to phase "start"
  // 3. Test rollback to phase "end"
  // 4. Verify correct checkpoint selected
});

test("existing checkpoint repository", async () => {
  // 1. Run server, create checkpoints
  // 2. Stop server
  // 3. Start new server in same directory
  // 4. Verify can list and rollback to old checkpoints
});
```

### Integration Tests

1. **Server Idle Events**: Verify emitted at correct times
2. **Checkpoint Pattern Restoration**: Verify patterns restored after rollback
3. **Branch Management**: Verify correct branch after server restart

## Migration Notes

1. **Default behavior unchanged**: Existing users see no difference
2. **New --no-autostart flag**: Opt-in for manual control
3. **State format unchanged**: No migration needed
4. **Checkpoint system enhanced**: Existing checkpoints remain valid
5. **Existing repositories**: Will be detected and reused

## Key Implementation Notes

1. **Force Stop**: Now does immediate state transition, doesn't wait for process exit
2. **Checkpoint Aliases**: "start" and "end" make rollback commands more intuitive
3. **Rollback to Start**: If no successful phases, finds first checkpoint of any type
4. **Repository Detection**: Won't reinitialize if `.langton/checkpoints/.git` exists
5. **Pattern Restoration**: After rollback, checkpoint patterns are restored appropriately
