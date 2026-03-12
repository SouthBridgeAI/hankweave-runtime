# Usage

## Basic invocation

The shim always reads its prompt from stdin.

```bash
echo "Say hello" | bun ./index.js --model google/gemini-2.5-flash
```

If stdin is empty after trimming, the shim exits silently with code `0`.

## CLI options

### Required in normal mode

- `--model <model>`

The shim also honors `MODEL` as a fallback.

### Optional

- `--resume <session_id>` — resume a previous public shim session UUID
- `--verbose` — write diagnostic logs to stderr
- `--append-system-prompt <text>` — append extra OpenCode instruction content
- `--idle-timeout <seconds>` — baseline idle timeout, default `120`
- `--debug-dir <path>` — enable on-disk debug logs and shim-managed session mapping
- `--sandbox <none|standard|strict>` — accepted for spec compatibility; currently a documented no-op in OpenCode `run` mode
- `--self-test` — run environment checks and emit JSON
- `--version`
- `--help`

Unknown flags are ignored for forward compatibility.

## Model resolution

Accepted model forms:

- shortnames such as `flash`, `sonnet`, `haiku`
- provider/model such as `google/gemini-2.5-flash`
- full model IDs such as `claude-sonnet-4-20250514`

Examples:

```bash
echo "Hi" | bun ./index.js --model flash
echo "Hi" | bun ./index.js --model google/gemini-2.5-flash
echo "Hi" | bun ./index.js --model claude-sonnet-4-20250514
```

## Session behavior

### Fresh sessions

Fresh runs generate a public UUID session ID and start an OpenCode session titled with that UUID.

### Resume without `--debug-dir`

When `--debug-dir` is not provided, the shim does **not** create its own session store. Instead it resolves the native OpenCode session by scanning `opencode session list` for the public UUID title.

### Resume with `--debug-dir`

When `--debug-dir` is provided, the shim also stores a session mapping in:

```text
<debug-dir>/sessions/<public_uuid>.json
```

This makes resume deterministic even if OpenCode session-list output changes.

## Debug artifacts

No debug files are written unless `--debug-dir` is provided.

With `--debug-dir /tmp/opencode-shim-debug`, the shim writes files like:

```text
/tmp/opencode-shim-debug/
├── session-<uuid>.raw.jsonl
├── session-<uuid>.raw.log
└── sessions/
    └── <uuid>.json
```

Contents:

- `session-<uuid>.raw.jsonl` — raw parsed OpenCode stdout events plus shim lifecycle records
- `session-<uuid>.raw.log` — captured stderr and shim retry notes
- `sessions/<uuid>.json` — public UUID to native OpenCode session mapping

## Permissions and config injection

The shim uses `OPENCODE_CONFIG_CONTENT` to inject headless runtime config instead of modifying the workspace:

- `permission: "allow"`
- temporary instruction file content

This avoids leaving `opencode.json` behind in the user project.

## Additional instruction injection

`--append-system-prompt` is implemented by appending caller text to a temporary OpenCode instruction file. The shim also injects a small internal instruction set that:

- keeps the run headless
- encourages completion of all explicit user-requested steps
- discourages partial multi-step completion
- constrains file operations to the current working directory unless the prompt explicitly asks otherwise

## Timeouts

The shim uses adaptive timeout behavior:

- **Idle timeout**: before work starts, or when the run is otherwise idle
- **Busy-step timeout**: after `step_start`, a longer timeout is used

For OpenCode the busy timeout is computed as:

```text
max(300s, min(900s, idle_timeout * 5))
```

So the default `--idle-timeout 120` yields a `600s` busy-step timeout.

## Gemini/OpenCode hardening

On fresh Gemini runs, the shim retries hidden attempts when it detects either of these cases:

- empty cached response with zero output tokens
- stale absolute workspace paths outside the current cwd

Discarded retry sessions are deleted from OpenCode native storage so they do not accumulate under the public UUID title.

## Self-test

```bash
bun ./index.js --self-test
```

This checks:

- whether OpenCode is installed
- whether its version can be queried
- whether `opencode models google` works
- whether common provider API keys appear to be present in the environment

## Environment variables

### Used directly by the shim

- `OPENCODE_BIN` — override the OpenCode executable path
- `MODEL` — fallback model when `--model` is omitted

### Common provider auth passthrough

- `GOOGLE_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- others supported by OpenCode

## Exit behavior

- Exit `0` on success
- Exit `1` on startup/configuration errors
- Exit `1` with JSONL `system → synthetic assistant error → result` for runtime failures after initialization
