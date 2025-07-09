import type { z } from "zod";
import type { logMessageSchema } from "../types/claude-session-schema.js";
import type { ErrorSeverity } from "./error-types.js";

// ============================================================================
// Model Types
// ============================================================================

export type ModelName = "sonnet" | "opus";

// ============================================================================
// Process Exit Types
// ============================================================================

export type ProcessExit =
  | { type: "success" }
  | { type: "error"; code: number }
  | { type: "killed"; signal: NodeJS.Signals };

// ============================================================================
// Continuation Mode Types
// ============================================================================

export type ContinuationMode = "fresh" | "continue-previous";

// ============================================================================
// Message ID Types
// ============================================================================

export type ClaudeMessageId = `msg_${string}`;
export type UUIDMessageId = string; // Keep flexible for UUIDs

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

/**
 * Workspace setup operation - either copy files/directories or run commands.
 */
export interface WorkspaceSetupItem {
  /** Type of setup operation */
  type: "copy" | "command";

  /** For copy operations */
  copy?: {
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

  /** For command operations */
  command?: {
    /** Shell command to execute */
    run: string;
    /** Working directory for command execution (default: "project") */
    workingDirectory?: "project" | "lastCopied";
  };
}

/**
 * Configuration for a single phase in the Langton workflow.
 * A phase represents a discrete task for Claude to perform, with its own
 * prompt, model settings, and optional file watching.
 */
export interface PhaseConfig {
  /** Unique identifier for this phase (e.g., "phase-1", "data-analysis") */
  id: string;

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
   * If true, this phase will continue from the previous phase's session,
   * maintaining context and conversation history. The previous phase must
   * have completed successfully.
   */
  continueFromPrevious?: boolean;

  /**
   * Workspace setup operations to run before phase starts.
   * Each operation must complete successfully for phase to start.
   */
  workspaceSetup?: WorkspaceSetupItem[];

  /**
   * Glob pattern for files to watch during phase execution.
   * Changes to matching files will be streamed to the client.
   */
  watch?: string;

  /** Optional description shown to users about what this phase does */
  description?: string;

  /** Glob patterns to track for checkpointing and watching (files and directories) */
  checkpointAndWatch?: string[];
}

/**
 * Information for creating a checkpoint commit in the shadow git repository.
 *
 * The checkpoint system creates a shadow git repo in `.langton/checkpoints/` that tracks
 * files matching the `checkpointAndWatch` patterns. Each checkpoint creates a commit
 * with detailed metadata about the phase state.
 */
export interface CheckpointInfo {
  /** The type of checkpoint being created */
  status: CheckpointStatus;

  /** Unique identifier of the phase (e.g., "phase-1") */
  phaseId: string;

  /** Human-readable name of the phase */
  phaseName: string;

  /** Unique identifier for this Langton server run */
  runId: string;

  /** ISO timestamp when the checkpoint was created */
  timestamp: string;

