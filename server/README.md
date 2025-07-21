# Langton Server Technical Documentation

A WebSocket-based orchestration server that manages Claude CLI sessions through configurable phases. The server provides state management, process lifecycle control, real-time event streaming, cost tracking, and checkpoint-based recovery.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Core Concepts](#core-concepts)
3. [Module Structure](#module-structure)
4. [State Management System](#state-management-system)
5. [Phase Execution Lifecycle](#phase-execution-lifecycle)
6. [WebSocket Protocol](#websocket-protocol)
7. [Process Management](#process-management)
8. [File System Operations](#file-system-operations)
9. [Checkpoint and Rollback System](#checkpoint-and-rollback-system)
10. [Error Handling](#error-handling)
11. [Type System](#type-system)
12. [Configuration](#configuration)
13. [Development Patterns](#development-patterns)

## Architecture Overview

The server follows a modular, event-driven architecture with centralized state management:

```
┌─────────────────┐
│   WebSocket     │
│     Client      │
└────────┬────────┘
         │
┌────────▼────────────────────────────────────────┐
│            LangtonServer (langton-server.ts)    │
│  - WebSocket server management                  │
│  - Command routing and validation               │
│  - Phase orchestration                          │
│  - Event broadcasting                           │
└────────┬────────────────────────────────────────┘
         │
    ┌────┴────┬────────┬─────────┬──────────┬──────────┐
    │         │        │         │          │          │
┌───▼──────┐ ┌▼──────┐ ┌▼─────┐ ┌▼───────┐ ┌▼────────┐
│State      │ │Process│ │ Log  │ │File    │ │Checkpoint│
│Manager    │ │Manager│ │Parser│ │Resolver│ │Git       │
│           │ │       │ │      │ │        │ │          │
│Persistent │ │Claude │ │JSONL │ │Gitignore│ │Shadow   │
│state with │ │process│ │stream│ │respect- │ │repo for │
│validation │ │control│ │parser│ │ing globs│ │rollback │
└───────────┘ └───────┘ └──────┘ └─────────┘ └──────────┘
```

### Design Principles

1. **Single Source of Truth**: All state lives in StateManager
2. **Fire-and-Forget Transitions**: State changes are queued and processed asynchronously
3. **Type Safety**: Branded types, discriminated unions, and exhaustive checking
4. **Crash Recovery**: State persists across server restarts with automatic recovery
5. **Event-Driven**: Components communicate through typed events
6. **Immutable State**: All state updates create new objects

## Core Concepts

### Runs

A **run** represents one complete server lifecycle from startup to shutdown:

- **Run ID**: Format `{timestamp}-{random}` (e.g., `1234567890-abc`)
- **Run Folder**: `.langton/runs/{runId}/` stores logs and artifacts
- **Git Branch**: `run-{runId}` for checkpoint isolation
- **Starting Conditions**: Fresh start or continuation from previous run
- **Status**: `running`, `completed`, `failed`, or `crashed`

### Phases

A **phase** is a discrete task configuration executed by Claude:

- **Phase ID**: Unique identifier from configuration (e.g., `phase-1`, `research`)
- **Prompt**: File or text containing instructions for Claude
- **Model**: Which Claude model to use (`sonnet` or `opus`)
- **Continuation Mode**: `fresh` (new conversation) or `continue-previous`
- **Workspace Setup**: Optional file copying and command execution
- **Tracked Files**: Glob patterns for files to watch and checkpoint

### Phase Execution

Each phase execution tracks its progress through multiple states:

```
preparing → starting → initializing → running → completed
    ↓          ↓           ↓            ↓
  failed    failed      failed       failed
    ↓          ↓           ↓            ↓
  skipped   skipped     skipped      skipped
```

## Module Structure

### Entry Points

- **`index.ts`**: CLI entry point, argument parsing, mode selection
- **`langton-server.ts`**: Main server class, orchestrates all components

### State Management

- **`state-manager.ts`**: Centralized state storage, transition processing, queries
- **`state-types.ts`**: TypeScript interfaces for all state structures
- **`state-transition-guards.ts`**: Validation for state transition metadata

### Process Control

- **`claude-process-manager.ts`**: Spawns and manages Claude CLI subprocesses
- **`claude-log-parser.ts`**: Parses Claude's JSONL output stream

### File Operations

- **`file-resolver.ts`**: Unified file resolution respecting .gitignore rules
- **`checkpoint-git.ts`**: Git operations for checkpoint system

### Infrastructure

- **`config.ts`**: Configuration loading, validation, and defaults
- **`error-types.ts`**: Error severity levels and custom error classes
- **`typed-event-emitter.ts`**: Type-safe event emitter wrapper
- **`command-schemas.ts`**: Zod schemas for command validation

### Utilities

- **`utils.ts`**: Common utilities (ID generation, logging, file operations)
- **`branded-types.ts`**: Branded type definitions for compile-time safety
- **`tool-types.ts`**: Claude tool input type definitions
- **`types.ts`**: Shared type definitions across the system

### Features

- **`basic-tui.ts`**: Terminal UI for testing and debugging
- **`cleanup-command.ts`**: Project cleanup functionality
- **`cleanup/`**: Cleanup implementation modules

## State Management System

### State Structure

The complete state is stored in `.langton/state.json`:

```typescript
interface LangtonState {
  runs: Run[]; // All runs, newest first
  currentRunId: RunId | null; // Active run or null
  initialCheckpoint?: string; // Git SHA of clean state
}
```

### State Transitions

State changes happen through typed transitions:

```typescript
// Example: Starting a new phase
stateManager.transition({
  type: "PhaseStarted",
  data: { runId, phaseId },
});

// Example: Updating costs
stateManager.transition({
  type: "CostsUpdated",
  data: { runId, phaseId, cost, tokens },
});
```

### Transition Types

1. **Run Lifecycle**: `RunStarted`, `RunCompleted`, `RunFailed`, `RunCrashed`
2. **Phase Lifecycle**: `PhaseStarted`, `PhaseTransitioned`
3. **Data Updates**: `CostsUpdated`, `AssistantMessageCountUpdated`, `CheckpointCreated`
4. **System Events**: `InitialCheckpointSet`

### Fire-and-Forget Processing

Transitions are queued and processed asynchronously:

```
transition() called → Queue → Validate → Apply → Persist → Emit Events
                        ↑                                          ↓
                        └──────────────────────────────────────────┘
```

### State Queries

The StateManager provides type-safe queries:

- `getCurrentRun()`: Get active run
- `getCurrentlyRunningPhase()`: Get executing phase
- `getNextPhaseToExecute()`: Determine next phase based on history
- `getLastSuccessfulPhase(phaseId)`: Find previous successful execution
- `getTotalCost()`: Calculate accumulated costs

## Phase Execution Lifecycle

### 1. Phase Start

```typescript
startPhase(phaseId) {
  1. Validate phase exists and no phase running
  2. Create "PhaseStarted" transition
  3. Execute workspace setup (if configured)
  4. Transition to "starting" status
  5. Spawn Claude process
}
```

### 2. Workspace Setup

Optional pre-phase operations:

```typescript
workspaceSetup: [
  { type: "copy", copy: { from: "../templates", to: "src" } },
  { type: "command", command: { run: "npm install" } },
];
```

### 3. Claude Process Management

```typescript
ClaudeProcessManager {
  1. Build CLI arguments (model, continuation, system prompt)
  2. Spawn process with proper environment
  3. Pipe stdout to log file
  4. Feed prompt to stdin
  5. Monitor exit and errors
}
```

### 4. Log Parsing

Real-time parsing of Claude's output:

```typescript
ClaudeLogParser {
  - Watch log file for new lines
  - Parse JSONL messages
  - Extract costs and tokens
  - Detect API timeouts
  - Trigger state updates
}
```

### 5. Phase Completion

```typescript
handlePhaseComplete(exitCode) {
  1. Wait for final log messages
  2. Determine success/failure/skip
  3. Create checkpoint
  4. Transition to terminal state
  5. Clean up resources
  6. Auto-start next phase (if enabled)
}
```

## WebSocket Protocol

### Connection Lifecycle

1. Client connects → Server accepts single connection
2. Server sends `server.ready` event
3. Server sends `state.snapshot` with current state
4. Client sends commands, server broadcasts events
5. Connection loss → Server shuts down

### Event Structure

All events follow this structure:

```typescript
{
  id: string;        // Unique event ID
  timestamp: string; // ISO 8601 timestamp
  type: string;      // Event type for routing
  data?: any;        // Event-specific payload
}
```

### Server → Client Events

#### System Events

- `server.ready`: Server initialized and ready
- `server.idle`: Server waiting for commands
- `state.snapshot`: Complete state dump
- `error`: Error occurred (may be fatal)
- `info`: Informational message

#### Phase Events

- `phase.started`: Phase execution began (includes session ID)
- `phase.completed`: Phase finished (success/failure/skip)
- `incomplete.phase`: Detected incomplete phase from previous run

#### Real-time Updates

- `assistant.action`: Claude's actions (message/thinking/tool_use)
- `token.usage`: Token consumption update
- `file.updated`: Watched file changed
- `filetree.updated`: File tree structure changed

#### Checkpoint Events

- `checkpoint.list`: Available checkpoints response
- `rollback.started`: Rollback operation began
- `rollback.progress`: Rollback progress update
- `rollback.completed`: Rollback finished

### Client → Server Commands

#### Phase Control

- `phase.start`: Start specific phase by ID
- `phase.next`: Start next phase in sequence
- `phase.skip`: Skip currently running phase
- `phase.redo`: Re-run last phase
- `phase.forceStop`: Force stop with failure

#### System Control

- `server.shutdown`: Graceful shutdown
- `checkpoint.list`: Query available checkpoints

#### Rollback Commands

- `rollback.toCheckpoint`: Rollback to specific SHA
- `rollback.toPhase`: Rollback to phase + checkpoint type
- `rollback.toLastSuccess`: Rollback to last successful phase

## Process Management

### Lock File System

The lock file (`.langton/server.lock`) prevents multiple instances:

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

### Process Lifecycle

1. **Startup**: Check lock file, detect crashes, create run
2. **Execution**: Manage Claude processes, track state
3. **Shutdown**: Kill processes, save state, remove lock

### Claude Process Arguments

```bash
claude --verbose \
  --dangerously-skip-permissions \
  --model {model} \
  --permission-mode bypassPermissions \
  -p \
  --output-format stream-json \
  [--resume {sessionId}] \
  [--append-system-prompt {prompt}]
```

## File System Operations

### Unified File Resolution

The `fileResolver` service provides consistent file handling:

```typescript
fileResolver.resolveFiles(projectPath, patterns) {
  1. Parse all .gitignore files in project
  2. Build ignore rules with proper precedence
  3. Apply glob patterns
  4. Filter through ignore rules
  5. Return resolved file list
}
```

### File Watching

Tool-based file tracking:

```typescript
handleFileToolCall(toolName, toolInput) {
  1. Extract file path from tool input
  2. Check if matches watch patterns
  3. Read file content
  4. Send file.updated event
  5. Update file tree
}
```

### Run-Specific Storage

Each run creates a folder:

```
.langton/
  runs/
    1234567890-abc/
      phase-research-claude.log
      phase-analysis-claude.log
```

## Checkpoint and Rollback System

### Shadow Git Repository

Checkpoints use a separate git repository:

```
.langton/
  checkpoints/
    .git/          # Git directory
    .gitconfig     # Isolated git config
```

### Checkpoint Creation

Checkpoints are created at key milestones:

1. **Workspace Setup**: After copying files and running commands
2. **Completion**: After successful phase completion
3. **Error**: After phase failure (for debugging)
4. **Skip**: When user skips a phase

### Rollback Process

Phase-by-phase rollback with workspace cleanup:

```typescript
executePhaseByPhaseRollback() {
  1. Clean up current phase state
  2. Identify phases to roll back through
  3. For each phase (in reverse):
     - Reset to phase checkpoint
     - Clean up workspace directories
  4. Apply target checkpoint
  5. Complete current run
  6. Start new continuation run
}
```

## Error Handling

### Error Severity Levels

```typescript
enum ErrorSeverity {
  FATAL = "fatal", // Server shutdown required
  PHASE = "phase", // Phase fails, server continues
  OPERATION = "operation", // Single operation fails
  WARNING = "warning", // Logged only
}
```

### Error Flow

1. Error occurs → Determine severity
2. Log error with context
3. Send error event to client
4. Take action based on severity

### Special Error Cases

- **API Timeout**: Detected in log parser, phase marked as failed
- **Process Crash**: Exit code handling, state cleanup
- **State Corruption**: Backup recovery, validation

## Type System

### Branded Types

Used for compile-time safety:

```typescript
type RunId = Branded<string, "RunId">;
type PhaseId = Branded<string, "PhaseId">;
type SessionId = Branded<string, "SessionId">;
```

### Discriminated Unions

Phase states use discriminated unions:

```typescript
type PhaseExecution =
  | { status: "preparing"; phaseId: PhaseId; ... }
  | { status: "running"; sessionId: SessionId; ... }
  | { status: "completed"; finalCost: number; ... }
```

### Exhaustive Checking

```typescript
switch (phase.status) {
  case "preparing": ...
  case "running": ...
  // TypeScript ensures all cases handled
  default: assertNever(phase);
}
```

## Configuration

### Phase Configuration Structure

```typescript
interface PhaseConfig {
  id: PhaseId;
  name: string;
  promptFile?: string | string[];
  promptText?: string;
  model: "sonnet" | "opus";
  continuationMode: "fresh" | "continue-previous";
  workspaceSetup?: WorkspaceSetupItem[];
  trackedFiles?: string[];
}
```

### Server Configuration

```typescript
interface ServerConfig {
  port: number;                    // WebSocket port
  projectPath: string;             // Project root
  phases: PhaseConfig[];           // Phase definitions
  costsPerMTok: { ... };          // Token pricing
  logParsingInterval: number;      // Log check frequency
  autostart: boolean;              // Auto-advance phases
}
```

### Configuration Loading

1. Load JSON file with phase definitions
2. Validate with Zod schemas
3. Resolve relative paths
4. Check file existence
5. Transform to internal types

## Development Patterns

### Event-Driven Architecture

Components communicate through typed events:

```typescript
class Component extends TypedEventEmitter<Events> {
  doWork() {
    this.emit("workDone", { result });
  }
}
```

### Async Queue Pattern

State transitions use async queue processing:

```typescript
transition(event) {
  queue.push(event);
  processQueue(); // Don't await
}
```

### Resource Cleanup

Consistent cleanup pattern:

```typescript
cleanup() {
  1. Stop timers/intervals
  2. Close file streams
  3. Kill subprocesses
  4. Remove event listeners
  5. Clear references
}
```

### Testing Approach

- State manager exposed as readonly
- Events emitted for test monitoring
- Configurable paths for isolation
- Process tracking via PIDs

### Logging Strategy

- Structured logs to `.langton/logs/`
- Socket traffic logging for debugging
- Event log in JSONL format
- Console output for errors only
