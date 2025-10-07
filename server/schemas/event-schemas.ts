import { z } from "zod";

// ============================================================================
// Re-usable Base Schemas
// ============================================================================

// Process exit types
const processExitSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("success") }),
  z.object({ type: z.literal("error"), code: z.number() }),
  z.object({ type: z.literal("killed"), signal: z.string() }),
]);

// Failure reason schema
const failureReasonSchema = z.object({
  type: z.enum(["timeout", "rate-limit", "api-error", "unknown"]),
  retriable: z.boolean(),
  message: z.string().optional(),
});

// Token usage schema
const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
});

// Pagination direction schema
const paginationDirectionSchema = z.enum(["forward", "backward"]);

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
  ])
);

// Phase execution schema (complete version for state snapshots)
const phaseExecutionSchema = z.object({
  phaseId: z.string(),
  phaseName: z.string().optional(),
  status: z.enum([
    "preparing",
    "starting",
    "initializing",
    "running",
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
  workspaceSetupCheckpoint: z.string().optional(),
  errorCheckpoint: z.string().optional(),
  skipCheckpoint: z.string().optional(),
});

// Checkpoint query info schema
const checkpointQueryInfoSchema = z.object({
  phaseId: z.string(),
  phaseName: z.string(),
  checkpointType: z.enum(["workspace-setup", "completed", "error", "skipped"]),
  sha: z.string(),
  status: z.enum([
    "preparing",
    "starting",
    "initializing",
    "running",
    "completed",
    "failed",
    "skipped",
  ]),
  timestamp: z.string(),
});

// ============================================================================
// Event Data Payload Schemas
// ============================================================================

export const serverReadyEventDataSchema = z.object({
  serverVersion: z.string(),
  executionPath: z.string(),
  dataPath: z.string(),
});

export const stateSnapshotEventDataSchema = z.object({
  currentPhase: phaseExecutionSchema.optional(),
  completedPhases: z.array(phaseExecutionSchema),
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

export const phaseStartedEventDataSchema = z.object({
  phaseId: z.string(),
  phaseName: z.string(),
  phaseDescription: z.string().optional(),
  sessionId: z.string(),
  previousSessionId: z.string().optional(),
  startTime: z.string().datetime(),
});

export const phaseCompletedEventDataSchema = z.object({
  phaseId: z.string(),
  success: z.boolean(),
  cost: z.number(),
  duration: z.number(),
  exitStatus: processExitSchema,
  failureReason: failureReasonSchema.optional(),
});

export const assistantActionEventDataSchema = z.object({
  phaseId: z.string(),
  action: z.enum(["thinking", "message", "tool_use"]),
  content: z.string(),
  toolName: z.string().optional(),
  toolInput: z.record(z.unknown()).optional(),
});

export const tokenUsageEventDataSchema = z.object({
  phaseId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  totalCost: z.number(),
});

export const toolResultEventDataSchema = z.object({
  phaseId: z.string(),
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
  phase: z.string().optional(),
  fatal: z.boolean(),
  severity: z.enum(["fatal", "phase", "operation", "warning"]).optional(),
  context: z.string().optional(),
  code: z.string().optional(),
});

export const incompletePhaseEventDataSchema = z.object({
  phaseId: z.string(),
  phaseName: z.string(),
  message: z.string(),
});

export const infoEventDataSchema = z.object({
  message: z.string(),
});

export const serverIdleEventDataSchema = z.object({
  reason: z.enum(["startup", "phase-completed", "all-phases-completed"]),
  message: z.string(),
});

export const checkpointListEventDataSchema = z.object({
  runId: z.string(),
  checkpoints: z.array(checkpointQueryInfoSchema),
  currentBranch: z.string(),
});

export const rollbackStartedEventDataSchema = z.object({
  fromRun: z.string(),
  fromPhase: z.string(),
  toPhase: z.string(),
  toCheckpoint: z.string(),
  checkpointType: z.string(),
  phasesToProcess: z.array(z.string()),
});

export const rollbackPhaseCheckpointEventDataSchema = z.object({
  phaseId: z.string(),
  phaseName: z.string(),
  checkpoint: z.string(),
  checkpointType: z.string(),
  message: z.string(),
});

export const rollbackWorkspaceCleanupEventDataSchema = z.object({
  phaseId: z.string(),
  phaseName: z.string(),
  directories: z.array(z.string()),
  status: z.enum(["started", "completed", "failed", "partial"]),
  successfulCleanups: z.array(z.string()).optional(),
  failedCleanups: z
    .array(
      z.object({
        directory: z.string(),
        error: z.string(),
      })
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
  phaseId: z.string(),
  phaseName: z.string(),
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

// ============================================================================
// Full Event Schemas
// ============================================================================

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

export const phaseStartedEventSchema = baseEventSchema.extend({
  type: z.literal("phase.started"),
  data: phaseStartedEventDataSchema,
});

export const phaseCompletedEventSchema = baseEventSchema.extend({
  type: z.literal("phase.completed"),
  data: phaseCompletedEventDataSchema,
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

export const incompletePhaseEventSchema = baseEventSchema.extend({
  type: z.literal("incomplete.phase"),
  data: incompletePhaseEventDataSchema,
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

export const rollbackPhaseCheckpointEventSchema = baseEventSchema.extend({
  type: z.literal("rollback.phaseCheckpoint"),
  data: rollbackPhaseCheckpointEventDataSchema,
});

export const rollbackWorkspaceCleanupEventSchema = baseEventSchema.extend({
  type: z.literal("rollback.workspaceCleanup"),
  data: rollbackWorkspaceCleanupEventDataSchema,
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

// ============================================================================
// Client Command Schemas
// ============================================================================

export const startPhaseCommandSchema = z.object({
  id: z.string(),
  type: z.literal("phase.start"),
  data: z.object({
    phaseId: z.string(),
    skipPreCommands: z.boolean().optional(),
  }),
});

export const nextPhaseCommandSchema = z.object({
  id: z.string(),
  type: z.literal("phase.next"),
});

export const skipPhaseCommandSchema = z.object({
  id: z.string(),
  type: z.literal("phase.skip"),
});

export const redoPhaseCommandSchema = z.object({
  id: z.string(),
  type: z.literal("phase.redo"),
});

export const shutdownCommandSchema = z.object({
  id: z.string(),
  type: z.literal("server.shutdown"),
});

export const forceStopCommandSchema = z.object({
  id: z.string(),
  type: z.literal("phase.forceStop"),
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

export const rollbackToPhaseCommandSchema = z.object({
  id: z.string(),
  type: z.literal("rollback.toPhase"),
  data: z.object({
    phaseId: z.string(),
    checkpointType: z.enum([
      "start",
      "end",
      "workspace-setup",
      "completed",
      "error",
      "skipped",
    ]),
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
  startPhaseCommandSchema,
  nextPhaseCommandSchema,
  skipPhaseCommandSchema,
  redoPhaseCommandSchema,
  shutdownCommandSchema,
  forceStopCommandSchema,
  listCheckpointsCommandSchema,
  rollbackToCheckpointCommandSchema,
  rollbackToPhaseCommandSchema,
  rollbackToLastSuccessCommandSchema,
  pingCommandSchema,
  pingBroadcastCommandSchema,
  historySyncCommandSchema,
]);

// ============================================================================
// Master Discriminated Union
// ============================================================================

export const serverEventSchema = z.discriminatedUnion("type", [
  serverReadyEventSchema,
  stateSnapshotEventSchema,
  phaseStartedEventSchema,
  phaseCompletedEventSchema,
  assistantActionEventSchema,
  tokenUsageEventSchema,
  toolResultEventSchema,
  fileUpdatedEventSchema,
  fileTreeUpdatedEventSchema,
  errorEventSchema,
  incompletePhaseEventSchema,
  infoEventSchema,
  serverIdleEventSchema,
  checkpointListEventSchema,
  rollbackStartedEventSchema,
  rollbackPhaseCheckpointEventSchema,
  rollbackWorkspaceCleanupEventSchema,
  rollbackProgressEventSchema,
  rollbackCompletedEventSchema,
  pongEventSchema,
  historyBatchEventSchema,
]);

// ============================================================================
// Inferred TypeScript Types
// ============================================================================

// Export the master union type
export type ServerEvent = z.infer<typeof serverEventSchema>;

// Export individual event types for convenience
export type ServerReadyEvent = z.infer<typeof serverReadyEventSchema>;
export type StateSnapshotEvent = z.infer<typeof stateSnapshotEventSchema>;
export type PhaseStartedEvent = z.infer<typeof phaseStartedEventSchema>;
export type PhaseCompletedEvent = z.infer<typeof phaseCompletedEventSchema>;
export type AssistantActionEvent = z.infer<typeof assistantActionEventSchema>;
export type TokenUsageEvent = z.infer<typeof tokenUsageEventSchema>;
export type ToolResultEvent = z.infer<typeof toolResultEventSchema>;
export type FileUpdatedEvent = z.infer<typeof fileUpdatedEventSchema>;
export type FileTreeUpdatedEvent = z.infer<typeof fileTreeUpdatedEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
export type IncompletePhaseEvent = z.infer<typeof incompletePhaseEventSchema>;
export type InfoEvent = z.infer<typeof infoEventSchema>;
export type ServerIdleEvent = z.infer<typeof serverIdleEventSchema>;
export type CheckpointListEvent = z.infer<typeof checkpointListEventSchema>;
export type RollbackStartedEvent = z.infer<typeof rollbackStartedEventSchema>;
export type RollbackPhaseCheckpointEvent = z.infer<
  typeof rollbackPhaseCheckpointEventSchema
>;
export type RollbackWorkspaceCleanupEvent = z.infer<
  typeof rollbackWorkspaceCleanupEventSchema
>;
export type RollbackProgressEvent = z.infer<typeof rollbackProgressEventSchema>;
export type RollbackCompletedEvent = z.infer<
  typeof rollbackCompletedEventSchema
>;
export type PongEvent = z.infer<typeof pongEventSchema>;
export type HistoryBatchEvent = z.infer<typeof historyBatchEventSchema>;

// Export client command types
export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type StartPhaseCommand = z.infer<typeof startPhaseCommandSchema>;
export type NextPhaseCommand = z.infer<typeof nextPhaseCommandSchema>;
export type SkipPhaseCommand = z.infer<typeof skipPhaseCommandSchema>;
export type RedoPhaseCommand = z.infer<typeof redoPhaseCommandSchema>;
export type ShutdownCommand = z.infer<typeof shutdownCommandSchema>;
export type ForceStopCommand = z.infer<typeof forceStopCommandSchema>;
export type ListCheckpointsCommand = z.infer<
  typeof listCheckpointsCommandSchema
>;
export type RollbackToCheckpointCommand = z.infer<
  typeof rollbackToCheckpointCommandSchema
>;
export type RollbackToPhaseCommand = z.infer<
  typeof rollbackToPhaseCommandSchema
>;
export type RollbackToLastSuccessCommand = z.infer<
  typeof rollbackToLastSuccessCommandSchema
>;
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
export type PhaseExecution = z.infer<typeof phaseExecutionSchema>;
export type { FileNode }; // Re-export the interface

// Map of event types to their data schemas (for chronicler validation)
export const serverEventDataSchemas: Record<ServerEventType, z.ZodSchema> = {
  "server.ready": serverReadyEventDataSchema,
  "state.snapshot": stateSnapshotEventDataSchema,
  "phase.started": phaseStartedEventDataSchema,
  "phase.completed": phaseCompletedEventDataSchema,
  "assistant.action": assistantActionEventDataSchema,
  "token.usage": tokenUsageEventDataSchema,
  "tool.result": toolResultEventDataSchema,
  "file.updated": fileUpdatedEventDataSchema,
  "filetree.updated": fileTreeUpdatedEventDataSchema,
  error: errorEventDataSchema,
  "incomplete.phase": incompletePhaseEventDataSchema,
  info: infoEventDataSchema,
  "server.idle": serverIdleEventDataSchema,
  "checkpoint.list": checkpointListEventDataSchema,
  "rollback.started": rollbackStartedEventDataSchema,
  "rollback.phaseCheckpoint": rollbackPhaseCheckpointEventDataSchema,
  "rollback.workspaceCleanup": rollbackWorkspaceCleanupEventDataSchema,
  "rollback.progress": rollbackProgressEventDataSchema,
  "rollback.completed": rollbackCompletedEventDataSchema,
  pong: pongEventDataSchema,
  "history.batch": historyBatchEventDataSchema,
};

// List of all valid event types (for chronicler validation)
export const serverEventTypes = Object.keys(
  serverEventDataSchemas
) as ServerEventType[];
