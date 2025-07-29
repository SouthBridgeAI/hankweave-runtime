// ============================================================================
// Tadpole State Management Types
// ============================================================================

import type { PhaseId, RunId, SessionId } from "./branded-types.js";
import type { FailureReason, TokenUsage } from "./types.js";

// Re-export types for use in other modules
export type { PhaseId, RunId, SessionId, FailureReason, TokenUsage };

// ============================================================================
// Phase Execution States - Discriminated Union
// ============================================================================

/**
 * Phase execution status progression.
 *
 * Normal flow: preparing → starting → initializing → running → completed
 * Can skip to "failed" or "skipped" from any non-terminal state.
 *
 * Intent: Track granular progress for better crash recovery and user feedback.
 */
export type PhaseStatus =
  | "preparing" // Workspace setup running (copy files, run commands)
  | "starting" // Spawning Claude process
  | "initializing" // Process started, waiting for session ID
  | "running" // Claude is working (have session ID)
  | "completed" // Success - terminal state
  | "failed" // Failed - terminal state
  | "skipped"; // User skipped - terminal state

/**
 * Base properties shared by all phase states.
 * These are set when the phase starts and never change.
 */
interface BasePhase {
  /**
   * Which phase configuration this execution is for.
   * References the phase in phases.json.
   *
   * Used by: UI to show phase name, state queries for phase history
   */
  phaseId: PhaseId;

  /**
   * When this phase execution started.
   * ISO 8601 timestamp.
   *
   * Used by: Duration calculations, UI timeline display
   */
  startTime: string;
}

/**
 * Phase is preparing workspace (running workspace setup operations).
 *
 * Next states:
 * - starting: Workspace setup succeeded
 * - failed: Copy failed, command failed, etc.
 * - skipped: User skipped during prep
 */
export interface PreparingPhase extends BasePhase {
  status: "preparing";
  // No Claude info yet - process not started
  // No costs yet - Claude not running
}

/**
 * Spawning Claude process.
 *
 * Next states:
 * - initializing: Process started successfully
 * - failed: Spawn failed (Claude not found, etc.)
 * - skipped: User skipped during startup
 */
export interface StartingPhase extends BasePhase {
  status: "starting";

  /**
   * Git commit SHA after workspace setup completed.
   * Only set if phase config has workspaceSetup operations.
   *
   * Used by: Rollback to know exact state after setup
   * Edge case: May be undefined if no workspace setup configured
   */
  workspaceSetupCheckpoint?: string;
}

/**
 * Claude process running but no session ID yet.
 * Waiting for init message from Claude.
 *
 * Next states:
 * - running: Got session ID from init message
 * - failed: Process crashed before init
 * - skipped: User skipped during init
 */
export interface InitializingPhase extends BasePhase {
  status: "initializing";
  workspaceSetupCheckpoint?: string;

  /**
   * Claude process ID for monitoring/cleanup.
   *
   * Used by: Process manager to kill on skip/shutdown
   * Edge case: Process might already be dead
   */
  claudePid: number;

  /**
   * Path to Claude's JSONL log file.
   * Relative to .tadpole directory.
   * Example: "runs/1234-abc/phase-research-claude.log"
   *
   * Used by: Log parser, debugging, cleanup
   */
  claudeLogPath: string;

  /**
   * Session ID from previous phase if continuing.
   * Only set if phase has continueFromPrevious: true.
   *
   * Used by: Claude CLI --resume flag
   */
  previousSessionId?: SessionId;
}

/**
 * Claude is actively working.
 * This is where most time is spent.
 *
 * Next states:
 * - completed: Claude process exited cleanly
 * - failed: Timeout, API error, crash
 * - skipped: User skipped
 */
export interface RunningPhase extends BasePhase {
  status: "running";
  workspaceSetupCheckpoint?: string;
  claudePid: number;

  /**
   * Claude's session UUID from init message.
   * Required for continuation in later phases.
   *
   * Used by: Continue functionality, logs correlation
   */
  claudeSessionId: SessionId;
  claudeLogPath: string;
  previousSessionId?: SessionId;

  /**
   * Accumulated cost so far in USD.
   * Updated on each token usage message.
   *
   * Used by: Cost display, cost limits (future)
   * Edge case: May be stale if messages delayed
   */
  currentCost: number;

  /**
   * Accumulated token counts.
   * Updated on each assistant message with usage.
   *
   * Used by: Token display, rate limit tracking
   */
  currentTokens: TokenUsage;

