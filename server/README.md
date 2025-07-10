# Langton Server

A WebSocket-based orchestration server for managing Claude CLI sessions through configurable phases. The server provides real-time event streaming, file watching, state persistence, and cost tracking.

## Overview

Langton Server acts as a bridge between clients and the Claude CLI, managing multi-phase AI workflows with features like:

- **Phase-based execution**: Break complex tasks into discrete phases
- **Session continuity**: Phases can continue from previous sessions
- **Real-time updates**: Stream Claude's actions and file changes to clients
- **State persistence**: Recover from crashes using Claude's log files
- **Cost tracking**: Monitor token usage and calculate costs per phase
- **File watching**: Monitor project files for changes during execution
- **Workspace setup**: Copy files and run commands before phases start
- **Checkpoint system**: Git-based snapshots of work progress with selective file tracking
- **Cleanup system**: Remove all Langton artifacts and restore project to initial state

## Architecture

```
┌─────────────┐         WebSocket          ┌──────────────┐
│   Client    │ ◄─────────────────────────► │    Server    │
│ (Single)    │         Events/Commands     │   (Bun.js)   │
└─────────────┘                             └──────┬───────┘
                                                   │
                                          ┌────────┴────────┐
                                          │                 │
                                     ┌────▼───┐      ┌─────▼─────┐
                                     │ Claude │      │   File    │
                                     │  CLI   │      │  Watcher  │
                                     └────────┘      └───────────┘
```

## Directory Structure

```
server/
├── index.ts              # CLI entry point and argument parsing
├── langton-server.ts     # Core server implementation
├── claude-process-manager.ts # Claude subprocess lifecycle management
├── config.ts            # Configuration management and validation
├── types.ts             # TypeScript type definitions
├── type-guards.ts       # Runtime type validation guards
├── tool-types.ts        # Claude tool input type definitions
├── error-types.ts       # Error severity levels and custom errors
├── utils.ts             # Utility functions (logging, ID generation)
├── claude-log-parser.ts # Real-time Claude output parsing
├── checkpoint-git.ts    # Git-based checkpoint system
├── cleanup-command.ts   # Cleanup orchestration
├── cleanup/             # Cleanup module directory
│   ├── manifest-builder.ts # Analyzes what needs cleaning
│   ├── git-operations.ts   # Git reset functionality
│   ├── file-operations.ts  # Safe file removal
│   ├── command-analyzer.ts # Command side effect analysis
│   └── types.ts           # Cleanup-specific types
└── basic-tui.ts         # Terminal UI for testing
```

## Components

### 1. **index.ts** - CLI Entry Point

Handles command-line arguments and server initialization:

- `--config=<path>`: Path to phases configuration (default: phases.json)
- `--port=<port>`: WebSocket server port (default: 7777)
- `--basic`: Run with terminal UI for testing
- `--anthropic-base-url=<url>`: Custom API endpoint
- `--cleanup`: Clean up all Langton artifacts (requires --config)
- `-y`: Skip confirmation prompts (for cleanup)
- `--help`: Show help message

### 2. **langton-server.ts** - Core Server

Main orchestration engine that:

- Manages WebSocket connections (single client only)
- Executes phases sequentially or on-demand
- Delegates process management to ClaudeProcessManager
- Handles state transitions and persistence
- Emits real-time events to clients
- Implements phase skipping and recovery
- Manages result message promises with timeout handling
- Coordinates error handling with severity levels

### 3. **config.ts** - Configuration Management

- Validates phase configurations using Zod schemas
- Provides default server settings
- Calculates token costs based on model pricing
- Resolves file paths relative to config location

### 4. **types.ts** - Type Definitions

Complete TypeScript interfaces for:

- Server configuration (`ServerConfig`)
- Phase configuration (`PhaseConfig`)
- WebSocket events (server → client)
- WebSocket commands (client → server)
- Internal state management types

### 5. **utils.ts** - Utilities

Helper functions for:

- Unique ID generation
- Structured logging with timestamps
- WebSocket traffic logging
- File tree building
- Session ID extraction from logs

### 6. **claude-log-parser.ts** - Log Parser

Real-time parsing of Claude's JSONL output:

