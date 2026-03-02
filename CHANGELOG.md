# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- 

### Changed
- 

### Fixed
- 

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

## [0.5.4] - 2026-02-20

### Added

-

### Changed

-

### Fixed

- **Release CI: all 5 platform builds now succeed** — `darwin-x64` and `linux-arm64` builds were failing because `bun install` only fetches the codex binary for the host architecture. Cross-compilation targets now fetch the correct binary via `npm pack` before building. Also survived the retirement of `macos-13` (Intel) runners along the way.

## [0.5.3] - 2026-02-20

_Patch releases 0.5.1–0.5.3 were a hat-trick of CI fixes, each one revealing the next. All three are consolidated here._

### Changed

- **Dynamic model selection for credit validation** — `validateApiCredits()` now uses the model registry to find the cheapest recent model per provider instead of hardcoding model names that rot when providers deprecate old models. `findCheapestModel()` prefers models updated in the last 6 months, falls back to 1 year, then all candidates.

### Fixed

- **Remote hanks with slashed branch names** — URLs like `.../tree/release/alpha/path/to/hank` now work correctly. The URL parser couldn't tell where the branch name ended and the file path began for branches containing `/`. Now uses `git ls-remote` to resolve the actual ref before cloning.
- **Release script: modify/delete conflicts on stripped files** — The merge from `develop → release/alpha` now auto-resolves modify/delete conflicts when the conflicting files are in the internal strip list. The dry-run feasibility check also catches `DU`/`UD` conflict markers it previously missed.
- **Release CI: cross-platform codex binary builds** — `darwin-x64` and `linux-arm64` executable builds fixed via cross-compilation using `npm pack`. Also switched `darwin-x64` off the retired `macos-13` runner.

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

## [0.4.1] - 2026-02-13

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

## [0.4.0] - 2026-02-13

Internal release. See v0.4.1 for combined public release notes.

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

## [0.2.2] - 2026-02-09

### Fixed

