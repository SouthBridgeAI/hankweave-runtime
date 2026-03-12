# opencode-shim

A self-contained Hankweave shim package for the OpenCode CLI.

This package wraps `opencode run --format json` and translates OpenCode events into the shim JSONL protocol expected by Hankweave and the eval suite.

## What this package contains

- `index.js` — drop-in compiled bundle for Hankweave
- `dist/index.js` — normal build output
- `src/` — shim source
- `common/` — vendored `@shims/common`
- `docs/` — usage, architecture, and validation notes
- `rebuild.sh` — reinstalls deps, rebuilds, refreshes `VERSION`, and updates `index.js`

## Quick start

```bash
cd shim
./rebuild.sh

echo "Say hello" | bun ./index.js --model google/gemini-2.5-flash
```

## Requirements

- Bun
- Node.js
- OpenCode CLI available on PATH, or `OPENCODE_BIN` pointing to the executable
- Provider auth available to OpenCode, typically via environment variables such as:
  - `GOOGLE_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `OPENAI_API_KEY`

## Common commands

### Rebuild the package

```bash
./rebuild.sh
```

### Run the shim

```bash
echo "Summarize this repository" | bun ./index.js --model google/gemini-2.5-flash
```

### Run self-test

```bash
bun ./index.js --self-test
```

### Run tests

```bash
bun test
bun run typecheck
```

## Key behavior

- Emits spec-compliant JSONL with `system` first and `result` last
- Uses OpenCode native sessions by title when `--debug-dir` is not provided
- Stores shim-managed session mappings only under `<debug-dir>/sessions/` when `--debug-dir` is provided
- Forces headless permissions via `OPENCODE_CONFIG_CONTENT` without writing `opencode.json` into the workspace
- Normalizes tool names and emits public `toolu_*` IDs instead of leaking native OpenCode `callID` values
- Uses adaptive timeouts with a longer busy-step timeout than pre-work idle timeout
- Requires a terminal OpenCode `step_finish` with `reason: "stop"` before reporting success
- Includes Gemini/OpenCode retry hardening for empty cached responses and stale-workspace tool paths
- Accepts `--sandbox`, but OpenCode `run` mode currently has no documented equivalent sandbox flag, so non-`none` values are logged and otherwise ignored

## Documentation

- `docs/USAGE.md` — CLI usage and behavior
- `docs/ARCHITECTURE.md` — code layout and event flow
- `docs/VALIDATION.md` — test and eval results

## Packaging notes

This is a thin subprocess shim. It does **not** bundle the OpenCode CLI itself. The generated `VERSION` file therefore contains `n/a`.