- Watches log files for new entries
- Validates and parses Claude messages
- Extracts token usage information
- Handles both streaming and batch parsing
- Processes result messages for accurate cost tracking

### 7. **checkpoint-git.ts** - Checkpoint System

Git-based checkpoint and snapshot system:

- Creates shadow git repository in `.langton/checkpoints/`
- Tracks files matching `checkpointAndWatch` patterns
- Creates commits at phase milestones (setup, completion, errors)
- Supports branching for error and exit scenarios
- Uses git exclude patterns for selective file tracking

### 8. **claude-process-manager.ts** - Process Manager

Dedicated Claude subprocess lifecycle management:

- Spawns Claude processes with proper arguments
- Manages stdin/stdout/stderr streams
- Handles log stream creation and cleanup
- Provides process monitoring and termination
- Emits process events (exit, error, stdout, stderr)
- Supports custom Anthropic base URLs

### 9. **type-guards.ts** - Type Guards

Runtime type validation for:

- Server events (phase.started, assistant.action, etc.)
- Client commands (phase.start, phase.skip, etc.)
- Ensures type safety at WebSocket boundaries
- Provides compile-time type narrowing

### 10. **tool-types.ts** - Tool Types

Strongly typed tool input definitions:

- Defines input schemas for all Claude tools
- Includes standard tools (Write, Read, Edit, etc.)
- Supports special tools (TodoWrite, exit_plan_mode)
- Provides ToolName type and validation

### 11. **error-types.ts** - Error Types

Hierarchical error handling system:

- ErrorSeverity enum (FATAL, PHASE, OPERATION, WARNING)
- Custom error classes for different severity levels
- Contextual error information
- Guides server behavior based on error severity

### 12. **basic-tui.ts** - Terminal UI

Simple terminal interface for testing:

- Connects as a WebSocket client
- Displays events with color coding
- Provides keyboard shortcuts for phase control
- Shows real-time costs and token usage

### 13. **cleanup-command.ts** - Cleanup System

Main cleanup orchestration that:

- Analyzes what needs to be cleaned using ManifestBuilder
- Removes copied directories from workspace setup
- Removes .langton directory (logs, checkpoints, lock file)
- Resets git-tracked files to initial commit
- Provides safety checks to prevent deletion outside project
- Shows warnings about commands that cannot be undone

### 14. **cleanup/** - Cleanup Modules

Modular cleanup implementation:

- **manifest-builder.ts**: Analyzes configuration to determine what to clean
- **git-operations.ts**: Handles git reset to initial commit
- **file-operations.ts**: Safe file and directory removal with validation
- **command-analyzer.ts**: Analyzes commands for potential side effects
- **types.ts**: TypeScript types for cleanup operations

## Phase Configuration

Phases are configured via JSON with the following schema:

```typescript
interface PhaseConfig {
  id: string; // Unique identifier
  name: string; // Display name
  promptFile?: string | string[]; // Path(s) to prompt file(s)
  promptText?: string; // Inline prompt text
  appendSystemPromptFile?: string | string[]; // Path(s) to system prompt file(s)
  appendSystemPromptText?: string; // Inline system prompt text
  model: string; // Claude model to use
  continueFromPrevious?: boolean; // Continue from previous phase
  preStart?: string; // Shell command to run before phase (DEPRECATED)
  workspaceSetup?: WorkspaceSetupItem[]; // Workspace setup operations
  watch?: string; // Glob pattern for file watching
  checkpointAndWatch?: string[]; // Glob patterns for checkpoint tracking
  description?: string; // Phase description
}

interface WorkspaceSetupItem {
  type: "copy" | "command";
  copy?: {
    from: string; // Source path (relative to config or absolute)
    to: string; // Target path relative to projectPath
  };
  command?: {
    run: string; // Shell command to execute
    workingDirectory?: "project" | "lastCopied"; // Where to run command
  };
}
```

Example configuration:

