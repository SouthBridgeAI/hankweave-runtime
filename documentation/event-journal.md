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

All server events are categorized into four mutually exclusive types, enabling intelligent routing and persistence decisions.

### Server State Events

Events that represent changes to the server's persistent execution state. These events:
- **Are persisted** to the event journal (file or memory storage)
- **Are broadcasted** to all connected clients that have completed handshake
- **Represent domain logic**: phase execution, state transitions, errors

**Event Types**:
```typescript
// Phase lifecycle
phase.started, phase.completed

// State updates
state.snapshot, server.idle, state.transition

// Execution events
token.usage

// Notifications
info, error

// Checkpoints and rollback
checkpoint.list
rollback.started, rollback.progress, rollback.phaseCheckpoint
rollback.completed, rollback.workspaceCleanup
```

### Agentic Backbone Events

Events that capture the agent's core execution artifacts. These events:
- **Are persisted** to the event journal (file or memory storage)
- **Are broadcasted** to all connected clients that have completed handshake
- **Represent agent artifacts**: Claude's actions, tool outputs, workspace mutations

These events are journaled and broadcast the same way as server state events but are tracked separately for clarity.

**Event Types**:
```typescript
// Claude's actions and tool execution
assistant.action, tool.result

// File system mutations
file.updated, filetree.updated
```

### Chronicler Events

Events that represent the lifecycle and output of the parallel Chronicler agents. These events:
- **Are persisted** to the event journal.
- **Are broadcasted** to all connected clients.
- **Represent observational work**: a layer of analysis that runs parallel to the main agent.

**Event Types**:
```typescript
// Chronicler lifecycle and activity
chronicler.loaded, chronicler.unloaded, chronicler.error, chronicler.output, chronicler.triggered
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

The system uses TypeScript's type system to ensure all events are categorized in one of the 4 categories. If you add a new event and forget to classify it, the TypeScript compiler will gently remind you about this.

### Runtime Validation

The event journal accepts server state, agentic backbone, and chronicler events, but explicitly rejects connection state events.

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

### Receiving Live Events After Sync

After the history synchronization completes (`hasMore: false`), the WebSocket connection remains open and the client continues to receive **live events** as they occur on the server.

**Important**: Live events include **Server State Events**, **Agentic Backbone Events**, and **Connection State Events**:

- **Server State Events**: Persisted events like `phase.started`, `state.transition`, `state.snapshot`, etc.
- **Agentic Backbone Events**: Persisted events like `assistant.action`, `tool.result`, `file.updated`, `filetree.updated`
- **Connection State Events**: Ephemeral events like `history.batch`, `incomplete.phase`, etc.

Clients can filter live events based on their needs:

```typescript
let historySyncComplete = false;

ws.on("message", (data) => {
  const event = JSON.parse(data);

  // Handle history sync batches
  if (event.type === "history.batch") {
    const { events, hasMore } = event.data;
    events.forEach(processHistoricalEvent);

    if (!hasMore) {
      historySyncComplete = true;
      console.log("History sync complete, now receiving live events...");
    }
    return;
  }

  // After sync completes, process live events
  if (historySyncComplete) {
    // Option 1: Process all events (both server state and connection events)
    processLiveEvent(event);
  }
});
```

This pattern enables clients to:
1. **Catch up** on historical events they missed while offline
2. **Stay synchronized** with ongoing server activity in real-time
3. **Filter events** based on their specific needs (e.g., UI updates vs. audit logging)
