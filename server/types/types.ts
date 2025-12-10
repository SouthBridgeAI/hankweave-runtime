import type { z } from "zod";
import type { ServerEvent } from "../schemas/event-schemas.js";
import type { CodonId } from "./branded-types.js";
import type { AssistantMessage, logMessageSchema, ResultMessage } from "./claude-session-schema.js";
import type { SentinelConfig } from "./sentinel-types.js";

// -------------
// Model Types
// -------------

export type ModelName = "sonnet" | "opus";

export type ContinuationMode = "fresh" | "continue-previous";

// -------------
// WebSocket Client Types
// -------------

/**
 * Client access modes for different capabilities
 */
export enum ClientMode {
  READONLY = "readonly",
  READANDWRITE = "readandwrite",
}

/**
 * Cursor for paginating through event history
 */
export interface EventCursor {
  timestamp: string;
  eventId: string;
}

/**
 * Direction for pagination through event history
 */
export type PaginationDirection = "forward" | "backward";

/**
 * Handshake request sent by client to establish connection mode
 */
export interface HandshakeRequest {
  type: "handshake";
  data: {
    mode: ClientMode;
    sendPreviousEvents?: boolean; // Whether to send event history (defaults to false)
  };
}

/**
 * Handshake response sent by server after processing request
 */
export interface HandshakeResponse {
  type: "handshake.response";
  data: {
    clientId: string;
    mode: ClientMode; // Granted mode (may differ from requested)
    eventHistory: ServerEvent[]; // Limited by handshakeHistoryLimit
    totalEvents: number; // Total events in journal
  };
}

/**
 * Client metadata stored with each WebSocket connection.
 * Provides connection tracking and activity monitoring.
 */
export type ClientData =
  | {
      id: string;
      connectionTime: Date;
      lastActivity: Date;
      handshakeComplete: false;
    }
  | {
      id: string;
      connectionTime: Date;
      lastActivity: Date;
      mode: ClientMode;
      handshakeComplete: true;
    };

// -------------
// Process Exit Types (moved to schemas)
// -------------
// ProcessExit is now defined in server/schemas/event-schemas.ts

// -------------
// Failure Reason Types (moved to schemas)
// -------------
// FailureReason is now defined in server/schemas/event-schemas.ts

// -------------
// Message ID Types
// -------------

export type ClaudeMessageId = `msg_${string}`;
export type UUIDMessageId = string; // Keep flexible for UUIDs
export type MessageId = ClaudeMessageId | UUIDMessageId;

// -------------
// Checkpoint Status Types
// -------------

export const CHECKPOINT_STATUS = {
  RIG_SETUP: "rig-setup",
  COMPLETED: "completed",
  ERROR: "error",
  EXIT: "exit",
  SKIPPED: "skipped",
} as const;

export type CheckpointStatus = (typeof CHECKPOINT_STATUS)[keyof typeof CHECKPOINT_STATUS];

// -------------
// Server Configuration
// -------------

type ShellCommandWorkingDirectory = "project";
type RigShellCommandWorkingDirectory = ShellCommandWorkingDirectory | "lastCopied";

export type ShellCommand = {
  /** Type of setup operation */
  type: "command";
  /** For command operations */
  command: {
    /** Shell command to execute */
    run: string;
    /** Working directory for command execution (default: "project") */
    workingDirectory?: ShellCommandWorkingDirectory;
  };
};

export type RigShellCommand = {
  /** Type of setup operation */
  type: "command";
  /** For command operations */
  command: {
    /** Shell command to execute */
    run: string;
    /** Working directory for command execution (default: "project") */
    workingDirectory?: RigShellCommandWorkingDirectory;
  };
};

/**
 * Rig setup operation - either copy files/directories or run commands.
 */
