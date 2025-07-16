# Langton Tests: A Deep Dive into the Testing Architecture

The Langton test suite is not your typical unit test collection. It's a sophisticated end-to-end testing framework that validates the entire Langton orchestration system through real-world scenarios, complete with crash recovery, cost tracking, and state consistency verification.

## 🎯 Overview: What Makes These Tests Special

Unlike traditional test suites, Langton's tests are **standalone executable scripts** that spin up actual servers, run real Claude CLI processes, and validate the complete system behavior. Each test run creates:

- **Real server processes** with actual WebSocket connections
- **Authentic Claude CLI sessions** with real API calls
- **Complete state persistence** including crash recovery
- **Git-based checkpointing** with per-run branches
- **Multi-level cost tracking** validation
- **File system operations** with workspace setup

## 📁 Directory Structure

```
tests/
├── config/                    # Test configuration files
│   ├── test-phases.config.json    # 3-phase test workflow
│   ├── phase1Prompt1.md           # Multi-file prompt testing
│   ├── systemPrompt1.md            # System prompt additions
│   └── typescript_structure/       # Template for phase 3
├── e2e/                       # End-to-end integration tests
│   ├── happy-path-e2e.test.ts      # Complete 3-phase workflow
│   ├── crash-recovery-e2e.test.ts  # Server crash scenarios
│   ├── server-shutdown-e2e.test.ts   # Graceful shutdown
│   ├── skip-phase-continue-e2e.test.ts # Phase skipping
│   └── test-groups/               # Modular test suites
│       ├── checkpoint-system-tests.ts
│       ├── cost-tracking-tests.ts
│       ├── state-consistency-tests.ts
│       └── 25+ specialized test groups
├── unit/                      # Unit tests for core components
│   ├── state-manager.test.ts       # State management validation
│   ├── claude-log-parser.test.ts   # Log parsing accuracy
│   ├── checkpoint-git.test.ts      # Git checkpointing
│   └── cleanup-*.test.ts           # Cleanup system tests
├── utils/                     # Test utilities and helpers
│   ├── test-helpers.ts            # Core test infrastructure
│   ├── state-assertions.ts        # State validation helpers
│   ├── cleanup-integration.ts   # Cleanup verification
│   └── test-data-helpers.ts        # Test data generation
├── test-claude-logs/          # Real Claude CLI output samples
│   ├── ehr-success/               # Successful execution logs
│   ├── ehr-timeout/                # Timeout scenario logs
│   └── ehr-timeout-not-recognized/ # Edge case handling
├── test-area/                 # Runtime test directories (gitignored)
├── test-results/              # Test artifacts and logs (gitignored)
├── index.ts                   # Test suite entry point
└── info.test.ts             # Informational test runner
```

## 🚀 Running the Tests

### Quick Start

```bash
# Full E2E test suite (expensive - requires Claude API calls)
bun run test

# Individual test scenarios
bun test tests/e2e/happy-path-e2e.test.ts
bun test tests/e2e/crash-recovery-e2e.test.ts

# Unit tests only (fast)
bun run test:unit

# Environment checks
bun run test:check      # Check if ready to test
bun run test:sanity     # Detailed environment verification
```

### Test Configuration

Tests use `tests/config/test-phases.config.json` which defines a 3-phase workflow:

1. **Phase 1**: Write three "pick one" poems
2. **Phase 2**: Save second favorite as file
3. **Phase 3**: Convert poems to TypeScript code

## 🔍 Test Architecture Deep Dive

### The Happy Path Test: A Complete Journey

The `happy-path-e2e.test.ts` is the crown jewel - it validates the entire system through a realistic 3-phase workflow:

```typescript
// Test flow orchestration
1. Setup isolated test directory
2. Start Langton server with test configuration
3. Connect WebSocket client
4. Execute all 3 phases automatically
5. Validate state consistency across all layers
6. Verify checkpoint system integrity
7. Clean up with verification
```

### State Consistency Validation

The test suite implements sophisticated state validation:

```typescript
// Cross-reference validation between:
- WebSocket events
- State.json persistence
- Claude log files
- Git checkpoint commits
- Cost calculations
```

### Cost Tracking Precision

Tests validate cost accuracy across multiple sources:

