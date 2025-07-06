# Langton Server

A WebSocket server for orchestrating Claude AI phases with real-time event streaming, file watching, and session management.

## Architecture Overview

The server is built around a WebSocket-based event system that manages Claude AI sessions in phases. Each phase represents a distinct task with its own prompt, configuration, and file watching requirements.

## File Structure

```
server/
├── index.ts           # Entry point and CLI handling
├── langton-server.ts  # Main server class and core logic
├── config.ts          # Configuration loading and validation
├── types.ts           # TypeScript type definitions
├── utils.ts           # Utility functions (logging, file operations)
├── claude-log-parser.ts # Claude log parsing and analysis
└── basic-tui.ts       # Basic terminal UI for testing
```

## Core Components

### 1. LangtonServer (langton-server.ts)

The main server class that handles:
- WebSocket server lifecycle
- Phase execution and management
- Claude process spawning and monitoring
- Event emission and state management
- File watching and updates

**Key Methods:**
- `start()` - Initializes the server, loads previous state, starts WebSocket server
- `startPhase(phaseId, skipPreCommands?)` - Starts a specific phase
- `startNextPhase()` - Advances to the next phase in sequence
- `handleCommand(command)` - Processes client commands
- `shutdown(reason)` - Graceful server shutdown

**State Management:**
- Tracks current phase, completed phases, and total costs
- Persists state through Claude log files
- Recovers state on server restart

### 2. Configuration (config.ts)

**PhaseConfig Schema:**
```typescript
{
  id: string;                    // Unique phase identifier
  name: string;                  // Human-readable name
  promptFile?: string;           // Path to prompt file
  promptText?: string;           // Inline prompt text
  model: string;                 // Claude model to use
  continueFromPrevious?: boolean; // Continue from previous session
  preStart?: string;             // Shell command to run before phase
  watch?: string;                // Glob pattern for file watching
  description?: string;          // Phase description
}
```

**ServerConfig:**
- Port, version, file paths
- Cost calculation parameters
- Log parsing interval

### 3. Event System (types.ts)

**Server → Client Events:**
- `server.ready` - Server initialized and ready
- `state.snapshot` - Current server state
- `phase.started` - Phase execution started
- `phase.completed` - Phase finished (success/failure)
- `assistant.action` - Claude actions (thinking, message, tool_use)
- `token.usage` - Token usage and cost updates
- `file.updated` - Watched file changes
- `filetree.updated` - File tree structure changes
- `error` - Error events (fatal/non-fatal)
- `incomplete.phase` - Incomplete phase detected
- `info` - Informational messages

**Client → Server Commands:**
- `connect` - Initial client connection
- `phase.start` - Start specific phase
- `phase.next` - Start next phase
- `phase.skip` - Skip current phase
- `phase.redo` - Redo last phase
- `server.shutdown` - Shutdown server

### 4. Claude Integration (claude-log-parser.ts)

**Log Parsing:**
- Real-time parsing of Claude's JSON log output
- Extracts messages, token usage, and results
- Uses Zod schemas from claude-session-schema

**Process Management:**
- Spawns Claude CLI with appropriate arguments
- Handles stdin/stdout/stderr streams
- Monitors process lifecycle

### 5. File Watching

- Uses Chokidar for efficient file watching
- Supports glob patterns per phase
- Emits events for file creates/updates/deletes
- Maintains file tree structure

## Process Flow

### 1. Server Startup
```
1. Load configuration and validate
2. Check for lock file (prevent multiple instances)
3. Load previous state from logs
4. Start WebSocket server
5. Wait for client connection
```

### 2. Client Connection
```
1. Accept single client connection
2. Send server.ready event
3. Send state.snapshot with current state
4. Check for incomplete phases
5. Wait for commands
```

### 3. Phase Execution
```
1. Validate phase configuration
2. Run pre-start command (if specified)
3. Get previous session ID (if continuing)
4. Start file watcher (if pattern specified)
5. Spawn Claude process with arguments
6. Feed prompt to Claude stdin
7. Parse Claude logs in real-time
8. Emit events for actions and updates
9. Handle phase completion
10. Clean up resources
```

### 4. State Persistence
```
1. Each phase has its own log file (.logs/log-{phaseId}.jsonl)
2. Session IDs extracted from Claude init messages
3. Token usage and costs calculated from assistant messages
4. Success/failure determined from result messages
```

## WebSocket Protocol

### Message Format
All messages are JSON with this structure:
```typescript
{
  id: string;        // Unique message ID
  timestamp: string; // ISO 8601 timestamp
  type: string;      // Event/command type
  data?: any;        // Type-specific data
}
```

### Connection Flow
1. Client connects to ws://localhost:7777
2. Server sends `server.ready` event
3. Server sends `state.snapshot` event
4. Client sends commands as needed
5. Server streams events in real-time

## Security Considerations

- Single client connection only
- Lock file prevents multiple servers
- Process cleanup on shutdown
- No authentication (local use only)

## Error Handling

**Fatal Errors:**
- Pre-start command failures
- Missing previous session for continuation
- Claude process errors
- Phase failures

**Non-Fatal Errors:**
- Unknown commands
- File read errors
- Invalid phase IDs

## Logging

**Server Logs** (`.logs/server.log`):
- Server lifecycle events
- Command handling
- Error messages

**WebSocket Logs** (`.logs/websocket.log`):
- All WebSocket traffic (in/out)
- Command and event details

**Claude Logs** (`.logs/log-{phaseId}.jsonl`):
- Claude session logs per phase
- Used for state recovery

## Basic TUI Mode

Run with `--basic` flag for terminal interface:
- Shows real-time events
- Keyboard shortcuts: [n]ext, [s]kip, [q]uit
- Useful for testing and debugging