export type RigSetupItem =
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
      /**
       * If true, failure of this operation won't fail the codon (default: false).
       * Recommended for rig setup in loop codons where operations might
       * fail in some iterations (e.g., copying files that don't exist yet).
       */
      allowFailure?: boolean;
    }
  | (RigShellCommand & {
      /**
       * If true, failure of this operation won't fail the codon (default: false).
       * Recommended for rig setup in loop codons where operations might
       * fail in some iterations (e.g., running commands that might not succeed initially).
       */
      allowFailure?: boolean;
    });

// -------------
// Loop Termination Conditions
// -------------

/**
 * Loop termination conditions define when a loop should stop iterating.
 * - iterationLimit: Stop after a fixed number of iterations
 * - contextExceeded: Stop when Claude signals context exhaustion
 */
export type LoopTermination =
  | { type: "iterationLimit"; limit: number }
  | { type: "contextExceeded" };
// Future: | { type: "budgetExhausted"; budget: number; budgetType: "tokens" | "time" }

// -------------
// Codon and Loop Types
// -------------

/**
 * Single codon configuration - represents one executable codon.
 * Codon-level sentinel entry.
 * Wraps sentinel config with codon-specific settings.
 *
 * This separation keeps sentinel configs reusable across codons
 * while allowing codon-specific configuration.
 */
export interface CodonSentinelEntry {
  /**
   * Sentinel configuration.
   * Can be:
   * - File path (string): "./sentinels/narrator.json"
   * - Inline config (object): Full SentinelConfig
   */
  sentinelConfig: string | SentinelConfig;

  /**
   * Codon-specific settings for this sentinel.
   */
  settings?: {
    /**
     * Fail the codon if this sentinel fails to load.
     *
     * IMPORTANT: This only affects LOAD-TIME failures (config errors, file not found, etc).
     * Does NOT fail the codon if:
     * - Sentinel needs to be unloaded mid-execution (due to errors)
     * - Sentinel LLM calls fail (those are handled by error thresholds)
     * - Sentinel queue overflows
     *
     * Use for mission-critical sentinels where codon cannot proceed without them.
     * Default: false (sentinels are optional)
     */
    failCodonIfNotLoaded?: boolean;

    /**
     * Output file paths for this sentinel in this codon.
     * If omitted, sentinel auto-generates paths in .strandweave/sentinel-outputs/
     * You can use filenames to join together logs from different sentinels.
     * Path convention:
     * - Filename only (no '/'): .strandweave/sentinel-outputs/{id}/{filename}
     * - Path with '/': {executionPath}/{path}
     */
    outputPaths?: {
      logFile?: string;
      lastValueFile?: string;
    };

    /**
     * Override sentinel's reportToWebsocket settings for this codon.
     * Codon-level settings take precedence over sentinel-level settings.
     *
     * Controls which sentinel events are emitted to the WebSocket stream:
     * - lifecycle: sentinel.loaded, sentinel.unloaded (default: true)
     * - errors: sentinel.error events (default: true)
     * - outputs: sentinel.output events with full content (default: true)
     * - triggers: sentinel.triggered events (default: false - verbose)
     *
     * Example: Disable verbose output events for this codon only:
     * ```json
     * "reportToWebsocket": { "outputs": false, "triggers": false }
     * ```
     */
    reportToWebsocket?: {
      lifecycle?: boolean;
      errors?: boolean;
      outputs?: boolean;
      triggers?: boolean;
    };
  };
}

/**
 * Configuration for a single codon in the Strandweave workflow.
 * A codon represents a discrete task for Claude to perform, with its own
 * prompt, model settings, and optional file watching.
 */
export interface Codon {
  /** Type discriminator - optional, defaults to "codon" */
  type?: "codon";

  /** Unique identifier for this codon (e.g., "codon-1", "data-analysis") */
  id: CodonId;

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
   * How this codon should handle continuation from previous codons.
   * - "fresh": Start a new session (default for most cases)
   * - "continue-previous": Continue from the previous codon's session,
   *   maintaining context and conversation history. The previous codon must
   *   have completed successfully.
   */
  continuationMode: ContinuationMode;

