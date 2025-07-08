import type {
  AssistantActionEvent,
  ClientCommand,
  ErrorEvent,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  IncompletePhaseEvent,
  InfoEvent,
  NextPhaseCommand,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  RedoPhaseCommand,
  ServerEvent,
  ServerReadyEvent,
  ShutdownCommand,
  SkipPhaseCommand,
  StartPhaseCommand,
  StateSnapshotEvent,
  TokenUsageEvent,
} from "./types.js";

// ============================================================================
// Server Event Guards
// ============================================================================

export function isServerReadyEvent(event: ServerEvent): event is ServerReadyEvent {
  return event.type === "server.ready";
}

export function isStateSnapshotEvent(event: ServerEvent): event is StateSnapshotEvent {
  return event.type === "state.snapshot";
}

export function isPhaseStartedEvent(event: ServerEvent): event is PhaseStartedEvent {
  return (
    event.type === "phase.started" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "phaseId" in event.data
  );
}

export function isPhaseCompletedEvent(event: ServerEvent): event is PhaseCompletedEvent {
  return (
    event.type === "phase.completed" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "success" in event.data
  );
}

export function isAssistantActionEvent(event: ServerEvent): event is AssistantActionEvent {
  return (
    event.type === "assistant.action" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "action" in event.data
  );
}

export function isTokenUsageEvent(event: ServerEvent): event is TokenUsageEvent {
  return (
    event.type === "token.usage" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "inputTokens" in event.data
  );
}

export function isFileUpdatedEvent(event: ServerEvent): event is FileUpdatedEvent {
  return (
    event.type === "file.updated" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "path" in event.data
  );
}

export function isFileTreeUpdatedEvent(event: ServerEvent): event is FileTreeUpdatedEvent {
  return (
    event.type === "filetree.updated" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "tree" in event.data
  );
}

export function isErrorEvent(event: ServerEvent): event is ErrorEvent {
  return (
    event.type === "error" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "message" in event.data
  );
}

export function isInfoEvent(event: ServerEvent): event is InfoEvent {
  return (
    event.type === "info" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "message" in event.data
  );
}

export function isIncompletePhaseEvent(event: ServerEvent): event is IncompletePhaseEvent {
  return (
    event.type === "incomplete.phase" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "phaseId" in event.data
  );
}

// ============================================================================
// Client Command Guards
// ============================================================================

export function isStartPhaseCommand(cmd: ClientCommand): cmd is StartPhaseCommand {
  return (
    cmd.type === "phase.start" &&
    "data" in cmd &&
    typeof cmd.data === "object" &&
    cmd.data !== null &&
    "phaseId" in cmd.data
  );
}

export function isNextPhaseCommand(cmd: ClientCommand): cmd is NextPhaseCommand {
  return cmd.type === "phase.next";
}

export function isSkipPhaseCommand(cmd: ClientCommand): cmd is SkipPhaseCommand {
  return cmd.type === "phase.skip";
}

export function isRedoPhaseCommand(cmd: ClientCommand): cmd is RedoPhaseCommand {
  return cmd.type === "phase.redo";
}

export function isShutdownCommand(cmd: ClientCommand): cmd is ShutdownCommand {
  return cmd.type === "server.shutdown";
}
