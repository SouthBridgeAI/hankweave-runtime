FROM AI: (Except for the parts with TODOs)

// NOTE: This is a DESIGN DOCUMENT, not production code.
// TypeScript errors are expected as this file is for planning purposes.
// The imports below reference types that would exist in the actual implementation.

import { z } from "zod";
import type {
  TokenUsage,
  FailureReason,
  CheckpointStatus,
} from "../../server/types.js";

/**
 * STATE SYSTEM DESIGN DOCUMENT
 *
 * This is a living document describing the state management system for Tadpole,
 * focusing on enabling rollback, branching, and comprehensive attempt tracking.
 *
 * KEY PRINCIPLES:
 * 1. Every phase execution is an "attempt" with full tracking
 * 2. Attempts form a DAG (directed acyclic graph) via parent relationships
 * 3. State is the single source of truth (not Claude logs)
 * 4. Atomic updates with write-ahead logging for crash recovery
 * 5. Strong typing prevents invalid states
 */

// -------------
// Branded Types for Strong Type Safety
// -------------

declare const __brand: unique symbol;
type Brand<B> = { [__brand]: B };
export type Branded<T, B> = T & Brand<B>;

// Run ID: Unique identifier for a server run (timestamp-random format)
export type RunId = Branded<string, "RunId">;
export const RunId = (id: string): RunId => id as RunId;

// Attempt ID: Unique identifier for a phase execution attempt
export type AttemptId = Branded<string, "AttemptId">;
export const AttemptId = (id: string): AttemptId => id as AttemptId;

// Already defined in branded-types.ts, but re-export for convenience
export type { PhaseId, SessionId } from "../../server/branded-types.js";

// -------------
// HOW BRANCHING WORKS
// -------------

/**
 * BRANCHING CONCEPTS:
 *
 * 1. IMPLICIT BRANCHES: Created automatically when:
 *    - Retrying a failed phase (parentRelation: "retry")
 *    - Rolling back to a previous state (parentRelation: "rollback")
 *    - Explicitly branching for experimentation (parentRelation: "branch")
 *
 * 2. BRANCH IDENTIFICATION:
 *    - Each attempt has a unique ID
 *    - Parent-child relationships form the branch structure
 *    - Git branches in checkpoint system align with attempt branches
 *
 * 3. BRANCH SELECTION:
 *    - Default: Continue from most recent successful attempt
 *    - Explicit: User can specify attemptId to continue from
 *    - Rollback: Restore files from checkpoint, create new attempt
 *
 * EXAMPLE BRANCH STRUCTURE:
 *
 * attempt-1 (phase-1, success)
 *   └── attempt-2 (phase-2, failed)
 *       ├── attempt-3 (phase-2, retry, success)
 *       │   └── attempt-4 (phase-3, success)
 *       └── attempt-5 (phase-2, branch for testing, success)
 *           └── attempt-6 (phase-3, different approach)
 */

// -------------
// HOW ROLLBACKS WORK
// -------------

/**
 * ROLLBACK MECHANISM:
 *
 * 1. STATE ROLLBACK:
 *    - Create new attempt with parentRelation: "rollback"
 *    - Restore cost/token counts to parent state
 *    - Mark intermediate attempts as "abandoned" (future feature)
 *
 * 2. FILE ROLLBACK:
 *    - Use git checkout from checkpoint system
 *    - Restore to commit SHA stored in parent attempt
 *    - Handle workspace setup re-execution if needed
 *
 * 3. CONTEXT ROLLBACK:
 *    - For continuationMode phases, update previousSessionId
 *    - Preserve conversation history up to rollback point
 *    - Allow "forking" conversations from any point
 *
 * ROLLBACK SCENARIOS:
 *
 * a) Simple Rollback:
 *    attempt-1 → attempt-2 (fail) → rollback to attempt-1 → attempt-3
 *
 * b) Cross-Phase Rollback:
 *    phase-1/attempt-1 → phase-2/attempt-2 → phase-3/attempt-3 (fail)
 *    → rollback to phase-1/attempt-1 → phase-2/attempt-4 (different approach)
 *
 * c) Branch Rollback:
 *    Can rollback to any attempt, not just direct ancestors
 */