- **WebSocket events**: Real-time cost updates
- **State.json**: Persistent cost tracking
- **Claude logs**: Actual API usage from result messages
- **Cross-validation**: All sources must match within precision tolerance

### Crash Recovery Testing

Specialized tests validate the crash recovery system:

- **Process death detection**: Identifies crashed runs on startup
- **State reconstruction**: Recovers from backup state files
- **Phase failure handling**: Marks running phases as failed
- **Continuation support**: Can resume from checkpoint

## 🧪 Test Categories

### 1. End-to-End Integration Tests

- **Happy Path**: Complete 3-phase workflow
- **Crash Recovery**: Server failure scenarios
- **Phase Skipping**: User-initiated phase skipping
- **Server Shutdown**: Graceful and forceful termination

### 2. State Management Tests

- **State transitions**: Valid and invalid state changes
- **Persistence**: Atomic writes with backup files
- **Recovery**: Corrupted state file handling
- **Queries**: Cost calculation and phase history

### 3. File System Tests

- **Workspace setup**: Copy and command operations
- **File watching**: Real-time file change detection
- **Path consistency**: Cross-platform path handling
- **Cleanup verification**: Complete artifact removal

### 4. Cost Tracking Tests

- **Precision**: Dollar-level accuracy validation
- **Multi-source verification**: Events vs logs vs state
- **Cumulative tracking**: Run and phase-level costs
- **Token usage**: Input/output/cache breakdown

### 5. Checkpoint System Tests

- **Git integration**: Per-run branch creation
- **Commit integrity**: Milestone-based snapshots
- **File tracking**: Selective file inclusion
- **Rollback capability**: Restore from any checkpoint

### 6. WebSocket Protocol Tests

- **Event ordering**: Sequential event delivery
- **State snapshots**: Complete state transmission
- **Error handling**: Graceful error propagation
- **Connection management**: Client lifecycle

## 🔧 Test Utilities and Patterns

### TestWSClient: WebSocket Testing Framework

```typescript
const client = new TestWSClient();
await client.connect(7777);

// Wait for specific events
const phaseStart = await client.waitForPhaseStart("research");
const completion = await client.waitForPhaseCompletion("research");

// Validate event sequences
const events = client.getEvents();
expect(events.filter((e) => e.type === "phase.completed")).toHaveLength(3);
```

### State Inspection Helpers

```typescript
// Read state directly from file system
const state = await getServerState(testDir);
const completedPhases = await getCompletedPhasesFromState(testDir);
const totalCost = await getTotalCostFromState(testDir);
```

### Cleanup Integration

```typescript
// Automated cleanup with verification
const result = await executeTestCleanup({
  testDir: "/path/to/test",
  phasesConfig: "/path/to/config.json",
  skipConfirmation: true,
  force: true,
});
```

## 🎭 Test Scenarios and Edge Cases

### The "Untracked File" Problem

Tests discovered that files created by commands (vs workspace setup) aren't tracked for cleanup. The test suite now validates this behavior:

```typescript
// notes/ directory persists (created by command)
// typescript_code/ is removed (created by workspace setup)
// .langton/ is completely removed
```

### Process Group Management

The test suite implements sophisticated process cleanup:

- **Signal handling**: SIGINT/SIGTERM cleanup
- **Process groups**: Kills entire process trees
- **Graceful shutdown**: WebSocket shutdown commands
- **Force kill fallback**: SIGKILL after timeout

### State File Corruption

Tests validate recovery from corrupted state files:

- **Backup restoration**: Uses .bak file when main corrupted
- **Validation**: Detects and reports state inconsistencies
- **Atomic writes**: Prevents partial write corruption

## 📊 Performance and Scale

### Test Execution Times

- **Unit tests**: ~2-3 seconds
- **E2E happy path**: ~30-60 seconds (depends on Claude API)
- **Full E2E suite**: ~5-10 minutes
- **Cleanup verification**: ~1-2 seconds

### Resource Usage

- **Test directories**: ~50-100MB per test run
- **State files**: ~1-10KB per run
- **Log files**: ~1-5MB per phase
- **Git repository**: ~10-50MB with checkpoints

## 🚨 Important Testing Notes

### ⚠️ Cost Warning

**E2E tests make real Claude API calls and incur actual costs.** Each test run typically costs $0.10-$0.50 depending on the models used.

### 🔒 Environment Requirements

