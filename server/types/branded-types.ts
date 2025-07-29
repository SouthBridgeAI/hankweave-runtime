/**
 * Branded types for type safety and clarity
 */

// Helper type for branding
type Branded<T, Brand> = T & { __brand: Brand };

// Phase ID - references a phase configuration
export type PhaseId = Branded<string, "PhaseId">;
export const PhaseId = (id: string): PhaseId => id as PhaseId;

// Session ID - Claude's session UUID
export type SessionId = Branded<string, "SessionId">;
export const SessionId = (id: string): SessionId => id as SessionId;

// Run ID - Unique identifier for a server run
export type RunId = Branded<string, "RunId">;
export const RunId = (id: string): RunId => id as RunId;

// Event ID - Unique identifier for WebSocket events
export type EventId = Branded<string, "EventId">;
export const EventId = (id: string): EventId => id as EventId;
