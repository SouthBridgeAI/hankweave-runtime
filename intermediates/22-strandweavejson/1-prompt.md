Below is a quick overview of different configurations sources currently used strandweave. We would like to come up with a way to centralize as much of this config as possible and practical in a centralized `.json' file called `strandweave.json`. Apart from the configurations outlined below, we will likely want to eventually enable people to tweak some of strandweaves internals:

- bun runtime version
- docker usage
- test replay data for llm providers
- llm provider usersage
- etc etc

---

Strandweave uses three configuration sources with the following precedence (highest to lowest):

1. **Command-line arguments** - Override everything
2. **Environment variables** - System-level and codon-specific
3. **Configuration files** - JSON-based workflow definitions

---

## 1. Command-Line Arguments

**Location**: `server/index.ts:17-130`

**Pattern**: Direct `process.argv` parsing with regex validation.

### Available Arguments

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `--config=<path>` | File path | `codon-sequence.json` | Path to codon configuration file |
| `--data=<path>` | Path | Current directory | Data source path |
| `--execution=<path>` | Directory | Auto-generated | Resume in specific execution directory |
| `--start-new` | Flag | - | Force creation of new execution directory |
| `--copy` | Flag | - | Copy data instead of symlinking |
| `--port=<port>` | Number | `7777` | WebSocket server port |
| `--basic`, `-b` | Flag | - | Run in basic TUI mode |
| `--validate`, `-v` | Flag | - | Validate configuration without running |
| `--cleanup` | Flag | - | Clean up execution directories |
| `-y` | Flag | - | Skip confirmation prompts |
| `--no-autostart` | Flag | - | Don't automatically start codons |
| `--model=<sonnet\|opus>` | Enum | - | Override model for all codons |
| `--anthropic-base-url=<url>` | URL | - | Custom Anthropic API base URL |
| `--without-proxy` | Flag | - | Disable the proxy server |
| `--help`, `-h` | Flag | - | Show help message |

---

## 2. Environment Variables

**Location**: `server/claude-process-manager.ts:59-80`

### STRANDWEAVE_ Prefix Convention

Environment variables prefixed with `STRANDWEAVE_` are automatically passed to Claude processes with the prefix stripped:

### LLM Provider API Keys

**Location**: `server/llm/provider-config.ts`

| Provider | Environment Variable | Sentinel Override |
|----------|---------------------|-------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` | `STRANDWEAVE_SENTINEL_OPENAI_API_KEY` |
| Groq | `GROQ_API_KEY` | `STRANDWEAVE_SENTINEL_GROQ_API_KEY` |
| Google | `GOOGLE_API_KEY` | `STRANDWEAVE_SENTINEL_GOOGLE_API_KEY` |

The sentinel override takes precedence over the standard key when running sentinels.

### Codon-Specific Environment Variables

Defined in codon config, these override system environment variables with the same name:

```json
{
  "id": "my-codon",
  "env": {
    "API_KEY": "codon-specific-key",
    "DEBUG": "true"
  }
}
```

**Priority** (highest to lowest):
1. Codon-specific `env` field
2. `STRANDWEAVE_`-prefixed system variables
3. CLI `--anthropic-base-url` (for `ANTHROPIC_BASE_URL`)

---

## 3. Configuration Files

### Primary Config: `codon-sequence.json`

**Location**: Resolved relative to original working directory
**Validation**: `server/config.ts:336-600` using Zod schemas

### Codon Configuration

```json
{
  "id": "unique-codon-id",
  "name": "Human Readable Name",
  "type": "codon",
  "promptFile": "path/to/prompt.md",
  "model": "sonnet",
  "continuationMode": "fresh",
  "description": "Optional description",
  "trackedFiles": ["src/**/*.ts"],
  "env": {
    "CUSTOM_VAR": "value"
  },
  "rigSetup": [
    {
      "type": "copy",
      "copy": { "from": "templates/foo", "to": "src/foo" }
    },
    {
      "type": "command",
      "command": { "run": "npm install" }
    }
  ],
  "outputFiles": [
    {
      "copy": ["dist/**/*"]
    }
  ],
  "sentinels": [
    {
      "sentinelConfig": "path/to/sentinel.json"
    }
  ]
}
```

### Loop Configuration

```json
{
  "type": "loop",
  "id": "loop-id",
  "name": "Loop Name",
  "terminateOn": {
    "type": "iterationLimit",
    "limit": 5
  },
  "codons": [
    { /* codon config */ }
  ]
}
```

### Prompt Configuration Options

| Field | Type | Description |
|-------|------|-------------|
| `promptFile` | `string \| string[]` | Path(s) to prompt file(s) |
| `promptText` | `string` | Inline prompt text |
| `appendSystemPromptFile` | `string \| string[]` | Additional system prompt file(s) |
| `appendSystemPromptText` | `string` | Additional system prompt text |

### Template Variables

Available in prompt files:

| Variable | Resolves To |
|----------|-------------|
| `<%EXECUTION_DIR%>` | Execution directory path |
| `<%DATA_DIR%>` | Read-only data source path |
| `<%PROJECT_DIR%>` | Legacy alias for `<%EXECUTION_DIR%>` |

---

## 4. Default Configuration

**Location**: `server/config.ts:284-319`

```typescript
export const DEFAULT_CONFIG = {
  port: 7777,
  version: "1.0.0",
  outputDirectory: "strandweave-results",
  lockFile: ".strandweave/runtime.lock",
  socketLogFile: ".strandweave/logs/websocket.log",
  serverLogFile: ".strandweave/logs/server.log",
  costsPerMTok: {
    input: 3.0,
    inputCache: 3.75,
    cacheRead: 0.3,
    output: 15.0
  },
  logParsingInterval: 1000,
  autostart: true,
  dataHashTimeLimit: 5000,
  toolResultTruncateLength: 2500,
  withoutProxy: false,
  handshakeHistoryLimit: 50,
  sentinel: {
    enablePersistence: true,
    healthCheckGracePeriodMs: 2000,
    waitForAllHealthChecks: false
  }
};
```

---

## Summary

| Source | Location | Precedence | Use Case |
|--------|----------|------------|----------|
| CLI args | `server/index.ts` | Highest | Runtime overrides, one-off changes |
| Env vars | System + codon config | Medium | Secrets, API keys, per-environment settings |
| Config files | `codon-sequence.json` | Lowest | Workflow definition, reproducible setup |
| Defaults | `server/config.ts` | Fallback | Sensible defaults when nothing specified |

