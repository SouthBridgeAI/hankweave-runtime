/**
 * @deprecated This file is deprecated. Use server/schemas/websocket-log-schemas.ts instead.
 *
 * Re-exports from the new Zod-based schema file for backward compatibility.
 */

// Re-export types from event schemas for backward compatibility
export type { ClientCommand, ServerEvent } from "../schemas/event-schemas.js";
export {
  extractMessageContext,
  getMessageType,
  isClientCommand,
  isServerEvent,
  parseWebSocketLogEntry,
  safeParseWebSocketLogEntry,
  type WebSocketLogEntry,
  webSocketLogEntrySchema,
} from "../schemas/websocket-log-schemas.js";
