import type { z } from "zod";
import type { ServerEvent } from "../schemas/event-schemas.js";
import type { CodonId } from "./branded-types.js";
import type { AssistantMessage, logMessageSchema, ResultMessage } from "./claude-session-schema.js";
import type { SentinelConfig } from "./sentinel-types.js";

// Re-export types from config.ts (inferred from Zod schemas)
export type {
  Codon,
  CodonConfig,
  HankFile,
  HankMeta,
  HankOverrides,
  HankweaveConfig,
  Loop,
  LoopTermination,
  RigSetupItem,
  RigShellCommand,
  RuntimeConfig,
  ShellCommand,
} from "../config.js";

// -------------
// Model Types
// -------------

// ModelName supports any string to work with different shims (Claude, Gemini, etc.)
// Known Claude models are preserved for autocomplete
export type ModelName = "sonnet" | "opus" | (string & {});

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
     * If omitted, sentinel auto-generates paths in .hankweave/sentinel-outputs/
     * You can use filenames to join together logs from different sentinels.
     * Path convention:
     * - Filename only (no '/'): .hankweave/sentinel-outputs/{id}/{filename}
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
 * Information for creating a checkpoint commit in the shadow git repository.
 *
 * The checkpoint system creates a shadow git repo in `.hankweave/checkpoints/` that tracks
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

  /** Unique identifier for this Hankweave runtime run */
  runId: string;

  /** ISO timestamp when the checkpoint was created */
  timestamp: string;

  /** Duration in milliseconds (only for completed/error/skipped codons) */
  duration?: number;
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
// Shim Self-Test Types
// -------------

/**
 * Individual check result from a shim's self-test.
 * Each check verifies a specific aspect of the environment setup.
 */
export interface ShimSelfTestCheck {
  /** Name of the check (e.g., "gemini_cli_found", "api_key") */
  name: string;
  /** Whether this check passed */
  passed: boolean;
  /** Human-readable message describing the check result */
  message: string;
}

/**
 * Complete self-test result from a shim.
 * Shims use --self-test flag to verify their environment is properly configured.
 */
export interface ShimSelfTestResult {
  /** Information about the shim itself */
  shim: {
    /** Name of the shim (e.g., "gemini-cli-shim") */
    name: string;
    /** Version of the shim */
    version: string;
  };
  /** Information about the underlying agent/CLI */
  agent: {
    /** Name of the agent (e.g., "gemini-cli") */
    name: string;
    /** Version of the agent (or "unknown" if not found) */
    version: string;
    /** Whether the agent was found in the system */
    found: boolean;
  };
  /** Array of individual check results */
  checks: ShimSelfTestCheck[];
  /** Overall test result */
  overall: {
    /** Whether all checks passed */
    passed: boolean;
    /** Overall status message */
    message: string;
  };
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
