import type { z } from "zod";
import type { PhaseId } from "./branded-types.js";
import type { logMessageSchema } from "./claude-session-schema.js";

// ============================================================================
// Model Types
// ============================================================================

export type ModelName = "sonnet" | "opus";

export type ContinuationMode = "fresh" | "continue-previous";

// ============================================================================
// Process Exit Types (moved to schemas)
// ============================================================================
// ProcessExit is now defined in server/schemas/event-schemas.ts

// ============================================================================
// Failure Reason Types (moved to schemas)
// ============================================================================
// FailureReason is now defined in server/schemas/event-schemas.ts

// ============================================================================
// Message ID Types
// ============================================================================

export type ClaudeMessageId = `msg_${string}`;
export type UUIDMessageId = string; // Keep flexible for UUIDs
export type MessageId = ClaudeMessageId | UUIDMessageId;

// ============================================================================
// Checkpoint Status Types
// ============================================================================

export const CHECKPOINT_STATUS = {
  WORKSPACE_SETUP: "workspace-setup",
  COMPLETED: "completed",
  ERROR: "error",
  EXIT: "exit",
  SKIPPED: "skipped",
} as const;

export type CheckpointStatus = (typeof CHECKPOINT_STATUS)[keyof typeof CHECKPOINT_STATUS];

// ============================================================================
// Server Configuration
// ============================================================================

type ShellCommandWorkingDirectory = "project";
type WorkspaceShellCommandWorkingDirectory = ShellCommandWorkingDirectory | "lastCopied";

export type ShellCommand = {
  /** Type of setup operation */
  type: "command";
  /** For command operations */
  command: {
    /** Shell command to execute */
    run: string;
    /** Working directory for command execution (default: "project") */
    workingDirectory: ShellCommandWorkingDirectory;
  };
};

export type WorkspaceShellCommand = {
  /** Type of setup operation */
  type: "command";
  /** For command operations */
  command: {
    /** Shell command to execute */
    run: string;
    /** Working directory for command execution (default: "project") */
    workingDirectory: WorkspaceShellCommandWorkingDirectory;
  };
};

/**
 * Workspace setup operation - either copy files/directories or run commands.
 */
export type WorkspaceSetupItem =
  | {
      /** Type of setup operation */
      type: "copy";
      /** For copy operations */
      copy: {
        /** Source path (relative to config file or absolute) */
        from: string;
        /**
         * Target path relative to projectPath (parent directory must exist).
         * Always specifies the full target path including name.
         * Examples:
         * - from: "../templates/foo", to: "src/foo" → copies directory foo to src/foo
         * - from: "../templates/foo", to: "src/bar" → copies directory foo as src/bar
         * - from: "../config.json", to: "src/config.json" → copies file
         * - from: "../config.json", to: "src/settings.json" → copies file with rename
         */
        to: string;
      };
    }
  | WorkspaceShellCommand;

/**
 * Configuration for a single phase in the Tadpole workflow.
 * A phase represents a discrete task for Claude to perform, with its own
 * prompt, model settings, and optional file watching.
 */
export interface PhaseConfig {
  /** Unique identifier for this phase (e.g., "phase-1", "data-analysis") */
  id: PhaseId;

  /** Human-readable name displayed in UI and logs */
  name: string;

  /** Path to a file containing the prompt (mutually exclusive with promptText) */
  promptFile?: string | string[];

  /** Inline prompt text (mutually exclusive with promptFile) */
  promptText?: string;

  /** Path to a file containing system prompt to append (mutually exclusive with appendSystemPromptText) */
  appendSystemPromptFile?: string | string[];

  /** Inline system prompt text to append (mutually exclusive with appendSystemPromptFile) */
  appendSystemPromptText?: string;

  /** Claude model to use (e.g., "claude-3-opus-20240229", "sonnet") */
  model: ModelName;

  /**
   * How this phase should handle continuation from previous phases.
   * - "fresh": Start a new session (default for most cases)
   * - "continue-previous": Continue from the previous phase's session,
   *   maintaining context and conversation history. The previous phase must
   *   have completed successfully.
   */
  continuationMode: ContinuationMode;

  /**
   * Workspace setup operations to run before phase starts.
   * Each operation must complete successfully for phase to start.
   */
  workspaceSetup?: WorkspaceSetupItem[];

  /** Optional description shown to users about what this phase does */
  description?: string;

  /**
   * Glob patterns for files to track during phase execution.
   * These files will be:
   * - Watched for changes and streamed to the client
   * - Tracked in the git-based checkpoint system
   * - Resolved using gitignore rules for consistency
   */
  trackedFiles?: string[];

