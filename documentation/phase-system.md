# The Tadpole Phase System: Runs, Phases, and Execution Threads

## Overview

The Tadpole phase system provides a robust framework for structuring complex AI workflows. Instead of a single, monolithic prompt, tasks are broken down into a sequence of discrete, manageable units called "phases". This modular approach enables greater control, better state management, and powerful features like context preservation and rollback. The system is built on three core concepts: Phases, Runs, and Execution Threads.

## Core Concepts

### Phase

A **Phase** is the fundamental unit of work in the Tadpole system. It represents a single, focused task for Claude to perform, defined by a configuration object in your `phases.json` file. Each phase encapsulates everything needed for its execution:

- **Identity**: A unique `id` for programmatic reference and a human-readable `name` for display.
- **Prompt**: The instructions for Claude, which can be provided as inline text (`promptText`) or loaded from one or more files (`promptFile`).
- **Model**: The specific Claude model to use:
    - `sonnet`: Claude 4 Sonnet - Faster and more cost-effective, ideal for most tasks
    - `opus`: Claude 4.1 Opus - More capable but slower and more expensive, use for complex reasoning
- **Continuation Mode**: Determines how the phase handles conversational context. It can either start a `fresh` session or `continue-previous` to maintain the dialogue from the preceding phase.
- **Workspace Setup**: An optional set of operations (copying files, running commands) that prepare the project environment before the phase begins.
- **File Tracking**: A list of glob patterns specifying which files the server should monitor for changes and include in version-control checkpoints during this phase.
- **Environment Variables**: Optional phase-specific environment variables that override system variables.

#### Complete Phase Configuration Schema

```json
{
  "id": "phase-1",                    // Required: Unique identifier
  "name": "Initial Analysis",         // Required: Human-readable name

  // Prompt (one of these required)
  "promptFile": "prompts/analyze.md", // Single file
  "promptFile": ["prompt1.md", "prompt2.md"], // Multiple files
  "promptText": "Analyze the codebase...",    // Inline text

  // Model selection
  "model": "sonnet",                  // Required: "sonnet" or "opus"

  // Conversation mode
  "continuationMode": "fresh",        // Required: "fresh" or "continue-previous"

  // Optional system prompt additions
  "appendSystemPromptFile": "system.md",       // Single file
  "appendSystemPromptFile": ["s1.md", "s2.md"], // Multiple files
  "appendSystemPromptText": "Always be concise", // Inline text

  // Optional workspace preparation
  "workspaceSetup": [
    {
      "type": "copy",
      "copy": {
        "from": "./templates/starter",  // Source path
        "to": "src"                     // Destination (relative to project)
      }
    },
    {
      "type": "command",
      "command": {
        "run": "npm install",
        "workingDirectory": "project"   // "project" or "lastCopied"
      }
    }
  ],

  // Optional file tracking
  "trackedFiles": [
    "src/**/*.ts",    // All TypeScript files in src
    "*.json",         // All JSON files in root
    "!node_modules"   // Exclude node_modules
  ],

  // Optional phase description
  "description": "Analyzes the codebase structure",

  // Optional environment variables
  "env": {
    "API_KEY": "phase-specific-key",
    "DEBUG": "true"
  }
}
```

### Run

A **Run** represents a single, complete lifecycle of the Tadpole server, from startup to shutdown. Each time you start the server, a new run is initiated. A run is not just a container for phase executions; it's a stateful entity with its own identity and history.

- **Unique Identifier**: Each run is assigned a unique ID (e.g., `1737288000000-abc12`) that is used for logging, state management, and as the basis for its dedicated git branch.
- **Git Branch**: To support the checkpoint and rollback system, each run is associated with its own branch in the shadow git repository, ensuring that the version history of different execution paths is kept isolated.
- **Parent Relationship**: Runs can be created as continuations of previous runs. This happens during a rollback or a retry, creating a parent-child relationship that allows the system to trace the complete execution history.
- **Phase Collection**: A run contains an ordered, append-only list of all the `PhaseExecution` objects that were attempted within its lifecycle.

### Execution Thread

An **Execution Thread** is a powerful, high-level abstraction that represents the logical, end-to-end sequence of phase executions, even when they span multiple runs. When you perform a rollback, you create a new run that continues from a point in a previous run. The execution thread is the mechanism that stitches these runs together to provide a coherent, unified view of the entire workflow history.

