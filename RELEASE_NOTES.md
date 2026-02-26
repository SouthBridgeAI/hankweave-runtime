## [0.5.5] - 2026-02-26

### Added

- **`--overwrite-output` CLI flag** — When set, existing files in the output directory are overwritten in-place instead of being renamed with `_N_timestamp` suffixes. Useful for workflows that always produce the same output filenames across codons and want the latest version, not a history. Default behavior (rename on conflict) is unchanged.
- **`HANKWEAVE_*=unset` env var passthrough** — The `HANKWEAVE_*` environment variable passthrough mechanism now supports the special value `"unset"`. When `HANKWEAVE_FOO=unset` is set, `FOO` is actively removed from both the server's own process environment (before sentinel provider initialization) and child process environments (codon agents). Solves the proxy inheritance problem where `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` from a parent process (e.g., hankhelp) would propagate into codon agents and sentinels, causing guide injection, cost inflation, and silent sentinel failures.

### Changed

- **Cost tracking extracted from runtime** — Cost computation and lifecycle management moved from `HankweaveRuntime` into a dedicated `CostTracker` class owned by `CodonRunner`. No behavior change; internal cleanup.

### Fixed

- **Sentinel `output.file` and `output.lastValueFile` now work** — Both fields in sentinel JSON configs were silently ignored despite passing Zod validation. Sentinel output always went to auto-generated paths in `.hankweave/sentinels/outputs/` regardless of what was configured. The sentinel constructor now reads `config.output.file` and `config.output.lastValueFile` as fallbacks when `settings.outputPaths` (hank.json) is not set. Priority chain: `settings.outputPaths` (codon-level) > `config.output.*` (sentinel-level) > auto-generated. Path resolution uses the same convention: paths with `/` resolve to `agentRoot`, bare filenames stay in the managed directory.
- **Sentinel `output.format` now works** — The `output.format` field (`"text"` | `"jsonl"`) was also silently ignored. It now controls two things: (1) the auto-generated file extension when no explicit path is set (`.md` or `.jsonl`), and (2) the write format for text outputs — `"jsonl"` wraps each text output as a JSON line with `text`, `timestamp`, and `sentinelId` fields, useful for downstream parsing. The `"json"` option was removed to avoid confusion (it produced JSONL, not valid JSON). A new validation refinement rejects configs that set both `structuredOutput` and `output.format`, since structured output determines its own format.
- **Structured output E2E tests selecting deprecated model** — Two E2E tests (`Schema file loading`, `Cost tracking`) were failing because dynamic model selection grabbed `anthropic/claude-3-5-haiku-latest` (deprecated by Anthropic) before `anthropic/claude-haiku-4-5`. Fixed to prefer the current model name.