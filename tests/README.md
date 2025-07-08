# Langton Server Tests

Comprehensive end-to-end test suite for the Langton Server, including happy path testing and phase skipping scenarios.

## Overview

The test suite validates the complete server functionality through realistic multi-phase workflows. All tests use the actual Claude CLI to ensure real-world compatibility and include validation of the checkpoint system, workspace setup, file organization, and the refactored architecture with ClaudeProcessManager integration.

## Quick Start

```bash
# Run all tests
bun run test

# Run specific test suites
bun run test:happy          # Happy path only
bun run test:skip           # Skip tests only
bun run test:skip-continue  # Skip and continue test
bun run test:skip-quit      # Skip and quit test
```

## Test Structure

```
tests/
├── config/                      # Test configuration files
│   └── test-phases.config.json  # Default 3-phase test configuration
├── e2e/                         # End-to-end tests
│   ├── happy-path-e2e.test.ts          # Full workflow test
│   ├── skip-phase-continue-e2e.test.ts # Skip and continue test
│   └── skip-phase-quit-e2e.test.ts     # Skip and quit test
├── utils/                       # Test utilities
│   ├── check-test-ready.ts      # Pre-test environment verification
│   ├── cleanup-test.sh          # Manual cleanup script
│   └── sanity-check.ts          # Detailed environment check
├── test-area/                   # Test execution directory (gitignored)
├── test-results/                # Test logs and artifacts (gitignored)
├── test-summary.md              # Test implementation summary
└── README.md                    # This file
```

## Test Scenarios

### 1. Happy Path Test (`happy-path-e2e.test.ts`)

Tests the complete successful workflow:

- **Phase 1**: Uses workspace setup to create notes directory, creates poems and saves favorite to `notes/favorite_poem.txt`
- **Phase 2**: Continues from Phase 1, saves second favorite poem
- **Phase 3**: Uses workspace setup to copy typescript_structure and run bun install, converts poems to TypeScript code

Validates:

- All expected files are created
- WebSocket events are properly sequenced
- Cost tracking matches log files with result message integration
- Token usage is accurate from both streaming and result messages
- Session continuity works
- File watching events fire correctly
- Workspace setup operations work correctly:
  - Directory creation via command
  - Directory copying
  - Command execution in copied directory (`lastCopied`)
- Checkpoint system creates proper git commits:
  - Workspace setup commits
  - Phase completion commits
  - File tracking matches `checkpointAndWatch` patterns
  - Commit messages follow expected format
- Tool usage validation including TodoWrite tool support
- Type safety maintained across server and test boundaries

### 2. Skip and Continue Test (`skip-phase-continue-e2e.test.ts`)

Tests phase skipping with continuation:

- Starts phase 1 (using traditional `preStart`), skips it mid-execution
- Verifies server continues to phase 2
- Completes phase 2 normally
- Skips phase 3
- Verifies proper cleanup and state management
- Validates that `preStart` still works for backward compatibility
- Tests checkpoint system with skipped phases:
  - Skipped phases create `skipped` commits (even if empty)
  - Only successful phases have tracked files
  - No error branches created for normal skips
- Validates result message handling for skipped phases:
  - No result message wait for skipped phases
  - Proper timeout handling for completed phases

### 3. Skip and Quit Test (`skip-phase-quit-e2e.test.ts`)

Tests skipping the final phase:

- Runs phase 1 to completion (using traditional `preStart`)
- Starts phase 2 (last phase), skips it
- Verifies server shuts down gracefully  
- Checks that resources are cleaned up properly including:
  - Lock file removal
  - Process termination
  - Log stream closure
  - Result message promise cleanup
- Validates that `preStart` creates directories as expected
- Tests normal completion checkpoints:
  - No exit branch created (normal completion)
  - Phase completion commits for successful phases
  - Skipped commit for final phase


## Test Architecture

### WebSocket Test Client

Each test creates a minimal WebSocket client that:

- Connects to the server on a unique port
- Collects all server events with type-safe event handling
- Provides helper methods for waiting on specific events
- Sends commands to control phase execution
- Validates events using type guards from the server

### Test Utilities

**`check-test-ready.ts`**: Verifies environment before tests:

- Working directory is project root
- Test directories exist
- Server is not already running
- Claude CLI is available

**`sanity-check.ts`**: Detailed environment validation:

