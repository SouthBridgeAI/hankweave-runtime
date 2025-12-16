# Running the Strandweave Server

## Installation and Setup

Getting the Strandweave Runner up and running involves a few prerequisites and a simple setup process.

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
cd strandweave

# 2. Install all necessary dependencies using Bun
bun install

# 3. Verify the installation and a sample configuration file
# This command validates the default strand.json without starting the server
bun run validate
```

### Quick Start - Initialize a New Workflow

The fastest way to get started is to use the `--init` command to create a new workflow project:

```bash
# Create a new directory for your workflow
mkdir my-workflow
cd my-workflow

# Initialize with template files
strandweave --init

# This creates:
#   - strand.json           (workflow configuration)
#   - prompts/analyze.md    (prompt template)
#   - .gitignore            (git ignore patterns)
#   - README.md             (quick start guide)

# Run the workflow with your data
strandweave --config=strand.json --data=/path/to/your/project
```

The generated workflow includes a simple analysis codon that reads your data and creates an analysis report. You can customize the `strand.json` and prompts to build more complex workflows.

**What gets created:**
- **strand.json** - Basic workflow with one analysis codon, using the [object format](./codon-configuration-guide.md#strand-file-format)
- **prompts/analyze.md** - Template prompt asking Claude to analyze project files
- **.gitignore** - Ignores execution directories and output files
- **README.md** - Instructions for running and customizing your workflow

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

-   **`--config=<path>`**: Specifies the path to your strand configuration file. This defines the entire workflow.
    -   **Default**: `strand.json`
    -   **Example**: `bun run server --config=workflows/my-project/strand.json`

-   **`--data=<path>`**: Path to your data source (file or directory). Strandweave will create an isolated execution environment with your data accessible at `<execution-dir>/read_only_data_source/`.
    -   **Default**: Current directory
    -   **Example (directory)**: `bun run server --data=/path/to/project`
    -   **Example (file)**: `bun run server --data=/path/to/requirements.txt`

-   **`--execution=<path>`**: Resume work in a specific execution directory instead of auto-detecting.
    -   **Example**: `bun run server --execution=~/.strandweave-executions/1234-abc`

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

-   **`--no-autostart`**: By default, the server automatically begins executing the first codon as soon as a client connects. This flag disables that behavior, causing the server to start in an idle state, waiting for explicit commands from the client. This is useful for scenarios requiring manual control over the workflow's initiation.

-   **`--anthropic-base-url=<url>`**: Allows you to route Claude API requests through a custom endpoint, such as a proxy or a corporate gateway.

-   **`--without-proxy`**: Disables the built-in LLM proxy server entirely. The proxy is normally started alongside the main server to handle API request routing.
    -   **Example**: `bun run server --without-proxy`

#### Maintenance Options

-   **`--cleanup`**: Cleans up execution directories. When used with `--data`, removes the latest execution for that data source. When used with `--execution`, removes that specific execution directory.
    -   **Example**: `bun run server --cleanup --data=/path/to/project`

-   **`-y`**: When used with `--cleanup`, this flag skips the confirmation prompt, allowing for automated, non-interactive cleanup operations.

-   **`--help`** (or **`-h`**): Displays a detailed help message listing all available options.

## Execution Isolation

Strandweave Runner uses execution isolation to keep your project data safe and enable advanced features like clean rollbacks and multiple execution tracking.

### How It Works

Instead of running directly in your project directory, Strandweave:
1. Creates an isolated execution directory (e.g., `~/.strandweave-executions/1234-abc/`)
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
~/.strandweave-executions/
└── 1737123456789-abc-d4f5e6/          # Execution directory
    ├── read_only_data_source/         # Symlink to your data or contains file
    │   └── [filename.txt]             # (if data source is a file)
    ├── generated-docs/                # Files created by Claude
    ├── backend/                       # Rig setup files
    └── .strandweave/                      # Strandweave metadata
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
bun run server --execution=~/.strandweave-executions/1234-abc

# Clean up latest execution
bun run server --cleanup --data=/path/to/project
```

## Server Modes of Operation

### WebSocket Server Mode (Default)

This is the standard operational mode, designed for integration with programmatic clients (e.g., a web-based UI, an IDE extension).

```bash
bun run server --config=strand.json
```

In this mode, the server:
1.  Starts a WebSocket server on the configured port.
2.  Waits for clients to connect. It can handle multiple concurrent clients, each with different access modes (`readonly` or `readandwrite`).
3.  Communicates exclusively through the JSON-based protocol, sending events and receiving commands.
4.  Continues running even if all clients disconnect, allowing for persistent workflows.

### Basic TUI Mode

