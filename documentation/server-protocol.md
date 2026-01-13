# Strandweave Server Protocol

## Overview

The Strandweave server operates on a WebSocket-based protocol designed for real-time, bidirectional communication between the server and a client. This approach enables a highly interactive and transparent experience, allowing clients to monitor Claude's activity, control the execution flow, and receive immediate updates on file system changes and state transitions.

The server runs on port 7777 by default. All messages exchanged are JSON-encoded and adhere to a strict schema, ensuring type safety and predictable interactions.

## Connection Model

The server supports a **multi-client architecture**, allowing multiple WebSocket clients to connect concurrently and observe or control the same execution workflow.

- **Multi-Client Support**: The server maintains a registry of all connected clients. There is no hard limit on the number of clients that can connect.
- **Access Modes**: Each client connects in one of two modes, specified during the initial handshake:
  - `readandwrite`: The client can send control commands (e.g., `codon.start`, `rollback.toCheckpoint`) and receive all server events.
  - `readonly`: The client can only receive server events and is prohibited from sending any commands that would alter the server's state. This is ideal for passive monitoring UIs.
- **Connection Handling**: The server's lifecycle is no longer tied to a single client connection. It continues to run even if all clients disconnect, allowing for persistent, long-running workflows that can be re-connected to at any time.
- **Lock File**: On startup, the server creates a lock file at `.strandweave/runtime.lock`. This file contains the server's process ID (PID) and the current run ID. This mechanism prevents multiple server instances from running in the same project directory, which would otherwise lead to state corruption and race conditions. The lock file also includes a heartbeat timestamp, allowing the server to detect and clean up stale locks from crashed previous sessions.

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
  │                         │
  │─── history.sync ───────>│ (optional)
  │<──── history.batch ─────┤ (streamed batches)
  │                         │
  │─── codon.start ────────>│
  │<──── codon.started ─────┤
  │<─── assistant.action ───┤ (streaming)
  │<──── token.usage ───────┤ (periodic)
  │<─── codon.completed ────┤
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

Immediately after acknowledging the handshake, the server emits `server.ready`, then resumes real-time event delivery.

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

Clients send commands to control the server's execution flow, manage codons, and query state.

### Codon Control Commands

These commands are used to direct the codon execution lifecycle.

#### `codon.start`
Initiates the execution of a specific codon by its unique ID. This is typically used for manual control when autostart is disabled or to retry a specific codon from a previous run.

- `skipPreCommands`: An optional boolean that, when `true`, skips the `rigSetup` operations for the codon. This is useful when retrying a codon where the setup has already been completed and doesn't need to be repeated.

```json
{
  "id": "cmd-123",
  "type": "codon.start",
  "data": {
    "codonId": "codon-1-analysis",
    "skipPreCommands": false
  }
}
```

#### `codon.next`
The standard command to advance the workflow. The server uses its internal execution thread logic to determine the next codon in the sequence and starts it.

```json
{
  "id": "cmd-124",
  "type": "codon.next"
}
```

#### `codon.skip`
Instructs the server to gracefully terminate the currently running codon. The codon is marked as `skipped` in the state history. If autostart is enabled, the server will automatically proceed to the next codon.

```json
{
  "id": "cmd-125",
  "type": "codon.skip"
}
```

#### `codon.redo`
Allows for re-running the most recently executed codon, regardless of its completion status. This is useful for iterating on a specific step without rolling back.

```json
{
  "id": "cmd-126",
  "type": "codon.redo"
}
```

#### `codon.forceStop`
Immediately terminates the current codon and marks it as `failed`. This is a more forceful action than `skip` and is intended for situations where a codon is stuck or producing incorrect results. A forced stop may halt the entire run if the failure is considered non-retriable.

