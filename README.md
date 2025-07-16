# Langton Runner

A production-grade orchestration system for managing multi-phase Claude CLI workflows with comprehensive state management, crash recovery, and real-time event streaming.

## 🌟 Why Langton?

Langton transforms Claude CLI from a single-session tool into a powerful workflow engine:

- **🔄 Stateful Execution**: Every phase tracks 8 granular states from `preparing` to `completed`
- **💾 Crash Recovery**: Server crashes? No problem. Full state reconstruction on restart
- **📊 Multi-Level Cost Tracking**: Per-phase, per-run, and all-time cost analytics
- **🌳 Run History**: Every execution preserved with ability to continue from any point
- **⚡ Fire-and-Forget**: Async state transitions that never block your workflow
- **🔍 Type-Safe Everything**: Branded types, discriminated unions, compile-time validation

## Overview

Langton Runner provides a WebSocket server that orchestrates Claude CLI sessions through configurable phases, with enterprise-grade features:

- **State Management**: Centralized state with atomic persistence and recovery
- **Phase Lifecycle**: 8-state progression tracking (`preparing` → `starting` → `initializing` → `running` → `completing` → `completed`/`failed`/`skipped`)
- **Run Isolation**: Each run gets its own folder and git branch
- **Real-time Events**: WebSocket streaming of all state changes
- **Checkpoint System**: Git-based snapshots with per-run branches
- **Cost Analytics**: Automatic tracking with caching for performance
- **Workspace Setup**: Copy files and run commands before phases
- **File Watching**: Monitor and stream file changes during execution

## Quick Start

```bash
# Install dependencies
bun install

# Start the server
bun run server

# Run with terminal UI for testing
bun run server:basic

# Clean up project
bun run server -- --cleanup --config=phases.json
```

## The State System

Langton's state management is its superpower. Here's what makes it special:

### 📁 Run Organization

Each server run creates:

```
.langton/
├── state.json              # Single source of truth
├── state.json.bak         # Automatic backup
├── events.jsonl           # Event log for debugging
└── runs/
    └── 1234567890-abc/    # Unique run folder
        ├── phase-research-claude.log
        └── phase-implement-claude.log
```

### 🔄 Phase State Machine

Phases progress through 8 distinct states:

```typescript
// Normal flow
preparing → starting → initializing → running → completing → completed

// Can skip to terminal states from any point
any_state → failed
any_state → skipped (except completing)
```

Each state transition is validated and persisted atomically:

```typescript
// Fire-and-forget transitions
stateManager.transition({
  type: "PhaseTransitioned",
  data: {
    runId,
    phaseId,
    from: "initializing",
    to: "running",
    metadata: { claudeSessionId: "session-123" },
  },
});
```

### 💰 Cost Tracking

Three levels of cost tracking with automatic caching:

```typescript
// Get costs instantly (cached for performance)
const currentRunCost = stateManager.getCurrentRunCost();
const totalCost = stateManager.getTotalCost();
const costSinceRun = stateManager.getCostSince(runId);
```

### 🔍 Type-Safe Queries

Query your state with full type safety:

```typescript
// Find last successful execution of a phase
const result = stateManager.getLastSuccessfulPhase("research");
if (result) {
  console.log(`Session: ${result.phase.claudeSessionId}`);
  console.log(`Cost: $${result.phase.finalCost}`);
}

// Get phase history across all runs
const history = stateManager.getPhaseHistory("implement");
history.forEach(({ run, phase }) => {
  console.log(`Run ${run.runId}: ${phase.status}`);
});
```

## Phase Configuration

Create a `phases.json` file:

```json
[
  {
    "id": "research",
    "name": "Research Phase",
    "promptFile": "./prompts/research.md",
    "model": "sonnet",
    "continuationMode": "fresh",
    "workspaceSetup": [
      {
        "type": "copy",
        "copy": {
          "from": "../templates/research",
          "to": "research"
        }
      }
    ],
    "trackedFiles": ["research/**/*.md"]
  },
  {
    "id": "implement",
    "name": "Implementation",
    "promptFile": ["./prompts/context.md", "./prompts/task.md"],
    "model": "opus",
    "continuationMode": "continue-previous",
    "workspaceSetup": [
      {
        "type": "command",
        "command": {
          "run": "npm install",
          "workingDirectory": "project"
        }
      }
    ],
    "trackedFiles": ["src/**/*.ts", "*.json"]
  }
]
```

## WebSocket Protocol