  /** Optional environment variables to set for the Claude process */
  env?: Record<string, string>;

  /** Optional output files to copy after phase completion */
  output?: {
    copy: string[];
    beforeCopy?: ShellCommand[];
  };
}

/**
 * Information for creating a checkpoint commit in the shadow git repository.
 *
 * The checkpoint system creates a shadow git repo in `.tadpole/checkpoints/` that tracks
 * files matching the `checkpointAndWatch` patterns. Each checkpoint creates a commit
 * with detailed metadata about the phase state.
 */
export interface CheckpointInfo {
  /** The type of checkpoint being created */
  status: CheckpointStatus;

  /** Unique identifier of the phase (e.g., "phase-1") */
  phaseId: PhaseId;

  /** Human-readable name of the phase */
  phaseName: string;

  /** Unique identifier for this Tadpole server run */
  runId: string;

  /** ISO timestamp when the checkpoint was created */
  timestamp: string;

  /** Duration in milliseconds (only for completed/error/skipped phases) */
  duration?: number;
}

/**
 * Main server configuration containing all runtime settings.
 * Most values have defaults in config.ts except execution paths and phases.
 */
export interface ServerConfig {
  /** WebSocket server port (default: 7777) */
  port: number;

  /** Server version for client compatibility checks */
  version: string;

  /** Path to lock file preventing multiple server instances */
  lockFile: string;

  /** Path to WebSocket traffic log file */
  socketLogFile: string;

  /** Path to general server log file */
  serverLogFile: string;

  /** Current working directory for the server process */
  cwd: string;

  /** Output directory for generated files. Will be scoped to cwd */
  outputDirectory: string;

  // Execution paths (from ExecutionSetup)
  /** Original data location (for reference only) */
  readOnlySourceDataPath: string;
  /** Primary directory where everything runs */
  executionPath: string;
  /** executionPath + '/data' - ONLY for setup */
  dataPathInExecutionDir: string;
  /** Hash of the data directory structure */
  dataHash: string;
  /** Whether this is a new execution */
  isNewExecution: boolean;
  /** Whether we're resuming an existing execution */
  isResuming: boolean;
  /** How data is linked (symlink or copy) */
  linkType: "symlink" | "copy";

  /** Array of phase configurations to execute */
  phases: PhaseConfig[];

  /**
   * Token cost configuration per million tokens.
   * Used to calculate costs for each phase and total project cost.
   */
  costsPerMTok: {
    /** Cost per million input tokens */
    input: number;
    /** Cost per million tokens when creating cache */
    inputCache: number;
    /** Cost per million tokens when reading from cache */
    cacheRead: number;
    /** Cost per million output tokens */
    output: number;
  };

  /** Interval in milliseconds for parsing Claude log files (default: 1000) */
  logParsingInterval: number;

  /** Optional custom base URL for Anthropic API (e.g., for proxies or gateways) */
  anthropicBaseURL?: string;

  /** Whether to automatically start phases (default: true) */
  autostart: boolean;

  /** Time limit for hashing directories in milliseconds (default: 5000) */
  dataHashTimeLimit: number;

  /** Maximum length for tool result content before truncation (default: 2500) */
  toolResultTruncateLength: number;

  /** Optional model override for all phases (ignores per-phase model settings) */
  modelOverride?: ModelName;

  /** Whether to disable the proxy server (default: false) */
  withoutProxy: boolean;
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Token usage tracking for Claude API calls.
 * Used to calculate costs and monitor usage across phases.
 */
export interface TokenUsage {
  /** Standard input tokens processed */
  inputTokens: number;
  /** Generated output tokens */
  outputTokens: number;
  /** Tokens used to create prompt cache */
  cacheCreationTokens: number;
  /** Tokens read from existing cache */
  cacheReadTokens: number;
}

// ============================================================================
// Synthetic Message Types
// ============================================================================

/**
 * Synthetic timeout message structure.
 * Claude sends these special messages when API requests time out.
 * They have a specific structure that needs special handling.
 */
export interface SyntheticTimeoutMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: "<synthetic>";
    content: "API Error: Request timed out.";
    usage?: never;
    stop_reason: null;
    stop_sequence: null;
  };
}

/**
 * Type guard to check if an assistant message is a synthetic timeout.
 * These messages need special handling as they indicate API failures.
 */
