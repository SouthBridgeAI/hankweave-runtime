# Architecture

## Overview

This shim embeds the Pi SDK directly instead of spawning the `pi` CLI as a subprocess.

That design keeps translation simple:

1. create a Pi `AgentSession`
2. subscribe to Pi `AgentSessionEvent`s
3. translate them into shim JSONL messages
4. emit normalized `system`, `assistant`, `user`, and `result` messages

## Source layout

```text
src/
├── index.ts           # CLI entrypoint and runtime/error orchestration
├── pi-agent.ts        # Pi session creation and event consumption
├── translator.ts      # Pi → shim message translation helpers
├── provider-auth.ts   # environment-driven auth wiring for embedded Pi
├── debug-recorder.ts  # raw event/raw log capture for --debug-dir
├── watchdog.ts        # async event queue + adaptive timeout hooks
└── metadata.ts        # shim constants
```

## Event translation flow

### Session init

`preparePiSession()`:

- resolves the requested model
- validates known-provider API key presence
- creates or opens the Pi session manager
- disables Pi extensions/skills/prompt templates/themes for deterministic shim behavior
- creates the Pi `AgentSession`

`index.ts` then emits the public shim `system` init message.

### Assistant output

The shim emits assistant messages from Pi `message_end` events for assistant-role messages.

Pi content block types are normalized as follows:

| Pi block | Shim block |
|---|---|
| `text` | `text` |
| `thinking` | `thinking` |
| `toolCall` | `tool_use` |

Tool names are normalized to the standard shim tool names:

- `read` → `Read`
- `write` → `Write`
- `edit` → `Edit`
- `bash` → `Bash`
- `find` → `Glob`
- `grep` → `Grep`
- `ls` → `LS`

Top-level tool input keys are normalized to snake_case, with `path` / `filePath` mapped to `file_path`.

## Tool ordering and ID mapping

Pi-native tool IDs are kept internal.
The shim maintains a native-ID → public-ID map so that public output always uses shim-protocol-valid IDs.

Ordering is preserved by:

- emitting tool uses from assistant `message_end`
- emitting tool results from `turn_end.toolResults`

That guarantees `tool_use` appears before the corresponding `tool_result` in the public stream.

## Timeout design

The shim uses `withAdaptiveTimeout()` from vendored `@shims/common`.

### Activity signals

The watchdog treats these Pi events as liveness signals:

- `agent_start`
- `turn_start`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `turn_end`
- `agent_end`
- retry/compaction lifecycle events

### Busy vs idle

- `turn_start` marks the stream busy
- `turn_end` and `agent_end` return it to idle
- busy timeout is widened to at least 300 seconds

This is important because Pi can legitimately go quiet for a while inside an active turn.

## Session persistence policy

- without `--debug-dir`: use Pi native session storage
- with `--debug-dir`: use `<debug-dir>/sessions/`

The shim does not invent an extra working-directory session store.

## Debug capture

Debug capture is explicitly opt-in through `--debug-dir`.

When enabled, the shim records:

- raw Pi events (`*.raw.jsonl`)
- shim log lines (`*.raw.log`)
- Pi session files under `sessions/`

No debug files are created when `--debug-dir` is absent.

## Sandbox behavior

The shim accepts `--sandbox` because the shim protocol requires it.
The embedded Pi SDK currently does not expose equivalent runtime sandbox controls, so the request is logged and otherwise treated as advisory.
