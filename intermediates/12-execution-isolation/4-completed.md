# Execution Isolation Feature - Implementation Complete

## Overview

The execution isolation feature fundamentally changes how Langton Runner operates by separating the execution environment from the user's data source. Instead of running directly in the project directory, Langton now creates and manages isolated execution directories, with the user's data accessible through a symlink or copy at `<execution-dir>/data/`.

This architectural change provides several key benefits:
- **Clean Rollbacks**: Rollbacks only affect the execution environment, never the original data
- **Multiple Executions**: Track and manage multiple execution attempts for the same data
- **Data Integrity**: Original project files are never modified directly
- **Execution History**: Each execution is preserved with its own state and checkpoints

## Architecture

### Directory Structure

```
User's Project (Read-Only Data Source)
├── src/
├── docs/
├── package.json
└── phases.json

~/.langton-executions/ (Execution Root)
├── 1737123456789-abc-d4f5e6/ (Execution Directory)
│   ├── data/ → /path/to/user/project (symlink)
│   └── .langton/
│       ├── execution-meta.json
│       ├── state.json
│       ├── runs/
│       └── checkpoints/
└── 1737234567890-def-d4f5e6/ (Another Execution)
    ├── data/ → /path/to/user/project (symlink)
    └── .langton/
```

### Key Components

#### 1. Data Hashing (`server/data-hasher.ts`)
- Generates a deterministic hash of the data directory structure
- Uses file names, types, sizes, and modification times
- Implements time and depth limits to handle large projects efficiently
- Skips common directories like `node_modules`, `.git`, etc.
- Hash is used to identify which executions belong to which data source

#### 2. Execution Setup (`server/execution-setup.ts`)
- Manages the creation and detection of execution directories
- Handles both automatic execution directory creation and explicit paths
- Supports symlink (default) or copy modes for data access
- Stores execution metadata including creation time, data hash, and link type
- Implements safeguards against nested executions and data corruption

#### 3. Updated Server Configuration
- `projectPath` replaced with `executionPath` throughout the codebase
- New configuration properties:
  - `readOnlySourceDataPath`: Original data location
  - `executionPath`: Where the server operates
  - `dataPathInExecutionDir`: Always `executionPath + '/data'`
  - `dataHash`: Hash of the data directory
  - `linkType`: Whether data is symlinked or copied

## Command-Line Interface

### New/Updated Flags

```bash
--data=<path>         # Path to data/project directory (default: current directory)
--execution=<path>    # Resume in specific execution directory
--start-new           # Force creation of a new execution directory
--copy                # Copy data instead of symlinking (for compatibility)
```

### Usage Examples

```bash
# Run with default data (current directory)
bun server/index.ts

# Run with specific data directory
bun server/index.ts --data=/path/to/project

# Resume specific execution
bun server/index.ts --execution=/home/.langton-executions/1234-abc

# Start fresh execution (ignore existing)
bun server/index.ts --data=/path/to/project --start-new

# Copy data instead of symlinking
bun server/index.ts --data=/path/to/project --copy
```

## Template Variable Changes

The feature introduces new template variables while maintaining backward compatibility:

- `<%PROJECT_DIR%>` - **Deprecated** but still works, maps to execution directory
- `<%EXECUTION_DIR%>` - The execution directory path (recommended)
- `<%DATA_DIR%>` - The data directory path (`execution-dir/data`)

Example usage in prompts:
```markdown
Please analyze the code in <%DATA_DIR%>/src and create documentation in <%EXECUTION_DIR%>/docs
```

## Execution Flow

1. **Data Hashing**: When starting, Langton calculates a hash of the data directory
2. **Execution Discovery**: Checks for existing executions with the same data hash
3. **Directory Setup**:
   - If resuming: Uses the most recent execution directory
   - If new: Creates a new timestamped execution directory
   - If explicit path: Uses the provided execution directory
4. **Data Linking**: Creates a symlink (or copy) at `<execution-dir>/data/`
5. **Server Operation**: All Langton operations occur within the execution directory
6. **Metadata Tracking**: Stores execution metadata for future reference

## File System Operations

### Workspace Setup
- Copy operations now target the execution directory, not the data source
- Commands run in the execution directory context
- The `lastCopied` working directory option works within the execution space

### File Tracking and Checkpoints
- File tracking patterns are evaluated relative to the execution directory
- The shadow git repository lives in `<execution-dir>/.langton/checkpoints/`
- The `/data/` directory is explicitly excluded from checkpoints to avoid duplication

### Claude Process Execution
- Claude runs with the execution directory as its working directory
- All file operations through Claude's tools affect only the execution directory
- The data directory remains read-only (when symlinked)

## Cleanup Changes

The cleanup command has been updated to work with execution directories:

```bash
# Clean up the latest execution for a data directory
bun server/index.ts --cleanup --data=/path/to/project

# Clean up a specific execution directory
bun server/index.ts --cleanup --execution=/path/to/execution
```

**Important**: Cleanup now only removes the latest execution directory by default, preserving older executions for historical reference.

## Migration and Compatibility

### For Existing Users
- The default behavior (running in current directory) still works
- Existing `.langton` directories are treated as execution directories
- The `--data` flag is optional and defaults to the current directory

### Breaking Changes
- None for typical usage
- Custom scripts using `projectPath` need to update to `executionPath`
- WebSocket protocol now returns `executionPath` and `dataPath` instead of `projectPath`

## Benefits and Use Cases

### 1. Safe Experimentation
Users can try different approaches without fear of corrupting their project:
```bash
# Try approach A
bun server/index.ts --data=myproject --start-new

# Try approach B
bun server/index.ts --data=myproject --start-new
```

### 2. Parallel Executions
Multiple Langton instances can work on the same data simultaneously in different execution directories.

### 3. Clean Workspace
All Langton artifacts (logs, checkpoints, generated files) are isolated from the user's project.

### 4. Simplified Cleanup
Removing an execution is as simple as deleting its directory, with no impact on the original project.

### 5. Execution History
Users can review past execution attempts, compare different approaches, and learn from previous runs.

## Implementation Details

### Security Considerations
- Prevents execution within data directories
- Blocks nested execution directories
- Validates data source exists and is accessible
- Ensures execution directories don't conflict

### Performance Optimizations
- Data hashing uses time limits (default 5 seconds) to handle large directories
- Depth-limited directory traversal (max 3 levels by default)
- Efficient file filtering to skip common large directories
- Symlinks avoid data duplication

### Error Handling
- Graceful fallback from symlink to copy if symlinks aren't supported
- Clear error messages for common issues (missing data, permission problems)
- Validation of execution directory state before resuming

## Future Enhancements

This architecture enables several potential future features:
- Execution comparison tools
- Parallel execution management
- Cloud execution with local data mounting
- Execution templates and sharing
- Advanced cleanup policies (age-based, size-based)
