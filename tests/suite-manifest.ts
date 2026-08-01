/**
 * The inventory of everything `bun scripts/test-suite.ts` knows how to run.
 *
 * Why a manifest instead of globbing test files:
 *
 * - **Nothing drops off silently.** `resolveSuites()` cross-checks the manifest
 *   against what is actually on disk and throws if a test file exists that no
 *   suite claims. Adding `tests/e2e/whatever.test.ts` without classifying it is
 *   a hard error, not a test that quietly never runs. That is precisely how the
 *   e2e tier rotted: `bun run test` named two e2e files explicitly and the other
 *   twenty were invisible.
 * - **Cost and time are declared up front.** `--list` can price a run before
 *   spending anything, and CI can pick a tier that fits its budget.
 * - **Isolation is per-file where it has to be.** Every e2e file spawns real
 *   servers and binds real ports; one wedged suite must not take the rest down.
 *   Unit and integration have no such constraint, so they run as single batches.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/**
 * Cost/isolation classes, cheapest first. Tiers are the unit CI selects on.
 *
 * - `unit`         pure logic, mocks only, no network
 * - `integration`  component wiring against mock LLM providers, no network
 * - `e2e-offline`  full runtime end to end, but driven by replay logs or mocked
 *                  registries — real servers, zero API spend
 * - `e2e-live`     full runtime against real provider APIs (haiku unless noted)
 * - `e2e-heavy`    infrastructure-dependent or frontier-model: npm registry,
 *                  compiled binaries, opus/sonnet. Minutes and cents.
 * - `e2e-marathon` deliberately hours and dollars. Never run by CI; a human
 *                  starts these. Separated from `e2e-heavy` so `--max-cost`
 *                  stays a genuine safety brake rather than a routine filter —
 *                  the runner treats a limit firing as a failed run, because a
 *                  suite silently not running is what this whole exercise is
 *                  about eliminating.
 */
export const ALL_TIERS = [
  "unit",
  "integration",
  "e2e-offline",
  "e2e-live",
  "e2e-heavy",
  "e2e-marathon",
] as const;

export type Tier = (typeof ALL_TIERS)[number];

export function isTier(value: string): value is Tier {
  return (ALL_TIERS as readonly string[]).includes(value);
}

/** Tiers that cost nothing and need no credentials — the default `bun run test`. */
export const DEFAULT_TIERS: Tier[] = ["unit", "integration", "e2e-offline"];

export interface SuiteSpec {
  /** Stable id; names the log, junit and report row. Keep it filename-ish. */
  id: string;
  tier: Tier;
  /** Paths passed straight to `bun test`. */
  files: string[];
  /** One line on what breaks if this suite goes red. */
  description: string;
  /**
   * What a red run of this suite MEANS: the contract that broke and where to
   * start looking. Written for triage — human or agent — and emitted into
   * results.jsonl and triage.md by the runner when the suite fails.
   */
  failureMeans: string;
  /**
   * Repo paths this suite most directly exercises — triage starting points,
   * not an exhaustive dependency list.
   */
  suspects?: string[];
  /**
   * Env vars that must be non-empty, or the suite is skipped (not failed).
   *
   * Also a *grant*: the runner strips every `PROVIDER_KEY_ENV_VARS` entry that
   * is not listed here (or in `optionalEnv`) from the suite's environment, so
   * an undeclared provider dependency fails instead of silently spending.
   */
  needsEnv?: string[];
  /**
   * Provider keys passed through when present, without gating the suite on
   * them. For suites where a subset of tests self-skip on a missing key
   * (e.g. provider health pings) — everything else still runs keyless.
   */
  optionalEnv?: string[];
  /** Extra env for the subprocess. */
  env?: Record<string, string>;
  /** `bun test --timeout`, per individual test. */
  perTestTimeoutMs: number;
  /** Wall-clock ceiling for the whole suite before it is SIGKILLed. */
  suiteTimeoutSeconds: number;
  /** Measured wall time, for `--list` planning and `--max-time` budgeting. */
  estSeconds: number;
  /** Measured spend. Offline tiers are 0 by construction. */
  estCostUsd: number;
}

