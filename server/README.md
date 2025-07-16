# Langton Server

A WebSocket-based orchestration server for managing Claude CLI sessions through configurable phases, with comprehensive state management, real-time event streaming, and crash recovery.

## Overview

Langton Server orchestrates multi-phase AI workflows by managing Claude CLI processes, tracking state transitions, monitoring costs, and providing real-time updates to connected clients. The server implements a robust state machine that ensures consistency and enables recovery from crashes.

## Architecture

### Core Components

```
┌─────────────────┐
│   WebSocket     │
│     Client      │
└────────┬────────┘
         │
┌────────▼────────┐
│  LangtonServer  │
│  (Orchestrator) │
└────────┬────────┘
         │
    ┌────┴────┬────────┬─────────┬──────────┐
    │         │        │         │          │
┌───▼──┐ ┌───▼───┐ ┌──▼───┐ ┌──▼────┐ ┌───▼───┐
│State │ │Process│ │ Log  │ │ File  │ │Check- │
│Mgr   │ │Manager│ │Parser│ │Watcher│ │point  │
└──────┘ └───────┘ └──────┘ └───────┘ └───────┘
```

### Key Concepts

#### Runs

A "run" represents one complete server lifecycle from startup to shutdown. Each run:

- Has a unique ID (timestamp-random format)
- Creates its own folder in `.langton/runs/{runId}/`
- Gets its own git branch for checkpoints
- Tracks all phase executions within that run
- Can start fresh or continue from a previous run

#### Phases

Phases are discrete tasks with their own prompts, models, and configurations. Each phase execution tracks:

- Status progression through a detailed state machine
- Claude session information
- Costs and token usage
- Checkpoints at key milestones
- Failure reasons if applicable

#### State Management

The server maintains all state in a centralized `StateManager` that:

- Persists to `.langton/state.json` with atomic writes
- Validates all state transitions
- Provides type-safe queries
- Enables crash recovery
- Uses fire-and-forget transitions with async processing

## Directory Structure

```
server/
├── index.ts                    # CLI entry point
├── langton-server.ts          # Main orchestration logic
├── state-manager.ts           # State persistence and transitions
├── state-types.ts             # State type definitions
├── state-transition-guards.ts # Transition validation
├── claude-process-manager.ts  # Claude subprocess lifecycle
├── claude-log-parser.ts       # Real-time log parsing
├── checkpoint-git.ts          # Git-based checkpointing
├── file-resolver.ts           # Unified file resolution with gitignore
├── config.ts                  # Configuration management
├── error-types.ts             # Error severity system
├── typed-event-emitter.ts     # Type-safe event system
├── cleanup-command.ts         # Project cleanup
├── cleanup/                   # Cleanup modules
├── basic-tui.ts              # Terminal UI for testing
└── utils.ts                   # Utilities
```

## State System

### Phase Status Flow

```
preparing → starting → initializing → running → completing → completed
    ↓          ↓           ↓            ↓          ↓
  failed    failed      failed       failed     failed
    ↓          ↓           ↓            ↓
  skipped   skipped     skipped      skipped
```

**Status Definitions:**

- `preparing`: Running workspace setup (copying files, executing commands)
- `starting`: Spawning Claude process
- `initializing`: Process started, waiting for session ID
- `running`: Claude is actively working
- `completing`: Process exited, waiting for result message (30s timeout)
- `completed`: Successfully finished
- `failed`: Error occurred (with failure reason)
- `skipped`: User skipped the phase

### State Transitions

All state changes occur through typed transitions:

```typescript
// Start a new run
stateManager.transition({
  type: "RunStarted",
  data: { runId, runFolder, gitBranch, startingConditions, serverPid },
});

// Progress phase status
stateManager.transition({
  type: "PhaseTransitioned",
  data: { runId, phaseId, from: "preparing", to: "starting" },
});

// Update costs
stateManager.transition({
  type: "CostsUpdated",
  data: { runId, phaseId, cost, tokens },
});
```

### State Persistence

State is saved to `.langton/state.json` with:

- Atomic write-rename operations
- Automatic backups (`.langton/state.json.bak`)
- Event log in `.langton/events.jsonl` for debugging
- Validation on load with corruption detection

## Data Flow

### Phase Execution Flow

1. **Client Request** → WebSocket command
2. **Phase Start** → StateManager records new phase
3. **Workspace Setup** → Copy files, run commands
4. **Process Spawn** → ClaudeProcessManager creates subprocess
5. **Log Streaming** → ClaudeLogParser monitors output
6. **State Updates** → Fire-and-forget transitions
7. **Event Emission** → Real-time updates to client
8. **Completion** → Checkpoint creation, state finalization

### Event Flow

```
Client Command
    ↓
LangtonServer.handleCommand()
    ↓
StateManager.transition()  // Fire-and-forget
    ↓
Async Queue Processing
    ↓
State Validation → Apply → Persist → Emit Events
                                          ↓
                                    WebSocket Events
```

## WebSocket Protocol

### Server → Client Events

All events follow the base structure:

```typescript
{
  id: string;        // Unique event ID
  timestamp: string; // ISO 8601
  type: string;      // Event type
  data?: any;        // Event-specific data
}
```

