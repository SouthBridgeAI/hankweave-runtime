# Running the Langton Server

## Installation and Setup

Getting the Langton Runner up and running involves a few prerequisites and a simple setup process.

### Prerequisites

1.  **Bun Runtime**: The server is built on Bun, a fast JavaScript runtime. Ensure you have Bun v1.0.0 or later installed. You can find installation instructions at [bun.sh](https://bun.sh).
2.  **Git**: The powerful checkpoint and rollback features rely on Git. Make sure Git is installed and accessible in your system's PATH.
3.  **Claude CLI**: The server orchestrates the official Claude CLI. You must have it installed and configured with a valid Anthropic API key.

### Project Setup

Once the prerequisites are met, setting up the project is straightforward:

```bash
# 1. Clone the repository to your local machine
git clone <repository-url>
cd langton-runner

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

### Command-Line Options

The server's behavior can be fine-tuned with the following command-line flags:

-   **`--config=<path>`**: Specifies the path to your phase configuration file. This is the most important flag, as it defines the entire workflow.
    -   **Default**: `phases.json`
    -   **Example**: `bun run server --config=workflows/my-project/phases.json`

-   **`--port=<port>`**: Sets the port for the WebSocket server.
    -   **Default**: `7777`
    -   **Example**: `bun run server --port=8080`

-   **`--basic`** (or **`-b`**): Launches the server in the Basic Terminal UI (TUI) mode. This is an invaluable tool for debugging and manual control, providing a real-time, color-coded log of server events and keyboard shortcuts for interaction.

-   **`--validate`** (or **`-v`**): A crucial pre-flight check. This command parses and validates your configuration file without starting the server. It checks for schema correctness, file existence, and logical consistency, providing a detailed summary and a list of any errors or warnings.

-   **`--no-autostart`**: By default, the server automatically begins executing the first phase as soon as a client connects. This flag disables that behavior, causing the server to start in an idle state, waiting for explicit commands from the client. This is useful for scenarios requiring manual control over the workflow's initiation.

-   **`--anthropic-base-url=<url>`**: Allows you to route Claude API requests through a custom endpoint, such as a proxy or a corporate gateway.

-   **`--cleanup`**: A powerful but destructive command that cleans up all Langton-related artifacts from a project. It requires an explicit `--config` path to ensure you are targeting the correct project. It will display a detailed preview of what will be deleted and ask for confirmation.

-   **`-y`**: When used with `--cleanup`, this flag skips the confirmation prompt, allowing for automated, non-interactive cleanup operations.

-   **`--help`** (or **`-h`**): Displays a detailed help message listing all available options.

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

2.  **Phase-Specific Variables**: You can define an `env` object within a phase's configuration to set variables that are only active during that phase. These will override any system-provided variables with the same name.

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
1.  The server preserves the complete state in `.langton/state.json`.
2.  Restart the server; it will load the previous state.
3.  Examine the logs in `.langton/runs/<runId>/` to diagnose the issue.
4.  Use rollback commands to revert to a known good state before retrying.
5.  If you wish to start completely fresh, use the `bun server/index.ts --cleanup` command.
