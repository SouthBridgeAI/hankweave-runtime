# Architecture

## High-level flow

1. `src/index.ts` parses CLI args and reads stdin
2. `src/shim.ts` resolves model/session state and emits the `system` init message
3. `src/agent/opencode.ts` spawns:

   ```bash
   opencode run --format json --model <model> --dir <cwd>
   ```

4. OpenCode JSON events are parsed and wrapped with adaptive timeout handling
5. OpenCode events are translated into shim JSONL messages
6. The shim emits a final `result` message and flushes stdout

## Source layout

```text
src/
├── agent/
│   └── opencode.ts       # OpenCode process spawning, session lookup, adaptive timeout wiring
├── utils/
│   ├── ids.ts            # UUID/msg/toolu ID generation and validation helpers
│   ├── models.ts         # model resolution and API-key source detection
│   ├── output.ts         # JSONL emit, stdout flush, stderr logging helpers
│   ├── prompt.ts         # internal instruction file construction
│   └── tools.ts          # tool-name, tool-input, and tool-result normalization
├── index.ts              # CLI entrypoint
├── selftest.ts           # --self-test implementation
├── shim.ts               # orchestration, retries, translation, final result handling
└── types.ts              # OpenCode event and summary types
```

## Vendored common package

`common/` is a vendored copy of `packages/common/` from the source workspace. The shim depends on it via:

```json
"@shims/common": "file:./common"
```

This removes the workspace dependency so the package can rebuild independently.

## Event translation model

OpenCode emits JSON events such as:

- `step_start`
- `text`
- `reasoning`
- `tool_use`
- `step_finish`
- `error`

The shim turns these into the public protocol:

- `system` — exactly once, first
- `assistant` — text, thinking, and tool_use blocks
- `user` — tool_result blocks
- `result` — exactly once, last

## Tool translation rules

### Public IDs

OpenCode native `callID` values are not guaranteed to match shim protocol requirements, so the shim generates public `toolu_*` IDs and keeps a native-to-public mapping internally.

### Tool names

Known OpenCode tool names are normalized to standard names:

- `read` → `Read`
- `write` → `Write`
- `edit` / `str_replace_editor` → `Edit`
- `bash` / `shell` → `Bash`
- `glob` / `find_files` → `Glob`
- `grep` / `search_files` → `Grep`
- `ls` / `list_directory` → `LS`

### Tool inputs

Top-level input keys are converted from camelCase to snake_case.

### Tool results

OpenCode sometimes returns empty tool output, especially for bash. The shim synthesizes meaningful content such as:

- `Command completed successfully with no output.`
- `File written: <path>`
- structured error objects for failures

## Session strategy

### Without `--debug-dir`

- no shim-managed session files are created
- fresh runs use `--title <public_uuid>`
- resume works by resolving the native `ses_*` session through `opencode session list`

### With `--debug-dir`

- raw logs are written under the debug directory
- a session mapping is also persisted under `<debug-dir>/sessions/`

## Timeout strategy

The event stream is wrapped with `withAdaptiveTimeout()` from `@shims/common`.

Observed OpenCode behavior can include long quiet periods inside a busy step, so the shim distinguishes between:

- idle timeout before meaningful work or between settled steps
- busy-step stall timeout after `step_start`

Every parsed JSON event resets the timer, including non-lifecycle events such as `reasoning` or `retry`.

## Retry strategy

For fresh Gemini runs only, the shim may discard and retry hidden attempts when it detects:

- empty cached responses
- stale absolute paths outside the current workspace

Only the final accepted attempt is emitted on the public JSONL stream.

## Success criteria enforcement

The shim only reports success when either:

- the run was intentionally interrupted, or
- OpenCode emitted a terminal `step_finish` with `reason: "stop"`

A subprocess that exits `0` without that terminal stop signal is treated as an error.
