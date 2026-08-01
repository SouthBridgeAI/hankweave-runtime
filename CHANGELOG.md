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

## [0.8.0] - 2026-07-31

### Added
- **Parallel, manifest-driven test runner** — `tests/suite-manifest.ts` now declares every suite across six tiers (`unit` → `e2e-marathon`) and fails the run if any `*.test.ts` is unclaimed; 27 suites run, up from 4 (the rest were silently never referenced). `bun run test` runs suites concurrently by default (LPT-scheduled; free tier ~1m40s, was ~5m15s), with per-run reports in `.test-runs/<runId>/`: `report.html` (Southbridge design), `summary.md`, greppable `results.jsonl`/`tests.jsonl`, per-suite logs, and `triage.md`/`triage.json` on failure
- **Test-run budget enforcement** — `--max-cost`/`--max-time` decline suites whose declared estimates would breach the budget (before spending, not after) and exit non-zero when a limit fires; missing-credential skips stay green and are named. `--concurrency` now works with paid tiers. Contract tests pin the manifest invariants (default tier is structurally $0, env-key enforcement)
- **Adaptive live runner output** — rich terminals get an animated in-place status block (per-suite progress vs estimates, queue, run clock); GitHub Actions gets static lines plus `::error` annotations per failed suite in the PR checks UI; dumb terminals and redirects get plain escape-free lines
- **In-process Pi harness** (`server/pi-sdk-manager.ts`) — the Pi coding agent now runs in-process like the Claude SDK instead of as a subprocess shim; its events are translated to the claude-session schema (`server/pi-translation.ts`) and its crashes go through the same retriable/permanent failure policy
- **CI on every PR** — previously only develop-targeted PRs got CI. Now every PR gets lint+typecheck, the free tiers on 3 OSes, and a ~$0.45 paid smoke pair; the full paid sweep (~$1.70) runs when the PR is review-ready, on `[full ci]`, or via manual dispatch. Bun is version-pinned in CI
- **Per-codon `autoCompact` in hank.json** — opt a codon into harness auto-compaction with `"autoCompact": true`; default is off (see the breaking change below). Plumbed to both harnesses
- **Context-exceeded and compaction test coverage, all offline** — replay e2e for every `contextExceeded` detector shape, mock tests proving both harnesses surface provider input-overflow errors detectably, and discriminator tests pinning compaction-on vs compaction-off behavior
- **`HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR` is now honored** — the knob existed but nothing consumed it; all execution-root paths resolve through it, which also fully sandboxes the last tests that touched the developer's real home directory