```json
{
  "id": "cmd-127",
  "type": "codon.forceStop",
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

- `autoRestart`: If `true`, the server will attempt to automatically start the next codon after the rollback is complete.

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

#### `rollback.toCodon`
A more abstract way to roll back. Instead of a specific SHA, you specify a target codon and a checkpoint type. The server resolves this to the correct checkpoint SHA from the execution history.

**Checkpoint Types:**
- `"rig-setup"`: After rig setup, before Claude starts
- `"completed"`: After successful completion
- `"error"`: After failure (if checkpoint was created)
- `"skipped"`: After skip
- `"start"`: Alias for rig-setup
- `"end"`: Latest checkpoint for the codon

```json
{
  "id": "cmd-130",
  "type": "rollback.toCodon",
  "data": {
    "codonId": "codon-2",
    "checkpointType": "completed",
    "autoRestart": false
  }
}
```

#### `rollback.toLastSuccess`
A convenient command to revert to the completion checkpoint of the last successfully executed codon in the history.

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

The server emits events to keep the client informed about its state, Claude's activity, and changes in the project execution environment.

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
    "executionPath": "/home/.strandweave-executions/1234-abc",
    "dataPath": "/home/.strandweave-executions/1234-abc/read_only_data_source"
  }
}
```

**Note**: Prior to execution isolation, this event included `projectPath`. This has been replaced with:
- `executionPath`: Where the server operates and all Strandweave artifacts are stored
- `dataPath`: Where the user's original data is accessible (via symlink or copy) at `<execution-dir>/read_only_data_source`

#### `state.snapshot`
A comprehensive snapshot of the server's current state. It's sent after major state changes (like codon completion or rollback). This event is the primary source of truth for the client to build its own state representation.

```json
{
  "id": "evt-002",
  "timestamp": "2025-01-19T10:00:05Z",
  "type": "state.snapshot",
  "data": {
    "currentCodon": { "...CodonExecution object..." },
    "completedCodons": [ "..." ],
    "fileTree": [ "...FileNode array..." ],
    "totalCost": 1.23,
    "totalTime": 300000,
    "recentFileAccess": { "...details..." },
    "isRollingBack": false
  }
}
```

#### `state.transition`
A granular event that signals a specific, atomic change in the server's state. This is the underlying event that drives all state changes and is the most reliable way to track the state machine's evolution in real-time.