- **Claude CLI**: Must be installed and configured
- **Git**: Required for checkpoint system
- **Unix-like OS**: Process management features
- **Network**: Internet access for Claude API

### 🧪 Test Isolation

Each test creates isolated directories:

- `tests/test-area/happy-path/`
- `tests/test-area/crash-recovery/`
- `tests/test-results/timestamp-run/`

### 📈 Test Data Management

- **Configuration**: Uses `tests/config/test-phases.config.json`
- **Templates**: Copies from `tests/config/typescript_structure/`
- **Prompts**: Multi-file prompt testing with concatenation
- **System prompts**: Appends additional system instructions

## 🎯 Advanced Testing Patterns

### State Machine Validation

Tests validate the complete state machine:

```
preparing → starting → initializing → running → completing → completed
     ↓         ↓           ↓           ↓          ↓
   failed    failed      failed      failed     failed
```

### Cross-System Validation

Every test validates consistency across:

- **WebSocket events** (real-time)
- **State persistence** (atomic)
- **Git checkpoints** (historical)
- **Cost tracking** (financial)
- **File operations** (filesystem)

### Mock-Free Testing

The test suite deliberately avoids mocks to ensure:

- **Real API behavior** validation
- **Actual cost calculation** accuracy
- **True state persistence** testing
- **Authentic crash recovery** scenarios

This testing approach ensures that when Langton works in tests, it works in production - because the tests _are_ production scenarios.

## 🔬 Deep Dive: Test Mechanics and Irregularities

### The Git Checkpoint Commit Pattern

The checkpoint system creates a sophisticated commit pattern that reveals the true nature of phase execution:

```bash
# Typical commit sequence from a 3-phase test
git log --oneline
abc123 completed:phase-3 [run:2024-01-01-abc] Phase 3: Convert poems to code
def456 workspace-setup:phase-3 [run:2024-01-01-abc] Phase 3: Convert poems to code
ghi789 completed:phase-2 [run:2024-01-01-abc] Phase 2: Schema Generation
jkl012 completed:phase-1 [run:2024-01-01-abc] Phase 1: TestPhase1
mno345 Initial checkpoint setup
```

**Key insight**: Notice how `workspace-setup` commits only appear for phases that have actual workspace setup operations. Phase 1 and 2 don't have workspace setup commits because they either have no files to commit (Phase 1) or no workspace setup (Phase 2).

### The "Phantom Phase" Problem

Tests revealed a subtle issue where phases can appear to complete but actually fail silently:

```typescript
// In cost-tracking-tests.ts
// Phase might report completion but have zero cost
// This indicates Claude never actually processed the prompt
const phase = state.runs[0].phases.find((p) => p.phaseId === "phase-2");
if (phase.finalCost === 0) {
  // This is a red flag - Claude should always incur some cost
  throw new Error("Phantom phase detected");
}
```

### File Watching Edge Cases

The file watching system has several non-obvious behaviors:

**Special Character Handling**

```typescript
// tests/e2e/test-groups/file-system-edge-cases-tests.ts
// Files with spaces, dashes, dots are handled but normalized
"notes/poem with spaces.txt" → "notes/poem_with_spaces.txt"
"notes/poem-with-dashes.txt" → "notes/poem_with_dashes.txt"
```

**Symlink Safety**

```typescript
// Symlinks pointing outside the project are ignored
// This prevents security issues where tests could access system files
const symlinkPath = path.join(testDir, "notes/external-link");
// Any symlink events are filtered out
```

### The Cleanup Manifest Builder's Secret Logic

The cleanup system has sophisticated logic for determining what to remove:

```typescript
// From cleanup-command.test.ts
// The manifest builder creates a sophisticated decision tree:

// 1. Copied directories (from workspaceSetup.copy) → Always removed
// 2. Command-created directories → Sometimes preserved
// 3. Git-tracked files → Only removed if explicitly in patterns
// 4. .langton directory → Always removed (except during active runs)

// Edge case: notes/ directory persists because it's created by a command, not workspace setup
// This is intentional - user-created content should be preserved
```

### State Assertion Deep Magic

The state assertions reveal hidden validation patterns:

```typescript
// From state-assertions.ts
// These assertions catch subtle state inconsistencies:

// Phase completion validation checks for the existence of finalCost
// This catches cases where phases complete without Claude processing
assertPhaseCompleted(state, "phase-1");

// Cost validation ensures minimum thresholds
// This catches API key issues or model unavailability
assertPhaseCost(state, "phase-1", 0.001); // Minimum cost threshold
```