export function isSyntheticTimeout(msg: ClaudeLogMessage): msg is SyntheticTimeoutMessage {
  return (
    msg.type === "assistant" &&
    msg.message.model === "<synthetic>" &&
    msg.message.content === "API Error: Request timed out."
  );
}

// ============================================================================
// Claude Log Types (from claude-session-schema)
// ============================================================================

export type ClaudeLogMessage = z.infer<typeof logMessageSchema>;

// ============================================================================
// Re-export types from schemas for backward compatibility
// ============================================================================

export type {
  AssistantActionEvent,
  CheckpointListEvent,
  // Data types used in events
  CheckpointQueryInfo,
  ErrorEvent,
  FailureReason,
  FileNode,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  IncompletePhaseEvent,
  InfoEvent,
  PhaseCompletedEvent,
  PhaseExecution,
  PhaseStartedEvent,
  ProcessExit,
  RollbackCompletedEvent,
  RollbackPhaseCheckpointEvent,
  RollbackProgressEvent,
  RollbackStartedEvent,
  RollbackWorkspaceCleanupEvent,
  ServerEvent,
  ServerIdleEvent,
  // Event types
  ServerReadyEvent,
  StateSnapshotEvent,
  TokenUsageEvent,
  ToolResultEvent,
} from "../schemas/event-schemas.js";

// ============================================================================
// Client -> Server Commands (keeping these here for now)
// ============================================================================

/**
 * Start a specific phase by ID.
 * Can optionally skip pre-start commands for retry scenarios.
 */
export interface StartPhaseCommand {
  /** Unique ID for this command (for request/response correlation) */
  id: string;
  type: "phase.start";
  data: {
    /** ID of the phase to start */
    phaseId: string;
    /** If true, skip the phase's preStart command */
    skipPreCommands?: boolean;
  };
}

/**
 * Start the next phase in sequence.
 * Determines next phase based on completion history.
 */
export interface NextPhaseCommand {
  id: string;
  type: "phase.next";
}

/**
 * Skip the currently running phase.
 * Terminates the Claude process and marks phase as skipped.
 */
export interface SkipPhaseCommand {
  id: string;
  type: "phase.skip";
}

/**
 * Re-run the last completed phase.
 * Useful for retrying failed phases or regenerating outputs.
 */
export interface RedoPhaseCommand {
  id: string;
  type: "phase.redo";
}

/**
 * Gracefully shutdown the server.
 * Cleans up all resources and removes lock file.
 */
export interface ShutdownCommand {
  id: string;
  type: "server.shutdown";
}

/**
 * Force stop the current running phase.
 */
export interface ForceStopCommand {
  id: string;
  type: "phase.forceStop";
  data?: {
    /** Optional reason for force stopping */
    reason?: string;
  };
}

/**
 * List available checkpoints.
 */
export interface ListCheckpointsCommand {
  id: string;
  type: "checkpoint.list";
  data?: {
    /** Optional run ID to list checkpoints for */
    runId?: string;
  };
}

/**
 * Rollback to a specific checkpoint.
 */
export interface RollbackToCheckpointCommand {
  id: string;
  type: "rollback.toCheckpoint";
  data: {
    /** Checkpoint SHA (can be partial) */
    checkpointSha: string;
    /** Whether to auto-restart after rollback */
    autoRestart?: boolean;
  };
}

/**
 * Rollback to a phase with specific checkpoint type.
 */
export interface RollbackToPhaseCommand {
  id: string;
  type: "rollback.toPhase";
  data: {
    /** Phase ID to rollback to */
    phaseId: string;
    /** Checkpoint type within that phase */
    checkpointType: "start" | "end" | "workspace-setup" | "completed" | "error" | "skipped";
    /** Whether to auto-restart after rollback */
    autoRestart?: boolean;
  };
}

/**
 * Rollback to last successful phase.
 */
export interface RollbackToLastSuccessCommand {
  id: string;
  type: "rollback.toLastSuccess";
  data?: {
    /** Whether to auto-restart after rollback */
    autoRestart?: boolean;
  };
}

/**
 * Discriminated union of all client-to-server command types.
 * Use this instead of generic command interfaces for better type safety.
 * TypeScript will automatically narrow the type based on the `type` field.
 */
export type ClientCommand =
  | StartPhaseCommand
  | NextPhaseCommand
  | SkipPhaseCommand
  | RedoPhaseCommand
  | ShutdownCommand
  | ForceStopCommand
  | ListCheckpointsCommand
  | RollbackToCheckpointCommand
  | RollbackToPhaseCommand
  | RollbackToLastSuccessCommand;
