# Event Journal System

## Overview

The Tadpole Server Event Journal is a logging and event tracking system that serves as the **single source of truth** for all server activity. It is a unified event stream that is both persisted to disk and broadcasted to connected clients.

The Event Journal provides:
- **Audit trail** of all server state changes
- **Event history synchronization** for clients
- **Type-safe event schemas** with runtime validation
- **Intelligent event routing** with compile-time safety guarantees
- **Pluggable storage backends** (memory or file-based)

All server state events are stored at:

```
.tadpole/events/events.jsonl
```

## Event Journal Architecture

The Event Journal is built on a layered architecture with pluggable storage backends.

### Memory Storage Implementation

**Location**: `server/storage/memory-event-storage.ts`

In-memory event storage with configurable limits:
- Fast access for development and testing
- Configurable maximum events (default: 10,000)
- Automatic event rotation when limit reached
- No disk I/O overhead

### File Storage Implementation

**Location**: `server/storage/file-event-storage.ts`

Persistent JSONL-based event storage:
- Append-only file format (`.tadpole/events/events.jsonl`)
- Atomic writes with proper error handling
- Crash recovery on server restart
- Suitable for production use

### Event Journal Core

**Location**: `server/event-journal.ts`

High-level event management and querying:
- Event appending with validation
- Pagination support
- Filtering by event category
- Timestamp-based queries
- Integration with storage backends

## Event Categories & Routing

All server events are categorized into two mutually exclusive types, enabling intelligent routing and persistence decisions.

### Server State Events

Events that represent changes to the server's persistent execution state. These events:
- **Are persisted** to the event journal (file or memory storage)
- **Are broadcasted** to all connected clients that have completed handshake
- **Represent domain logic**: phase execution, file changes, Claude's actions, errors

**Event Types**:
```typescript
// Phase lifecycle
phase.started, phase.completed

// State updates
state.snapshot, server.idle, state.transition

// Execution events
assistant.action, token.usage, tool.result

// File system events
file.updated, filetree.updated

// Notifications
info, error

// Checkpoints and rollback
checkpoint.list
rollback.started, rollback.progress, rollback.phaseCheckpoint
rollback.completed, rollback.workspaceCleanup
```

### Connection State Events

Events specific to individual client connections. These events:
- **Are NOT persisted** to the event journal (ephemeral)
- **Are sent to individual clients** (not broadcasted)
- **Represent connection logic**: handshake, ping/pong, history sync

**Event Types**:
```typescript
server.ready        // Sent to specific client after connection
pong                // Response to specific client's ping
history.batch       // Streamed to requesting client only
incomplete.phase    // Client-specific warning
```

### Compile-Time Safety Guarantees

The system uses TypeScript's type system to ensure all events are categorized in one of the 2 categories. If you add a new event and forget to classify it, typescript compiler will gently remind you about this.

### Runtime Validation

The event journal explicitly rejects connection state events.

## Event Schemas

**Location**: `server/schemas/event-schemas.ts`

All events are defined using Zod schemas, providing:
- **Runtime validation** of event structure
- **TypeScript type inference** from schemas
- **Compile-time event category checks**
- **Automatic type safety** throughout the codebase

### JSONL Structure

Each line in the file is a complete JSON object representing a single server event. Events follow the structure defined in the event schemas.

**Example: Phase Started Event**
```json
{
  "id": "evt-abc123",
  "timestamp": "2025-10-28T10:30:00.000Z",
  "type": "phase.started",
  "data": {
    "phaseId": "phase-1",
    "runId": "run-456",
    "phaseName": "planning",
    "phaseConfig": { ... }
  }
}
```

**Example: State Transition Event**
```json
{
  "id": "evt-def456",
  "timestamp": "2025-10-28T10:30:01.000Z",
  "type": "state.transition",
  "data": {
    "transitionType": "PhaseStarted",
    "runId": "run-456",
    "phaseId": "phase-1",
    "transition": {
      "type": "PhaseStarted",
      "data": { "runId": "run-456", "phaseId": "phase-1" }
    },
    "resultingState": {
      "currentRunId": "run-456",
      "runCount": 3,
      "totalCost": 0.0042,
      "currentRunCost": 0.0012
    }
  }
}
```

**Example: File Updated Event**
```json
{
  "id": "evt-ghi789",
  "timestamp": "2025-10-28T10:30:05.000Z",
  "type": "file.updated",
  "data": {
    "path": "src/main.ts",
    "operation": "modified",
    "size": 1234
  }
}
```

### History Synchronization (Client-Side)

Clients can request event history through the WebSocket protocol:

```typescript
// Send history.sync command
ws.send(JSON.stringify({
  id: "cmd-123",
  type: "history.sync"
}));

// Receive streamed history.batch events
ws.on("message", (data) => {
  const event = JSON.parse(data);

  if (event.type === "history.batch") {
    const { events, hasMore } = event.data;

    // Process batch of events
    events.forEach(processEvent);

    // Check if more batches are coming
    if (hasMore) {
      console.log("More events coming...");
    } else {
      console.log("History sync complete");
    }
  }
});
```
