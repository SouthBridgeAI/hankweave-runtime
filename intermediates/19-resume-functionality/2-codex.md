# Resume Execution on Boot — Implementation Plan

This plan wires up automatic resume-on-boot using the existing checkpointing, rollback, and state systems. It keeps changes small and focused, leveraging modules already in place.

- Server boots
- Loads state and detects crashes
- Determines the last valid checkpoint to resume from
- Rolls back to that checkpoint (phase-by-phase with workspace cleanup)
- Starts a continuation run and continues execution

The design favors reuse of existing primitives: `StateManager`, `CheckpointGit`, `analyzeExecutionThread`, and the server’s rollback helpers.

## Current Architecture (Quick Map)

- `StateManager`
  - Loads `state.json` and emits transitions; detects crashed runs: `detectCrashedRuns()`.
  - Provides `getExecutionThread()` (via `analyzeExecutionThread`) and `getNextPhaseToExecute()`.
- `CheckpointGit`
  - Shadow git repo under `.tadpole/checkpoints`, creates commits, and can `resetToCheckpoint(sha)`.
- `execution-thread.ts`
  - `analyzeExecutionThread(state, phaseConfigs, checkpointData?)` builds a view over runs/phases.
  - Includes checkpoint attachment via `buildCheckpointInfo()` and helpers to determine `nextPhaseId`.
- `tadpole-server.ts`
  - Startup handles lock file and initializes state/claude machinery.
  - Robust rollback flow already exists: `executeRollback(...)` and `executePhaseByPhaseRollback(...)`.

Gaps: We don’t yet compute a “resume plan” at boot nor invoke rollback + continuation automatically.

## Resume Behavior — Rules of Thumb

1. If the latest run ended in `crashed` (or was detected as stale) or in a non-terminal state that was transitioned to `failed` by crash detection, we resume.
2. Choose the safest, most recent checkpoint:
   - Prefer the current phase’s `workspaceSetupCheckpoint` if available (re-run same phase).
   - Else prefer the most recent prior phase’s `completionCheckpoint` (run next phase).
   - Else, if nothing exists, do nothing (cannot safely resume) and start fresh when user starts.
3. Roll back phase-by-phase (already implemented) to the selected checkpoint, then start a continuation run from that point and auto-start the next phase if `autostart` is true.

Notes:
- We do not invent new events; we reuse the existing `rollback.*` events so the TUI/clients get progress for free.
- We respect tracked file patterns restoration just like rollback does.

## Module Changes

### 1) `execution-thread.ts` — add a small helper to pick a resume target

Add a function that inspects the latest thread and returns a target checkpoint and thread phase index suitable for rollback. This keeps policy localized and testable.

```ts
// execution-thread.ts
export interface ResumeTarget {
  targetPhaseIndex: number; // index into thread.phases (latest-first)
  checkpointSha: string; // full sha (validated/existing preferred)
  checkpointType: "workspace-setup" | "completed" | "error" | "skipped";
}

export function computeResumeTarget(thread: ExecutionThread): ResumeTarget | null {
  if (thread.phases.length === 0) return null;

  // Latest context
  const latest = thread.phases[0];

  // Strategy: try to resume from the current/latest phase first
  // Priority for safety: workspace-setup > completed > error > skipped
  const tryPhase = (tp: ThreadPhase): { sha: string; type: ResumeTarget["checkpointType"] } | null => {
    const p = tp.phase;
    if ("workspaceSetupCheckpoint" in p && p.workspaceSetupCheckpoint) {
      return { sha: p.workspaceSetupCheckpoint, type: "workspace-setup" };
    }
    if (p.status === "completed" && p.completionCheckpoint) {
      return { sha: p.completionCheckpoint, type: "completed" };
    }
    if (p.status === "failed" && "errorCheckpoint" in p && p.errorCheckpoint) {
      return { sha: p.errorCheckpoint, type: "error" };
    }
    if (p.status === "skipped" && "skipCheckpoint" in p && p.skipCheckpoint) {
      return { sha: p.skipCheckpoint, type: "skipped" };
    }
    return null;
  };

  // 1) Check latest phase
  const latestCandidate = tryPhase(latest);
  if (latestCandidate) {
    return {
      targetPhaseIndex: 0,
      checkpointSha: latestCandidate.sha,
      checkpointType: latestCandidate.type,
    };
  }

  // 2) Otherwise, scan forward in history for the first phase that has a checkpoint
  for (let i = 1; i < thread.phases.length; i++) {
    const cand = tryPhase(thread.phases[i]);
    if (cand) {
      return {
        targetPhaseIndex: i,
        checkpointSha: cand.sha,
        checkpointType: cand.type,
      };
    }
  }

  // 3) No checkpoint found
  return null;
}
```

Rationale: This mirrors how humans would recover—try to re-run the current phase from its setup point; otherwise, continue from the last completed phase behind it.

### 2) `tadpole-server.ts` — attempt resume during `start()`

Add `attemptResumeOnBoot()` and invoke it after state and checkpoints initialize, before starting a fresh run. This reuses the existing rollback machinery and continuation run logic.

