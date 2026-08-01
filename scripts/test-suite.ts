#!/usr/bin/env bun
/**
 * Hankweave test suite runner.
 *
 * `bun test` alone is not enough for this repo: the e2e tier spawns real
 * servers, spends real money, and has files that must not share a process.
 * This runner adds the three things that were missing — per-file isolation,
 * spend/time limits, and a durable result log you can grep after the fact.
 *
 * Every suite runs in its own `bun test` subprocess so a crash or a wedged
 * server can't take the rest of the run with it. Output lands in
 * `.test-runs/<runId>/` (gitignored):
 *
 *   results.json   machine-readable summary of the whole run
 *   results.jsonl  one line per suite, appended as it finishes (grep this)
 *   summary.md     human-readable table
 *   report.html    standalone report, no assets required
 *   logs/<id>.log  full stdout+stderr for one suite
 *   junit/<id>.xml per-test results from bun's junit reporter
 *
 * Usage:
 *   bun scripts/test-suite.ts                       # default tiers (free ones)
 *   bun scripts/test-suite.ts --tier all            # everything, including paid
 *   bun scripts/test-suite.ts --tier e2e-live
 *   bun scripts/test-suite.ts --filter budget
 *   bun scripts/test-suite.ts --max-cost 2.00 --max-time 900 --retries 2
 *   bun scripts/test-suite.ts --list                # print the plan, run nothing
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALL_TIERS,
  DEFAULT_TIERS,
  isTier,
  PROVIDER_KEY_ENV_VARS,
  resolveSuites,
  type SuiteSpec,
  type Tier,
} from "../tests/suite-manifest.js";
import { frogSvg } from "./report-frog.js";

const ROOT = path.resolve(import.meta.dir, "..");

// ─── Output mode ──────────────────────────────────────────────────────
// Three rendering worlds, detected once:
//  - rich (TTY, TERM≠dumb): animated status block with a spinner, colors,
//    cursor hidden during redraws.
//  - plain+color (GitHub Actions, FORCE_COLOR): static start/result lines
//    with ANSI colors — GH's log viewer renders them — plus ::error::
//    annotations that surface in the PR checks UI.
//  - plain mono (dumb terminals, redirects, generic CI): the same static
//    lines with zero escape codes.
// NO_COLOR (https://no-color.org) beats everything; FORCE_COLOR beats a
// missing TTY; TERM=dumb beats isTTY (Emacs shell buffers report a TTY).
const IS_DUMB_TERM = (process.env.TERM ?? "").toLowerCase() === "dumb";
const IS_RICH_TTY = process.stdout.isTTY === true && !IS_DUMB_TERM;
const ON_GITHUB = process.env.GITHUB_ACTIONS === "true";
const USE_COLOR =
  process.env.NO_COLOR === undefined &&
  !IS_DUMB_TERM &&
  (IS_RICH_TTY || ON_GITHUB || Boolean(process.env.FORCE_COLOR));

const paint =
  (code: string) =>
  (s: string): string =>
    USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
const green = paint("32");
const red = paint("31");
const yellow = paint("33");
const cyan = paint("36");
const gray = paint("2");
const bold = paint("1");

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the ANSI codes this file emits
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, "");
// biome-ignore lint/suspicious/noControlCharactersInRegex: anchored single-code match for width-safe clipping
const ANSI_CODE_PREFIX = /^\x1b\[[0-9;]*m/;

/** GitHub workflow-command escaping — message body vs `key=value` property. */
const ghEscData = (s: string): string =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const ghEscProp = (s: string): string => ghEscData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

// ─── CLI ──────────────────────────────────────────────────────────────

interface Options {
  tiers: Tier[];
  filter?: string;
  maxCostUsd?: number;
  maxTimeSeconds?: number;
  retries: number;
  list: boolean;
  bail: boolean;
  runId: string;
  keepGoingOnLimit: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    tiers: [...DEFAULT_TIERS],
    retries: 0,
    list: false,
    bail: false,
    runId: new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
    keepGoingOnLimit: false,
    // 0 = auto: resolved after suite selection to min(4, suites, cores/2).
    concurrency: 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };

    switch (arg) {
      case "--tier": {
        const raw = next();
        if (raw === "all") {
          opts.tiers = [...ALL_TIERS];
        } else {
          const tiers = raw.split(",").map((t) => t.trim());
          for (const t of tiers) {
            if (!isTier(t)) {
              throw new Error(`Unknown tier '${t}'. Valid: ${ALL_TIERS.join(", ")}, all`);
            }
          }
          opts.tiers = tiers as Tier[];
        }
        break;
      }
      case "--filter":
        opts.filter = next();
        break;
      case "--max-cost":
        opts.maxCostUsd = Number.parseFloat(next());
        break;
      case "--max-time":
        opts.maxTimeSeconds = Number.parseFloat(next());
        break;
      case "--retries":
        opts.retries = Number.parseInt(next(), 10);
        break;
      case "--concurrency":
        opts.concurrency = Number.parseInt(next(), 10);
        break;
      case "--run-id":
        opts.runId = next();
        break;
      case "--list":
        opts.list = true;
        break;
      case "--bail":
        opts.bail = true;
        break;
      case "--continue-past-limit":
        opts.keepGoingOnLimit = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        return process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (opts.maxCostUsd !== undefined && !Number.isFinite(opts.maxCostUsd)) {
    throw new Error("--max-cost must be a number");
  }
  if (opts.maxTimeSeconds !== undefined && !Number.isFinite(opts.maxTimeSeconds)) {
    throw new Error("--max-time must be a number");
  }
  if (!Number.isInteger(opts.retries) || opts.retries < 0) {
    throw new Error("--retries must be a non-negative integer");
  }
  if (opts.concurrency !== 0 && (!Number.isInteger(opts.concurrency) || opts.concurrency < 1)) {
    throw new Error("--concurrency must be a positive integer");
  }

  return opts;
}

function printHelp(): void {
  // The tier table is computed from the live manifest, so help can never
  // drift from what actually runs.
  const tierRows = ALL_TIERS.map((t) => {
    const inTier = resolveSuites({ tiers: [t] });
    const time = inTier.reduce((sum, s) => sum + s.estSeconds, 0);
    const cost = inTier.reduce((sum, s) => sum + s.estCostUsd, 0);
    const keys = [...new Set(inTier.flatMap((s) => s.needsEnv ?? []))];
    return (
      `  ${t.padEnd(14)} ${String(inTier.length).padStart(2)} suites  ~${fmtDuration(time).padStart(6)}  ${(cost > 0 ? `~${fmtCost(cost)}` : "$0").padStart(7)}` +
      (keys.length ? `  needs ${keys.join(", ")}` : "")
    );
  }).join("\n");

  console.log(`
${bold("Hankweave test suite runner")} — bun scripts/test-suite.ts [flags]

The manifest (tests/suite-manifest.ts) declares every suite: tier, files,
required env, timeouts, measured time and cost. A *.test.ts no suite claims
fails the run — a test file cannot stop running silently. TESTING.md has the
full story; triage.md (written on failure) tells you what a red MEANS.

${bold("TIERS")}  (default: ${DEFAULT_TIERS.join(", ")} — free, keyless, every push)
${tierRows}

${bold("SCRIPTS")}
  bun run test             Free tiers, parallel, + trailing residue cleanup
  bun run test:list        The full plan, all tiers, with estimates and key needs
  bun run test:all         Everything, marathon included
  bun run test:live        e2e-live — real models, real spend
  bun run test:heavy       e2e-heavy — provider health, SDK/init contracts
  bun run test:long        e2e-marathon — context exhaustion at the real 200k boundary
  bun run test:ci          Free tiers with --retries 1 (what CI runs)

${bold("FLAGS")}
  --tier <list|all>        Tiers to run (comma-separated). Default: ${DEFAULT_TIERS.join(",")}
  --filter <sub[,sub…]>    Only suites whose id or file contains any substring
  --max-cost <usd>         Decline a suite whose estimate would breach this. Firing = exit 1
  --max-time <seconds>     Same, for wall time
  --retries <n>            Retry a failing suite up to n times (default 0)
  --concurrency <n>        Suites to run at once. Default: auto — min(4, suites, cores/2),
                           the configuration measured stable across full sweeps. Pass 1 for
                           sequential. With paid suites, per-suite spend shows "—"
                           (overlapping measurement windows); the run total is still measured
  --bail                   Stop the whole run on the first suite failure
  --continue-past-limit    Record limit breaches but keep running
  --run-id <id>            Name the output directory (default: timestamp)
  --list                   Print the resolved plan and exit

${bold("OUTPUTS")}  (.test-runs/<runId>/ — gitignored; latest/ symlinks the newest)
  report.html              Standalone report, expandable per-test rows
  summary.md               Human summary
  results.jsonl            One row per SUITE (status, cost, failures, metadata)
  tests.jsonl              One row per TEST (suite, file, name, status, duration)
  logs/<suite>.log         Full child output          junit/<suite>.xml  bun's junit
  triage.md / triage.json  On failure: what the suite defends, what a red MEANS,
                           suspect server/ modules, assertion diffs, rerun commands

${bold("ENVIRONMENT")}
  Key hygiene              Every provider key (${PROVIDER_KEY_ENV_VARS.slice(0, 3).join(", ")}, …)
                           is STRIPPED from a suite's env unless its manifest entry
                           declares it in needsEnv — free means free, structurally.
  Output modes             NO_COLOR > FORCE_COLOR > TERM=dumb > TTY. Rich terminals
                           get the animated status block; GitHub Actions gets colored
                           lines + ::error annotations; everything else plain text.
  HANKWEAVE_REPLAY_SPEED_MS / _MAX_DELAY_MS   Replay pacing (manifest presets)
  HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL      Runner sets 100ms for every suite

${bold("EXIT CODES")}
  0 all green (missing-credential skips are green)   1 failures, or a limit
  declined suites (the run did less than asked)      2 setup/plan/preflight error

${bold("EXAMPLES")}
  bun run test                                       the free gate, ~1m40s
  bun scripts/test-suite.ts --filter budget          every suite touching budget
  bun scripts/test-suite.ts --tier e2e-live --filter happy-path
  bun scripts/test-suite.ts --tier all --max-cost 2.00 --bail
  bun run test -- --concurrency 1                    sequential, manifest order
`);
}