/**
 * Every env var that can buy an LLM call, from `PROVIDER_DEFINITIONS`
 * (server/llm/provider-config.ts) and `PROVIDER_CREDENTIALS`
 * (server/pi-sdk-manager.ts), plus the removed `GOOGLE_API_KEY` alias which is
 * still set in plenty of shells.
 *
 * The runner deletes every one of these from a suite's environment unless the
 * suite names it in `needsEnv`. That turns `needsEnv` from a comment into a
 * control: a suite that quietly reaches for a provider fails where it lies
 * instead of billing a tier advertised as free. Two mis-tiered suites hid here
 * for months — `replay-e2e` ran live models inside `e2e-offline` and deleted
 * its execution directory afterwards, so even the cost meter saw $0.
 */
export const PROVIDER_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
] as const;

const ANTHROPIC = ["ANTHROPIC_API_KEY"];
/** The default `launchHankweave` config runs codon-3 on `pi/google/gemini-2.5-flash`. */
const ANTHROPIC_GEMINI = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"];

export const SUITES: SuiteSpec[] = [
  // ── unit ────────────────────────────────────────────────────────────
  {
    id: "unit",
    tier: "unit",
    // tests/utils is included because env-test-helpers.test.ts lived there
    // unrun for months — `bun run test` only ever named unit/integration/e2e.
    files: ["tests/unit", "tests/utils"],
    description: "All pure-logic unit tests (mocks only, no network).",
    failureMeans:
      "A pure-logic contract broke — no servers or network involved. The failing test names " +
      "the module (config/schema validation, budget math, state reducers, parsers, error " +
      "classification, checkpoint-git). Suspect the last change to that server/ module, not " +
      "the environment; these are deterministic.",
    perTestTimeoutMs: 15_000,
    suiteTimeoutSeconds: 600,
    estSeconds: 80,
    estCostUsd: 0,
  },

  // ── integration ─────────────────────────────────────────────────────
  {
    id: "integration",
    tier: "integration",
    files: ["tests/integration"],
    description: "Component wiring against mock LLM providers. Keyless by construction.",
    failureMeans:
      "Harness wiring broke offline. The local-mock suites (pi-local-mock, claude-sdk-local-mock, " +
      "*-context-exceeded-mock, *-compaction-mock) pin each harness's REAL live path against a " +
      "local provider: a red usually means a manager/translation regression, or an SDK/pi " +
      "dependency bump changed wire behavior — check whether the failing assertion is about " +
      "what the mock RECEIVED (our side) or what the harness SURFACED (their side). Sentinel " +
      "files here exercise sentinel-manager event routing against mock LLMs.",
    suspects: [
      "server/pi-sdk-manager.ts",
      "server/claude-agent-sdk-manager.ts",
      "server/pi-translation.ts",
      "server/sentinels",
    ],
    perTestTimeoutMs: 60_000,
    suiteTimeoutSeconds: 900,
    estSeconds: 100,
    estCostUsd: 0,
  },

  // ── e2e-offline ─────────────────────────────────────────────────────
  {
    id: "e2e-budget",
    tier: "e2e-offline",
    files: ["tests/e2e/budget.test.ts"],
    description:
      "Budget allocation, exceeded policies and loop budgets — all via replay fixtures, no spend. " +
      "The one carry-over-on-resume test that needs real spending lives in e2e-budget-resume.",
    failureMeans:
      "Budget ENFORCEMENT through the real runtime broke (the math itself is unit-tested): " +
      "Budget exceeded → SIGTERM → onExceeded status wiring, allocation modes, or loop budget " +
      "shares. Replay-driven, so a red is a runtime change, not a provider.",
    suspects: ["server/budget.ts", "server/hankweave-runtime.ts", "server/execution-planner.ts"],
    // Fixtures strip their timestamps, so replay runs at the per-line floor;
    // collapsing it to 0 cut the suite 302s → 253s with 16/16 still green. The
    // remaining minutes are genuine work (16 server boots, checkpointing).
    env: { HANKWEAVE_REPLAY_SPEED_MS: "0" },
    perTestTimeoutMs: 180_000,
    suiteTimeoutSeconds: 900,
    estSeconds: 120,
    estCostUsd: 0,
  },
  {
    id: "e2e-replay",
    // Live, not offline: both describe blocks *record* a run with real models
    // in beforeAll (haiku + gemini + pi), then replay it. That round trip is
    // the point — it proves current recordings replay — but it spends, and it
    // sat in e2e-offline declaring $0 while deleting the execution dirs that
    // would have shown the spend. The free tier's replay coverage comes from
    // the checked-in and built fixtures in the four suites below.
    tier: "e2e-live",
    files: ["tests/e2e/replay-e2e.test.ts"],
    description: "Records a live run, then proves replay reproduces it without a provider.",
    failureMeans:
      "The record-then-replay round trip broke. A failure while RECORDING is a live runtime " +
      "issue; a failure on the REPLAY half means fresh recordings no longer replay — usually a " +
      "log-format or session-schema change that the checked-in fixtures (older recordings) " +
      "don't catch. Check which half failed first.",
    suspects: [
      "server/replay.ts",
      "server/replay-process-manager.ts",
      "server/claude-log-parser.ts",
    ],
    needsEnv: ANTHROPIC_GEMINI,
    // Recorded logs carry the original run's inter-message gaps, which replay
    // faithfully re-waits; the cap collapses them. This suite keeps timestamped
    // pacing exercised — it asserts replay duration tracks the recording.
    env: { HANKWEAVE_REPLAY_MAX_DELAY_MS: "25" },
    perTestTimeoutMs: 300_000,
    suiteTimeoutSeconds: 900,
    estSeconds: 160,
    estCostUsd: 0.04,
  },
  {
    id: "e2e-budget-resume",
    tier: "e2e-live",
    files: ["tests/e2e/budget-resume-e2e.test.ts"],
    description:
      "Budget spending carries over into a continuation run. Needs real spend by construction.",
    failureMeans:
      "Budget carry-over on resume broke: spending from the first run no longer counts against " +
      "the continuation run's limits, or the carried total is wrong. Asserts real cost " +
      "magnitude by construction.",
    suspects: ["server/budget.ts", "server/execution-thread.ts", "server/execution-setup.ts"],
    needsEnv: ANTHROPIC,
    perTestTimeoutMs: 600_000,
    suiteTimeoutSeconds: 1200,
    estSeconds: 30,
    estCostUsd: 0.05,
  },
  {
    id: "e2e-replay-plan-gen",
    tier: "e2e-offline",
    files: ["tests/e2e/replay-plan-gen-e2e.test.ts"],
    description: "Replay of the production plan-gen hank fixture (timestamps stripped at setup).",
    failureMeans:
      "The 17-codon production fixture no longer replays to the same terminal state — a state " +
      "machine, planner, or checkpointing behavior change surfaced at production scale. Diff " +
      "the failing codon's transitions in the log against the fixture's recorded flow.",
    suspects: [
      "server/hankweave-runtime.ts",
      "server/state-manager.ts",
      "server/checkpoint-git.ts",
    ],
    env: { HANKWEAVE_REPLAY_SPEED_MS: "0" },
    perTestTimeoutMs: 300_000,
    suiteTimeoutSeconds: 900,
    estSeconds: 20,
    estCostUsd: 0,
  },
  {
    id: "e2e-replay-output-token-exceeded",
    tier: "e2e-offline",
    files: ["tests/e2e/replay-output-token-exceeded-e2e.test.ts"],
    description: "Output-token budget termination, driven from a replay log.",
    failureMeans:
      "The completion-drain canary fired. This suite has caught two real runtime regressions " +
      "(the codon-completion drain and a running→completed transition skip) — treat a red as a " +
      "runtime signal, not test noise, and look at codon completion/exit handling first.",
    suspects: [
      "server/hankweave-runtime.ts",
      "server/budget.ts",
      "server/replay-process-manager.ts",
    ],
    env: { HANKWEAVE_REPLAY_SPEED_MS: "0" },
    perTestTimeoutMs: 180_000,
    suiteTimeoutSeconds: 600,
    estSeconds: 6,
    estCostUsd: 0,
  },
  {
    id: "e2e-replay-context-exceeded",
    tier: "e2e-offline",
    files: ["tests/e2e/replay-context-exceeded-loop-e2e.test.ts"],
    description:
      "terminateOn:contextExceeded loop termination (both detector patterns) through replay — " +
      "the runtime half of what the live marathon proves, free. See intermediates/54.",
    failureMeans:
      "The exhaustion signal no longer terminates contextExceeded loops through the state " +
      "machine: isContextExceeded detection (types.ts), planner loop-termination priority, or " +
      "handleCodonComplete's status ordering regressed. The offline half of the marathon pair.",
    suspects: [
      "server/types/types.ts",
      "server/execution-planner.ts",
      "server/hankweave-runtime.ts",
      "server/base-process-manager.ts",
    ],
    env: { HANKWEAVE_REPLAY_SPEED_MS: "0" },
    perTestTimeoutMs: 180_000,
    suiteTimeoutSeconds: 600,
    estSeconds: 13,
    estCostUsd: 0,
  },
  {
    id: "e2e-error-classification",
    tier: "e2e-offline",
    files: ["tests/e2e/error-classification-replay-e2e.test.ts"],
    description:
      "API-error classification → failure-policy routing (retry/ignore/abort) through replay.",
    failureMeans:
      "An API error classifies differently (retriable flipped, or a new wording fell into the " +
      "wrong bucket) or resolveFailurePolicy routes the classified reason to the wrong action " +
      "(retry/ignore/abort). Start at classifyApiErrorText and the failing error's exact text.",
    suspects: ["server/error-classification.ts", "server/hankweave-runtime.ts"],
    env: { HANKWEAVE_REPLAY_SPEED_MS: "0" },
    perTestTimeoutMs: 180_000,
    suiteTimeoutSeconds: 600,
    estSeconds: 15,
    estCostUsd: 0,
  },
  {
    id: "e2e-llm-provider-fallback",
    tier: "e2e-offline",
    files: ["tests/e2e/llm-provider-fallback.e2e.test.ts"],
    description: "Provider fallback and degradation against a mocked registry.",
    failureMeans:
      "Provider fallback/degradation order broke against a mocked registry — model resolution " +
      "or fallback selection logic, deterministic and offline.",
    suspects: ["server/llm"],
    perTestTimeoutMs: 30_000,
    suiteTimeoutSeconds: 300,
    estSeconds: 1,
    estCostUsd: 0,
  },

  // ── e2e-live ────────────────────────────────────────────────────────
  {
    id: "e2e-server",
    tier: "e2e-live",
    files: ["tests/e2e/hankweave-server.test.ts"],
    description: "Server lifecycle: start, run codons, history sync, rollback, stop.",
    failureMeans:
      "Live server lifecycle broke: startup, websocket command handling, history sync, KILL " +
      "recovery, or stop. First distinguish assertion failures (regression) from provider-call " +
      "timeouts (outage) — this suite runs real models and reddens on both.",
    suspects: ["server/index.ts", "server/hankweave-runtime.ts", "server/checkpoint-git.ts"],
    // The default test config's codon-3 is pi/google/gemini-2.5-flash, and
    // several tests run it to completion — the Gemini dependency was real but
    // undeclared until the runner started enforcing this list.
    needsEnv: ANTHROPIC_GEMINI,
    perTestTimeoutMs: 300_000,
    suiteTimeoutSeconds: 1200,
    estSeconds: 220,
    estCostUsd: 0.2,
  },
  {
    id: "e2e-happy-path",
    tier: "e2e-live",
    files: ["tests/e2e/happy-path-e2e.test.ts"],
    description:
      "The broad sweep: checkpoints, events, file tracking, cost, telemetry, cleanup (43 test groups).",
    failureMeans:
      "The broad live contract sweep failed — check WHICH group: checkpoints/events/files/cost " +
      "groups are runtime contracts (real regressions); model-output groups are quarantined " +
      "behind isNonAnthropicModel hatches, so 'model produced X' flakes should already be " +
      "impossible. The most model-quality-coupled suite in the tier.",
    suspects: ["server/hankweave-runtime.ts", "server/checkpoint-git.ts", "server/telemetry"],
    needsEnv: ANTHROPIC_GEMINI,
    perTestTimeoutMs: 600_000,
    suiteTimeoutSeconds: 2400,
    estSeconds: 60,
    estCostUsd: 0.05,
  },
  {
    id: "e2e-rollback",
    tier: "e2e-live",
    files: ["tests/e2e/rollback-comprehensive-e2e.test.ts"],
    description: "Rollback across checkpoints, runs and rig cleanup.",
    failureMeans:
      "Rollback broke: checkpoint selection, shadow-git restore, run truncation, or rig " +
      "archive/cleanup on rollback. The shadow repo in .hankweavecheckpoints is the mechanism " +
      "under test.",
    suspects: [
      "server/checkpoint-git.ts",
      "server/hankweave-runtime.ts",
      "server/cleanup-command.ts",
    ],
    needsEnv: ANTHROPIC_GEMINI,
    perTestTimeoutMs: 600_000,
    suiteTimeoutSeconds: 2400,
    estSeconds: 85,
    // Measured $0.286 on the last full paid run — the old 0.08 was fiction.
    estCostUsd: 0.3,
  },
  {
    id: "e2e-loop",
    tier: "e2e-live",
    files: ["tests/e2e/loop-test-e2e.test.ts"],
    description: "Loop expansion, rig failures, iteration telemetry, archive/restore on rollback.",
    failureMeans:
      "Loop machinery broke live: iteration expansion, rig-failure policy inside loops, " +
      "iteration telemetry, or archive/restore interaction with rollback. The critical live " +
      "path (~6 min). Expansion/planning reds → execution-planner/state-manager; rig reds → " +
      "runtime rig setup.",
    suspects: [
      "server/execution-planner.ts",
      "server/state-manager.ts",
      "server/hankweave-runtime.ts",
    ],
    needsEnv: ANTHROPIC,
    perTestTimeoutMs: 600_000,
    suiteTimeoutSeconds: 2400,
    estSeconds: 450,
    estCostUsd: 0.5,
  },
  {
    id: "e2e-codon-extension",
    tier: "e2e-live",
    files: ["tests/e2e/codon-extension-e2e.test.ts"],
    description: "exhaustWithPrompt extension loop and maxExtensions ceiling.",
    failureMeans:
      "exhaustWithPrompt extension broke: extension re-prompting, the maxExtensions ceiling, or " +
      "stopping at context exhaustion. shouldExtendCodon (codon-runner) and SDK session resume " +
      "are the moving parts.",
    suspects: ["server/codon-runner.ts", "server/claude-agent-sdk-manager.ts"],
    needsEnv: ANTHROPIC,
    perTestTimeoutMs: 600_000,
    suiteTimeoutSeconds: 1800,
    estSeconds: 115,
    estCostUsd: 0.12,
  },
  {
    id: "e2e-sentinel-integration",
    tier: "e2e-live",
    files: ["tests/e2e/sentinel-integration-e2e.test.ts"],
    description: "Sentinel load/trigger/output/unload lifecycle against a live codon.",
    failureMeans:
      "Sentinel lifecycle against a live codon broke: load/unload ordering, trigger firing, or " +
      "output writing. Event routing between the runtime and sentinel-manager is the usual " +
      "culprit; sentinel LLM calls themselves are real and can also fail on provider outage.",
    suspects: ["server/sentinels", "server/hankweave-runtime.ts"],
    needsEnv: ANTHROPIC,
    perTestTimeoutMs: 600_000,
    suiteTimeoutSeconds: 1800,
    estSeconds: 30,
    estCostUsd: 0.13,
  },
  {
    id: "e2e-sentinel-structured-output",
    tier: "e2e-live",
    files: ["tests/e2e/sentinel-structured-output-e2e.test.ts"],
    description: "Sentinel structured output (object/array/enum) with real model calls.",
    failureMeans:
      "Sentinel structured output broke: generateObject wiring, schema handling for " +
      "object/array/enum shapes, or a provider changed structured-output behavior. The " +
      "OpenAI-keyed tests self-skip without the key.",
    suspects: ["server/sentinels", "server/llm"],
    needsEnv: ANTHROPIC,
    // Two tests additionally spend a little OpenAI money when a key is around;
    // they self-skip without one, so the key is a pass-through, not a gate.
    optionalEnv: ["OPENAI_API_KEY"],
    perTestTimeoutMs: 600_000,
    suiteTimeoutSeconds: 1800,
    estSeconds: 35,
    estCostUsd: 0.05,
  },
  {
    id: "e2e-env-in-rig-setup",
    tier: "e2e-live",
    files: ["tests/e2e/env-in-rig-setup-e2e.test.ts"],
    description: "Codon `env` reaches rigSetup shell commands.",
    failureMeans:
      "codon.env stopped reaching rigSetup shell commands — the env overlay plumbing between " +
      "codon config and rig command execution regressed.",
    suspects: ["server/hankweave-runtime.ts", "server/utils.ts"],
    needsEnv: ANTHROPIC,
    perTestTimeoutMs: 300_000,
    suiteTimeoutSeconds: 900,
    estSeconds: 10,
    estCostUsd: 0.01,
  },
  {
    id: "e2e-data-mismatch",
    tier: "e2e-live",
    files: ["tests/e2e/data-mismatch-ignore-flag-e2e.test.ts"],
    description: "--ignore-data-mismatch relinks read_only_data_source on resume.",
    failureMeans:
      "--ignore-data-mismatch resume relinking broke: data-source hashing or the resume-time " +
      "relink of read_only_data_source.",
    suspects: ["server/data-hasher.ts", "server/execution-setup.ts"],
    // The default config's codon-3 is gemini: even with no codon awaited, the
    // startup self-test requires the key to be present. Verified the hard way —
    // this suite failed under enforcement with only ANTHROPIC declared.
    needsEnv: ANTHROPIC_GEMINI,
    perTestTimeoutMs: 300_000,
    suiteTimeoutSeconds: 900,
    estSeconds: 10,
    estCostUsd: 0.01,
  },
  {
    id: "e2e-resume-auto-managed",
    tier: "e2e-live",
    files: ["tests/e2e/resume-auto-managed-e2e.test.ts"],
    description: "Resume/guard rails for executions inside ~/.hankweave-executions.",
    failureMeans:
      "Managed-executions guard rails broke: resume/list behavior inside the managed root " +
      "(HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR sandbox). A red often means execution-setup path " +
      "resolution changed.",
    suspects: ["server/execution-setup.ts", "server/index.ts"],
    needsEnv: ANTHROPIC,
    perTestTimeoutMs: 300_000,
    suiteTimeoutSeconds: 1200,
    estSeconds: 30,
    estCostUsd: 0.02,
  },
  {
    id: "e2e-start-new-force-wipe",
    // Offline, not live: every launch passes --no-autostart, so no codon ever
    // runs and no provider is touched. It sat in e2e-live declaring $0.01 —
    // backwards on both axes.
    tier: "e2e-offline",
    files: ["tests/e2e/start-new-force-wipe-agentroot-e2e.test.ts"],
    description: "--start-new --force wipes agentRoot/, and --no-wipe preserves it. No LLM calls.",
    failureMeans:
      "--start-new --force agentRoot wipe wiring broke (or --no-wipe stopped preserving). CLI " +
      "flag plumbing through execution-setup; no LLM involved despite living in tests/e2e.",
    suspects: ["server/execution-setup.ts", "server/index.ts"],
    perTestTimeoutMs: 300_000,
    suiteTimeoutSeconds: 1200,
    estSeconds: 10,
    estCostUsd: 0,
  },
  {
    id: "e2e-hw-trace-resume",
    tier: "e2e-live",
    files: ["tests/e2e/hw-trace-resume-e2e.test.ts"],
    description: "Trace upload fires on SIGTERM and again when the resumed run completes.",
    failureMeans:
      "Trace upload stopped firing on SIGTERM or on resumed-run completion — telemetry " +
      "shutdown-path wiring (uploadTrace) or resume detection regressed.",
    suspects: ["server/telemetry", "server/hankweave-runtime.ts"],
    needsEnv: ANTHROPIC_GEMINI,
    perTestTimeoutMs: 300_000,
    suiteTimeoutSeconds: 900,
    estSeconds: 85,
    estCostUsd: 0.05,
  },
  {
    id: "e2e-sdk-session",
    // Moved out of the integration tier, where these files ran real Sonnet
    // sessions ("Say Hello…", a 500-word essay) under a banner of "mock
    // providers, no network" — on every CI push, on three OSes.
    tier: "e2e-live",
    files: ["tests/e2e/claude-sdk-session-e2e.test.ts", "tests/e2e/pi-sdk-session-e2e.test.ts"],
    description: "SDK manager session contracts (continuation ids, teardown) against live APIs.",
    failureMeans:
      "SDK session contracts broke against live APIs: continuation/session id capture, resume, " +
      "or teardown in one of the two managers. If the offline local-mock suites are green, the " +
      "LIVE session semantics drifted (SDK bump or provider change).",
    suspects: ["server/claude-agent-sdk-manager.ts", "server/pi-sdk-manager.ts"],
    needsEnv: ANTHROPIC,
    perTestTimeoutMs: 300_000,
    suiteTimeoutSeconds: 1200,
    estSeconds: 30,
    estCostUsd: 0.03,
  },

  // ── e2e-heavy ───────────────────────────────────────────────────────
  {
    id: "e2e-model-override",
    tier: "e2e-heavy",
    files: ["tests/e2e/model-override-e2e.test.ts"],
    description: "--model haiku overrides every codon model; asserts each log's init model string.",
    failureMeans:
      "--model override stopped rewriting every codon's model (asserted via each log's init " +
      "model string) — model validation/override path in config loading.",
    suspects: ["server/config.ts", "server/config-validation"],
    needsEnv: ANTHROPIC,
    perTestTimeoutMs: 600_000,
    suiteTimeoutSeconds: 1800,
    estSeconds: 60,
    estCostUsd: 0.06,
  },
  {
    id: "e2e-llm-provider-health",
    tier: "e2e-heavy",
    files: ["tests/e2e/llm-provider-health.e2e.test.ts"],
    description: "Live health checks against every provider with a key; skips the rest.",
    failureMeans:
      "A provider health ping failed. Check WHICH provider before suspecting hankweave: an " +
      "invalid key or provider outage reddens this without any code change. Only a failure " +
      "across all providers points at the registry/health-check plumbing itself.",
    suspects: ["server/llm"],
    needsEnv: ANTHROPIC,
    // Pings whichever of these are configured; each skips cleanly when absent.
    optionalEnv: ["OPENAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY"],
    perTestTimeoutMs: 60_000,
    suiteTimeoutSeconds: 600,
    estSeconds: 15,
    estCostUsd: 0.005,
  },
  {
    id: "e2e-init-command",
    tier: "e2e-heavy",
    files: ["tests/e2e/init-command-e2e.test.ts"],
    description:
      "`hankweave init` scaffolding, then running the generated hank. Needs Anthropic + Gemini.",
    failureMeans:
      "`hankweave init` scaffolding or the generated hank stopped running end to end — wizard " +
      "templates, packaging/registry surface, or the scaffolded config drifted from current " +
      "schema requirements.",
    suspects: ["server/wizard", "schemas"],
    needsEnv: ANTHROPIC_GEMINI,
    perTestTimeoutMs: 900_000,
    suiteTimeoutSeconds: 2400,
    estSeconds: 65,
    estCostUsd: 0.08,
  },
  {
    id: "e2e-context-exhaustion",
    tier: "e2e-marathon",
    files: ["tests/long-running/context-exhaustion-e2e.test.ts"],
    description:
      "Ground truth at the real 200k boundary, and the live half of the compaction on/off pair " +
      "(intermediates/55): test 1 runs the default (compaction OFF) and must terminate its " +
      "contextExceeded loop on the provider/SDK overflow with zero compact_boundary lines; " +
      "test 2 opts in (autoCompact: true) and its iterationLimit loop must cross the boundary " +
      "via real compaction. Ingestion-based — see intermediates/54 for why generation could " +
      "never reach the window.",
    failureMeans:
      "The real 200k boundary stopped behaving as pinned. If the offline compaction/overflow " +
      "mocks are green, the LIVE provider/SDK shape drifted from the pinned wording (SDK bump, " +
      "API change) — re-probe before touching runtime code. Test 1 red → default-off overflow " +
      "termination; test 2 red → autoCompact opt-in absorption. ~$1.6/run, human-started.",
    suspects: [
      "server/types/types.ts",
      "server/claude-agent-sdk-manager.ts",
      "server/codon-runner.ts",
    ],
    needsEnv: ANTHROPIC,
    env: { LONG_TESTS: "true" },
    perTestTimeoutMs: 900_000,
    suiteTimeoutSeconds: 1800,
    estSeconds: 210,
    estCostUsd: 1.55,
  },
];

