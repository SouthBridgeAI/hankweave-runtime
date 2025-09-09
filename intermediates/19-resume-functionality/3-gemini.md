### Implementation Plan: Execution Resumption

This plan outlines the changes required to enable the Tadpole server to resume execution from the last valid state upon startup.

#### 1. High-Level Strategy

The core idea is to introduce a `--resume` flag. When the server starts with this flag, it will:
1.  Load the existing `state.json` from the execution directory.
2.  Use `analyzeExecutionThread` to determine the last successfully completed or partially run phase.
3.  Identify the last valid checkpoint associated with that phase.
4.  Use `CheckpointGit` to perform a hard reset of the workspace to that checkpoint's state.
5.  Re-initialize the server state to reflect the rollback.
6.  Automatically start execution from the phase that follows the checkpoint.

If no `--resume` flag is provided, the server will start a new run as it currently does, unless it detects a crashed run, which is already handled.

#### 2. Module-by-Module Changes

Here are the specific changes required for each module:

##### 2.1. `server/index.ts` (Entry Point)

The entry point needs to be updated to recognize and handle a new `--resume` flag.

-   **Add `--resume` flag:** Add the flag to the list of valid arguments and the help message.
-   **Pass `resume` option to `TadpoleServer`:** A new `resume` property will be added to the `serverConfig` object passed to the `TadpoleServer` constructor.

```typescript
// In server/index.ts, inside main()

// ... argument parsing ...
const resumeMode = args.includes("--resume");

// ... help message ...
console.log(`
  // ... existing options ...
  --resume                  Resume the last execution from the most recent valid checkpoint.
  // ...
`);

// ... inside try block for normal server mode ...
const serverConfig = {
  // ... existing properties ...
  resume: resumeMode, // Add this new property
  autostart: !noAutostart,
  withoutProxy,
};

const server = new TadpoleServer(serverConfig);
await server.start();
```

##### 2.2. `server/tadpole-server.ts` (Core Orchestrator)

This is where the main resume logic will be orchestrated.

-   **Update `ServerConfig` type:** Add the optional `resume?: boolean;` property.
-   **Modify `start()` method:** The `start()` method will check for `this.config.resume` at the beginning.

