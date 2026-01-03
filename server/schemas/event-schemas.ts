import { z } from "zod";
import type { StateTransitionType } from "../types/state-types.js";
import type { AssertEqual } from "../utils.js";

// -------------
// Re-usable Base Schemas
// -------------

// Process exit types
const processExitSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("success") }),
  z.object({ type: z.literal("error"), code: z.number() }),
  z.object({ type: z.literal("killed"), signal: z.string() }),
]);

// Failure reason schema
const failureReasonSchema = z.object({
  type: z.enum(["timeout", "rate-limit", "api-error", "sentinel-load-failure", "unknown"]),
  retriable: z.boolean(),
  message: z.string().optional(),
  sentinelRefs: z.array(z.string()).optional(), // Which sentinels failed (for sentinel-load-failure)
});

// Token usage schema
const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
});

// File node type for recursive schema
interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: FileNode[];
  lastModified?: string;
}

// File node schema (recursive)
const fileNodeSchema: z.ZodType<FileNode> = z.lazy(() =>
  z.discriminatedUnion("isDirectory", [
    z.object({
      name: z.string(),
      path: z.string(),
      isDirectory: z.literal(true),
      children: z.array(fileNodeSchema),
    }),
    z.object({
      name: z.string(),
      path: z.string(),
      isDirectory: z.literal(false),
      lastModified: z.string(),
      children: z.array(fileNodeSchema),
    }),
  ]),
);

// Codon execution schema (complete version for state snapshots)
const codonExecutionSchema = z.object({
  codonId: z.string(),
  codonName: z.string().optional(),
  status: z.enum([
    "preparing",
    "starting",
    "initializing",
    "running",
    "completing-sentinels",
    "completed",
    "failed",
    "skipped",
  ]),
  startTime: z.string(),
  endTime: z.string().optional(),
  sessionId: z.string().optional(),
  previousSessionId: z.string().optional(),
  claudeSessionId: z.string().optional(), // Claude's session ID
  tokenUsage: tokenUsageSchema.optional(),
  cost: z.number().optional(),
  duration: z.number().optional(),
  exitStatus: processExitSchema.optional(),
  failureReason: failureReasonSchema.optional(),
  description: z.string().optional(),
  // Cost tracking fields
  finalCost: z.number().optional(),
  partialCost: z.number().optional(),
  currentCost: z.number().optional(),
  // Checkpoint fields
  completionCheckpoint: z.string().optional(),
  rigSetupCheckpoint: z.string().optional(),
  errorCheckpoint: z.string().optional(),
  skipCheckpoint: z.string().optional(),
});

// Checkpoint query info schema
const checkpointQueryInfoSchema = z.object({
  codonId: z.string(),
  codonName: z.string(),
  checkpointType: z.enum(["rig-setup", "completed", "error", "skipped"]),
  sha: z.string(),
  status: z.enum([
    "preparing",
    "starting",
    "initializing",
    "running",
    "completing-sentinels",
    "completed",
    "failed",
    "skipped",
  ]),
  timestamp: z.string(),
});

// -------------
// Event Data Payload Schemas
// -------------

export const serverReadyEventDataSchema = z.object({
  serverVersion: z.string(),
  executionPath: z.string(),
  dataPath: z.string(),
});

export const stateSnapshotEventDataSchema = z.object({
  currentCodon: codonExecutionSchema.optional(),
  completedCodons: z.array(codonExecutionSchema),
  fileTree: z.array(fileNodeSchema),
  totalCost: z.number(),
  totalTime: z.number(),
  recentFileAccess: z
    .object({
      path: z.string(),
      content: z.string(),
      timestamp: z.date(),
    })
    .optional(),
  isRollingBack: z.boolean(),
});

export const codonStartedEventDataSchema = z.object({
  codonId: z.string(),
  codonName: z.string(),
  codonDescription: z.string().optional(),
  sessionId: z.string(),
  previousSessionId: z.string().optional(),
  startTime: z.string().datetime(),
});

export const codonCompletedEventDataSchema = z.object({
  codonId: z.string(),
  success: z.boolean(),
  cost: z.number(),
  duration: z.number(),
  exitStatus: processExitSchema,
  failureReason: failureReasonSchema.optional(),
});

