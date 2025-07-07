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
├── config.ts            # Configuration management and validation
├── types.ts             # TypeScript type definitions
├── utils.ts             # Utility functions (logging, ID generation)
├── claude-log-parser.ts # Real-time Claude output parsing
└── basic-tui.ts         # Terminal UI for testing
```

## Components

### 1. **index.ts** - CLI Entry Point
Handles command-line arguments and server initialization:
- `--config=<path>`: Path to phases configuration (default: phases.json)
- `--port=<port>`: WebSocket server port (default: 7777)
- `--basic`: Run with terminal UI for testing
- `--anthropic-base-url=<url>`: Custom API endpoint
- `--help`: Show help message

### 2. **langton-server.ts** - Core Server
Main orchestration engine that:
- Manages WebSocket connections (single client only)
- Executes phases sequentially or on-demand
- Spawns and monitors Claude processes
- Handles state transitions and persistence
- Emits real-time events to clients
- Implements phase skipping and recovery

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

### 7. **basic-tui.ts** - Terminal UI
Simple terminal interface for testing:
- Connects as a WebSocket client
- Displays events with color coding
- Provides keyboard shortcuts for phase control
- Shows real-time costs and token usage

## Phase Configuration

Phases are configured via JSON with the following schema:

```typescript
interface PhaseConfig {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  promptFile?: string | string[]; // Path(s) to prompt file(s)
  promptText?: string;           // Inline prompt text
  appendSystemPromptFile?: string | string[]; // Path(s) to system prompt file(s)
  appendSystemPromptText?: string; // Inline system prompt text
  model: string;                 // Claude model to use
  continueFromPrevious?: boolean; // Continue from previous phase
  preStart?: string;             // Shell command to run before phase (DEPRECATED)
  workspaceSetup?: WorkspaceSetupItem[]; // Workspace setup operations
  watch?: string;                // Glob pattern for file watching
  description?: string;          // Phase description
}

interface WorkspaceSetupItem {
  type: "copy" | "command";
  copy?: {
    from: string;  // Source path (relative to config or absolute)
    to: string;    // Target path relative to projectPath
  };
  command?: {
    run: string;   // Shell command to execute
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
    "preStart": "mkdir -p output",
    "watch": "./output/**/*.ts"
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
    "watch": "./src/**/*.ts"
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
- State is persisted through Claude's JSONL log files
- Server can recover from crashes by reading logs
- Lock file prevents multiple server instances

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

- **Fatal errors**: Trigger server shutdown
- **Phase failures**: Stop execution, maintain state
- **Connection errors**: Client disconnection triggers shutdown
- **Process crashes**: State recoverable from logs

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
```

### Programmatic Usage
```typescript
import { LangtonServer } from "./langton-server.js";

const server = new LangtonServer({
  projectPath: process.cwd(),
  phases: [/* phase configs */],
  port: 7777
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

## Philosophy

The server is designed with these principles:
1. **Simplicity**: Single client, clear phase progression
2. **Transparency**: All actions are logged and streamed
3. **Recoverability**: State persists through crashes
4. **Extensibility**: Easy to add new events and commands
5. **Testability**: Comprehensive test suite with E2E tests