// -------------
// DATA NORMALIZATION STRATEGY
// -------------

/**
 * NORMALIZED DATA (stored once, referenced by ID):
 * - Phase configurations (stored in config file, referenced by PhaseId)
 * - Workspace setup operations (could be normalized in future)
 *
 * DENORMALIZED DATA (stored per attempt for history):
 * - Costs and token counts (needed for attempt-specific tracking)
 * - Timestamps and durations (unique per attempt)
 * - Checkpoint commit SHAs (different for each attempt)
 * - Failure reasons (specific to each failed attempt)
 *
 * COMPUTED DATA (derived on demand):
 * - Total costs across attempts
 * - Success rates per phase
 * - Branch visualization
 * - Attempt lineage/ancestry
 */

// -------------
// Attempt States - Discriminated Union
// -------------

/**
 * Base properties shared by all attempt states
 */
interface BaseAttemptState {
  /** Unique identifier for this attempt */
  attemptId: AttemptId;

  /** Phase being executed */
  phaseId: string; // Will be PhaseId from branded-types

  /** When this attempt started */
  startTime: string; // ISO 8601

  /** Parent attempt if this is a retry or rollback */
  // TODO: Should this also have the checkpoint hash or information that we're starting from? Would be useful to know to rollback to exactly the fresh state we started with.
  parentAttemptId?: AttemptId;

  /** Type of relationship to parent */
  // TODO: We may not always know this if the user just started a run and said to continue,  or to skip to a phase - does that make sense? How do we represent this?
  parentRelation?: "retry" | "rollback" | "branch";

  /** Claude process PID if available */
  claudePid?: number;

  /** Path to Claude's JSONL log file */
  // TODO: Note: This means that the claude jsonl files should be placed inside a runid based directory so they don't overwrite and conflict.
  claudeLogPath: string;

  // TODO: Shold all runs just have a branch of their own and there's no real concept of main other than what HEAD points to?

  /** Checkpoint information */
  // TODO: Do we need this? We can figure this out from the phase file right?
  checkpoint: {
    /** Git branch name for this attempt */
    branch: string;
    /** Commit SHA after workspace setup */
    workspaceSetup?: string;
    /** Tracked file patterns */
    patterns: string[];
  };
}

/**
 * Attempt that is initializing (process started but no session ID yet)
 */
export interface InitializingAttemptState extends BaseAttemptState {
  status: "initializing";
}

/**
 * Attempt that is actively running
 */
// TODO: Does this mean that claude has been started? If this is central state, do we need an intermediate that actually allows for the process id to be logged for cleanup things?
export interface RunningAttemptState extends BaseAttemptState {
  status: "running";

  /** Claude's session ID (available after init message) */
  sessionId: string; // Will be SessionId from branded-types

  // TODO: Previous session id from what? Is this for an attempt or for a phase?
  /** Previous session ID if continuing */
  previousSessionId?: string;

  /** Current cost accumulation */
  currentCost: number;

  /** Current token usage */
  currentTokens: TokenUsage;
}

/**
 * Successfully completed attempt
 */
export interface CompletedAttemptState extends BaseAttemptState {
  status: "completed";

  /** When attempt completed */
  endTime: string; // ISO 8601

  /** Duration in milliseconds */
  duration: number;

  /** Claude's session ID */
  sessionId: string;

  /** Previous session ID if continued */
  previousSessionId?: string;

  /** Final cost for this attempt */
  cost: number;

  /** Final token usage */
  tokens: TokenUsage;

  /** Whether we received the result message */
  resultMessageReceived: boolean;

  /** Exit code (always 0 for success) */
  exitCode: 0;

  checkpoint: BaseAttemptState["checkpoint"] & {
    /** Commit SHA on completion */
    completed: string;
  };
}