  /**
   * Number of assistant messages received.
   * Used to determine if Claude has established a conversation.
   * Initialized to 0 when phase enters running state.
   *
   * Used by: Continue functionality to check if session is valid
   */
  assistantMessageCount: number;
}

// ============================================================================
// Terminal States - Immutable once reached
// ============================================================================

/**
 * Phase completed successfully.
 * This is a terminal state - no further transitions possible.
 *
 * Immutability: All fields are final. To retry, start a new run.
 */
export interface CompletedPhase extends BasePhase {
  status: "completed";

  /**
   * When phase completed. Used for duration calculation.
   */
  endTime: string;

  // Claude integration details
  claudeSessionId: SessionId;
  claudeLogPath: string;
  previousSessionId?: SessionId;

  /**
   * Always 0 for successful completion.
   *
   * Used by: Success detection
   */
  exitCode: 0;

  /**
   * Final cost from result message or last token update.
   * This is the authoritative cost for this phase.
   *
   * Used by: Billing, cost reports
   * Edge case: May be from token updates if result message timed out
   */
  finalCost: number;

  /**
   * Final token counts.
   *
   * Used by: Usage analytics, model comparison
   */
  finalTokens: TokenUsage;

  /**
   * Whether we got Claude's result message before timeout.
   * False means costs might be slightly off.
   *
   * Used by: Cost accuracy warnings
   */
  resultMessageReceived: boolean;

  // Checkpoints
  workspaceSetupCheckpoint?: string;

  /**
   * Git commit after successful completion.
   * Always created for successful phases.
   *
   * Used by: Rollback target points
   */
  completionCheckpoint: string;
}

/**
 * Phase failed with error.
 * Terminal state - must start new run to retry.
 */
export interface FailedPhase extends BasePhase {
  status: "failed";
  endTime: string;

  /**
   * Which state we were in when failure occurred.
   * Helps understand how far we got.
   *
   * Used by: Error analysis, retry strategies
   * Example: "preparing" means workspace setup failed
   */
  failedDuring: "preparing" | "starting" | "initializing" | "running";

  // Claude info - only set if we got that far
  claudePid?: number;
  claudeSessionId?: SessionId;
  claudeLogPath?: string;
  previousSessionId?: SessionId;

  /**
   * Process exit code. 0 means clean exit (shouldn't happen for failed).
   * Common codes:
   * - 1: General error
   * - -1: Killed by signal
   * - 130: Ctrl+C
   *
   * Used by: Debugging, retry decisions
   */
  exitCode: number;

  /**
   * Structured failure information.
   *
   * Used by: UI error display, retry logic
   */
  failureReason: FailureReason;

  /**
   * Costs accumulated before failure.
   * Will be 0 if failed before Claude started.
   *
   * Used by: Partial cost tracking
   */
  partialCost: number;
  partialTokens: TokenUsage;

  // Checkpoints
  workspaceSetupCheckpoint?: string;

  /**
   * Error checkpoint if created.
   * On error branch in git.
   *
   * Edge case: Might not exist if git operations failed
   */
  errorCheckpoint?: string;
}

/**
 * Phase was skipped by user.
 * Terminal state - represents user choice to skip.
 */
export interface SkippedPhase extends BasePhase {
  status: "skipped";
  endTime: string;

  /**
   * Which state we were in when skipped.
   *
   * Used by: Understanding skip patterns
   */
  skippedDuring: "preparing" | "starting" | "initializing" | "running";

  // Claude info - only set if we got that far
  claudePid?: number;
  claudeSessionId?: SessionId;
  claudeLogPath?: string;
  previousSessionId?: SessionId;

  /**
   * Partial cost accumulated before skip.
   * Usually 0, but may have accumulated costs if skipped while running.
   *
   * Used by: Cost calculations, continuation logic
   */
  partialCost: number;

  /**
   * All zeros - no tokens used for skipped.
   */
  partialTokens: TokenUsage;

  /**
   * Number of assistant messages received before skip.
   * Used to determine if session can be continued.
   *
   * Used by: Continue functionality
   */
  assistantMessageCount?: number;

  // Checkpoints
  workspaceSetupCheckpoint?: string;

  /**
   * Skip checkpoint if any files were being tracked.
   * Even empty commits are created for skip markers.
   *
   * Used by: Skip history in git
   */
  skipCheckpoint?: string;
}