### Changed
- **BREAKING: context compaction is now OFF by default on both harnesses** — previously both silently auto-compacted at the window (pi even read the developer's `~/.pi/agent/settings.json`, so identical hanks behaved differently across machines). Compaction is now a per-codon opt-in (`autoCompact: true`); with it off, the context boundary surfaces as the provider overflow error — `terminateOn: contextExceeded` loops and `exhaustWithPrompt` codons still complete on it, but codons that previously crossed the window via silent compaction now fail unless they opt in. Spec and behavior matrix: `intermediates/55-compaction-default-off/spec.md`
- **`terminateOn: {type: "contextExceeded"}` works again** — the Claude SDK never surfaces the mid-session overflow error the runtime waited for (it emits a `compact_boundary` and keeps going), so these loops ran forever. `isContextExceeded` now detects overflow error results, auto compaction boundaries (both harnesses), and the legacy synthetic shapes; `exhaustWithPrompt` now stops at the first exhaustion signal, and `iterationLimit` loops absorb compaction and keep iterating
- **BREAKING: shim reorg — exactly two harnesses, both in-process** — removed the gemini-cli, codex, and opencode subprocess shims and all subprocess-shim machinery. Anthropic models run on the Claude Agent SDK; everything else on the embedded Pi agent. Google/OpenAI models route through pi (`gemini-2.5-flash` → `pi/google/gemini-2.5-flash`), `opencode/...` model strings are rewritten to `pi/...` so existing configs keep working, and reasoning-effort suffixes still resolve (passed as pi's `thinkingLevel`)
- **BREAKING: `GOOGLE_API_KEY` removed — set `GEMINI_API_KEY` instead** — one Google key name across every subsystem (sentinel override renames too: `HANKWEAVE_SENTINEL_GOOGLE_API_KEY` → `HANKWEAVE_SENTINEL_GEMINI_API_KEY`). Auth is now key-only: Gemini via `GEMINI_API_KEY` (gemini CLI OAuth gone), OpenAI via `OPENAI_API_KEY` (codex `~/.codex/auth.json` no longer read)
- **Pi sessions are hermetic** — `PiSdkManager` uses an in-memory settings manager, so a developer's personal `~/.pi/agent` compaction/retry/steering settings no longer leak into hank runs
- **TypeScript 7** — compiler upgraded 5.9.3 → 7.0.2 (the Go-native port); `bun run tc` drops ~13.9s → ~0.83s with identical type-checking results. `moduleResolution` is now `bundler` (TS7 removed `node10`), which let the hand-written `pi-ai-compat.d.ts` shim be deleted; `tsconfig.exports.json` pins `rootDir`; `typescript` moved from peer to dev dependencies; the strict-disabling `tests/tsconfig.json` was removed so editors see the same config CI enforces
- `hankweave init` now scaffolds four codons (haiku, gemini, pi, gpt) instead of five; the codex and opencode examples are gone. The gpt example runs on a **ChatGPT subscription** through pi's `openai-codex` provider (`pi login`, credential in `~/.pi/agent/auth.json`) instead of `OPENAI_API_KEY`; CI provisions it from the `CODEX_AUTH_JSON` secret via the new `scripts/codex-auth-to-pi-auth.ts`
- Removed the `@openai/codex-sdk` dependency; added `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` (^0.80.10)
- **Marathon suite restructured from generation to ingestion** — `e2e-context-exhaustion` fills the context window by reading a pre-written corpus instead of generating essays, making it passable for the first time: 2/2 in 3m30s, $1.54. Its second test now proves an `iterationLimit` loop absorbs the compaction boundary under `autoCompact: true`

### Fixed
- **Network connection failures now classify as retriable** — "unable to connect", "fetch failed", and `ENOTFOUND`/`EAI_AGAIN`/`ECONNABORTED` previously fell to the unrecognized bucket at the pre-session gate, so a network blip at codon startup bypassed `onFailure: "retry"` and killed the run. The default test config's Gemini codon now carries a retry policy so transient blips self-heal
- **Rollback racing a codon completion crashed the runtime** — `handleCodonComplete` dereferenced `currentCodon` after several awaits; a rollback landing in that window caused an unhandled TypeError and a hung client. Also fixed a TUI crash on `state.snapshot` events with null `totalCost`
- **Every codon completes ~2s sooner** — the fixed "log parser catch-up" sleep in `handleCodonComplete` is replaced by an on-demand parser drain plus an explicit wait for pending state transitions (gap now 7ms median)
- Welcome wizard: Google key detection and credit validation now resolve the same key value, so a `GEMINI_API_KEY`-only setup no longer passes detection and then fails validation
- **Test-suite reliability overhaul** — a deep flake audit (28 static findings + artifact mining) fixed assertions that could never fail, port TOCTOU races, colliding execution directories, lossy event-stream counts, and tests touching real home-directory state; ~36s of blind sleeps became condition waits; two test files that had never run anywhere now run; mis-tiered live tests moved out of the free tier; new replay pacing knobs (`HANKWEAVE_REPLAY_MAX_DELAY_MS`, `HANKWEAVE_REPLAY_SPEED_MS`) cut minutes from offline suites. Proven with three consecutive full sweeps at `--concurrency 4`: 26/26 suites × 3, zero failures across 2,400 tests

## [0.7.5] - 2026-07-20

### Added
- `gpt-5.6` now resolves to `gpt-5.6-sol` via a registry model shortcut, in every spelling: bare (`gpt-5.6`), provider-qualified (`openai/gpt-5.6`), effort-suffixed (`gpt-5.6-high`, `gpt-5.6-xhigh`), and combined (`openai/gpt-5.6-xhigh`). OpenAI ships `gpt-5.6` as sibling variants (`-sol`/`-luna`/`-terra`) and codex has no abstract `gpt-5.6` slug, so any spelling that would strip down to bare `gpt-5.6` at the shim would fail at runtime despite resolving successfully in the registry (the auto-generated effort variants of the abstract record made this reachable). Explicit variant ids (`gpt-5.6-luna`, `gpt-5.6-sol-xhigh`, …) are unaffected. Codex 0.144.6 supports `high`/`xhigh` for all three variants; the shim's no-suffix default remains `high` (codex's own defaults are lower: sol `low`, luna/terra `medium`)
- Kimi K3 (`kimi-k3`, `moonshotai/kimi-k3`) is automatically routed through the pi shim's OpenRouter provider (`pi/openrouter/moonshotai/kimi-k3`, authenticated via `OPENROUTER_API_KEY`). Bare and Moonshot-org-qualified spellings (`moonshot/…`, `moonshot-ai/…`) are normalized to the OpenRouter-canonical `moonshotai/kimi-k3`; strings already carrying a shim prefix are left untouched

### Changed
- Updated model data — refreshed `models-dev-data.json` from models.dev (167 providers, 5,517 models). Adds `openai/gpt-5.6`, `openai/gpt-5.6-luna`, `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, `openai/gpt-realtime-2.1`, and `google/gemini-omni-flash-preview`. Drops 12 upstream-removed Anthropic snapshots (`claude-3-5-sonnet-20241022`, `claude-3-opus-20240229`, `claude-opus-4-0`, `claude-sonnet-4-20250514`, …). Updated `llm-provider-registry` unit test expectations accordingly (assertions repointed to `claude-sonnet-4-5-20250929`, which has identical pricing)
- Updated `@openai/codex-sdk` to 0.144.5 (root and codex shim) and rebuilt the codex shim — required for the `gpt-5.6-*` models, which OpenAI rejects on codex < 0.144 ("requires a newer version of Codex")
- Updated `@earendil-works/pi-coding-agent` to 0.80.10 and rebuilt the pi shim. 0.80.8 replaced the SDK's synchronous `AuthStorage`/`ModelRegistry` pair with the async `ModelRuntime` facade (`AuthStorage` is no longer exported), so the shim's session setup and env-key injection were migrated to `ModelRuntime.create()` + `setRuntimeApiKey()`
- Updated `@anthropic-ai/claude-agent-sdk` to 0.3.212, then 0.3.215
- Updated `@openai/codex-sdk` to 0.144.6 (root); `CODEX_SDK_VERSION` bumped to match, now enforced by a unit test that compares it against the package.json pin so future SDK bumps can't leave it stale

### Fixed
- `CODEX_SDK_VERSION` in `server/codex-runtime-extractor.ts` was stale at `0.144.1`: compiled binaries extract the embedded codex binary to `~/.hankweave/codex-sdk/<version>/` and skip extraction when that directory's completion marker already exists, so users upgrading a standalone binary silently kept the old codex. Now stamped `0.144.5` to match the shipped SDK
- `CLAUDE_SDK_VERSION` in `server/claude-runtime-extractor.ts` was stale at `0.3.156` — the same upgrade bug as the codex constant below: users upgrading an already-used standalone binary silently kept the previously extracted Claude native runtime, pairing the new JS SDK with a stale executable. Now stamped `0.3.215` and enforced by a unit test against the package.json pin (same guard as codex)
- Compiled binaries now embed and extract `codex-code-mode-host` beside the codex binary. Codex ≥ 0.144 spawns this companion V8 runtime as a sibling of its own binary for models whose metadata declares `tool_mode: "code_mode_only"` (the `gpt-5.6-*` variants), so tool calls on those models failed with "failed to spawn code-mode host … No such file or directory" in standalone-binary mode. `needsCodexExtraction()` also checks for the host, so host-less caches from older Hankweave builds re-extract

## [0.7.4] - 2026-07-03

### Added
- GLM models (`glm-5.2`, `zai/glm-5.2`, …) are automatically routed through the pi shim's native Z.AI provider (`pi/zai/<id>`, authenticated via `ZAI_API_KEY`). The pi shim now recognizes the `zai` credential

### Changed
- Zhipu AI (`zhipuai`) is now the preferred/canonical provider for GLM models in the registry (`zai`/`Z.AI` is its international brand), so a bare `glm-*` id resolves deterministically to `zhipuai/...` instead of to whichever reseller happens to load last in the models.dev data. Runtime execution still routes through the pi shim's `zai` provider, since the pi SDK has no `zhipuai` provider
- Updated model data — refreshed `models-dev-data.json` from models.dev (147 providers, 5,109 models). Adds `anthropic/claude-sonnet-5` (Claude Sonnet 5, released 2026-06-30), now the most-recent Anthropic Sonnet, so the `sonnet` shortcut and fuzzy matches resolve to it instead of `claude-sonnet-4-6`. Also drops the upstream-removed `claude-3-5-haiku-20241022`/`claude-3-5-haiku-latest` aliases. Updated `llm-provider-registry` unit test expectations accordingly
- Updated `@openai/codex-sdk` to 0.142.4 (root and codex shim) and rebuilt the codex shim
- Updated `@earendil-works/pi-coding-agent` to 0.80.3

### Fixed
- 

## [0.7.3] - 2026-06-23

### Added

- DeepSeek provider support: `deepseek` is now a first-party provider. DeepSeek exposes an OpenAI-compatible API, so the registry reuses the OpenAI factory pointed at `https://api.deepseek.com` (override with `DEEPSEEK_BASE_URL`), authenticated via `DEEPSEEK_API_KEY`. `languageModel()` is routed to `/chat/completions` (DeepSeek doesn't implement the newer Responses API), so health checks and direct `generateText` calls work. Any `deepseek`-named model resolves to this provider rather than a reseller. The previous custom deepseek shim was removed in favor of routing through pi
- `--validate` now warns when a loop-body codon aborts on failure (the default `onFailure: "abort"`): a single transient blip on any iteration (idle-timeout abort, one-off provider error) halts the entire loop run, so the warning suggests `onFailure: "retry"` (with `retryConfig`) or `"ignore"` instead
- Shared API error classifier (`server/error-classification.ts`): single source of truth for whether an API failure is retriable, used by both the runtime's result-message handling and CodonRunner's extension logic
- Default stream-inactivity timeout (180s) for Claude SDK sessions; previously the SDK path had no inactivity bound when `shimIdleTimeout` was unset, so a hung streaming connection waited until the OS killed the socket
- `--no-wipe` flag: with `--start-new --force`, preserves the existing `agentRoot/` workspace instead of wiping it, so files injected directly into `agentRoot/` (without going through `data/`) survive a forced fresh start.

### Changed
- Transient API errors (socket drops, connection resets, 5xx/overloaded, timeouts, rate limits) are now classified retriable, so `onFailure: "retry"` fires on them; unrecognized API error text defaults to retriable (bounded by `retryConfig.maxAttempts`). Auth, invalid-request, billing/credit/quota, and provider usage-limit caps (`GoUsageLimitError`/`FreeUsageLimitError`, "usage limit", "available balance", "out of budget") remain non-retriable so retries don't burn attempts on a depleted plan/balance
- Explicit rate-limit signals (`429` / `rate_limit`) now take precedence over the broad billing/quota match, so a transient per-minute rate limit whose body also mentions "quota" stays retriable instead of being marked permanent
- Transient-crash retry is now generalized across all runtimes: a process that exits/crashes without a usable result message (Claude SDK mid-stream crash, or an early/pre-init gemini/pi/opencode shim exit) is given a bounded-retriable backstop reason instead of defaulting to non-retriable, so `onFailure: "retry"` is honored uniformly (cc-500 failure class)
- Permanent SDK API failures (billing/auth/400) now route through the codon failure policy via the normal exit path rather than an immediate fatal shutdown — so failed-state is recorded and a codon configured `onFailure: "ignore"` continues instead of being force-aborted
- Idle-timeout aborts now write a synthetic error result to the session log, surfacing as a retriable timeout failure (previously: failed with no failure reason, resolved as non-retriable)
- In headless mode, a retriable failure under `onFailure: "abort"` now fails and shuts down instead of parking in "stay-active" (no interactive client will ever issue a manual retry, so the run would otherwise hang forever). A new `SHUTDOWN_WATCHDOG_MS` (30s) backstop force-exits the process if any awaited shutdown step (process kill, sentinel/telemetry flush, pending state transitions, event-journal drain) wedges, so a detected-fatal run can never hang indefinitely

### Fixed

- Disguised SDK errors (result `subtype="success"` with `is_error=true`, e.g. transport failures) aborted runs configured with `onFailure: "retry"` without any retry attempt
- Disguised SDK errors no longer set `successResultReceived`, so the SDK's subsequent thrown error is reported as a real failure instead of being suppressed as a "post-success SDK error"
- The SDK emitting a retriable error result and *then* throwing is now decided by retriability of the classified reason, not by whether a result arrived, so it routes to the retry path instead of a fatal abort
- Local shim/replay process failures (missing `node`/`bun`, bad cwd, unexecutable shim) now stay fatal instead of being misclassified as retriable API crashes — only the Claude SDK manager's `error` event carries API/transport crashes
- `codon.completed` reported `exitStatus: {type: "success"}` for failed codons whose process exited 0 (disguised errors); `exitStatus` is now derived from the codon's final status
- `--start-new --force` now wipes the existing `agentRoot/` workspace when reusing an execution directory, so stale outputs from a prior run no longer leak into the fresh start. The prior `.hankweave/` is still preserved as a `.hankweave.backup-*`.
- Run wedged after a codon retry succeeded: `StateManager.getCodonRecord` returned the *first* record for a codon ID, which was the failed attempt's terminal record after a retry appended a new one. Callers like `handleCodonComplete` saw `status: "failed"` and early-returned, so the running record never advanced to completed. It now returns the *latest* record, mirroring the `CodonTransitioned` reducer
- Cost tracking could not compute cost for prefixed model IDs: `CostTracker` now takes a `ModelInfo` and builds a `providerId/modelId` pricing key (bare model ID for passthrough shim providers like pi/opencode), so registry pricing lookups resolve instead of silently yielding $0


## [0.7.2] - 2026-06-10

### Added
- 

### Changed
- Updated `@anthropic-ai/claude-agent-sdk` to 0.3.170
- Updated `@openai/codex-sdk` to 0.139.0 (root and codex shim)
- Updated `@earendil-works/pi-coding-agent` to 0.79.1 and rebuilt the pi shim (model catalog now includes `anthropic/claude-fable-5`)

### Fixed
- `bun run test` readiness check rejected the project root after the package was renamed to `@southbridgeai/hankweave`

## [0.7.1] - 2026-06-03

### Added
- 

### Changed
- 

### Fixed
- 

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

## [0.6.2] - 2026-03-19

### Added

- **Exported public types and schemas** — `server/exports/types.ts` and `server/exports/schemas.ts` expose a stable set of runtime types and Zod schemas for use by external consumers. A dedicated `tsconfig.exports.json` and updated build script generate the exports bundle.

### Changed

- **Updated model data** — Refreshed `models-dev-data.json` with latest provider model entries (March 2026). (ENG-225)
- **Codex shim API key logic consolidated** — `resolvedApiKey`, `apiKeySource`, and `isAuthConfigured` are now readonly getters on `CodexShim`, replacing scattered utility functions. Key priority order is explicit and tested: `OPENAI_API_KEY` > `CODEX_API_KEY` > `~/.codex/auth.json`. Unit and integration tests cover all priority combinations.

### Fixed

- **Codex shim falls back to SDK bundled binary when `codex` not on PATH** — `resolveCodexPath()` previously called `writeStartupError` if `which codex` failed, blocking the SDK's own `findCodexPath()` from running. In CI, codex is not on PATH but is available via npm platform packages. Now passes `null` to the Codex constructor so it can resolve the binary itself; self-test also tries `tryFindSdkBundledCodex()` as a fallback.
- **Codex shim `WebSearch` defers `tool_use` emission until `item.completed`** — WebSearch items arrive with `query: ""` at `item.started`; the real query only appears in later streaming chunks. Deferring emission ensures transcript logs record a non-empty query.
- **Codex warnings no longer thrown as errors** — The shim previously threw on any non-fatal warning message from Codex, causing spurious failures. Warnings are now logged and ignored.
- **Codon failure classification reads `msg.result` instead of `msg.error`** — `ResultMessage` has no `error` field; error text lives in `msg.result`. Reading `msg.error` always yielded `undefined`, so every error result was classified as `{ type: "unknown", retriable: false }`, including retriable timeouts and rate-limit errors.
- **Loop codons funded via hank proportional shares now route correctly** — When a hank used proportional allocation with a named share for a loop but the loop had no explicit `budget` field, `loopContext.loopBudget` was `undefined`. The routing condition fell through to `resolveHankScopedLimits`, which looked up shares by codon ID instead of loop ID, yielding a $0 allocation. Now synthesizes an implicit `loopBudget: {}` so the correct loop-scoped path is taken.

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
