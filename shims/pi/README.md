# pi-shim

A self-contained shim package for the embedded Pi SDK (`@mariozechner/pi-coding-agent`).

- Architecture: **SDK-as-dependency**
- Execution model: **in-process**
- Output: **standard shim JSONL protocol**
- Drop-in entrypoint: `./index.js`
- Rebuild command: `./rebuild.sh`

## Quick start

```bash
echo "Say hello briefly" | node index.js --model anthropic/claude-haiku-4-5
```

## What this shim does

`pi-shim` translates Pi SDK session events into the shim protocol expected by Hankweave and the eval suite:

- emits `system` init first
- translates Pi assistant/tool events into shim `assistant` / `user` messages
- emits `result` last
- supports fresh and resumed sessions
- supports debug capture with `--debug-dir`
- uses adaptive timeouts so quiet in-progress turns do not false-timeout

## Authentication

This packaged shim is intentionally **environment-variable-first**.
It configures the embedded Pi SDK with runtime API keys from the current process environment.

Supported preflighted providers:

- `ANTHROPIC_API_KEY`
- `GOOGLE_API_KEY` or `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`

If a known provider is requested without a matching key, the shim fails before session init.

## Common commands

```bash
# Self-test
node index.js --self-test

# Save raw debug files
mkdir -p /tmp/pi-shim-debug
echo "Summarize this repo" | node index.js \
  --model anthropic/claude-haiku-4-5 \
  --debug-dir /tmp/pi-shim-debug

# Resume a previous session
node index.js --model anthropic/claude-haiku-4-5 --resume <session-uuid> < prompt.txt

# Rebuild after dependency changes
./rebuild.sh
```

## Documentation

- `docs/usage.md` — CLI usage, options, models, sessions, debug files
- `docs/architecture.md` — source layout and translation design
- `docs/rebuild.md` — packaging, rebuild, versioning, bundle layout
- `docs/validation.md` — local tests, eval guidance, known limitation notes

## Package layout

```text
shim/
├── index.js
├── dist/index.js
├── src/
├── common/
├── docs/
├── tests/
├── package.json
├── rebuild.sh
├── VERSION
└── THIRDPARTY.md
```

## Notable limitation

The embedded Pi SDK currently does not expose CLI-equivalent sandbox controls.
The shim accepts `--sandbox` for protocol compatibility, logs the request, and continues without additional SDK-level sandboxing.
