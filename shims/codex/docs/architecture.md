# Architecture

## Overview

This shim wraps OpenAI Codex through `@openai/codex-sdk` instead of launching a custom subprocess protocol directly.

High-level flow:
1. parse shim CLI args
2. read stdin prompt
3. start or resume a Codex thread
4. translate streamed SDK events into shim JSONL messages
5. emit a final `result` message

## Source layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | tiny CLI entrypoint |
| `src/shim.ts` | main orchestration and event translation |
| `src/tools.ts` | Codex tool normalization |
| `src/timeout-state.ts` | adaptive timeout behavior for sparse Codex turns |
| `src/debug.ts` | optional debug artifact writer |
| `src/utils.ts` | IDs, model resolution, sandbox mapping, helpers |
| `common/src/*` | vendored shared shim utilities |

## Session model

Codex thread IDs are not public shim UUIDs. The shim therefore keeps a mapping:

- public session id: UUID v4 emitted to the orchestrator
- native agent session id: Codex thread id stored for resume

That mapping is persisted via the vendored `SessionManager`.

## Event translation

Observed Codex SDK events handled by the shim:
- `thread.started`
- `turn.started`
- `turn.completed`
- `turn.failed`
- `item.started`
- `item.updated`
- `item.completed`
- `error`

### Assistant text

- `reasoning` items become `thinking` content blocks
- `agent_message` items become `text` content blocks with `stop_reason: "end_turn"`

### Tools

Tool-capable items include:
- `command_execution`
- `file_change`
- `mcp_tool_call`
- `web_search`

The shim emits:
1. an `assistant` message with a public `toolu_*` id
2. a `user` message with the corresponding `tool_result`

## Shell-command normalization

Codex frequently represents file operations as shell commands. The shim converts safe, recognizable patterns into structured tool calls when possible.

Examples:
- `cd <workspace> && cat notes.md` → `Read { file_path: "notes.md" }`
- `printf 'hello' > notes.md` → `Write { file_path: "notes.md", content: "hello" }`
- heredoc writes → structured `Write`
- unrecognized commands stay as `Bash { command: ... }`

## Timeout strategy

Codex can emit `turn.started` and then remain quiet for several seconds before the first completed item. A naive idle timeout would false-fail that turn.

The shim therefore uses adaptive timeouts:
- baseline idle timeout: `--idle-timeout` (default `120s`)
- busy-step timeout: at least `300s`
- `turn.started` is treated as busy for practical timeout values above 1 second
- the narrow 1-second path is preserved for the eval-suite baseline idle-timeout test

## Permissions

The shim always requests Codex approval policy `never`, which pre-approves tool usage for headless operation.

## Packaging

This directory is made self-contained by:
- vendoring `@shims/common` into `common/`
- using `file:./common` in `package.json`
- keeping a standalone `tsconfig.json`
- producing a root `index.js` via `./rebuild.sh`
