# Langton Runner

A WebSocket-based orchestration system for managing multi-phase Claude CLI workflows with real-time event streaming, file watching, and state persistence.

## Overview

Langton Runner provides a server that orchestrates Claude CLI sessions through configurable phases, allowing you to break complex AI tasks into manageable steps with features like:

- **🔄 Phase-based execution**: Sequential or on-demand phase execution
- **💾 State persistence**: Recover from crashes using Claude's logs
- **📡 Real-time streaming**: WebSocket events for all Claude actions
- **👁️ File watching**: Monitor project files during execution
- **💰 Cost tracking**: Per-phase and total cost calculation
- **🔗 Session continuity**: Phases can continue previous conversations
- **📦 Workspace setup**: Copy files and run commands before phases
- **📸 Checkpoint system**: Git-based snapshots of your work progress
- **🧹 Cleanup system**: Remove all Langton artifacts and restore to initial state

## Quick Start

```bash
# Install dependencies
bun install

# Start the server
bun run server

# Run with terminal UI for testing
bun run server:basic

# Run tests
bun run test

# Clean up project (requires --config)
bun run server -- --cleanup --config=phases.json
```

## Project Structure

```
langton-runner/
├── server/              # WebSocket server implementation
│   ├── index.ts         # CLI entry point
│   ├── langton-server.ts # Core server logic
│   ├── claude-process-manager.ts # Claude subprocess lifecycle management
│   ├── config.ts        # Configuration management
│   ├── types.ts         # TypeScript definitions
│   ├── type-guards.ts   # Runtime type validation
│   ├── tool-types.ts    # Claude tool type definitions
│   ├── error-types.ts   # Error severity and handling
│   ├── utils.ts         # Utility functions
│   ├── claude-log-parser.ts # Claude output parsing
│   ├── checkpoint-git.ts # Git-based checkpoint system
│   ├── cleanup-command.ts # Cleanup orchestration
│   ├── cleanup/         # Cleanup modules
│   │   ├── manifest-builder.ts # Analyzes what to clean
│   │   ├── git-operations.ts   # Git reset functionality
│   │   ├── file-operations.ts  # Safe file removal
│   │   ├── command-analyzer.ts # Command side effects
│   │   └── types.ts           # Cleanup types
│   ├── basic-tui.ts     # Terminal UI
│   └── README.md        # Detailed server documentation
├── tests/               # Comprehensive test suite
│   ├── e2e/            # End-to-end tests
│   ├── utils/          # Test utilities
│   ├── config/         # Test configurations
│   └── README.md       # Test documentation
├── types/              # Shared type definitions
│   └── claude-session-schema.ts
├── package.json        # Project configuration
├── TODOs.md            # Human-only development notes
├── REFACTOR_PLAN.md    # Detailed refactoring implementation plan
├── tsconfig.json       # TypeScript configuration
├── biome.json         # Code formatting config
└── README.md          # This file
```

## Core Concepts

### Phases

A phase represents a discrete task for Claude with its own:

- Prompt (file or inline text)
- Model selection
- Workspace setup operations (copy files, run commands)
- File watching and checkpoint patterns
- Continuation settings

### Phase Configuration

Create a `phases.json` file:

```json
[
  {
    "id": "research",
    "name": "Research Phase",
    "promptFile": "./prompts/research.md",
    "appendSystemPromptFile": "./prompts/research-guidelines.md",
    "model": "claude-3-opus-20240229",
    "workspaceSetup": [
      {
        "type": "command",
        "command": { "run": "mkdir -p research" }
      }
    ],
    "watch": "./research/**/*.md",
    "checkpointAndWatch": ["research/**/*"]
  },
  {
    "id": "implement",
    "name": "Implementation Phase",
    "promptFile": ["./prompts/context.md", "./prompts/implementation-task.md"],
    "appendSystemPromptFile": [
      "./prompts/coding-standards.md",
      "./prompts/best-practices.md"
    ],
    "model": "claude-3-sonnet-20240229",
    "continueFromPrevious": true,
    "workspaceSetup": [
      {
        "type": "copy",
        "copy": { "from": "../templates/project", "to": "src" }
      },
      {
        "type": "command",
        "command": { "run": "npm install", "workingDirectory": "lastCopied" }
      }
    ],
    "watch": "./src/**/*.ts",
    "checkpointAndWatch": ["src/**/*.ts", "package.json"]
  }
]
```

