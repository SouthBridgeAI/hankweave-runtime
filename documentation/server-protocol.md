# Tadpole Server Protocol

## Overview

The Tadpole server operates on a WebSocket-based protocol designed for real-time, bidirectional communication between the server and a client. This approach enables a highly interactive and transparent experience, allowing clients to monitor Claude's activity, control the execution flow, and receive immediate updates on file system changes and state transitions.

The server runs on port 7777 by default. All messages exchanged are JSON-encoded and adhere to a strict schema, ensuring type safety and predictable interactions.

## Connection Model

The connection model is designed for simplicity and state consistency:

- **Single Client**: The server enforces a strict single-client model. This is a deliberate design choice to prevent conflicting commands and ensure that the project state remains consistent and predictable. If a client is already connected, any new connection attempts are rejected with WebSocket close code `1008`.

- **Automatic Shutdown**: To ensure clean resource management and prevent orphaned processes, the server is designed to shut down gracefully when its client disconnects. This ties the server's lifecycle directly to the client's session.

- **Lock File**: On startup, the server creates a lock file at `.tadpole/server.lock`. This file contains the server's process ID (PID) and the current run ID. This mechanism prevents multiple server instances from running in the same project directory, which would otherwise lead to state corruption and race conditions. The lock file also includes a heartbeat timestamp, allowing the server to detect and clean up stale locks from crashed previous sessions.

### Connection Flow Diagram
```
Client                    Server
  │                         │
  ├──── Connect WS ────────>│
  │                         ├─ Check for existing clients
  │                         ├─ Create/verify lock file
  │<──── server.ready ──────┤
  │<─── state.snapshot ─────┤
  │                         │
  │─── phase.start ────────>│
  │<──── phase.started ─────┤
  │<─── assistant.action ───┤ (streaming)
  │<──── token.usage ───────┤ (periodic)
  │<─── phase.completed ────┤
  │                         │
  │──── Disconnect ─────────>│
  │                         ├─ Kill Claude process
  │                         ├─ Save final state
  │                         └─ Remove lock file
```

### WebSocket Close Codes
- `1000`: Normal closure
- `1001`: Going away (server shutdown)
- `1006`: Abnormal closure (connection lost)
- `1008`: Policy violation (client already connected)
- `1011`: Internal server error

## Message Format

### Base Message Structure

All communication, whether from client to server (Commands) or server to client (Events), follows a consistent base structure. This uniformity simplifies message parsing and handling.

```typescript
{
  "id": string,        // A unique identifier for the message, used for correlation.
  "timestamp": string, // An ISO 8601 timestamp (present in server events only).
  "type": string,      // A string identifying the message type for routing.
  "data"?: object      // An optional payload containing type-specific data.
}
```

## Client Commands (Client → Server)

Clients send commands to control the server's execution flow, manage phases, and query state.

### Phase Control Commands

These commands are used to direct the phase execution lifecycle.

#### `phase.start`
Initiates the execution of a specific phase by its unique ID. This is typically used for manual control when autostart is disabled or to retry a specific phase from a previous run.

- `skipPreCommands`: An optional boolean that, when `true`, skips the `workspaceSetup` operations for the phase. This is useful when retrying a phase where the setup has already been completed and doesn't need to be repeated.

```json
{
  "id": "cmd-123",
  "type": "phase.start",
  "data": {
    "phaseId": "phase-1-analysis",
    "skipPreCommands": false
  }
}
```

#### `phase.next`
The standard command to advance the workflow. The server uses its internal execution thread logic to determine the next phase in the sequence and starts it.

```json
{
  "id": "cmd-124",
  "type": "phase.next"
}
```

#### `phase.skip`
Instructs the server to gracefully terminate the currently running phase. The phase is marked as `skipped` in the state history. If autostart is enabled, the server will automatically proceed to the next phase.

```json
{
  "id": "cmd-125",
  "type": "phase.skip"
}
```

#### `phase.redo`
Allows for re-running the most recently executed phase, regardless of its completion status. This is useful for iterating on a specific step without rolling back.

```json
{
  "id": "cmd-126",
  "type": "phase.redo"
}
```

#### `phase.forceStop`
Immediately terminates the current phase and marks it as `failed`. This is a more forceful action than `skip` and is intended for situations where a phase is stuck or producing incorrect results. A forced stop may halt the entire run if the failure is considered non-retriable.

```json
{
  "id": "cmd-127",
  "type": "phase.forceStop",
  "data": {
    "reason": "User intervention"
  }
}
```

### Checkpoint & Rollback Commands

These commands interact with the versioning system to manage and revert project state.

#### `checkpoint.list`
A read-only query to retrieve a list of all available checkpoints for a given run. This is used to identify potential targets for a rollback.