/**
 * Failed attempt
 */
export interface FailedAttemptState extends BaseAttemptState {
  status: "failed";

  /** When attempt failed */
  endTime: string;

  /** Duration before failure */
  duration: number;

  /** Claude's session ID if available */
  sessionId?: string;

  /** Partial cost before failure */
  cost: number;

  /** Partial token usage */
  tokens: TokenUsage;

  /** Exit code (non-zero) */
  exitCode: number;

  /** Structured failure information */
  failureReason: FailureReason;

  checkpoint: BaseAttemptState["checkpoint"] & {
    /** Error commit SHA if created */
    // TODO: This should always be created haha
    error?: string;
  };
}

/**
 * Skipped attempt
 */
export interface SkippedAttemptState extends BaseAttemptState {
  status: "skipped";

  /** When skip was initiated */
  endTime: string;

  /** Time from start to skip */
  duration: number;

  /** Claude's session ID if available */
  sessionId?: string;

  /** Always 0 for skipped */
  cost: 0;

  /** No tokens used */
  tokens: TokenUsage;

  checkpoint: BaseAttemptState["checkpoint"] & {
    /** Skip commit SHA if any files were tracked */
    skipped?: string;
  };
}

/**
 * Crashed attempt (detected on recovery)
 */
export interface CrashedAttemptState extends BaseAttemptState {
  status: "crashed";

  /** When crash was detected */
  detectedAt: string;

  /** Last known state before crash */
  lastKnownState: "initializing" | "running";

  /** Partial cost if available */
  cost?: number;

  /** Partial tokens if available */
  tokens?: TokenUsage;
}

/**
 * Union of all possible attempt states
 */
export type AttemptState =
  | InitializingAttemptState
  | RunningAttemptState
  | CompletedAttemptState
  | FailedAttemptState
  | SkippedAttemptState
  | CrashedAttemptState;

// -------------
// Run State - Root State Object
// -------------

/**
 * Complete state for a Tadpole server run
 *
 * STATE MANAGEMENT STRATEGY:
 *
 * 1. PERSISTENCE:
 *    - Stored in: .tadpole/runs/{runId}/state.json
 *    - Write pattern: Atomic write-rename
 *    - Backup: Previous state kept as state.json.bak
 *
 * 2. UPDATES:
 *    - Critical: Immediate write (phase transitions)
 *    - Batched: Periodic write (token updates)
 *    - Async: Eventually consistent (git operations)
 *
 * 3. RECOVERY:
 *    - On startup: Load state.json
 *    - If corrupted: Try state.json.bak
 *    - If missing: Rebuild from WAL
 *    - If WAL corrupted: Start fresh (data loss)
 */
export interface RunState {
  /** Schema version for migrations */
  version: 1;

  /** Unique identifier for this run */
  runId: RunId;

  /** Absolute project path (needed for recovery) */
  projectPath: string;

  /** Path to configuration file */
  configPath: string;

  /** Hash of configuration for change detection */
  configHash: string;

  /** Server version that created this state */
  serverVersion: string;

  /** When this run started */
  startTime: string; // ISO 8601

  /** When this run ended (if applicable) */
  endTime?: string;

  /** Custom Anthropic base URL if configured */
  anthropicBaseUrl?: string;

  /** Server process PID */
  serverPid: number;

  /** Current status of the run */
  status: "running" | "completed" | "error" | "shutdown";

  /** Currently executing attempt */
  currentAttemptId: AttemptId | null;

  /** All attempts in this run */
  attempts: Record<AttemptId, AttemptState>;

  /** Execution statistics */
  stats: {
    /** Total cost across all attempts */
    totalCost: number;

    /** Total tokens used */
    totalTokens: TokenUsage;

    /** Number of attempts per phase */
    attemptCounts: Record<string, number>;

    /** Success rate per phase */
    successRates: Record<string, number>;
  };
}

// -------------
// EXAMPLE STATE SCENARIOS
// -------------

