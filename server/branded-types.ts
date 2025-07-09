declare const __brand: unique symbol;
type Brand<B> = { [__brand]: B };
export type Branded<T, B> = T & Brand<B>;

// ============================================================================
// ID Types
// ============================================================================

export type PhaseId = Branded<string, "PhaseId">;
export type SessionId = Branded<string, "SessionId">;
export type PhaseExecutionId = Branded<`${number}-${string}`, "PhaseExecutionId">;
export type EventId = Branded<string, "EventId">;
export type MessageId = Branded<string, "MessageId">;
export type ToolUseId = Branded<string, "ToolUseId">;

// ============================================================================
// Path Types
// ============================================================================

export type LogPath = Branded<string, "LogPath">;
export type GlobPattern = Branded<string, "GlobPattern">;
export type ShellCommand = Branded<string, "ShellCommand">;

// ============================================================================
// Helper Functions
// ============================================================================

export const PhaseId = (id: string): PhaseId => id as PhaseId;
export const SessionId = (id: string): SessionId => id as SessionId;
export const PhaseExecutionId = (id: string): PhaseExecutionId => id as PhaseExecutionId;
export const EventId = (id: string): EventId => id as EventId;
export const MessageId = (id: string): MessageId => id as MessageId;
export const ToolUseId = (id: string): ToolUseId => id as ToolUseId;

export const LogPath = (path: string): LogPath => {
  if (!path.match(/^log-.*\.jsonl$/)) {
    throw new Error("Invalid log path format");
  }
  return path as LogPath;
};

export const GlobPattern = (pattern: string): GlobPattern => pattern as GlobPattern;
export const ShellCommand = (cmd: string): ShellCommand => cmd as ShellCommand;

// ============================================================================
// Specialized ID Creation Functions
// ============================================================================

/**
 * Creates a PhaseExecutionId with timestamp-random format
 */
export const createPhaseExecutionId = (timestamp: number, random: string): PhaseExecutionId =>
  `${timestamp}-${random}` as PhaseExecutionId;