/**
 * Union of all possible phase states.
 * Use discriminated union on `status` field for type narrowing.
 */
export type PhaseExecution =
  | PreparingPhase
  | StartingPhase
  | InitializingPhase
  | RunningPhase
  | CompletedPhase
  | FailedPhase
  | SkippedPhase;

// ============================================================================
// Run State
// ============================================================================

/**
 * Represents one server lifecycle (start → shutdown).
 * Runs form a tree via parent relationships for rollback/retry.
 */
export interface Run {
  /**
   * Unique identifier for this run.
   * Also used as git branch name.
   *
   * Used by: State lookups, folder naming, git branches
   */
  runId: RunId;

  /**
   * Absolute path where run files are stored.
   * Example: "/project/.tadpole/runs/1234-abc"
   *
   * Used by: Log file storage, cleanup operations
   * Edge case: Folder might not exist if run failed early
   */
  runFolder: string;

  /**
   * Git branch name for this run.
   * Usually same as runId, but explicit for flexibility.
   *
   * Used by: Checkpoint system
   */
  gitBranch: string;

  /**
   * How this run started - fresh or continuation.
   * Immutable after run creation.
   *
   * Used by: UI to show run relationships, rollback tracking
   */
  startingConditions: StartingConditions;

  /**
   * Ordered list of phase executions in this run.
   * Append-only - new phases added as they start.
   *
   * Used by: Progress tracking, cost calculation
   * Invariant: Only one phase can be non-terminal at a time
   */
  phases: PhaseExecution[];

  /**
   * Overall run status.
   * - running: Currently executing
   * - completed: All phases done successfully
   * - failed: Stopped due to phase failure
   * - crashed: Detected on recovery
   *
   * Used by: Run selection, cleanup decisions
   */
  status: "running" | "completed" | "failed" | "crashed";

  /**
   * When server started. Never changes.
   */
  startTime: string;

  /**
   * When server stopped. Set when status becomes terminal.
   */
  endTime?: string;

  /**
   * Server process ID for lock file validation.
   *
   * Used by: Detecting stale lock files, crash recovery
   * Edge case: Process might not exist anymore
   */
  serverPid: number;
}

/**
 * How a run started - fresh project or continuation.
 */
export type StartingConditions =
  | {
      type: "fresh";
      initialCheckpointSha?: string; // SHA of the initial checkpoint commit
    }
  | {
      type: "continuation";
      source: {
        /**
         * Which run we're continuing from.
         *
         * Used by: Building run relationships tree
         */
        runId: RunId;

        /**
         * Which phase to continue after.
         * null means start from beginning of that run.
         *
         * Example: "phase-2" means start from phase-3
         * Used by: Determining next phase to execute
         */
        afterPhase: PhaseId | null;

        /**
         * Git commit SHA we restored to.
         * This is the exact state we're continuing from.
         *
         * Used by: Verifying correct restoration
         */
        checkpointSha: string;
      };

      /**
       * Human-readable reason for continuation.
       * Optional metadata for UI/analytics.
       *
       * Used by: Understanding user patterns
       */
      reason?: "retry" | "rollback" | "continue";
    };

// ============================================================================
// Top-Level State
// ============================================================================

/**
 * Root state object for Tadpole.
 * Stored in .tadpole/state.json.
 *
 * Design decisions:
 * - Single file instead of per-run for simplicity
 * - No version field per user request
 * - No denormalized costs - computed when needed
 */
export interface TadpoleState {
  /**
   * All runs, newest first.
   * Append-only - runs are never removed from history.
   *
   * Used by: History UI, cost calculations, rollback sources
   * Scaling: May need pagination/archival eventually
   */
  runs: Run[];

  /**
   * Currently active run ID.
   * null when server not running.
   *
   * Used by: State queries, preventing multiple servers
   * Invariant: Only one run can be "running" status
   */
  currentRunId: RunId | null;

  /**
   * Initial checkpoint SHA from git repository initialization.
   * This is the empty commit created when the checkpoint system starts.
   * Represents the project's clean state before any phases have executed.
   *
   * Used by: Rollback to clean state, project-level rollback commands
   */
  initialCheckpoint?: string;

  // No denormalized costs/tokens - computed from runs when needed
  // This avoids sync issues and keeps state minimal
}

// ============================================================================
// State Transitions
// ============================================================================

