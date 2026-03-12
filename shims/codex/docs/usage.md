# Usage

## Basic invocation

The shim reads the prompt from stdin and emits a JSONL event stream to stdout.

```bash
echo "Say hello" | node ./index.js --model gpt-5.1-codex-max
```

If stdin is empty after trimming, the shim exits quietly with code `0` and emits no JSON.

## Required flag

- `--model <model>`

## Optional flags

| Flag | Description |
| --- | --- |
| `-p` | Accepted for compatibility; stdin is read either way |
| `--resume <session_id>` | Resume a prior public shim session UUID |
| `--verbose` | Send extra diagnostics to stderr |
| `--append-system-prompt <text>` | Append extra system instructions before the user request |
| `--idle-timeout <seconds>` | Baseline inactivity timeout, default `120` |
| `--debug-dir <path>` | Write raw debug artifacts and session mappings under this directory |
| `--sandbox <none|standard|strict>` | Map shim sandbox levels to Codex sandbox modes |
| `--self-test` | Print environment verification JSON and exit |
| `--version` | Print shim version |
| `--help` | Print CLI help |

## Environment

### Codex binary discovery

The shim passes `CODEX_PATH_OVERRIDE` through to the SDK. If unset, it falls back to `codex` on `PATH`.

### Authentication

The shim accepts any of these auth sources:
- `OPENAI_API_KEY`
- `CODEX_API_KEY`
- `~/.codex/auth.json`

## Model examples

```bash
# direct model
echo "hi" | node ./index.js --model gpt-5.1-codex-max

# provider-prefixed public model string
echo "hi" | node ./index.js --model openai/gpt-5.2-high

# reasoning-effort suffix parsed by the shim
echo "hi" | node ./index.js --model gpt-5.2-xhigh
```

Reasoning suffixes currently parsed by the shim:
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

## Sandbox mapping

| Shim flag | Codex SDK option |
| --- | --- |
| `--sandbox none` | `danger-full-access` |
| `--sandbox standard` | `workspace-write` |
| `--sandbox strict` | `read-only` |

## Debug output

When `--debug-dir` is set, the shim writes files like:

```text
<debug-dir>/
├── session-<uuid>.raw.jsonl
├── session-<uuid>.raw.log
└── sessions/<uuid>.json
```

Without `--debug-dir`, debug files are not written in the project tree.

## Self-test output

```bash
node ./index.js --self-test
```

This verifies:
1. the `codex` binary can be found
2. authentication is configured
3. the agent version can be queried
