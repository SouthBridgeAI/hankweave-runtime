# Testing Hankweave

How the test suite works, what it defends, and where your new test goes. The
short operational version lives in `standard-operating-procedures.md` §6; this
is the full picture, including the reasoning, so the next person changes the
system instead of accreting around it.

Last grounded: 2026-07-26, v0.7.5+, 27 suites / ~2,400 tests, parallel runner.

---

## Philosophy

Five rules carry everything else. Each one was earned, not decreed — the
receipts live in `intermediates/53-e2e-test-suite/*.md`.

1. **Every test file is claimed, or the run fails.** The manifest
   (`tests/suite-manifest.ts`) declares every suite; `resolveSuites()` throws
   if a `*.test.ts` exists that no suite claims. Before this rule, twenty of
   twenty-four e2e files were simply never referenced by anything — not
   skipped, not quarantined, invisible.

2. **Tier declarations are enforced, not documentary.** The runner strips
   every provider API key from a suite's environment unless the suite declares
   it (`needsEnv` gates and grants; `optionalEnv` grants without gating). A
   test that reaches for an undeclared provider fails at the point of the lie.
   Before enforcement, the "free" tier made real LLM calls on every CI push
   for months — the cost meter couldn't see it because the tests deleted their
   own execution directories.

3. **Assertions defend contracts, or they go.** A wall-clock threshold under
   CI load, an `expect` inside `try{}catch{console.error}`, a latency bound
   mathematically unreachable given its own search window — all of these
   shipped here once, and all were worse than no assertion, because they
   manufactured either flakes or false confidence.

4. **The event stream is a lossy view; state is authoritative.** The server
   broadcasts only to clients past their handshake, and autostart wins that
   race (measured: always, in headless). Exact counts — loop arity, extension
   counts — are asserted from `server.getState()`; event-stream counts are
   `>=` with the race named in a comment. Never "tighten" those back.

5. **Waits are conditions, not sleeps.** `waitForEvent`, `waitForState`,
   `waitForCondition`, `waitForPortFree`. A fixed sleep is permitted only for
   a *negative* assertion (proving nothing arrives in a window) or a genuine
   timer semantic, and must carry a comment saying so. The runtime itself had
   a hidden 2-second sleep per codon completion that was ~35% of the offline
   tier's wall time; it is gone, replaced by an explicit parser drain + state
   queue wait.

## The tiers

Cost and isolation classes, cheapest first. Tiers are what CI selects on.

| Tier | What it is | Keys | Cost |
| --- | --- | --- | --- |
| `unit` | pure logic, mocks only, no network | none | $0, enforced |
| `integration` | component wiring, mock/local-mock providers | none | $0, enforced |
| `e2e-offline` | full runtime + real servers, driven by replay logs, built fixtures, or wiring-only configs | none | $0, enforced |
| `e2e-live` | full runtime against real provider APIs (haiku + gemini flash) | `ANTHROPIC_API_KEY`, most also `GEMINI_API_KEY` | cents |
| `e2e-heavy` | npm registry, compiled binaries, multi-provider health | varies | ~$0.15 |
| `e2e-marathon` | deliberately hours and dollars (context exhaustion) | `ANTHROPIC_API_KEY` | ~$1.50 |

"Enforced" means structural: a unit test
(`tests/unit/suite-manifest-contracts.test.ts`) asserts every free-tier suite
declares `estCostUsd: 0` and no `needsEnv`, and the runner deletes all provider
keys from those suites' environments. Free means free even when CI injects
secrets into the job.

## The runner

`bun scripts/test-suite.ts`, driven entirely by the manifest.

```
bun run test          # the three free tiers      (~1m40s parallel, $0)
bun run test:live     # e2e-live                  (~15 min, ~$1.2)
bun run test:heavy    # e2e-heavy                 (~2 min, ~$0.15)
bun run test:long     # e2e-marathon              (human-started, never CI)
bun run test:all      # everything
bun run test:list     # print + price any plan without running it
```

Flags: `--tier <list|all>`, `--filter <substring>`, `--retries <n>` (default
0 — flakes are surfaced, not masked), `--bail`, `--max-cost <usd>`,
`--max-time <seconds>`, `--concurrency <n>` (default: auto — see below),
`--run-id <id>`.

What the runner guarantees:

- **One `bun test` subprocess per suite**, in its own process group, with a
  wall-clock ceiling — a wedged server cannot take the run with it, and a
  SIGKILL takes the servers down too.