// ─── Cost accounting ──────────────────────────────────────────────────

/**
 * Sum spend recorded by the runtime itself, for codons that ran in this window.
 *
 * Tests write real `state.json` files and every codon carries its own final or
 * partial cost, so reading those back beats any estimate — a price change in
 * models.dev can't make this number lie.
 *
 * Two things this is careful about, and one it cannot be:
 *
 * - The window filter is on `codon.startTime`, deliberately *not* on file
 *   mtime. Several suites copy recorded fixtures out of `tests/fixtures/` into
 *   the test area, which gives a months-old `state.json` a brand-new mtime; an
 *   mtime filter books that historical spend against the current run. Replay
 *   executions fall out for free — the runtime copies them to a tmpdir, so the
 *   fixture left in the test area is never written to.
 * - Execution directories nest (some suites create their own parent), so the
 *   walk is recursive rather than one level deep.
 * - It is a **floor, not a total**. A suite that deletes its own execution
 *   directory takes the evidence with it — `happy-path` does exactly that,
 *   because tearing the workspace down is part of what it tests. For those the
 *   manifest's declared estimate is the better number, which is why `--list`
 *   prices a run from estimates and the report shows measured spend beside it.
 */
function measureSpendSince(sinceMs: number): number {
  const roots = [
    path.join(ROOT, "tests", "test-area"),
    path.join(os.homedir(), ".hankweave-executions"),
  ];

  let total = 0;

  const visit = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".hankweave") {
        total += costFromStateFile(path.join(dir, entry.name, "state.json"), sinceMs);
        continue;
      }
      if (entry.name === "node_modules" || entry.name === "agentRoot") continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };

  for (const root of roots) {
    if (fs.existsSync(root)) visit(root, 0);
  }
  return total;
}

export function costFromStateFile(statePath: string, sinceMs: number): number {
  let raw: string;
  try {
    if (fs.statSync(statePath).mtimeMs < sinceMs) return 0;
    raw = fs.readFileSync(statePath, "utf-8");
  } catch {
    return 0;
  }
  let total = 0;
  try {
    const state = JSON.parse(raw);
    for (const run of state.runs ?? []) {
      for (const codon of run.codons ?? []) {
        const startedMs = Date.parse(codon.startTime ?? "");
        if (!Number.isFinite(startedMs) || startedMs < sinceMs) continue;
        // Sentinel spend is persisted beside the agent's cost, not inside it
        // (state-manager writes finalCost/partialCost from currentCost and
        // sentinels.totalCost separately) — both are real dollars.
        total += (codon.finalCost ?? codon.partialCost ?? 0) + (codon.sentinels?.totalCost ?? 0);
      }
    }
  } catch {
    // A half-written state.json during a crash is not worth failing over.
  }
  return total;
}

// ─── JUnit parsing ────────────────────────────────────────────────────

interface TestCase {
  name: string;
  /** The describe path (junit classname) — where the test lives logically. */
  classname: string;
  file: string;
  timeSeconds: number;
  status: "pass" | "fail" | "skip";
  failure?: string;
}

interface JUnitSummary {
  tests: number;
  failures: number;
  skipped: number;
  cases: TestCase[];
}

/**
 * Minimal JUnit reader. Bun emits a flat, predictable shape (one `testsuite`
 * per file, `testcase` children), so a regex pass beats taking on an XML
 * dependency for a build-time script.
 */
function parseJUnit(xmlPath: string): JUnitSummary | undefined {
  if (!fs.existsSync(xmlPath)) return undefined;
  let xml: string;
  try {
    xml = fs.readFileSync(xmlPath, "utf-8");
  } catch {
    return undefined;
  }

  const cases: TestCase[] = [];
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  const attrRe = /(\w[\w-]*)="([^"]*)"/g;

  for (const match of xml.matchAll(caseRe)) {
    const attrs: Record<string, string> = {};
    for (const a of match[1].matchAll(attrRe)) attrs[a[1]] = a[2];
    const body = match[3] ?? "";

    let status: TestCase["status"] = "pass";
    let failure: string | undefined;
    if (/<failure\b/.test(body) || /<error\b/.test(body)) {
      status = "fail";
      // Bun emits `<failure type="AssertionError" />` — no message, no body.
      // Take whatever attribute carries information; the real assertion diff
      // lives only in the log and is mined by triage's extractFailureDetail.
      const msg = /<(?:failure|error)\b[^>]*message="([^"]*)"/.exec(body);
      const type = /<(?:failure|error)\b[^>]*type="([^"]*)"/.exec(body);
      failure = msg?.[1] ? decodeXml(msg[1]) : type?.[1] ? decodeXml(type[1]) : "failed";
    } else if (/<skipped\b/.test(body)) {
      status = "skip";
    }

    cases.push({
      name: decodeXml(attrs.name ?? "(unnamed)"),
      classname: decodeXml(attrs.classname ?? ""),
      file: attrs.file ?? "",
      timeSeconds: Number.parseFloat(attrs.time ?? "0") || 0,
      status,
      failure,
    });
  }

  return {
    tests: cases.length,
    failures: cases.filter((c) => c.status === "fail").length,
    skipped: cases.filter((c) => c.status === "skip").length,
    cases,
  };
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ─── Running one suite ────────────────────────────────────────────────

interface SuiteResult {
  id: string;
  tier: Tier;
  files: string[];
  status: "passed" | "failed" | "skipped" | "timed-out";
  skipReason?: string;
  exitCode: number | null;
  durationSeconds: number;
  costUsd: number;
  attempts: number;
  tests: number;
  failures: number;
  skippedTests: number;
  failedTestNames: string[];
  /** Failing cases with their junit failure messages — the triage payload. */
  failedCases: Array<{ name: string; file: string; failure?: string }>;
  /** Manifest triage metadata, denormalized onto non-passed results. */
  description?: string;
  failureMeans?: string;
  suspects?: string[];
  logPath: string;
  junitPath?: string;
  startedAt: string;
}

/** One `bun test` invocation for one suite. */
interface SuiteAttempt {
  exitCode: number | null;
  durationSeconds: number;
  timedOut: boolean;
}

// `needsEnv` is a contract, not a note: a suite gets exactly the provider
// keys it declared and none of the others. Anything that reaches for an
// undeclared provider fails at the point of the lie, in the tier that lied,
// rather than silently spending money in one advertised as free.
//
// Measuring spend after the fact cannot replace this. `measureSpendSince()`
// reads each run's `state.json`, so a suite that deletes its execution
// directory in `afterAll` reports $0 no matter what it spent — which is
// exactly how `replay-e2e` ran live models inside `e2e-offline` unnoticed.
export function buildSuiteEnv(
  suite: Pick<SuiteSpec, "needsEnv" | "optionalEnv" | "env">,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const declared = new Set([...(suite.needsEnv ?? []), ...(suite.optionalEnv ?? [])]);
  const childEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    // Every codon pays `2 × logParsingInterval` of pure sleep at completion
    // (`handleCodonComplete`, hankweave-runtime.ts) — at the production default
    // of 1000ms that is 2s per codon, which was ~34s of a 47s plan-gen replay
    // and the single largest cost in the offline tier. The sleep is redundant
    // on the exit path (emitExit force-parses the log synchronously first),
    // but that is a runtime change to make with live verification; polling at
    // 100ms shrinks the tax to 200ms/codon without touching runtime behavior.
    HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL: "100",
    ...(suite.env ?? {}),
  };
  for (const key of PROVIDER_KEY_ENV_VARS) {
    // The registry (llm-provider-registry.ts) prefers the HANKWEAVE_SENTINEL_
    // alias over the bare key, and CI exports both from the same secret — so
    // both forms grant the same provider and both must be stripped together.
    const alias = `HANKWEAVE_SENTINEL_${key}`;
    if (!declared.has(key) && !declared.has(alias)) {
      delete childEnv[key];
      delete childEnv[alias];
    }
  }
  return childEnv;
}

// ─── Live progress (interactive terminals only) ──────────────────────
//
// A five-minute suite behind a frozen `...` line reads as a hang. The child's
// output already streams through us on the way to the log file, so count the
// per-test result markers as they pass and let a ticker in main() render
// elapsed-vs-estimate. Counting is best-effort display only — junit stays the
// source of truth for totals.

interface LiveSuiteProgress {
  suite: SuiteSpec;
  startedAt: number;
  attempt: number;
  testsSeen: number;
  failsSeen: number;
}

const liveProgress = new Map<string, LiveSuiteProgress>();

// Every live suite's group-killer, so a runner-level SIGINT/SIGTERM can take
// the detached children down before exiting. Detached spawning puts each
// suite in its own process group — the terminal's Ctrl-C never reaches them,
// and a runner that just exits leaves bun test, e2e servers, and in-flight
// provider calls running (and spending) unsupervised.
const activeKillers = new Set<(signal: NodeJS.Signals) => void>();

