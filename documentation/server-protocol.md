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
  │─── handshake ──────────>│
  │                         ├─ Grant mode & optionally gather history
  │<─ handshake.response ───┤
  │<──── server.ready ──────┤
  │<─── state.snapshot ─────┤
  │                         │
  │─── history.sync ───────>│ (optional)
  │<──── history.batch ─────┤ (streamed batches)
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

## Handshake Protocol

Before sending commands or receiving events, clients must complete a handshake with the server. The server buffers all domain events until the handshake is acknowledged, ensuring both sides agree on permissions and synchronization behavior.

### Handshake Request

The client initiates the handshake by sending:

```json
{
  "type": "handshake",
  "data": {
    "mode": "readandwrite",
    "sendPreviousEvents": true
  }
}
```

- `mode`: Either `"readonly"` or `"readandwrite"` to specify access level
- `sendPreviousEvents`: Optional boolean (default: `false`). When `true`, the server includes up to `handshakeHistoryLimit` recent events in the handshake response. When omitted or `false`, the response contains an empty history and the client can opt into a later sync.

### Handshake Response

The server responds with:

```json
{
  "type": "handshake.response",
  "data": {
    "clientId": "client-123",
    "mode": "readandwrite",
    "eventHistory": [...],
    "totalEvents": 1500
  }
}
```

- `clientId`: The server-assigned unique client ID
- `mode`: The granted access mode (may differ from requested)
- `eventHistory`: Chronologically ordered recent events when `sendPreviousEvents` was `true`; otherwise an empty array
- `cursor`: Reserved for future pagination support (currently always `null`)
- `totalEvents`: Count of events currently stored in the journal. This can be larger than `eventHistory.length`, signalling that additional history is available via `history.sync`.

Immediately after acknowledging the handshake, the server emits `server.ready` followed by a `state.snapshot`, then resumes real-time event delivery.

### Example Client Flow

The following TypeScript example uses the `ws` WebSocket client to:

- establish a connection and complete the handshake,
- request the full event history when more events are available than were included in the handshake response, and
- handle real-time events alongside streamed history batches.

```ts
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:7777");

const handleServerEvent = (event: any) => {
  console.log(`[event] ${event.type}`, event);
};

const sendHistorySync = () => {
  const command = {
    id: `cmd-history-sync-${Date.now()}`,
    type: "history.sync",
  };
  ws.send(JSON.stringify(command));
};

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "handshake",
      data: {
        mode: "readandwrite",
        sendPreviousEvents: true,
      },
    }),
  );
});

ws.on("message", (raw) => {
  const message = JSON.parse(raw.toString());

  switch (message.type) {
    case "handshake.response": {
      const { clientId, eventHistory, totalEvents } = message.data;
      console.log(`Handshake complete. Server recognized client ${clientId}.`);

      // Process the initial batch of recent events (if requested)
      eventHistory.forEach(handleServerEvent);

      if (totalEvents > eventHistory.length) {
        sendHistorySync();
      }
      break;
    }

    case "history.batch": {
      message.data.events.forEach(handleServerEvent);

      if (!message.data.hasMore) {
        console.log("History synchronization complete.");
      }
      break;
    }

    default: {
      // All other messages are real-time server events
      handleServerEvent(message);
    }
  }
});
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

### History Synchronization

#### `history.sync`
Streams the full event journal to the client. Useful when the handshake did not request history, or when more events are available than were returned in `eventHistory`.

```json
{
  "id": "cmd-133",
  "type": "history.sync"
}
```

- The command has no `data` payload.
- The server responds with one or more `history.batch` events, each containing a chunk of events in chronological order.
- Batches continue until the final message has `hasMore: false`. No follow-up command is required.

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
    "dataPath": "/home/.tadpole-executions/1234-abc/read_only_data_source"
  }
}
```

**Note**: Prior to execution isolation, this event included `projectPath`. This has been replaced with:
- `executionPath`: Where the server operates and all Tadpole artifacts are stored
- `dataPath`: Where the user's original data is accessible (via symlink or copy) at `<execution-dir>/read_only_data_source`

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

### History Synchronization Events

#### `history.batch`
Response to a `history.sync` command, containing a paginated batch of events from the journal.

```json
{
  "id": "evt-history-001",
  "timestamp": "2025-01-19T10:05:00Z",
  "type": "history.batch",
  "data": {
    "events": [
      { "id": "evt-100", "type": "phase.started", "..." },
      { "id": "evt-99", "type": "assistant.action", "..." }
    ],
    "hasMore": true
  }
}
```

**Fields:**
- `events`: Array of previously recorded `ServerEvent` objects delivered in chronological order
- `hasMore`: Boolean indicating if additional batches will follow for the same `history.sync` request

