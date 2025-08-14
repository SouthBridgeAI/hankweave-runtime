import type { ClientCommand, ServerEvent } from "./types.js";

/**
 * WebSocket log entry format for JSONL logging.
 *
 * This wraps the actual WebSocket messages with minimal additional metadata.
 * We avoid duplicating fields that already exist in the underlying packets
 * (e.g., timestamp, id are already in ServerEvent).
 */
export interface WebSocketLogEntry {
  /** ISO 8601 timestamp of when the message was logged (not the message's own timestamp) */
  loggedAt: string;

  /** Direction of the message flow */
  direction: "in" | "out";

  /** The actual WebSocket message data */
  message: ClientCommand | ServerEvent;

  /**
   * Optional metadata that isn't in the message itself.
   * We only add fields here that aren't already present in the message.
   */
  metadata?: {
    /** Size of the message in bytes */
    size?: number;
    /** Any errors that occurred during processing */
    error?: string;
  };
}

/**
 * Helper type guard to check if a message is a ServerEvent
 */
export function isServerEvent(message: ClientCommand | ServerEvent): message is ServerEvent {
  return "timestamp" in message;
}

/**
 * Helper type guard to check if a message is a ClientCommand
 */
export function isClientCommand(message: ClientCommand | ServerEvent): message is ClientCommand {
  return !("timestamp" in message);
}

/**
 * Extract the message type from a WebSocket message
 */
export function getMessageType(message: ClientCommand | ServerEvent): string {
  return message.type;
}

/**
 * Extract relevant context from a message for quick reference
 */
export function extractMessageContext(
  message: ClientCommand | ServerEvent,
): Record<string, unknown> {
  const context: Record<string, unknown> = {};

  // Extract phase ID if present
  if ("data" in message && message.data) {
    const data = message.data as Record<string, unknown>;
    if ("phaseId" in data) {
      context.phaseId = data.phaseId;
    }
    if ("sessionId" in data) {
      context.sessionId = data.sessionId;
    }
    if ("runId" in data) {
      context.runId = data.runId;
    }
  }

  return context;
}
