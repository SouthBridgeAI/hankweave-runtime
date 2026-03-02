## [0.5.6] - 2026-03-02

### Added

- **Replay mode (`--replay` flag)** — Deterministic re-execution of a previous run from its JSONL logs, without making real LLM API calls. Pass `--replay <execution-dir>` to replay any completed execution. The original execution directory is copied to a temp location (preserving the source as read-only), hank config and data paths are auto-discovered from `execution-meta.json`, and rig setup and sentinels are skipped since the copied directory already has post-setup state. Replay uses timestamp-based inter-message pacing (capped at 5s) for realistic output timing. Useful for debugging, demos, and testing TUI/client integrations without API spend.
- **Timestamps in LLM log entries** — Every JSONL message written by `ClaudeAgentSDKManager` and `ShimProcessManager` now includes an ISO 8601 `timestamp` field. Enables the replay mode's realistic timing and improves log forensics.
- **`BaseProcessManager` base class** — Extracted shared context-exceeded detection logic (`detectContextExceeded()`, `emitExit()`) into a common base class. `ClaudeAgentSDKManager`, `ShimProcessManager`, and the new `ReplayProcessManager` all extend it. No behavior change; internal cleanup.

### Changed

- **Context overflow detection unified** — `ClaudeAgentSDKManager` previously had its own inline context-exceeded check that only matched a subset of failure patterns. All process managers now use the shared `isContextExceeded()` function via `BaseProcessManager`, fixing cases where context overflow was not correctly reported by the SDK manager.
- **`ShimProcessManager` stdout processing** — Replaced raw `stdout.pipe()` to the log stream with a `readline.Interface` for line-by-line processing (needed for timestamp injection). The `stdout` event is now emitted per-line from the readline handler.

### Fixed

- **TUI shutdown summary showed wrong output path** (ENG-211) — The "Run Complete" summary box displayed `{executionPath}/outputs/` as the fallback output location when no explicit `outputDirectory` was configured. Outputs actually live in `agentRoot/`. Fixed to show the correct agent workspace path.
- **Could not resume auto-managed executions via `--execution`** (ENG-198) — Using `--execution` with a path inside `~/.hankweave-executions/` always threw a hard error, even for existing executions the user wanted to resume. Now checks for the presence of `execution-meta.json` — if the metadata file exists (indicating an existing execution), resume is allowed. Only creation of new executions in the managed directory is blocked.