/**
 * Test files the manifest deliberately does not run as their own suite.
 * Anything here needs a reason, so the coverage-gap check below stays honest.
 */
const UNCLAIMED_ALLOWLIST: Record<string, string> = {
  "tests/info.test.ts": "One-line notice that tests are standalone scripts; carries no coverage.",
  // These use node:assert and a top-level main(), not bun:test, because the
  // whole point is running the same file under bun, node and deno. `bun test`
  // would load them and report zero tests. Driven by `bun run test:cross-runtime:*`.
  "tests/cross-runtime/dynamic-port.test.ts": "Standalone script; run by test:cross-runtime:*.",
  "tests/cross-runtime/runtime-metadata.test.ts": "Standalone script; run by test:cross-runtime:*.",
};

/**
 * Directories under tests/ that hold data rather than suites. `test-area` and
 * `test-results` are scratch space, and `fixtures` contains recorded runs whose
 * filenames can look like tests.
 */
const NON_SUITE_DIRS: Record<string, true> = {
  "test-area": true,
  "test-results": true,
  fixtures: true,
  node_modules: true,
};

/** Every test file the manifest is responsible for accounting for. */
function discoverTestFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (NON_SUITE_DIRS[entry.name]) continue;
        walk(full);
      } else if (entry.name.endsWith(".test.ts")) {
        found.push(path.relative(ROOT, full).replaceAll(path.sep, "/"));
      }
    }
  };
  walk(path.join(ROOT, "tests"));
  return found.sort();
}

