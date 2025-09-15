# Tadpole Runner

Tadpole Runner is a powerful orchestration server designed to manage and execute complex, multi-step AI workflows using the Claude AI. It provides a robust, stateful environment that transforms large, ambiguous tasks into a structured sequence of manageable "phases". Through its WebSocket-based protocol, it offers real-time monitoring, interactive control, and a suite of advanced features that enable sophisticated AI-driven development and automation.

## What is Tadpole Runner?

At its core, Tadpole Runner is a bridge between your development environment and the Claude AI. It allows you to define a structured workflow in a simple JSON configuration file, and then it manages the entire lifecycle of executing that workflow. It goes far beyond simply running a series of prompts by providing a rich set of features that address the challenges of stateful, long-running AI tasks:

-   **Execution Isolation**: Tadpole runs in isolated execution directories, keeping your original project untouched. Your data is accessed via a symlink at `<execution-dir>/read_only_data_source/`, ensuring clean rollbacks and enabling multiple execution tracking.
-   **Flexible Data Sources**: You can provide either a file or a directory as your data source. Files are automatically placed in a `read_only_data_source` directory for consistent access.
-   **State Persistence**: The server meticulously records every action, decision, and outcome in the execution's `.tadpole` directory. This means you can stop the server and resume your workflow later, with all history and context perfectly preserved.
-   **Rollback System**: A shadow git repo automatically checkpoints your execution state at key moments. This allows you to instantly revert to any point in the execution history, making it easy to explore different approaches or recover from errors.
-   **Cost Tracking**: Get real-time feedback on token usage and associated costs for each phase, helping you manage your budget and optimize your prompts.
-   **Tool Result Tracking**: Monitor Claude's tool executions in real-time with detailed results, execution timing, and automatic truncation of large outputs.
-   **File Tracking**: Specify which files Claude should pay attention to. The server will monitor these files for changes, stream updates to you in real-time, and include them in checkpoints.
-   **Session Continuity**: Build complex, multi-turn conversations with Claude. A phase can be configured to "continue" from the previous one, inheriting the full conversational context.
-   **Workspace Setup**: Automate the preparation of your development environment. Before a phase starts, the server can copy template files or run shell commands (like `npm install`), ensuring Claude has everything it needs to get started.

## Installation

### Prerequisites

To use Tadpole Runner, you'll need a few things set up in your development environment:

