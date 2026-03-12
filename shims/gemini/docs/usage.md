# Usage

## Preconditions

This shim is intentionally thin at runtime. It expects:

1. `gemini` to already be installed locally
2. Gemini authentication to already be configured
3. the caller to provide prompts via stdin

The shim does **not** bundle Gemini CLI itself.

## Basic invocation

```bash
echo "Say hello" | ./index.js --model gemini-2.5-flash
```

The shim always reads stdin, even if `-p` is omitted.

## Accepted model forms

The shim accepts several model spellings and normalizes public output to `google/...` form.

| Input | Gemini CLI receives | Shim output model |
| --- | --- | --- |
| `flash` | `gemini-2.5-flash` | `google/gemini-2.5-flash` |
| `pro` | `gemini-2.5-pro` | `google/gemini-2.5-pro` |
| `gemini-2.5-flash` | `gemini-2.5-flash` | `google/gemini-2.5-flash` |
| `google/gemini-2.5-pro` | `gemini-2.5-pro` | `google/gemini-2.5-pro` |

## Resume a session

The shim reuses Gemini-native UUID session IDs.

```bash
echo "What did I tell you earlier?" | ./index.js --model gemini-2.5-flash --resume 550e8400-e29b-41d4-a716-446655440000
```

If the session id is invalid, the shim exits with code `1` and prints the error to stderr without producing JSONL.

## CLI flags

| Flag | Description |
| --- | --- |
| `--model <model>` | Required by the shim contract; defaults to `MODEL` env var or `gemini-2.5-flash` |
| `--resume <uuid>` | Continue an existing Gemini-native session |
| `--verbose` | Write shim diagnostics and Gemini stderr to stderr |
| `--append-system-prompt <text>` | Append extra caller instructions after the shim's built-in internal guidance |
| `--idle-timeout <seconds>` | Baseline inactivity timeout before meaningful work starts; default `120` |
| `--debug-dir <path>` | Persist raw Gemini stdout/stderr artifacts in that directory |
| `--sandbox <level>` | `none`, `standard`, or `strict` |
| `--self-test` | Emit JSON environment diagnostics instead of running a prompt |
| `--version` | Print shim version |
| `--help` | Print help |

## Sandbox mapping

| Shim value | Gemini CLI behavior |
| --- | --- |
| `none` | `GEMINI_SANDBOX=false`; no `--sandbox` flag |
| `standard` | `--sandbox` |
| `strict` | `--sandbox` and `SEATBELT_PROFILE=restrictive-open` on macOS |

## Debug output

When `--debug-dir` is provided, the shim writes only inside that directory:

```text
<debug-dir>/
├── session-<uuid>.raw.jsonl
├── session-<uuid>.raw.log
└── session-unknown.raw.log   # only for failures before Gemini init
```

Without `--debug-dir`, the shim writes no debug artifacts of its own.

## Rebuilding the package

```bash
./rebuild.sh
```

This script:

1. runs `bun install`
2. runs `bun run build`
3. refreshes `VERSION`
4. ensures `dist/index.js` has a Node shebang and executable bit
5. copies `dist/index.js` to root `index.js`

## Self-test

```bash
./index.js --self-test
```

Example shape:

```json
{
  "shim": { "name": "gemini-cli-shim", "version": "0.1.0" },
  "agent": { "name": "gemini", "version": "0.27.0", "found": true },
  "checks": [
    { "name": "agent_found", "passed": true, "message": "..." },
    { "name": "auth_configured", "passed": true, "message": "..." }
  ],
  "overall": { "passed": true, "message": "All checks passed" }
}
```

## Additional shim behavior

To make Gemini CLI more reliable under eval-suite style workloads, the shim may transparently issue one or more bounded continuation turns on the **same** Gemini session when it detects:

1. a silent success turn with no assistant/tool activity
2. an apparently incomplete numbered workflow
3. invalid JSON files left on disk after a nominal success

These continuations are internal implementation details; the public session id remains the same.