/**
 * SCENARIO 1: Simple Linear Execution
 *
 * Run starts → Phase 1 attempt succeeds → Phase 2 attempt succeeds → Complete
 *
 * State evolution:
 * - attempts: { "att-1": {...}, "att-2": {...} }
 * - No parent relationships
 * - Linear git history in checkpoints
 *
 * SCENARIO 2: Retry After Failure
 *
 * Phase 1 succeeds → Phase 2 fails → Retry Phase 2 → Success → Phase 3
 *
 * State structure:
 * - attempts: {
 *     "att-1": { status: "completed", ... },
 *     "att-2": { status: "failed", failureReason: { type: "timeout" } },
 *     "att-3": { status: "completed", parentAttemptId: "att-2", parentRelation: "retry" },
 *     "att-4": { status: "completed", ... }
 *   }
 *
 * SCENARIO 3: Rollback and Branch
 *
 * Phase 1 → Phase 2 → Phase 3 fails → Rollback to Phase 1 → Different Phase 2
 *
 * State structure:
 * - attempts: {
 *     "att-1": { status: "completed" },
 *     "att-2": { status: "completed" },
 *     "att-3": { status: "failed" },
 *     "att-4": { status: "completed", parentAttemptId: "att-1", parentRelation: "rollback" },
 *     "att-5": { status: "running", ... }
 *   }
 *
 * Git branches:
 * - main: att-1 → att-2 → att-3
 * - rollback/att-4: branches from att-1 commit
 */

// -------------
// Write-Ahead Log Events
// -------------

/**
 * WAL DESIGN:
 *
 * Purpose: Crash recovery and audit trail
 * Location: .tadpole/runs/{runId}/wal.jsonl
 *
 * Write Pattern:
 * 1. Append event to WAL
 * 2. Apply change to in-memory state
 * 3. Periodically snapshot to state.json
 * 4. Truncate WAL after successful snapshot
 *
 * Recovery Pattern:
 * 1. Load last state.json
 * 2. Replay WAL events from last snapshot
 * 3. Rebuild complete state
 * 4. Write new snapshot
 */

/**
 * Base event for write-ahead log
 */
interface BaseWALEvent {
  /** Event ID for deduplication */
  eventId: string;

  /** When event occurred */
  timestamp: string;

  /** Monotonic counter for ordering */
  sequence: number;
}

/**
 * WAL event types for state changes
 */
export type WALEvent =
  | (BaseWALEvent & {
      type: "RunStarted";
      data: {
        runId: RunId;
        projectPath: string;
        configPath: string;
        configHash: string;
      };
    })
  | (BaseWALEvent & {
      type: "AttemptStarted";
      data: {
        attemptId: AttemptId;
        phaseId: string;
        parentAttemptId?: AttemptId;
        parentRelation?: "retry" | "rollback" | "branch";
      };
    })
  | (BaseWALEvent & {
      type: "AttemptTransitioned";
      data: {
        attemptId: AttemptId;
        fromStatus: AttemptState["status"];
        toStatus: AttemptState["status"];
        sessionId?: string;
      };
    })
  | (BaseWALEvent & {
      type: "TokensUpdated";
      data: {
        attemptId: AttemptId;
        tokens: TokenUsage;
        cost: number;
      };
    })
  | (BaseWALEvent & {
      type: "CheckpointCreated";
      data: {
        attemptId: AttemptId;
        type: CheckpointStatus;
        commitSha: string;
        branch: string;
      };
    })
  | (BaseWALEvent & {
      type: "AttemptCompleted";
      data: {
        attemptId: AttemptId;
        success: boolean;
        exitCode: number;
        cost: number;
        duration: number;
        failureReason?: FailureReason;
      };
    });

// -------------
// FUTURE CONSIDERATIONS
// -------------