  /**
   * Rig setup operations to run before codon starts.
   * Each operation must complete successfully for codon to start.
   */
  rigSetup?: RigSetupItem[];

  /** Optional description shown to users about what this codon does */
  description?: string;

  /**
   * Glob patterns for files to track during codon execution.
   * These files will be:
   * - Watched for changes and streamed to the client
   * - Tracked in the git-based checkpoint system
   * - Resolved using gitignore rules for consistency
   */
  trackedFiles?: string[];

  /** Optional environment variables to set for the Claude process */
  env?: Record<string, string>;

  /** Optional output copy steps to run after codon completion: files to copy out from a completed codon, with optional pre-copy commands. */
  outputFiles?: {
    /** Glob patterns to copy from execution directory to output directory */
    copy: string[];
    /** Optional commands to run before copying (run in executionPath) */
    beforeCopy?: ShellCommand[];
  }[];

  /**
   * Sentinels to run during this codon.
   * Sentinels are parallel observation agents that process the event stream.
   *
   * Each entry is a wrapper object with:
   * - sentinelConfig: Portable sentinel configuration (file or inline)
   * - settings: Codon-specific settings (output paths, load requirements)
   *
   * This wrapper pattern keeps sentinel configs reusable across codons.
   */
  sentinels?: CodonSentinelEntry[];
}

/**
 * Loop configuration - contains multiple codons that repeat.
 * Loops flatten at runtime into individual codon executions.
 * Nested loops are not supported in v1.
 */
export interface Loop {
  /** Type discriminator - required for loops */
  type: "loop";

  /** Unique identifier for this loop (e.g., "iterative-development") */
  id: CodonId;

  /** Human-readable name displayed in UI and logs */
  name: string;

  /** Optional description shown to users about what this loop does */
  description?: string;

  /** Termination condition for the loop */
  terminateOn: LoopTermination;

  /** Array of codons to execute in each iteration. Only Codon objects allowed (no nested loops). */
  codons: Codon[];
}

/**
 * CodonConfig is a discriminated union of Codon and Loop.
 * This is the top-level configuration type used in strand.json.
 */
export type CodonConfig = Codon | Loop;

// -------------
// Strand Configuration (New Config System)
// -------------

/**
 * Metadata for a strand file.
 * Used for sharing, indexing, and documentation.
 */
export interface StrandMeta {
  /** Human-readable name for the strand */
  name: string;

  /** Version number (e.g., "1.0.0") */
  version: string;

  /** Optional description of what this strand does */
  description?: string;

  /** Optional author information */
  author?: string;
}

/**
 * Architect's recommendations for optimal strand execution.
 * These are "soft defaults" specific to this workflow logic.
 * Priority Level 4 in the resolution hierarchy.
 */
export interface StrandRecommendations {
  /** Recommended model for this strand (e.g., "This task needs high reasoning") */
  model?: ModelName;

  /** Recommended time limit for data hashing in milliseconds */
  dataHashTimeLimit?: number;

  /** Recommended sentinel system settings */
  sentinel?: {
    /** Whether to enable sentinel persistence */
    enablePersistence?: boolean;

    /** Grace period for sentinel health checks */
    healthCheckGracePeriodMs?: number;

    /** Whether to wait for all health checks before starting */
    waitForAllHealthChecks?: boolean;
  };
}

/**
 * Strand file format (strand.json).
 * Defines the workflow logic plus optional metadata and recommendations.
 *
 */
export interface StrandFile {
  /** Metadata for sharing/indexing (optional) */
  meta?: StrandMeta;

  /** Architect's recommendations for optimal execution (optional) */
  recommendations?: StrandRecommendations;

  /** The immutable logic sequence (required) */
  strand: CodonConfig[];
}

/**
 * Runtime configuration (strandweave.json).
 * User's local preferences and environment-specific settings.
 * Priority Level 3 in the resolution hierarchy.
 *
 */
export interface RuntimeConfig {
  // Server Behaviors
  /** WebSocket server port */
  port?: number;