/**
 * Count bun's per-test `(pass)`/`(fail)` markers in a stream chunk.
 *
 * Markers are only counted at LINE START: suites boot hankweave servers whose
 * prefixed output freely contains these tokens mid-line (codon ids like
 * `budget-on-exceeded-fail`, echoed hank output — one e2e-budget run carried
 * 2,237 mid-line `(fail)` strings against 0 real failures, which the old
 * anywhere-in-chunk match displayed as "9 FAIL" on a passing suite). Bun
 * prints real markers at column 0; a possible ANSI color prefix is tolerated.
 */
function makeMarkerCounter(progress: LiveSuiteProgress): (chunk: Buffer) => void {
  let carry = "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches the ANSI color prefix bun may emit before a marker
  const marker = /^(?:\x1b\[[0-9;]*m)*\((pass|fail|skip|todo)\)/;
  return (chunk: Buffer) => {
    const text = carry + chunk.toString("utf8");
    const lines = text.split("\n");
    // The last element is an incomplete line; hold it until its newline
    // arrives so a marker straddling two chunks still counts once.
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const m = marker.exec(line);
      if (!m) continue;
      progress.testsSeen++;
      if (m[1] === "fail") progress.failsSeen++;
    }
  };
}

async function runSuiteOnce(
  suite: SuiteSpec,
  outDir: string,
  attempt: number,
): Promise<SuiteAttempt> {
  const logPath = path.join(outDir, "logs", `${suite.id}.log`);
  const junitPath = path.join(outDir, "junit", `${suite.id}.xml`);
  const logStream = fs.createWriteStream(logPath, { flags: attempt === 1 ? "w" : "a" });

  if (attempt > 1) logStream.write(`\n\n===== RETRY ATTEMPT ${attempt} =====\n\n`);

  const args = [
    "test",
    ...suite.files,
    "--timeout",
    String(suite.perTestTimeoutMs),
    "--reporter=junit",
    `--reporter-outfile=${junitPath}`,
  ];

  const childEnv = buildSuiteEnv(suite, process.env);
  // Telemetry identity lives in ~/.hankweave/telemetry.json by default, and
  // nearly every server boot read-modify-writes it — ~80 boots per sweep on a
  // SHARED file, concurrently under the parallel default. Redirect the cache
  // dir per suite instead of disabling telemetry: suites that TEST telemetry
  // behavior keep working, and a suite's own env still wins.
  if (!childEnv.HANKWEAVE_CACHE_DIR) {
    childEnv.HANKWEAVE_CACHE_DIR = path.join(outDir, "cache", suite.id);
  }

  const startedAt = Date.now();
  const { promise, resolve } = Promise.withResolvers<SuiteAttempt>();

  const child = spawn("bun", args, {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group, so the timeout below can take the servers down with
    // the runner. E2E suites spawn hankweave servers; killing only `bun test`
    // leaves those orphaned, and because they inherit the stdio pipes the
    // parent's "close" never fires — a 600s ceiling then overran to 30 minutes.
    detached: process.platform !== "win32",
  });

  const killTree = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already gone, or the group vanished between check and signal.
    }
  };
  activeKillers.add(killTree);

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    logStream.write(
      `\n\n===== SUITE TIMEOUT after ${suite.suiteTimeoutSeconds}s — killing process group =====\n`,
    );
    killTree("SIGKILL");
  }, suite.suiteTimeoutSeconds * 1000);
  killer.unref?.();

  const progress: LiveSuiteProgress = {
    suite,
    startedAt,
    attempt,
    testsSeen: 0,
    failsSeen: 0,
  };
  liveProgress.set(suite.id, progress);
  const countMarkers = makeMarkerCounter(progress);

  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  // Extra listeners alongside pipe(): streams are already flowing, so these
  // observe the same chunks without altering delivery to the log.
  child.stdout?.on("data", countMarkers);
  child.stderr?.on("data", countMarkers);

  child.on("error", (err) => {
    logStream.write(`\n\nspawn error: ${err.message}\n`);
  });

  // Resolve on "exit", not "close". "close" additionally waits for every stdio
  // stream to end, and a surviving grandchild holding the pipe keeps that from
  // ever happening — which is exactly the hang this ceiling exists to break.
  child.on("exit", (code) => {
    clearTimeout(killer);
    activeKillers.delete(killTree);
    liveProgress.delete(suite.id);
    // Give the pipes a moment to flush what was already written, then stop
    // waiting on them regardless.
    setTimeout(() => {
      child.stdout?.unpipe(logStream);
      child.stderr?.unpipe(logStream);
      logStream.end();
    }, 250).unref?.();
    resolve({
      exitCode: code,
      durationSeconds: (Date.now() - startedAt) / 1000,
      timedOut,
    });
  });

  return await promise;
}

// ─── Reporting ────────────────────────────────────────────────────────

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

function fmtCost(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? `$${usd.toFixed(4)}` : "—";
}

/**
 * Did a limit actually STOP work? Under --continue-past-limit a breach is
 * recorded in meta.limitHit but nothing is declined — reports must then say
 * "breached, continued" rather than "stopped early", and a fully-green run
 * is not a failed run.
 */
function limitStoppedRun(results: SuiteResult[]): boolean {
  return results.some(
    (r) => r.status === "skipped" && r.skipReason && !r.skipReason.startsWith("missing "),
  );
}

function writeSummaryMarkdown(outDir: string, results: SuiteResult[], meta: RunMeta): void {
  const lines: string[] = [];
  lines.push(`# Test run ${meta.runId}`);
  lines.push("");
  lines.push(
    `**${meta.passed} passed · ${meta.failed} failed · ${meta.skipped} skipped** — ` +
      `${fmtDuration(meta.durationSeconds)}, ${fmtCost(meta.costUsd)}`,
  );
  lines.push("");
  lines.push(`Tiers: ${meta.tiers.join(", ")}`);
  if (meta.limitHit) {
    lines.push(
      limitStoppedRun(results)
        ? `\n> Stopped early: ${meta.limitHit}`
        : `\n> Limit breached (run continued): ${meta.limitHit}`,
    );
  }
  lines.push("");
  lines.push("| Suite | Tier | Status | Tests | Time | Cost | Tries |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const icon =
      r.status === "passed"
        ? "pass"
        : r.status === "failed"
          ? "FAIL"
          : r.status === "timed-out"
            ? "TIMEOUT"
            : "skip";
    const tests =
      r.status === "skipped" ? (r.skipReason ?? "") : `${r.tests - r.failures}/${r.tests}`;
    lines.push(
      `| \`${r.id}\` | ${r.tier} | ${icon} | ${tests} | ${fmtDuration(r.durationSeconds)} | ${fmtCost(r.costUsd)} | ${r.attempts} |`,
    );
  }

  const failed = results.filter((r) => r.failedTestNames.length > 0);
  if (failed.length > 0) {
    lines.push("");
    lines.push("## Failing tests");
    for (const r of failed) {
      lines.push("");
      lines.push(`### \`${r.id}\` — logs/${r.id}.log`);
      if (r.failureMeans) lines.push(`> ${r.failureMeans}`);
      for (const name of r.failedTestNames) lines.push(`- ${name}`);
    }
    lines.push("");
    lines.push(
      "Full failure messages, log excerpts and rerun commands: `triage.md` / `triage.json`.",
    );
  }

  fs.writeFileSync(path.join(outDir, "summary.md"), `${lines.join("\n")}\n`);
}

/**
 * triage.md / triage.json — written only when suites failed or timed out.
 *
 * The contract: a reader (human or agent) with ONLY triage.md can say what
 * broke, what that means (the manifest's failureMeans), see the exact junit
 * failure messages and the log lines around them, jump to the suspect server/
 * modules, and rerun precisely the failing thing — without parsing junit XML
 * or scrolling megabyte logs. triage.json is the same content, structured.
 */