export const assistantActionEventDataSchema = z.object({
  codonId: z.string(),
  action: z.enum(["thinking", "message", "tool_use"]),
  content: z.string(),
  toolName: z.string().optional(),
  toolInput: z.record(z.unknown()).optional(),
});

export const tokenUsageEventDataSchema = z.object({
  codonId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  totalCost: z.number(),
  modelId: z.string().optional(), // For single-model scenarios
  modelUsage: z
    .record(
      z.string(),
      z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadInputTokens: z.number().optional(),
        cacheCreationInputTokens: z.number().optional(),
        costUSD: z.number(),
      }),
    )
    .optional(), // For multi-model scenarios
});

export const toolResultEventDataSchema = z.object({
  codonId: z.string(),
  toolUseId: z.string(),
  toolName: z.string(),
  result: z.string(),
  truncated: z.boolean(),
  originalLength: z.number(),
  executionTimeMs: z.number(),
  isError: z.boolean(),
});

export const fileUpdatedEventDataSchema = z.object({
  path: z.string(),
  filename: z.string(),
  content: z.string(),
  action: z.enum(["created", "modified", "deleted"]),
});

export const fileTreeUpdatedEventDataSchema = z.object({
  tree: z.array(fileNodeSchema),
});

export const errorEventDataSchema = z.object({
  message: z.string(),
  codon: z.string().optional(),
  fatal: z.boolean(),
  severity: z.enum(["fatal", "codon", "operation", "warning"]).optional(),
  context: z.string().optional(),
  code: z.string().optional(),
});

export const incompleteCodonEventDataSchema = z.object({
  codonId: z.string(),
  codonName: z.string(),
  message: z.string(),
});

export const infoEventDataSchema = z.object({
  message: z.string(),
});

export const serverIdleEventDataSchema = z.object({
  reason: z.enum(["startup", "codon-completed", "all-codons-completed"]),
  message: z.string(),
});

export const checkpointListEventDataSchema = z.object({
  runId: z.string(),
  checkpoints: z.array(checkpointQueryInfoSchema),
  currentBranch: z.string(),
});

export const rollbackStartedEventDataSchema = z.object({
  fromRun: z.string(),
  fromCodon: z.string(),
  toCodon: z.string(),
  toCheckpoint: z.string(),
  checkpointType: z.string(),
  codonsToProcess: z.array(z.string()),
});

export const rollbackCodonCheckpointEventDataSchema = z.object({
  codonId: z.string(),
  codonName: z.string(),
  checkpoint: z.string(),
  checkpointType: z.string(),
  message: z.string(),
});