  /** If true, run immediately on client connect */
  autostart?: boolean;

  /** Bypass internal LLM proxy */
  withoutProxy?: boolean;

  // Model & API
  /** User's preferred default model */
  model?: ModelName;

  /** Custom Anthropic API base URL (for corporate proxies) */
  anthropicBaseUrl?: string;

  // Resources & Limits
  /** Where to put results (relative to CWD) */
  outputDirectory?: string;

  /** Where to create temp execution environments */
  executionBaseDir?: string;

  /** Interval for parsing Claude log files (milliseconds) */
  logParsingInterval?: number;

  /** Time limit for hashing directories (milliseconds) */
  dataHashTimeLimit?: number;

  // Sentinel System
  /** Sentinel system configuration */
  sentinel?: {
    /** Enable filesystem persistence for sentinel outputs */
    enablePersistence?: boolean;

    /** Grace period to wait for provider health checks (milliseconds) */
    healthCheckGracePeriodMs?: number;

    /** Wait for all health checks before loading sentinels */
    waitForAllHealthChecks?: boolean;
  };
}

/**
 * Information for creating a checkpoint commit in the shadow git repository.
 *
 * The checkpoint system creates a shadow git repo in `.strandweave/checkpoints/` that tracks
 * files matching the `checkpointAndWatch` patterns. Each checkpoint creates a commit
 * with detailed metadata about the codon state.
 */
export interface CheckpointInfo {
  /** The type of checkpoint being created */
  status: CheckpointStatus;

  /** Unique identifier of the codon (e.g., "codon-1") */
  codonId: CodonId;

  /** Human-readable name of the codon */
  codonName: string;

  /** Unique identifier for this Strandweave runtime run */
  runId: string;

  /** ISO timestamp when the checkpoint was created */
  timestamp: string;

  /** Duration in milliseconds (only for completed/error/skipped codons) */
  duration?: number;
}

/**
 * Main server configuration containing all runtime settings.
 * Extends RuntimeConfig with all fields required (defaults filled in) plus additional internal/execution properties.
 * This is the complete, finalized config assembled from all layers (CLI, env, files, defaults).
 */
export interface StrandweaveConfig
  extends Omit<Required<RuntimeConfig>, "model" | "anthropicBaseUrl"> {
  // Fields from RuntimeConfig that remain optional
  /** Optional custom base URL for Anthropic API (e.g., for proxies or gateways) */
  anthropicBaseUrl?: string;

  /**
   * Model setting - behavior depends on resolution layer:
   * - If set via CLI/Env/RuntimeConfig (layers 1-3): Overrides ALL codon models globally
   * - If set via Recommendations/Defaults (layers 4-5): Used as fallback for codons without model specified
   */
  model?: ModelName;

  // Additional internal properties (not in RuntimeConfig)
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

  /** Path to the codon configuration file (for resolving relative sentinel paths) */
  configPath?: string;

  /**
   * Token cost configuration per million tokens.
   * Used to calculate costs for each codon and total project cost.
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

  /** Maximum length for tool result content before truncation (default: 2500) */
  toolResultTruncateLength: number;

  /** Maximum number of recent events to include in handshake response (default: 50) */
  handshakeHistoryLimit: number;

  // Execution-specific properties (from ExecutionSetup)
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

  /** Array of codon configurations to execute */
  codons: CodonConfig[];
}

// -------------
// Internal Types
// -------------

/**
 * Token usage tracking for Claude API calls.
 * Used to calculate costs and monitor usage across codons.
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

// -------------
// Synthetic Message Types
// -------------

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

/**
 * Type guard to check if a log message indicates a context exceeded error.
 * Detects two patterns:
 * - Pattern 1: Synthetic assistant message with "API Error: terminated" or output token maximum exceeded
 * - Pattern 2: Result message with "exceeded the...output token maximum"
 */