  /** Duration in milliseconds (only for completed/error/skipped phases) */
  duration?: number;
}

/**
 * Main server configuration containing all runtime settings.
 * Most values have defaults in config.ts except projectPath and phases.
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

  /** Absolute path to the project directory where Claude will run */
  projectPath: string;

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

/**
 * Runtime state of an active phase.
 * Tracks the Claude process, costs, and monitoring infrastructure.
 */
export interface PhaseState {
  /** The phase configuration being executed */
  phase: PhaseConfig;
  /** Internal execution ID for tracking (timestamp-random format) */
  phaseExecutionId: string;
  /** Claude session ID for this phase instance (starts as undefined, set on init) */
  sessionId: string | undefined;
  /** Previous claude session ID if continuing from another phase */
  previousSessionId: string | undefined;
  /** Whether the phase is currently executing */
  isRunning: boolean;
  /** When this phase started */
  startTime: Date;
  /** Accumulated cost for this phase in dollars */
  phaseCost: number;
  /** Token usage breakdown for this phase */
  phaseTokens: TokenUsage;
}

/**
 * Record of a phase that has finished execution.
 * Used for state persistence and cost tracking.
 */
export interface CompletedPhase {
  /** ID of the phase that was completed */
  phaseId: string;
  /** Claude session ID used */
  sessionId: string;
  /** Whether the phase completed successfully */
  success: boolean;
  /** Total cost in dollars */
  cost: number;
  /** Execution time in milliseconds */
  duration: number;
  /** When the phase completed */
  completedAt: Date;
}

/**
 * Represents a file or directory in the watched file tree.
 * Used to send file structure updates to clients.
 */
export interface FileNode {
  /** File or directory name */
  name: string;
  /** Relative path from project root */
  path: string;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** Last modified time (ISO string) for files */
  lastModified?: string;
  /** Child nodes if this is a directory */
  children?: FileNode[];
}

// ============================================================================
// Server -> Client Events
// ============================================================================

/**
 * Base interface for all server-to-client events.
 * Events are sent over WebSocket to inform clients of server state changes.
 */
export interface ServerEvent {
  /** Unique ID for this event instance */
  id: string;
  /** ISO 8601 timestamp of when the event was created */
  timestamp: string;
  /** Event type identifier for client-side routing */
  type: string;
}

/**
 * Sent immediately after client connection to indicate server is ready.
 * Contains basic server information for client compatibility checks.
 */
export interface ServerReadyEvent extends ServerEvent {
  type: "server.ready";
  data: {
    /** Server version for compatibility checking */
    serverVersion: string;
    /** Absolute path where Claude will execute */
    projectPath: string;
  };
}

/**
 * Comprehensive state snapshot sent after connection and on major state changes.
 * Allows clients to sync with server state after connection or reconnection.
 */
export interface StateSnapshotEvent extends ServerEvent {
  type: "state.snapshot";
  data: {
    /** Currently executing phase, undefined if idle */
    currentPhase: PhaseState | undefined;
    /** List of all completed phases in this session */
    completedPhases: CompletedPhase[];
    /** Current file tree structure (if watching files) */
    fileTree: FileNode[];
    /** Total accumulated cost across all phases in dollars */
    totalCost: number;
    /** Total time since server start in milliseconds */
    totalTime: number;
    /** Most recently accessed file information */
    recentFileAccess?:
      | {
          path: string;
          content: string;
          timestamp: Date;
        }
      | undefined;
  };
}

/**
 * Emitted when a phase begins execution.
 * Indicates Claude process has been spawned and prompt has been sent.
 */
export interface PhaseStartedEvent extends ServerEvent {
  type: "phase.started";
  data: {
    /** ID of the phase that started */
    phaseId: string;
    /** Human-readable phase name */
    phaseName: string;
    /** Optional phase description */
    phaseDescription?: string;
    /** Claude session ID for this execution */
    sessionId: string;
    /** Previous session ID if continuing from another phase */
    previousSessionId?: string;
    /** ISO 8601 timestamp of phase start */
    startTime: string;
  };
}

/**
 * Emitted when a phase finishes execution.
 * Includes success status, costs, and timing information.
 */
export interface PhaseCompletedEvent extends ServerEvent {
  type: "phase.completed";
  data: {
    /** ID of the completed phase */
    phaseId: string;
    /** Whether the phase completed successfully */
    success: boolean;
    /** Total cost for this phase in dollars */
    cost: number;
    /** Execution time in milliseconds */
    duration: number;
    /** Process exit code (0 = success, undefined = killed) */
    exitCode: number | undefined;
  };
}

/**
 * Real-time stream of Claude's actions during phase execution.
 * Parsed from Claude's JSON log output.
 */
export interface AssistantActionEvent extends ServerEvent {
  type: "assistant.action";
  data: {
    /** Phase this action belongs to */
    phaseId: string;
    /** Type of action Claude is performing */
    action: "thinking" | "message" | "tool_use";
    /** Content of the action (text for messages, empty for tool use) */
    content: string;
    /** Name of tool being used (only for tool_use actions) */
    toolName?: string; // Allow any tool name, not just known ones
    /** Tool parameters (only for tool_use actions) */
    toolInput?: Record<string, unknown>;
  };
}

/**
 * Token usage update for cost tracking.
 * Emitted after each Claude message with usage information.
 */
export interface TokenUsageEvent extends ServerEvent {
  type: "token.usage";
  data: {
    /** Phase that consumed these tokens */
    phaseId: string;
    /** Number of input tokens processed */
    inputTokens: number;
    /** Number of output tokens generated */
    outputTokens: number;
    /** Tokens used to create cache */
    cacheCreationTokens: number;
    /** Tokens read from cache */
    cacheReadTokens: number;
    /** Cost for this specific message in dollars */
    totalCost: number;
  };
}

/**
 * File change notification for watched files.
 * Only emitted for files matching the phase's watch pattern.
 */
export interface FileUpdatedEvent extends ServerEvent {
  type: "file.updated";
  data: {
    /** Relative path from project root */
    path: string;
    /** Just the filename */
    filename: string;
    /** File contents (empty for deletions) */
    content: string;
    /** Type of file system change */
    action: "created" | "modified" | "deleted";
  };
}

/**
 * Complete file tree structure update.
 * Sent after file changes to provide updated directory structure.
 */
export interface FileTreeUpdatedEvent extends ServerEvent {
  type: "filetree.updated";
  data: {
    /** Root nodes of the file tree */
    tree: FileNode[];
  };
}

/**
 * Error notification for both fatal and non-fatal errors.
 * Fatal errors will trigger server shutdown.
 */
export interface ErrorEvent extends ServerEvent {
  type: "error";
  data: {
    /** Human-readable error message */
    message: string;
    /** Phase ID where error occurred (if applicable) */
    phase?: string;
    /** If true, server will shutdown after this error */
    fatal: boolean;
    /** Error severity level */
    severity?: ErrorSeverity;
    /** Additional error context */
    context?: string;
  };
}

/**
 * Notification of incomplete phase from previous session.
 * Helps users recover from interrupted workflows.
 */
export interface IncompletePhaseEvent extends ServerEvent {
  type: "incomplete.phase";
  data: {
    /** ID of the incomplete phase */
    phaseId: string;
    /** Human-readable phase name */
    phaseName: string;
    /** Suggested action message */
    message: string;
  };
}

/**
 * General informational messages.
 * Used for non-error status updates.
 */
export interface InfoEvent extends ServerEvent {
  type: "info";
  data: {
    /** Informational message */
    message: string;
  };
}

// ============================================================================
// Client -> Server Commands
// ============================================================================

/**
 * Base interface for all client-to-server commands.
 * Commands are sent over WebSocket to control server behavior.
 */
export interface ClientCommand {
  /** Unique ID for this command (for request/response correlation) */
  id: string;
  /** Command type identifier for server-side routing */
  type: string;
}

/**
 * Start a specific phase by ID.
 * Can optionally skip pre-start commands for retry scenarios.
 */
export interface StartPhaseCommand extends ClientCommand {
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
export interface NextPhaseCommand extends ClientCommand {
  type: "phase.next";
}

/**
 * Skip the currently running phase.
 * Terminates the Claude process and marks phase as skipped.
 */
export interface SkipPhaseCommand extends ClientCommand {
  type: "phase.skip";
}

/**
 * Re-run the last completed phase.
 * Useful for retrying failed phases or regenerating outputs.
 */
export interface RedoPhaseCommand extends ClientCommand {
  type: "phase.redo";
}

/**
 * Gracefully shutdown the server.
 * Cleans up all resources and removes lock file.
 */
export interface ShutdownCommand extends ClientCommand {
  type: "server.shutdown";
}

// ============================================================================
// Claude Log Types (from claude-session-schema)
// ============================================================================

export type ClaudeLogMessage = z.infer<typeof logMessageSchema>;