**Key Features**:

- **Multiple File Support**: Both `promptFile` and `appendSystemPromptFile` can accept arrays of file paths. Files are concatenated with double newlines between them.
- **Workspace Setup**: Use `workspaceSetup` to copy files and run commands before a phase starts. Supports both file operations and shell commands.
- **Checkpoint System**: Use `checkpointAndWatch` to specify which files should be tracked in git-based snapshots of your work progress.

### WebSocket Protocol

The server uses WebSocket for bidirectional communication:

**Server → Client Events**:

- `server.ready`: Server initialized
- `phase.started`: Phase execution began
- `phase.completed`: Phase finished
- `assistant.action`: Claude performed an action
- `file.updated`: Watched file changed
- `token.usage`: Token consumption update

**Client → Server Commands**:

- `phase.start`: Start specific phase
- `phase.next`: Continue to next phase
- `phase.skip`: Skip current phase
- `server.shutdown`: Graceful shutdown

## Usage

### Command Line

```bash
# Basic usage
bun run server

# Custom configuration
bun run server -- --config=my-phases.json

# Different port
bun run server -- --port=8080

# With terminal UI
bun run server:basic

# Custom API endpoint
bun run server -- --anthropic-base-url=https://proxy.example.com

# Clean up all Langton artifacts
bun run server -- --cleanup --config=phases.json

# Clean up without confirmation prompt
bun run server -- --cleanup --config=phases.json -y
```

### Available Scripts

```bash
# Development
bun run server        # Start server
bun run server:basic  # Start with terminal UI

# Code quality
bun run lint         # Check code style
bun run lint:fix     # Fix code style
bun run format       # Format code
bun run type-check   # TypeScript validation
bun run build        # Full build check

# Testing
bun run test         # Run all tests
bun run test:happy   # Happy path test only
bun run test:skip    # Skip tests only
bun run test:check   # Pre-test environment check
bun run test:cleanup # Clean up stuck tests

# Cleanup
bun run cleanup:example  # Clean up with phases.json
bun run cleanup:force    # Clean up without prompts
```

## Architecture

### Server Components

1. **WebSocket Server**: Single-client connection for security
2. **Phase Executor**: Manages Claude process lifecycle via ClaudeProcessManager
3. **Process Manager**: Dedicated subprocess lifecycle management with logging
4. **Log Parser**: Real-time parsing of Claude's output with result message handling
5. **File Watcher**: Monitors project files during execution
6. **State Manager**: Persists state through Claude logs
7. **Error Handler**: Severity-based error handling (Fatal, Phase, Operation, Warning)
8. **Type Guards**: Runtime validation for WebSocket messages and tool inputs
9. **Cleanup System**: Comprehensive cleanup of all Langton artifacts

### Event Flow

```
Client ←→ WebSocket ←→ Server
                         ↓
                    Phase Executor
                         ↓
                 ClaudeProcessManager
                         ↓
                    Claude CLI → Log Parser
                         ↓              ↓
                    File Watcher    Result Messages
```

### State Persistence

State is persisted through multiple mechanisms:

- **Claude Logs**: `.langton/logs/log-{phase-id}.jsonl` - Claude session logs
- **Server Logs**: `.langton/logs/server.log` - Server operation logs
- **Lock File**: `.langton/server.lock` - Prevents multiple server instances
- **Checkpoints**: `.langton/checkpoints/` - Git-based snapshots of tracked files
- Server reads logs on startup to recover state and track completed phases with costs and durations

