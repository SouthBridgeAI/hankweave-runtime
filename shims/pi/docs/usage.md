# Usage

## Basic invocation

```bash
echo "Say hello" | node index.js --model anthropic/claude-haiku-4-5
```

The shim always reads stdin. If stdin is empty after trimming, it exits silently with code `0`.

## CLI options

| Option | Description |
|---|---|
| `--model <model>` | Required model identifier unless `MODEL` is set in the environment |
| `--resume <session_id>` | Resume an existing Pi session by UUID |
| `--verbose` | Mirror debug log lines to stderr |
| `--append-system-prompt <text>` | Append extra system instructions |
| `--debug-dir <path>` | Write raw Pi events, raw log output, and resumed sessions under this directory |
| `--idle-timeout <seconds>` | Baseline idle timeout, default `120` |
| `--sandbox <none\|standard\|strict>` | Accepted for compatibility; currently advisory only in embedded mode |
| `--self-test` | Print a JSON environment report and exit |
| `--version` | Print shim version and exit |
| `--help` | Print help and exit |

Unknown arguments are ignored for forward compatibility.

## Model formats

The shim accepts:

- full provider/model IDs, for example `anthropic/claude-sonnet-4-5`
- short names:
  - `haiku` → `anthropic/claude-haiku-4-5`
  - `sonnet` → `anthropic/claude-sonnet-4-5`
  - `opus` → `anthropic/claude-opus-4-5`
- bare IDs with provider inference:
  - `claude-*` → `anthropic/...`
  - `gemini-*` → `google/...`
  - `gpt-*`, `o1*`, `o3*` → `openai/...`

If `--model` is omitted, the shim falls back to `MODEL` from the environment.

## Authentication model

This packaged shim injects runtime API keys into the embedded Pi SDK from environment variables.

### Known provider env vars

| Provider | Environment variables |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Google | `GOOGLE_API_KEY`, `GEMINI_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

For known providers, missing credentials are treated as startup errors and the shim exits before emitting JSONL.

## Sessions

### Fresh sessions

Without `--resume`, the shim creates a fresh Pi session.

- default persistence: Pi native session storage
- with `--debug-dir`: sessions are stored under `<debug-dir>/sessions/`

### Resume

```bash
node index.js --model anthropic/claude-haiku-4-5 --resume 550e8400-e29b-41d4-a716-446655440000 < prompt.txt
```

The public shim `session_id` is the Pi session UUID itself.

Invalid resume IDs fail before init with stderr-only output.

## Debug files

When `--debug-dir` is supplied, the shim writes:

```text
<debug-dir>/
├── session-<uuid>.raw.jsonl
├── session-<uuid>.raw.log
└── sessions/
```

### File meanings

- `session-<uuid>.raw.jsonl` — raw Pi events plus synthetic init/result debug entries
- `session-<uuid>.raw.log` — verbose/internal shim log lines
- `sessions/` — Pi session persistence when debug-dir-backed sessions are used

Without `--debug-dir`, the shim writes no debug files.

## Timeout behavior

The shim uses adaptive timeout handling.

- idle timeout: `--idle-timeout` seconds
- busy-turn timeout: `max(idle-timeout, 300s)`
- `turn_start` marks the stream busy
- `turn_end` / `agent_end` return the stream to idle
- lifecycle and streaming events reset the watchdog timer

This avoids false idle timeouts while Pi is in a legitimate in-progress turn with sparse output.

### Explicit silence conflict detection

If `--append-system-prompt` explicitly instructs the model to remain silent longer than the configured idle timeout, the shim fails fast with a timeout-style runtime error instead of starting a run that already violates the timeout budget.

## Self-test

```bash
node index.js --self-test
```

The self-test reports:

- shim name/version
- whether the Pi SDK loaded successfully
- whether at least one supported provider key is configured
- which models are currently resolvable through the embedded Pi model registry

## Output contract notes

The shim emits JSONL on stdout only.

Ordering is:

1. `system` init
2. zero or more `assistant` / `user` messages
3. final `result`

Errors after init produce:

1. `system`
2. synthetic `assistant` error
3. `result` with `is_error: true`