function writeTriage(outDir: string, results: SuiteResult[], meta: RunMeta): boolean {
  const failed = results.filter((r) => r.status === "failed" || r.status === "timed-out");
  if (failed.length === 0) return false;

  /**
   * Signal lines from a suite log. `(fail)` markers are bun's per-test verdicts
   * and the ONLY reliable failure anchors — hankweave tests deliberately log
   * [ERROR] lines on green paths (error-path coverage), so generic error
   * patterns are the fallback, never the preference.
   */
  const logExcerpt = (lines: string[]): { signal: string; tail: string } => {
    let markers: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^\(fail\)|\(fail\) |SUITE TIMEOUT/.test(lines[i])) markers.push(i);
    }
    if (markers.length === 0) {
      for (let i = 0; i < lines.length; i++) {
        if (/error: |Error: |ERROR\]/.test(lines[i])) markers.push(i);
      }
      markers = markers.slice(-8);
    }
    const keep = new Set<number>();
    // (fail) verdicts come AFTER their assertion diff, so context leans back.
    for (const m of markers.slice(-12)) {
      for (let i = Math.max(0, m - 8); i <= Math.min(lines.length - 1, m + 1); i++) keep.add(i);
    }
    const ordered = [...keep].sort((a, b) => a - b);
    const chunks: string[] = [];
    let prev = -2;
    for (const i of ordered) {
      if (i !== prev + 1) chunks.push("  ⋮");
      chunks.push(lines[i]);
      prev = i;
    }
    return {
      signal: chunks.join("\n").slice(0, 8000),
      tail: lines.slice(-30).join("\n").slice(0, 4000),
    };
  };

  /**
   * The assertion detail for one failing test, mined from the log: bun prints
   * the expect() diff immediately BEFORE its `(fail) <describe> > <name>` line
   * (junit carries no message). Walk back from the verdict line to the
   * previous test verdict or file header, capped at 15 lines.
   */
  const extractFailureDetail = (lines: string[], testName: string): string | undefined => {
    const needle = `(fail) `;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(needle) || !lines[i].includes(testName)) continue;
      const block: string[] = [];
      for (let j = i - 1; j >= Math.max(0, i - 15); j--) {
        const l = lines[j];
        if (/^\((pass|fail|skip)\)/.test(l) || /\.test\.ts:$/.test(l)) break;
        block.unshift(l);
      }
      const trimmed = block.join("\n").trim();
      return trimmed ? trimmed.slice(0, 1200) : undefined;
    }
    return undefined;
  };

  const md: string[] = [];
  md.push(`# Triage — run ${meta.runId}`);
  md.push("");
  md.push(
    `${failed.length} suite(s) failed out of ${meta.passed + meta.failed}. ` +
      "Each section below: what the suite defends, what a red MEANS, the exact " +
      "failure messages, log signal lines, suspects, and rerun commands.",
  );
  const triageJson: Array<Record<string, unknown>> = [];

  for (const r of failed) {
    let logLines: string[] = [];
    try {
      logLines = fs.readFileSync(path.join(outDir, r.logPath), "utf-8").split("\n");
    } catch {
      // triage still renders from junit alone
    }
    const excerpt = logExcerpt(logLines);
    const casesWithDetail = r.failedCases.map((c) => ({
      ...c,
      detail: extractFailureDetail(logLines, c.name),
    }));
    md.push("");
    md.push(
      `## ${r.id} — ${r.status.toUpperCase()}${r.attempts > 1 ? ` (${r.attempts} tries)` : ""}`,
    );
    md.push("");
    if (r.description) md.push(`**Defends:** ${r.description}`);
    if (r.failureMeans) md.push(`**A red here means:** ${r.failureMeans}`);
    if (r.suspects?.length)
      md.push(`**Suspects:** ${r.suspects.map((s) => `\`${s}\``).join(", ")}`);
    md.push(`**Files:** ${r.files.map((f) => `\`${f}\``).join(", ")}`);
    md.push("");
    if (casesWithDetail.length > 0) {
      md.push("### Failing tests");
      for (const c of casesWithDetail) {
        md.push(`- **${c.name}**${c.file ? ` (\`${c.file}\`)` : ""} — ${c.failure ?? "failed"}`);
        if (c.detail) {
          md.push("");
          md.push("  ```");
          for (const line of c.detail.split("\n")) md.push(`  ${line}`);
          md.push("  ```");
        }
      }
    } else if (r.status === "timed-out") {
      md.push(
        "### No junit written — the suite hit its wall-clock ceiling and was SIGKILLed. " +
          "The log tail below shows where it was stuck.",
      );
    } else {
      md.push("### No junit written — the suite died before reporting (spawn/import failure?).");
    }
    md.push("");
    md.push("### Log signal");
    md.push("```");
    md.push(excerpt.signal || "(no failure markers found in log)");
    md.push("```");
    if (r.status === "timed-out" && excerpt.tail) {
      md.push("### Log tail (last 30 lines before the kill)");
      md.push("```");
      md.push(excerpt.tail);
      md.push("```");
    }
    md.push("### Rerun");
    md.push("```bash");
    md.push(`# whole suite, with the runner's env grants and timeouts:`);
    md.push(`bun scripts/test-suite.ts --tier ${r.tier} --filter ${r.id}`);
    for (const c of r.failedCases.slice(0, 6)) {
      const file = c.file || r.files[0];
      md.push(`bun test ${file} -t ${JSON.stringify(c.name)}`);
    }
    md.push("```");
    md.push(
      "_Note: direct `bun test` skips the runner's provider-key enforcement and env " +
        "(HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL etc.), and `-t` still pays the whole " +
        "file's beforeAll._",
    );

    triageJson.push({
      suite: r.id,
      tier: r.tier,
      status: r.status,
      attempts: r.attempts,
      description: r.description,
      failureMeans: r.failureMeans,
      suspects: r.suspects ?? [],
      files: r.files,
      failedCases: casesWithDetail,
      logPath: r.logPath,
      junitPath: r.junitPath,
      logSignal: excerpt.signal,
      rerun: {
        suite: `bun scripts/test-suite.ts --tier ${r.tier} --filter ${r.id}`,
        tests: r.failedCases.map(
          (c) => `bun test ${c.file || r.files[0]} -t ${JSON.stringify(c.name)}`,
        ),
      },
    });
  }

  fs.writeFileSync(path.join(outDir, "triage.md"), `${md.join("\n")}\n`);
  fs.writeFileSync(
    path.join(outDir, "triage.json"),
    `${JSON.stringify({ runId: meta.runId, failedSuites: triageJson }, null, 2)}\n`,
  );
  return true;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The run report, in the Southbridge design language.
 *
 * Two deliberate departures from the brand kit, both forced by the artifact:
 *
 * - **No `@font-face`.** A report is written per run and read from `file://` or
 *   a CI artifact zip, so it cannot reference font files and should not carry
 *   ~300KB of base64 in every copy. The token stacks degrade exactly as
 *   designed — Iowan Old Style ships with macOS, and Georgia carries the serif
 *   elsewhere.
 * - **Light only.** The system has no dark palette; inventing one would be
 *   making up brand. `color-scheme: light` stops browsers force-darkening.
 *
 * The frog is not decoration here: it sits inside a ring that reads the pass
 * rate, so the shape of the run is legible before any text is.
 */
