/**
 * Public schema exports for external consumers (e.g., hw-tracing).
 *
 * Exports Zod schemas and inferred TypeScript types for:
 * - Server events (events.jsonl)
 * - Per-codon log messages (claude session JSONL)
 */

// Event schemas — the master union and individual event schemas
export {
  type AssistantActionEvent,
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
  errorEventSchema,
  type FileUpdatedEvent,
  fileUpdatedEventSchema,
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
