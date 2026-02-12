## [0.3.3] - 2026-02-12

### Added
- 

### Changed
- 

### Fixed
- 

## [0.3.2] - 2026-02-12

### Added
- 

### Changed
- 

### Fixed
- 

## [0.3.1] - 2026-02-12

### Added
- 

### Changed
- 

### Fixed
- 

## [0.3.0] - 2026-02-12

### Added

- **Welcome wizard** — First-run experience when running `hankweave` with no arguments
  - Animated 4D tesseract splash screen with depth-aware teal/amber color gradient
  - Automatic environment detection (Claude Code, Codex, Gemini CLI + API keys)
  - Bordered environment panel with clear found/not-found status and help links
  - Menu: try demo hank, init new hank, open docs/GitHub/launch page
  - Demo hank flow with time/cost warning (~5-10 min, ~$0.50-1.00), data folder picker, and `-o` output copy
  - Init hank flow with file tree preview and next-steps guidance
  - Non-TTY fallback with static text for CI/piped environments
  - Runner detection (npx vs bunx) for accurate command suggestions
  - Uses `@clack/prompts` for interactive elements

- **Shared color palette** (`server/wizard/colors.ts`)
  - 24-bit RGB color functions anchored to the tesseract's amber/teal scheme
  - Box-drawing helper with rounded corners and optional title
  - ANSI-aware string width utilities (`visibleLength`, `padVisible`)

- **`.gitignore` in init template** — Scaffolded hanks now include `.gitignore` for `.hankweave/`, logs, and `node_modules/`

- **Example hanks and learning materials**
  - Clausetta example hank (shim builder) with full eval suite
  - Plan-gen-v2 example hank (general planning workflow)
  - `hank-basics.md` guide

- **Force shutdown command** (`server.force_shutdown`) — new WebSocket command that immediately kills agent processes and exits. Clients can send this during a graceful shutdown to skip the wait.
- **Second-press force quit in TUI** — pressing `q` or Ctrl+C a second time during graceful shutdown triggers an immediate force exit with SIGKILL escalation. The TUI now shows "press q again to force quit" during shutdown.
- **Shutdown info event** — server emits an `info` event to all connected clients when entering graceful shutdown, enabling external clients to show status and send `server.force_shutdown` if needed.

### Changed

- **CLI startup reordered** — Welcome wizard, `--init`, `--attach`, and `--help` now exit early before heavy config resolution and SDK checks
- **Init template README updated** — Accurate file list, full model examples, running instructions, and learn-more links
- **Banner links updated** — Blog link replaced with launch page (`southbridge.ai/hankweave`)
- **README.md trimmed** — Detailed documentation moved to docs site
- **SIGINT/SIGTERM signal handling** — second signal now escalates to force shutdown instead of being silently ignored.

### Fixed

- **Basic TUI box overflow** — `drawBox()` now caps width at `min(terminalWidth, 120)` and word-wraps long content lines. Fixes sentinel output boxes stretching to hundreds of columns.
- **Tesseract aspect ratio** — Side-by-side mode no longer squishes the tesseract vertically. `scY` is now derived from `scX` with character aspect ratio correction instead of scaling independently with terminal height.
- **Remote hank branch fallback** — `main` → `master` fallback now works on cached repos (previously only worked on initial clone). Fixes "pathspec 'main' did not match" errors on second fetch.
- **HTTP status code** — Non-WebSocket requests to the server now return 400 instead of 426.
- **Telemetry shutdown** — `sendRunTelemetry` now uses `getCurrentRun()` instead of looking up by a potentially-cleared run ID.
- **Critical: Claude Code abort controller never reached the SDK** — the abort controller was created _after_ building SDK options, so the SDK received `undefined` and created its own internal controller. `kill()` was aborting a controller the SDK didn't know about. The child process never received SIGTERM via abort. Fixed by creating the controller before building options.
- **Orphaned agent processes on shutdown** — `ClaudeAgentSDKManager.kill()` now properly waits up to 5 seconds for the SDK query to complete after aborting, instead of returning after 100ms. This ensures the child process has time to exit before the server calls `process.exit()`.
- **ShimProcessManager SIGKILL escalation was dead code** — the kill wait loop checked `ChildProcess.killed` (true when signal is _sent_) instead of actual process exit. The interval resolved on the first tick and SIGKILL was never reached. Fixed to check whether the process reference has been cleared by the exit event handler.

## [0.2.3] - 2026-02-10

### Added

- **GPT-5.3 Codex model support** (PR #105)
  - Added `gpt-5.3-codex-high` and `gpt-5.3-codex-xhigh` model definitions
  - Reasoning effort specifiers parsed from model ID suffix (e.g., `-high`, `-xhigh`)
  - Load-time assertions verify model resolution correctness

- **Anonymous Telemetry** (ENG-12, PR #100)
  - Privacy-preserving usage analytics via self-hosted PostHog

- **New server events**
  - `rig.setup.completed` — emitted after rig setup with duration, command count, and checkpoint status
  - `rig.setup.failed` — emitted on rig setup failure with classified failure type (`command_failed`, `timeout`, `other`)
  - `loop.iteration.completed` — emitted per loop iteration with duration, cost, token usage, and termination reason

### Changed

- **Codex SDK upgraded to v0.98.0** (PR #104, PR #105)
  - Updated `@openai/codex-sdk` from `^0.87.0` to `^0.98.0`
  - New `webSearchMode` parameter support (replaces boolean `webSearchEnabled`)
  - Config overrides support via new `config` constructor option with TOML serialization
  - Thread resume (`args.threadId`) now passed before `--image` flags (ordering fix)

- **Codex shim streaming rewritten for incremental deltas** (PR #104)
  - Shim now tracks `lastEmittedAssistantText` and `lastEmittedReasoningByItemId` to compute true deltas
  - Previously re-emitted full accumulated text on each update, causing duplicate content in streaming output
  - Reasoning text deltas now tracked per-item via Map for correct multi-item reasoning streams

- CLI startup reordered: config resolution now happens before mode branches (init, attach, validate, cleanup) so all code paths have access to resolved config and telemetry

### Fixed

-