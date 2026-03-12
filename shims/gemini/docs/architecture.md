# Architecture

## High-level flow

1. Read stdin until EOF and trim it
2. Resolve the requested model into:
   - Gemini CLI input model
   - normalized public shim output model
3. Spawn `gemini --output-format stream-json --approval-mode yolo`
4. Wait for Gemini `init`
5. Emit shim `system.init`
6. Translate Gemini events into shim JSONL messages
7. Optionally consult Gemini native session files for richer tool result content and per-model usage
8. Emit shim `result` last and flush stdout

## Why the shim uses subprocess integration

This package intentionally wraps the installed Gemini CLI instead of embedding deeper Gemini internals. That keeps runtime behavior aligned with the user's actual local Gemini installation and authentication state.

## Event translation

Gemini `stream-json` events observed in practice:

- `init`
- `message`
- `tool_use`
- `tool_result`
- `error`
- `result`

These are translated to the shim protocol as follows:

| Gemini event | Shim output |
| --- | --- |
| `init` | `system.init` |
| assistant `message` | `assistant` text block |
| `tool_use` | `assistant` tool_use block |
| `tool_result` | `user` tool_result block |
| `error` | synthetic `assistant` error message |
| `result` | final `result` |

## Tool normalization

Gemini-native tool names are normalized to standard shim names when possible:

- `read_file` -> `Read`
- `write_file` -> `Write`
- `replace` -> `Edit`
- `run_shell_command` -> `Bash`
- `glob` -> `Glob`
- `search_file_content` -> `Grep`
- `list_directory` -> `LS`

Unknown Gemini tool names are passed through unchanged.

The shim also converts top-level tool input keys from camelCase to snake_case and maps common Gemini parameter shapes into the standard shim tool schema.

## Public tool IDs

Gemini-native tool call ids are not public shim ids. The shim generates protocol-valid `toolu_*` ids and keeps a native-to-public mapping internally.

If Gemini ever emits a `tool_result` before the corresponding `tool_use`, the shim buffers the result until the tool use has been emitted.

## Tool result enrichment from Gemini session files

A core implementation detail: Gemini `stream-json` sometimes emits empty or poor `tool_result.output` values.

To avoid empty tool results, the shim checks Gemini's native session file under `~/.gemini/tmp/.../chats/` and backfills richer content from the recorded tool call result when needed.

This is especially important for:

- file reads
- file writes
- edits with diff metadata

## Timeout strategy

The shim uses adaptive timeouts:

- baseline idle timeout from `--idle-timeout` (default `120s`)
- longer busy-step stall timeout (`max(idleTimeout, 300s)`) after assistant/tool activity starts

Because Gemini `stream-json` is fairly sparse, the busy/idle split matters more than raw event count. Assistant deltas and tool events both reset the timer.

## Built-in reliability heuristics

The shim contains bounded workarounds for three real Gemini CLI failure modes observed during validation:

### 1. Silent success retry

If Gemini returns `result.success` without assistant text, tool use, or tool results, the shim resumes the **same** Gemini session once with a continuation prompt instead of reporting a misleading success.

### 2. Numbered-task completion check

If the original prompt contained a numbered list and Gemini appears to stop after only part of the requested work, the shim sends one follow-up turn asking Gemini to re-check and finish remaining numbered steps.

### 3. Invalid JSON repair

The shim tracks JSON files written or edited during the run. Before reporting success, it parses those on-disk files. If any are invalid JSON, the shim resumes the same session with a repair prompt and allows up to two bounded repair attempts.

## Debug artifacts

The shim writes debug artifacts only when `--debug-dir` is provided. Before the Gemini session id is known, raw data is buffered in memory. After `init`, the shim binds that buffered data to session-specific debug files.

## Session model

The shim uses Gemini's native session UUID directly as the public shim `session_id`.

That means:

- new sessions use the Gemini-generated UUID from `init`
- resumed sessions reuse the same UUID
- the shim does not create its own custom session database in the project directory

## Cross-platform runtime behavior

- uses `shell: true` on Windows when spawning CLIs
- uses `where` instead of `which` on Windows
- uses `path.join` / `path.resolve` for filesystem paths

## Packaging model

This shim package is rebuildable in isolation:

- root `index.js` is the Hankweave drop-in bundle
- `dist/index.js` is the normal build output
- `common/` vendors `@shims/common`
- `rebuild.sh` restores the root bundle from source