The thread is constructed by:

1. Starting from the most recent run.
2. Traversing its phases in reverse chronological order.
3. When it encounters a continuation point, it jumps to the parent run and continues traversing from there.
4. It intelligently excludes phases from the parent run that were superseded by the continuation, ensuring there are no duplicates in the logical history.
5. Crucially, it calculates the `nextPhaseId`, which is the server's understanding of what the next logical step in the workflow should be.

## The Phase Lifecycle: A Granular State Machine

To provide maximum visibility and control, each phase execution progresses through a detailed, well-defined lifecycle. The state machine is designed to make impossible states unrepresentable and to pinpoint the exact stage of failure.

### Phase Status Progression

The normal flow of execution is a linear progression from `preparing` to `completed`. However, a phase can transition to a terminal state (`failed` or `skipped`) from any of the non-terminal states.

```
┌───────────┐     ┌──────────┐     ┌──────────────┐     ┌─────────┐     ┌───────────┐
│ preparing │ ──> │ starting │ ──> │ initializing │ ──> │ running │ ──> │ completed │
└─────┬─────┘     └────┬─────┘     └──────┬───────┘     └────┬────┘     └───────────┘
      │                 │                   │                  │
      │                 │                   │                  │           ┌─────────┐
      └─────────────────┴───────────────────┴──────────────────┴─────────> │ failed  │
      │                 │                   │                  │           └─────────┘
      │                 │                   │                  │
      └─────────────────┴───────────────────┴──────────────────┴─────────> ┌─────────┐
                                                                            │ skipped │
                                                                            └─────────┘
```

Each transition is triggered by specific events:

- `preparing → starting`: Workspace setup completed successfully
- `starting → initializing`: Claude process spawned successfully
- `initializing → running`: Received session ID from Claude
- `running → completed`: Claude process exited cleanly (code 0)
- `any → failed`: Error occurred (process crash, timeout, user force-stop)
- `any → skipped`: User requested skip

### Status Definitions

#### Non-Terminal States (The Journey)

- **`preparing`**: The server is executing the `workspaceSetup` operations for the phase, such as copying template files or running `npm install`. The Claude process has not yet been started.
- **`starting`**: The workspace is ready. The server is now spawning the Claude CLI subprocess and feeding it the prompt via stdin. A checkpoint may be created at this stage if workspace setup was performed.
- **`initializing`**: The Claude process is running, and the server is listening to its log output, waiting for the initial "init" message that contains the crucial `sessionId`.
- **`running`**: The server has received the `sessionId` and Claude is now actively working on the prompt. This is the state where most of the "thinking", tool use, and message generation occurs. Costs and file changes are actively tracked.

#### Terminal States (The Destination)

- **`completed`**: The phase finished successfully. The Claude process exited with code 0, and the server received a final "result" message. A `completion` checkpoint is created.
- **`failed`**: The phase terminated due to an error. This could be a process crash, an API timeout, a failed workspace command, or a user-initiated force stop. An `error` checkpoint may be created to capture the state at the time of failure.
- **`skipped`**: The user gracefully requested to skip the phase. The process is terminated, and a `skipped` checkpoint is created. The server can then proceed to the next phase.

## Phase Execution in Detail

### Workspace Setup

This powerful feature allows phases to configure their own environment. The server executes these steps in order:

1.  **Copy Operations**: Copies files or entire directories. A common use is to copy a starter template into the workspace.
    ```json
    {
      "type": "copy",
      "copy": {
        "from": "./templates/react-app",  // Absolute or relative to config file
        "to": "frontend"                  // Relative to project root (where you run the command from)
      }
    }
    ```

2.  **Command Execution**: Runs arbitrary shell commands. This is often used for installing dependencies (`npm install`) or running build scripts.
    - Commands are executed using the system's default shell
    - Working directory can be:
      - `"project"`: The project root directory (where you run the command from)
      - `"lastCopied"`: The destination of the most recent copy operation
    - Commands run sequentially - if one fails, subsequent commands are skipped
    - There's no timeout by default - ensure commands complete in reasonable time

   - Commands are executed using the system's default shell
   - Working directory can be:
       - `"project"`: The project root directory
       - `"lastCopied"`: The destination of the most recent copy operation
   - Commands run sequentially - if one fails, subsequent commands are skipped
   - There's no timeout by default - ensure commands complete in reasonable time

   ```json
   {
     "type": "command",
     "command": {
       "run": "npm install && npm run build",
       "workingDirectory": "lastCopied"  // Run in the copied directory
     }
   }
   ```