```json
[
  {
    "id": "phase-1",
    "name": "Initial Setup",
    "promptFile": "./prompts/setup.md",
    "appendSystemPromptFile": "./prompts/system-instructions.md",
    "model": "claude-3-opus-20240229",
    "workspaceSetup": [
      {
        "type": "command",
        "command": { "run": "mkdir -p output" }
      }
    ],
    "watch": "./output/**/*.ts",
    "checkpointAndWatch": ["output/**/*.ts", "*.md"]
  },
  {
    "id": "phase-2",
    "name": "Setup from Template",
    "promptFile": "./prompts/customize.md",
    "model": "claude-3-sonnet-20240229",
    "workspaceSetup": [
      {
        "type": "copy",
        "copy": {
          "from": "../templates/typescript-starter",
          "to": "src/app"
        }
      },
      {
        "type": "command",
        "command": {
          "run": "npm install",
          "workingDirectory": "lastCopied"
        }
      },
      {
        "type": "copy",
        "copy": {
          "from": "./configs/tsconfig.json",
          "to": "src/app/tsconfig.json"
        }
      }
    ],
    "watch": "./src/**/*.ts",
    "checkpointAndWatch": ["src/**/*.ts", "package.json"]
  }
]
```

### Workspace Setup

The `workspaceSetup` field allows you to prepare the workspace before a phase starts by copying files/directories and running commands:

- **Copy operations**: Copy files or directories from templates or other locations
  - `from`: Source path (relative to config file or absolute)
  - `to`: Target path relative to project directory (parent must exist)
  - Always specify the full target path including the name
- **Command operations**: Run shell commands in specific directories
  - `run`: Shell command to execute
  - `workingDirectory`: Either `"project"` (default) or `"lastCopied"` (the last copied directory)

Operations are executed in order, and all must succeed for the phase to start. If `preStart` is also specified, it runs before `workspaceSetup`.

### Checkpoint System

The `checkpointAndWatch` field specifies which files should be tracked in the git-based checkpoint system:

- **Shadow Repository**: Creates a git repo in `.langton/checkpoints/`
- **Selective Tracking**: Only files matching the glob patterns are tracked
- **Automatic Commits**: Creates commits at phase milestones:
  - `workspace-setup`: After workspace operations complete
  - `completed`: When phase finishes successfully
  - `skipped`: When phase is manually skipped
  - `error`: When phase fails (creates error branch)
  - `exit`: When server is force-shutdown (creates exit branch)
- **Branch Management**: Error and exit scenarios create separate branches to preserve main timeline
- **Commit Messages**: Machine-parseable format with phase info, timestamps, and durations

### Multiple File Support

Both `promptFile` and `appendSystemPromptFile` support arrays of file paths. When multiple files are provided:

- Files are read in the order specified
- Contents are concatenated with double newlines (`\n\n`) between them
- All paths are resolved relative to the configuration file location
- Template variables like `<%PROJECT_DIR%>` are replaced in all files

## WebSocket Protocol

### Server → Client Events

All events follow this base structure:

```typescript
{
  id: string;        // Unique event ID
  timestamp: string; // ISO 8601 timestamp
  type: string;      // Event type
  data?: any;        // Event-specific data
}
```

#### Event Types:

- **`server.ready`**: Server initialized and ready
- **`state.snapshot`**: Complete current state
- **`phase.started`**: Phase execution began
- **`phase.completed`**: Phase finished (success/failure)
- **`assistant.action`**: Claude performed an action
- **`token.usage`**: Token consumption update
- **`file.updated`**: Watched file changed
- **`filetree.updated`**: File tree structure changed
- **`error`**: Error occurred (fatal/non-fatal)
- **`info`**: Informational message

### Client → Server Commands

Commands follow this structure:

```typescript
{
  id: string;   // Client-generated ID
  type: string; // Command type
  data?: any;   // Command-specific data
}
```

#### Command Types:

- **`phase.start`**: Start specific phase by ID
- **`phase.next`**: Start next phase in sequence
- **`phase.skip`**: Skip current running phase
- **`phase.redo`**: Re-run last completed phase
- **`server.shutdown`**: Gracefully shutdown server

## State Management

### Persistence

- **Claude Logs**: State persisted through JSONL log files in `.langton/logs/`
- **Server Logs**: Operations logged to `.langton/logs/server.log`
- **Lock File**: `.langton/server.lock` prevents multiple server instances
- **Checkpoints**: Git-based snapshots in `.langton/checkpoints/` for tracked files
- **Result Messages**: Phase completion costs tracked via result message promises
- Server can recover from crashes by reading logs and checkpoint history