- `runId`: Optional. If omitted, checkpoints for the current run are returned.

```json
{
  "id": "cmd-128",
  "type": "checkpoint.list",
  "data": {
    "runId": "1737288000000-abc12"
  }
}
```

#### `rollback.toCheckpoint`
Reverts the project's file state and execution history to a specific checkpoint, identified by its Git SHA. The server supports partial SHAs for convenience, as long as they are unique.

- `autoRestart`: If `true`, the server will attempt to automatically start the next phase after the rollback is complete.

```json
{
  "id": "cmd-129",
  "type": "rollback.toCheckpoint",
  "data": {
    "checkpointSha": "a1b2c3d",
    "autoRestart": false
  }
}
```

#### `rollback.toPhase`
A more abstract way to roll back. Instead of a specific SHA, you specify a target phase and a checkpoint type. The server resolves this to the correct checkpoint SHA from the execution history.

**Checkpoint Types:**
- `"workspace-setup"`: After workspace setup, before Claude starts
- `"completed"`: After successful completion
- `"error"`: After failure (if checkpoint was created)
- `"skipped"`: After skip
- `"start"`: Alias for workspace-setup
- `"end"`: Latest checkpoint for the phase

```json
{
  "id": "cmd-130",
  "type": "rollback.toPhase",
  "data": {
    "phaseId": "phase-2",
    "checkpointType": "completed",
    "autoRestart": false
  }
}
```

#### `rollback.toLastSuccess`
A convenient command to revert to the completion checkpoint of the last successfully executed phase in the history.

```json
{
  "id": "cmd-131",
  "type": "rollback.toLastSuccess",
  "data": {
    "autoRestart": true
  }
}
```

### Server Control

#### `server.shutdown`
Requests a graceful shutdown of the server. The server will clean up resources, remove the lock file, and terminate the process.

```json
{
  "id": "cmd-132",
  "type": "server.shutdown"
}
```

## Server Events (Server → Client)

The server emits events to keep the client informed about its state, Claude's activity, and changes in the project workspace.

### Connection & State Events

#### `server.ready`
The initial handshake event, sent once a client connects successfully. It provides essential server information.

```json
{
  "id": "evt-001",
  "timestamp": "2025-01-19T10:00:00Z",
  "type": "server.ready",
  "data": {
    "serverVersion": "1.0.0",
    "executionPath": "/home/.tadpole-executions/1234-abc",
    "dataPath": "/home/.tadpole-executions/1234-abc/data"
  }
}
```

**Note**: Prior to execution isolation, this event included `projectPath`. This has been replaced with:
- `executionPath`: Where the server operates and all Tadpole artifacts are stored
- `dataPath`: Where the user's original data is accessible (via symlink or copy)

#### `state.snapshot`
A comprehensive snapshot of the server's current state. It's sent after `server.ready` and after major state changes (like phase completion or rollback). This event is the primary source of truth for the client to build its own state representation.

```json
{
  "id": "evt-002",
  "timestamp": "2025-01-19T10:00:05Z",
  "type": "state.snapshot",
  "data": {
    "currentPhase": { "...PhaseExecution object..." },
    "completedPhases": [ "..." ],
    "fileTree": [ "...FileNode array..." ],
    "totalCost": 1.23,
    "totalTime": 300000,
    "recentFileAccess": { "...details..." },
    "isRollingBack": false
  }
}
```

### Phase Lifecycle Events

#### `phase.started`
Announces the beginning of a phase's execution, after workspace setup is complete and the Claude process has been spawned.

```json
{
  "id": "evt-003",
  "timestamp": "2025-01-19T10:00:10Z",
  "type": "phase.started",
  "data": {
    "phaseId": "phase-1",
    "phaseName": "Initial Analysis",
    "sessionId": "session-uuid-123",
    "startTime": "2025-01-19T10:00:10Z"
  }
}
```

#### `phase.completed`
Marks the end of a phase's execution, providing a summary of its outcome, cost, and duration.

- `failureReason`: If `success` is `false`, this object provides structured information about the error, including whether it's considered retriable.

```json
{
  "id": "evt-004",
  "timestamp": "2025-01-19T10:05:10Z",
  "type": "phase.completed",
  "data": {
    "phaseId": "phase-1",
    "success": true,
    "cost": 0.0123,
    "duration": 300000,
    "exitStatus": { "type": "success" }
  }
}
```

### Claude Activity Events

#### `assistant.action`
A real-time stream of Claude's actions, parsed from its log output. This provides a live view into Claude's "thought process" and tool usage.

```json
{
  "id": "evt-005",
  "timestamp": "2025-01-19T10:01:00Z",
  "type": "assistant.action",
  "data": {
    "phaseId": "phase-1",
    "action": "tool_use",
    "toolName": "Read",
    "toolInput": { "file_path": "src/index.ts" }
  }
}
```