/**
 * POTENTIAL ENHANCEMENTS:
 *
 * 1. ATTEMPT RELATIONSHIPS:
 *    - Add "supersedes" relationship for replacements
 *    - Add "conflicts-with" for incompatible branches
 *    - Track merge points for converging branches
 *
 * 2. STATE QUERIES:
 *    - Get attempt ancestry (all parents up to root)
 *    - Find common ancestor of two attempts
 *    - List all heads (attempts with no children)
 *    - Calculate branch divergence metrics
 *
 * 3. ADVANCED FEATURES:
 *    - Attempt tagging/labeling
 *    - Bookmark favorite attempts
 *    - Compare attempts side-by-side
 *    - Visualize execution tree
 *
 * 4. OPTIMIZATION:
 *    - State sharding for large histories
 *    - Compressed state archives
 *    - Incremental state transfer
 *    - State pruning policies
 */

// -------------
// Zod Schemas for Runtime Validation
// -------------

// Token usage schema
const tokenUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheCreationTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
});

// Failure reason schema
const failureReasonSchema = z.object({
  type: z.enum(["timeout", "rate-limit", "api-error", "unknown"]),
  retriable: z.boolean(),
  message: z.string().optional(),
});

// Base attempt state schema
const baseAttemptStateSchema = z.object({
  attemptId: z.string(),
  phaseId: z.string(),
  startTime: z.string().datetime(),
  parentAttemptId: z.string().optional(),
  parentRelation: z.enum(["retry", "rollback", "branch"]).optional(),
  claudePid: z.number().int().positive().optional(),
  claudeLogPath: z.string(),
  checkpoint: z.object({
    branch: z.string(),
    workspaceSetup: z.string().optional(),
    patterns: z.array(z.string()),
  }),
});

// Discriminated union for attempt states
export const attemptStateSchema = z.discriminatedUnion("status", [
  baseAttemptStateSchema.extend({
    status: z.literal("initializing"),
  }),
  baseAttemptStateSchema.extend({
    status: z.literal("running"),
    sessionId: z.string(),
    previousSessionId: z.string().optional(),
    currentCost: z.number().nonnegative(),
    currentTokens: tokenUsageSchema,
  }),
  baseAttemptStateSchema.extend({
    status: z.literal("completed"),
    endTime: z.string().datetime(),
    duration: z.number().positive(),
    sessionId: z.string(),
    previousSessionId: z.string().optional(),
    cost: z.number().nonnegative(),
    tokens: tokenUsageSchema,
    resultMessageReceived: z.boolean(),
    exitCode: z.literal(0),
    checkpoint: baseAttemptStateSchema.shape.checkpoint.extend({
      completed: z.string(),
    }),
  }),
  baseAttemptStateSchema.extend({
    status: z.literal("failed"),
    endTime: z.string().datetime(),
    duration: z.number().nonnegative(),
    sessionId: z.string().optional(),
    cost: z.number().nonnegative(),
    tokens: tokenUsageSchema,
    exitCode: z.number().int(),
    failureReason: failureReasonSchema,
    checkpoint: baseAttemptStateSchema.shape.checkpoint.extend({
      error: z.string().optional(),
    }),
  }),
  baseAttemptStateSchema.extend({
    status: z.literal("skipped"),
    endTime: z.string().datetime(),
    duration: z.number().nonnegative(),
    sessionId: z.string().optional(),
    cost: z.literal(0),
    tokens: tokenUsageSchema,
    checkpoint: baseAttemptStateSchema.shape.checkpoint.extend({
      skipped: z.string().optional(),
    }),
  }),
  baseAttemptStateSchema.extend({
    status: z.literal("crashed"),
    detectedAt: z.string().datetime(),
    lastKnownState: z.enum(["initializing", "running"]),
    cost: z.number().nonnegative().optional(),
    tokens: tokenUsageSchema.optional(),
  }),
]);