export interface ResolveOptions {
  tiers: Tier[];
  filter?: string;
}

/**
 * Select suites for a run, after proving the manifest still covers the tree.
 *
 * The coverage check is the point: a test file nobody classified is a test
 * nobody runs, and that failure mode is silent by nature.
 */
export function resolveSuites(options: ResolveOptions): SuiteSpec[] {
  const claimed = new Set<string>();
  for (const suite of SUITES) {
    for (const entry of suite.files) {
      if (entry.endsWith(".test.ts")) {
        claimed.add(entry);
        if (!fs.existsSync(path.join(ROOT, entry))) {
          throw new Error(`Suite '${suite.id}' names a missing file: ${entry}`);
        }
      } else {
        // Directory entry: claims everything beneath it.
        const dir = path.join(ROOT, entry);
        if (!fs.existsSync(dir)) {
          throw new Error(`Suite '${suite.id}' names a missing directory: ${entry}`);
        }
        for (const file of discoverTestFiles()) {
          if (file.startsWith(`${entry}/`)) claimed.add(file);
        }
      }
    }
  }

  const unclaimed = discoverTestFiles().filter(
    (f) => !claimed.has(f) && !(f in UNCLAIMED_ALLOWLIST),
  );
  if (unclaimed.length > 0) {
    throw new Error(
      `These test files are not in any suite, so nothing would run them:\n` +
        unclaimed.map((f) => `  - ${f}`).join("\n") +
        `\n\nAdd them to tests/suite-manifest.ts (or to UNCLAIMED_ALLOWLIST with a reason).`,
    );
  }

  const ids = new Set<string>();
  for (const suite of SUITES) {
    if (ids.has(suite.id)) throw new Error(`Duplicate suite id: ${suite.id}`);
    ids.add(suite.id);
  }

  const wanted = new Set(options.tiers);
  // Comma is OR: "--filter a,b" selects suites matching either substring.
  // A comma can never appear in a suite id or file path, so this only changes
  // the meaning of filters that previously matched nothing. CI's smoke job
  // leans on this to name its exact suite pair in one invocation.
  const needles = (options.filter ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return SUITES.filter((s) => wanted.has(s.tier)).filter(
    (s) =>
      needles.length === 0 ||
      needles.some((n) => s.id.includes(n) || s.files.some((f) => f.includes(n))),
  );
}
