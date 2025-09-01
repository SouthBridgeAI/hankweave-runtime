# The `.tadpole` Folder: State, Logs, and Checkpoints

## Overview

The `.tadpole` folder, created within the execution directory (not your project directory), is the operational heart of the Tadpole Runner. It serves as the persistent storage layer, meticulously recording every aspect of the server's execution. This folder is critical for the system's core features, including state persistence, crash recovery, historical auditing, and the powerful rollback capability. Understanding its structure is key to debugging workflows and leveraging the full power of the server.

With execution isolation, the `.tadpole` folder lives in the execution directory (e.g., `~/.tadpole-executions/1234-abc/.tadpole/`), keeping all Tadpole artifacts separate from your original project data.

**Note**: While the `.tadpole` folder stays in the isolated execution directory, Tadpole can copy output files to a `tadpole-results/` directory in your original project directory when phases have `output` configuration. This provides easy access to phase results without navigating to temporary execution directories.

## Directory Structure

The folder is organized to separate concerns, making it easy to locate state information, logs, and versioning data.

```
.tadpole/
├── execution-meta.json # Metadata about this execution environment
├── state.json          # The central, authoritative state file for all runs.
├── state.json.bak      # An automatic backup of the state file for recovery.
├── server.lock         # A lock file present only when the server is running.
├── events.jsonl        # A detailed, append-only log of all state transitions.
├── runs/               # A directory containing data for each individual server run.
│   └── 1234567-abc/    # A folder for a specific run, named with a unique ID.
│       └── ...         # Contains Claude's raw log files for each phase.
└── checkpoints/        # The shadow git repository for file versioning.
    ├── .git/           # The raw git object database.
    └── .gitconfig      # An isolated git configuration for the server.
```

## File Specifications

### `execution-meta.json`

This file contains metadata about the execution environment and its relationship to the original data source. It's created when the execution directory is first set up and updated on each server run.

- **Role**: Links the execution directory to its data source and tracks execution metadata.
- **Format**: A JSON object with execution environment information.
- **Key Data**: Data source path, data hash, link type, creation time, and last usage time.

```json
{
  "version": "1.0.0",
  "readOnlySourceDataPath": "/path/to/original/project",
  "readOnlySourceResolvedDataPath": "/absolute/path/to/project",
  "dataHash": "a1b2c3d4e5f6",
  "linkType": "symlink",
  "createdAt": "2025-01-19T10:00:00Z",
  "lastUsed": "2025-01-19T15:00:00Z"
}
```

**Key Fields:**
- `dataHash`: A deterministic hash of the data directory structure, used to identify which executions belong to which data source
- `linkType`: Either "symlink" (default) or "copy", indicating how the data is accessed
- `readOnlySourceDataPath`: The original path to the data as provided by the user
- `readOnlySourceResolvedDataPath`: The absolute, resolved path to the data source

### `state.json`

This is the most important file in the `.tadpole` directory. It acts as the single source of truth for the entire execution history of the project, containing a structured record of all runs and the phases within them.

- **Role**: Central database for all execution history.
- **Format**: A single JSON object representing the `TadpoleState`.
- **Key Data**: Contains an array of `Run` objects, with the most recent run first. It also tracks the `currentRunId` when the server is active.

```typescript
interface TadpoleState {
  // An array of all runs, with the newest at the beginning. This is append-only.
  runs: Run[];

  // The ID of the currently active run. Null if the server is not running.
  currentRunId: RunId | null;

  // The SHA of the very first commit in the checkpoint repo, representing a clean state.
  initialCheckpoint?: string;
}
```

### `state.json.bak`

To protect against data corruption (e.g., from an unexpected power outage during a write), the server maintains a backup of the state file. Before writing a new version of `state.json`, the server first copies the existing version to `state.json.bak`. This ensures that even if the write operation is interrupted, a valid previous state is always available for recovery.

### `server.lock`

This file serves two purposes: it prevents multiple server instances from running against the same project, and it enables crash detection.

- **Lifecycle**: Created on server startup and removed on graceful shutdown.
- **Content**: A JSON object containing the server's process ID (PID), the current `runId`, and a `lastHeartbeat` timestamp that is updated every 30 seconds.
- **Crash Detection**: If a new server instance starts and finds a `server.lock` file with a heartbeat older than two minutes, it assumes the previous server crashed, cleans up the lock, and marks the corresponding run as `crashed` in the state file.

```typescript
interface LockFile {
  pid: number;
  runId: string;
  startTime: string;     // ISO timestamp
  lastHeartbeat: string; // ISO timestamp
}
```

**Handling Stale Locks:**
- If the process is killed with `kill -9`, the lock file remains
- On next startup, the server checks if the PID in the lock file is still running
- If the process doesn't exist or the heartbeat is stale (>2 minutes old), the lock is cleared
- The associated run is marked as `crashed` in the state
- You can manually delete the lock file if needed, but the server will detect this on next startup

### `events.jsonl`

For deep debugging and auditing, this file provides a granular, append-only log of every single state transition that occurs. Each line is a JSON object representing a specific event and a snapshot of key state metrics after the event was processed.

- **Format**: JSON Lines (JSONL), where each line is a self-contained JSON object.
- **Use Case**: Allows developers to trace the exact sequence of events that led to a particular state, which is invaluable for diagnosing complex bugs or race conditions.

