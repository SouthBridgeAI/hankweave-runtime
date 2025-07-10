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
│   └── server-shutdown-e2e.test.ts     # Server shutdown test
├── utils/                       # Test utilities
│   ├── check-test-ready.ts      # Pre-test environment verification
│   ├── cleanup-test.sh          # Manual cleanup script
│   ├── sanity-check.ts          # Detailed environment check
│   └── cleanup-integration.ts   # Test cleanup integration helper
├── unit/                        # Unit tests
│   ├── cleanup-integration.test.ts # Tests for cleanup integration
│   └── ...                      # Other unit tests
├── test-area/                   # Test execution directory (gitignored)
│   ├── happy-path/              # Isolated directory for happy-path test
│   ├── skip-continue/           # Isolated directory for skip-continue test
│   └── server-shutdown/         # Isolated directory for server-shutdown test
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

### 3. Server Shutdown Test (`server-shutdown-e2e.test.ts`)

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
2. **Test Isolation**: Each test uses its own subdirectory in `test-area/`:
   - `happy-path/`: Used by happy-path-e2e.test.ts
   - `skip-continue/`: Used by skip-phase-continue-e2e.test.ts
   - `server-shutdown/`: Used by server-shutdown-e2e.test.ts
3. **Port Usage**: Each test uses a different port:
   - Happy path: 7780 (or `LANGTON_TEST_PORT`)
   - Skip continue: 7778
   - Server shutdown: 7779
4. **API Usage**: Tests consume real Claude API credits
5. **Cleanup**: Always runs in `afterAll()` using the cleanup integration
6. **Timeouts**: Tests have 2-5 minute timeouts
7. **Environment Variables**: Set `LANGTON_TEST_PORT` to use custom port
8. **Type Checking**: Tests are included in TypeScript compilation for full type safety
9. **Process Management**: Tests validate proper cleanup of ClaudeProcessManager resources

## Debugging Failed Tests

1. Check `test-results/` for the specific test run
2. Review `server.log` for server errors
3. Check Claude logs in `claude-logs/` for AI errors
4. Inspect `websocket-events.json` for event sequence
5. Run `bun run test:cleanup` if processes are stuck

## Test Patterns and Best Practices

### Test Directory Isolation

Each e2e test uses its own subdirectory to prevent conflicts:

```typescript
const TEST_DIR = path.join(TEST_ROOT, "tests/test-area/my-test-name");
```

This ensures:

- Tests can run in parallel without interference
- File conflicts are avoided (e.g., "Target path already exists")
- Each test has a clean workspace

### Cleanup Integration Pattern

All e2e tests use a consistent cleanup pattern:

```typescript
import { executeTestCleanup } from "../utils/cleanup-integration.js";

// Run test setup and execution first
await runMyTest();

// Cleanup always runs in afterAll
afterAll(async () => {
  // First shutdown server
  await shutdownServer();

  // Then run full cleanup
  const cleanupResult = await executeTestCleanup({
    testDir: TEST_DIR,
    phasesConfig: PHASES_CONFIG,
    skipConfirmation: true,
    force: true, // Force cleanup even if git operations fail
  });

  // Verify cleanup succeeded
  logCleanupResults(cleanupResult, true);
});
```

Key points:

- **Always use `afterAll()`**: Ensures cleanup runs even if tests fail
- **Use `force: true`** for e2e tests: Falls back to manual cleanup if needed
- **Separate server shutdown from file cleanup**: Prevents timing issues

### Checkpoint Data Capture Pattern

For tests that need to verify git state:

```typescript
// Capture checkpoint data BEFORE cleanup runs
async function validateCheckpointSystem(): Promise<void> {
  const checkpointDir = path.join(TEST_DIR, ".langton/checkpoints");
  const gitDir = path.join(checkpointDir, ".git");

  // Store validation results in test state
  testState.checkpointValidation = {
    checkpointDirExists: fs.existsSync(checkpointDir),
    gitDirExists: fs.existsSync(gitDir),
    commitMessages: [], // Populate with git log
    branches: [], // Populate with git branch
    trackedFiles: [], // Populate with git ls-files
  };
}

// Call this BEFORE cleanup
await validateCheckpointSystem();

// Tests can then use the captured data
test("checkpoint tests", () => {
  expect(testState.checkpointValidation.branches).toContain("* main");
});
```

## Writing New Tests

1. Create new test file with `.test.ts` extension
2. Import test utilities and cleanup integration
3. Use unique port number (avoid 7778-7780)
4. Use isolated test directory
5. Follow the established patterns:

   ```typescript
   import { executeTestCleanup } from "../utils/cleanup-integration.js";

   // Use isolated directory
   const TEST_DIR = path.join(TEST_ROOT, "tests/test-area/my-new-test");

   // Setup and run test
   async function runMyTest(): Promise<void> {
     await setupTestDirectory();
     const server = startServer();
     const client = new TestWSClient();

     await client.connect();
     // ... test logic

     // Store events for assertions
     testState.events = client.getEvents();
   }

   // Run test before assertions
   await runMyTest();

   // Assertions
   describe("Test Suite", () => {
     test("assertion", () => {
       expect(result).toBe(expected);
     });
   });

   // Cleanup in afterAll
   afterAll(async () => {
     await executeTestCleanup({
       testDir: TEST_DIR,
       phasesConfig: PHASES_CONFIG,
       force: true,
     });
   });
   ```

## Philosophy

The test suite follows these principles:

1. **Real-world testing**: Uses actual Claude CLI, not mocks
2. **Isolation**: Each test runs independently
3. **Observability**: All actions logged and preserved
4. **Determinism**: Tests produce consistent results
5. **Comprehensiveness**: Cover success and failure paths
