# Gemini CLI Shim

A shim that translates Gemini CLI output to the standardized JSONL format for orchestrators.

## Installation

```bash
bun install
bun run build
```

## Usage

```bash
echo "Your prompt here" | ./dist/index.mjs --model gemini-2.5-flash
```

### Command-Line Arguments

#### Required
- `--model <model>` - Model identifier (e.g., `gemini-2.5-flash`, `gemini-2.5-pro`, `flash`, `pro`)

#### Optional
- `--resume <session_id>` - Resume a previous session
- `--verbose` - Enable verbose logging to stderr
- `--append-system-prompt <text>` - Additional system prompt to append
- `--self-test` - Run environment verification
- `--version` - Print version and exit
- `--help` - Print help and exit

### Model Shortnames

- `flash` → `gemini-2.5-flash`
- `pro` → `gemini-2.5-pro`
- `sonnet` → `anthropic/claude-sonnet-4-20250514` (for reference)
- `haiku` → `anthropic/claude-3-haiku` (for reference)

## Features

### ✅ Implemented
- Stream JSON output from Gemini CLI
- Tool name normalization (maps Gemini tool names to standard names)
- Tool ID correlation (tracks Gemini tool IDs and maps to `toolu_*` format)
- Session management (create and resume)
- Permission bypass (auto-approves all tools with `--yolo`)
- Text deduplication (handles both delta and aggregated text)
- Token usage tracking
- Self-test mode
- Signal handling (SIGINT/SIGTERM)

### Tool Name Mappings

| Gemini CLI Tool | Standard Name |
|----------------|--------------|
| `write_file` | `Write` |
| `read_file` | `Read` |
| `edit_file` | `Edit` |
| `run_shell_command` | `Bash` |
| `list_directory` | `LS` |
| `glob` | `Glob` |
| `grep` | `Grep` |

## Output Format

The shim outputs JSONL (JSON Lines) to stdout:

```jsonl
{"type":"system","subtype":"init","session_id":"...","cwd":"...","tools":[...],"model":"...","permissionMode":"bypassPermissions","apiKeySource":"GOOGLE_API_KEY","mcp_servers":[]}
{"type":"assistant","message":{"id":"msg_...","type":"message","role":"assistant","model":"...","content":[{"type":"text","text":"..."}],"stop_reason":"end_turn"}}
{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"num_turns":1,"result":"...","session_id":"...","usage":{...}}
```

## Environment Variables

- `GOOGLE_API_KEY` or `GEMINI_API_KEY` - API key for Gemini (required)
- `MODEL` - Default model if not specified via `--model`

## Testing

Run the eval suite:

```bash
cd ../eval-suite
bun run src/cli.ts --shim "../shim/dist/index.mjs" --model gemini-2.5-flash
```

### Test Results

**17/17 tests passing (100% pass rate)** ✅

All tests from the eval suite pass successfully. The shim correctly handles:
- Simple and multi-turn conversations
- Tool operations (Read, Write, Edit, Bash, etc.)
- Session management (creation and resumption)
- Error handling (invalid sessions, API errors)
- Signal handling (SIGINT, SIGTERM)
- Edge cases (empty prompts, large files, unicode)

## Architecture

### Components

- `src/index.ts` - Entry point, argument parsing, main flow
- `src/shim.ts` - Core shim logic, event translation
- `src/agent/gemini.ts` - Gemini CLI process management
- `src/utils/args.ts` - Argument parsing and model resolution
- `src/utils/ids.ts` - ID generation (UUIDs, msg_*, toolu_*)
- `src/utils/tools.ts` - Tool name normalization and input transformation
- `src/types.ts` - TypeScript type definitions

### Event Flow

```
┌─────────────┐
│ Orchestrator│
└──────┬──────┘
       │ spawn + stdin
       ▼
┌─────────────────┐
│   Shim Process  │
│                 │
│  1. Parse args  │
│  2. Read stdin  │
│  3. Spawn gemini│
│  4. Translate   │
│     events      │
│  5. Emit JSONL  │
└────────┬────────┘
         │ stdout (JSONL)
         ▼
┌─────────────────┐
│  Orchestrator   │
└─────────────────┘
```

### Event Translation

| Gemini CLI Event | Shim Output |
|-----------------|-------------|
| `{type: "init", session_id, model}` | System init message (first) |
| `{type: "message", role: "assistant", content, delta}` | Assistant message (text content) |
| `{type: "tool_use", tool_name, tool_id, parameters}` | Assistant message (tool_use content) |
| `{type: "tool_result", tool_id, status, output}` | User message (tool_result content) |
| `{type: "result", status, stats}` | Result message (last) |

## Development

### Building

```bash
bun run build
```

### Running Tests

```bash
# Self-test
./dist/index.mjs --self-test

# Simple test
echo "What is 2+2?" | ./dist/index.mjs --model flash

# Tool test
echo "List files in current directory" | ./dist/index.mjs --model flash

# With verbose logging
echo "Test prompt" | ./dist/index.mjs --model flash --verbose 2>debug.log
```

### Debugging

Enable verbose mode to see:
- Gemini CLI spawn arguments
- Raw Gemini CLI stderr output
- Parsed Gemini CLI events
- Emitted shim messages

```bash
./dist/index.mjs --model flash --verbose < prompt.txt 2>debug.log
```

## License

MIT

## Contributing

This shim follows the standardized shim specification. When making changes:

1. Ensure all output goes to stdout as valid JSONL
2. Diagnostic output goes to stderr only
3. First message must be system init
4. Last message must be result
5. Flush stdout before exit
6. Tool use IDs must match tool result IDs
7. Test with the eval suite

## Troubleshooting

### "Gemini CLI not found"
Install Gemini CLI from https://geminicli.com/docs/

### "No API key found"
Set `GOOGLE_API_KEY` or `GEMINI_API_KEY` environment variable

### "Invalid session ID"
The session might have expired or doesn't exist. Use `--list-sessions` with Gemini CLI directly to see available sessions.

### Tool operations return empty content
This is expected - Gemini CLI doesn't return file contents in tool results. The agent reports relevant information in its text responses.

## References

- [Gemini CLI Documentation](https://geminicli.com/docs/)
- [Shim Specification](../shim-spec-v2/spec.md)
- [Eval Suite](../eval-suite/)