## Testing

The project includes comprehensive end-to-end tests:

```bash
# Run all tests
bun run test

# Run specific test suite
bun run test:happy          # Success scenarios
bun run test:skip-continue  # Skip and continue
bun run test:skip-quit      # Skip and shutdown
```

Tests validate:

- Complete phase workflows
- Event streaming accuracy
- File watching functionality
- Cost tracking precision with result message integration
- Error handling with severity levels
- State recovery from logs and checkpoints
- Type safety across server and test code
- Process lifecycle management
- Workspace setup operations
- Cleanup functionality and artifact removal

### Test Infrastructure

The test suite includes:

- **Isolated Test Directories**: Each test runs in its own subdirectory to prevent conflicts
- **Cleanup Integration**: Automatic cleanup after tests using `force` mode for reliability
- **Checkpoint Validation**: Tests capture git state before cleanup for verification
- **Comprehensive Coverage**: Unit tests for cleanup utilities and e2e tests for integration

## Cleanup System

Langton includes a comprehensive cleanup system to remove all artifacts and restore your project to its initial state:

### Usage

```bash
# Clean up with confirmation prompt
bun run server -- --cleanup --config=phases.json

# Skip confirmation (useful for scripts)
bun run server -- --cleanup --config=phases.json -y
```

### What Gets Cleaned

- **Copied Directories**: All directories copied via `workspaceSetup`
- **Git-tracked Files**: Reset to initial commit (if checkpoint system was used)
- **.langton Directory**: Complete removal including:
  - Server and Claude logs
  - Checkpoint git repository
  - Lock files

### What Is Preserved

- **Command-created Directories**: Directories created by shell commands (e.g., `mkdir -p notes`)
- **Files Outside Tracked Patterns**: Files not matching `checkpointAndWatch` patterns
- **Pre-existing Files**: Any files that existed before Langton was run

### Safety Features

- Requires explicit `--config` parameter to prevent accidental cleanup
- Shows detailed preview of what will be removed
- Interactive confirmation (can be skipped with `-y`)
- Refuses to run if server is currently running
- Validates all paths to prevent deletion outside project directory

### Test Integration

The cleanup system is integrated into all e2e tests with a robust pattern:

```typescript
import { executeTestCleanup } from "../utils/cleanup-integration.js";

afterAll(async () => {
  const cleanupResult = await executeTestCleanup({
    testDir: TEST_DIR,
    phasesConfig: PHASES_CONFIG,
    force: true, // Falls back to manual cleanup if needed
  });
});
```

This ensures test isolation and prevents interference between test runs.

## Security Considerations

1. **Single Client**: Only one WebSocket connection allowed
2. **File Access**: Server has full filesystem access
3. **Command Execution**: Pre-start commands run directly
4. **API Keys**: Managed by Claude CLI, not the server

## Error Handling

- **Fatal Errors**: Trigger graceful shutdown
- **Phase Failures**: Stop execution, preserve state
- **Connection Loss**: Server shuts down
- **Process Crashes**: State recoverable from logs

## Requirements

- **Bun.js**: Runtime and package manager
- **Claude CLI**: Installed and configured with API access
- **TypeScript**: For development (strict type checking enabled)
- **Unix-like OS**: For shell commands and process management
- **Git**: For checkpoint system functionality

## Philosophy

Langton Runner is designed with these principles:

1. **Simplicity**: Clear phase progression, minimal configuration
2. **Transparency**: All actions logged and streamed
3. **Recoverability**: Crash-resistant through log persistence
4. **Testability**: Comprehensive test coverage
5. **Extensibility**: Easy to add new events and features

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `bun run test`
5. Run linting: `bun run lint`
6. Submit a pull request

## License

[Add your license here]

## Support

For issues, questions, or contributions:

- Check the server README for detailed documentation
- Review the test README for testing guidance
- Open an issue for bugs or feature requests