#### `token.usage`
Provides a real-time update on token consumption and associated costs after each interaction with the Claude API that reports usage.

```json
{
  "id": "evt-006",
  "timestamp": "2025-01-19T10:01:05Z",
  "type": "token.usage",
  "data": {
    "phaseId": "phase-1",
    "inputTokens": 1024,
    "outputTokens": 512,
    "totalCost": 0.0045
  }
}
```

### File System Events

#### `file.updated`
Notifies the client of a change (creation, modification, or deletion) to a file being tracked in the current phase.

```json
{
  "id": "evt-007",
  "timestamp": "2025-01-19T10:02:00Z",
  "type": "file.updated",
  "data": {
    "path": "src/index.ts",
    "filename": "index.ts",
    "content": "...",
    "action": "modified"
  }
}
```

#### `filetree.updated`
Sent after a `file.updated` event to provide the client with the new, complete structure of all tracked files.

```json
{
  "id": "evt-008",
  "timestamp": "2025-01-19T10:02:00Z",
  "type": "filetree.updated",
  "data": {
    "tree": [ "...FileNode array..." ]
  }
}
```

### Status & Rollback Events

#### `server.idle`
Indicates that the server is not executing any phase and is waiting for a command. This happens when autostart is disabled or when all phases have been completed.

```json
{
  "id": "evt-009",
  "timestamp": "2025-01-19T10:05:10Z",
  "type": "server.idle",
  "data": {
    "reason": "phase-completed",
    "message": "Phase phase-1 completed. Use 'phase.next' to continue."
  }
}
```

#### `error`
Communicates an error to the client. The `fatal` flag indicates whether the server will shut down as a result.

```json
{
  "id": "evt-010",
  "timestamp": "2025-01-19T10:00:05Z",
  "type": "error",
  "data": {
    "message": "Configuration file not found",
    "fatal": true,
    "severity": "fatal"
  }
}
```

#### Rollback Events (`rollback.started`, `rollback.progress`, etc.)
A series of events that provide detailed, step-by-step feedback during a rollback operation, allowing the client to display a rich progress indicator to the user.

## Protocol Behavior

### Connection Lifecycle
The typical connection flow is designed to quickly synchronize the client with the server's state:
1.  The client establishes a WebSocket connection.
2.  The server immediately responds with a `server.ready` event.
3.  This is followed by a comprehensive `state.snapshot` event.
4.  If `autostart` is enabled, the server proceeds to start the first phase. Otherwise, it sends a `server.idle` event and waits for commands.

### Command Processing
The server processes commands sequentially to maintain state integrity. Most commands that modify state (e.g., starting or stopping a phase) are blocked during a rollback operation to prevent conflicts. Read-only queries like `checkpoint.list` are always permitted.

### State Consistency
The protocol is backed by a robust state manager that ensures consistency. All state changes are validated and persisted atomically to disk before any corresponding events are sent to the client. This guarantees that the client's view of the state, as informed by events, accurately reflects the persisted reality, even in the event of a crash.

### Event Ordering
The server provides strong guarantees about the order of events, which simplifies client-side logic:
- Phase lifecycle events (`phase.started`, `phase.completed`) will always be sent in the correct sequence for a given phase.
- A `state.snapshot` always reflects the state *after* the event that triggered it (e.g., after a `phase.completed` event).
- File system events (`file.updated`, `filetree.updated`) are sent as changes are detected during a phase's execution.

### Message Size Limits
- Maximum message size: 10MB (configurable in WebSocket options)
- Large file contents in `file.updated` events may be truncated
- Binary files are not included in file update events
- For very large state snapshots, consider pagination (future feature)

### Error Handling
When errors occur, the server sends structured error events:

```json
{
  "id": "evt-err-001",
  "timestamp": "2025-01-19T10:00:00Z",
  "type": "error",
  "data": {
    "code": "PHASE_TIMEOUT",
    "message": "Phase execution timed out after 30 minutes",
    "details": {
      "phaseId": "phase-1",
      "elapsed": 1800000
    },
    "fatal": false,
    "retriable": true,
    "severity": "error"
  }
}
```

**Error Codes:**
- `CONFIG_INVALID`: Phase configuration error
- `CLAUDE_NOT_FOUND`: Claude CLI not available
- `API_ERROR`: Claude API error (rate limit, auth, etc.)
- `PHASE_TIMEOUT`: Phase took too long
- `STATE_CORRUPTED`: State file corruption detected
- `GIT_ERROR`: Checkpoint operation failed
- `WORKSPACE_SETUP_FAILED`: Copy/command failed
- `INTERNAL_ERROR`: Unexpected server error
