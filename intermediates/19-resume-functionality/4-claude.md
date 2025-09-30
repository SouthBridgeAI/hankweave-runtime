# Resume Functionality Implementation Plan

## Current Architecture Analysis

After carefully analyzing the Tadpole codebase, I've identified the existing components that support resumption:

### Existing Components

1. **State Management (`state-manager.ts`)**
   - Persists complete execution state to `.tadpole/state.json`
   - Tracks all runs, phases, and their statuses
   - Detects crashed runs on startup via `detectCrashedRuns()`
   - Supports state recovery from backup files

2. **Checkpoint System (`checkpoint-git.ts`)**
   - Creates git checkpoints at phase boundaries
   - Supports rollback to specific checkpoints
   - Tracks workspace setup, completion, error, and skip checkpoints

3. **Execution Thread (`execution-thread.ts`)**
   - Analyzes execution history across runs
   - Determines next phase to execute
   - Handles continuation chain traversal

4. **Server Startup (`tadpole-server.ts`)**
   - Checks for lock files to detect running instances
   - Has partial recovery logic for crashed runs (lines 286-290)
   - Creates new runs or continues existing ones

## Gap Analysis

The system is **almost complete** for resume functionality. The main missing piece is:

**The server doesn't automatically detect and resume from the last valid checkpoint when booting up after a crash or shutdown.**

## Detailed Implementation Plan

### 1. Add Resume Detection on Server Startup

**Location**: `tadpole-server.ts::start()` method

**Changes needed**:

```typescript
// In tadpole-server.ts, after line 256 (state manager initialization)
async start(): Promise<void> {
  // ... existing code ...
  
  // Initialize state manager
  await this.stateManager.initialize();
  
  // NEW: Check if we should resume from a previous run
  const shouldResume = await this.checkForResumableState();
  if (shouldResume) {
    await this.resumeFromLastCheckpoint();
    return; // Early return, resume handles everything
  }
  
  // ... rest of existing startup logic ...
}
```

### 2. Implement Resume Detection Logic

**New method in `tadpole-server.ts`**:

```typescript
private async checkForResumableState(): Promise<boolean> {
  const state = this.stateManager.getState();
  
  // Check if there are any runs
  if (state.runs.length === 0) {
    return false;
  }
  
  // Get the most recent run
  const latestRun = state.runs[0];
  
  // Resume if:
  // 1. The latest run is not completed
  // 2. There's at least one phase with a checkpoint
  // 3. Not already running (no current run ID)
  if (
    latestRun.status !== 'completed' &&
    !state.currentRunId &&
    latestRun.phases.length > 0
  ) {
    // Check if we have any valid checkpoints to resume from
    const hasValidCheckpoint = latestRun.phases.some(phase => {
      return (
        ('workspaceSetupCheckpoint' in phase && phase.workspaceSetupCheckpoint) ||
        (phase.status === 'completed' && 'completionCheckpoint' in phase && phase.completionCheckpoint) ||
        (phase.status === 'skipped' && 'skipCheckpoint' in phase && phase.skipCheckpoint)
      );
    });
    
    return hasValidCheckpoint;
  }
  
  return false;
}
```

### 3. Implement Resume Execution

**New method in `tadpole-server.ts`**:

