// -------------
// Hankweave State Management Types
// -------------

import type { CodonId, RunId, SessionId } from "./branded-types.js";
import type { BudgetExceededData } from "./budget-types.js";
import type { FailureReason, TokenUsage } from "./types.js";

// Re-export types for use in other modules
export type { CodonId, RunId, SessionId, FailureReason, TokenUsage };

// -------------
// Sentinel State
// -------------

/**
 * State tracking for a single sentinel within a codon.
 * Mutable structure updated in-place during codon execution.
 */
export interface SentinelState {
  id: string;
  model: string;
  loadedAt: string;
  unloadedAt?: string;
  llmCallCount: number;
  failedLLMCalls: number;
  lastLlmCallAt?: string;
  totalTriggers: number;
  totalCost: number;
  status: "active" | "unloaded";
  unloadReason?: "codon-complete" | "fatal-error" | "consecutive-failures";
}

// -------------
// Codon Execution States - Discriminated Union
// -------------

/**
 * Codon execution status progression.
 *
 * Normal flow: preparing → starting → initializing → running → completing-sentinels → completed
 * Can skip to "failed" or "skipped" from any non-terminal state.
 *
 * Intent: Track granular progress for better crash recovery and user feedback.
 */
export type CodonStatus =
  | "preparing" // Rig setup running (copy files, run commands)
  | "starting" // Spawning Claude process
  | "initializing" // Process started, waiting for session ID
  | "running" // Claude is working (have session ID)
  | "completing-sentinels" // Completing sentinel work (draining queues)
  | "completed" // Success - terminal state
  | "failed" // Failed - terminal state
  | "skipped"; // User skipped - terminal state

/**
 * Base properties shared by all codon states.
 * These are set when the codon starts and never change.
 */
interface BaseCodon {
  /**
   * Which codon configuration this execution is for.
   * References the codon in hank.json.
   *
   * Used by: UI to show codon name, state queries for codon history
   */
  codonId: CodonId;

  /**
   * When this codon execution started.
   * ISO 8601 timestamp.
   *
   * Used by: Duration calculations, UI timeline display
   */
  startTime: string;

  /**
   * Loop context if this codon is part of a loop iteration.
   * Used for resuming loops after interruption and rollback.
   */
  loopContext?: {
    loopId: CodonId; // ID of the loop this codon belongs to
    iteration: number; // Which iteration (0-indexed: 0 = first, 1 = second, etc.)
    codonIndexInLoop: number; // Position within loop.codons array
  };
}

/**
 * Codon is preparing rig (running rig setup operations).
 *
 * Next states:
 * - starting: Rig setup succeeded
 * - failed: Copy failed, command failed, etc.
 * - skipped: User skipped during prep
 */
export interface PreparingCodon extends BaseCodon {
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
export interface StartingCodon extends BaseCodon {
  status: "starting";

  /**
   * Git commit SHA after rig setup completed.
   * Only set if codon config has rigSetup operations.
   *
   * Used by: Rollback to know exact state after setup
   * Edge case: May be undefined if no rig setup configured
   */
  rigSetupCheckpoint?: string;

  /**
   * Sentinels loaded for this codon.
   * Set after sentinels load during starting state.
   */
  sentinels?: {
    loaded: SentinelState[];
    totalCost: number;
  };
}

/**
 * Claude process running but no session ID yet.
 * Waiting for init message from Claude.
 *
 * Next states:
 * - running: Got session ID from init message
 * - completed: Process exited cleanly but init message failed validation
 * - failed: Process crashed before init
 * - skipped: User skipped during init
 */
export interface InitializingCodon extends BaseCodon {
  status: "initializing";
  rigSetupCheckpoint?: string;

  /**
   * Claude process ID for monitoring/cleanup.
   *
   * Used by: Process manager to kill on skip/shutdown
   * Edge case: Process might already be dead
   */
  claudePid: number;

