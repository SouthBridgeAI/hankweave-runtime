/**
 * Public schema exports for external consumers (e.g., hw-tracing).
 *
 * Exports Zod schemas and inferred TypeScript types for:
 * - Server events (events.jsonl)
 * - Per-codon log messages (claude session JSONL)
 *
 * Versioning contract: the event payload shape is versioned file-level by
 * EVENT_SCHEMA_VERSION, recorded in the run's `events.meta.json` sidecar
 * (never per-event). v2 made `file.updated` fingerprint-only: events carry
 * `sha256`/`bytes`/`source` and never a file body. The change's bytes live in
 * the `assistant.action` receipt joined via `source.toolUseId` (Write bodies
 * and Edit old/new strings are journaled verbatim in `toolInput` — inputs are
 * never truncated, only tool results are); full file states live in
 * checkpoints and on disk. `state.snapshot.recentFileAccess` is a
 * `{path, timestamp}` pointer. v1 journals (inline `content` bodies) predate
 * this contract.
 */

// Event schemas — the master union and individual event schemas
export {
  type AssistantActionEvent,
  // The composable object shape (.pick/.extend/.shape); the wire validator
  // below is a refined ZodEffects (tool_use actions require their join keys).
  assistantActionEventDataBaseSchema,
  assistantActionEventDataSchema,
  assistantActionEventSchema,
  type BudgetSummaryEvent,
  budgetSummaryEventSchema,
  type CodonCompletedEvent,
  type CodonExtendedEvent,
  type CodonStartedEvent,
  codonCompletedEventDataSchema,
  codonCompletedEventSchema,
  codonExtendedEventSchema,
  // Data payload schemas (useful for partial parsing)
  codonStartedEventDataSchema,
  codonStartedEventSchema,
  type ErrorEvent,
  EVENT_SCHEMA_VERSION,
  errorEventSchema,
  type FileUpdatedEvent,
  type FileUpdatedEventData,
  type FileUpdatedSource,
  fileUpdatedEventDataSchema,
  fileUpdatedEventSchema,
  fileUpdatedSourceSchema,
  type InfoEvent,
  infoEventSchema,
  isAgenticBackboneEvent,
  isConnectionStateEvent,
  isSentinelEvent,
  // Event category classifiers
  isServerStateEvent,
  type LoopIterationCompletedEvent,
  loopIterationCompletedEventDataSchema,
  loopIterationCompletedEventSchema,
  type RigOutputEvent,
  type RigSetupCompletedEvent,
  type RigSetupFailedEvent,
  rigOutputEventSchema,
  rigSetupCompletedEventDataSchema,
  rigSetupCompletedEventSchema,
  rigSetupFailedEventDataSchema,
  rigSetupFailedEventSchema,
  type SentinelErrorEvent,
  type SentinelLoadedEvent,
  type SentinelOutputEvent,
  type SentinelTriggeredEvent,
  type SentinelUnloadedEvent,
  type ServerEvent,
  type ServerReadyEvent,
  sentinelErrorEventSchema,
  sentinelLoadedEventDataSchema,
  sentinelLoadedEventSchema,
  sentinelOutputEventDataSchema,
  sentinelOutputEventSchema,
  sentinelTriggeredEventSchema,
  sentinelUnloadedEventDataSchema,
  sentinelUnloadedEventSchema,
  serverEventSchema,
  // Individual event schemas (Zod) and types
  serverReadyEventSchema,
  type TokenUsageEvent,
  type ToolResultEvent,
  tokenUsageEventDataSchema,
  tokenUsageEventSchema,
  toolResultEventDataSchema,
  toolResultEventSchema,
} from "../schemas/event-schemas.js";

// Per-codon log message schemas (claude session JSONL format)
export {
  type AssistantMessage,
  assistantMessageSchema,
  // The union schema for any log line
  type LogMessage,
  logMessageSchema,
  messageContentSchema,
  type ResultMessage,
  resultMessageSchema,
  type SystemMessage,
  systemMessageSchema,
  type TextContent,
  type ThinkingContent,
  type ToolResultContent,
  type ToolUseContent,
  textContentSchema,
  thinkingContentSchema,
  toolResultContentSchema,
  // Content block schemas
  toolUseContentSchema,
  type UserMessage,
  userMessageSchema,
} from "../types/claude-session-schema.js";