/**
 * Defines which status transitions are legal.
 * This is enforced at compile time by the state manager.
 *
 * Key rules:
 * - Can skip to "failed" or "skipped" from any non-terminal state
 * - Terminal states (completed/failed/skipped) have no valid transitions
 * - Must progress through states in order for normal execution
 */
export const PhaseTransitions: Record<PhaseStatus, PhaseStatus[]> = {
  preparing: ["starting", "failed", "skipped"],
  starting: ["initializing", "failed", "skipped"],
  initializing: ["running", "failed", "skipped"],
  running: ["completed", "failed", "skipped"],
  completed: [], // Terminal - no transitions
  failed: [], // Terminal - no transitions
  skipped: [], // Terminal - no transitions
};

/**
 * All possible state changes in the system.
 * These are the only way to modify state - ensures consistency.
 *
 * Design: Each event captures the minimal data needed for the transition.
 * The state manager computes derived state (like totals) as needed.
 */
export type StateTransition =
  // ===== Run Lifecycle =====

  /**
   * New run started (fresh or from continuation point).
   * Creates new Run entry with starting phase.
   *
   * Triggered by: Server startup
   * State changes:
   * - Adds new run to runs array
   * - Sets currentRunId
   * - Creates git branch
   */
  | {
      type: "RunStarted";
      data: {
        runId: RunId;
        runFolder: string;
        gitBranch: string;
        startingConditions: StartingConditions;
        serverPid: number;
      };
    }

  /**
   * Run completed successfully (all phases done).
   *
   * Triggered by: Last phase completing successfully
   * State changes:
   * - Sets run.status = "completed"
   * - Sets run.endTime
   * - Clears currentRunId
   */
  | {
      type: "RunCompleted";
      data: { runId: RunId };
    }

  /**
   * Run failed (phase failed and server shutting down).
   *
   * Triggered by: Phase failure, fatal error
   * State changes:
   * - Sets run.status = "failed"
   * - Sets run.endTime
   * - Clears currentRunId
   */
  | {
      type: "RunFailed";
      data: { runId: RunId };
    }

  /**
   * Run crashed (detected on recovery).
   *
   * Triggered by: Stale lock file detection
   * State changes:
   * - Sets run.status = "crashed"
   * - Sets run.endTime
   * - Marks running phases as failed
   */
  | {
      type: "RunCrashed";
      data: {
        runId: RunId;
        detectedAt: string;
        lastPhaseStatus: PhaseStatus;
      };
    }

  // ===== Phase Lifecycle =====

  /**
   * New phase starting in current run.
   *
   * Triggered by: User command or auto-advance
   * State changes:
   * - Adds new PreparingPhase to run.phases
   * Validation: No other phase currently running
   */
  | {
      type: "PhaseStarted";
      data: {
        runId: RunId;
        phaseId: PhaseId;
      };
    }

  /**
   * Phase status changed (main state machine).
   *
   * Triggered by: Various phase lifecycle events
   * State changes:
   * - Updates phase status
   * - Sets relevant fields based on transition
   * Validation: Transition must be in PhaseTransitions map
   */
  | {
      type: "PhaseTransitioned";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        from: PhaseStatus;
        to: PhaseStatus;
        metadata?: {
          // For starting → initializing
          claudePid?: number;
          claudeLogPath?: string;
          previousSessionId?: SessionId;

          // For initializing → running
          claudeSessionId?: SessionId;

          // For any → failed
          exitCode?: number;
          failureReason?: FailureReason;
          failedDuring?: PhaseStatus;

          // For any → skipped
          skippedDuring?: PhaseStatus;

          // For completing → completed
          resultMessageReceived?: boolean;

          // Checkpoint info
          checkpointSha?: string;
          checkpointBranch?: string;
        };
      };
    }

  // ===== Cost Updates =====

  /**
   * Token usage update from Claude.
   * Can happen frequently during execution.
   *
   * Triggered by: Assistant messages with usage
   * State changes:
   * - Updates currentCost/currentTokens (if running)
   * - Updates finalCost/finalTokens (if completing)
   */
  | {
      type: "CostsUpdated";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        cost: number; // New total cost
        tokens: TokenUsage; // New total tokens
      };
    }

  /**
   * Incremental token usage update from Claude.
   * More resilient to race conditions than CostsUpdated.
   *
   * Triggered by: Assistant messages with usage (incremental approach)
   * State changes:
   * - Adds costDelta to currentCost (if running)
   * - Adds tokensDelta to currentTokens (if running)
   */
  | {
      type: "CostsIncremented";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        costDelta: number; // The amount to add to the cost
        tokensDelta: TokenUsage; // The tokens to add to the totals
      };
    }

  // ===== Assistant Message Tracking =====

  /**
   * Assistant message count update.
   * Incremented when Claude sends a message.
   *
   * Triggered by: Assistant messages in Claude logs
   * State changes:
   * - Increments assistantMessageCount (if running/completing)
   */
  | {
      type: "AssistantMessageCountUpdated";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        newCount: number; // New total count
      };
    }

  // ===== Checkpoint Events =====

  /**
   * Git checkpoint created.
   *
   * Triggered by: Workspace setup, completion, error, skip
   * State changes:
   * - Sets relevant checkpoint field in phase
   */
  | {
      type: "CheckpointCreated";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        checkpointType: "workspace-setup" | "completed" | "error" | "skipped";
        sha: string;
        branch: string;
      };
    }

  /**
   * Initial checkpoint set for the project.
   *
   * Triggered by: Git repository initialization
   * State changes:
   * - Sets state.initialCheckpoint
   */
  | {
      type: "InitialCheckpointSet";
      data: {
        sha: string;
      };
    }

  /**
   * Phase final cost set from Claude's result message.
   * This ensures the authoritative cost from Claude's result message
   * is stored before the phase completes.
   *
   * Triggered by: Claude result message with final cost
   * State changes:
   * - Updates currentCost and currentTokens in running phase
   */
  | {
      type: "PhaseFinalCostSet";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        finalCost: number;
        finalTokens: TokenUsage;
      };
    };

