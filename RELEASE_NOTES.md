- 2026-02-13

### Added

- **Rig setup telemetry events** — `rig_setup_completed` and `rig_setup_failed` are now captured by the telemetry collector. Previously the event names were defined but no code generated them.
- **`rollback-completed` idle reason** — New `server.idle` reason emitted after rollback completes without autostart, so TUI and clients know the server is waiting for input.
- **Sentinel `codon.completed` drain test suite** — 6 new unit tests verifying sentinels watching `codon.completed` fire correctly for all execution strategies.
- **TUI shutdown summary box** — When a hank finishes (success, failure, or user interrupt), the TUI now shows a prominent summary box with: codon count, total cost, duration, full clickable workspace path, and output directory path. On first successful run, includes a one-time star nudge for the GitHub repo.
- **TUI activity heartbeat** — After 10 seconds of no output (e.g., during large file generation), the TUI shows a ticking `Working... Xs` counter on the same line so it doesn't appear frozen. Clears automatically when new output arrives.
- **TUI resume hint on quit** — When the user presses `q` to interrupt a run, the TUI shows the `hankweave --execution <path>` command to resume.
- **Validation run hint** — After successful `--validate`, shows a copy-pasteable `hankweave <config> <data_path>` command. Uses the original URL for remote hanks.
- **`outputDirectory` in `server.ready` event** — The output directory path is now included in the `server.ready` WebSocket event so TUI and clients know where outputs will be copied.
- **First-success tracking** — `firstSuccessAt` field added to `~/.hankweave/telemetry.json` to track when a user's first successful hank run occurred (used for the star nudge).

### Changed

- **TUI rollback now auto-restarts execution** — Rollback commands from the TUI (`[r]` menu) now send `autoRestart: true` instead of `false`. If `config.autostart` is enabled (the default), execution resumes automatically from the rollback point. Users running with `--no-autostart` are not affected.
- **TUI idle state display** — `server.idle` events now render as a prominent "Waiting for Input" box with contextual command hints (e.g., `[n] start next codon  [r] rollback  [q] quit`) instead of dim text. Hints adapt based on why the server is idle (rollback, codon completion, startup, all-done).
- **TUI rig setup events** — `rig.setup.completed` and `rig.setup.failed` now render properly (green check with duration / red cross with failure type) instead of showing as "Unknown Event" with raw JSON.
- **Wizard demo output path** — The demo wizard now shows the full resolved path for the output directory (Cmd/Ctrl-clickable) instead of a relative `./hankweave-demo-output`.
- **Remote hank cache: hash-based freshness** — Branch caches now validate via `git ls-remote` (a single lightweight network roundtrip) to check if the remote tip has new commits, replacing the previous 1-hour TTL. Tags/commits remain cached indefinitely. Falls back to cache if offline.
- **Strict hank file validation** — `hankFileSchema` now uses `.strict()` to catch unrecognized root-level fields (e.g., `outputFiles` at hank root instead of codon level). Error messages detect codon fields placed at root and suggest where to move them.
- **CLI: single remote URL treated as hank path** — A single positional argument starting with `https://`, `http://`, or `git@` is now correctly treated as a hank path instead of a data path. Fixes `--validate` and bare execution of remote hanks.
- **Emoji-free CLI output** — Replaced all emoji characters (🔍📁🏃❌🌐📦✨⚠️🎮) in startup, validation, and error output with ASCII symbols (`>`, `✓`, `✗`, `!`, `+`) for a consistent terminal aesthetic.
- **Validation summary box alignment** — Fixed "GOOD TO RUN!" box top border width to match the bottom border.
- **Sentinel docs improved** — Added execution model section (blocking vs non-blocking at codon boundaries), "note-takers not editors" capabilities callout, sentinel-vs-codon guidance, unidirectional data flow pattern, event routing rules, and shared-file antipattern warning. Driven by customer feedback on sentinel complexity.
- **Sentinel config reference updated** — Event types table split into routed/not-routed sections with warning that `sentinel.*` events never fire triggers.
- **Execution flow docs updated** — Added "Routed to Sentinels" column to event categories table and two-phase drain description.
- **Public README improved** — Expanded FAQs with new sections (Understanding Hankweave, Using Hanks), added MCPs rationale, codon data flow, information sharing between codons, and interactive-vs-hermetic comparison with Claude Code.
- **Release script overhauled** — Two-phase release with full dry-run validation before any changes. `--dry-run` flag validates the entire pipeline (merge feasibility, schema generation, typecheck, lint, tag availability). `--yes` flag enables headless/agent execution. Automatic rollback on failure.
- **Public sync: `.github/actions` stripped** — Composite actions (setup-environment, run-tests, dump-test-logs) are now excluded from the public repo snapshot since they're only used by private CI.
- **Public sync: broken scripts removed from `package.json`** — `release:patch`, `release:minor`, `release:major` scripts are now stripped during public transformation since `release.ts` is not included.

### Fixed

- **Sentinels watching `codon.completed` now reliably fire** — Added a second sentinel queue drain after the `codon.completed` event emission. Previously, sentinels triggered by `codon.completed` had their work silently dropped during unload. Affects all execution strategies (immediate, debounce, count, timeWindow).
- **Telemetry shutdown: `run_started`, `run_completed`, `$ai_trace` events missing** — The `RunCompleted`/`RunFailed` state transitions clear `currentRunId`, causing `getCurrentRun()` to return `null` when telemetry tried to build the shutdown payload. Run data is now captured before the transition.
- **Telemetry E2E tests disabled by Cursor's `CI=1`** — Happy-path test now clears the `CI` environment variable so telemetry debug mode works when running from Cursor's terminal.
- **Structured output E2E test calling Opus instead of Haiku** — Model auto-discovery now prefers haiku before falling back to first-available, preventing 15s timeouts and unnecessary spend.
- **E2E event integrity false positive** — Relaxed duplicate `assistant.action` detection threshold from >1 to >3, since agents legitimately produce identical thinking/message patterns across codons.
- **Output directory path resolution** — Absolute paths passed via `-o` (e.g., `-o /Users/.../output`) were concatenated onto CWD by `path.join`, creating deeply nested directories instead of writing to the intended location. The `outputDirectory` is now resolved to an absolute path once at config assembly time using `path.resolve`. Also affects the wizard demo flow.
- **Output file copy source** — `outputFiles` glob patterns were resolved against `executionPath` (the outer system directory) instead of `agentRootPath` (where the agent actually works). Since execution isolation (v0.2.0) moved agent work into `agentRoot/`, the globs matched zero files and nothing was copied. Changed the `copyFiles` source to `agentRootPath`.
- **TUI shutdown summary timing** — The "Run Complete" summary box now prints on WebSocket disconnect (always last) instead of on the "All codons completed" info event (which fired before sentinel shutdown output). A brief one-liner provides immediate feedback when codons complete.