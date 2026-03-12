# codex-shim

A self-contained Hankweave shim for OpenAI Codex built on `@openai/codex-sdk`.

The directory is packaged so it can be:
- dropped directly into Hankweave with `index.js` at the root
- rebuilt independently with `./rebuild.sh`

## Directory layout

```text
shim/
├── index.js          # drop-in bundle used by Hankweave
├── dist/index.js     # build output
├── src/              # shim source
├── common/           # vendored @shims/common
├── docs/             # usage, architecture, and verification notes
├── rebuild.sh        # reinstall + rebuild helper
├── VERSION           # resolved primary SDK version
└── THIRDPARTY.md     # third-party notices
```

## Requirements

- Node.js 18+
- Bun 1.1+
- Codex CLI available either on `PATH` or via `CODEX_PATH_OVERRIDE`
- Authentication configured via one of:
  - `OPENAI_API_KEY`
  - `CODEX_API_KEY`
  - `~/.codex/auth.json`

## Quick start

```bash
cd shim
./rebuild.sh

echo "Say hello" | node ./index.js --model gpt-5.1-codex-max
```

## Common usage

Basic prompt:

```bash
echo "Summarize this repository" | node ./index.js --model gpt-5.1-codex-max
```

Resume a previous shim session:

```bash
echo "Continue" | node ./index.js --model gpt-5.1-codex-max --resume <session_uuid>
```

Capture raw debug artifacts:

```bash
echo "Inspect app startup" | node ./index.js \
  --model gpt-5.1-codex-max \
  --debug-dir ./debug-run
```

Run the environment self-test:

```bash
node ./index.js --self-test
```

## Supported flags

- `--model <model>`
- `--resume <session_id>`
- `--verbose`
- `--append-system-prompt <text>`
- `--idle-timeout <seconds>`
- `--debug-dir <path>`
- `--sandbox <none|standard|strict>`
- `--self-test`
- `--version`
- `--help`

## Model handling

The shim preserves the public model string in output while mapping it into Codex SDK options.

Examples:
- `gpt-5.1-codex-max` → used directly
- `openai/gpt-5.2-high` → public output stays prefixed, SDK model becomes `gpt-5.2`, reasoning effort becomes `high`
- `gpt-5.2-xhigh` → SDK model `gpt-5.2`, reasoning effort `xhigh`

## Tool normalization

Codex often reports file work as shell commands. The shim normalizes common patterns into structured shim tools:

- `cat file.txt` → `Read`
- `ls ...` → `LS`
- `rg ...` / `grep ...` → `Grep`
- `find ...` / `fd ...` → `Glob`
- `printf '...' > file.txt` → `Write`
- heredoc file writes → `Write`
- unknown shell commands → `Bash`
- Codex web tooling may surface as `WebSearch`, `WebFetch`, or passthrough MCP tool names

## Session storage

- With `--debug-dir`, shim session mappings are stored in `<debug-dir>/sessions/`
- Without `--debug-dir`, mappings are stored outside the project tree in `~/.shim/sessions/`

This preserves resume support without creating unexpected files in the workspace.

## More documentation

- `docs/usage.md`
- `docs/architecture.md`
- `docs/verification.md`

## Rebuild

```bash
./rebuild.sh
```

`rebuild.sh`:
1. runs `bun install`
2. runs `bun run build`
3. updates `VERSION`
4. ensures `dist/index.js` has a Node shebang and executable bit
5. copies `dist/index.js` to root `index.js`