// ============================================================================
// State Manager Interface
// ============================================================================

/**
 * Central state management for Tadpole.
 * All state modifications go through this interface.
 *
 * Implementation notes:
 * - Single instance per server
 * - Persists to disk after each transition
 * - Validates all transitions before applying
 * - Provides type-safe queries
 */
export interface StateManager {
  // ===== Initialization =====

  /**
   * Load state from disk or create new.
   * Called once on server startup.
   *
   * Recovery logic:
   * 1. Try to load state.json
   * 2. If corrupted, try state.json.bak
   * 3. If both fail, start fresh
   * 4. Detect any crashed runs
   */
  initialize(): Promise<void>;

  /**
   * Get current state snapshot (immutable).
   * This is the primary way to read state.
   *
   * Usage: const { runs, currentRunId } = stateManager.getState();
   */
  getState(): Readonly<TadpoleState>;

  // ===== State Modifications =====

  /**
   * Apply a state transition.
   * This is the ONLY way to modify state.
   *
   * Process:
   * 1. Validate transition is legal
   * 2. Apply transition (pure function)
   * 3. Persist to disk atomically
   * 4. Emit change event
   *
   * @throws {InvalidTransitionError} if transition is invalid
   * @throws {PersistenceError} if save fails
   */
  transition(event: StateTransition): void;

  // ===== Current Run Queries =====

  /**
   * Get the currently active run.
   * @returns null if no server running
   */
  getCurrentRun(): Run | null;

  /**
   * Get the currently executing phase.
   * @returns null if between phases or no run active
   */
  getCurrentlyRunningPhase(): PhaseExecution | null;

  /**
   * Get specific phase in current run.
   * Useful for checking if phase already executed.
   *
   * @param phaseId - Phase to look for
   * @returns null if phase not found or no current run
   */
  getPhaseInCurrentRun(phaseId: PhaseId): PhaseExecution | null;

  /**
   * Determine which phase should execute next.
   * Handles both fresh runs and continuations.
   *
   * Logic:
   * - For fresh runs: First phase in config
   * - For continuations: Phase after the continuation point
   * - If all phases complete: null
   *
   * @returns null if all phases completed
   */
  getNextPhaseToExecute(): Promise<PhaseId | null>;

  // ===== Historical Queries =====

  /**
   * Get any run by ID.
   * Useful for rollback sources, history display.
   *
   * @returns null if run not found
   */
  getRun(runId: RunId): Run | null;

  // ===== Cost Queries =====

  /**
   * Calculate total cost of current run.
   * Includes all phases (successful, failed, partial).
   *
   * @returns 0 if no current run
   */
  getCurrentRunCost(): number;

