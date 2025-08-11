# Running the Tadpole Server

## Installation and Setup

Getting the Tadpole Runner up and running involves a few prerequisites and a simple setup process.

### Prerequisites

1.  **Bun Runtime**: The server is built on Bun, a fast JavaScript runtime. Ensure you have Bun v1.0.0 or later installed. You can find installation instructions at [bun.sh](https://bun.sh).
    ```bash
    # Check Bun version
    bun --version
    ```

2.  **Git**: The powerful checkpoint and rollback features rely on Git. Make sure Git is installed and accessible in your system's PATH.
    ```bash
    # Check Git version (2.25+ recommended)
    git --version
    ```

3.  **Claude CLI**: The server orchestrates the official Claude CLI. You must have it installed and configured with a valid Anthropic API key.
    ```bash
    # Install Claude CLI
    npm install -g @anthropic-ai/claude-cli

    # Configure with your API key
    claude auth
    ```

**System Requirements:**
- **OS**: macOS, Linux, or Windows (with WSL)
- **Memory**: 4GB RAM minimum (8GB recommended)
- **Disk**: 1GB free space for logs and checkpoints
- **Network**: Stable internet for Claude API calls

### Project Setup

Once the prerequisites are met, setting up the project is straightforward:

```bash
# 1. Clone the repository to your local machine
git clone <repository-url>
cd tadpole

# 2. Install all necessary dependencies using Bun
bun install

# 3. Verify the installation and a sample configuration file
# This command validates the default phases.json without starting the server
bun run validate
```

## Command-Line Interface

The server is controlled via a command-line interface that offers various options to customize its behavior.

### Basic Usage

You can run the server directly using Bun or via the predefined npm scripts in `package.json`.

```bash
# Direct execution
bun server/index.ts [options]

# Using npm scripts (recommended)
bun run server          # Starts the standard WebSocket server
bun run server:basic    # Starts the server with the Basic TUI
```

**Exit Codes:**
- `0`: Successful completion
- `1`: Configuration error
- `2`: Runtime error
- `3`: Cleanup requested
- `130`: Interrupted (Ctrl+C)

### Command-Line Options

The server's behavior can be fine-tuned with the following command-line flags:

#### Configuration & Data Options

-   **`--config=<path>`**: Specifies the path to your phase configuration file. This defines the entire workflow.
    -   **Default**: `phases.json`
    -   **Example**: `bun run server --config=workflows/my-project/phases.json`

-   **`--data=<path>`**: Path to your data source (file or directory). Tadpole will create an isolated execution environment with your data accessible at `<execution-dir>/read_only_data_source/`.
    -   **Default**: Current directory
    -   **Example (directory)**: `bun run server --data=/path/to/project`
    -   **Example (file)**: `bun run server --data=/path/to/requirements.txt`

-   **`--execution=<path>`**: Resume work in a specific execution directory instead of auto-detecting.
    -   **Example**: `bun run server --execution=~/.tadpole-executions/1234-abc`

-   **`--start-new`**: Force creation of a new execution directory, ignoring any existing executions for the same data.
    -   **Example**: `bun run server --data=/path/to/project --start-new`

-   **`--copy`**: Copy data instead of creating a symlink. Use this on Windows or when symlinks aren't supported.
    -   **Example**: `bun run server --data=/path/to/project --copy`

#### Server Options

-   **`--port=<port>`**: Sets the port for the WebSocket server.
    -   **Default**: `7777`
    -   **Example**: `bun run server --port=8080`

-   **`--basic`** (or **`-b`**): Launches the server in the Basic Terminal UI (TUI) mode. This is an invaluable tool for debugging and manual control, providing a real-time, color-coded log of server events and keyboard shortcuts for interaction.

-   **`--validate`** (or **`-v`**): A crucial pre-flight check. This command parses and validates your configuration file without starting the server. It checks for schema correctness, file existence, and logical consistency, providing a detailed summary and a list of any errors or warnings.

-   **`--no-autostart`**: By default, the server automatically begins executing the first phase as soon as a client connects. This flag disables that behavior, causing the server to start in an idle state, waiting for explicit commands from the client. This is useful for scenarios requiring manual control over the workflow's initiation.

-   **`--anthropic-base-url=<url>`**: Allows you to route Claude API requests through a custom endpoint, such as a proxy or a corporate gateway.

-   **`--without-proxy`**: Disables the built-in LLM proxy server entirely. The proxy is normally started alongside the main server to handle API request routing.
    -   **Example**: `bun run server --without-proxy`

#### Maintenance Options

-   **`--cleanup`**: Cleans up execution directories. When used with `--data`, removes the latest execution for that data source. When used with `--execution`, removes that specific execution directory.
    -   **Example**: `bun run server --cleanup --data=/path/to/project`

-   **`-y`**: When used with `--cleanup`, this flag skips the confirmation prompt, allowing for automated, non-interactive cleanup operations.

-   **`--help`** (or **`-h`**): Displays a detailed help message listing all available options.

## Execution Isolation

Tadpole Runner uses execution isolation to keep your project data safe and enable advanced features like clean rollbacks and multiple execution tracking.

### How It Works

Instead of running directly in your project directory, Tadpole:
1. Creates an isolated execution directory (e.g., `~/.tadpole-executions/1234-abc/`)
2. Links your data source via a symlink at `<execution-dir>/read_only_data_source/`
   - If data is a directory: creates a direct symlink to the directory
   - If data is a file: creates the directory and symlinks the file inside it
3. Runs all operations within this execution environment
4. Keeps all generated files, logs, and state separate from your original data

### Benefits

- **Data Safety**: Your original project files are never modified directly
- **Clean Rollbacks**: Rollbacks only affect the execution environment
- **Multiple Executions**: Track different approaches to the same task
- **Easy Cleanup**: Remove execution artifacts without touching your project

### Execution Directory Structure

```
~/.tadpole-executions/
└── 1737123456789-abc-d4f5e6/          # Execution directory
    ├── read_only_data_source/         # Symlink to your data or contains file
    │   └── [filename.txt]             # (if data source is a file)
    ├── generated-docs/                # Files created by Claude
    ├── backend/                       # Workspace setup files
    └── .tadpole/                      # Tadpole metadata
        ├── execution-meta.json
        ├── state.json
        └── checkpoints/
```

### Common Usage Patterns

```bash
# First run - creates new execution
bun run server --data=/path/to/project

# Resume latest execution
bun run server --data=/path/to/project

# Force new execution
bun run server --data=/path/to/project --start-new

# Resume specific execution
bun run server --execution=~/.tadpole-executions/1234-abc

# Clean up latest execution
bun run server --cleanup --data=/path/to/project
```

## Server Modes of Operation

### WebSocket Server Mode (Default)

This is the standard operational mode, designed for integration with programmatic clients (e.g., a web-based UI, an IDE extension).

```bash
bun run server --config=phases.json
```

In this mode, the server:
1.  Starts a WebSocket server on the configured port.
2.  Waits for a single client to connect.
3.  Communicates exclusively through the JSON-based protocol, sending events and receiving commands.
4.  Automatically shuts down when the client disconnects.

### Basic TUI Mode

The Basic Terminal UI (TUI) is an interactive, console-based client perfect for local development, testing, and debugging.

```bash
bun run server:basic --config=phases.json
```

The TUI provides:
-   A real-time, color-coded stream of all server events.
-   Clear status indicators (emojis) for different event types.
-   Keyboard shortcuts for controlling the workflow without needing a separate client.

#### TUI Keyboard Controls

-   **`[n]`**: Advance to the **n**ext phase.
-   **`[s]`**: **S**kip the current phase.
-   **`[f]`**: **F**orce-stop the current phase.
-   **`[l]`**: **L**ist available checkpoints.
-   **`[r]`**: Open the interactive **r**ollback menu.
-   **`[q]`** or **`Ctrl+C`**: **Q**uit the server.

### Validation Mode

A read-only mode that provides a comprehensive analysis of your configuration file. It's highly recommended to run this before starting a complex workflow.

```bash
bun run validate --config=phases.json
```

The validation process checks for:
-   Correct JSON syntax and schema adherence.
-   Existence and readability of all referenced prompt and workspace files.
-   Logical consistency, such as ensuring a `continue-previous` phase is not the first in the sequence.
-   It also provides a helpful summary of environment variables that will be available to Claude.

## Environment Variables

You can pass environment variables to the Claude process in two ways:

1.  **System Environment Variables**: Any environment variable on your system prefixed with `TADPOLE_` will be passed to the Claude process with the prefix removed. This is a secure way to inject secrets like API keys without hardcoding them.
    ```bash
    export TADPOLE_CUSTOM_API_KEY=secret123
    # Claude process will see CUSTOM_API_KEY=secret123
    ```

    **Why TADPOLE?** The prefix serves as a namespace to:
    - Prevent accidental exposure of sensitive system variables
    - Make it clear which variables are intended for Claude
    - Avoid conflicts with existing environment variables
    - The name comes from the project's internal codename

2.  **Phase-Specific Variables**: You can define an `env` object within a phase's configuration to set variables that are only active during that phase. These will override any system-provided variables with the same name.
    ```json
    {
      "id": "phase-1",
      "env": {
        "API_ENDPOINT": "https://staging.api.com",
        "DEBUG": "true"
      }
    }
    ```

## Typical Workflows

### Automated Execution (Fresh Start)

This is the most common workflow.
1.  Define your entire workflow in a `phases.json` file.
2.  Start the server: `bun run server --config=my-phases.json`.
3.  Connect your client. The server will automatically start the first phase and continue through the sequence until all phases are complete, then shut down.

### Interactive Development & Manual Control

For more iterative or exploratory work:
1.  Start the server with autostart disabled: `bun run server --no-autostart`.
2.  Connect your client (or use the Basic TUI).
3.  Manually trigger phases using `phase.start` or `phase.next`.
4.  Review the output, make adjustments to prompts or files, and use `phase.redo` or `rollback` commands to iterate.

### Debugging and Recovery

When a phase fails:
1.  The server preserves the complete state in `.tadpole/state.json`.
2.  Restart the server; it will load the previous state.
3.  Examine the logs in `.tadpole/runs/<runId>/` to diagnose the issue.
4.  Use rollback commands to revert to a known good state before retrying.
5.  If you wish to start completely fresh, use the `bun server/index.ts --cleanup` command.

**Common Issues and Solutions:**

| Issue | Cause | Solution |
|-------|-------|----------|
| "Claude CLI not found" | CLI not installed or not in PATH | Install with `npm install -g @anthropic-ai/claude-cli` |
| "API timeout" | Network issues or rate limiting | Check connection, wait for rate limit reset |
| "Permission denied" | File permissions or locked files | Check file ownership, close other programs |
| "Git not available" | Git not installed | Install Git (checkpointing will be disabled) |
| "Port already in use" | Another server running | Change port with `--port` or kill other process |
| "State corrupted" | Disk error or crash during write | Server will auto-recover from backup |

**Performance Tuning:**
- **Large Projects**: Use specific glob patterns in `trackedFiles` to avoid tracking unnecessary files
- **Slow Checkpoints**: Exclude large binary files and build artifacts
- **Memory Usage**: The server streams logs and doesn't load entire files into memory
- **API Rate Limits**: The server respects Claude's rate limits automatically