The Basic Terminal UI (TUI) is an interactive, console-based client perfect for local development, testing, and debugging.

```bash
bun run server:basic --config=strand.json
```

The TUI provides:
-   A real-time, color-coded stream of all server events.
-   Clear status indicators (emojis) for different event types.
-   Keyboard shortcuts for controlling the workflow without needing a separate client.

#### TUI Keyboard Controls

-   **`[n]`**: Advance to the **n**ext codon.
-   **`[s]`**: **S**kip the current codon.
-   **`[f]`**: **F**orce-stop the current codon.
-   **`[l]`**: **L**ist available checkpoints.
-   **`[r]`**: Open the interactive **r**ollback menu.
-   **`[q]`** or **`Ctrl+C`**: **Q**uit the server.

### Validation Mode

A read-only mode that provides a comprehensive analysis of your configuration file. It's highly recommended to run this before starting a complex workflow.

```bash
bun run validate --config=strand.json
```

The validation process checks for:
-   Correct JSON syntax and schema adherence.
-   Existence and readability of all referenced prompt and rig files.
-   Logical consistency, such as ensuring a `continue-previous` codon is not the first in the sequence.
-   It also provides a helpful summary of environment variables that will be available to Claude.

## Environment Variables

Strandweave uses three distinct environment variable prefixes for different purposes:

### 1. Runtime Configuration (`STRANDWEAVE_RUNTIME_*`)