  /**
   * Calculate total cost across all runs.
   * This is the "all time" cost.
   *
   * Note: Computed on demand, not stored
   */
  getTotalCost(): number;

  /**
   * Calculate cost from a specific run onwards.
   * Useful for "cost since last success" queries.
   *
   * @param runId - Starting run (inclusive)
   * @returns Total cost from that run to now
   */
  getCostSince(runId: RunId): number;

  // ===== Rollback/Continue Support =====

  /**
   * Check if we can continue from a specific point.
   * Validates that the source run and phase exist.
   *
   * @param runId - Run to continue from
   * @param afterPhase - Phase to continue after (null = from beginning)
   * @returns true if valid continuation point
   */
  canContinueFrom(runId: RunId, afterPhase: PhaseId | null): boolean;

  /**
   * Get the checkpoint SHA for a continuation point.
   * This is what git should restore to.
   *
   * @returns null if invalid continuation point
   */
  getCheckpointForContinuation(runId: RunId, afterPhase: PhaseId | null): string | null;

  // ===== Persistence Operations =====

  /**
   * Force save current state to disk.
   * Normally automatic after transitions.
   *
   * Process:
   * 1. Copy current to .bak
   * 2. Write to .tmp
   * 3. Atomic rename to state.json
   *
   * Note: fs.renameSync is atomic on POSIX systems
   */
  save(): Promise<void>;

  /**
   * Validate state file integrity.
   * Checks for corruption, invalid references, etc.
   *
   * @returns Validation results with any issues found
   */
  validate(state: unknown): StateValidation;

  // ===== Recovery Operations =====

  /**
   * Detect and mark crashed runs on startup.
   * Finds runs with status="running" but server not running.
   *
   * Side effects:
   * - Transitions crashed runs to "crashed" status
   * - Marks running phases as failed
   *
   * Recovery strategy:
   * - Check for orphaned run folders not in state
   * - Validate PIDs in lock files
   * - Handle partial state writes (check for .tmp files)
   */
  detectCrashedRuns(): Promise<void>;

  /**
   * Attempt recovery from corrupted state.
   * Last resort if both state.json and backup fail.
   *
   * Options:
   * - Start fresh (data loss)
   * - Rebuild from Claude logs (deprecated)
   *
   * @returns Recovery results
   */
  recover(): Promise<RecoveryResult>;

  /**
   * Wait for all pending transitions during shutdown
   */
  waitForPendingTransitions(): Promise<void>;
}

// Supporting types for StateManager

export interface StateValidation {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  type: "missing_run" | "invalid_phase" | "corrupted_data";
  message: string;
  context?: unknown;
}

export interface ValidationWarning {
  type: "orphaned_folder" | "missing_checkpoint" | "cost_mismatch";
  message: string;
}

export interface RecoveryResult {
  success: boolean;
  method: "backup" | "fresh" | "logs";
  dataLoss: boolean;
  message: string;
}

// ============================================================================
// Latest Phase Info
// ============================================================================

/**
 * Information about the latest phase execution.
 * Used to determine the current position in the workflow.
 */
export interface LatestPhaseInfo {
  /**
   * The phase execution object containing all phase details
   */
  phase: PhaseExecution;

  /**
   * Which run this phase belongs to
   */
  runId: RunId;

  /**
   * Current status of the phase (convenience field)
   */
  status: PhaseStatus;

  /**
   * The next phase that should be executed (if any).
   * null means all phases are complete or a new run is needed.
   */
  nextPhaseId: PhaseId | null;

  /**
   * Whether to continue execution in the current run.
   * false means a new run needs to be started (e.g., after rollback).
   */
  continueInCurrentRun: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a phase status is terminal (no further transitions possible)
 */
export function isTerminalPhaseStatus(status: PhaseStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

/**
 * Calculate phase cost based on its status
 */
export function getPhaseCost(phase: PhaseExecution): number {
  switch (phase.status) {
    case "completed":
      return phase.finalCost;
    case "failed":
      return phase.partialCost;
    case "skipped":
      return 0;
    case "running":
      return phase.currentCost;
    default:
      return 0;
  }
}

/**
 * Calculate phase tokens based on its status
 */
export function getPhaseTokens(phase: PhaseExecution): TokenUsage {
  switch (phase.status) {
    case "completed":
      return phase.finalTokens;
    case "failed":
      return phase.partialTokens;
    case "skipped":
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
    case "running":
      return phase.currentTokens;
    default:
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
  }
}