Key entry points (pseudocode outline):

```ts
// tadpole-server.ts
private async attemptResumeOnBoot(): Promise<boolean> {
  // 1) Nothing to do if state has no runs
  const state = this.stateManager.getState();
  if (state.runs.length === 0) return false;

  // 2) Build checkpoint metadata map (sha -> {message,timestamp,branch})
  let checkpointData: Map<string, { message: string; timestamp: string; branch: string }> | undefined;
  if (this.checkpointGit?.isInitialized()) {
    const all = await this.checkpointGit.getAllCheckpoints();
    checkpointData = new Map(all.map((c) => [c.sha, { message: c.message, timestamp: c.timestamp, branch: c.branch }]));
  }

  // 3) Build execution thread and see if recovery is warranted
  const thread = await analyzeExecutionThread(state, this.config.phases, checkpointData, undefined, this.logger);

  // If latest run is completed and no phases running, nothing to resume
  const latestRun = state.runs[0];
  if (!latestRun) return false;
  const isTerminalRun = latestRun.status === "completed" || latestRun.status === "failed";
  const needsResume = latestRun.status === "crashed" || (!thread.hasRunningPhase && !isTerminalRun);
  if (!needsResume) return false;

  // 4) Pick a resume target
  const target = computeResumeTarget(thread);
  if (!target) {
    this.logger.log("No valid checkpoint found for resume; skipping auto-resume");
    return false;
  }

  // 5) Execute rollback + continuation
  await this.executeRollback(
    thread,
    target.targetPhaseIndex,
    target.checkpointSha,
    target.checkpointType,
    /* autoRestart */ true,
  );
  return true;
}

// In start(): after initializeCheckpoints() and stateManager.initialize(), before startNewRun()
await this.initializeCheckpoints();
await this.stateManager.initialize();

// Handle stale lock and crash detection as today...
// After lock handling, try resume
const resumed = await this.attemptResumeOnBoot();
if (!resumed) {
  // Fall back to current behavior: start a new run
  await this.startNewRun();
  const currentRun = this.stateManager.getCurrentRun();
  if (currentRun?.gitBranch && this.checkpointGit) {
    const isFreshRun = currentRun.startingConditions?.type === "fresh";
    if (!isFreshRun) {
      try { await this.checkpointGit.switchToBranch(currentRun.gitBranch); } catch {}
    }
  }
}
```

Why here? We already have `executeRollback`, tracked pattern restoration, and continuation run creation, so we avoid duplicating logic.

### 3) `state-manager.ts` — optional helper (nice-to-have)

No hard requirement to change `StateManager`, but two optional helpers improve clarity/testability:

- A method that returns the latest non-terminal run info or a boolean indicating resume is advisable (based on run status):

```ts
// state-manager.ts (optional)
getLatestRun(): ST.Run | null { return this.state.runs[0] ?? null; }
shouldResumeOnBoot(): boolean {
  const r = this.state.runs[0];
  if (!r) return false;
  return r.status === "crashed" || r.status === "running"; // running will usually be marked crashed by initialize()
}
```

This keeps policy out of `tadpole-server.ts`, but it’s not strictly necessary.

## Edge Cases and Details

- No checkpoints present: We skip resume and start a fresh run.
- Workspace-setup continuation: If the target is a workspace-setup checkpoint, `executeRollback()` already sets `afterPhase = null` so the same phase is re-run in the continuation.
- Tracked patterns: `executeRollback()` restores tracked files for phases up to the target (or including target when workspace-setup), so future commits work correctly.
- Events: Reuses `rollback.started`, `rollback.progress`, `rollback.phaseCheckpoint`, `rollback.workspaceCleanup`, and `rollback.completed` so the TUI shows progress.
- Autostart: `executeRollback()` uses `autoRestart` which chains into `startPhase(nextPhase)` if configured.
- Lock file: Startup logic still removes stale locks and emits `RunCrashed` when needed; resume happens afterward.

## Minimal Diffs (Where to Touch)

- `execution-thread.ts`: add the `ResumeTarget` interface and `computeResumeTarget()` helper.
- `tadpole-server.ts`: add `attemptResumeOnBoot()` and call it from `start()` before creating a new run.
- Optionally, small helper(s) in `state-manager.ts` for readability.

## Validation Plan

- Simulate crash during a phase:
  - Start a run, begin a phase with workspace setup, kill the server process.
  - On next boot, expect: rollback progress events, reset to the workspace-setup checkpoint, continuation run created, same phase re-started.
- Simulate crash after a `completed` phase:
  - Ensure last phase has `completionCheckpoint`.
  - Kill server before next phase starts.
  - On boot, expect: rollback to the completion checkpoint and auto-start of the next phase.
- Simulate no checkpoints:
  - Boot should skip resume and start a fresh run.

## Rationale

This approach:
- Minimizes code surface by reusing `executeRollback()` and thread analysis.
- Keeps policy (how to pick a resume checkpoint) small, explicit, and testable.
- Preserves the existing event model and TUI behavior.