export function isContextExceeded(msg: ClaudeLogMessage): boolean {
  // Pattern 1: Synthetic assistant message with context exceeded indicators
  if (msg.type === "assistant") {
    const assistantMsg = msg as AssistantMessage;
    if (
      assistantMsg.message.model === "<synthetic>" &&
      Array.isArray(assistantMsg.message.content) &&
      assistantMsg.message.content.length === 1 &&
      assistantMsg.message.content[0].type === "text"
    ) {
      const text = assistantMsg.message.content[0].text;
      // Check for either "API Error: terminated" or output token maximum exceeded
      return (
        text === "API Error: terminated" ||
        (text.includes("exceeded the") && text.includes("output token maximum"))
      );
    }
  }

  // Pattern 2: Result message with output token limit exceeded
  if (msg.type === "result") {
    const resultMsg = msg as ResultMessage;
    return (
      resultMsg.is_error === true &&
      typeof resultMsg.result === "string" &&
      resultMsg.result.includes("exceeded the") &&
      resultMsg.result.includes("output token maximum")
    );
  }

  return false;
}

// -------------
// Claude Log Types (from claude-session-schema)
// -------------

export type ClaudeLogMessage = z.infer<typeof logMessageSchema>;

// -------------
// Re-export types from schemas for backward compatibility
// -------------

export type {
  AssistantActionEvent,
  CheckpointListEvent,
  // Data types used in events
  CheckpointQueryInfo,
  CodonCompletedEvent,
  CodonExecution,
  CodonStartedEvent,
  ErrorEvent,
  FailureReason,
  FileNode,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  HistoryBatchEvent,
  IncompleteCodonEvent,
  InfoEvent,
  ProcessExit,
  RollbackCodonCheckpointEvent,
  RollbackCompletedEvent,
  RollbackProgressEvent,
  RollbackRigCleanupEvent,
  RollbackStartedEvent,
  ServerEvent,
  // Event types
  ServerIdleEvent,
  ServerReadyEvent,
  StateSnapshotEvent,
  TokenUsageEvent,
  ToolResultEvent,
} from "../schemas/event-schemas.js";

// -------------
// Client -> Server Commands (keeping these here for now)
// -------------

/**
 * Start a specific codon by ID.
 * Can optionally skip pre-start commands for retry scenarios.
 */
export interface StartCodonCommand {
  /** Unique ID for this command (for request/response correlation) */
  id: string;
  type: "codon.start";
  data: {
    /** ID of the codon to start */
    codonId: string;
    /** If true, skip the codon's preStart command */
    skipPreCommands?: boolean;
  };
}

/**
 * Start the next codon in sequence.
 * Determines next codon based on completion history.
 */
export interface NextCodonCommand {
  id: string;
  type: "codon.next";
}

/**
 * Skip the currently running codon.
 * Terminates the Claude process and marks codon as skipped.
 */
export interface SkipCodonCommand {
  id: string;
  type: "codon.skip";
}

/**
 * Re-run the last completed codon.
 * Useful for retrying failed codons or regenerating outputs.
 */
export interface RedoCodonCommand {
  id: string;
  type: "codon.redo";
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
 * Force stop the current running codon.
 */
export interface ForceStopCommand {
  id: string;
  type: "codon.forceStop";
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
 * Rollback to a codon with specific checkpoint type.
 */
export interface RollbackToCodonCommand {
  id: string;
  type: "rollback.toCodon";
  data: {
    /** Codon ID to rollback to */
    codonId: string;
    /** Checkpoint type within that codon */
    checkpointType: "start" | "end" | "rig-setup" | "completed" | "error" | "skipped";
    /** Whether to auto-restart after rollback */
    autoRestart?: boolean;
  };
}

/**
 * Rollback to last successful codon.
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
  | StartCodonCommand
  | NextCodonCommand
  | SkipCodonCommand
  | RedoCodonCommand
  | ShutdownCommand
  | ForceStopCommand
  | ListCheckpointsCommand
  | RollbackToCheckpointCommand
  | RollbackToCodonCommand
  | RollbackToLastSuccessCommand;
