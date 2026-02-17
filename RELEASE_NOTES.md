## [0.5.0] - 2026-02-17

### Added

- **Shim idle timeout** — Configurable timeout that aborts agent harnesses when no events are received within a deadline. Prevents runs from hanging indefinitely on stalled agents. Configurable per-codon (`shimIdleTimeout`), per-hank (in `overrides`), or runtime-wide (`--shim-idle-timeout` CLI flag / `hankweave.json`). Shims default to 120s.
- **Environment metadata in `execution-meta.json`** — Execution metadata now records hankweave version, invocation method (binary/bun/node/deno), platform, arch, OS release, and runtime version. Schema version bumped to 1.1.0.
- **Wizard credit validation** — The welcome wizard now makes a lightweight API call to verify credentials have working credits before launching the demo, catching dead keys and exhausted balances up front.
- **Wizard model fallback** — The demo wizard now adapts to whatever provider the user has available (Anthropic → OpenAI → Google) instead of failing when the user lacks Anthropic credentials.
- **Wizard completed-run detection** — If the user already ran the demo with the same data folder, the wizard detects the prior completed run and offers to start fresh.

### Changed

- **Idle timeout validation** — `--idle-timeout` and `--shim-idle-timeout` CLI values are now validated (must be positive finite integers within bounds). Previously, invalid values like NaN could cause instant aborts.
- **Error tracking enrichment** — Original `Error` objects are now preserved at all failure sites instead of creating synthetic errors at the capture point. Correlation context (`runIdHash`, `codonIdHash`, `codonPosition`, `model`, `hankweaveVersion`) added for debugging.
- **Windows CI timeout budgets** — Increased timeout budgets for unit, integration, and E2E tests on Windows to accommodate PowerShell overhead and file locking delays.

### Fixed

- **False "completed" status on billing errors** — The Claude SDK returns billing failures as `subtype: "success"` with `is_error: true`. The runtime now distinguishes real success from disguised API errors, correctly marking codons as "failed" instead of "completed".
- **Idle timeout timer leak** — Fixed a timer leak in `withIdleTimeout` when `iterator.next()` rejects before the timeout fires.
- **NPX init E2E flakiness** — Resolved cache corruption and timeout issues causing intermittent init test failures.
- **Deno version missing from startup banner** — `getRuntimeVersion()` now correctly reports the Deno version instead of falling through to Node.js detection.