1.  **[Bun](https://bun.sh)** (v1.0.0 or later): A fast, all-in-one JavaScript runtime and toolkit.
2.  **Git**: Required for the powerful checkpoint and rollback functionality.
3.  **[Claude CLI](https://github.com/anthropics/claude-cli)**: The underlying tool used to communicate with the Claude API. Ensure it's installed and configured with your API key.

### Setup

```bash
# 1. Clone the repository to your local machine
git clone <repository-url>
cd tadpole

# 2. Install all necessary dependencies using Bun
bun install

# 3. Test your system
bun test ./tests/e2e/happy-path-e2e.test.ts
```

## Quick Start

Let's walk through a simple two-phase workflow.

### 1. Create a Phase Configuration

Create a file named `phases.json` where you run the command from:

```json
[
  {
    "id": "phase-1-analysis",
    "name": "Phase 1: Initial Analysis",
    "promptFile": "prompts/1-analyze.md",
    "model": "sonnet",
    "continuationMode": "fresh",
    "trackedFiles": ["src/**/*.ts", "analysis.md"],
    "outputFiles": [
      {
        "beforeCopy": [
          {
            "type": "command",
            "command": {
              "run": "mv analysis.md $(date +%Y_%m_%d)_analysis.md",
              "workingDirectory": "project"
            }
          }
        ],
        "copy": ["*_analysis.md"]
      }
    ]
  },
  {
    "id": "phase-2-implementation",
    "name": "Phase 2: Implementation",
    "promptFile": "prompts/2-implement.md",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "trackedFiles": ["src/**/*.ts"]
  }
]
```

### 2. Create Prompt Files

Create a `prompts` directory and add the following files:

**`prompts/1-analyze.md`**:
```markdown
Please analyze the TypeScript files in the `src/` directory. Identify areas for improvement in terms of code structure, clarity, and potential bugs. Write your findings to a new file named `analysis.md`.
```

**`prompts/2-implement.md`**:
```markdown
Based on our previous discussion and the contents of `analysis.md`, please implement the suggested improvements directly into the source files.
```

### 3. Run the Server

You can run the server in two primary modes:

```bash
# For programmatic clients (e.g., a web UI)
bun run server

# For interactive use in your terminal
bun run server:basic
```

When you run in TUI mode, you'll see a live stream of events and can control the flow with keyboard shortcuts like `[n]` to advance to the next phase.

### 4. Using Different Data Sources

You can provide either a directory or a single file as your data source:

```bash
# Using a directory (default behavior)
bun run server --data=/path/to/project

# Using a single file
bun run server --data=/path/to/document.txt

# The data will be accessible at <%DATA_DIR%> in your prompts
```

## Key Concepts Explained

-   **Phases**: The building blocks of your workflow. Each phase is a self-contained task for Claude, defined by its prompt, model, and other settings.
-   **Runs**: A single, end-to-end execution of the server. A new run is created every time you start the server, and it contains the history of all phases attempted during that session.
-   **Execution Thread**: The logical, unified history of your workflow, even across multiple runs (e.g., after a rollback). It's how the server knows what the "next" step truly is.
-   **Checkpoints**: Automatic git commits in a hidden "shadow" repository that capture the state of your tracked files at critical moments, enabling the rollback feature.

## Novel Architectural Aspects

Tadpole Runner incorporates several advanced design patterns to provide its powerful feature set:

-   **Fire-and-Forget State Management**: The server uses an event-sourcing-inspired model where state changes are queued and processed asynchronously. This decouples components and ensures that state is always persisted atomically and safely.
-   **Shadow Git Repository**: By maintaining its own git repository in the `.tadpole` folder, the server can provide powerful versioning and rollback features without ever interfering with your project's own git history.
-   **Granular Phase States**: The server tracks each phase through a seven-stage lifecycle (`preparing`, `starting`, `initializing`, `running`, `completed`, `failed`, `skipped`). This provides extremely precise state tracking and error reporting.

## Documentation

Comprehensive documentation is available in the `documentation/` directory:

-   **[Architecture Overview](documentation/architecture.md)** - System design, modules, and key architectural decisions
-   **[Execution Model Guide](documentation/execution-model-guide.md)** - Deep dive into executions, data directories, symlinks, runs, and phases with formulas
-   **[Phase Configuration Guide](documentation/phase-configuration-guide.md)** - Complete guide to building phase configurations
-   **[Phase System](documentation/phase-system.md)** - Understanding phases, runs, and execution threads
-   **[Running the Server](documentation/running-the-server.md)** - Installation, setup, and command-line options
-   **[Server Protocol](documentation/server-protocol.md)** - WebSocket protocol reference for client developers
-   **[Tadpole Folder Structure](documentation/tadpole-folder-structure.md)** - Understanding the `.tadpole` directory

## Important Considerations

-   **Single Client Model**: The server is designed to be controlled by a single client at a time. When that client disconnects, the server gracefully shuts down.
-   **Atomic State Persistence**: Your workflow's history is precious. The server uses an atomic write process (write-to-temp, backup, then rename) to ensure that the `state.json` file is never corrupted, even if the server crashes mid-write.
-   **File Tracking**: Remember that only files matching the `trackedFiles` patterns in your phase configuration will be monitored for changes and included in checkpoints. This is a feature, not a limitation, as it allows you to be precise about what state you want to version.

## Troubleshooting

-   **Configuration Issues?** Run `bun run validate --config=<your-config>.json` to get a detailed analysis of your setup before you start a run.
-   **Need to Start Over?** If you want a completely clean slate, you can stop the server and safely delete the entire `.tadpole` directory. For a less destructive reset, consider the `bun server/index.ts --cleanup` command.
-   **How to Rollback?** In the Basic TUI, simply press `[r]` to open the interactive rollback menu. If you're using a programmatic client, send the `rollback.toLastSuccess` or `rollback.toCheckpoint` command.