**Event Structure:**
```json
{
  "timestamp": "2025-01-19T10:00:00.123Z",
  "type": "PhaseTransitioned",
  "data": {
    "runId": "1234-abc",
    "phaseId": "phase-1",
    "from": "starting",
    "to": "running"
  },
  "metrics": {
    "totalRuns": 5,
    "currentRunPhases": 2,
    "totalCost": 1.23
  }
}
```

**Notes:**
- This file can grow large over time but is never truncated automatically
- Each event includes the state metrics *after* the transition was applied
- Safe to delete when the server is not running if you don't need the history

### `runs/` Directory

This directory contains a sub-directory for every individual run, allowing for a clean separation of artifacts.

#### Run Folder (`<timestamp>-<randomId>/`)

Each folder is uniquely named using a combination of a timestamp and a random string (e.g., `1737288000000-abc12`). This folder houses the raw output from the Claude CLI for each phase executed within that run.

#### Claude Log Files (`<phaseId>-claude.log`)

These are the raw JSONL output files generated by the Claude CLI during a phase's execution. They contain the full, unfiltered stream of system messages, assistant responses, tool usage, and final results. They are the source from which the Tadpole server parses `assistant.action` and `token.usage` events.

**Log Entry Types:**
```json
// System initialization
{"type":"system","message":"Claude session initialized","sessionId":"uuid-123"}

// Assistant message with token usage
{"type":"assistant","message":"I'll help you...", "usage":{"input":100,"output":50}}

// Tool usage
{"type":"tool_use","tool":"read_file","input":{"path":"src/index.ts"}}

// Final result
{"type":"result","success":true,"cost":0.0123,"tokens":{"input":1000,"output":500}}
```

**Important Notes:**
- Logs are written in real-time as Claude responds
- The server tails these files to provide live updates
- Binary data in tool responses is base64 encoded
- Malformed lines are preserved but may cause parsing warnings

### `checkpoints/` Directory

This directory contains a "shadow" git repository. It is a complete, independent git repository that the server uses to checkpoint the state of tracked files in the project.

- **Isolation**: It is completely separate from your project's own git repository. It has its own `.git` directory and a `.gitconfig` to ensure it doesn't interfere with your user-level or project-level git settings.
- **Working Tree**: Its working tree is configured to be the root of your project, allowing it to commit files from your project directory without needing to copy them.
- **Branching Strategy**: A new branch is created for each run, named `run-<runId>`. This isolates the history of each run, making it easy to navigate and compare different execution paths.
- **Commit Messages**: Commits are made automatically at key lifecycle events with highly structured messages.

#### Commit Message Format
```
checkpoint(workspace-setup): phase-1-analysis

Phase: phase-1-analysis
Status: workspace-setup
Run: 1737288000000-abc12
Timestamp: 2025-01-19T10:00:00Z
Files: 5 tracked
```

#### Manual Inspection
You can inspect the shadow repository using standard git commands:
```bash
cd .tadpole/checkpoints
git log --oneline                    # View commit history
git branch -a                        # List all run branches
git diff <sha1> <sha2>              # Compare checkpoints
git checkout run-1234-abc           # Switch to a run's branch
```

**Important Notes:**
- Do NOT push this repository to a remote - it may contain sensitive data
- The repository starts with an empty initial commit for a clean baseline
- If git is not available, checkpointing is disabled but the server still runs
- Large binary files in tracked paths may impact performance

## Data Types & Storage Patterns

### Append-Only Design

The system is designed around an append-only philosophy for historical data. Runs are added to the `state.json` file, events are appended to `events.jsonl`, and checkpoints are new commits in the git history. Nothing is ever deleted or modified, ensuring a complete and auditable trail of every action taken.

### Storage Limits and Performance

**File Size Considerations:**
- `state.json`: Typically remains small (<1MB even with hundreds of runs)
- `events.jsonl`: Can grow to several MB over time
- Claude logs: Each phase generates 10KB-10MB depending on conversation length
- Checkpoint repository: Size depends on tracked files

**Performance Notes:**
- State loading is fast even with large histories due to efficient JSON parsing
- The first checkpoint in a run may be slow if tracking many files
- File watching has minimal overhead using OS-level APIs
- Cost calculations are cached to avoid repeated computation

### Atomic Writes

To ensure the integrity of `state.json`, the server uses an atomic write pattern:
1.  A new state is written to a temporary file (`state.json.tmp`).
2.  The existing `state.json` is copied to `state.json.bak`.
3.  The temporary file is atomically renamed to `state.json`.

This process ensures that there is always at least one valid state file on disk.

### Recovery Mechanisms

The system is resilient to crashes. On startup, it performs several checks:
- **Crash Detection**: Uses the `server.lock` file to identify and mark crashed runs.
- **State Corruption Recovery**: If `state.json` is unreadable, it automatically falls back to `state.json.bak`.
- **Orphaned Resources**: The validation system can identify inconsistencies, such as run folders that don't have a corresponding entry in the state file, and reports them as warnings.

#### Recovery Procedures

**After a crash:**
1. The server detects the stale lock file
2. Marks the previous run as `crashed`
3. Any running phases are marked as `failed`
4. Creates a new run to continue work

**If state.json is corrupted:**
1. Attempts to load `state.json.bak`
2. If backup works, replaces corrupted file
3. If both fail, starts fresh (data loss)
4. Logs detailed error for debugging

**Manual Recovery:**
- Delete `.tadpole` directory for a complete fresh start
- Use `--cleanup` command for guided cleanup
- Restore from your own backups if available