  /**
   * Path to Claude's JSONL log file.
   * Relative to .hankweave directory.
   * Example: "runs/1234-abc/codon-research-claude.log"
   *
   * Used by: Log parser, debugging, cleanup
   */
  claudeLogPath: string;

  /**
   * Session ID from previous codon if continuing.
   * Only set if codon has continueFromPrevious: true.
   *
   * Used by: Claude CLI --resume flag
   */
  previousSessionId?: SessionId;

  /**
   * Sentinels loaded for this codon.
   * Optional field added during starting state, carried forward to initializing.
   */
  sentinels?: {
    loaded: SentinelState[];
    totalCost: number;
  };
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
export interface RunningCodon extends BaseCodon {
  status: "running";
  rigSetupCheckpoint?: string;
  claudePid: number;

  /**
   * Claude's session UUID from init message.
   * Required for continuation in later codons.
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
   * Initialized to 0 when codon enters running state.
   *
   * Used by: Continue functionality to check if session is valid
   */
  assistantMessageCount: number;

  /**
   * Number of extensions performed so far.
   * 0 initially, increments with each extension.
   * Used for tracking progress and enforcing maxExtensions.
   */
  extensionCount: number;

  /**
   * Sentinels loaded for this codon.
   * Updated in-place during execution.
   */
  sentinels?: {
    loaded: SentinelState[];
    totalCost: number;
  };
}

/**
 * Codon is completing sentinel work.
 * Transient state between agent completion and final state.
 *
 * This state indicates:
 * - Main Claude agent has finished (process exited)
 * - Sentinel queues are being drained
 * - All pending LLM calls are completing
 * - Output files are being finalized
 *
 * Next states:
 * - completed: All work done successfully
 * - failed: Checkpoint creation failed
 * - skipped: Should not normally happen from this state
 */
export interface CompletingSentinelsCodon extends BaseCodon {
  status: "completing-sentinels";
  rigSetupCheckpoint?: string;
  claudePid: number;
  claudeSessionId: SessionId;
  claudeLogPath: string;
  previousSessionId?: SessionId;

  /**
   * Current cost accumulated while Claude was running.
   * Will become finalCost when transitioning to completed.
   */
  currentCost: number;

  /**
   * Current token counts.
   * Will become finalTokens when transitioning to completed.
   */
  currentTokens: TokenUsage;

  /**
   * Number of assistant messages received.
   */
  assistantMessageCount: number;

  /**
   * Extension count from the running state.
   * Preserved during sentinel completion.
   */
  extensionCount: number;

  /**
   * Sentinels being completed.
   * States are updated in-place as work completes.
   */
  sentinels?: {
    loaded: SentinelState[];
    totalCost: number;
  };
}

// -------------
// Terminal States - Immutable once reached
// -------------

/**
 * Codon completed successfully.
 * This is a terminal state - no further transitions possible.
 *
 * Immutability: All fields are final. To retry, start a new run.
 */
export interface CompletedCodon extends BaseCodon {
  status: "completed";

  /**
   * When codon completed. Used for duration calculation.
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
   * This is the authoritative cost for this codon.
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

  /**
   * Final count of extensions performed.
   * Used for reporting and debugging.
   */
  extensionCount: number;

  // Checkpoints
  rigSetupCheckpoint?: string;

  /**
   * Git commit after successful completion.
   * Always created for successful codons.
   *
   * Used by: Rollback target points
   */
  completionCheckpoint: string;

  /**
   * Sentinels that executed during this codon (final state).
   * Field renamed from 'loaded' to 'executed' when codon completes.
   */
  sentinels?: {
    executed: SentinelState[];
    totalCost: number;
  };

  /** Present when codon was force-completed due to budget limit. */
  budgetExceeded?: BudgetExceededData;
}

/**
 * Codon failed with error.
 * Terminal state - must start new run to retry.
 */
export interface FailedCodon extends BaseCodon {
  status: "failed";
  endTime: string;