### Result Message Handling

The server implements a promise-based system for tracking Claude's result messages:

- Creates promises when phases complete to wait for final cost data
- 30-second timeout for result messages (continues if timeout occurs)
- Updates phase costs and token usage from result messages
- Cleans up promises on server shutdown

### Phase States

1. **Idle**: No phase running
2. **Running**: Phase actively executing
3. **Completed**: Phase finished successfully
4. **Failed**: Phase terminated with error
5. **Skipped**: Phase was skipped by user

## Security Considerations

1. **Single Client**: Only one client connection allowed
2. **File Access**: Server runs with full file system access
3. **Command Injection**: Pre-start commands are executed directly
4. **API Keys**: Managed by Claude CLI, not the server

## Error Handling

The server uses a severity-based error handling system:

### Error Severities

- **FATAL**: Triggers immediate server shutdown
- **PHASE**: Current phase fails, server remains operational
- **OPERATION**: Single operation fails, phase continues
- **WARNING**: Logged but no action taken

### Error Flow

- All errors logged with appropriate severity level
- Fatal errors emit error event and trigger shutdown
- Phase errors stop current phase execution
- Operation errors allow continuation
- Custom error classes provide context

### Common Error Scenarios

- **Connection errors**: Client disconnection (FATAL)
- **Process crashes**: Claude process failure (PHASE)
- **File operations**: Workspace setup failures (OPERATION)
- **State recovery**: Log parsing issues (WARNING)

## Usage Examples

### Basic Usage

```bash
# Start with default configuration
bun server/index.ts

# Use custom phases configuration
bun server/index.ts --config=my-phases.json

# Run on different port
bun server/index.ts --port=8080

# Test with terminal UI
bun server/index.ts --basic

# Clean up all Langton artifacts
bun server/index.ts --cleanup --config=my-phases.json

# Clean up without confirmation
bun server/index.ts --cleanup --config=my-phases.json -y
```

### Programmatic Usage

```typescript
import { LangtonServer } from "./langton-server.js";

const server = new LangtonServer({
  projectPath: process.cwd(),
  phases: [
    /* phase configs */
  ],
  port: 7777,
});

await server.start();
```

## Development

### Running Tests

See the tests folder README for comprehensive testing information.

### Key Files to Modify

- Add new events: Update `types.ts` and emit in `langton-server.ts`
- Change protocol: Update both `types.ts` and client code
- Add configuration: Update `config.ts` schema and defaults
- Modify logging: Update `claude-log-parser.ts` parsing logic
- Add tool support: Update `tool-types.ts` with new tool schemas
- Add type guards: Update `type-guards.ts` for new event/command types
- Change error handling: Update `error-types.ts` and error flow

## Philosophy

The server is designed with these principles:

1. **Simplicity**: Single client, clear phase progression
2. **Transparency**: All actions are logged and streamed
3. **Recoverability**: State persists through crashes
4. **Extensibility**: Easy to add new events and commands
5. **Testability**: Comprehensive test suite with E2E tests

## Cleanup System

The cleanup system provides a way to remove all Langton artifacts and restore the project to its initial state:

### What Gets Cleaned

- **Copied directories**: All directories copied via workspace setup
- **Git-tracked files**: Reset to initial commit (if checkpoint system was used)
- **.langton directory**: Complete removal including logs, checkpoints, and lock file

### What Is Preserved

- **Command-created directories**: Directories created by commands (e.g., `mkdir -p notes`)
- **Files outside tracked patterns**: Files not matching checkpointAndWatch patterns
- **Pre-existing files**: Any files that existed before Langton was run

### Safety Features

- Requires explicit --config parameter to prevent accidental cleanup
- Shows detailed preview of what will be removed
- Interactive confirmation (can be skipped with -y)
- Refuses to run if server is currently running
- Validates all paths to prevent deletion outside project directory

### Limitations

- Cannot undo executed commands (shows warnings)
- Cannot restore files modified by Claude outside of git tracking
- Git reset may fail if repository is in an inconsistent state