- **Codon env variables not available in rig setup and beforeCopy commands** (PR #103)
  - Codon `env` variables were only passed to the Claude/shim process, not to `rigSetup` or `beforeCopy` commands
  - Shell expansions like `${MY_VAR}` in rig commands now correctly resolve instead of expanding to empty strings
  - `runCommand()` now accepts and forwards codon env variables to `spawn()`

## [0.2.1] - 2026-02-08

### Added

- **HTML Comment Stripping in Prompts** (ENG-158)
  - HTML comments (`<!-- ... -->`) are now automatically stripped from all prompts before sending to LLM
  - Applies to system prompts, user prompts, and template variable processing
  - Trailing newlines are also consumed to prevent blank line accumulation
  - Useful for adding internal notes and documentation that shouldn't reach the model

- **Output File Conflict Resolution** (ENG-115)
  - Automatic handling of filename collisions when copying output files
  - Conflicting files are renamed with format: `file_<counter>_<timestamp>.ext` (e.g., `report_1_1738678800.pdf`)
  - Preflight warnings shown when output directory is non-empty
  - New `resolveFileConflict()` utility with safety limit (max 100 conflicts)
  - Server emits info events with conflict details for client awareness
  - Updated `copyFiles()` returns conflict information for post-copy processing

- **Headless Autostart Control** (ENG-180)
  - New `requestAutostart()` method for idempotent codon execution triggering
  - Headless mode now automatically starts execution without waiting for client connection
  - Prevents race condition where both headless startup and client handshake trigger autostart
  - Smart exit codes: 0 for success/user shutdown, 1 for codon failure (based on run status)

### Changed

- **Dynamic Port Allocation by Default** (ENG-179)
  - Default WebSocket server port changed from 7777 to 0 (OS-assigned ephemeral port)
  - Prevents port conflicts when running multiple Hankweave instances
  - Startup sequence reordered: WebSocket server binds first, then proxy on `actualPort + 1`
  - Lock file now updated with actual ports after binding
  - `start()` method now returns actual port for callers
  - CLI help text updated to reflect auto-selection behavior
  - Proxy falls back to dynamic port if preferred port unavailable

- **`shutdown()` signature enhanced** (ENG-180)
  - New optional parameter: `shutdown(reason, exitProcess = true, exitCode?)`
  - Exit code can now be explicitly set or auto-determined from run status
  - Fully backward compatible with existing `shutdown(reason)` and `shutdown(reason, exitProcess)` calls

- **Cleaner Startup Logs**
  - Removed noisy `[MODULE]` debug output from startup
  - Version and platform info now displayed in a clean rounded box matching codon display style
  - Execution info grouped together: status, source, path, and SDK versions
  - Paths shortened with `~` for home directory
  - Suppressed verbose "Calculating data signature..." message
  - SDK managers now return structured info instead of printing directly

### Fixed

- **Critical: Dynamic Port Display Bug**
  - Fixed banner showing `ws://localhost:0` instead of actual assigned port
  - TUI was attempting to connect to port 0, causing immediate connection failure
  - Now correctly reads actual port from crossws Bun adapter via `.bun.server.port`
  - Affects all dynamic port allocations (default behavior)

- **Critical: HTTP Request Crash in Headless Mode**
  - Fixed crash when server receives HTTP requests (curl, browser, health checks)
  - Previously crashed with "fetchHandler is not a function" error
  - Now returns helpful JSON error message directing users to WebSocket endpoint
  - Particularly important for CI/CD environments where stray HTTP probes could kill entire runs
  - Added CORS headers for better browser compatibility

- **Sentinel Output Path Resolution**
  - Sentinel output paths with `/` (including `./`) now correctly resolve relative to `agentRootPath`
  - Previously, all explicit paths resolved relative to `executionPath` (outer directory)
  - Filename-only paths continue to use managed directory: `.hankweave/sentinels/outputs/{id}/`
  - Allows sentinels to write outputs directly to agent workspace (e.g., `./analysis.log`)
  - Path safety validation updated to allow paths within both `executionPath` and `agentRootPath`

## [0.2.0] - 2026-02-03

### Added

- **Execution Isolation (Hidden Execution Area)**
  - New directory structure separates agent workspace from system files
  - `agentRoot/` - Agent's workspace where all work happens (Git work tree)
  - `rigArchive/` - Archive storage for `archiveOnSuccess` feature
  - `.hankweave/` - System files (checkpoints, logs, manifest) hidden from agent
  - Template variables (`<%AGENT_ROOT%>`, `<%PROJECT_DIR%>`, `<%EXECUTION_DIR%>`) all resolve to `agentRoot/`
  - `server.ready` event now includes `agentRootPath` in addition to `executionPath`

- **Rig Archiving (`archiveOnSuccess` field)**
  - New `archiveOnSuccess` field on codons and loops to archive files after successful completion
  - Files are moved from `agentRoot/` to `rigArchive/<codonId>/` preserving directory structure
  - Loop-level archives create iteration-specific directories: `rigArchive/<loopId>-<iteration>/`
  - Archive manifest tracks all archived files at `.hankweave/archive-manifest.json`
  - Supports glob patterns for specifying files to archive
  - New events: `archive.completed`, `archive.partial` for tracking archive operations

- **Rollback Archive Restoration**
  - When rolling back, archived files are automatically restored from `rigArchive/` to `agentRoot/`
  - Archive manifest is updated to remove entries for rolled-back checkpoints
  - Empty archive directories are cleaned up after restoration
  - New `rollback.archiveRestore` event emitted with details of restored files

### Changed

- Renamed checkpoint git directory from `.git` to `.hankweavecheckpoints` to prevent Git submodule detection when committing execution environments (ENG-178)
  - Existing execution environments are automatically migrated on startup
  - Backup directories (from `--start-new --force`) are also migrated when main checkpoint needs migration
  - File resolver updated to exclude the new directory name from checkpoints
- `beforeCopy` commands in `outputFiles` now only run when `outputDirectory` is configured
  - Previously, `beforeCopy` would run even if there was no output directory to copy to
  - This prevents unnecessary command execution and potential errors
- Process managers now use `agentRootPath` as working directory (previously `executionPath`)
- `PromptBuilder` simplified to only require `agentRootPath` (removed unused `executionPath` parameter)

## [0.1.48] - 2026-01-31

## [0.1.47] - 2026-01-31

### Added

- **ASCII structure visualization** (ENG-175)
  - Visual tree diagram of hank structure appears in both `--validate` mode and before normal execution
  - Hierarchical numbering: [1], [2], [2.1], [2.2], [3] for clear codon references
  - Flow arrows (↓) showing execution order between codons
  - Rounded box corners and loop body boxes with visual grouping
  - Color output when running in terminal (auto-disabled when piped)
  - Prompt line counts (e.g., "prompts: 2 (347 lines)") for at-a-glance sizing
  - Terminal-width-aware rendering that adapts to narrow terminals

- **OpenAI Codex CLI support** (PR #77)
  - Run codons using OpenAI models (GPT-4.1, GPT-5.2 variants) via the Codex CLI
  - Platform-specific Codex binary extraction from `@openai/codex-sdk` package
  - Automatic binary detection: uses `node_modules` in dev, extracts to `~/.hankweave/codex-sdk/<version>/` for compiled executables
  - Self-test functionality verifies Codex installation and API key configuration
  - Multiple auth methods supported: `~/.codex/auth.json`, `CODEX_API_KEY`, or `OPENAI_API_KEY` env vars
- **Multi-OS CI testing** (PR #77)
  - CI now runs on Ubuntu, macOS, and Windows
  - E2E tests with retry logic for flaky network conditions
  - Platform-specific test configurations
- **Reusable runtime extractor base** (PR #77)
  - Shared utilities for embedded file extraction, versioning, and caching
  - Handles Bun virtual filesystem paths correctly across platforms
  - Used by Claude SDK, Codex, and shim extractors

### Changed

- **Refactored runtime extractors** (PR #77)
  - `claude-runtime-extractor.ts`: Migrated to base extractor (-215 lines)
  - `shim-runtime-extractor.ts`: Migrated to base extractor (-186 lines)
- **CI workflow enhancements** (PR #77)
  - Added `setup-environment` composite action for Bun, Node.js, and agent auth setup
  - Added `dump-test-logs` composite action for better CI debugging
  - Codex auth via `~/.codex/auth.json` from CI secrets
- **Line ending consistency** (PR #77)
  - `.gitattributes` now enforces LF line endings for text files
  - Prevents CRLF issues that break shell scripts on Windows

### Fixed

- **Comprehensive Windows compatibility fixes** (PR #77)
  - File URL parsing: Use `fileURLToPath()` instead of manual parsing for cross-platform paths
  - Path duplication: Fixed `path.join()` with absolute paths in `HankweaveRuntime` constructor
  - Directory cleanup: Added `rmSyncWithRetry()` with exponential backoff for Windows file locks
  - Build script: Replaced Unix commands (`cp -r`, `chmod`) with cross-platform Node.js APIs
  - Double extension: Prevented `hankweave.exe.exe` on Windows builds
  - NPX discovery: Set `NPM_CONFIG_USERCONFIG` so npx finds `.npmrc` on Windows
  - Codex on Windows: Guide model to use `Write` tool instead of PowerShell commands

## [0.1.46] - 2026-01-27

### Added

- **CLI attach mode** (`--attach` flag) (PR #87, ENG-103)
  - Connect TUI to an already-running server in read-only mode
  - Reads port from execution directory's lock file, or use `--port` to specify directly
  - Commands are disabled in attach mode; press `q` to disconnect without stopping server
- **Required environment variables validation** (`requirements.env`) (PR #87, ENG-121)
  - Declare required env vars in hank.json: `"requirements": { "env": ["ANTHROPIC_API_KEY"] }`
  - Validation runs during both `--validate` and normal startup (fail-fast)
  - Supports `HANKWEAVE_` prefix: `HANKWEAVE_API_KEY` satisfies requirement for `API_KEY`
- **Global system prompts** (`globalSystemPromptFile`/`globalSystemPromptText`) (PR #87, ENG-122)
  - Apply a system prompt to ALL codons in a hank
  - Configure via file path(s) or inline text in hank.json
  - Global prompt is prepended before codon-specific system prompts
- **Rig setup visibility events** (PR #87, ENG-102)
  - Emits `info` events for rig setup start, per-operation progress, and completion
  - TUI formats these events with distinct styling for better visibility
  - Completion event includes duration and success/failure counts
- **`--ignore-rig-failures` CLI flag** (PR #87, ENG-119)
  - Global override to treat all rig setup operations as `allowFailure: true`
  - Useful for resume workflows where rig setup already completed partially

### Changed

- **Directory-aware config resolution** (PR #87, ENG-139)
  - `hankweave ./project/` now finds `./project/hank.json` automatically
  - Data directories containing hank.json are auto-discovered when no explicit config specified
- Lock file now includes `port` field for attach mode discovery
- Refactored prompt building into shared `PromptBuilder` class (used by both SDK and shim managers)
- `loadCodonSequence()` now returns `{ codons, globalSystemPrompt }` object (internal API change)
- Release script now regenerates JSON schemas before commit (ensures schemas are fresh in tagged releases)
- Improved changelog validation with confirmation prompt for empty release notes

### Fixed

- **Symlink copy errors in outputFiles** (PR #87, ENG-125)
  - Added `verbatimSymlinks: true` to `fs.promises.cp()` - symlinks are now preserved during copy
  - Fixes `EINVAL` errors when copying directories with `node_modules/.bin/` symlinks
- Fixed flaky NPX E2E test in CI by adding retry logic (2 attempts) and disabling npm update/audit checks

## [0.1.45] - 2026-01-25

### Changed

- Internal release with build improvements
- Improved changelog validation with confirmation prompt for empty release notes

## [0.1.44] - 2026-01-25

### Added

- **JSON Schema support for editor autocomplete** (PR #84)
  - VS Code (and other editors) now provide autocomplete, hover docs, and validation for `hank.json` files
  - Schemas auto-generated from Zod definitions via `bun run generate-schemas`
  - `hankweave init` includes `$schema` in generated files
  - Running or validating auto-adds `$schema` if missing
  - Schemas served via unpkg CDN: `https://unpkg.com/hankweave@latest/schemas/hank.schema.json`
- **Stable data hashing for `--input` flag** (PR #84)
  - Inline/stdin input now creates content-addressed files in `~/.hankweave-cache/inputs/`
  - Same content produces same hash, enabling proper resume with `--execution`
- **`--ignore-data-mismatch` flag** (PR #84)
  - Allows resuming executions when data has intentionally changed
  - Shows warning but continues instead of failing
  - Properly relinks `read_only_data_source` to new data

### Changed

- **Renamed `recommendations` to `overrides` in hank.json** (PR #82)
  - `hank.json` files now use `overrides` instead of `recommendations` for model/settings
  - Old files with `recommendations` will need to be updated
- **Model override now actually works** (PR #81)
  - `--model` CLI flag now properly overrides all codon models
  - Override applied at config loading before validation
  - Simplified architecture: override logic centralized in `loadHankFile()`

### Fixed

- **Better validation error messages for hank files** (PR #80)
  - Errors now show codon ID and name for context
  - Unknown fields get "Did you mean X?" suggestions for common typos
  - Example: `systemPromptFile: Unknown field. Did you mean "appendSystemPromptFile"?`

## [0.1.43] - 2026-01-21

### Changed

- Temporarily disabled OIDC for public npm publishing (requires public package visibility)

## [0.1.42] - 2026-01-21

### Fixed

- Release script improvements for better reliability

## [0.1.41] - 2026-01-20

### Added

- **Public release infrastructure** (PR #79)
  - Two-repo model: private development, public release mirror
  - `hankweave` npm package now available publicly
  - Sync workflow transforms private repo → clean public releases
  - Internal files (`intermediates/`, `CLAUDE.md`, etc.) stripped from public releases

## [0.1.40] - 2026-01-20

### Changed

- Reverted to token-based npm publishing (OIDC requires public package)

## [0.1.39] - 2026-01-20

### Changed

- Switched to npm trusted publishing (OIDC) for secure, token-less releases with provenance attestation

## [0.1.38] - 2026-01-19

### Added

- `--version` CLI flag for printing version number without banner
- Debug directory support for shims (`--debug-dir` flag, logs stored in `.hankweave/logs/shim-debug/{codon-id}/`)

### Changed

- Package configuration:
  - Removed LICENSE field from package.json
  - Added homepage link to Terms of Service
  - Excluded README.md and LICENSE from published package files
  - Increased minimum Node.js version from 18.0.0 to 20.0.0
- Gemini shim consolidated to single `index.js` file (removed `index.mjs` and standalone README)
- Init command E2E test timeouts adjusted for reliability

## [0.1.36] - 2026-01-14

### Added

- Contributing documentation (CONTRIBUTING.md) with branch model and release workflow
- Comprehensive validation mode that performs preflight checks without creating directories
- Tests for validation mode behavior and data source overwriting
- Pre-flight checks in release script: branch verification, remote sync, and changelog validation

### Changed

- Improved execution directory behavior: `--start-new --force` now properly overwrites `read_only_data_source` link
- Refactored validation logic into separate `validate-command.ts` module for better separation of concerns
- Enhanced release automation with develop → release/alpha merge workflow
- Release script now validates changelog content before releasing
- CI now runs on both `develop` and `release/alpha` branches
- Config change warnings now skip when using `--start-new` (user explicitly wants fresh execution)
- Help text clarifications for `--validate`, `--start-new`, and `--force` flags

### Fixed

- Validation mode no longer creates execution directories (regression from ENG-90)
- Data source link now properly refreshed when using `--start-new --force` with different data

## [0.1.35] - 2026-01-13

### Changed

strandweave -> hankweave

## [0.1.34] - 2026-01-13

### Added

- CLI parser with modern space-separated flag syntax (`--flag value`) and comprehensive validation
- Remote strand support: run strands directly from Git URLs (GitHub, GitLab, Bitbucket)
- Remote strand caching system with TTL-based refresh for branches
- Prompt frontmatter: YAML metadata support in prompt markdown files (name, description, tags, version, author)
- Inline text input via `--input <text>` flag for quick data passing
- Stdin support for data input via `--data -` or positional `-` argument
- `--force` flag for running in existing directories with .strandweave/ (creates backups)
- Config change detection on resume with SHA-256 hash tracking and user warnings
- Positional argument support for strand and data paths with smart inference
- Non-interactive mode detection for CI/CD environments (respects CI env vars, test mode, TTY checks)
- Three-tier directory safety validation with user confirmation prompts
- Comprehensive CLI parser tests with 900+ lines of test coverage
- Version banner on startup showing Strandweave version

### Changed

- **BREAKING**: Renamed `trackedFiles` to `checkpointedFiles` in configuration schema for clarity
- TUI now enabled by default (use `--headless` to disable, replaces old `--basic` flag)
- CLI flag syntax: space-separated now preferred (e.g., `--port 8080` instead of `--port=8080`)
- Deprecated `--flag=value` syntax with migration warnings (still supported for backward compatibility)
- Improved help text with examples, positional argument documentation, and remote URL usage
- Execution setup enhanced with directory existence checks and user prompts
- Confirmation prompts now timeout after 30 seconds to prevent hangs
- Help text now shows both positional and flag-based argument formats

### Fixed

- Confirmation prompts now respect non-interactive environments (CI, tests, pipes)
- Directory safety validation with user prompts before potentially destructive operations

## [0.1.33] - 2026-01-12

### Added

- Verdaccio integration for local npm registry testing
- E2E test suite for package installation and executables
- Test utilities for binary file comparison and executable validation
- CI/CD workflows for automated building, testing, and publishing
- Support for testing executables on Linux x64/ARM64, macOS Intel/Apple Silicon, Windows x64

### Changed

- Improved test infrastructure with HankweaveServerTestInstance class
- Updated CI/CD workflows with comprehensive platform matrix testing
- Enhanced error handling and logging throughout runtime extraction

### Fixed

- Test helper utilities for cross-platform compatibility

## [0.1.32] - 2026-01-12

## [0.1.31] - 2026-01-12

## [0.1.30] - 2026-01-12

## [0.1.29] - 2026-01-12

## [0.1.28] - 2026-01-12

## [0.1.27] - 2026-01-12

## [0.1.26] - 2025-01-10

### Added

- NPX package distribution support
- Standalone executables for Linux (x64/ARM64), macOS (Intel/Apple Silicon), and Windows
- Runtime abstraction for Bun, Node.js, and Deno runtimes
- Embedded Claude Agent SDK and shim files in executables with runtime extraction
- CI/CD infrastructure for automated building, testing, and publishing
- Docker-based testing for executables
- Verdaccio integration for local npm registry testing
- Comprehensive E2E tests for package installation and executables

### Changed

- Package name to `@southbridgeai/hankweave` for scoped npm publishing
- Entry point from `server/index.ts` to `dist/index.js` (built artifact)
- Init command templates now inlined as strings (removed template files)
- Server implementation to use runtime-agnostic WebSocket abstraction
- Switched to Haiku for init command (cost-effective default)

### Fixed

- Windows file locking issues with retry logic
- Cross-platform path handling in build scripts
- Binary extraction on different platforms