  /**
   * Which state we were in when failure occurred.
   * Helps understand how far we got.
   *
   * Used by: Error analysis, retry strategies
   * Example: "preparing" means rig setup failed
   * Note: Can include "completing-sentinels" if checkpoint creation fails during that codon
   */
  failedDuring: "preparing" | "starting" | "initializing" | "running" | "completing-sentinels";

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

  /**
   * Number of extensions performed before failure.
   * Only present if codon reached running state and attempted extensions.
   */
  extensionCount?: number;

  // Checkpoints
  rigSetupCheckpoint?: string;

  /**
   * Error checkpoint if created.
   * On error branch in git.
   *
   * Edge case: Might not exist if git operations failed
   */
  errorCheckpoint?: string;

  /**
   * Sentinels that executed before failure.
   */
  sentinels?: {
    executed: SentinelState[];
    totalCost: number;
  };
}

/**
 * Codon was skipped by user.
 * Terminal state - represents user choice to skip.
 */
export interface SkippedCodon extends BaseCodon {
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
  rigSetupCheckpoint?: string;

  /**
   * Skip checkpoint if any files were being tracked.
   * Even empty commits are created for skip markers.
   *
   * Used by: Skip history in git
   */
  skipCheckpoint?: string;

  /**
   * Sentinels that executed before skip.
   */
  sentinels?: {
    executed: SentinelState[];
    totalCost: number;
  };
}

/**
 * Union of all possible codon states.
 * Use discriminated union on `status` field for type narrowing.
 */
export type CodonExecution =
  | PreparingCodon
  | StartingCodon
  | InitializingCodon
  | RunningCodon
  | CompletingSentinelsCodon
  | CompletedCodon
  | FailedCodon
  | SkippedCodon;

// -------------
// Run State
// -------------

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
   * Example: "/project/.hankweave/runs/1234-abc"
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
   * Ordered list of codon executions in this run.
   * Append-only - new codons added as they start.
   *
   * Used by: Progress tracking, cost calculation
   * Invariant: Only one codon can be non-terminal at a time
   */
  codons: CodonExecution[];

  /**
   * Overall run status.
   * - running: Currently executing
   * - completed: All codons done successfully
   * - failed: Stopped due to codon failure
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
         * Which codon to continue after.
         * null means start from beginning of that run.
         *
         * Example: "codon-2" means start from codon-3
         * Used by: Determining next codon to execute
         */
        afterCodon: CodonId | null;

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

// -------------
// Top-Level State
// -------------

/**
 * Root state object for Hankweave.
 * Stored in .hankweave/state.json.
 *
 * Design decisions:
 * - Single file instead of per-run for simplicity
 * - No version field per user request
 * - No denormalized costs - computed when needed
 */
export interface HankweaveState {
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
   * Represents the project's clean state before any codons have executed.
   *
   * Used by: Rollback to clean state, project-level rollback commands
   */
  initialCheckpoint?: string;

  /**
   * Current execution plan with all loop iterations expanded.
   * This is the flattened plan that represents the actual execution sequence.
   * Rebuilt on server start but persisted for crash recovery and debugging.
   *
   * Note: May be empty array during initialization before first run starts,
   * but the field itself is always present.
   *
   * Used by: Codon execution, execution thread analysis, crash recovery
   */
  executionPlan: import("../execution-planner.js").ExecutionCodonEntry[];