function writeHtmlReport(outDir: string, results: SuiteResult[], meta: RunMeta): void {
  const total = meta.passed + meta.failed + meta.skipped;
  const passRate = total > 0 ? meta.passed / total : 0;

  // Ring geometry, per the brand kit's progress-ring recipe, scaled up for a
  // headline stat: dasharray is the full circumference, dashoffset the unfilled
  // remainder, and the whole svg is rotated -90deg so the arc grows from noon.
  const RING = { size: 116, stroke: 4 };
  const radius = (RING.size - RING.stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashoffset = circumference * (1 - passRate);
  const runFailed = meta.failed > 0 || limitStoppedRun(results);

  const rows = results
    .map((r) => {
      const cases = parseJUnit(path.join(outDir, "junit", `${r.id}.xml`))?.cases ?? [];
      const detail = cases.length
        ? `<table class="cases">${cases
            .map((c) => {
              const mark =
                c.status === "fail" ? "&#10007;" : c.status === "skip" ? "&#8211;" : "&#10003;";
              return `<tr class="case-${c.status}">
        <td class="case-mark" aria-hidden="true">${mark}</td>
        <td class="case-name">${escapeHtml(c.name)}</td>
        <td class="num">${c.timeSeconds.toFixed(2)}s</td>
      </tr>${
        c.failure
          ? `<tr class="case-failure"><td></td><td colspan="2"><pre>${escapeHtml(c.failure)}</pre></td></tr>`
          : ""
      }`;
            })
            .join("")}</table>`
        : `<p class="detail-empty">${escapeHtml(r.skipReason ?? "No per-test results were recorded.")}</p>`;

      const tests = r.status === "skipped" ? "&mdash;" : `${r.tests - r.failures}/${r.tests}`;
      return `<tr class="suite is-${r.status}">
  <td class="cell-id">
    <button class="toggle" data-id="${r.id}" aria-expanded="false"
            aria-label="Show tests in ${escapeHtml(r.id)}"><span aria-hidden="true">&#9656;</span></button>
    <code>${escapeHtml(r.id)}</code>
  </td>
  <td class="cell-tier">${r.tier}</td>
  <td class="cell-status"><span class="dot" aria-hidden="true"></span>${r.status}</td>
  <td class="num">${tests}</td>
  <td class="num">${fmtDuration(r.durationSeconds)}</td>
  <td class="num">${fmtCost(r.costUsd)}</td>
  <td class="num">${r.attempts > 1 ? r.attempts : "&mdash;"}</td>
  <td class="cell-log"><a href="logs/${encodeURIComponent(r.id)}.log">log</a></td>
</tr>
<tr class="detail" id="detail-${r.id}" hidden><td colspan="8">${detail}</td></tr>`;
    })
    .join("\n");

  const empty = `<p class="detail-empty">No suites matched this run's tiers and filter.</p>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hankweave tests &mdash; ${escapeHtml(meta.runId)}</title>
<style>
:root {
  --sb-text: #3c3836;
  --sb-background: #ffffff;
  --sb-secondary: #29916e;
  --sb-text-highlight-soft: rgba(32, 255, 175, 0.15);
  --sb-text-highlight-medium: rgba(32, 255, 175, 0.3);
  --sb-text-muted: #676767;
  --sb-text-light: #888888;
  --sb-bg-subtle: #fafafa;
  --sb-bg-muted: #f0f0f0;
  --sb-border: #d9d9d9;
  --sb-code-bg: #f3f3f2;
  --sb-error: #c62828;
  --font-display: "Parastoo", Georgia, "Book Antiqua", Palatino, serif;
  --font-body: "Iowan Old Style", Georgia, "Times New Roman", serif;
  --font-sans: "HK Grotesk", -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
  --font-mono: "Departure Mono", "SF Mono", Monaco, Consolas, monospace;
  --content-width: 680px;
  --full-width: 1200px;
  color-scheme: light;
}
* { box-sizing: border-box; }
html { font-size: 16px; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
body {
  font-family: var(--font-body); font-size: 1.0625rem; line-height: 1.65;
  color: var(--sb-text); background: var(--sb-background);
  margin: 0; padding: 4rem 1.5rem 6rem;
}
::selection { background: var(--sb-text-highlight-medium); color: var(--sb-text); }
:focus-visible { outline: 2px solid var(--sb-secondary); outline-offset: 2px; }
.wrap { max-width: var(--content-width); margin: 0 auto; }
.bleed { max-width: var(--full-width); margin: 0 auto; }

/* ── masthead ─────────────────────────────────────────────── */
.lockup { display: inline-flex; align-items: center; gap: .5rem; margin-bottom: 2.5rem; }
.lockup-frog { width: 30px; height: 20px; color: #2d5044; flex: none; }
.wordmark { font-family: var(--font-display); font-size: 1.0625rem; color: var(--sb-text); letter-spacing: .01em; }
.wordmark .south { color: var(--sb-text-light); }
h1 { font-family: var(--font-display); font-weight: 400; font-size: 2.75rem;
     line-height: 1.15; margin: 0 0 .75rem; }
.meta { font-family: var(--font-mono); font-size: .8125rem; color: var(--sb-text-light);
        margin: 0; letter-spacing: .01em; }
.limit { margin-top: 1.25rem; padding: .75rem 1rem; border-left: 3px solid var(--sb-error);
         background: var(--sb-bg-subtle); font-size: .875rem; color: var(--sb-text); }

/* ── the ring: pass rate, read before any text ────────────── */
.headline { display: flex; align-items: center; gap: 2.5rem; margin: 3rem 0 0; flex-wrap: wrap; }
.ring-wrap { position: relative; width: ${RING.size}px; height: ${RING.size}px; flex: none; }
.ring { position: absolute; inset: 0; transform: rotate(-90deg); }
.ring-track { stroke: rgba(60, 56, 54, .12); }
.ring-bar { stroke: var(--sb-secondary); transition: stroke-dashoffset .6s ease-out; }
.is-failed .ring-bar { stroke: var(--sb-error); }
.ring-frog { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
             width: 40px; height: 27px; color: var(--sb-text); }
.stats { display: flex; gap: 2.25rem; flex-wrap: wrap; }
.stat dt { font-family: var(--font-sans); font-size: .6875rem; font-weight: 600;
           text-transform: uppercase; letter-spacing: .08em; color: var(--sb-text-light);
           margin: 0 0 .25rem; }
.stat dd { margin: 0; font-family: var(--font-display); font-size: 1.875rem;
           font-weight: 400; line-height: 1; color: var(--sb-text); }
.stat.is-bad dd { color: var(--sb-error); }
.stat.is-null dd { color: var(--sb-text-light); }

/* ── frog divider ─────────────────────────────────────────── */
.frog-hr { position: relative; height: 2px; border-radius: 1px; margin: 3.5rem 0 2.5rem;
  background: linear-gradient(to right, var(--sb-bg-muted), var(--sb-bg-muted) 25%,
    transparent 42%, transparent 58%, var(--sb-bg-muted) 75%, var(--sb-bg-muted)); }
.frog-hr svg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
               width: 20px; height: 14px; color: #a0a0a0; opacity: .5; }

/* ── the data sheet ───────────────────────────────────────── */
table.suites { width: 100%; border: 1px solid var(--sb-border); border-radius: 6px;
  border-collapse: separate; border-spacing: 0; font-size: .875rem;
  box-shadow: 0 1px 3px rgba(0,0,0,.04), 0 4px 12px rgba(0,0,0,.03); overflow: hidden; }
table.suites th { font-family: var(--font-sans); font-size: .6875rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: .06em; background: var(--sb-bg-subtle);
  color: var(--sb-text); text-align: left; }
table.suites th, table.suites td { padding: .7rem 1rem; border-bottom: 1px solid var(--sb-border);
  white-space: nowrap; }
table.suites tbody tr:last-child td { border-bottom: none; }
.num { text-align: right; font-family: var(--font-mono); font-size: .8125rem;
       font-variant-numeric: tabular-nums; color: var(--sb-text-muted); }
.cell-id code { font-family: var(--font-mono); font-size: .8125rem; color: var(--sb-text); }
.cell-tier { font-family: var(--font-mono); font-size: .75rem; color: var(--sb-text-light); }
.cell-status { font-family: var(--font-sans); font-size: .75rem; color: var(--sb-text-muted); }
.cell-log a { font-family: var(--font-sans); font-size: .75rem; color: var(--sb-text-muted);
  text-decoration: underline; text-decoration-color: rgba(103,103,103,.3);
  text-underline-offset: 2px; }
.cell-log a:hover { color: var(--sb-text); text-decoration-color: rgba(60,56,54,.5); }
.dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%;
       margin-right: .5rem; vertical-align: middle; background: var(--sb-secondary); }
tr.is-failed .dot, tr.is-timed-out .dot { background: var(--sb-error); }
tr.is-skipped .dot { background: var(--sb-border); }
tr.is-failed .cell-status, tr.is-timed-out .cell-status { color: var(--sb-error); font-weight: 600; }
tr.is-skipped { color: var(--sb-text-light); }
tr.is-skipped .cell-id code { color: var(--sb-text-light); }
tbody tr.suite:hover { background: rgba(128,128,128,.05); }
.toggle { border: 0; background: none; cursor: pointer; padding: 0 .4rem 0 0;
  color: var(--sb-text-light); font-size: .75rem; transition: color 150ms ease; }
.toggle:hover { color: var(--sb-text); }
.toggle[aria-expanded="true"] span { display: inline-block; transform: rotate(90deg); }

/* ── per-suite detail ─────────────────────────────────────── */
tr.detail > td { padding: 0; background: var(--sb-bg-subtle); white-space: normal; }
table.cases { width: 100%; border-collapse: collapse; }
table.cases td { padding: .4rem 1rem; border-bottom: 1px dotted var(--sb-border);
  font-size: .8125rem; white-space: normal; }
table.cases tr:last-child td { border-bottom: none; }
.case-mark { width: 1.5rem; text-align: center; font-family: var(--font-mono); }
.case-pass .case-mark { color: var(--sb-secondary); }
.case-fail .case-mark { color: var(--sb-error); }
.case-skip .case-mark { color: var(--sb-text-light); }
.case-name { font-family: var(--font-body); color: var(--sb-text); }
.case-fail .case-name { color: var(--sb-error); }
.case-failure pre { margin: .25rem 0 .75rem; padding: .75rem 1rem; background: var(--sb-code-bg);
  border-radius: 2px; font-family: var(--font-mono); font-size: .75rem; line-height: 1.5;
  color: var(--sb-text); white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
.detail-empty { margin: 0; padding: .9rem 1rem; font-size: .8125rem; color: var(--sb-text-light);
  font-style: italic; }

@media (max-width: 720px) {
  body { padding: 2.5rem 1rem 4rem; }
  h1 { font-size: 2.25rem; }
  .headline { gap: 1.5rem; }
  .cell-tier, .cell-log { display: none; }
}
</style></head>
<body class="${runFailed ? "is-failed" : ""}">
<header class="wrap">
  <span class="lockup">
    ${frogSvg('class="lockup-frog" aria-hidden="true"')}
    <span class="wordmark"><span class="south">South</span>bridge</span>
  </span>
  <h1>Hankweave test run</h1>
  <p class="meta">${escapeHtml(meta.runId)} &middot; ${meta.tiers.join(", ")}</p>
  ${meta.limitHit ? `<p class="limit"><strong>${limitStoppedRun(results) ? "Stopped early." : "Limit breached (run continued)."}</strong> ${escapeHtml(meta.limitHit)}</p>` : ""}

  <div class="headline">
    <div class="ring-wrap">
      <svg class="ring" width="${RING.size}" height="${RING.size}" viewBox="0 0 ${RING.size} ${RING.size}"
           role="img" aria-label="${meta.passed} of ${total} suites passed">
        <circle class="ring-track" cx="${RING.size / 2}" cy="${RING.size / 2}" r="${radius}"
                fill="none" stroke-width="${RING.stroke}"></circle>
        <circle class="ring-bar" cx="${RING.size / 2}" cy="${RING.size / 2}" r="${radius}"
                fill="none" stroke-width="${RING.stroke}" stroke-linecap="round"
                stroke-dasharray="${circumference.toFixed(2)}"
                stroke-dashoffset="${dashoffset.toFixed(2)}"></circle>
      </svg>
      ${frogSvg('class="ring-frog" aria-hidden="true"')}
    </div>
    <dl class="stats">
      <div class="stat"><dt>Passed</dt><dd>${meta.passed}</dd></div>
      <div class="stat ${meta.failed ? "is-bad" : "is-null"}"><dt>Failed</dt><dd>${meta.failed}</dd></div>
      <div class="stat ${meta.skipped ? "" : "is-null"}"><dt>Skipped</dt><dd>${meta.skipped}</dd></div>
      <div class="stat"><dt>Wall time</dt><dd>${fmtDuration(meta.durationSeconds)}</dd></div>
      <div class="stat ${meta.costUsd > 0 ? "" : "is-null"}"><dt>Spend</dt><dd>${fmtCost(meta.costUsd)}</dd></div>
    </dl>
  </div>

  <div class="frog-hr">${frogSvg('aria-hidden="true"')}</div>
</header>

<main class="bleed">
${
  results.length === 0
    ? empty
    : `<table class="suites">
<thead><tr>
  <th>Suite</th><th>Tier</th><th>Status</th><th class="num">Tests</th>
  <th class="num">Time</th><th class="num">Spend</th><th class="num">Tries</th><th></th>
</tr></thead>
<tbody>
${rows}
</tbody></table>`
}
</main>

<script>
for (const b of document.querySelectorAll(".toggle")) {
  b.addEventListener("click", () => {
    const row = document.getElementById("detail-" + b.dataset.id);
    row.hidden = !row.hidden;
    b.setAttribute("aria-expanded", String(!row.hidden));
  });
}
</script>
</body></html>`;

  fs.writeFileSync(path.join(outDir, "report.html"), html);
}

interface RunMeta {
  runId: string;
  tiers: Tier[];
  passed: number;
  failed: number;
  skipped: number;
  durationSeconds: number;
  costUsd: number;
  limitHit?: string;
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    printHelp();
    process.exit(2);
  }

  const suites = resolveSuites({ tiers: opts.tiers, filter: opts.filter });

  // Auto concurrency: min(4, suites, cores/2). Four is the configuration the
  // flake audit measured stable across full sweeps (26/26, 6m54s vs ~24m
  // sequential — intermediates/53); the cores/2 clamp keeps CI's 2-core
  // runners from thrashing four server-booting suites at once. Explicit
  // --concurrency (including 1 for sequential) always wins.
  const autoConcurrency = opts.concurrency === 0;
  if (opts.concurrency === 0) {
    const halfCores = Math.max(1, Math.floor(os.cpus().length / 2));
    opts.concurrency = Math.max(1, Math.min(4, suites.length, halfCores));
  }

  // Per-suite spend is measured over a time window (see measureSpendSince), so
  // two suites running at once would each be billed for the other's codons.
  // Under concurrency, per-suite cost is therefore reported as unattributable
  // ("—") rather than as a number that is quietly wrong; the RUN-level total
  // stays honest because it is measured over the whole run's window. `--list`
  // estimates and `--max-cost` projections are unaffected — they come from the
  // manifest, not the meter.
  if (opts.concurrency > 1) {
    const paid = suites.filter((s) => s.estCostUsd > 0);
    if (paid.length > 0) {
      console.log(
        `--concurrency ${opts.concurrency} with ${paid.length} paid suite(s): per-suite spend ` +
          `cannot be attributed (overlapping measurement windows) and will show "—". ` +
          `The run-level total is still measured.`,
      );
    }
  }

  if (suites.length === 0) {
    console.error("No suites matched the given tiers/filter.");
    process.exit(2);
  }

  if (opts.list) {
    console.log(`\nPlan (${suites.length} suites, tiers: ${opts.tiers.join(", ")}):\n`);
    let estCost = 0;
    let estTime = 0;
    for (const s of suites) {
      const miss = (s.needsEnv ?? []).filter((k) => !process.env[k]?.trim());
      estCost += s.estCostUsd;
      estTime += s.estSeconds;
      console.log(
        `  ${s.id.padEnd(38)} ${s.tier.padEnd(13)} ~${String(s.estSeconds).padStart(4)}s  ~${fmtCost(s.estCostUsd).padStart(7)}` +
          (miss.length ? `   SKIP (missing ${miss.join(", ")})` : ""),
      );
    }
    console.log(`\n  Estimated total: ~${fmtDuration(estTime)}, ~${fmtCost(estCost)} (sequential)`);
    const excluded = ALL_TIERS.filter((t) => !opts.tiers.includes(t));
    if (excluded.length > 0) {
      console.log(
        gray(
          `  Not listed: ${excluded
            .map((t) => `${t} (${resolveSuites({ tiers: [t] }).length})`)
            .join(" · ")} — \`--tier all\` lists everything`,
        ),
      );
    }
    console.log("");
    process.exit(0);
  }

  const outDir = path.join(ROOT, ".test-runs", opts.runId);
  fs.mkdirSync(path.join(outDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "junit"), { recursive: true });
  const jsonlPath = path.join(outDir, "results.jsonl");
  fs.writeFileSync(jsonlPath, "");
  fs.writeFileSync(path.join(outDir, "tests.jsonl"), "");

  const planSeconds = suites.reduce((sum, s) => sum + s.estSeconds, 0);
  console.log(
    `\n${bold(`Hankweave test suite — ${suites.length} suite${suites.length === 1 ? "" : "s"}, tiers: ${opts.tiers.join(", ")}`)}`,
  );
  // Name what this run does NOT cover — "where did happy-path go?" should be
  // answered by the header, not by knowing the tier taxonomy. Paid tiers are
  // excluded from `bun run test` by design (free means free, enforced by
  // suite-manifest-contracts); they must still be one glance away.
  {
    const excluded = ALL_TIERS.filter((t) => !opts.tiers.includes(t));
    if (excluded.length > 0) {
      const bits = excluded.map((t) => {
        const inTier = resolveSuites({ tiers: [t] });
        const cost = inTier.reduce((sum, s) => sum + s.estCostUsd, 0);
        return `${t} (${inTier.length}${cost > 0 ? `, ~${fmtCost(cost)}` : ""})`;
      });
      console.log(
        gray(`Not selected: ${bits.join(" · ")} — \`bun run test:list\` shows every suite`),
      );
    }
  }
  console.log(
    `Concurrency: ${opts.concurrency}${autoConcurrency ? " (auto)" : ""}` +
      ` · plan ~${fmtDuration(planSeconds)} sequential` +
      (opts.retries > 0 ? ` · retries ${opts.retries}` : "") +
      (opts.maxTimeSeconds !== undefined ? ` · max-time ${fmtDuration(opts.maxTimeSeconds)}` : "") +
      (opts.maxCostUsd !== undefined ? ` · max-cost ${fmtCost(opts.maxCostUsd)}` : ""),
  );
  console.log(
    `Output: ${path.relative(ROOT, outDir)}/ (logs/<suite>.log · results.jsonl · triage.md on failure)`,
  );
  console.log(gray(`Workspaces: tests/test-area/ + os tmpdir — aged residue swept by preflight`));
  console.log("");

  // ── Residue sweep + stdio preflight ──────────────────────────────
  // Root-caused live (intermediates/56 §incident): leftover execution dirs
  // in tests/test-area carry installed node_modules trees; at ~40 leftovers
  // the repo hit 281k directories, `bun test`'s discovery crawl held >10,237
  // directory fds, and past exactly that threshold Bun spawns every child
  // with CLOSED stdio — output silently vanishes while exit codes still
  // arrive (30+ phantom failures across unrelated suites, one cause).
  //
  // Two lines of defense, both here:
  //  1. Sweep aged test-area residue (>1h) so the directory count can never
  //     creep back to the cliff. Shares cleanup-after-tests so `bun run
  //     test`'s trailing cleanup and hub-started runners behave identically.
  //  2. Run the canary, which checks BOTH the fd headroom and an actual
  //     spawn's captured bytes. If it fails, no suite result can be trusted
  //     — abort loudly instead of emitting 30 lies.
  {
    const sweep = spawn("bun", ["tests/unit/cleanup-after-tests.ts"], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const sweepDone = Promise.withResolvers<void>();
    sweep.on("exit", () => sweepDone.resolve());
    sweep.on("error", () => sweepDone.resolve());
    await sweepDone.promise;

    // stderr is inherited: when the canary fails, its assertion output IS
    // the diagnosis (the first Windows CI run failed invisibly behind
    // "ignore" — /dev/fd doesn't exist there — and the abort message
    // blamed the fd cliff).
    const canary = spawn(
      "bun",
      ["test", "tests/unit/child-stdio-canary.test.ts", "--timeout", "10000"],
      { cwd: ROOT, env: process.env, stdio: ["ignore", "ignore", "inherit"] },
    );
    const { promise, resolve } = Promise.withResolvers<number | null>();
    canary.on("exit", (code) => resolve(code));
    canary.on("error", () => resolve(null));
    const canaryExit = await promise;
    if (canaryExit !== 0) {
      console.error(
        red(
          "\nPreflight FAILED: `bun test` children on this machine are losing stdio " +
            "(tests/unit/child-stdio-canary.test.ts). Known cause: a huge directory " +
            "count under this checkout pushes bun's test-discovery crawl past 10,237 " +
            "open dir fds, after which Bun spawns children with CLOSED stdio.\n" +
            "Fix: remove directory bloat — `rm -rf tests/test-area` residue is the " +
            "usual culprit (the preflight sweeps aged entries automatically; a run " +
            "in the last hour may have left fresh ones). Verify with " +
            "`find . -type d -not -path './node_modules*' | wc -l` — the repo " +
            "should be a few thousand, not hundreds of thousands. Full forensics: " +
            "intermediates/56-parallel-runner-and-test-hygiene/notes.md.",
        ),
      );
      process.exit(2);
    }
  }

  const runStart = Date.now();
  const results: SuiteResult[] = [];
  let limitHit: string | undefined;
  // Estimated spend of paid suites currently in flight. Measured spend only
  // materializes in state.json after codons run, so at dispatch time every
  // concurrent worker sees the same stale total — without a reservation, N
  // paid suites each pass the --max-cost check alone and breach it together.
  let reservedUsd = 0;

  /** Run one suite to a final result, including retries. */
  const executeSuite = async (suite: SuiteSpec): Promise<SuiteResult> => {
    const suiteStart = Date.now();
    const startedAt = new Date().toISOString();
    let attempt = 0;
    let last: SuiteAttempt | undefined;

    while (attempt < opts.retries + 1) {
      // A retry of a paid suite is another estimated charge — recheck the cost
      // limit before spending it. Deliberately conservative: this suite's own
      // dispatch reservation is still held while its first attempt's spend may
      // already have materialized, so the projection can double-count; for a
      // hard budget cap, declining on uncertainty is the right failure mode.
      if (
        attempt > 0 &&
        suite.estCostUsd > 0 &&
        opts.maxCostUsd !== undefined &&
        measureSpendSince(runStart) + reservedUsd + suite.estCostUsd > opts.maxCostUsd
      ) {
        if (!limitHit) {
          limitHit =
            `cost limit ${fmtCost(opts.maxCostUsd)} would be exceeded ` +
            `by retrying '${suite.id}' (estimates ~${fmtCost(suite.estCostUsd)} per attempt)`;
        }
        if (!opts.keepGoingOnLimit) break;
      }
      attempt++;
      last = await runSuiteOnce(suite, outDir, attempt);
      if (last.exitCode === 0) break;
    }

    const junit = parseJUnit(path.join(outDir, "junit", `${suite.id}.xml`));
    const status: SuiteResult["status"] =
      last?.timedOut && last.exitCode !== 0
        ? "timed-out"
        : last?.exitCode === 0
          ? "passed"
          : "failed";

    const failedCases =
      junit?.cases
        .filter((c) => c.status === "fail")
        .map((c) => ({ name: c.name, file: c.file, failure: c.failure })) ?? [];

    // One row per test case, machine-first: `tests.jsonl` is the file an agent
    // greps to find WHICH test broke and with what message, without parsing
    // junit XML or scraping logs. Single appendFileSync per suite keeps
    // interleaving safe under the worker pool.
    if (junit) {
      const rows = junit.cases
        .map((c) =>
          JSON.stringify({
            suite: suite.id,
            tier: suite.tier,
            file: c.file,
            name: c.name,
            status: c.status,
            timeSeconds: c.timeSeconds,
            ...(c.failure ? { failure: c.failure } : {}),
            ...(attempt > 1 ? { attempts: attempt } : {}),
          }),
        )
        .join("\n");
      fs.appendFileSync(path.join(outDir, "tests.jsonl"), `${rows}\n`);
    }

    const passed = status === "passed";
    return {
      id: suite.id,
      tier: suite.tier,
      files: suite.files,
      status,
      exitCode: last?.exitCode ?? null,
      durationSeconds: last?.durationSeconds ?? 0,
      // Cost attribution needs an exclusive time window: under concurrency a
      // suite's window catches other suites' codons, so per-suite spend is
      // unattributable and reported as 0 (rendered "—"). The run-level total
      // in meta.costUsd is still measured over the whole run.
      costUsd: opts.concurrency === 1 ? measureSpendSince(suiteStart) : 0,
      attempts: attempt,
      tests: junit?.tests ?? 0,
      failures: junit?.failures ?? 0,
      skippedTests: junit?.skipped ?? 0,
      failedTestNames: failedCases.map((c) => c.name),
      failedCases,
      // Triage metadata rides on non-passed rows so results.jsonl is
      // self-explaining: an agent reading a FAIL row learns what the suite
      // defends and where to start, without opening the manifest.
      ...(passed
        ? {}
        : {
            description: suite.description,
            failureMeans: suite.failureMeans,
            ...(suite.suspects ? { suspects: suite.suspects } : {}),
          }),
      logPath: path.join("logs", `${suite.id}.log`),
      junitPath: path.join("junit", `${suite.id}.xml`),
      startedAt,
    };
  };

  // ─── Live status block ───────────────────────────────────────────
  // Rich terminals get an animated multi-line status block (~8 fps): one row
  // per running suite (elapsed vs measured estimate, tests streamed, files),
  // one row for the queue, one for the run-level clock. The block is redrawn
  // in place (cursor-up + erase-below) and every row is clipped to the
  // terminal width — a wrapped row breaks the redraw arithmetic and strands
  // stale lines on screen, which is exactly how the old single-line ticker
  // died: N concurrent suites joined with "|" overflow any terminal.
  // Anything that prints a real line clears the block first. Everything else
  // (CI, hub logs, dumb terminals, agents) gets explicit start/result lines.
  const interactive = IS_RICH_TTY;

  // Bounded worker pool feed. Suites are independent processes on dynamic
  // ports with unique execution directories, so running several at once is
  // safe; under concurrency, per-suite spend is reported as unattributable
  // (see the note where results are assembled) while the run-level total
  // stays measured. Sequential runs keep manifest order (curated,
  // cheap-first, readable). Concurrent runs schedule longest-first: with a
  // pool of N, wall time approaches max(longest suite, total/N) only if the
  // long suites start early — manifest order left e2e-loop (~6min, the
  // critical path) starting mid-run and dangling past the pool. Estimates
  // are measured, so LPT here is trustworthy. (Declared here so the status
  // block can show what's still queued.)
  const queue =
    opts.concurrency > 1 ? [...suites].sort((a, b) => b.estSeconds - a.estSeconds) : [...suites];

  let statusLinesDrawn = 0;
  const clearStatusBlock = () => {
    if (!interactive || statusLinesDrawn === 0) return;
    process.stdout.write(`\r\x1b[${statusLinesDrawn}A\x1b[0J`);
    statusLinesDrawn = 0;
  };
  // Clip to the terminal width WITHOUT counting ANSI codes and without ever
  // cutting one in half — a broken escape sequence bleeds style into the
  // next row; an over-width row wraps and breaks the redraw arithmetic.
  const clip = (line: string): string => {
    const width = (process.stdout.columns ?? 120) - 1;
    if (stripAnsi(line).length <= width) return line;
    let out = "";
    let visible = 0;
    for (let i = 0; i < line.length; ) {
      const code = line[i] === "\x1b" ? ANSI_CODE_PREFIX.exec(line.slice(i)) : null;
      if (code) {
        out += code[0];
        i += code[0].length;
        continue;
      }
      if (visible === width - 1) break;
      out += line[i];
      visible++;
      i++;
    }
    return `${out}…${USE_COLOR ? "\x1b[0m" : ""}`;
  };
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerFrame = 0;
  const renderStatusBlock = () => {
    if (!interactive) return;
    clearStatusBlock();
    if (liveProgress.size === 0 && queue.length === 0) return;
    const spin = SPINNER[spinnerFrame++ % SPINNER.length];
    const now = Date.now();
    const rows: string[] = [];
    for (const p of liveProgress.values()) {
      const pace = `${fmtDuration((now - p.startedAt) / 1000)} / ~${fmtDuration(p.suite.estSeconds)}`;
      let tests =
        p.testsSeen > 0 ? `${p.testsSeen} test${p.testsSeen === 1 ? "" : "s"}` : "starting";
      if (p.failsSeen > 0) tests += `, ${p.failsSeen} FAIL`;
      if (p.attempt > 1) tests += ` (retry ${p.attempt})`;
      const testsCell = tests.padEnd(20);
      const files =
        p.suite.files.length === 1
          ? p.suite.files[0]
          : `${p.suite.files[0]} +${p.suite.files.length - 1}`;
      rows.push(
        `  ${cyan(spin)} ${bold(p.suite.id.padEnd(34))} ${pace.padEnd(16)} ` +
          `${p.failsSeen > 0 ? red(testsCell) : testsCell} ${gray(files)}`,
      );
    }
    if (queue.length > 0) {
      rows.push(gray(`  … ${queue.length} queued: ${queue.map((s) => s.id).join(", ")}`));
    }
    rows.push(
      gray(
        `  ── ${results.length}/${suites.length} done` +
          ` · ${opts.concurrency} worker${opts.concurrency > 1 ? "s" : ""}` +
          ` · ${fmtDuration((now - runStart) / 1000)} elapsed / ~${fmtDuration(planSeconds)} plan`,
      ) + (limitHit ? red(` · LIMIT HIT: ${limitHit}`) : ""),
    );
    process.stdout.write(`${rows.map(clip).join("\n")}\n`);
    statusLinesDrawn = rows.length;
  };
  let statusTicker: ReturnType<typeof setInterval> | undefined;
  if (interactive) {
    // ~8 fps: smooth spinner and sub-second elapsed at negligible cost (a
    // handful of short rows per frame).
    statusTicker = setInterval(renderStatusBlock, 120);
    statusTicker.unref?.();
    // Hide the cursor while the block redraws — it otherwise strobes across
    // the rows. Restored on every exit path, signals included.
    process.stdout.write("\x1b[?25l");
    process.on("exit", () => process.stdout.write("\x1b[?25h"));
  }
  // Signal handlers are installed for EVERY mode, not just interactive: suites
  // run detached in their own process groups, so neither the terminal's Ctrl-C
  // nor a runner-only SIGTERM (CI cancellation) reaches them — without this,
  // exiting strands bun test children, e2e servers, and in-flight paid calls.
  // SIGKILL to each group mirrors the suite-timeout path: the runner exits
  // immediately, so nobody is left to escalate a softer signal.
  const terminateAndExit = (exitCode: number) => {
    if (interactive) process.stdout.write("\x1b[?25h");
    for (const kill of activeKillers) kill("SIGKILL");
    process.exit(exitCode);
  };
  process.once("SIGINT", () => terminateAndExit(130));
  process.once("SIGTERM", () => terminateAndExit(143));

  const counterWidth = String(suites.length).length;
  const record = (result: SuiteResult) => {
    results.push(result);
    clearStatusBlock();
    fs.appendFileSync(jsonlPath, `${JSON.stringify(result)}\n`);
    const counter = gray(`[${String(results.length).padStart(counterWidth)}/${suites.length}]`);
    if (result.status === "skipped") {
      console.log(
        `  ${yellow("SKIP ")} ${counter} ${result.id.padEnd(38)} ${gray(result.skipReason ?? "")}`,
      );
      return;
    }
    const label =
      result.status === "passed"
        ? green("pass ")
        : result.status === "timed-out"
          ? yellow(bold("TMOUT"))
          : red(bold("FAIL "));
    // Failures point at their log immediately — the next question is always
    // "show me", and agents grep the path straight out of the line.
    const logHint =
      result.status === "passed"
        ? ""
        : `  → ${path.join(path.relative(ROOT, outDir), result.logPath)}`;
    console.log(
      `  ${label} ${counter} ${result.id.padEnd(38)} ${fmtDuration(result.durationSeconds).padStart(7)}  ${fmtCost(result.costUsd).padStart(8)}` +
        (result.attempts > 1 ? yellow(`  (${result.attempts} tries)`) : "") +
        (result.failures ? red(`  ${result.failures} failing`) : "") +
        (logHint ? gray(logHint) : ""),
    );
    // On GitHub, a failed suite also emits a ::error:: workflow command —
    // the log line alone is buried in a fold; the annotation pins the
    // failure to a file in the PR checks UI with the rerun pointers.
    if (ON_GITHUB && (result.status === "failed" || result.status === "timed-out")) {
      const file = result.failedCases[0]?.file || result.files[0];
      const names = result.failedTestNames.slice(0, 3).join(" | ");
      console.log(
        `::error file=${ghEscProp(file)},title=${ghEscProp(`suite ${result.id} ${result.status}`)}::` +
          ghEscData(
            `${result.failures || "?"} failing${names ? ` — ${names}` : ""} · ` +
              `log: .test-runs/${opts.runId}/${result.logPath} · ` +
              `triage: .test-runs/${opts.runId}/triage.md`,
          ),
      );
    }
  };

  /**
   * Reasons a suite is not going to run. Evaluated at dispatch so a limit
   * tripped by an earlier suite still stops the ones behind it.
   */
  const declineReason = (suite: SuiteSpec): string | undefined => {
    // Credentials first: a suite that cannot run for lack of keys is a
    // documented green skip, and its estimate must never count toward — or
    // trip — a budget limit. Checked before any limitHit mutation, otherwise
    // an unaffordable keyless suite poisons the global flag, turns itself
    // into a red budget failure, and declines every free suite behind it.
    const missing = (suite.needsEnv ?? []).filter((k) => !process.env[k]?.trim());
    if (missing.length > 0) return `missing ${missing.join(", ")}`;

    const elapsed = (Date.now() - runStart) / 1000;
    const spentSoFar = measureSpendSince(runStart);

    // Limits are checked against what this suite is *projected* to add, not just
    // what has already been spent. A reactive check lets one expensive suite
    // blow the whole budget, because the overrun is only noticed once it is
    // already paid for — and the marathon context-exhaustion suite alone is
    // ~$1.50 and ~30 minutes. Declared estimates exist precisely so a run can
    // decline a suite it cannot afford. In-flight suites' estimates are held
    // in reservedUsd until their spend materializes in state.json.
    if (!limitHit && opts.maxTimeSeconds !== undefined) {
      if (elapsed + suite.estSeconds > opts.maxTimeSeconds) {
        limitHit =
          `time limit ${opts.maxTimeSeconds}s would be exceeded ` +
          `(${fmtDuration(elapsed)} elapsed, '${suite.id}' needs ~${fmtDuration(suite.estSeconds)})`;
      }
    }
    if (!limitHit && opts.maxCostUsd !== undefined) {
      if (spentSoFar + reservedUsd + suite.estCostUsd > opts.maxCostUsd) {
        limitHit =
          `cost limit ${fmtCost(opts.maxCostUsd)} would be exceeded ` +
          `(${fmtCost(spentSoFar)} spent, ${fmtCost(reservedUsd)} in flight, ` +
          `'${suite.id}' estimates ~${fmtCost(suite.estCostUsd)})`;
      }
    }

    return limitHit && !opts.keepGoingOnLimit ? limitHit : undefined;
  };

  const skipResult = (suite: SuiteSpec, skipReason: string): SuiteResult => ({
    id: suite.id,
    tier: suite.tier,
    files: suite.files,
    status: "skipped",
    skipReason,
    exitCode: null,
    durationSeconds: 0,
    costUsd: 0,
    attempts: 0,
    tests: 0,
    failures: 0,
    skippedTests: 0,
    failedTestNames: [],
    failedCases: [],
    logPath: path.join("logs", `${suite.id}.log`),
    startedAt: new Date().toISOString(),
  });

  // (Pool feed `queue` is declared with the status block above so the ticker
  // can render what's still pending.)
  let bailed = false;

  const worker = async () => {
    while (true) {
      // Check bailed BEFORE shifting: a worker that shifts first and then
      // returns on bail has removed the suite from the queue without
      // recording it — it would vanish from results.jsonl and the report,
      // violating the "reported, not lost" guarantee below.
      if (bailed) return;
      const suite = queue.shift();
      if (!suite) return;

      const reason = declineReason(suite);
      if (reason) {
        record(skipResult(suite, reason));
        continue;
      }

      // The ticker owns the status block on interactive terminals; non-TTY
      // consumers (CI, hub logs, agents) get an explicit start line so a
      // long suite is never a silent gap.
      if (!interactive) {
        console.log(
          gray(
            `  start ${suite.id} (${suite.tier}, ${suite.files.length} file${suite.files.length === 1 ? "" : "s"}, est ~${fmtDuration(suite.estSeconds)})`,
          ),
        );
      }
      // Reserve this suite's estimate while it runs; by release time its real
      // spend is visible to measureSpendSince (a suite that deletes its own
      // execution directory keeps today's floor semantics).
      reservedUsd += suite.estCostUsd;
      let result: SuiteResult;
      try {
        result = await executeSuite(suite);
      } finally {
        reservedUsd -= suite.estCostUsd;
      }
      record(result);

      if (opts.bail && result.status !== "passed") {
        limitHit = `bailed after ${suite.id} failed`;
        bailed = true;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, worker));

  clearInterval(statusTicker);
  clearStatusBlock();

  // Anything still queued when a bail cut the pool short is reported, not lost.
  for (const suite of queue) record(skipResult(suite, limitHit ?? "not reached"));

  const meta: RunMeta = {
    runId: opts.runId,
    tiers: opts.tiers,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed" || r.status === "timed-out").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    durationSeconds: (Date.now() - runStart) / 1000,
    costUsd: measureSpendSince(runStart),
    limitHit,
  };

  fs.writeFileSync(
    path.join(outDir, "results.json"),
    `${JSON.stringify({ meta, results }, null, 2)}\n`,
  );
  writeSummaryMarkdown(outDir, results, meta);
  writeHtmlReport(outDir, results, meta);
  const triageWritten = writeTriage(outDir, results, meta);

  // A stable path so `open .test-runs/latest/report.html` always works.
  const latest = path.join(ROOT, ".test-runs", "latest");
  try {
    if (fs.existsSync(latest)) fs.rmSync(latest, { recursive: true, force: true });
    fs.symlinkSync(outDir, latest, "dir");
  } catch {
    // Symlinks can fail on Windows without developer mode; the run still stands.
  }

  // A suite skipped for missing credentials is a legitimate outcome — CI has no
  // Anthropic key and says so. A suite skipped because a limit was hit is not:
  // the run did less than it was asked to, and going green on that is precisely
  // how the e2e tier became invisible in the first place.
  const skippedByLimit = results.filter(
    (r) => r.status === "skipped" && r.skipReason && !r.skipReason.startsWith("missing "),
  );

  const passedBit = (meta.passed > 0 ? green : String)(`${meta.passed} passed`);
  const failedBit = meta.failed > 0 ? red(bold(`${meta.failed} failed`)) : `${meta.failed} failed`;
  const skippedBit = (meta.skipped > 0 ? yellow : String)(`${meta.skipped} skipped`);
  console.log(
    `\n${passedBit} · ${failedBit} · ${skippedBit} — ` +
      `${fmtDuration(meta.durationSeconds)}, ${fmtCost(meta.costUsd)}`,
  );
  if (limitHit) {
    // Under --continue-past-limit nothing was declined, so "Stopped early"
    // would contradict the run that just completed in full.
    if (skippedByLimit.length > 0) {
      console.log(red(`Stopped early: ${limitHit}`));
      console.log(`Not run: ${skippedByLimit.map((r) => r.id).join(", ")}`);
    } else {
      console.log(yellow(`Limit breached (run continued): ${limitHit}`));
    }
  }
  console.log(`\nReport:  ${path.relative(ROOT, path.join(outDir, "report.html"))}`);
  console.log(`Summary: ${path.relative(ROOT, path.join(outDir, "summary.md"))}`);
  console.log(
    `Grep:    ${path.relative(ROOT, jsonlPath)} · ${path.relative(ROOT, path.join(outDir, "tests.jsonl"))}`,
  );
  if (triageWritten) {
    console.log(
      `Triage:  ${path.relative(ROOT, path.join(outDir, "triage.md"))} (what failed, what it means, how to rerun)`,
    );
  }
  console.log("");

  process.exit(meta.failed > 0 || skippedByLimit.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