1. **Checkpoint Creation**: After a successful setup, a `workspace-setup` checkpoint is automatically created, capturing the exact state of the workspace before Claude begins its work.

#### Error Handling

- If a copy operation fails (source not found, permission denied), the phase transitions to `failed`
- If a command returns non-zero exit code, the phase transitions to `failed`
- The error details are captured in the `failureReason` field

### Continuation Modes

#### `fresh` Mode

This is the default mode. It starts a brand new conversation with Claude, with no memory of previous phases. Use this when:

- Starting a new logical task
- The phase doesn't depend on previous context
- You want to ensure a clean slate

#### `continue-previous` Mode

This is the key to building multi-turn, context-aware workflows. The server will find the `sessionId` from the most recent successful execution of the preceding phase and pass it to the Claude CLI. This makes Claude "remember" the entire conversation up to that point, allowing it to build upon previous work.

**Requirements for continuation:**

- The previous phase must have reached `running` state (received a session ID)
- The previous phase must have at least one assistant message
- The previous phase can be `completed` or `skipped` (if it has messages)

**Edge cases:**

- If the previous phase `failed` before receiving any messages, continuation is not possible
- If the previous phase was `skipped` immediately (no messages), continuation is not possible
- If this is the first phase in a workflow, `continue-previous` will be treated as `fresh`
- Sessions are tied to specific Claude model versions - continuation may fail if the model changes

**Example workflow using continuation:**

```json
[
  {
    "id": "analyze",
    "continuationMode": "fresh",
    "promptText": "Analyze this codebase and identify areas for improvement"
  },
  {
    "id": "implement",
    "continuationMode": "continue-previous",
    "promptText": "Now implement the improvements you suggested"
  }
]
```

### File Tracking & Checkpointing

When you specify `trackedFiles`, you are enabling two powerful features:

1. **Live Monitoring**: The server will watch these files for any changes made by Claude's tool use and stream `file.updated` events to the client in real-time.

   - File watching uses efficient OS-level APIs
   - Changes are debounced to avoid excessive events
   - Binary files are detected but their content is not streamed
1. **Versioning**: These are the only files that will be included in the automatic git checkpoints created by the server, ensuring that your rollbacks are precise and don't revert unrelated files.

#### Glob Pattern Support

File tracking uses standard glob patterns with some extensions:

- `*` - Matches any characters except path separators
- `**` - Matches any characters including path separators
- `?` - Matches single character
- `[abc]` - Matches any character in brackets
- `!(pattern)` - Excludes matches (e.g., `!node_modules`)
- `{a,b}` - Matches either pattern

**Examples:**

```json
"trackedFiles": [
  "src/**/*.ts",     // All TypeScript files in src (recursive)
  "*.json",          // JSON files in project root only
  "docs/**/*",       // Everything in docs directory
  "!**/*.test.ts",   // Exclude test files
  "config/*.{json,yaml}"  // JSON or YAML config files
]
```

#### .gitignore Integration

- The file tracking system respects your project's `.gitignore` file
- Files ignored by git won't be tracked even if they match your patterns
- The shadow git repository has its own independent ignore rules
- To track normally-ignored files (like build outputs), you'll need to adjust your patterns

#### Important Notes

- If no `trackedFiles` are specified, no checkpoints will be created
- Checkpoints only include files that exist and match the patterns
- Deleted files are tracked and will be restored on rollback
- Symlinks are resolved and the target files are tracked

## State Persistence and Relationships

All of this complex state is meticulously tracked and persisted in `state.json`. The `Run` objects form a tree-like structure through their `startingConditions`. A run with a `fresh` start is a root, while a run with a `continuation` start is a child of the run it continues from. This structure is what allows the **Execution Thread** to accurately reconstruct the complete, logical history of the project's development, providing the foundation for intelligent, context-aware automation.