```typescript
private async resumeFromLastCheckpoint(): Promise<void> {
  this.logger.log("Detected incomplete run, attempting to resume...");
  
  const state = this.stateManager.getState();
  const latestRun = state.runs[0];
  
  // Find the last valid checkpoint to resume from
  let resumePoint: { 
    phaseId: PhaseId | null; 
    checkpointSha: string;
    checkpointType: 'workspace-setup' | 'completed' | 'skipped';
  } | null = null;
  
  // Traverse phases in reverse to find the most recent valid checkpoint
  for (let i = latestRun.phases.length - 1; i >= 0; i--) {
    const phase = latestRun.phases[i];
    
    // Priority order: completed > skipped > workspace-setup
    if (phase.status === 'completed' && 'completionCheckpoint' in phase && phase.completionCheckpoint) {
      resumePoint = {
        phaseId: phase.phaseId,
        checkpointSha: phase.completionCheckpoint,
        checkpointType: 'completed'
      };
      break;
    } else if (phase.status === 'skipped' && 'skipCheckpoint' in phase && phase.skipCheckpoint) {
      resumePoint = {
        phaseId: phase.phaseId,
        checkpointSha: phase.skipCheckpoint,
        checkpointType: 'skipped'
      };
      break;
    } else if ('workspaceSetupCheckpoint' in phase && phase.workspaceSetupCheckpoint) {
      // For workspace-setup, we resume FROM this phase (re-run it)
      resumePoint = {
        phaseId: null, // Will re-run this phase
        checkpointSha: phase.workspaceSetupCheckpoint,
        checkpointType: 'workspace-setup'
      };
      // Don't break - keep looking for better checkpoints
    }
  }
  
  if (!resumePoint) {
    this.logger.log("No valid checkpoint found, starting fresh");
    await this.startNewRun();
    return;
  }
  
  this.logger.log(`Resuming from checkpoint: ${resumePoint.checkpointSha} (${resumePoint.checkpointType})`);
  
  // Step 1: Rollback to the checkpoint
  if (this.checkpointGit) {
    try {
      await this.checkpointGit.resetToCheckpoint(resumePoint.checkpointSha);
      this.logger.log(`Successfully rolled back to checkpoint ${resumePoint.checkpointSha}`);
    } catch (error) {
      this.logger.log(`Failed to rollback: ${error}`, "error");
      // Continue anyway - the files might still be in a good state
    }
  }
  
  // Step 2: Create a continuation run
  const continuationConditions: StartingConditions = {
    type: 'continuation',
    source: {
      runId: latestRun.runId,
      afterPhase: resumePoint.phaseId,
      checkpointSha: resumePoint.checkpointSha
    },
    reason: 'continue' // Resuming after crash/restart
  };
  
  await this.startNewRun(continuationConditions);
  
  // Step 3: Start WebSocket server
  this.server = Bun.serve<ClientData, undefined>({
    port: this.config.port,
    websocket: {
      open: (ws) => this.handleConnection(ws),
      message: (ws, message) => this.handleMessage(ws, message),
      close: (ws) => this.handleClose(ws),
    },
    fetch(req, server) {
      if (server.upgrade(req)) {
        return;
      }
      return new Response("WebSocket server only", { status: 400 });
    },
  });
  
  this.logger.log(`WebSocket server listening on port ${this.config.port}`);
  
  // Step 4: Set up process handlers
  process.on("SIGINT", () => this.shutdown("SIGINT"));
  process.on("SIGTERM", () => this.shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    this.logger.log(`Uncaught exception: ${error.message}`, "error");
    this.shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason, promise) => {
    this.logger.log(`Unhandled rejection at: ${promise}, reason: ${reason}`, "error");
    this.shutdown("unhandledRejection");
  });
  
  // Step 5: Auto-start next phase if configured
  if (this.config.autostart) {
    // Use execution thread to determine next phase
    const thread = await this.stateManager.getExecutionThread();
    if (thread.nextPhaseId) {
      this.logger.log(`Auto-starting next phase: ${thread.nextPhaseId}`);
      await this.startPhase(thread.nextPhaseId);
    } else {
      this.logger.log("All phases completed or no next phase determined");
    }
  }
  
  this.logger.log("Resume complete - server ready");
}
```

### 4. Add Configuration Option

**In `config.ts`**, add a new configuration option:

```typescript
export interface ServerConfig {
  // ... existing fields ...
  autoResume?: boolean; // Default: true - automatically resume from last checkpoint on startup
}

export const DEFAULT_CONFIG = {
  // ... existing defaults ...
  autoResume: true,
};
```

### 5. Modify Lock File Handling

**In `tadpole-server.ts::start()`**, update the lock file check to better handle resume scenarios:

```typescript
// Around line 258, modify the lock file check
if (fs.existsSync(this.config.lockFile)) {
  const lockData = fs.readFileSync(this.config.lockFile, "utf-8");
  
  try {
    const lockInfo = JSON.parse(lockData);
    const heartbeatAge = Date.now() - new Date(lockInfo.lastHeartbeat).getTime();
    
    if (heartbeatAge > 120000) { // 2 minutes
      this.logger.log(`Found stale lock file (heartbeat age: ${heartbeatAge}ms), removing...`);
      fs.unlinkSync(this.config.lockFile);
      
      // Mark the run as crashed but DON'T transition yet
      // Let the resume logic handle it
      if (lockInfo.runId) {
        this.logger.log(`Previous run ${lockInfo.runId} appears to have crashed`);
        // The resume logic will handle this
      }
    } else {
      throw new Error(
        `Server already running (PID: ${lockInfo.pid}, Run: ${lockInfo.runId})`
      );
    }
  } catch (e) {
    // Old format lock file
    throw new Error(
      `Server already running (PID: ${lockData}). Remove ${this.config.lockFile} if this is incorrect.`
    );
  }
}
```

## Summary

The implementation requires adding approximately 150 lines of code, primarily in `tadpole-server.ts`. The key changes are:

1. **Resume Detection**: Check state on startup to determine if resumption is needed
2. **Checkpoint Selection**: Find the most recent valid checkpoint to resume from
3. **Rollback**: Use existing `CheckpointGit.resetToCheckpoint()` to restore file state
4. **Continuation Run**: Create a new run that continues from the checkpoint
5. **Auto-start**: Automatically start the next phase after resumption

The implementation leverages all existing infrastructure:
- State persistence and recovery
- Checkpoint system for file restoration  
- Execution thread for determining next phase
- Continuation run mechanics

This approach ensures that Tadpole can gracefully recover from crashes, restarts, or interruptions by automatically resuming from the last known good state.