**Event Types:**

- `server.ready` - Server initialized
- `state.snapshot` - Complete state snapshot
- `phase.started` - Phase execution began (emitted when Claude sends session ID)
- `phase.completed` - Phase finished
- `assistant.action` - Claude action (message, thinking, tool_use)
- `token.usage` - Token consumption update
- `file.updated` - Watched file changed
- `filetree.updated` - File tree structure update
- `error` - Error occurred
- `info` - Informational message

### Client → Server Commands

Commands are validated using Zod schemas:

```typescript
{
  id: string;   // Client-generated ID
  type: string; // Command type
  data?: any;   // Command-specific data
}
```

**Command Types:**

- `phase.start` - Start specific phase
- `phase.next` - Start next phase
- `phase.skip` - Skip current phase
- `phase.redo` - Re-run last phase
- `server.shutdown` - Graceful shutdown

## Key Components

### StateManager

Central state management with:

- **Immutable state updates** via pure transition functions
- **Async queue processing** for fire-and-forget transitions
- **Cost caching** for performance
- **Crash detection** on startup
- **Type-safe queries** for state inspection

### ClaudeProcessManager

Dedicated subprocess lifecycle management:

- Spawns Claude with proper arguments
- Manages stdin/stdout/stderr streams
- Creates log files in run-specific folders
- Handles process termination
- Supports custom Anthropic base URLs

### ClaudeLogParser

Real-time parsing of Claude's JSONL output:

- Watches log files for new entries
- Validates messages against schemas
- Extracts costs and token usage
- Handles result messages for accurate costs
- Detects API timeouts

### CheckpointGit

Git-based checkpoint system:

- Shadow repository in `.langton/checkpoints/`
- Per-run branches for isolation
- Commits at phase milestones
- Selective file tracking with patterns
- Atomic operations

## Process Management

### Lock File System

Enhanced lock file (`.langton/server.lock`) contains:

```json
{
  "pid": 12345,
  "runId": "1234567890-abc",
  "startTime": "2024-01-01T00:00:00Z",
  "lastHeartbeat": "2024-01-01T00:00:30Z"
}
```

- Heartbeat updated every 30 seconds
- Stale detection after 2 minutes
- Automatic cleanup on shutdown

### Crash Recovery

On startup, the server:

1. Checks for stale lock files
2. Detects crashed runs (status="running" but process dead)
3. Marks crashed phases as failed
4. Updates state accordingly
5. Can optionally continue the same run

## File Management

### Unified File Resolution

The `fileResolver` service provides consistent file handling:

- Respects `.gitignore` rules at all levels
- Handles negation patterns correctly
- Used by watching, checkpointing, and cleanup systems
- Caches ignore rules for performance

### Run-Specific Storage

Each run stores its files in `.langton/runs/{runId}/`:

- `phase-{phaseId}-claude.log` - Claude's JSONL output
- Future: workspace snapshots, artifacts

## Error Handling

### Severity Levels

```typescript
enum ErrorSeverity {
  FATAL = "fatal", // Shutdown required
  PHASE = "phase", // Phase fails, server continues
  OPERATION = "operation", // Single operation fails
  WARNING = "warning", // Logged only
}
```

### Error Flow

1. Error occurs → Severity determined
2. Always logged and sent to client
3. Fatal → Graceful shutdown initiated
4. Phase → Current phase cleaned up
5. Operation/Warning → Execution continues

## Cost Tracking

### Token Usage

Costs are tracked at multiple levels:

- **Per-message**: From Claude's usage data
- **Per-phase**: Accumulated during execution
- **Per-run**: Sum of all phases
- **All-time**: Across all runs

### Cost Calculation

```typescript
cost = (inputTokens / 1M * costsPerMTok.input) +
       (outputTokens / 1M * costsPerMTok.output) +
       (cacheCreationTokens / 1M * costsPerMTok.inputCache) +
       (cacheReadTokens / 1M * costsPerMTok.cacheRead)
```

## Development

### Type Safety

- Branded types for IDs (`RunId`, `PhaseId`, `SessionId`)
- Discriminated unions for phase states
- Zod schemas for runtime validation
- Exhaustive type checking with `assertNever`

### Event System

Type-safe event emitter with compile-time checking:

```typescript
stateManager.on("phaseRunning", (data) => {
  // data is fully typed
});
```

### Testing Considerations

The server is designed for testability:

- State manager exposed as readonly for inspection
- All file operations use configurable paths
- Process management allows PID tracking
- WebSocket events emitted for test monitoring

## Configuration

### Phase Configuration

Phases support:

- Multiple prompt files (concatenated)
- System prompt additions
- Workspace setup operations
- File tracking patterns
- Continuation modes

### Server Configuration

Key settings in `config.ts`:

- Port (default: 7777)
- Log parsing interval
- Result message timeout (30s)
- Process kill grace period (5s)
- Cost per million tokens

## Future Considerations

The current architecture supports future enhancements:

- Multiple concurrent phases
- Phase dependency graphs
- State sharding for large histories
- Real-time collaboration
- Advanced rollback/branching (continuation from any point)
- Cost limits and budgets