- **Key enforcement** per suite, as above (`buildSuiteEnv` — exported, unit
  tested).
- **`HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL=100`** for every suite (production
  default is 1000ms; tests want tight completion latency). Suites can override
  via their `env`.
- **Output adapts to where it lands** (`NO_COLOR` > `FORCE_COLOR` > `TERM=dumb` > TTY):
  - *Rich terminals* (TTY, `TERM≠dumb`): an animated status block at ~8 fps —
    spinner, one row per running suite (elapsed vs measured estimate, tests
    streamed, source files), the queue, and a run line (done, workers, clock
    vs plan). Redrawn in place with the cursor hidden (restored on exit and
    signals); every row is ANSI-aware clipped to the terminal width. Test
    markers count at line start only — server output echoed mid-line can
    contain `(fail)` tokens.
  - *GitHub Actions*: static `start`/result lines with 16-color ANSI (GH
    renders them), plus a `::error file=…::` annotation per failed suite that
    surfaces in the PR checks UI with the failing test names, log path, and
    triage pointer.
  - *Dumb terminals, redirects, generic CI, hub logs*: the same static lines
    with zero escape codes — `[n/N]` counters, and failures always print
    their log path inline.
- **Limits are a brake, not a filter.** `--max-cost`/`--max-time` decline a
  suite whose *declared estimate* would breach the budget, and a limit firing
  exits non-zero — a run that quietly did less than asked must not report
  success. To exclude expensive suites, select tiers; don't cap cost.
- **Parallel by default.** Concurrency auto-resolves to min(4, suites,
  cores/2) — the configuration measured stable across full sweeps — and long
  suites are scheduled first (LPT), so wall time approaches the longest
  suite: the free tier runs in ~1m40s (sequential: ~5m15s), the full
  everything-below-marathon sweep in ~7 minutes (sequential: ~24).
  `--concurrency 1` restores sequential. With paid suites, per-suite spend
  reports "—" — attribution needs an exclusive measurement window — while
  the run-level total stays measured. Skips for missing credentials stay
  green and are named in the report.
- **A residue sweep + health preflight** runs before every suite. Root cause
  (intermediates/56): leftover `tests/test-area` execution dirs carry
  installed node_modules trees; past ~280k directories, `bun test`'s
  discovery crawl holds >10,237 open dirfds — and past exactly that count,
  Bun spawns every child with CLOSED stdio (output vanishes, exit codes
  still arrive; once read as 30+ phantom failures across unrelated suites).
  The runner sweeps aged (>1h) test-area entries, then runs a ~1s canary
  (`tests/unit/child-stdio-canary.test.ts`: fd headroom + an actual spawn's
  captured bytes) and aborts with the remediation if it fails, instead of
  producing untrustworthy results.

Outputs land in `.test-runs/<runId>/` (gitignored, `latest/` symlink):
`report.html` (standalone, expandable per-test rows), `summary.md`, greppable
`results.jsonl` (one row per suite; failed rows carry the manifest's
`failureMeans` and `suspects`) and `tests.jsonl` (one row per TEST — suite,
file, name, status, duration, failure type — the file to grep when asking
"which test broke"), full `logs/<suite>.log`, and per-suite junit XML. A
launch failure inside a `beforeAll` carries the server's stderr tail into
the error, because bun's junit records hook failures as `(unnamed)` with no
message.

