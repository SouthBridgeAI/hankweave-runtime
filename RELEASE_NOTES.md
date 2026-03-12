## [0.6.1] - 2026-03-12

### Added

- **Execution budget system** — Per-codon and per-hank cost, time, and token limits with automatic enforcement. Four budget currencies: `maxDollars` (cost cap), `maxTimeSeconds` (wall-clock cap), `maxOutputTokens` (cumulative output token cap), and `maxContextTokens` (context window high-water mark cap). Budgets are declared in `hank.json` under a `budget` object at the hank level, loop level, or codon level.
- **Budget allocation modes** — Three strategies for distributing a global budget among codons: `shared` (default, first-past-the-post — each codon draws from the full remaining pool), `proportional` (share-based with explicit percentages via a `shares` map; unspent budget flows back to the pool), and `proportional-strict` (share-based but unspent budget evaporates). Allocation mode is set on the parent container's `budget.allocation` field.
- **`--max-cost` and `--max-time` CLI flags** — Runtime-level budget overrides. `--max-cost 5.00` caps the entire run at $5; `--max-time 3600` caps it at 1 hour. CLI values act as a ceiling — they cap but never raise hank-declared limits.
- **`onExceeded` budget policy** — Configurable behavior when a limit is hit: `"complete"` (default) marks the codon as completed and moves on, `"fail"` marks it as failed and triggers the codon's failure policy. Set per-codon or as a container default.
- **Loop-level budgets** — Loops can declare their own `budget` with `maxDollars`, `maxTimeSeconds`, allocation mode, and shares. Codon caps within loops are per-iteration (not cumulative across iterations).
- **Active watchdog timer for time budgets** — A 1-second interval timer checks wall-clock elapsed time independently of cost events, ensuring `maxTimeSeconds` is enforced even when the model is silently thinking with no token events.
- **Budget preflight validation table** — `--validate` now displays a table showing the resolved budget for each codon: ceiling source, allocation mode, per-codon limits, and any warnings (e.g., shares that don't sum to 1.0, unknown codon IDs in shares maps).
- **End-of-run budget summary table** (`budget.summary` event) — When a run completes, a summary table is emitted showing per-codon budget vs. actual usage (dollars, time, output tokens), codon status, and whether any limits were exceeded. The TUI renders this inline before the shutdown summary.
- **Budget hydration on resume** — When resuming a run, the budget system hydrates prior spending and elapsed time from completed runs so allocation calculations account for money and time already spent.
- **Pi agent harness shim** (`shims/pi/`) — New shim enabling hanks to run on the Pi agent. Includes session management, provider auth, a translator for the Hankweave message protocol, idle watchdog, and debug recording.
- **OpenCode agent harness shim** (`shims/opencode/`) — New shim enabling hanks to run on the OpenCode agent. Includes agent orchestration, model resolution, prompt building, tool handling, and self-test.
- **Shared shim common package** (`@shims/common`) — Extracted arg parsing, message protocol types, session management, idle timeout logic, and tool definitions into a shared package used by all shims.
- **OpenCode codon in `--init` template** — `hankweave --init` now scaffolds an OpenCode codon alongside the existing Haiku, Gemini, Codex, and Pi codons.
- **Package sanity check in release script** — The release dry-run now runs `npm pack --dry-run` and validates file count (<500), unpacked size (<30MB), and checks for `node_modules` leaking into the tarball. Catches packaging errors before they reach npm.

### Changed

- **Codex shim rewritten** — The codex shim has been substantially rewritten to use the shared `@shims/common` package, with full source and build infrastructure (`rebuild.sh`, TypeScript sources, docs). Includes improved Windows support with vendored `codex.exe` discovery from npm global installs.
- **Passthrough provider model validation uses real capabilities** — When a model is routed through a passthrough shim (e.g., `opencode/anthropic/claude-haiku-4-5`), the model validator now resolves the underlying model from the registry to get real capabilities (context limits, cost data, modalities) instead of using generic defaults.
- **Budget fields nested in `budget` object** — Codon-level budget fields (`maxDollars`, `maxTimeSeconds`, `maxOutputTokens`, `maxContextTokens`, `onExceeded`) are now nested inside a `budget: {}` object in `hank.json`, rather than being top-level codon fields. Hank-level and loop-level budget config follows the same pattern.
- **`maxDurationSeconds` renamed to `maxTimeSeconds`** — For consistency across the budget spec. Applies to both hank-level and codon-level config.
- **`maxCost` renamed to `maxDollars`** — Clearer naming that distinguishes dollar cost from other budget currencies.
- **Codon budget caps are per-iteration in loops** — A codon's `maxDollars` inside a loop applies fresh to each iteration, not cumulatively across the entire loop.
- **Shared allocation uses first-past-the-post** — In `shared` mode, each codon gets access to the entire remaining pool (not a uniform split). When the pool is exhausted, whoever is running gets stopped.

### Fixed

- **npm publish failed due to shim `node_modules` in tarball** — The Pi and Codex shims' `node_modules/`, `src/`, `tests/`, and build files were being included in the published npm package (36,575 files, 542MB). Added `.npmignore` exclusions for `shims/*/node_modules/`, `shims/*/src/`, `shims/*/tests/`, and other build-time-only files. Only the bundled `index.js` per shim is shipped.
- **Loop budgets in proportional allocations** — Proportional share resolution now correctly accounts for loop-scoped budgets when computing per-codon allocations.
- **Loop time aggregates** — Fixed time tracking aggregation for loops where elapsed time was not correctly summed across iterations.
- **Codon `maxDollars` zeroed when no explicit share and shares sum to 1.0** — When all shares were explicitly assigned (summing to 1.0) and a codon had no share entry, its computed allocation was $0. Now correctly falls through to the unallocated pool calculation.
- **Codon `maxDollars` caps (not overrides) proportional share allocation** — A codon's explicit `maxDollars` now acts as a ceiling on its proportional share, rather than replacing it entirely.
- **Loop-scoped resolution dropping hank dollar limits when loop has no `maxDollars`** — When a loop had no `maxDollars` of its own, the hank-level dollar limit was not propagated to codons inside the loop. Fixed to carry the hank ceiling through.
- **Budget validation table and preflight warnings** — Fixed alignment and content issues in the `--validate` budget table display.
- **TUI label for context token breaches** — The TUI now correctly labels context token budget breaches (was showing wrong currency name).
- **`maxContextTokens` shown in budget table** — The preflight and summary tables now include the context token limit column.
- **Pi shim conflict detection before session prep** — Explicit wait conflict detection (idle timeout vs requested silence) now runs before Pi SDK session initialization, avoiding unnecessary SDK startup on known configuration errors.
- **Pi shim path resolution** — Fixed shim entry point path to use `./index.js` instead of `dist/index.js`.