**Note:** `history.batch` events are not stored in the journal as they only contain references to existing events.

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
    "startTime": "2025-01-19T10:00:10Z",
    "metadata": {
      "checkpointSha": "a1b2c3d"
    }
  }
}
```

**Fields:**
- `metadata.checkpointSha`: Optional. Present when resuming from an existing workspace setup checkpoint, indicating the Git SHA of the workspace state being reused.

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

#### `tool.result`
Provides detailed information about the completion of a tool execution, including the result, execution time, and whether it was successful. This event is correlated with the original tool use via `toolUseId`.

```json
{
  "id": "evt-006",
  "timestamp": "2025-01-19T10:01:05Z",
  "type": "tool.result",
  "data": {
    "phaseId": "phase-1",
    "toolUseId": "toolu_01ABC123XYZ",
    "toolName": "Read",
    "result": "const app = express();\n// ... file content ...",
    "truncated": false,
    "originalLength": 1024,
    "executionTimeMs": 45,
    "isError": false
  }
}
```

**Fields:**
- `toolUseId`: Unique identifier that correlates with the tool invocation
- `result`: The tool's output (may be truncated for large results)
- `truncated`: Whether the result was truncated
- `originalLength`: Original size of the result before truncation
- `executionTimeMs`: Time taken to execute the tool in milliseconds
- `isError`: Whether the tool execution resulted in an error

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

## Resume Functionality

The server provides robust resume functionality that allows execution to continue from previous sessions, even after failures or interruptions.

### Workspace Setup Checkpoint Reuse

When a phase is started, the server checks the phase's execution history for an existing `workspaceSetupCheckpoint`:

1. **Checkpoint Discovery**: The server queries the state manager for all previous runs of the phase and searches for any entry containing a `workspaceSetupCheckpoint`
2. **Automatic Skip**: If a checkpoint is found, workspace setup operations (file copies, commands) are automatically skipped, regardless of the `skipPreCommands` parameter
3. **Resume from Checkpoint**: The phase resumes execution with the workspace already configured from the previous attempt

This mechanism prevents expensive and time-consuming workspace setup operations from being repeated when resuming failed phases. It's particularly valuable for phases that copy large directories or perform complex setup operations.

**Example Scenario:**
```
Run 1: Phase starts → Workspace setup (copies 5GB of data) → Phase fails during execution
Run 2: Phase starts → Finds existing checkpoint → Skips workspace setup → Resumes immediately
```

### Automatic Failure Detection and Recovery

On server startup (when a client connects), the server performs automatic failure detection:

1. **Thread Analysis**: The server calls `getExecutionThread()` to analyze the complete execution history
2. **Failure Check**: The `ExecutionThread.failed` property is checked, which returns true if any phase has:
   - `phase.status === "failed"`
   - `runStatus === "failed"`
   - `runStatus === "crashed"`
3. **Automatic Rollback**: If failure is detected, the server automatically invokes `rollbackToLastSuccess()` with the `autostart` configuration
4. **Clean Restart**: After rollback, the server starts fresh from a known good state

This ensures that resuming a session never begins from a corrupted or failed state. The workspace is automatically restored to the last successful checkpoint, allowing execution to proceed cleanly.

### Checkpoint Types Used for Resume

The resume functionality leverages different checkpoint types depending on the phase's state:

- **Workspace Setup Checkpoint**: Created after workspace setup, before phase execution begins. Used to skip setup on resume.
- **Completion Checkpoint**: Created after successful phase completion. Used as the primary rollback target.
- **Error Checkpoint**: Created when a phase fails (if configured). Can be used as a fallback rollback target.
- **Skip Checkpoint**: Created when a phase is skipped. Can be used as a fallback rollback target.

The `rollbackToLastSuccess` operation prioritizes completion checkpoints but falls back to any available checkpoint (workspace-setup, error, or skipped) if no successful completions exist.

## Protocol Behavior

### Connection Lifecycle
The typical connection flow is designed to quickly synchronize the client with the server's state:
1.  The client establishes a WebSocket connection.
2.  The server immediately responds with a `server.ready` event.
3.  This is followed by a comprehensive `state.snapshot` event.
4.  The server checks if the execution thread has previously failed by analyzing the execution history.
5.  If a failure is detected, the server automatically triggers `rollbackToLastSuccess` to restore the workspace to a known good state before resuming.
6.  If `autostart` is enabled, the server proceeds to start the next phase (after rollback if needed). Otherwise, it sends a `server.idle` event and waits for commands.

**Automatic Failure Recovery:**
When the server starts up, it analyzes the execution thread to detect if previous execution attempts failed. If `ExecutionThread.failed` is true (indicating phases with status "failed" or runStatus "failed"/"crashed"), the server automatically performs a rollback to the last successful checkpoint before starting any new work. This ensures that resuming a session never continues from a broken state.

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