**When something fails, start at `triage.md`** (also `triage.json` for
machines): per failing suite it renders what the suite defends, what a red
MEANS (the manifest's `failureMeans`), the suspect server/ modules, every
failing test with its assertion diff mined from the log (bun's junit carries
no failure detail — `<failure type="AssertionError" />` is all you get), the
log signal lines, and exact rerun commands. An agent handed only triage.md
can say what broke, why it matters, and reproduce it.

## The suite map

Declared in `tests/suite-manifest.ts` — that file is the source of truth;
this is the guide. Estimates are measured, re-baselined when they drift >25%.

**Free (runs on every push):**

- `unit` — `tests/unit/**` + `tests/utils/**`. Pure logic: config validation,
  budget math, state reducers, parsers, registries. Slowest members are real
  git (checkpoint-git) and deliberate timer semantics (watchdog) — those are
  genuine work, not waste.
- `integration` — `tests/integration/**`. Component wiring against mock
  providers, **including the two local-mock suites that run each harness's
  REAL live path offline**:
  - `pi-local-mock.test.ts` — a real pi codon against a local
    OpenAI-compatible SSE mock (`PI_CODING_AGENT_DIR` + `models.json` with a
    localhost `baseUrl`, `PI_OFFLINE=1`).
  - `claude-sdk-local-mock.test.ts` — a real Claude-SDK codon against a local
    Anthropic Messages SSE mock (`ANTHROPIC_BASE_URL` env passthrough + a fake
    key; note the `--anthropic-base-url` *flag* is only the proxy's upstream
    and does not reach the SDK on the no-proxy path).
  - `claude-sdk-context-exceeded-mock.test.ts` / `pi-context-exceeded-mock.test.ts`
    — the input-overflow probes: the mock returns the provider's REAL
    context-overflow 400 and the tests pin what each harness surfaces (the
    Claude SDK normalizes to "Prompt is too long"; pi passes
    `context_length_exceeded` through) and that a `terminateOn:
    contextExceeded` loop then terminates cleanly.
  - `claude-sdk-compaction-mock.test.ts` / `pi-compaction-mock.test.ts` — the
    auto-compaction on/off discriminators (intermediates/55): the same mock
    stimulus with `autoCompact: true` vs the default proves compaction is
    genuinely off by default (no compact-retry, no summarization traffic, no
    compact_boundary) and genuinely works when opted in (Claude: reactive
    compact-and-retry on the overflow 400; pi: proactive summarize once
    usage crosses `contextWindow - reserveTokens` and history crosses the
    cut point).
  These are the strategic direction: replay tests the replay machinery,
  the mocks test what replay stands in for.
- `e2e-offline` — full runtime, real servers, no providers: `e2e-budget`
  (16 boots, replay fixtures), `e2e-replay-plan-gen` (17-codon production
  fixture), `e2e-replay-output-token-exceeded` (the completion-drain canary —
  it has caught two runtime regressions; treat its failures as runtime
  signals, not test noise), `e2e-replay-context-exceeded` (all four
  `isContextExceeded` shapes — synthetic, error-result, and auto-compaction —
  driving loop termination through the real state machine),
  `e2e-error-classification`,
  `e2e-llm-provider-fallback` (mocked registry — its `-load` sibling was a
  benchmark with the numbers removed and was deleted, its two real contracts
  lifted into the registry unit tests), and
  `e2e-start-new-force-wipe` (wiring-only, `--no-autostart`, keyless config).

**Live (`ANTHROPIC_API_KEY`, most `+ GEMINI_API_KEY` — the default test config's
codon-3 is `pi/google/gemini-2.5-flash`, and the startup self-test requires the
key even when no codon is awaited):**

`e2e-server` (lifecycle, KILL recovery, history sync), `e2e-happy-path` (43
test-groups: checkpoints, events, files, cost — the most model-quality-coupled
suite), `e2e-rollback`, `e2e-loop` (the critical path, ~6 min),
`e2e-codon-extension`, `e2e-sentinel-integration`,
`e2e-sentinel-structured-output` (+optional `OPENAI_API_KEY`),
`e2e-budget-resume` (needs real spend *by construction* — asserts cost
magnitude), `e2e-replay` (records live, then proves replay reproduces it —
the round trip is the point), `e2e-sdk-session` (SDK session contracts),
`e2e-env-in-rig-setup`, `e2e-data-mismatch`, `e2e-resume-auto-managed`
(managed-space guard rails, sandboxed root), `e2e-hw-trace-resume`.

**Heavy:** `e2e-model-override`, `e2e-llm-provider-health` (pings every
provider with a key; extras are `optionalEnv`), `e2e-init-command` (scaffolds
and runs a real hank).

**Marathon:** `e2e-context-exhaustion` — ground truth at the real 200k
boundary, and the live half of the compaction on/off pair. Ingestion-based
(rig-generated corpus, read into a continued session). Test 1 runs with the
default (compaction OFF): the boundary arrives as the provider/SDK overflow
error and the `contextExceeded` loop completes on it, with zero
compact_boundary lines as proof. Test 2 opts in (`autoCompact: true`) and its
iterationLimit loop must cross the boundary via real compaction. ~4m, ~$1.6.
Human-started only.

**Outside the manifest:** cross-runtime smoke tests
(`scripts/run-cross-runtime-tests.ts`, bun/node/deno) run via the CI composite
action, and the init-e2e jobs (normal/npx/binary modes) run as separate CI
jobs with retry — they test installation surfaces, not runtime behavior.

## Where does my new test go?

Decide by what the test *needs*, not what it's about:

1. **No server, no I/O beyond a tmpdir** → `tests/unit/`. Claimed
   automatically (the unit suite claims the directory).
2. **Needs a running hankweave server but no real provider** →
   - replaying a recorded run → `tests/e2e/`, fixture via
     `tests/utils/replay-fixture-builder.ts` (starts with an empty journal —
     safe for `sendPreviousEvents`) or a checked-in
     `tests/fixtures/*-execution` dir (carries the original recording's
     journal — backfill unsafe).
   - exercising the live execution path → `tests/integration/`, against a
     local mock (copy the pattern from either local-mock file).
   - wiring only, no codon ever runs → use
     `tests/config/test-codons-keyless.config.json` and keep it offline.
   Then: either the file lands in a directory-claimed suite (integration) or
   you add a manifest entry (e2e files are claimed individually — the
   unclaimed-file guard will remind you).
3. **Needs a real model** → `tests/e2e/` + a manifest entry in `e2e-live`
   with honest `needsEnv`, `estSeconds`, `estCostUsd`. Ask first whether the
   assertion depends on model *quality* (rare — happy-path's poem checks,
   structured-output's schema compliance) or just on *a* model answering
   (common — then keep it haiku and assert runtime behavior, not content).
4. **Needs infrastructure** (registry, binaries, many keys) → `e2e-heavy`.

House rules for the test body:

- Ports: `getFreePort()` **immediately before** `launchHankweave` — it's a
  handle, not a reservation; never do slow work between the two, never
  hardcode a port. Re-using a port across a stop/relaunch needs
  `waitForPortFree`. The irreducible handle→listen window is absorbed by
  `launchHankweave`'s bounded bind-retry (fresh port on "Is port N in
  use?"), so a lost race costs one respawn, not a suite failure.
- Waits: the helpers in `tests/utils/hankweave-server-test-helpers.ts` and
  `tests/utils/test-helpers.ts`. Timeouts generous (30-60s) — CI is 3-5×
  slower than your machine; the suite ceiling catches true hangs.
- Counting events: exact counts from `getState()`; stream counts `>=`, with
  the reason in a comment. `sendPreviousEvents: true` only against a fresh
  (built) execution dir.
- Sandbox: never touch `~/.hankweave`, `~/.hankweave-executions`
  (`HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR` redirects the managed root), or any
  path outside your tmpdir/test-area.
- Every relaxed assertion (`>=`, dropped bound) names its mechanism in a
  comment, so nobody "fixes" it back into a flake.
- Real git repos (and anything fsync-sensitive) go in `os.tmpdir()`, never
  `tests/test-area`: this repo lives in a synced folder, and a sync daemon
  touching `.git` internals mid-commit failed 25 checkpoint tests in one
  sweep. On this machine `tests/test-area`, `tests/test-results`, and
  `.test-runs` also carry the `com.dropbox.ignored` xattr
  (`xattr -w com.dropbox.ignored 1 <dir>`) — re-apply on new checkouts.

## Recording and replay

Replay fixtures are execution directories: `.hankweave/state.json` + per-codon
JSONL logs. `--replay` copies the directory to a tmpdir and re-feeds the logs
through the real parser/state machinery — no provider contact, self-tests
skipped. Pacing: recorded timestamps capped by `HANKWEAVE_REPLAY_MAX_DELAY_MS`;
fixtures with stripped timestamps run at the `HANKWEAVE_REPLAY_SPEED_MS` floor
(manifest sets 0 for fixture-driven suites). `e2e-replay` is the one suite
that *records live then replays* — that round trip proves current recordings
stay replayable, which a checked-in fixture cannot.

## CI

`.github/workflows/ci.yml` — every PR gets CI, whatever branch it targets
(stacked feature branches included). What runs scales with the event:

- **Always** (any PR event, ~$0.45): lint+tc; free tiers — ubuntu runs
  `unit,integration,e2e-offline` with `max-cost: '0.01'` (a tripwire, not a
  budget — free tiers cannot spend), windows/macos run `unit,integration` as
  portability canaries; plus the paid **smoke pair** on ubuntu
  (`e2e-happy-path` + `e2e-llm-provider-health`, `--retries 1`,
  `--max-cost 0.60`) — the suites that historically catch real integration
  and provider drift first.
- **Full paid sweep** (`e2e-live,e2e-heavy`, ~$1.7, `--max-cost 2.50`) when
  the PR is review-ready — not a draft and no `WIP` in the title
  (word-boundary match, so "wipe" doesn't count) — or when the head commit
  message contains `[full ci]` (works on trunk pushes too), or via manual
  dispatch (`gh workflow run ci.yml -f tiers=… -f max-cost=…`). Renaming a
  PR to drop `WIP`, or flipping draft→ready, triggers the full run without
  a push (`edited`/`ready_for_review` event types).
- **init-e2e packaging families** (normal/npx/binary, 9 legs, real spend)
  only for trunk-bound events: pushes, or PRs targeting develop or
  release/alpha — they defend distribution, not the runtime.
- A push of N commits fires ONE run for the head commit; rapid pushes
  cancel stale runs (`concurrency` + `cancel-in-progress`).

Results land three ways: `::error` annotations pin failing suites to files
in the PR; the job's step summary carries `summary.md` (plus `triage.md` on
failure) inline on the run page; artifacts split into `test-report-*`
(report.html, summary, triage, jsonl — tiny) and `test-logs-*` (forensics,
7-day retention). Bun is pinned in `setup-environment` — bump deliberately
(the fd-cliff incident was a bun-version-specific spawn defect).

The private release workflow runs the same free tiers with the same brake.
**CI's injected API keys are irrelevant to free tiers by construction** —
enforcement strips them; the paid jobs are where they're granted, still
per-suite via `needsEnv`. Marathon never runs in CI — it's `bun run
test:long`, deliberate and local. None of this reaches the public repo:
`sync-public.ts` deletes `ci.yml` and strips `.github/actions` from every
snapshot.

`--retries` is 1 in CI (process-level flakiness on shared runners is real),
0 locally and in flake hunts. A suite that needed its retry is visible in
`results.jsonl` (`attempts: 2`) — check for those when auditing; they are
flakes on parole, not passes.

## Debugging a failure

1. `.test-runs/<runId>/report.html` — expand the suite, read the failure
   message (paper block).
2. `logs/<suite>.log` — the full interleaved server + test output. Server-side
   `[ERROR]`s just before a test failure usually *are* the failure.
3. Reproduce one test: `bun test <file> -t "<name>"` — but know that heavy
   `beforeAll` blocks (replay recordings, rollback scenarios) run even when
   everything is filtered out.
4. For replay suites: the server's own log lives inside the replay tmpdir
   (`$TMPDIR/hankweave-replay-*/.hankweave/logs/server.log`) and is deleted on
   clean exit — copy it mid-run if you need millisecond forensics (gap
   analysis on `CodonFinalCostSet → Creating checkpoint` found a hidden
   2-second sleep; the technique generalizes).
5. Flake hunting: run the suite 3-5× with `--retries 0` and diff
   `results.jsonl`/junit across runs. Cross-run variance >40% on a stable
   machine marks a hidden nondeterministic wait.

## Known limits, on purpose

- **Per-suite cost under concurrency is unattributable** — the meter measures
  a time window; run-level spend is still real. Run paid tiers sequentially
  when you need per-suite numbers.
- **`measureSpendSince` reads `state.json`** — a suite that deletes its
  execution dirs hides from the meter. That's exactly why key enforcement,
  not metering, is the control.
- **Model-quality assertions are quarantined, not eliminated** — happy-path's
  content checks soften for non-Anthropic models (`isNonAnthropicModel`
  hatches, in six test-group files). Swapping cheap models in would silently
  shed those assertions; that trade was evaluated and declined.
- **The `-t` filter trap**: filtering to one test still pays the whole file's
  `beforeAll`. Live-recording suites are the expensive case.

## History

The audit trail — every number above has a reproduction in
`intermediates/53-e2e-test-suite/` (internal repo; stripped from the public mirror):

- `1-inventory-and-triage.md` — making `bun run test` real (4 → 27 suites)
- `2-codon-started-investigation.md` — three wrong diagnoses; the
  autostart-vs-handshake race; why `sendPreviousEvents` isn't a default
- `3-free-tier-honesty.md` — the free tier was never free; key enforcement
- `4-cpu-mystery-and-pi-mock.md` — the hidden 2s/codon sleep; the pi
  local-mock spike
- `5-flake-audit.md` — 28 findings, four fix lanes, the completion drain, and
  the two runtime bugs the faster tests exposed