```typescript
// In server/tadpole-server.ts

// ... imports ...
import type { ServerConfig } from "./types/types.js"; // Ensure this type is updated

// ... inside TadpoleServer class ...

async start(): Promise<void> {
  this.logger.log(
    `Starting Tadpole Server v${this.config.version} in ${this.config.executionPath}`,
  );

  // ... proxy server startup ...

  await this.initializeCheckpoints();
  await this.stateManager.initialize();

  // --- NEW RESUME LOGIC ---
  if (this.config.resume) {
    const resumeSuccess = await this.attemptResume();
    if (!resumeSuccess) {
      this.logger.log("Resume failed. Starting a fresh run instead.", "info");
      // The server will proceed to start a new run as normal if resume fails.
    }
  }
  // --- END NEW RESUME LOGIC ---

  // Check for existing lock file (this logic might need slight adjustment to coexist with resume)
  // ... existing lock file logic ...

  // Start a new run if needed (this will now only run if not resuming or if resume failed)
  if (!this.currentRunId) {
    await this.startNewRun();
    // ... existing branch switching logic ...
  }

  // ... rest of the start() method ...
}

// Add a new private method to handle the resume logic
private async attemptResume(): Promise<boolean> {
  this.logger.log("Attempting to resume execution...");

  const thread = await this.stateManager.getExecutionThread(undefined, true);
  if (thread.phases.length === 0) {
    this.logger.log("No phases found in history. Cannot resume.", "info");
    return false;
  }

  // Find the latest valid checkpoint to resume from.
  // We look for 'completed', 'skipped', or 'workspace-setup' checkpoints.
  let checkpointToResumeFrom: CheckpointInfo | undefined;
  let phaseToResumeAfter: PhaseExecution | undefined;
  let sourceRunId: RunId | undefined;

  for (const threadPhase of thread.phases) {
    const phase = threadPhase.phase;
    if (phase.status === "completed" && phase.completionCheckpoint) {
      checkpointToResumeFrom = threadPhase.validatedCheckpoints.find(c => c.type === 'completed');
      phaseToResumeAfter = phase;
      sourceRunId = threadPhase.runId;
      break;
    }
    if (phase.status === "skipped" && "skipCheckpoint" in phase && phase.skipCheckpoint) {
      checkpointToResumeFrom = threadPhase.validatedCheckpoints.find(c => c.type === 'skipped');
      phaseToResumeAfter = phase;
      sourceRunId = threadPhase.runId;
      break;
    }
    if ("workspaceSetupCheckpoint" in phase && phase.workspaceSetupCheckpoint) {
        // This allows resuming from a phase that failed after setup.
        checkpointToResumeFrom = threadPhase.validatedCheckpoints.find(c => c.type === 'workspace-setup');
        phaseToResumeAfter = phase;
        sourceRunId = threadPhase.runId;
        break;
    }
  }

  if (!checkpointToResumeFrom || !phaseToResumeAfter || !sourceRunId) {
    this.logger.log("No valid checkpoint found to resume from.", "info");
    return false;
  }

  this.logger.log(`Found checkpoint to resume from: ${checkpointToResumeFrom.sha} (Phase: ${phaseToResumeAfter.phaseId}, Status: ${phaseToResumeAfter.status})`);

  // Perform the rollback
  try {
    if (!this.checkpointGit) {
        throw new Error("CheckpointGit not initialized.");
    }
    await this.checkpointGit.resetToCheckpoint(checkpointToResumeFrom.sha);
    this.logger.log(`Successfully rolled back workspace to checkpoint ${checkpointToResumeFrom.sha}`);
  } catch (error) {
    this.logger.log(`Rollback to checkpoint ${checkpointToResumeFrom.sha} failed: ${error}`, "error");
    return false;
  }

  // Start a new run that continues from the rolled-back state
  const startingConditions: import("./types/state-types.js").StartingConditions = {
    type: "continuation",
    source: {
      runId: sourceRunId,
      afterPhase: phaseToResumeAfter.phaseId,
      checkpointSha: checkpointToResumeFrom.sha,
    },
    reason: "resume",
  };

  await this.startNewRun(startingConditions);

  this.logger.log(`Resume successful. New run ${this.currentRunId} started.`);
  await this.sendStateSnapshot();

  // Auto-start the next phase
  if (this.config.autostart) {
    this.autoStartNextPhase();
  }

  return true;
}
```

##### 2.3. `server/execution-thread.ts`

The `analyzeExecutionThread` function is already powerful enough to determine the logical order of phases. The current logic for `nextPhaseId` seems to correctly identify the next phase after a continuation. When we create a new run with `reason: "resume"`, the execution thread will see it as a continuation and correctly identify the next phase to run. No changes are required here.

##### 2.4. `server/checkpoint-git.ts`

The `resetToCheckpoint` method already exists and performs a `--hard` reset, which is exactly what is needed. No changes are required here.

#### 3. Summary of New Logic Flow

1.  `bun server/index.ts --resume` is executed.
2.  `index.ts` parses the flag and sets `resume: true` in `serverConfig`.
3.  `TadpoleServer.start()` is called.
4.  Inside `start()`, `this.config.resume` is true, so `this.attemptResume()` is called.
5.  `attemptResume()` gets the execution thread from `StateManager`.
6.  It iterates through the thread's phases (newest first) to find the latest phase with a `completed`, `skipped`, or `workspace-setup` checkpoint.
7.  If a suitable checkpoint is found, `CheckpointGit.resetToCheckpoint()` is called to revert the workspace files.
8.  A new run is created in the `StateManager` with `startingConditions` that point to the phase and checkpoint that were used for the rollback. The reason is marked as `"resume"`.
9.  `attemptResume()` returns `true`.
10. The `start()` method continues. The `this.currentRunId` is now set, so it doesn't start another new run.
11. The server finishes starting up, connects to a client, and `autoStartNextPhase()` is called.
12. `autoStartNextPhase()` calls `stateManager.getExecutionThread()`, which now correctly identifies the phase *after* the resumed phase as the `nextPhaseId`.
13. The server starts the correct next phase, effectively resuming the workflow.