// Run state schema
export const runStateSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  projectPath: z.string(),
  configPath: z.string(),
  configHash: z.string(),
  serverVersion: z.string(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().optional(),
  anthropicBaseUrl: z.string().url().optional(),
  serverPid: z.number().int().positive(),
  status: z.enum(["running", "completed", "error", "shutdown"]),
  currentAttemptId: z.string().nullable(),
  attempts: z.record(z.string(), attemptStateSchema),
  stats: z.object({
    totalCost: z.number().nonnegative(),
    totalTokens: tokenUsageSchema,
    attemptCounts: z.record(z.string(), z.number().int().nonnegative()),
    successRates: z.record(z.string(), z.number().min(0).max(1)),
  }),
});

// WAL event schemas
const baseWALEventSchema = z.object({
  eventId: z.string(),
  timestamp: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
});

export const walEventSchema = z.discriminatedUnion("type", [
  baseWALEventSchema.extend({
    type: z.literal("RunStarted"),
    data: z.object({
      runId: z.string(),
      projectPath: z.string(),
      configPath: z.string(),
      configHash: z.string(),
    }),
  }),
  baseWALEventSchema.extend({
    type: z.literal("AttemptStarted"),
    data: z.object({
      attemptId: z.string(),
      phaseId: z.string(),
      parentAttemptId: z.string().optional(),
      parentRelation: z.enum(["retry", "rollback", "branch"]).optional(),
    }),
  }),
  baseWALEventSchema.extend({
    type: z.literal("AttemptTransitioned"),
    data: z.object({
      attemptId: z.string(),
      fromStatus: z.enum([
        "initializing",
        "running",
        "completed",
        "failed",
        "skipped",
        "crashed",
      ]),
      toStatus: z.enum([
        "initializing",
        "running",
        "completed",
        "failed",
        "skipped",
        "crashed",
      ]),
      sessionId: z.string().optional(),
    }),
  }),
  baseWALEventSchema.extend({
    type: z.literal("TokensUpdated"),
    data: z.object({
      attemptId: z.string(),
      tokens: tokenUsageSchema,
      cost: z.number().nonnegative(),
    }),
  }),
  baseWALEventSchema.extend({
    type: z.literal("CheckpointCreated"),
    data: z.object({
      attemptId: z.string(),
      type: z.enum([
        "workspace-setup",
        "completed",
        "error",
        "exit",
        "skipped",
      ]),
      commitSha: z.string(),
      branch: z.string(),
    }),
  }),
  baseWALEventSchema.extend({
    type: z.literal("AttemptCompleted"),
    data: z.object({
      attemptId: z.string(),
      success: z.boolean(),
      exitCode: z.number().int(),
      cost: z.number().nonnegative(),
      duration: z.number().nonnegative(),
      failureReason: failureReasonSchema.optional(),
    }),
  }),
]);

// -------------
// Type Guards
// -------------

export function isInitializingAttempt(
  state: AttemptState
): state is InitializingAttemptState {
  return state.status === "initializing";
}

export function isRunningAttempt(
  state: AttemptState
): state is RunningAttemptState {
  return state.status === "running";
}

export function isCompletedAttempt(
  state: AttemptState
): state is CompletedAttemptState {
  return state.status === "completed";
}

export function isFailedAttempt(
  state: AttemptState
): state is FailedAttemptState {
  return state.status === "failed";
}

export function isSkippedAttempt(
  state: AttemptState
): state is SkippedAttemptState {
  return state.status === "skipped";
}

export function isCrashedAttempt(
  state: AttemptState
): state is CrashedAttemptState {
  return state.status === "crashed";
}

export function isTerminalAttempt(state: AttemptState): boolean {
  return ["completed", "failed", "skipped", "crashed"].includes(state.status);
}

// -------------
// Utility Types
// -------------

/**
 * Extract attempt states by status
 */
export type AttemptByStatus<S extends AttemptState["status"]> = Extract<
  AttemptState,
  { status: S }
>;

/**
 * State transition validation
 */
export type ValidTransitions = {
  initializing: ["running", "failed", "skipped"];
  running: ["completed", "failed", "skipped"];
  completed: never;
  failed: never;
  skipped: never;
  crashed: never;
};

/**
 * Helper type to ensure exhaustive handling
 */
export type Exhaustive<T> = T extends never ? true : false;
