import { z } from "zod";
import {
  type ClientCommand,
  clientCommandSchema,
  type ServerEvent,
  serverEventSchema,
} from "./event-schemas.js";

/**
 * WebSocket log entry schema for JSONL logging.
 *
 * This wraps the actual WebSocket messages with minimal additional metadata.
 * We avoid duplicating fields that already exist in the underlying packets
 * (e.g., timestamp, id are already in ServerEvent).
 */
export const webSocketLogEntrySchema = z.object({
  /** ISO 8601 timestamp of when the message was logged (not the message's own timestamp) */
  loggedAt: z.string().datetime(),

  /** Direction of the message flow */
  direction: z.enum(["in", "out"]),

  /** The actual WebSocket message data */
  message: z.union([clientCommandSchema, serverEventSchema]),

  /**
   * Optional metadata that isn't in the message itself.
   * We only add fields here that aren't already present in the message.
   */
  metadata: z
    .object({
      /** Size of the message in bytes */
      size: z.number().optional(),
      /** Any errors that occurred during processing */
      error: z.string().optional(),
    })
    .optional(),
});

/**
 * Inferred TypeScript type from the Zod schema
 */
export type WebSocketLogEntry = z.infer<typeof webSocketLogEntrySchema>;

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

  // Extract codon ID if present
  if ("data" in message && message.data) {
    const data = message.data as Record<string, unknown>;
    if ("codonId" in data) {
      context.codonId = data.codonId;
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

/**
 * Validate and parse a WebSocket log entry
 */
export function parseWebSocketLogEntry(data: unknown): WebSocketLogEntry {
  return webSocketLogEntrySchema.parse(data);
}

/**
 * Safely parse a WebSocket log entry, returning undefined if invalid
 */
export function safeParseWebSocketLogEntry(data: unknown): WebSocketLogEntry | undefined {
  const result = webSocketLogEntrySchema.safeParse(data);
  return result.success ? result.data : undefined;
}