These environment variables configure the Strandweave server itself (port, model, sentinel settings, etc.). They are part of the [5-layer configuration system](#configuration-system).

```bash
export STRANDWEAVE_RUNTIME_PORT=8080
export STRANDWEAVE_RUNTIME_MODEL=opus
export STRANDWEAVE_RUNTIME_WITHOUT_PROXY=true
export STRANDWEAVE_RUNTIME_SENTINEL_ENABLE_PERSISTENCE=false
```

See the [Configuration System](#configuration-system) section below for complete details and all available options.

### 2. Main Agent Environment (`STRANDWEAVE_*`)

Any environment variable prefixed with `STRANDWEAVE_` will be passed to the Claude process with the prefix removed, **except** for:
- `STRANDWEAVE_RUNTIME_*` - These configure the server itself, not passed to Claude
- `STRANDWEAVE_SENTINEL_*` - These are sentinel API keys, not passed to Claude

```bash
export STRANDWEAVE_CUSTOM_API_KEY=secret123
export STRANDWEAVE_DB_URL=postgres://localhost/mydb
# Claude process will see:
# CUSTOM_API_KEY=secret123
# DB_URL=postgres://localhost/mydb
```

**Why STRANDWEAVE prefix?** This serves as a namespace to:
- Prevent accidental exposure of sensitive system variables
- Make it clear which variables are intended for Claude
- Avoid conflicts with existing environment variables

You can also define **codon-specific variables** in your strand configuration that override system variables:
```json
{
  "id": "codon-1",
  "env": {
    "API_ENDPOINT": "https://staging.api.com",
    "DEBUG": "true"
  }
}
```

### 3. Sentinel API Keys (`STRANDWEAVE_SENTINEL_*`)

Sentinels use separate environment variables for their LLM API keys, allowing you to use separate API accounts:

```bash
export STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY=sk-ant-...
export STRANDWEAVE_SENTINEL_OPENAI_API_KEY=sk-...
export STRANDWEAVE_SENTINEL_GROQ_API_KEY=gsk_...
export STRANDWEAVE_SENTINEL_GOOGLE_API_KEY=...
```

If these are not set, sentinels fall back to the standard variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).

For complete details on sentinel configuration, see the [Sentinel Configuration Guide](./sentinels/configuration-guide.md#environment-variables).

## Configuration System

Strandweave uses a flexible 5-layer configuration system that allows you to configure server settings through multiple sources, with a clear precedence order.

### Configuration Resolution Order

Settings are merged in this order (later layers override earlier ones):

1. **Default Configuration** - Built-in defaults
2. **Runtime Config File** - `strandweave.json` in execution directory
3. **Strand File Recommendations** - `recommendations` section in your strand.json
4. **Environment Variables** - `STRANDWEAVE_RUNTIME_*` prefixed variables
5. **CLI Arguments** - Command-line flags (highest priority)

This layered approach gives you flexibility:
- Set project-wide defaults in `strandweave.json`
- Recommend settings for specific workflows in strand files
- Override with environment variables for CI/CD
- Use CLI flags for one-off changes

### Layer 1: Default Configuration

These are the built-in defaults used when no other configuration is provided:

```typescript
{
  port: 7777,
  version: "1.0.0",
  outputDirectory: "strandweave-results",
  executionBaseDir: "~/.strandweave-executions",
  autostart: true,
  withoutProxy: false,
  logParsingInterval: 1000,
  dataHashTimeLimit: 60000,
  idleTimeout: 20,

  // Sentinel configuration
  sentinel: {
    enablePersistence: true,
    healthCheckGracePeriodMs: 2000,
    waitForAllHealthChecks: false
  },

  // Cost tracking (per million tokens)
  costsPerMTok: {
    input: 3.0,
    inputCache: 3.75,
    cacheRead: 0.3,
    output: 15.0
  }
}
```

### Layer 2: Runtime Config File (`strandweave.json`)

Create a `strandweave.json` file in your execution directory for project-wide settings. This file is optional but useful for setting defaults that apply across multiple strand files.

**Location**: The file is auto-discovered in the current execution directory (`process.cwd()`).

**Example** `strandweave.json`:
```json
{
  "port": 8080,
  "model": "sonnet",
  "autostart": false,
  "logParsingInterval": 2000,
  "idleTimeout": 30,
  "sentinel": {
    "enablePersistence": false,
    "healthCheckGracePeriodMs": 3000
  }
}
```

**Available Fields**:
- `port` (number) - WebSocket server port
- `model` ("sonnet" | "opus") - Default model for all codons
- `autostart` (boolean) - Auto-start first codon on client connect
- `withoutProxy` (boolean) - Disable the LLM proxy server
- `anthropicBaseUrl` (string) - Custom Anthropic API endpoint
- `logParsingInterval` (number) - How often to check for new log entries (ms)
- `dataHashTimeLimit` (number) - Max time for data hashing (ms)
- `idleTimeout` (number) - Idle timeout for WebSocket and proxy servers in seconds (0-255). Maximum time a connection can be idle before the server closes it.
- `sentinel` (object) - Sentinel configuration:
  - `enablePersistence` (boolean) - Enable sentinel state persistence
  - `healthCheckGracePeriodMs` (number) - Grace period for health checks
  - `waitForAllHealthChecks` (boolean) - Wait for all sentinels before starting codon

### Layer 3: Strand File Recommendations

Your strand configuration file can include a `recommendations` section that suggests settings for that specific workflow:

**Example** `strand.json`:
```json
{
  "meta": {
    "name": "My Workflow",
    "version": "1.0.0",
    "description": "A complex workflow that needs specific settings",
    "author": "Your Name"
  },
  "recommendations": {
    "model": "opus",
    "dataHashTimeLimit": 15000,
    "sentinel": {
      "enablePersistence": true
    }
  },
  "strand": [
    {
      "id": "codon-1",
      "name": "First Codon",
      "model": "sonnet",
      "continuationMode": "fresh",
      "promptText": "Do something"
    }
  ]
}
```

**Why use recommendations?**
- Share optimal settings with your team
- Document the intended configuration for a workflow
- Users can still override with environment variables or CLI args

**Available Fields**: Same as runtime config file (see Layer 2 above).

### Layer 4: Environment Variables

Use `STRANDWEAVE_RUNTIME_*` prefixed environment variables for deployment-specific or CI/CD configuration:

**Naming Convention**:
- Use `SNAKE_CASE` for environment variable names
- Prefix with `STRANDWEAVE_RUNTIME_`
- For nested config (like sentinel settings), use additional underscores

**Examples**:
```bash
# Basic settings
export STRANDWEAVE_RUNTIME_PORT=9000
export STRANDWEAVE_RUNTIME_MODEL=opus
export STRANDWEAVE_RUNTIME_AUTOSTART=false
export STRANDWEAVE_RUNTIME_WITHOUT_PROXY=true
export STRANDWEAVE_RUNTIME_ANTHROPIC_BASE_URL=https://custom.api.com

# Timing settings
export STRANDWEAVE_RUNTIME_LOG_PARSING_INTERVAL=2000
export STRANDWEAVE_RUNTIME_DATA_HASH_TIME_LIMIT=30000
export STRANDWEAVE_RUNTIME_IDLE_TIMEOUT=30

# Sentinel settings (nested)
export STRANDWEAVE_RUNTIME_SENTINEL_ENABLE_PERSISTENCE=false
export STRANDWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS=5000
export STRANDWEAVE_RUNTIME_SENTINEL_WAIT_FOR_ALL_HEALTH_CHECKS=true
```

**Type Conversion**:
- Boolean fields: `"true"`, `"false"`, `"1"`, or `"0"`
- Number fields: Parsed as integers or floats
- String fields: Used as-is

### Layer 5: CLI Arguments (Highest Priority)

Command-line arguments override all other configuration layers:

```bash
# Override port
bun run server --port=9999

# Override model
bun run server --model=opus

# Disable autostart
bun run server --no-autostart

# Disable proxy
bun run server --without-proxy

# Custom API endpoint
bun run server --anthropic-base-url=https://custom.api.com

# Set idle timeout to 30 seconds
bun run server --idle-timeout=30
```

**Available CLI Flags**:
- `--port=<number>` - Server port
- `--model=<sonnet|opus>` - Default model
- `--no-autostart` - Don't auto-start codons
- `--without-proxy` - Disable LLM proxy
- `--anthropic-base-url=<url>` - Custom API endpoint
- `--idle-timeout=<seconds>` - Idle timeout in seconds (0-255)

See [Command-Line Options](#command-line-options) for complete list.

### Configuration Resolution Examples

#### Example 1: Simple Override Chain

```bash
# Layer 1: Default port is 7777
# Layer 2: strandweave.json sets port to 8080
# Layer 3: strand.json recommendations don't specify port
# Layer 4: STRANDWEAVE_RUNTIME_PORT=9000
# Layer 5: --port=9999

# Result: Port is 9999 (CLI wins)
```

#### Example 2: Partial Overrides

```bash
# Layer 1: Default config
# Layer 2: strandweave.json
{
  "port": 8080,
  "model": "sonnet",
  "autostart": false
}

# Layer 3: strand.json recommendations
{
  "model": "opus"  // Override model only
}

# Layer 4: STRANDWEAVE_RUNTIME_WITHOUT_PROXY=true

# Result:
{
  "port": 8080,           // From Layer 2
  "model": "opus",        // From Layer 3 (overrides Layer 2)
  "autostart": false,     // From Layer 2
  "withoutProxy": true    // From Layer 4
}
```

#### Example 3: Nested Configuration Merging

```bash
# Layer 2: strandweave.json
{
  "sentinel": {
    "enablePersistence": true,
    "healthCheckGracePeriodMs": 1000
  }
}

# Layer 3: strand.json recommendations
{
  "sentinel": {
    "enablePersistence": false,  // Override this field
    "waitForAllHealthChecks": true  // Add new field
  }
}

# Layer 4: Env vars
export STRANDWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS=3000

# Result (deep merged):
{
  "sentinel": {
    "enablePersistence": false,      // From Layer 3
    "healthCheckGracePeriodMs": 3000, // From Layer 4
    "waitForAllHealthChecks": true   // From Layer 3
  }
}
```

### Best Practices

**1. Use the Right Layer for Each Setting**:
- **Defaults**: Don't configure (use built-in defaults)
- **Project-wide**: Put in `strandweave.json`
- **Workflow-specific**: Put in strand file `recommendations`
- **Deployment/CI**: Use environment variables
- **One-off testing**: Use CLI arguments

**2. Document Recommendations**:
```json
{
  "meta": {
    "name": "High-Memory Workflow",
    "version": "1.0.0",
    "description": "This workflow processes large files and needs extended timeouts"
  },
  "recommendations": {
    "dataHashTimeLimit": 120000,
    "model": "opus"
  }
}
```

**3. Environment-Specific Config**:
```bash
# .env.development
STRANDWEAVE_RUNTIME_PORT=7777
STRANDWEAVE_RUNTIME_LOG_PARSING_INTERVAL=500

# .env.production
STRANDWEAVE_RUNTIME_PORT=8080
STRANDWEAVE_RUNTIME_LOG_PARSING_INTERVAL=2000
STRANDWEAVE_RUNTIME_SENTINEL_ENABLE_PERSISTENCE=true
```

**4. Verify Configuration**:
Use the validate command to see the effective configuration:
```bash
bun run validate --config=strand.json --port=9999
```

## Typical Workflows

### Automated Execution (Fresh Start)

This is the most common workflow.
1.  Define your entire workflow in a `strand.json` file.
2.  Start the server: `bun run server --config=my-strand.json`.
3.  Connect your client. The server will automatically start the first codon and continue through the sequence until all codons are complete, then shut down.

### Interactive Development & Manual Control

For more iterative or exploratory work:
1.  Start the server with autostart disabled: `bun run server --no-autostart`.
2.  Connect your client (or use the Basic TUI).
3.  Manually trigger codons using `codon.start` or `codon.next`.
4.  Review the output, make adjustments to prompts or files, and use `codon.redo` or `rollback` commands to iterate.

### Debugging and Recovery

When a codon fails:
1.  The server preserves the complete state in `.strandweave/state.json`.
2.  Restart the server; it will load the previous state.
3.  Examine the logs in `.strandweave/runs/<runId>/` to diagnose the issue.
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
