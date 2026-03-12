# gemini-cli-shim

A self-contained shim package that wraps a locally installed `gemini` CLI and translates its `stream-json` output into the Hankweave shim JSONL protocol.

## What this package contains

- `index.js` — drop-in compiled bundle for Hankweave
- `dist/index.js` — normal build output
- `src/` — shim source
- `common/` — vendored `@shims/common`
- `docs/` — usage, architecture, validation, and research notes
- `rebuild.sh` — reinstalls deps, rebuilds, refreshes `VERSION`, and copies the drop-in bundle

## Requirements

- Gemini CLI installed and available on `PATH` as `gemini`
- Gemini CLI already authenticated
- Bun available for rebuilds (`bun install`, `bun run build`)

## Quick start

```bash
echo "Say hello" | ./index.js --model gemini-2.5-flash
```

Resume a prior Gemini-native session:

```bash
echo "What did I ask earlier?" | ./index.js --model google/gemini-2.5-pro --resume <session-uuid>
```

Run the environment check:

```bash
./index.js --self-test
```

Rebuild the package:

```bash
./rebuild.sh
```

## Documentation

- `docs/usage.md` — installation assumptions, CLI flags, examples, debug mode
- `docs/architecture.md` — event translation, retries, JSON repair, session handling
- `docs/verification.md` — eval-suite and shim-local validation notes
- `docs/research.md` — implementation research summary
- `docs/implementation-notes.md` — working notes, edge cases, and issue log

## Notes

- The shim uses Gemini's native session UUIDs as shim session IDs.
- Raw debug files are only written when `--debug-dir` is provided.
- The shim includes bounded follow-up turns for three observed Gemini CLI failure modes:
  - silent success with no assistant/tool activity
  - early exit during numbered workflows
  - invalid JSON files left on disk after a nominally successful turn