```json
{
  "id": "evt-100",
  "timestamp": "2025-01-19T10:00:10Z",
  "type": "state.transition",
  "data": {
    "transitionType": "CodonTransitioned",
    "runId": "run-123",
    "codonId": "codon-1",
    "transition": {
      "type": "CodonTransitioned",
      "data": { "from": "running", "to": "completed" }
    },
    "resultingState": {
      "currentRunId": "run-123",
      "runCount": 1,
      "totalCost": 0.0123,
      "currentRunCost": 0.0123
    }
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
      { "id": "evt-100", "type": "codon.started", "..." },
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

### Codon Lifecycle Events

#### `codon.started`
Announces the beginning of a codon's execution, after rig setup is complete and the Claude process has been spawned.

```json
{
  "id": "evt-003",
  "timestamp": "2025-01-19T10:00:10Z",
  "type": "codon.started",
  "data": {
    "codonId": "codon-1",
    "codonName": "Initial Analysis",
    "sessionId": "session-uuid-123",
    "startTime": "2025-01-19T10:00:10Z",
    "metadata": {
      "checkpointSha": "a1b2c3d"
    }
  }
}
```

**Fields:**
- `metadata.checkpointSha`: Optional. Present when resuming from an existing rig setup checkpoint, indicating the Git SHA of the rig state being reused.

#### `codon.completed`
Marks the end of a codon's execution, providing a summary of its outcome, cost, and duration.

- `failureReason`: If `success` is `false`, this object provides structured information about the error, including whether it's considered retriable.

```json
{
  "id": "evt-004",
  "timestamp": "2025-01-19T10:05:10Z",
  "type": "codon.completed",
  "data": {
    "codonId": "codon-1",
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
    "codonId": "codon-1",
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
    "codonId": "codon-1",
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
    "codonId": "codon-1",
    "inputTokens": 1024,
    "outputTokens": 512,
    "totalCost": 0.0045
  }
}
```

### File System Events

#### `file.updated`
Notifies the client of a change (creation, modification, or deletion) to a file being tracked in the current codon.

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

### Sentinel Events

These events provide visibility into the lifecycle and activity of the parallel Sentinel agents.

#### `sentinel.loaded`
Sent when a sentinel is successfully loaded and initialized at the start of a codon.

```json
{
  "id": "evt-chr-001",
  "timestamp": "2025-01-19T10:00:11Z",
  "type": "sentinel.loaded",
  "data": {
    "sentinelId": "narrator",
    "codonId": "codon-1",
    "model": "anthropic/claude-3-5-sonnet-20241022",
    "triggerType": "event",
    "executionStrategy": "debounce",
    "conversational": false,
    "source": "file"
  }
}
```

#### `sentinel.triggered`
Sent when a sentinel's trigger conditions are met and it begins processing a batch of events.

```json
{
  "id": "evt-chr-002",
  "timestamp": "2025-01-19T10:03:00Z",
  "type": "sentinel.triggered",
  "data": {
    "sentinelId": "narrator",
    "codonId": "codon-1",
    "triggerNumber": 1,
    "strategy": "debounce",
    "eventCount": 5,
    "queueSize": 0
  }
}
```

#### `sentinel.output`
Sent when a sentinel's LLM call completes and produces an output.

```json
{
  "id": "evt-chr-003",
  "timestamp": "2025-01-19T10:03:05Z",
  "type": "sentinel.output",
  "data": {
    "sentinelId": "narrator",
    "codonId": "codon-1",
    "triggerNumber": 1,
    "outputType": "text",
    "content": "The agent has started analyzing the files.",
    "cost": 0.00015,
    "tokens": { "input": 50, "output": 25 },
    "eventCount": 5
  }
}
```

#### `sentinel.error`
Sent when a sentinel encounters a non-fatal error, such as a failed LLM call.

```json
{
  "id": "evt-chr-004",
  "timestamp": "2025-01-19T10:04:00Z",
  "type": "sentinel.error",
  "data": {
    "sentinelId": "narrator",
    "codonId": "codon-1",
    "errorType": "llm-call-failed",
    "message": "API returned status 500",
    "retriable": true,
    "consecutiveFailureCount": 1
  }
}
```

#### `sentinel.unloaded`
Sent when a sentinel is unloaded at the end of a codon or due to a fatal error.

```json
{
  "id": "evt-chr-005",
  "timestamp": "2025-01-19T10:05:10Z",
  "type": "sentinel.unloaded",
  "data": {
    "sentinelId": "narrator",
    "codonId": "codon-1",
    "reason": "codon-complete",
    "finalCost": 0.0012,
    "llmCallCount": 8
  }
}
```

### Status & Rollback Events

#### `server.idle`
Indicates that the server is not executing any codon and is waiting for a command. This happens when autostart is disabled or when all codons have been completed.

```json
{
  "id": "evt-009",
  "timestamp": "2025-01-19T10:05:10Z",
  "type": "server.idle",
  "data": {
    "reason": "codon-completed",
    "message": "Codon codon-1 completed. Use 'codon.next' to continue."
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

### Rig Setup Checkpoint Reuse

When a codon is started, the server checks the codon's execution history for an existing `rigSetupCheckpoint`:

1. **Checkpoint Discovery**: The server queries the state manager for all previous runs of the codon and searches for any entry containing a `rigSetupCheckpoint`
2. **Automatic Skip**: If a checkpoint is found, rig setup operations (file copies, commands) are automatically skipped, regardless of the `skipPreCommands` parameter
3. **Resume from Checkpoint**: The codon resumes execution with the rig already configured from the previous attempt

This mechanism prevents expensive and time-consuming rig setup operations from being repeated when resuming failed codons. It's particularly valuable for codons that copy large directories or perform complex setup operations.

**Example Scenario:**
```
Run 1: Codon starts → Rig setup (copies 5GB of data) → Codon fails during execution
Run 2: Codon starts → Finds existing checkpoint → Skips rig setup → Resumes immediately
```

### Automatic Failure Detection and Recovery

On server startup (when a client connects), the server performs automatic failure detection:

1. **Thread Analysis**: The server calls `getExecutionThread()` to analyze the complete execution history
2. **Failure Check**: The `ExecutionThread.failed` property is checked, which returns true if any codon has:
   - `codon.status === "failed"`
   - `runStatus === "failed"`
   - `runStatus === "crashed"`
3. **Automatic Rollback**: If failure is detected, the server automatically invokes `rollbackToLastSuccess()` with the `autostart` configuration
4. **Clean Restart**: After rollback, the server starts fresh from a known good state

This ensures that resuming a session never begins from a corrupted or failed state. The rig is automatically restored to the last successful checkpoint, allowing execution to proceed cleanly.

### Checkpoint Types Used for Resume

The resume functionality leverages different checkpoint types depending on the codon's state:

- **Rig Setup Checkpoint**: Created after rig setup, before codon execution begins. Used to skip setup on resume.
- **Completion Checkpoint**: Created after successful codon completion. Used as the primary rollback target.
- **Error Checkpoint**: Created when a codon fails (if configured). Can be used as a fallback rollback target.
- **Skip Checkpoint**: Created when a codon is skipped. Can be used as a fallback rollback target.

The `rollbackToLastSuccess` operation prioritizes completion checkpoints but falls back to any available checkpoint (rig-setup, error, or skipped) if no successful completions exist.

## Protocol Behavior

### Connection Lifecycle
The typical connection flow is designed to quickly synchronize the client with the server's state:
1.  The client establishes a WebSocket connection and completes the handshake.
2.  The server responds with a `server.ready` event.
3.  The server checks if the execution thread has previously failed by analyzing the execution history.
4.  If a failure is detected, the server automatically triggers `rollbackToLastSuccess` to restore the rig to a known good state before resuming.
5.  If `autostart` is enabled, the server proceeds to start the next codon (after rollback if needed). Otherwise, it sends a `server.idle` event and waits for commands.

**Automatic Failure Recovery:**
When the server starts up, it analyzes the execution thread to detect if previous execution attempts failed. If `ExecutionThread.failed` is true (indicating codons with status "failed" or runStatus "failed"/"crashed"), the server automatically performs a rollback to the last successful checkpoint before starting any new work. This ensures that resuming a session never continues from a broken state.

### Command Processing
The server processes commands sequentially to maintain state integrity. Most commands that modify state (e.g., starting or stopping a codon) are blocked during a rollback operation to prevent conflicts. Read-only queries like `checkpoint.list` are always permitted.

### State Consistency
The protocol is backed by a robust state manager that ensures consistency. All state changes are validated and persisted atomically to disk before any corresponding events are sent to the client. This guarantees that the client's view of the state, as informed by events, accurately reflects the persisted reality, even in the event of a crash.

### Event Ordering
The server provides strong guarantees about the order of events, which simplifies client-side logic:
- Codon lifecycle events (`codon.started`, `codon.completed`) will always be sent in the correct sequence for a given codon.
- A `state.snapshot`, when sent, always reflects the state *after* the event that triggered it (e.g., after a `codon.completed` event).
- File system events (`file.updated`, `filetree.updated`) are sent as changes are detected during a codon's execution.

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
    "code": "CODON_TIMEOUT",
    "message": "Codon execution timed out after 30 minutes",
    "details": {
      "codonId": "codon-1",
      "elapsed": 1800000
    },
    "fatal": false,
    "retriable": true,
    "severity": "error"
  }
}
```

**Error Codes:**
- `CONFIG_INVALID`: Codon configuration error
- `CLAUDE_NOT_FOUND`: Claude Code not available (SDK or CLI)
- `API_ERROR`: Claude API error (rate limit, auth, etc.)
- `CODON_TIMEOUT`: Codon took too long
- `STATE_CORRUPTED`: State file corruption detected
- `GIT_ERROR`: Checkpoint operation failed
- `RIG_SETUP_FAILED`: Copy/command failed
- `INTERNAL_ERROR`: Unexpected server error