### Server → Client Events

All events include full state context:

```typescript
// Phase started (emitted when Claude sends session ID)
{
  type: "phase.started",
  data: {
    phaseId: "research",
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    previousSessionId: "previous-session-id", // if continuing
    startTime: "2024-01-01T00:00:00Z"
  }
}

// State snapshot
{
  type: "state.snapshot",
  data: {
    currentPhase: {
      status: "running",
      phase: { /* config */ },
      sessionId: "...",
      phaseCost: 0.0234,
      phaseTokens: { /* usage */ }
    },
    completedPhases: [...],
    totalCost: 0.1523,
    totalTime: 120000
  }
}
```

### Client → Server Commands

```typescript
// Start specific phase
{ type: "phase.start", data: { phaseId: "research" } }

// Continue workflow
{ type: "phase.next" }

// Skip current phase
{ type: "phase.skip" }

// Graceful shutdown
{ type: "server.shutdown" }
```

## Advanced Features

### 🔄 Crash Recovery

Lock files now include heartbeats:

```json
{
  "pid": 12345,
  "runId": "1234567890-abc",
  "startTime": "2024-01-01T00:00:00Z",
  "lastHeartbeat": "2024-01-01T00:30:00Z"
}
```

On startup:

1. Detects stale lock files (>2 minutes old)
2. Marks crashed runs in state
3. Can optionally continue the same run

### 🌳 Continuation from Any Point

Continue from any successful phase in history:

```typescript
// In future versions
stateManager.transition({
  type: "RunStarted",
  data: {
    startingConditions: {
      type: "continuation",
      source: {
        runId: "previous-run",
        afterPhase: "research",
        checkpointSha: "abc123",
      },
    },
  },
});
```

### 📸 Per-Run Git Branches

Each run gets its own git branch for checkpoints:

```bash
.langton/checkpoints/
├── .git/
└── (working tree points to your project)

# Branches:
# - main (initial state)
# - run-1234567890-abc (current run)
# - run-0987654321-xyz (previous run)
```

### 🧹 Comprehensive Cleanup

Remove all Langton artifacts intelligently:

```bash
# Preview what will be cleaned
bun run server -- --cleanup --config=phases.json

# Force cleanup without prompts
bun run server -- --cleanup --config=phases.json -y
```

Cleanup understands:

- Copied vs command-created directories
- Git-tracked vs untracked files
- Run-specific artifacts

## Architecture

### State Management Flow

```
Commands → StateManager → Transitions → Persistence
              ↓              ↓             ↓
         Validation      Pure Apply    Atomic Write
              ↓              ↓             ↓
           Events      State Update   state.json
```

### Key Components

1. **StateManager**: Central brain with fire-and-forget transitions
2. **State Types**: 50+ TypeScript types ensuring impossible states are impossible
3. **Transition Guards**: Compile-time validation of state changes
4. **Event System**: Async processing queue for state updates
5. **Cost Cache**: Lightning-fast cost queries
6. **Recovery System**: Multiple fallback strategies

### Phase Execution States

```typescript
type PhaseStatus =
  | "preparing" // Workspace setup running
  | "starting" // Spawning Claude process
  | "initializing" // Waiting for session ID
  | "running" // Claude is working
  | "completing" // Waiting for result message
  | "completed" // Success - terminal state
  | "failed" // Failed - terminal state
  | "skipped"; // User skipped - terminal state
```

## Testing

Comprehensive test coverage including state management:

```bash
# All tests
bun run test

# Specific suites
bun run test:unit          # Unit tests
bun run test:e2e           # End-to-end tests

# Individual e2e tests
bun test tests/e2e/happy-path-e2e.test.ts
bun test tests/e2e/crash-recovery-e2e.test.ts
```

The test suite validates:

- State transitions and persistence
- Crash recovery scenarios
- Cost calculation accuracy
- File operation safety
- Cleanup completeness
- Type safety throughout

## Requirements

- **Bun**: v1.0+ (runtime and package manager)
- **Claude CLI**: Installed and configured
- **TypeScript**: 5.0+ (development)
- **Git**: For checkpoint system
- **Unix-like OS**: For process management

## Philosophy

Langton is built on these principles:

1. **Production-Grade**: Handle crashes, preserve state, never lose work
2. **Type Safety**: If it compiles, it works
3. **Observability**: Every state change is logged and streamed
4. **Performance**: Cached queries, async transitions
5. **Extensibility**: Clean interfaces for new features
