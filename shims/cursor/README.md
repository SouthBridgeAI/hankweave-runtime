# cursor-agent-shim

A Hankweave shim that wraps the Cursor Agent CLI (`agent`) and translates its `stream-json` print output into the shim JSONL protocol.

## Requirements

- Cursor Agent CLI on `PATH` as `agent`, or `CURSOR_AGENT_BIN`
- A logged-in `agent` session, or `CURSOR_API_KEY`
- Bun, to rebuild

## Quick start

```bash
./rebuild.sh
echo "Say hello" | ./index.js --model composer-2.5-fast
```

```bash
./index.js --self-test
```

## Notes

- Headless runs spawn `agent -p --trust --force --sandbox disabled --output-format stream-json`.
- MCP approval is not enabled.
- `--append-system-prompt` is prefixed onto the stdin prompt. The Cursor CLI has no matching flag.
- Public session ids are Cursor chat UUIDs. Records live in `.cursor-agent-shim/sessions` and `--debug-dir`.

Clausetta ([learning/examples/clausetta](../../learning/examples/clausetta)) was started against `/Users/rip/dev/cursor-agent-docs` and stopped before the first codon: the local Claude login returns `401 OAuth access token is invalid`, and `ANTHROPIC_API_KEY` is unset. This package was written from that data pack and `shim-spec.md` instead.
