# Architecture

1. Read stdin until EOF. Empty stdin exits 0 with no output.
2. Emit shim `system.init` first (`permissionMode: bypassPermissions`, standard tool names).
3. Spawn `agent -p --trust --force --sandbox disabled --output-format stream-json --workspace "$PWD" --model ...`.
4. Drop Cursor `thinking` events and the echoed `user` prompt.
5. Translate `assistant` text, `tool_call` started/completed, and `result`.
6. Emit shim `result` last. If the process ends without one, emit a synthetic result.

## Tool keys observed on CLI 2026.10.16-e3cb207

| Cursor key | Shim name |
| --- | --- |
| `shellToolCall` | `Bash` |
| `readToolCall` | `Read` |
| `editToolCall` creating a file (`diffString` contains `/dev/null`, or `streamContent` with no old string) | `Write` |
| `editToolCall` otherwise | `Edit` |
| `grepToolCall`, `searchToolCall` | `Grep` |
| `globToolCall` | `Glob` |
| `lsToolCall`, `listToolCall` | `LS` |

Native `tool_…` call ids are not public ids. The shim mints `toolu_*` ids. A `completed` event without a prior `started` still emits `tool_use` before `tool_result`.

## Sessions

Cursor `session_id` values are UUIDs. On resume the shim requires a session file written by an earlier run in the working directory or `--debug-dir`. Unknown ids exit 1 with `session not found` on stderr and no JSONL.