  // No denormalized costs/tokens - computed from runs when needed
  // This avoids sync issues and keeps state minimal
}

// -------------
// State Transitions
// -------------

/**
 * Defines which status transitions are legal.
 * This is enforced at compile time by the state manager.
 *
 * Key rules:
 * - Can skip to "failed" or "skipped" from any non-terminal state
 * - Terminal states (completed/failed/skipped) have no valid transitions
 * - Must progress through states in order for normal execution
 */
export const CodonTransitions: Record<CodonStatus, CodonStatus[]> = {
  preparing: ["starting", "failed", "skipped"],
  starting: ["initializing", "failed", "skipped"],
  initializing: ["running", "completed", "failed", "skipped"],
  running: ["completing-sentinels", "completed", "failed", "skipped"],
  "completing-sentinels": ["completed", "failed", "skipped"],
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
   * Creates new Run entry with starting codon.
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
   * Run completed successfully (all codons done).
   *
   * Triggered by: Last codon completing successfully
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
   * Run failed (codon failed and server shutting down).
   *
   * Triggered by: Codon failure, fatal error
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
   * - Marks running codons as failed
   */
  | {
      type: "RunCrashed";
      data: {
        runId: RunId;
        detectedAt: string;
        lastCodonStatus: CodonStatus;
      };
    }

  // ===== Codon Lifecycle =====

  /**
   * New codon starting in current run.
   *
   * Triggered by: User command or auto-advance
   * State changes:
   * - Adds new PreparingCodon to run.codons
   * Validation: No other codon currently running
   */
  | {
      type: "CodonStarted";
      data: {
        runId: RunId;
        codonId: CodonId;
        loopContext?: {
          loopId: CodonId;
          iteration: number;
          codonIndexInLoop: number;
        };
      };
    }

  /**
   * Codon status changed (main state machine).
   *
   * Triggered by: Various codon lifecycle events
   * State changes:
   * - Updates codon status
   * - Sets relevant fields based on transition
   * Validation: Transition must be in CodonTransitions map
   */
  | {
      type: "CodonTransitioned";
      data: {
        runId: RunId;
        codonId: CodonId;
        from: CodonStatus;
        to: CodonStatus;
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
          failedDuring?: CodonStatus;

          // For any → skipped
          skippedDuring?: CodonStatus;

          // For completing → completed
          resultMessageReceived?: boolean;

          // For running → completing-sentinels
          sentinelCount?: number;
          sentinelIds?: string[];

          // Checkpoint info
          checkpointSha?: string;
          checkpointBranch?: string;

          // For marking context exceeded
          contextExceeded?: boolean;

          // For extensions
          extensionCount?: number;

          // For budget exceeded (force completion)
          budgetExceeded?: BudgetExceededData;
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
        codonId: CodonId;
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
        codonId: CodonId;
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
        codonId: CodonId;
        newCount: number; // New total count
      };
    }

  // ===== Extension Tracking =====

  /**
   * Extension count update.
   * Incremented when a codon extends.
   *
   * Triggered by: Extension trigger in hankweave-runtime
   * State changes:
   * - Updates extensionCount on RunningCodon
   */
  | {
      type: "ExtensionCountUpdated";
      data: {
        runId: RunId;
        codonId: CodonId;
        extensionCount: number; // New extension count
      };
    }

  // ===== Checkpoint Events =====

  /**
   * Git checkpoint created.
   *
   * Triggered by: Rig setup, completion, error, skip
   * State changes:
   * - Sets relevant checkpoint field in codon
   */
  | {
      type: "CheckpointCreated";
      data: {
        runId: RunId;
        codonId: CodonId;
        checkpointType: "rig-setup" | "completed" | "error" | "skipped";
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
   * Codon final cost set from Claude's result message.
   * This ensures the authoritative cost from Claude's result message
   * is stored before the codon completes.
   *
   * Triggered by: Claude result message with final cost
   * State changes:
   * - Updates currentCost and currentTokens in running codon
   */
  | {
      type: "CodonFinalCostSet";
      data: {
        runId: RunId;
        codonId: CodonId;
        finalCost: number;
        finalTokens: TokenUsage;
      };
    }

  /**
   * Sentinel states updated/initialized for a codon.
   * Sets the initial sentinel state when sentinels load,
   * or updates states before codon completion.
   *
   * Triggered by: After sentinels load, before completing-sentinels transition
   * State changes:
   * - Sets/updates RunningCodon.sentinels field
   * - Updates CompletingSentinelsCodon.sentinels field
   */
  | {
      type: "SentinelStatesUpdated";
      data: {
        runId: RunId;
        codonId: CodonId;
        sentinelStates: SentinelState[];
        totalCost: number;
      };
    };

/**
 * Extract the type field from StateTransition for use in schemas.
 * This ensures type safety when creating state transition events.
 */
export type StateTransitionType = StateTransition["type"];

// -------------
// State Manager Interface
// -------------

/**
 * Central state management for Hankweave.
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
  getState(): Readonly<HankweaveState>;

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
   * Get the currently executing codon.
   * @returns null if between codons or no run active
   */
  getCurrentlyRunningCodon(): CodonExecution | null;

  /**
   * Get specific codon in current run.
   * Useful for checking if codon already executed.
   *
   * @param codonId - Codon to look for
   * @returns null if codon not found or no current run
   */
  getCodonInCurrentRun(codonId: CodonId): CodonExecution | null;

  /**
   * Determine which codon should execute next.
   * Handles both fresh runs and continuations.
   *
   * Logic:
   * - For fresh runs: First codon in config
   * - For continuations: Codon after the continuation point
   * - If all codons complete: null
   *
   * @returns null if all codons completed
   */
  getNextCodonToExecute(): Promise<CodonId | null>;

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
   * Includes all codons (successful, failed, partial).
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
   * Validates that the source run and codon exist.
   *
   * @param runId - Run to continue from
   * @param afterCodon - Codon to continue after (null = from beginning)
   * @returns true if valid continuation point
   */
  canContinueFrom(runId: RunId, afterCodon: CodonId | null): boolean;

  /**
   * Get the checkpoint SHA for a continuation point.
   * This is what git should restore to.
   *
   * @returns null if invalid continuation point
   */
  getCheckpointForContinuation(runId: RunId, afterCodon: CodonId | null): string | null;

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
   * - Marks running codons as failed
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
  type: "missing_run" | "invalid_codon" | "corrupted_data";
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

// -------------
// Latest Codon Info
// -------------

/**
 * Information about the latest codon execution.
 * Used to determine the current position in the workflow.
 */
export interface LatestCodonInfo {
  /**
   * The codon execution object containing all codon details
   */
  codon: CodonExecution;

  /**
   * Which run this codon belongs to
   */
  runId: RunId;

  /**
   * Current status of the codon (convenience field)
   */
  status: CodonStatus;

  /**
   * The next codon that should be executed (if any).
   * null means all codons are complete or a new run is needed.
   */
  nextCodonId: CodonId | null;

  /**
   * Whether to continue execution in the current run.
   * false means a new run needs to be started (e.g., after rollback).
   */
  continueInCurrentRun: boolean;
}

// -------------
// Helper Functions
// -------------

/**
 * Check if a codon status is terminal (no further transitions possible)
 */
export function isTerminalCodonStatus(status: CodonStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

/**
 * Calculate codon cost based on its status
 */
export function getCodonCost(codon: CodonExecution): number {
  switch (codon.status) {
    case "completed":
      return codon.finalCost;
    case "failed":
      return codon.partialCost;
    case "skipped":
      return 0;
    case "running":
      return codon.currentCost;
    case "completing-sentinels":
      return codon.currentCost;
    default:
      return 0;
  }
}

/**
 * Calculate codon tokens based on its status
 */
export function getCodonTokens(codon: CodonExecution): TokenUsage {
  switch (codon.status) {
    case "completed":
      return codon.finalTokens;
    case "failed":
      return codon.partialTokens;
    case "skipped":
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
    case "running":
      return codon.currentTokens;
    case "completing-sentinels":
      return codon.currentTokens;
    default:
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
  }
}
