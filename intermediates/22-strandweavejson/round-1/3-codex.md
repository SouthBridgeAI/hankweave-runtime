# Strandweave.json Design & Implementation Suggestions

This assumes we keep the current precedence (CLI > env > config > defaults) and introduce a single `strandweave.json` to concentrate runtime configuration without absorbing workflow definitions.

## Scope & Separation
- Keep workflow shape (`codon-sequence.json`) separate; `strandweave.json` is about **how** strandweave runs, not **what** it runs. Allow `strandweave.json.workflow.configFile` to point to a sequence file for convenience.
- Secrets stay in env vars (`STRANDWEAVE_` passthrough, provider keys, sentinel overrides). Config only stores non-secret tunables and paths.
- Allow optional per-environment overlays by using `--strandweave-config` to point at an alternate file rather than in-file environment sections.

## File Discovery & Overrides
1. New CLI arg `--strandweave-config=<path>` (and `-s` alias) to explicitly set the file. If absent, resolve in order: CWD, nearest parent, `~/.config/strandweave/strandweave.json`.
2. Support a secondary `strandweave.local.json` in the same directory for developer-only overrides (merged after the base file, before env vars).
3. Merge order: CLI args > env vars > `strandweave.local.json` > `strandweave.json` (nearest wins when walking up) > DEFAULT_CONFIG. Use deep merges at leaf level so sections compose instead of replace.

## Proposed Top-Level Shape
```json
{
  "$schema": "./strandweave.schema.json",
  "version": "1.0.0",
  "server": { "port": 7777, "withoutProxy": false },
  "paths": {
    "outputDirectory": "strandweave-results",
    "lockFile": ".strandweave/runtime.lock",
    "logs": { "websocket": ".strandweave/logs/websocket.log", "server": ".strandweave/logs/server.log" }
  },
  "workflow": { "configFile": "codon-sequence.json", "autostart": true, "dataHashTimeLimit": 5000 },
  "costs": { "perMTok": { "input": 3.0, "inputCache": 3.75, "cacheRead": 0.3, "output": 15.0 } },
  "llm": {
    "defaultModel": "sonnet",
    "providers": { "anthropic": { "baseUrl": null } },
    "replay": { "enabled": false, "dataPath": null }
  },
  "runtime": {
    "logParsingInterval": 1000,
    "toolResultTruncateLength": 2500,
    "handshakeHistoryLimit": 50,
    "bun": { "version": null },
    "docker": { "enabled": false, "image": null }
  },
  "sentinel": { "enablePersistence": true, "healthCheckGracePeriodMs": 2000, "waitForAllHealthChecks": false }
}
```

## CLI & Env Mapping
- Add CLI flags that map 1:1 to fields when practical (`--port`, `--without-proxy`, `--autostart`, `--model`, `--anthropic-base-url`, `--docker-image`, `--bun-version`), keeping existing names for backward compatibility.
- Document env variable precedence clearly; expose an `--explain-config` flag that prints the resolved config and the source of each field to aid debugging.
- Keep `STRANDWEAVE_` passthrough unchanged; provider keys remain env-only with sentinel overrides continuing to win in sentinel contexts.

## Validation & Tooling
- Extend Zod validation to cover the new structure; ship a JSON Schema for IDE completion. Fail fast with actionable errors (include path to offending field).
- Provide a `strandweave validate --config strandweave.json` command that only validates config (no execution).
- Consider optional `strandweave init` to scaffold `strandweave.json` from DEFAULT_CONFIG plus comments.

## Backward Compatibility
- If `strandweave.json` is absent, behave exactly as today. If present, merge it before env/CLI overrides.
- Keep legacy flags working; if both a legacy flag and the new config set the same field, log a warning showing precedence resolution to avoid surprises.

## Implementation Steps (suggested order)
1. Add config file discovery helper that returns `{ config, sourceMap }` to track origins for `--explain-config`.
2. Define a Zod schema mirroring the proposed shape; generate a JSON Schema artifact alongside.
3. Implement deep-merge utility with source tracking; wire into existing config assembly pipeline in `server/config.ts`.
4. Add new CLI flag(s) for `--strandweave-config` and `--explain-config`; update help output.
5. Update docs and examples (`strandweave.json` sample, env precedence table).
6. Add tests: unit tests for merge ordering, schema validation failures, discovery order (CWD vs parent vs home), and `--explain-config` output snapshot.

## Open Questions / Decisions
- Should we support YAML/TOML? Recommendation: stay JSON-only for now to avoid parser divergence.
- Do we allow `strandweave.json` to embed codon sequences? Recommendation: no; keep workflow files separate to allow multiple workflows with a shared runtime config.
- Should we write back defaults into a generated file? Optional: `strandweave init --write-defaults` could materialize the full resolved config for inspection.