### The "Run ID Collision" Problem

Test runs use timestamp-based IDs that can theoretically collide:

```typescript
// In happy-path-e2e.test.ts
const TEST_TIMESTAMP = generateTestTimestamp();
// Format: 2024-01-01T12-00-00-123
// Collision probability: 1 in 1000 for millisecond precision
// Mitigation: Tests include random suffix if collision detected
```

### WebSocket Event Ordering Quirks

Events don't always arrive in the order you expect:

```typescript
// From state-consistency-tests.ts
// Events can arrive in this order:
// 1. phase.started (Phase 1)
// 2. state.snapshot (initial)
// 3. file.updated (Phase 1 creates files)
// 4. phase.completed (Phase 1)
// 5. phase.started (Phase 2) - might arrive before Phase 1 completion!

// The test suite validates this with sophisticated event ordering
```

### The "Git Branch Naming Collision" Issue

Run-specific branches can have naming collisions:

```typescript
// Branch format: run-2024-01-01-abc123
// Problem: Multiple tests running simultaneously
// Solution: Each test uses isolated test directories
// test-area/happy-path/
// test-area/crash-recovery/
// test-results/timestamp-1/
// test-results/timestamp-2/
```

### Cost Precision Validation Deep Dive

The cost validation has multiple layers:

```typescript
// 1. WebSocket event costs (real-time)
// 2. State.json costs (persistent)
// 3. Claude log costs (actual API usage)
// 4. Cross-validation with 6 decimal places precision

// Edge case: Cache hits can make costs appear lower than expected
// Mitigation: Tests account for cache scenarios
```

### The "Process Group Kill" Problem

Process cleanup has platform-specific behaviors:

```typescript
// Unix: Uses process groups (kill -PID)
// Windows: Falls back to individual process killing
// Edge case: Orphaned processes when parent dies unexpectedly
// Solution: Multiple fallback strategies in cleanupTest()
```

### State File Atomic Write Verification

State persistence has subtle failure modes:

```typescript
// Atomic write sequence:
// 1. Write to state.json.tmp
// 2. fsync() to ensure disk write
// 3. rename() to state.json (atomic operation)
// 4. fsync() directory to ensure rename persistence

// Test validation: Corrupt state.json → Should recover from .bak
// Missing .bak → Should create new state
// Partial write → Should be detected and handled
```

### The "Template Variable Expansion" Gotcha

Template variables in prompts have unexpected behaviors:

```typescript
// In test-phases.config.json
"promptText": "Save to <%PROJECT_DIR%>/notes/favorite.txt"
// Actual expansion: /absolute/path/to/test-area/happy-path/notes/favorite.txt
// Edge case: Path contains spaces → handled by shell escaping
```

### Cleanup Verification Deep State

The cleanup verification has hidden complexity:

```typescript
// What actually gets cleaned:
// ✅ .langton/ (entire directory)
// ✅ copied-dir/ (from workspaceSetup.copy)
// ✅ typescript_code/ (from workspaceSetup.copy)
// ❌ notes/ (created by command, preserved intentionally)
// ❌ untracked.txt (created by tests, preserved)

// This creates the "untracked file" problem where test artifacts persist
```

### The "Session ID Chain" Validation

Phase continuation has subtle session ID chaining:

```typescript
// Phase 1: fresh start → session-id-1
// Phase 2: continue-previous → session-id-2 (references session-id-1)
// Phase 3: fresh start → session-id-3 (no reference)

// Validation: previousSessionId must match exactly
// Edge case: Session ID format changes between Claude versions
```

### Test Isolation Boundary Conditions

Each test creates completely isolated environments:

```typescript
// Isolation boundaries:
// - Process isolation: Each test gets new PID
// - File system isolation: Unique test directories
// - Network isolation: Separate WebSocket ports
// - State isolation: Separate .langton directories
// - Git isolation: Separate git repositories

// However: Shared Claude CLI configuration
// Mitigation: Tests use --test-mode to avoid config conflicts
```

These mechanics represent the sophisticated edge case handling that makes Langton's test suite production-grade. The tests don't just validate happy paths - they probe the dark corners where real systems fail.
