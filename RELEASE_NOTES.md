## [0.5.7] - 2026-03-07

### Added
- **Rig output streaming (`rig.output` event)** — Rig setup commands now emit real-time `rig.output` events with stdout/stderr lines, throttled to 1 event per second per stream. The TUI displays rig output inline and uses the last output line as a hint in the activity heartbeat spinner. Enables clients to show rig setup progress instead of a silent wait.
- **Context-aware TUI activity spinner** — The "Working..." heartbeat now shows phase-specific labels: "Rig running" during rig setup, "Model thinking" during agent execution, and "Completing sentinels" during sentinel drain. The last rig output line is shown as a hint alongside the spinner.

### Changed
- **TUI cost display is now opt-in** — Cost data (dollar amounts, token totals) is hidden in the TUI by default. Set `HANKWEAVE_RUNTIME_SHOW_COSTS=1` to display costs.
- **Updated model data** — Refreshed `models-dev-data.json` with latest provider model entries (March 2026).

### Fixed
- **Resume without `--data` used CWD instead of original data path** (ENG-196) — When resuming via `--execution` without an explicit `--data` flag, the data source path is now read from `execution-meta.json` instead of defaulting to the current working directory. Prevents hash mismatches when resuming from a different directory.
- **Server hung on resume when killed execution had no checkpoints** (ENG-196) — A guard condition prevented starting a fresh run when a failed execution thread had no checkpoints to roll back to. The server now starts fresh instead of hanging indefinitely.
- **Replay flow-control decisions lived in wrong module** (ENG-196) — Moved replay-specific startup logic from `replay.ts` into `HankweaveRuntime`, where other flow-control decisions live.
- **Rig output flush interval leaked on command error** — The 1-second flush interval for rig output throttling was not cleared when the spawned command errored, causing a timer leak.