- All dependencies installed
- Configuration files valid
- File permissions correct
- API keys configured

**`cleanup-test.sh`**: Manual cleanup for stuck tests:

- Finds and kills orphaned server processes
- Removes lock files
- Cleans test directories

### Test Configuration

Tests can use custom phase configurations or the default `test-phases.config.json`:

```json
[
  {
    "id": "phase-1",
    "name": "Phase 1: TestPhase1",
    "promptFile": ["./phase1Prompt1.md", "./phase1Prompt2.md"],
    "appendSystemPromptFile": ["./systemPrompt1.md", "./systemPrompt2.md"],
    "model": "sonnet",
    "workspaceSetup": [
      {
        "type": "command", 
        "command": { "run": "mkdir -p notes" }
      }
    ],
    "watch": "./notes/*.txt",
    "checkpointAndWatch": ["notes/**/*"]
  }
  // ... more phases
]
```

The test configuration demonstrates several key features:
- **Multiple file support**: Both prompt files and system prompt files can be specified as arrays
- **Workspace setup**: Modern `workspaceSetup` approach alongside legacy `preStart` for compatibility testing  
- **Checkpoint tracking**: `checkpointAndWatch` patterns for git-based snapshots

## Running Tests

### Prerequisites

1. Claude CLI installed and configured
2. Valid Anthropic API key
3. Bun.js runtime
4. Run from project root directory

### Test Commands

```bash
# Full test suite with cleanup
bun run test

# Individual test suites
bun run test:happy
bun run test:skip-continue
bun run test:skip-quit

# Utilities
bun run test:check    # Verify test environment
bun run test:sanity   # Detailed environment check
bun run test:cleanup  # Clean up stuck tests
```

### Test Execution Flow

1. **Pre-test**: Cleans test area and results directories
2. **Test runs**: Each test spawns its own server instance
3. **Assertions**: Validates events, files, and state
4. **Cleanup**: Shuts down server and preserves logs

## Test Artifacts

### During Execution

- **`test-area/`**: Working directory for Claude
  - `.langton/logs/`: Claude session logs (JSONL format)
  - `.langton/checkpoints/`: Git repository with tracked files
  - `.langton/server.lock`: Server lock file
  - `notes/`: Test file outputs
  - Configuration files

### After Execution

- **`test-results/`**: Timestamped test runs
  - `server.log`: Server output
  - `claude-logs/`: Copied Claude logs
  - `websocket-events.json`: All WebSocket events

## Important Notes

1. **Working Directory**: Tests MUST run from project root
2. **Port Usage**: Each test uses a different port:
   - Happy path: 7777 (or `LANGTON_TEST_PORT`)
   - Skip continue: 7778
   - Skip quit: 7779
3. **API Usage**: Tests consume real Claude API credits
4. **Cleanup**: Always runs between tests automatically
5. **Timeouts**: Tests have 2-5 minute timeouts
6. **Environment Variables**: Set `LANGTON_TEST_PORT` to use custom port
7. **Type Checking**: Tests are included in TypeScript compilation for full type safety
8. **Process Management**: Tests validate proper cleanup of ClaudeProcessManager resources

## Debugging Failed Tests

1. Check `test-results/` for the specific test run
2. Review `server.log` for server errors
3. Check Claude logs in `claude-logs/` for AI errors
4. Inspect `websocket-events.json` for event sequence
5. Run `bun run test:cleanup` if processes are stuck

## Writing New Tests

1. Create new test file with `.test.ts` extension
2. Import test client from existing tests
3. Use unique port number (avoid 7777-7779)
4. Follow existing test structure:

   ```typescript
   // Setup
   await setupTestDirectory();
   const server = startServer();
   const client = new TestWSClient();

   // Execute test scenario
   await client.connect();
   // ... test logic

   // Assertions
   describe("Test Suite", () => {
     test("assertion", () => {
       expect(result).toBe(expected);
     });
   });

   // Cleanup
   afterAll(async () => {
     await cleanup();
   });
   ```

## Philosophy

The test suite follows these principles:

1. **Real-world testing**: Uses actual Claude CLI, not mocks
2. **Isolation**: Each test runs independently
3. **Observability**: All actions logged and preserved
4. **Determinism**: Tests produce consistent results
5. **Comprehensiveness**: Cover success and failure paths