export const rollbackRigCleanupEventDataSchema = z.object({
  codonId: z.string(),
  codonName: z.string(),
  directories: z.array(z.string()),
  status: z.enum(["started", "completed", "failed", "partial"]),
  successfulCleanups: z.array(z.string()).optional(),
  failedCleanups: z
    .array(
      z.object({
        directory: z.string(),
        error: z.string(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

export const rollbackProgressEventDataSchema = z.object({
  currentStep: z.number(),
  totalSteps: z.number(),
  message: z.string(),
});

export const rollbackCompletedEventDataSchema = z.object({
  fromRun: z.string(),
  toRun: z.string(),
  checkpoint: z.string(),
  codonId: z.string(),
  codonName: z.string(),
  checkpointType: z.string(),
  autoRestart: z.boolean(),
});

export const pongEventDataSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
  clientId: z.string().optional(), // Only present in ping.broadcast responses
});

export const historyBatchEventDataSchema = z.object({
  events: z.array(z.any()), // Array of ServerEvent (we use z.any() to avoid circular reference)
  hasMore: z.boolean(),
});

export const stateTransitionEventDataSchema = z.object({
  transitionType: z.enum([
    "RunStarted",
    "RunCompleted",
    "RunFailed",
    "RunCrashed",
    "CodonStarted",
    "CodonTransitioned",
    "CostsUpdated",
    "CostsIncremented",
    "AssistantMessageCountUpdated",
    "CheckpointCreated",
    "InitialCheckpointSet",
    "CodonFinalCostSet",
    "SentinelStatesUpdated",
  ]),
  runId: z.string().optional(),
  codonId: z.string().optional(),
  transition: z.object({
    type: z.string(),
    data: z.record(z.unknown()),
  }),
  resultingState: z.object({
    currentRunId: z.string().nullable(),
    runCount: z.number(),
    totalCost: z.number(),
    currentRunCost: z.number(),
  }),
});

// Sentinel event data schemas
export const sentinelLoadedEventDataSchema = z.object({
  sentinelId: z.string(),
  codonId: z.string(),
  model: z.string(),
  triggerType: z.enum(["event", "sequence"]),
  executionStrategy: z.enum(["immediate", "debounce", "count", "timeWindow"]),
  conversational: z.boolean(),
  source: z.enum(["file", "inline"]),
  sourcePath: z.string().optional(),
});

export const sentinelUnloadedEventDataSchema = z.object({
  sentinelId: z.string(),
  codonId: z.string(),
  reason: z.enum(["codon-complete", "fatal-error", "consecutive-failures", "shutdown"]),
  errorType: z.enum(["template", "configuration", "corruption", "resource"]).optional(),
  finalCost: z.number(),
  llmCallCount: z.number(),
});

export const sentinelErrorEventDataSchema = z.object({
  sentinelId: z.string(),
  codonId: z.string(),
  errorType: z.enum(["llm-call-failed", "template-render-failed", "file-write-failed"]),
  message: z.string(),
  retriable: z.boolean(),
  consecutiveFailureCount: z.number(),
});

export const sentinelOutputEventDataSchema = z.object({
  sentinelId: z.string(),
  codonId: z.string(),
  triggerNumber: z.number(),
  outputType: z.enum(["text", "structured"]),
  content: z.union([z.string(), z.record(z.unknown())]),
  cost: z.number(),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
  }),
  eventCount: z.number(),
});

export const sentinelTriggeredEventDataSchema = z.object({
  sentinelId: z.string(),
  codonId: z.string(),
  triggerNumber: z.number(),
  strategy: z.enum(["immediate", "debounce", "count", "timeWindow"]),
  eventCount: z.number(),
  queueSize: z.number(),
});

// -------------
// Full Event Schemas
// -------------

const baseEventSchema = z.object({
  id: z.string(), // EventId branded type will be handled by inference
  timestamp: z.string(),
});

export const serverReadyEventSchema = baseEventSchema.extend({
  type: z.literal("server.ready"),
  data: serverReadyEventDataSchema,
});

export const stateSnapshotEventSchema = baseEventSchema.extend({
  type: z.literal("state.snapshot"),
  data: stateSnapshotEventDataSchema,
});

export const codonStartedEventSchema = baseEventSchema.extend({
  type: z.literal("codon.started"),
  data: codonStartedEventDataSchema,
});

export const codonCompletedEventSchema = baseEventSchema.extend({
  type: z.literal("codon.completed"),
  data: codonCompletedEventDataSchema,
});

export const assistantActionEventSchema = baseEventSchema.extend({
  type: z.literal("assistant.action"),
  data: assistantActionEventDataSchema,
});

export const tokenUsageEventSchema = baseEventSchema.extend({
  type: z.literal("token.usage"),
  data: tokenUsageEventDataSchema,
});

export const toolResultEventSchema = baseEventSchema.extend({
  type: z.literal("tool.result"),
  data: toolResultEventDataSchema,
});

export const fileUpdatedEventSchema = baseEventSchema.extend({
  type: z.literal("file.updated"),
  data: fileUpdatedEventDataSchema,
});

export const fileTreeUpdatedEventSchema = baseEventSchema.extend({
  type: z.literal("filetree.updated"),
  data: fileTreeUpdatedEventDataSchema,
});

export const errorEventSchema = baseEventSchema.extend({
  type: z.literal("error"),
  data: errorEventDataSchema,
});

export const incompleteCodonEventSchema = baseEventSchema.extend({
  type: z.literal("incomplete.codon"),
  data: incompleteCodonEventDataSchema,
});

export const infoEventSchema = baseEventSchema.extend({
  type: z.literal("info"),
  data: infoEventDataSchema,
});

export const serverIdleEventSchema = baseEventSchema.extend({
  type: z.literal("server.idle"),
  data: serverIdleEventDataSchema,
});

export const checkpointListEventSchema = baseEventSchema.extend({
  type: z.literal("checkpoint.list"),
  data: checkpointListEventDataSchema,
});

export const rollbackStartedEventSchema = baseEventSchema.extend({
  type: z.literal("rollback.started"),
  data: rollbackStartedEventDataSchema,
});

export const rollbackCodonCheckpointEventSchema = baseEventSchema.extend({
  type: z.literal("rollback.codonCheckpoint"),
  data: rollbackCodonCheckpointEventDataSchema,
});

export const rollbackRigCleanupEventSchema = baseEventSchema.extend({
  type: z.literal("rollback.rigCleanup"),
  data: rollbackRigCleanupEventDataSchema,
});

export const rollbackProgressEventSchema = baseEventSchema.extend({
  type: z.literal("rollback.progress"),
  data: rollbackProgressEventDataSchema,
});

export const rollbackCompletedEventSchema = baseEventSchema.extend({
  type: z.literal("rollback.completed"),
  data: rollbackCompletedEventDataSchema,
});

export const pongEventSchema = baseEventSchema.extend({
  type: z.literal("pong"),
  data: pongEventDataSchema,
});

export const historyBatchEventSchema = baseEventSchema.extend({
  type: z.literal("history.batch"),
  data: historyBatchEventDataSchema,
});

export const stateTransitionEventSchema = baseEventSchema.extend({
  type: z.literal("state.transition"),
  data: stateTransitionEventDataSchema,
});

// Sentinel event schemas
export const sentinelLoadedEventSchema = baseEventSchema.extend({
  type: z.literal("sentinel.loaded"),
  data: sentinelLoadedEventDataSchema,
});

export const sentinelUnloadedEventSchema = baseEventSchema.extend({
  type: z.literal("sentinel.unloaded"),
  data: sentinelUnloadedEventDataSchema,
});

export const sentinelErrorEventSchema = baseEventSchema.extend({
  type: z.literal("sentinel.error"),
  data: sentinelErrorEventDataSchema,
});

export const sentinelOutputEventSchema = baseEventSchema.extend({
  type: z.literal("sentinel.output"),
  data: sentinelOutputEventDataSchema,
});

export const sentinelTriggeredEventSchema = baseEventSchema.extend({
  type: z.literal("sentinel.triggered"),
  data: sentinelTriggeredEventDataSchema,
});

// -------------
// Client Command Schemas
// -------------

export const startCodonCommandSchema = z.object({
  id: z.string(),
  type: z.literal("codon.start"),
  data: z.object({
    codonId: z.string(),
    skipPreCommands: z.boolean().optional(),
  }),
});

export const nextCodonCommandSchema = z.object({
  id: z.string(),
  type: z.literal("codon.next"),
});

export const skipCodonCommandSchema = z.object({
  id: z.string(),
  type: z.literal("codon.skip"),
});

export const redoCodonCommandSchema = z.object({
  id: z.string(),
  type: z.literal("codon.redo"),
});

export const shutdownCommandSchema = z.object({
  id: z.string(),
  type: z.literal("server.shutdown"),
});

export const forceStopCommandSchema = z.object({
  id: z.string(),
  type: z.literal("codon.forceStop"),
  data: z
    .object({
      reason: z.string().optional(),
    })
    .optional(),
});

export const listCheckpointsCommandSchema = z.object({
  id: z.string(),
  type: z.literal("checkpoint.list"),
  data: z
    .object({
      runId: z.string().optional(),
    })
    .optional(),
});

export const rollbackToCheckpointCommandSchema = z.object({
  id: z.string(),
  type: z.literal("rollback.toCheckpoint"),
  data: z.object({
    checkpointSha: z.string(),
    autoRestart: z.boolean().optional(),
  }),
});

export const rollbackToCodonCommandSchema = z.object({
  id: z.string(),
  type: z.literal("rollback.toCodon"),
  data: z.object({
    codonId: z.string(),
    checkpointType: z.enum(["start", "end", "rig-setup", "completed", "error", "skipped"]),
    autoRestart: z.boolean().optional(),
  }),
});

export const rollbackToLastSuccessCommandSchema = z.object({
  id: z.string(),
  type: z.literal("rollback.toLastSuccess"),
  data: z
    .object({
      autoRestart: z.boolean().optional(),
    })
    .optional(),
});

export const pingCommandSchema = z.object({
  id: z.string(),
  type: z.literal("ping"),
});

export const pingBroadcastCommandSchema = z.object({
  id: z.string(),
  type: z.literal("ping.broadcast"),
});

export const historySyncCommandSchema = z.object({
  id: z.string(),
  type: z.literal("history.sync"),
});

export const clientCommandSchema = z.discriminatedUnion("type", [
  startCodonCommandSchema,
  nextCodonCommandSchema,
  skipCodonCommandSchema,
  redoCodonCommandSchema,
  shutdownCommandSchema,
  forceStopCommandSchema,
  listCheckpointsCommandSchema,
  rollbackToCheckpointCommandSchema,
  rollbackToCodonCommandSchema,
  rollbackToLastSuccessCommandSchema,
  pingCommandSchema,
  pingBroadcastCommandSchema,
  historySyncCommandSchema,
]);

// -------------
// Master Discriminated Union
// -------------

export const serverEventSchema = z.discriminatedUnion("type", [
  serverReadyEventSchema,
  stateSnapshotEventSchema,
  codonStartedEventSchema,
  codonCompletedEventSchema,
  assistantActionEventSchema,
  tokenUsageEventSchema,
  toolResultEventSchema,
  fileUpdatedEventSchema,
  fileTreeUpdatedEventSchema,
  errorEventSchema,
  incompleteCodonEventSchema,
  infoEventSchema,
  serverIdleEventSchema,
  checkpointListEventSchema,
  rollbackStartedEventSchema,
  rollbackCodonCheckpointEventSchema,
  rollbackRigCleanupEventSchema,
  rollbackProgressEventSchema,
  rollbackCompletedEventSchema,
  pongEventSchema,
  historyBatchEventSchema,
  stateTransitionEventSchema,
  sentinelLoadedEventSchema,
  sentinelUnloadedEventSchema,
  sentinelErrorEventSchema,
  sentinelOutputEventSchema,
  sentinelTriggeredEventSchema,
]);

// -------------
// Inferred TypeScript Types
// -------------

// Export the master union type
export type ServerEvent = z.infer<typeof serverEventSchema>;

// Export individual event types for convenience
export type ServerReadyEvent = z.infer<typeof serverReadyEventSchema>;
export type StateSnapshotEvent = z.infer<typeof stateSnapshotEventSchema>;
export type CodonStartedEvent = z.infer<typeof codonStartedEventSchema>;
export type CodonCompletedEvent = z.infer<typeof codonCompletedEventSchema>;
export type AssistantActionEvent = z.infer<typeof assistantActionEventSchema>;
export type TokenUsageEvent = z.infer<typeof tokenUsageEventSchema>;
export type ToolResultEvent = z.infer<typeof toolResultEventSchema>;
export type FileUpdatedEvent = z.infer<typeof fileUpdatedEventSchema>;
export type FileTreeUpdatedEvent = z.infer<typeof fileTreeUpdatedEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
export type IncompleteCodonEvent = z.infer<typeof incompleteCodonEventSchema>;
export type InfoEvent = z.infer<typeof infoEventSchema>;
export type ServerIdleEvent = z.infer<typeof serverIdleEventSchema>;
export type CheckpointListEvent = z.infer<typeof checkpointListEventSchema>;
export type RollbackStartedEvent = z.infer<typeof rollbackStartedEventSchema>;
export type RollbackCodonCheckpointEvent = z.infer<typeof rollbackCodonCheckpointEventSchema>;
export type RollbackRigCleanupEvent = z.infer<typeof rollbackRigCleanupEventSchema>;
export type RollbackProgressEvent = z.infer<typeof rollbackProgressEventSchema>;
export type RollbackCompletedEvent = z.infer<typeof rollbackCompletedEventSchema>;
export type PongEvent = z.infer<typeof pongEventSchema>;
export type HistoryBatchEvent = z.infer<typeof historyBatchEventSchema>;
export type StateTransitionEvent = z.infer<typeof stateTransitionEventSchema>;
export type SentinelLoadedEvent = z.infer<typeof sentinelLoadedEventSchema>;
export type SentinelUnloadedEvent = z.infer<typeof sentinelUnloadedEventSchema>;
export type SentinelErrorEvent = z.infer<typeof sentinelErrorEventSchema>;
export type SentinelOutputEvent = z.infer<typeof sentinelOutputEventSchema>;
export type SentinelTriggeredEvent = z.infer<typeof sentinelTriggeredEventSchema>;

// -------------
// Event Category Classification
// -------------

/**
 * Events are classified into FOUR categories:
 *
 * - **Server State Events**: Track the server's execution state, codon lifecycle,
 *   and persistent changes (e.g., codon execution, errors, rollbacks).
 *   These events represent changes to the server's internal state and are
 *   persisted to the event journal and broadcasted to all connected clients.
 *
 * - **Agentic Backbone Events**: Capture the agent's core execution artifacts
 *   (assistant actions, tool outputs, and rig mutations). These events
 *   are journaled and broadcast the same way as server state events but are
 *   tracked separately for clarity.
 *
 * - **Sentinel Events**: Track sentinel lifecycle, outputs, and errors.
 *   Persisted and broadcasted like Server State Events but explicitly categorized
 *   for filtering. Sentinels are observers, not participants.
 *
 * - **Connection State Events**: Track client specific events.
 *   These events are not persisted to the event journal and are sent to individual clients.
 *
 * The category is automatically inferred from the event's type field using the
 * Sets below. Events do not have an explicit category field.
 */

/**
 * Array of event types that represent server state changes.
 */
const SERVER_STATE_EVENT_TYPES_ARRAY = [
  "codon.started",
  "codon.completed",
  "state.snapshot",
  "server.idle",
  "token.usage",
  "info",
  "error",
  "checkpoint.list",
  "rollback.started",
  "rollback.progress",
  "rollback.codonCheckpoint",
  "rollback.completed",
  "rollback.rigCleanup",
  "state.transition",
] as const;

/**
 * Array of event types that represent agentic backbone events.
 */
const AGENTIC_BACKBONE_EVENT_TYPES_ARRAY = [
  "assistant.action",
  "tool.result",
  "file.updated",
  "filetree.updated",
] as const;

/**
 * Array of event types that represent sentinel events.
 */
const SENTINEL_EVENT_TYPES_ARRAY = [
  "sentinel.loaded",
  "sentinel.unloaded",
  "sentinel.error",
  "sentinel.output",
  "sentinel.triggered",
] as const;

/**
 * Array of event types that represent connection state changes.
 */
const CONNECTION_STATE_EVENT_TYPES_ARRAY = [
  "server.ready",
  "pong",
  "history.batch",
  "incomplete.codon",
] as const;

// Derive union types from the arrays
type ServerStateEventType = (typeof SERVER_STATE_EVENT_TYPES_ARRAY)[number];
type AgenticBackboneEventType = (typeof AGENTIC_BACKBONE_EVENT_TYPES_ARRAY)[number];
type SentinelEventType = (typeof SENTINEL_EVENT_TYPES_ARRAY)[number];
type ConnectionStateEventType = (typeof CONNECTION_STATE_EVENT_TYPES_ARRAY)[number];

/**
 * Set of event types that represent server state changes.
 */
const SERVER_STATE_EVENT_TYPES = new Set<ServerEventType>(SERVER_STATE_EVENT_TYPES_ARRAY);

/**
 * Set of event types that represent agentic backbone events.
 */
const AGENTIC_BACKBONE_EVENT_TYPES = new Set<ServerEventType>(AGENTIC_BACKBONE_EVENT_TYPES_ARRAY);

/**
 * Set of event types that represent sentinel events.
 */
const SENTINEL_EVENT_TYPES = new Set<ServerEventType>(SENTINEL_EVENT_TYPES_ARRAY);

/**
 * Set of event types that represent connection state changes.
 */
const CONNECTION_STATE_EVENT_TYPES = new Set<ServerEventType>(CONNECTION_STATE_EVENT_TYPES_ARRAY);

/**
 * Union type representing all server state events.
 * These events track the server's execution state and persistent changes.
 */
export type ServerStateEvent =
  | CodonStartedEvent
  | CodonCompletedEvent
  | StateSnapshotEvent
  | ServerIdleEvent
  | TokenUsageEvent
  | InfoEvent
  | ErrorEvent
  | CheckpointListEvent
  | RollbackStartedEvent
  | RollbackProgressEvent
  | RollbackCodonCheckpointEvent
  | RollbackCompletedEvent
  | RollbackRigCleanupEvent
  | StateTransitionEvent;

/**
 * Union type representing all agentic backbone events.
 * These events capture the agent's core execution artifacts.
 */
export type AgenticBackboneEvent =
  | AssistantActionEvent
  | ToolResultEvent
  | FileUpdatedEvent
  | FileTreeUpdatedEvent;

/**
 * Union type representing all sentinel events.
 * These events track sentinel lifecycle and activity.
 */
export type SentinelEvent =
  | SentinelLoadedEvent
  | SentinelUnloadedEvent
  | SentinelErrorEvent
  | SentinelOutputEvent
  | SentinelTriggeredEvent;

/**
 * Union type representing all connection state events.
 * These events track WebSocket connection lifecycle and client communication.
 */
export type ConnectionStateEvent =
  | ServerReadyEvent
  | PongEvent
  | HistoryBatchEvent
  | IncompleteCodonEvent;

// Compile-time check: ensures all ServerEventTypes are categorized
// This will cause a TypeScript error if any event is not categorized
const _assertAllEventsCategorized: AssertEqual<
  ServerEventType,
  ServerStateEventType | AgenticBackboneEventType | SentinelEventType | ConnectionStateEventType
> = true;

// Compile-time checks: ensure the union types match their respective arrays
// These will cause TypeScript errors if events are missing from the unions
const _assertServerStateEventsMatch: AssertEqual<ServerStateEvent["type"], ServerStateEventType> =
  true;

const _assertAgenticBackboneEventsMatch: AssertEqual<
  AgenticBackboneEvent["type"],
  AgenticBackboneEventType
> = true;

const _assertSentinelEventsMatch: AssertEqual<SentinelEvent["type"], SentinelEventType> = true;

const _assertConnectionStateEventsMatch: AssertEqual<
  ConnectionStateEvent["type"],
  ConnectionStateEventType
> = true;

// Compile-time check: ensure state transition event schema matches StateTransitionType
const _assertStateTransitionTypeMatch: AssertEqual<
  z.infer<typeof stateTransitionEventDataSchema>["transitionType"],
  StateTransitionType
> = true;

/**
 * Type guard to check if an event is a server state event.
 *
 * @param event - The event to check
 * @returns true if the event is a server state event
 *
 * @example
 * if (isServerStateEvent(event)) {
 *   // TypeScript narrows event to ServerStateEvent
 *   await journal.append(event);
 * }
 */
export function isServerStateEvent(event: ServerEvent): event is ServerStateEvent {
  return SERVER_STATE_EVENT_TYPES.has(event.type);
}

/**
 * Type guard to check if an event is an agentic backbone event.
 *
 * @param event - The event to check
 * @returns true if the event is an agentic backbone event
 */
export function isAgenticBackboneEvent(event: ServerEvent): event is AgenticBackboneEvent {
  return AGENTIC_BACKBONE_EVENT_TYPES.has(event.type);
}

/**
 * Type guard to check if an event is a sentinel event.
 *
 * @param event - The event to check
 * @returns true if the event is a sentinel event
 */
export function isSentinelEvent(event: ServerEvent): event is SentinelEvent {
  return SENTINEL_EVENT_TYPES.has(event.type);
}

/**
 * Type guard to check if an event is a connection state event.
 *
 * @param event - The event to check
 * @returns true if the event is a connection state event
 *
 * @example
 * if (isConnectionStateEvent(event)) {
 *   // TypeScript narrows event to ConnectionStateEvent
 *   // Handle connection-specific logic without persisting
 * }
 */
export function isConnectionStateEvent(event: ServerEvent): event is ConnectionStateEvent {
  return CONNECTION_STATE_EVENT_TYPES.has(event.type);
}

/**
 * Type guard to check if an event should be journaled.
 * Journaled events include server state, agentic backbone, and sentinel events.
 *
 * @param event - The event to check
 * @returns true if the event should be journaled
 *
 * @example
 * if (isJournaledEvent(event)) {
 *   // This event is persisted to the event journal
 *   // and broadcasted to all connected clients
 * }
 */
export function isJournaledEvent(
  event: ServerEvent,
): event is ServerStateEvent | AgenticBackboneEvent | SentinelEvent {
  return isServerStateEvent(event) || isAgenticBackboneEvent(event) || isSentinelEvent(event);
}

// Export client command types
export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type StartCodonCommand = z.infer<typeof startCodonCommandSchema>;
export type NextCodonCommand = z.infer<typeof nextCodonCommandSchema>;
export type SkipCodonCommand = z.infer<typeof skipCodonCommandSchema>;
export type RedoCodonCommand = z.infer<typeof redoCodonCommandSchema>;
export type ShutdownCommand = z.infer<typeof shutdownCommandSchema>;
export type ForceStopCommand = z.infer<typeof forceStopCommandSchema>;
export type ListCheckpointsCommand = z.infer<typeof listCheckpointsCommandSchema>;
export type RollbackToCheckpointCommand = z.infer<typeof rollbackToCheckpointCommandSchema>;
export type RollbackToCodonCommand = z.infer<typeof rollbackToCodonCommandSchema>;
export type RollbackToLastSuccessCommand = z.infer<typeof rollbackToLastSuccessCommandSchema>;
export type PingCommand = z.infer<typeof pingCommandSchema>;
export type PingBroadcastCommand = z.infer<typeof pingBroadcastCommandSchema>;
export type HistorySyncCommand = z.infer<typeof historySyncCommandSchema>;

// Export type helpers
export type ServerEventType = ServerEvent["type"];
export type ClientCommandType = ClientCommand["type"];

// Export additional types that are used elsewhere
export type ProcessExit = z.infer<typeof processExitSchema>;
export type FailureReason = z.infer<typeof failureReasonSchema>;
export type CheckpointQueryInfo = z.infer<typeof checkpointQueryInfoSchema>;
export type CodonExecution = z.infer<typeof codonExecutionSchema>;
export type { FileNode }; // Re-export the interface

// Map of event types to their data schemas (for sentinel validation)
export const serverEventDataSchemas: Record<ServerEventType, z.ZodSchema> = {
  "server.ready": serverReadyEventDataSchema,
  "state.snapshot": stateSnapshotEventDataSchema,
  "codon.started": codonStartedEventDataSchema,
  "codon.completed": codonCompletedEventDataSchema,
  "assistant.action": assistantActionEventDataSchema,
  "token.usage": tokenUsageEventDataSchema,
  "tool.result": toolResultEventDataSchema,
  "file.updated": fileUpdatedEventDataSchema,
  "filetree.updated": fileTreeUpdatedEventDataSchema,
  error: errorEventDataSchema,
  "incomplete.codon": incompleteCodonEventDataSchema,
  info: infoEventDataSchema,
  "server.idle": serverIdleEventDataSchema,
  "checkpoint.list": checkpointListEventDataSchema,
  "rollback.started": rollbackStartedEventDataSchema,
  "rollback.codonCheckpoint": rollbackCodonCheckpointEventDataSchema,
  "rollback.rigCleanup": rollbackRigCleanupEventDataSchema,
  "rollback.progress": rollbackProgressEventDataSchema,
  "rollback.completed": rollbackCompletedEventDataSchema,
  pong: pongEventDataSchema,
  "history.batch": historyBatchEventDataSchema,
  "state.transition": stateTransitionEventDataSchema,
  "sentinel.loaded": sentinelLoadedEventDataSchema,
  "sentinel.unloaded": sentinelUnloadedEventDataSchema,
  "sentinel.error": sentinelErrorEventDataSchema,
  "sentinel.output": sentinelOutputEventDataSchema,
  "sentinel.triggered": sentinelTriggeredEventDataSchema,
};

// List of all valid event types (for sentinel validation)
export const serverEventTypes = Object.keys(serverEventDataSchemas) as ServerEventType[];
