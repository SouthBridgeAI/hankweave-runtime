## [0.7.0] - 2026-06-01

### Added

- **Trace upload on run completion** — When `HANKWEAVE_TRACE_BRAINTRUST` and/or `HANKWEAVE_TRACE_LANGFUSE` are set, the runtime registers a post-run trace upload via the `hankweave-trace` CLI (`npx`/`bunx hankweave-trace`, overridable with `HANKWEAVE_TRACE_BINARY`). A `hankweave-trace config` check runs at startup so misconfiguration is surfaced immediately, and the upload runs synchronously in `shutdown()`/force-shutdown (with a guard against double-upload) rather than in an exit handler. New `server/trace-watcher.ts`.
- **Pi shim Node.js runtime preflight** — The pi shim is always spawned under Node (it bundles `@earendil-works/pi-coding-agent` → undici, which crashes under Bun). Before launch, `assertPiNodeRuntime()` verifies the PATH `node` exists and is ≥ `22.19.0` (`MIN_PI_NODE`), throwing an actionable `PiRuntimeError` (carrying the resolved node path/version) instead of letting pi die downstream with an opaque module-load crash. Pi-shim detection keys off the parent dir being `pi`, which holds across source, dist, and extracted-binary layouts.
- **Self-test failure classification** — Shim self-test failures are now classified (`launch`, `binary-missing`, `auth`, `check`, `unknown`) and the aggregate error appends guidance tailored to the categories that actually occurred, so a launch/runtime crash is never misreported as an API-key problem. Failed self-tests render per-model bullets that include each failed check's specific message (e.g. where a binary was searched).
- **Secret masking in validation output** — Environment variables shown in `--validate` output are masked when their name looks secret (`SECRET`/`TOKEN`/`KEY`/`PASSWORD`/etc., with `PUBLIC`/`PUBLISHABLE` exempted), revealing only the last 4 characters of long values. Readable config (URLs, hosts, public keys) is shown verbatim. New `isSensitiveEnvKey()`, `maskSecretValue()`, `formatEnvVarForDisplay()` utilities.
- **`update-models-dev` command and daily workflow** — New `.claude/commands/update-models-dev.md` slash command that fetches fresh `models.dev` data, runs unit tests, and reports newly added models, plus a GitHub Actions workflow that runs it on a schedule and opens a PR. Includes `scripts/e2e/test-new-models.ts` for parallel smoke-testing new models.

### Changed

- **Upgraded `@anthropic-ai/claude-agent-sdk` to 0.3.156** (from `^0.1.70`) — Reworked the binary build and shim runtime to match the new SDK layout.
- **Upgraded `@openai/codex-sdk` to 0.135.0** (from 0.104.0) — Codex shim bumped to `0.135.0`. The vendor binary layout changed (`<triple>/bin/<binary>` in v0.135.0+, falling back to the legacy `<triple>/codex/<binary>`); `codex-runtime-extractor.ts` now resolves both layouts via `resolveCodexBinaryInTripleDir()`.
- **Migrated the pi shim to `@earendil-works/pi-coding-agent` 0.77.0** (from `@mariozechner/pi-coding-agent` 0.57.1).
- **Node engine requirement raised to `>=22.19.0`** (from `>=20.0.0`) — Applies to the root package and the pi shim, matching the pi/undici requirement.
- **Updated model data** — Refreshed `models-dev-data.json` and the backup with the latest provider model entries. Codex tests and the `--init` codex scaffold now use `gpt-5.2` (works with both subscription and API key) instead of the API-only `gpt-5.1-codex-mini`.
- **More actionable "binary not found" errors for shims** — OpenCode now reports exactly where it searched (PATH names vs filesystem paths), and the Gemini self-test names the binary and lookup mechanism. Shim self-test JSON-parse failures surface the exit code and captured stderr instead of swallowing the real cause.

### Fixed

- **Event journal not fully drained before shutdown returns** — `shutdown()` now awaits the file-backed event journal append queue before returning, so tests (and callers) that replace or delete the execution directory immediately afterward don't race with in-flight journal writes.