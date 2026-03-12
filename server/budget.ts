/**
 * Unified budget module.
 *
 * Contains:
 * - BudgetTracker: per-codon limit enforcement (cost, duration, output tokens)
 * - resolveCodonBudget: allocation logic (shared, proportional, proportional-strict)
 * - Budget: run-level facade that ties everything together
 *
 * Shared types (BudgetLimits, BudgetExceededInfo, etc.) live in types/budget-types.ts
 * and are re-exported here for convenience.
 */

import type { CostTrackerEvents } from "./cost-tracker.js";
import type { ExecutionCodonEntry } from "./execution-planner.js";
import { TypedEventEmitter } from "./typed-event-emitter.js";
import type { CodonId } from "./types/branded-types.js";
import {
  type AllocationMode,
  type BudgetExceededInfo,
  BudgetLimits,
  type BudgetLimitsOptions,
  type BudgetSummaryData,
  type CodonBudgetSummaryRow,
  type OnExceededPolicy,
} from "./types/budget-types.js";
import { getCodonCost, getCodonTokens, type Run } from "./types/state-types.js";
import type { Logger } from "./utils.js";

// Re-export shared types so consumers can import from "./budget.js"
export type {
  AllocationMode,
  BudgetCurrency,
  BudgetExceededData,
  BudgetExceededInfo,
  BudgetLimitsOptions,
  BudgetSummaryData,
  CodonBudgetSummaryRow,
  OnExceededPolicy,
} from "./types/budget-types.js";
export { BUDGET_CURRENCIES, BudgetLimits } from "./types/budget-types.js";

// =============================================================================
// BudgetTracker — per-codon limit enforcement
// =============================================================================

export interface BudgetTrackerEvents extends Record<string, unknown[]> {
  exceeded: [info: BudgetExceededInfo];
}

/**
 * Pure logic class that tracks budget consumption against limits.
 * Emits `exceeded` event (at most once) when any currency goes over its limit.
 * No I/O, no runtime dependencies — designed for unit testing.
 */
export class BudgetTracker extends TypedEventEmitter<BudgetTrackerEvents> {
  private costUsed = 0;
  private outputTokensUsed = 0;
  private contextTokensHighWaterMark = 0;
  private readonly startTime: number;
  private exceededInfo: BudgetExceededInfo | undefined;

  constructor(private readonly limits: BudgetLimits) {
    super();
    this.startTime = Date.now();
  }

  /** Accumulate cost and check against limit. */
  addCost(delta: number): void {
    if (this.exceededInfo) return;
    if (delta === 0) return;
    if (delta < 0) {
      console.warn(
        `BudgetTracker.addCost: negative delta ${delta} ignored (counters must monotonically increase)`,
      );
      return;
    }
    this.costUsed += delta;
    if (this.limits.maxDollars !== undefined && this.costUsed >= this.limits.maxDollars) {
      const sourceInfo = this.limits.costSource ? ` [${this.limits.costSource}]` : "";
      this.setExceeded({
        currency: "cost",
        limit: this.limits.maxDollars,
        used: this.costUsed,
        message: `Cost $${this.costUsed.toFixed(4)} exceeded limit $${this.limits.maxDollars.toFixed(4)}${sourceInfo}`,
      });
    }
  }

  /** Accumulate output tokens and check against limit. */
  addOutputTokens(delta: number): void {
    if (this.exceededInfo) return;
    if (delta === 0) return;
    if (delta < 0) {
      console.warn(
        `BudgetTracker.addOutputTokens: negative delta ${delta} ignored (counters must monotonically increase)`,
      );
      return;
    }
    this.outputTokensUsed += delta;
    if (
      this.limits.maxOutputTokens !== undefined &&
      this.outputTokensUsed >= this.limits.maxOutputTokens
    ) {
      this.setExceeded({
        currency: "outputTokens",
        limit: this.limits.maxOutputTokens,
        used: this.outputTokensUsed,
        message: `Output tokens ${this.outputTokensUsed} exceeded limit ${this.limits.maxOutputTokens}`,
      });
    }
  }

  /**
   * Update the context token high-water mark and check against limit.
   * Called with per-turn inputTokens + outputTokens (NOT cumulative sum).
   * Tracks the peak context window fill level across all turns.
   */
  updateContextTokens(inputTokensThisTurn: number, outputTokensThisTurn: number): void {
    if (this.exceededInfo) return;
    if (this.limits.maxContextTokens === undefined) return;
    const contextSize = inputTokensThisTurn + outputTokensThisTurn;
    if (contextSize > this.contextTokensHighWaterMark) {
      this.contextTokensHighWaterMark = contextSize;
    }
    if (this.contextTokensHighWaterMark >= this.limits.maxContextTokens) {
      this.setExceeded({
        currency: "contextTokens",
        limit: this.limits.maxContextTokens,
        used: this.contextTokensHighWaterMark,
        message: `Context tokens ${this.contextTokensHighWaterMark} exceeded limit ${this.limits.maxContextTokens}`,
      });
    }
  }

  /** Check elapsed wall-clock time against duration limit. */
  checkTime(): void {
    if (this.exceededInfo) return;
    if (this.limits.maxTimeSeconds === undefined) return;
    const elapsed = (Date.now() - this.startTime) / 1000;
    if (elapsed >= this.limits.maxTimeSeconds) {
      this.setExceeded({
        currency: "duration",
        limit: this.limits.maxTimeSeconds,
        used: elapsed,
        message: `Duration ${elapsed.toFixed(1)}s exceeded limit ${this.limits.maxTimeSeconds}s`,
      });
    }
  }

  /** Has any budget limit been exceeded? */
  isExceeded(): boolean {
    return this.exceededInfo !== undefined;
  }

  /** Get info about which limit was exceeded, if any. */
  getExceededInfo(): BudgetExceededInfo | undefined {
    return this.exceededInfo;
  }

  /** Remaining cost budget, or undefined if no cost limit. */
  getRemainingCost(): number | undefined {
    if (this.limits.maxDollars === undefined) return undefined;
    return Math.max(0, this.limits.maxDollars - this.costUsed);
  }

  /** Current consumption state. */
  getState(): {
    costUsed: number;
    outputTokensUsed: number;
    contextTokensHighWaterMark: number;
    elapsedSeconds: number;
  } {
    return {
      costUsed: this.costUsed,
      outputTokensUsed: this.outputTokensUsed,
      contextTokensHighWaterMark: this.contextTokensHighWaterMark,
      elapsedSeconds: (Date.now() - this.startTime) / 1000,
    };
  }

  /** Whether any limits are configured. */
  hasLimits(): boolean {
    return this.limits.hasLimits();
  }

  private setExceeded(info: BudgetExceededInfo): void {
    if (this.exceededInfo) return; // idempotent — emit at most once
    this.exceededInfo = info;
    this.emit("exceeded", info);
  }
}

// =============================================================================
// Budget allocator — resolves per-codon limits from global budget
// =============================================================================

export interface CodonBudgetConfig {
  maxDollars?: number;
  maxTimeSeconds?: number;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  onExceeded?: OnExceededPolicy;
}

export type RemainingCodonInfo = Pick<CodonBudgetConfig, "maxDollars"> & {
  /** Config-level ID, used to look up in parent's shares map. */
  codonConfigId?: string;
};

export interface ResolveCodonBudgetParams {
  codon: CodonBudgetConfig;
  /** Codons that haven't started yet (excluding the current codon). */
  remainingCodons: RemainingCodonInfo[];
  /** Effective global budget (min of runtime and hank maxDollars). */
  globalMaxDollars?: number;
  /** Total cost already spent across completed/failed codons. */
  alreadySpent: number;
  // --- Allocation mode fields ---
  /** Allocation mode from the parent container's budget config. Default: "shared". */
  allocationMode?: AllocationMode;
  /** Share map from parent's budget config: child config ID → fraction (0-1). */
  shares?: Record<string, number>;
  /** The codon's config-level ID (used to look up in shares map). */
  codonConfigId?: string;
  /**
   * For proportional-strict mode: the amount of budget "consumed" by completed codons
   * using strict accounting (max of share amount and actual spend per codon).
   * If undefined, falls back to alreadySpent.
   */
  strictAlreadyConsumed?: number;
  /**
   * Remaining wall-clock seconds from the hank-level time budget.
   * When set, the codon's effective duration = min(codon.maxTimeSeconds, remainingTimeSeconds).
   */
  remainingTimeSeconds?: number;
  /** Container-level (hank/loop) onExceeded default. Codon-level overrides this. */
  containerOnExceeded?: OnExceededPolicy;
}

/**
 * Resolves effective budget limits for a single codon execution.
 * Pure function — no I/O, no side effects.
 *
 * When a global budget exists, every codon gets a cost limit.
 * Allocation mode determines how the budget is distributed among children.
 */
export function resolveCodonBudget(params: ResolveCodonBudgetParams): BudgetLimits {
  const { codon } = params;
  const opts: BudgetLimitsOptions = {};

  // --- Cost ---
  const costResult = resolveCostLimit(params);
  opts.maxDollars = costResult?.limit;
  opts.costSource = costResult?.source;

  // --- Duration: min(per-codon cap, hank remaining time) ---
  if (codon.maxTimeSeconds !== undefined || params.remainingTimeSeconds !== undefined) {
    const candidates = [codon.maxTimeSeconds, params.remainingTimeSeconds].filter(
      (v): v is number => v !== undefined,
    );
    if (candidates.length > 0) {
      opts.maxTimeSeconds = Math.max(0, Math.min(...candidates));
    }
  }

  // --- Output tokens (per-codon cap, fresh each execution) ---
  if (codon.maxOutputTokens !== undefined) {
    opts.maxOutputTokens = codon.maxOutputTokens;
  }

  // --- Context tokens (per-codon cap, high-water mark of context window) ---
  if (codon.maxContextTokens !== undefined) {
    opts.maxContextTokens = codon.maxContextTokens;
  }

  // --- onExceeded: codon-level overrides container-level, default "complete" ---
  opts.onExceeded = codon.onExceeded ?? params.containerOnExceeded ?? "complete";

  return new BudgetLimits(opts);
}

interface CostResolution {
  limit: number;
  source: string;
}

function resolveCostLimit(params: ResolveCodonBudgetParams): CostResolution | undefined {
  const { codon, globalMaxDollars, alreadySpent, allocationMode = "shared" } = params;

  const globalRemaining =
    globalMaxDollars !== undefined ? Math.max(0, globalMaxDollars - alreadySpent) : undefined;

  if (globalMaxDollars === undefined && codon.maxDollars === undefined) {
    return undefined;
  }

  let modeLimit: number | undefined;
  let modeSource: string | undefined;

  switch (allocationMode) {
    case "shared":
      modeLimit = resolveSharedMode(params, globalRemaining);
      if (modeLimit !== undefined) modeSource = "shared pool";
      break;
    case "proportional": {
      const share = lookupShare(params.codonConfigId, params.shares);
      modeLimit = resolveProportionalMode(params, globalRemaining);
      if (share !== undefined && globalMaxDollars !== undefined) {
        modeSource = `proportional share (${(share * 100).toFixed(0)}% of $${globalMaxDollars.toFixed(2)})`;
      } else {
        modeSource = "uniform share";
      }
      break;
    }
    case "proportional-strict": {
      const share = lookupShare(params.codonConfigId, params.shares);
      modeLimit = resolveProportionalStrictMode(params, globalRemaining);
      if (share !== undefined && globalMaxDollars !== undefined) {
        modeSource = `strict share (${(share * 100).toFixed(0)}% of $${globalMaxDollars.toFixed(2)})`;
      } else {
        modeSource = "uniform share (strict)";
      }
      break;
    }
  }

  // Apply codon maxDollars as a hard ceiling
  if (codon.maxDollars !== undefined) {
    const hasShare = lookupShare(params.codonConfigId, params.shares) !== undefined;
    if (hasShare && modeLimit !== undefined) {
      const capped = Math.min(modeLimit, codon.maxDollars);
      const source =
        capped === codon.maxDollars
          ? `codon cap (share was $${modeLimit.toFixed(2)})`
          : (modeSource ?? "unknown");
      return { limit: capped, source };
    }
    if (globalRemaining !== undefined) {
      const capped = Math.min(codon.maxDollars, globalRemaining);
      const source = capped === globalRemaining ? "global remaining" : "codon cap";
      return { limit: capped, source };
    }
    return { limit: codon.maxDollars, source: "codon cap" };
  }

  if (modeLimit !== undefined) {
    return { limit: modeLimit, source: modeSource ?? "unknown" };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Shared mode (default) — first-past-the-post shared pool
// ---------------------------------------------------------------------------

function resolveSharedMode(
  _params: ResolveCodonBudgetParams,
  globalRemaining: number | undefined,
): number | undefined {
  // First-past-the-post: codon gets access to the entire remaining pool.
  // When the pool is empty, whoever's running gets stopped.
  return globalRemaining;
}

// ---------------------------------------------------------------------------
// Proportional mode (generous) — share-based, unspent flows back
// ---------------------------------------------------------------------------

function resolveProportionalMode(
  params: ResolveCodonBudgetParams,
  globalRemaining: number | undefined,
): number | undefined {
  const { remainingCodons, shares, globalMaxDollars, codonConfigId } = params;

  if (globalMaxDollars === undefined || globalRemaining === undefined) {
    return undefined;
  }

  // Look up this codon's share
  const codonShare = lookupShare(codonConfigId, shares);

  if (codonShare !== undefined) {
    // Share-based allocation, bounded by global remaining (generous: unspent flows back)
    const allocation = codonShare * globalMaxDollars;
    return Math.min(allocation, globalRemaining);
  }

  // Codon has no share → split unallocated remainder uniformly
  return computeProportionalUniformShare(
    remainingCodons,
    shares,
    globalMaxDollars,
    globalRemaining,
  );
}

/**
 * Look up a codon's share from the parent shares map.
 */
function lookupShare(
  codonConfigId: string | undefined,
  shares: Record<string, number> | undefined,
): number | undefined {
  if (codonConfigId && shares && codonConfigId in shares) {
    return shares[codonConfigId];
  }
  return undefined;
}

/**
 * For proportional mode: compute uniform share for a codon NOT in the shares map.
 * The unallocated pool = globalMaxDollars * (1 - sum of all shares).
 * Distribute evenly among codons without shares (including current codon).
 * Bounded by globalRemaining.
 */
function computeProportionalUniformShare(
  remainingCodons: RemainingCodonInfo[],
  shares: Record<string, number> | undefined,
  globalMaxDollars: number,
  globalRemaining: number,
): number {
  const totalShared = shares ? Object.values(shares).reduce((a, b) => a + b, 0) : 0;
  const unallocatedPool = Math.max(0, 1 - totalShared) * globalMaxDollars;

  // Count unshared codons among remaining (plus current = 1)
  let unsharedCount = 1;
  for (const c of remainingCodons) {
    const hasShare =
      c.codonConfigId !== undefined && shares !== undefined && c.codonConfigId in shares;
    const hasExplicit = c.maxDollars !== undefined;
    if (!hasShare && !hasExplicit) {
      unsharedCount++;
    }
  }

  const share = unallocatedPool / unsharedCount;
  return Math.min(share, globalRemaining);
}

// ---------------------------------------------------------------------------
// Proportional-strict mode — share-based, unspent evaporates
// ---------------------------------------------------------------------------

function resolveProportionalStrictMode(
  params: ResolveCodonBudgetParams,
  _globalRemaining: number | undefined,
): number | undefined {
  const {
    remainingCodons,
    globalMaxDollars,
    alreadySpent,
    shares,
    codonConfigId,
    strictAlreadyConsumed,
  } = params;

  if (globalMaxDollars === undefined) {
    return undefined;
  }

  // Strict remaining uses strict accounting (max of share amount and actual spend per codon)
  const effectiveConsumed = strictAlreadyConsumed ?? alreadySpent;
  const strictRemaining = Math.max(0, globalMaxDollars - effectiveConsumed);

  // Actual remaining is an absolute floor (can't give more than what's really left)
  const actualRemaining = Math.max(0, globalMaxDollars - alreadySpent);

  const codonShare = lookupShare(codonConfigId, shares);

  if (codonShare !== undefined) {
    const allocation = codonShare * globalMaxDollars;
    return Math.min(allocation, strictRemaining, actualRemaining);
  }

  // Unshared codons: split unallocated remainder, bounded by strict and actual remaining
  const totalShared = shares ? Object.values(shares).reduce((a, b) => a + b, 0) : 0;
  const unallocatedPool = Math.max(0, 1 - totalShared) * globalMaxDollars;

  let unsharedCount = 1;
  for (const c of remainingCodons) {
    const hasShare =
      c.codonConfigId !== undefined && shares !== undefined && c.codonConfigId in shares;
    const hasExplicit = c.maxDollars !== undefined;
    if (!hasShare && !hasExplicit) {
      unsharedCount++;
    }
  }

  const uniformShare = unallocatedPool / unsharedCount;
  return Math.min(uniformShare, strictRemaining, actualRemaining);

  // Note: globalRemaining parameter is not used here because strict mode
  // uses strictRemaining + actualRemaining instead
}

// =============================================================================
// Budget facade — run-level budget management
// =============================================================================

/**
 * Budget configuration from the hank-level budget config.
 */
export interface BudgetConfig {
  maxDollars?: number;
  maxTimeSeconds?: number;
  allocationMode?: AllocationMode;
  shares?: Record<string, number>;
  onExceeded?: OnExceededPolicy;
}

/**
 * Interface for reporting budget telemetry events.
 * Implemented by TelemetryCollector; injected into Budget to keep it decoupled.
 */
export interface BudgetTelemetryReporter {
  reportBudgetSet(data: { codonId: string; limits: BudgetLimits }): void;
  reportBudgetExceeded(data: { codonId: string; info: BudgetExceededInfo }): void;
}

export interface BudgetParams {
  config: BudgetConfig;
  executionPlan: ExecutionCodonEntry[];
  logger: Logger;
  /** For continuation runs: prior runs to hydrate spending from. */
  priorRuns?: { runs: Run[]; currentRunId: string };
  /** Optional telemetry reporter for budget events. */
  telemetry?: BudgetTelemetryReporter;
}

export interface BudgetEvents extends Record<string, unknown[]> {
  exceeded: [data: { codonId: string; info: BudgetExceededInfo }];
}

/**
 * Run-level budget facade.
 *
 * Encapsulates allocation logic (resolveCodonBudget), per-codon limit
 * enforcement (BudgetTracker), run-level spending tracking, and retry
 * cost accumulation behind a single interface.
 *
 * Created once per run by HankweaveRuntime. Both the runtime and
 * CodonRunner interact with this class for all budget concerns.
 *
 * CostTracker and StateManager remain in CodonRunner — this class
 * subscribes to CostTracker events for automatic limit enforcement.
 */
export class Budget extends TypedEventEmitter<BudgetEvents> {
  private readonly budgetConfig: BudgetConfig;
  private readonly logger: Logger;
  private readonly telemetry?: BudgetTelemetryReporter;
  private executionPlan: ExecutionCodonEntry[];

  // Hank-level start time for wall-clock watchdog (offset backwards on resume)
  private hankStartTime: number;

  // Per-codon BudgetTracker instances (active while codon is running)
  private activeTrackers = new Map<string, BudgetTracker>();
  // Active watchdog timers for time-budgeted codons
  private activeTimers = new Map<string, ReturnType<typeof setInterval>>();
  // Cached resolved limits from trackCodon
  private resolvedLimits = new Map<string, BudgetLimits>();
  // Exceeded snapshots stored when BudgetTracker fires
  private exceededSnapshots = new Map<string, BudgetExceededInfo>();

  // Run-level spending: final costs for completed/failed codons
  private completedSpending = new Map<string, number>();
  // Retry cost accumulation (moved from HankweaveRuntime)
  private retryAccumulated = new Map<string, number>();

  // Loop-level effective budgets (resolved once when first codon of loop starts)
  private loopEffectiveBudgets = new Map<
    string,
    {
      maxDollars?: number;
      maxTimeSeconds?: number;
      allocation?: AllocationMode;
      shares?: Record<string, number>;
      onExceeded?: OnExceededPolicy;
    }
  >();
  // Loop start times (for maxTimeSeconds watchdog)
  private loopStartTimes = new Map<string, number>();
  // Snapshot of prior-run codon entries for time hydration on resume
  private priorCodonSnapshots?: Map<string, Run["codons"][number][]>;

  constructor(params: BudgetParams) {
    super();
    this.budgetConfig = params.config;
    this.executionPlan = params.executionPlan;
    this.logger = params.logger;
    this.telemetry = params.telemetry;
    this.hankStartTime = Date.now();

    if (params.priorRuns) {
      this.hydrateFromPriorRuns(params.priorRuns.runs, params.priorRuns.currentRunId);
      this.hydrateTimeFromPriorRuns(params.priorRuns.runs, params.priorRuns.currentRunId);
    }

    this.logStartupSummary();
  }

  /**
   * Log a human-readable budget summary at startup so the server log captures
   * the effective ceiling, allocation mode, and spending state.
   */
  private logStartupSummary(): void {
    const cfg = this.budgetConfig;
    const hasBudget = cfg.maxDollars !== undefined || cfg.maxTimeSeconds !== undefined;

    if (!hasBudget) {
      this.logger.log("Budget: no global budget configured");
      return;
    }

    const parts: string[] = [];
    if (cfg.maxDollars !== undefined) parts.push(`$${cfg.maxDollars.toFixed(4)} ceiling`);
    if (cfg.maxTimeSeconds !== undefined) parts.push(`${cfg.maxTimeSeconds}s time limit`);
    parts.push(`allocation: ${cfg.allocationMode ?? "shared"}`);
    if (cfg.onExceeded) parts.push(`onExceeded: ${cfg.onExceeded}`);
    this.logger.log(`Budget config: ${parts.join(", ")}`);

    const spent = this.getTotalSpent();
    if (spent > 0) {
      const remaining = cfg.maxDollars !== undefined ? cfg.maxDollars - spent : undefined;
      this.logger.log(
        `Budget state: $${spent.toFixed(4)} already spent across ${this.completedSpending.size} prior codon(s)` +
          (remaining !== undefined ? `, $${remaining.toFixed(4)} remaining` : ""),
      );
    }
  }

  /**
   * Hydrate spending from prior runs on resume.
   * Called after construction when this Budget belongs to a continuation run,
   * so that allocation calculations account for money already spent.
   */
  seedCompletedSpending(priorSpending: Map<string, number>): void {
    for (const [codonId, cost] of priorSpending) {
      this.completedSpending.set(codonId, cost);
    }
  }

  /**
   * Compute and hydrate prior spending from historical runs.
   * Iterates over all runs except the current one, aggregates codon costs,
   * and seeds the completed spending map.
   */
  hydrateFromPriorRuns(runs: Run[], currentRunId: string): void {
    const priorSpending = new Map<string, number>();
    const snapshots = new Map<string, Run["codons"][number][]>();
    for (const run of runs) {
      if (run.runId === currentRunId) continue;
      for (const codon of run.codons) {
        const existing = snapshots.get(codon.codonId);
        if (existing) {
          existing.push(codon);
        } else {
          snapshots.set(codon.codonId, [codon]);
        }
        const cost = getCodonCost(codon);
        if (cost > 0) {
          priorSpending.set(codon.codonId, (priorSpending.get(codon.codonId) ?? 0) + cost);
        }
      }
    }
    this.priorCodonSnapshots = snapshots;
    if (priorSpending.size > 0) {
      this.seedCompletedSpending(priorSpending);
      const totalPrior = [...priorSpending.values()].reduce((a, b) => a + b, 0);
      this.logger.log(
        `Budget hydrated with $${totalPrior.toFixed(4)} from ${priorSpending.size} prior codon(s)`,
      );
    }
  }

  /**
   * Compute elapsed wall-clock time from prior runs and offset hankStartTime
   * so that time budgets account for time already consumed.
   */
  hydrateTimeFromPriorRuns(runs: Run[], currentRunId: string): void {
    let totalPriorElapsedMs = 0;
    for (const run of runs) {
      if (run.runId === currentRunId) continue;
      if (run.startTime && run.endTime) {
        const elapsed = new Date(run.endTime).getTime() - new Date(run.startTime).getTime();
        if (elapsed > 0) totalPriorElapsedMs += elapsed;
      } else if (run.startTime && run.codons.length > 0) {
        // Fallback for crashed runs: use last codon's endTime if available
        const lastCodon = [...run.codons].reverse().find((c) => "endTime" in c && c.endTime);
        if (lastCodon && "endTime" in lastCodon && lastCodon.endTime) {
          const elapsed = new Date(lastCodon.endTime).getTime() - new Date(run.startTime).getTime();
          if (elapsed > 0) totalPriorElapsedMs += elapsed;
        }
      }
    }
    if (totalPriorElapsedMs > 0) {
      this.hankStartTime = Date.now() - totalPriorElapsedMs;
      this.logger.log(
        `Budget: time hydrated with ${(totalPriorElapsedMs / 1000).toFixed(0)}s from prior run(s)`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize budget tracking for a codon. Resolves effective limits,
   * creates a BudgetTracker, and subscribes to CostTracker events for
   * automatic limit enforcement.
   */
  trackCodon(
    codonId: CodonId | string,
    codon: {
      id: string;
      budget?: {
        maxDollars?: number;
        maxTimeSeconds?: number;
        maxOutputTokens?: number;
        maxContextTokens?: number;
        onExceeded?: OnExceededPolicy;
      };
    },
    costTracker: TypedEventEmitter<CostTrackerEvents>,
  ): void {
    const currentIndex = this.executionPlan.findIndex((e) => e.codonId === codonId);
    const entry = currentIndex >= 0 ? this.executionPlan[currentIndex] : undefined;
    const loopCtx = entry?.loopContext;
    const loopBudget = loopCtx?.loopBudget;

    let limits: BudgetLimits;

    if (loopBudget && loopCtx) {
      limits = this.resolveLoopScopedLimits(codonId, codon, currentIndex, loopCtx);
    } else {
      limits = this.resolveHankScopedLimits(codonId, codon, currentIndex);
    }

    this.resolvedLimits.set(String(codonId), limits);

    if (limits.hasLimits()) {
      this.telemetry?.reportBudgetSet({ codonId: String(codonId), limits });
    }

    // Create BudgetTracker if any limits exist
    const tracker = new BudgetTracker(limits);
    this.activeTrackers.set(String(codonId), tracker);

    // Wire exceeded event
    tracker.on("exceeded", (info) => {
      const id = String(codonId);
      this.exceededSnapshots.set(id, info);
      this.emit("exceeded", { codonId: id, info });
      this.telemetry?.reportBudgetExceeded({ codonId: id, info });
    });

    // Wire CostTracker → BudgetTracker for automatic limit tracking
    costTracker.on("costIncremented", (delta) => {
      tracker.addCost(delta.cost);
      tracker.addOutputTokens(delta.tokens.outputTokens);
      tracker.updateContextTokens(delta.tokens.inputTokens, delta.tokens.outputTokens);
      tracker.checkTime();
    });

    // Start watchdog timer for active time enforcement (independent of cost events)
    const loopId = loopCtx ? String(loopCtx.loopId) : undefined;
    const hasCodonTimeLimit = limits.maxTimeSeconds !== undefined;
    const hasLoopTimeLimit = loopId
      ? this.loopEffectiveBudgets.get(loopId)?.maxTimeSeconds !== undefined
      : false;

    if (hasCodonTimeLimit || hasLoopTimeLimit) {
      const id = String(codonId);
      const timer = setInterval(() => {
        tracker.checkTime();
        if (loopId && !this.exceededSnapshots.has(id) && this.isLoopBudgetExceeded(loopId)) {
          const loopEffective = this.loopEffectiveBudgets.get(loopId);
          const loopStartTime = this.loopStartTimes.get(loopId);
          if (loopEffective?.maxTimeSeconds !== undefined && loopStartTime !== undefined) {
            const elapsed = (Date.now() - loopStartTime) / 1000;
            const info: BudgetExceededInfo = {
              currency: "duration",
              limit: loopEffective.maxTimeSeconds,
              used: elapsed,
              message: `Loop ${loopId} duration ${elapsed.toFixed(1)}s exceeded limit ${loopEffective.maxTimeSeconds}s`,
            };
            this.exceededSnapshots.set(id, info);
            this.emit("exceeded", { codonId: id, info });
            this.telemetry?.reportBudgetExceeded({ codonId: id, info });
          }
        }
      }, 1000);
      timer.unref();
      this.activeTimers.set(id, timer);
    }

    const alreadySpent = loopBudget
      ? this.getLoopSpent(String(loopCtx?.loopId))
      : this.getTotalSpent();
    this.logger.log(
      `Budget: started tracking codon ${codonId} ` +
        `(limits: ${JSON.stringify(limits)}, alreadySpent: $${alreadySpent.toFixed(4)}` +
        (loopBudget ? `, loopScoped: ${loopCtx?.loopId}` : "") +
        `)`,
    );
  }

  /**
   * Record that a codon completed successfully. Updates spending records
   * for subsequent allocation calculations.
   */
  completeCodon(codonId: CodonId | string, finalCost: number): void {
    this.clearWatchdog(String(codonId));
    this.completedSpending.set(String(codonId), finalCost);
    this.activeTrackers.delete(String(codonId));
  }

  /**
   * Record that a codon failed. Updates spending records.
   */
  failCodon(codonId: CodonId | string, partialCost: number): void {
    this.clearWatchdog(String(codonId));
    this.completedSpending.set(String(codonId), partialCost);
    this.activeTrackers.delete(String(codonId));
  }

  /**
   * Record that a codon was skipped (0 cost).
   */
  skipCodon(codonId: CodonId | string): void {
    this.clearWatchdog(String(codonId));
    this.completedSpending.set(String(codonId), 0);
    this.activeTrackers.delete(String(codonId));
  }

  private clearWatchdog(codonId: string): void {
    const timer = this.activeTimers.get(codonId);
    if (timer) {
      clearInterval(timer);
      this.activeTimers.delete(codonId);
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Has this codon's budget been exceeded?
   */
  isExceeded(codonId: string): boolean {
    return this.exceededSnapshots.has(codonId);
  }

  /**
   * Get details about the budget breach, if any.
   */
  getExceededInfo(codonId: string): BudgetExceededInfo | undefined {
    return this.exceededSnapshots.get(codonId);
  }

  /**
   * Get the effective budget limits resolved for a codon.
   */
  getEffectiveLimits(codonId: string): BudgetLimits {
    return this.resolvedLimits.get(codonId) ?? new BudgetLimits();
  }

  /**
   * Total cost spent across all completed/failed codons in this run.
   */
  getTotalSpent(): number {
    let total = 0;
    for (const cost of this.completedSpending.values()) {
      total += cost;
    }
    return total;
  }

  /**
   * Get exceeded snapshots (read-only) for all codons that hit their budget.
   */
  getExceededSnapshots(): ReadonlyMap<string, BudgetExceededInfo> {
    return this.exceededSnapshots;
  }

  /**
   * Build the end-of-run budget summary from internal state + run codons.
   * Returns null if no budget limits were configured.
   */
  getBudgetSummary(currentRun: Run): BudgetSummaryData | null {
    const hasBudget =
      this.budgetConfig.maxDollars !== undefined ||
      this.budgetConfig.maxTimeSeconds !== undefined ||
      this.resolvedLimits.size > 0;
    if (!hasBudget) return null;

    const rows: CodonBudgetSummaryRow[] = [];

    for (const entry of this.executionPlan) {
      const codonId = String(entry.codonId);
      const limits = this.resolvedLimits.get(codonId) ?? new BudgetLimits();

      // Find matching codon in the run's state for actuals
      const stateCodon = currentRun.codons.find((c) => String(c.codonId) === codonId);

      const actualDollars = stateCodon ? getCodonCost(stateCodon) : 0;
      const actualTokens = stateCodon ? getCodonTokens(stateCodon) : { outputTokens: 0 };

      // Compute actual duration from start/end times
      let actualTimeSeconds = 0;
      if (stateCodon?.startTime) {
        const endTimeStr =
          "endTime" in stateCodon && stateCodon.endTime ? stateCodon.endTime : undefined;
        const start = new Date(stateCodon.startTime).getTime();
        const end = endTimeStr ? new Date(endTimeStr).getTime() : Date.now();
        actualTimeSeconds = (end - start) / 1000;
      }

      // Determine status
      let status: CodonBudgetSummaryRow["status"] = "running";
      if (stateCodon) {
        if (stateCodon.status === "completed") {
          status = this.exceededSnapshots.has(codonId) ? "exceeded" : "completed";
        } else if (stateCodon.status === "failed") {
          status = "failed";
        } else if (stateCodon.status === "skipped") {
          status = "skipped";
        }
      }

      rows.push({
        codonId,
        loopContext: entry.loopContext
          ? {
              loopId: String(entry.loopContext.loopId),
              iteration: entry.loopContext.iteration,
              codonIndexInLoop: entry.loopContext.codonIndexInLoop,
            }
          : undefined,
        status,
        budget: {
          maxDollars: limits.maxDollars,
          maxTimeSeconds: limits.maxTimeSeconds,
          maxOutputTokens: limits.maxOutputTokens,
        },
        actual: {
          dollars: actualDollars,
          timeSeconds: actualTimeSeconds,
          outputTokens: actualTokens.outputTokens,
        },
      });
    }

    const totalActualDollars = rows.reduce((sum, r) => sum + r.actual.dollars, 0);
    const totalActualTime = rows.reduce((sum, r) => sum + r.actual.timeSeconds, 0);

    return {
      ceiling: {
        maxDollars: this.budgetConfig.maxDollars,
        maxTimeSeconds: this.budgetConfig.maxTimeSeconds,
      },
      allocation: this.budgetConfig.allocationMode ?? "shared",
      rows,
      totals: {
        budgetDollars: this.budgetConfig.maxDollars,
        actualDollars: totalActualDollars,
        actualTimeSeconds: totalActualTime,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Execution plan updates
  // ---------------------------------------------------------------------------

  /**
   * Update the execution plan (e.g., after loop expansion adds new entries).
   * Must be called before trackCodon() for newly expanded codons.
   */
  updateExecutionPlan(plan: ExecutionCodonEntry[]): void {
    this.executionPlan = plan;
  }

  // ---------------------------------------------------------------------------
  // Retry tracking (moved from HankweaveRuntime)
  // ---------------------------------------------------------------------------

  /**
   * Accumulate cost from a failed retry attempt.
   */
  accumulateRetryCost(codonId: string, cost: number): void {
    const current = this.retryAccumulated.get(codonId) ?? 0;
    this.retryAccumulated.set(codonId, current + cost);
  }

  /**
   * Get accumulated retry cost and clear it. Returns 0 if none.
   */
  getAndClearRetryCost(codonId: string): number {
    const cost = this.retryAccumulated.get(codonId) ?? 0;
    this.retryAccumulated.delete(codonId);
    return cost;
  }

  // ---------------------------------------------------------------------------
  // Loop-level budget
  // ---------------------------------------------------------------------------

  /**
   * Check whether a loop's budget has been exhausted (cost or time).
   */
  isLoopBudgetExceeded(loopId: string): boolean {
    const effective = this.loopEffectiveBudgets.get(loopId);
    if (!effective) return false;

    if (effective.maxDollars !== undefined) {
      if (this.getLoopSpent(loopId) >= effective.maxDollars) return true;
    }
    if (effective.maxTimeSeconds !== undefined) {
      const startTime = this.loopStartTimes.get(loopId);
      if (startTime !== undefined) {
        const elapsed = (Date.now() - startTime) / 1000;
        if (elapsed >= effective.maxTimeSeconds) return true;
      }
    }
    return false;
  }

  /**
   * Total cost spent across all completed/failed codons within a specific loop.
   */
  getLoopSpent(loopId: string): number {
    let total = 0;
    for (const entry of this.executionPlan) {
      if (entry.loopContext?.loopId === loopId) {
        total += this.completedSpending.get(String(entry.codonId)) ?? 0;
      }
    }
    return total;
  }

  /**
   * Compute total elapsed wall-clock time for prior codons within a specific loop.
   * Uses codon startTime/endTime from the execution plan's completed spending entries.
   */
  private computePriorLoopElapsedMs(loopId: string): number {
    let totalMs = 0;
    for (const entry of this.executionPlan) {
      if (entry.loopContext?.loopId !== loopId) continue;
      const codons = this.findCodonInPriorRuns(String(entry.codonId));
      for (const codon of codons) {
        if ("endTime" in codon && codon.endTime && codon.startTime) {
          const elapsed = new Date(codon.endTime).getTime() - new Date(codon.startTime).getTime();
          if (elapsed > 0) totalMs += elapsed;
        }
      }
    }
    if (totalMs > 0) {
      this.logger.log(
        `Budget: loop ${loopId} time hydrated with ${(totalMs / 1000).toFixed(0)}s from prior codon(s)`,
      );
    }
    return totalMs;
  }

  /**
   * Find a codon by ID in the prior runs data stored during hydration.
   * Returns undefined if not found or if no prior runs exist.
   */
  private findCodonInPriorRuns(codonId: string): Run["codons"][number][] {
    // The prior runs are not stored after hydration — but the completed spending map
    // tells us which codons had prior costs. For time hydration, we need the actual
    // codon objects. Store them during dollar hydration.
    return this.priorCodonSnapshots?.get(codonId) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Private: budget resolution helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve budget limits for a codon scoped to the hank level (no loop).
   */
  private resolveHankScopedLimits(
    _codonId: CodonId | string,
    codon: {
      id: string;
      budget?: {
        maxDollars?: number;
        maxTimeSeconds?: number;
        maxOutputTokens?: number;
        maxContextTokens?: number;
        onExceeded?: OnExceededPolicy;
      };
    },
    currentIndex: number,
  ): BudgetLimits {
    let alreadySpent = 0;
    for (const cost of this.completedSpending.values()) {
      alreadySpent += cost;
    }

    const remainingCodons = this.executionPlan
      .slice(currentIndex + 1)
      .filter((e) => !this.completedSpending.has(e.codonId))
      .map((e) => ({
        maxDollars: e.codon.budget?.maxDollars,
        codonConfigId: e.codon.id,
      }));

    let strictAlreadyConsumed: number | undefined;
    if (
      this.budgetConfig.allocationMode === "proportional-strict" &&
      this.budgetConfig.maxDollars !== undefined
    ) {
      strictAlreadyConsumed = this.computeStrictConsumed(
        currentIndex,
        this.budgetConfig.shares,
        this.budgetConfig.maxDollars,
      );
    }

    let remainingTimeSeconds: number | undefined;
    if (this.budgetConfig.maxTimeSeconds !== undefined) {
      const elapsedSeconds = (Date.now() - this.hankStartTime) / 1000;
      remainingTimeSeconds = this.budgetConfig.maxTimeSeconds - elapsedSeconds;
    }

    return resolveCodonBudget({
      codon: {
        maxDollars: codon.budget?.maxDollars,
        maxTimeSeconds: codon.budget?.maxTimeSeconds,
        maxOutputTokens: codon.budget?.maxOutputTokens,
        maxContextTokens: codon.budget?.maxContextTokens,
        onExceeded: codon.budget?.onExceeded,
      },
      remainingCodons,
      globalMaxDollars: this.budgetConfig.maxDollars,
      alreadySpent,
      allocationMode: this.budgetConfig.allocationMode,
      shares: this.budgetConfig.shares,
      codonConfigId: codon.id,
      strictAlreadyConsumed,
      remainingTimeSeconds,
      containerOnExceeded: this.budgetConfig.onExceeded,
    });
  }

  /**
   * Resolve budget limits for a codon scoped to its parent loop's budget.
   */
  private resolveLoopScopedLimits(
    _codonId: CodonId | string,
    codon: {
      id: string;
      budget?: {
        maxDollars?: number;
        maxTimeSeconds?: number;
        maxOutputTokens?: number;
        maxContextTokens?: number;
        onExceeded?: OnExceededPolicy;
      };
    },
    currentIndex: number,
    loopCtx: NonNullable<ExecutionCodonEntry["loopContext"]>,
  ): BudgetLimits {
    const loopId = String(loopCtx.loopId);
    const loopBudget = loopCtx.loopBudget;
    if (!loopBudget) {
      // Caller guarantees loopBudget exists; fallback to hank-scoped if somehow missing
      return this.resolveHankScopedLimits(_codonId, codon, currentIndex);
    }

    // Initialize loop effective budget on first encounter
    if (!this.loopEffectiveBudgets.has(loopId)) {
      this.resolveAndStoreLoopEffectiveBudget(loopId, loopBudget);
      // Offset loop start time by prior elapsed time within this loop
      const priorLoopElapsedMs = this.computePriorLoopElapsedMs(loopId);
      this.loopStartTimes.set(loopId, Date.now() - priorLoopElapsedMs);
    }

    const effective = this.loopEffectiveBudgets.get(loopId);
    if (!effective) {
      return this.resolveHankScopedLimits(_codonId, codon, currentIndex);
    }
    const loopSpent = this.getLoopSpent(loopId);

    // Scope remaining codons to this loop only
    const remainingCodons = this.executionPlan
      .slice(currentIndex + 1)
      .filter(
        (e) => e.loopContext?.loopId === loopCtx.loopId && !this.completedSpending.has(e.codonId),
      )
      .map((e) => ({
        maxDollars: e.codon.budget?.maxDollars,
        codonConfigId: e.codon.id,
      }));

    // Strict consumed for proportional-strict within the loop
    let strictAlreadyConsumed: number | undefined;
    if (effective.allocation === "proportional-strict" && effective.maxDollars !== undefined) {
      strictAlreadyConsumed = this.computeStrictConsumedInLoop(
        currentIndex,
        loopCtx.loopId,
        effective.shares,
        effective.maxDollars,
      );
    }

    // Compute remaining time: min(loop remaining, hank remaining)
    let remainingTimeSeconds: number | undefined;
    if (effective.maxTimeSeconds !== undefined) {
      const loopStartTime = this.loopStartTimes.get(loopId);
      if (loopStartTime !== undefined) {
        const loopElapsed = (Date.now() - loopStartTime) / 1000;
        remainingTimeSeconds = effective.maxTimeSeconds - loopElapsed;
      }
    }
    if (this.budgetConfig.maxTimeSeconds !== undefined) {
      const hankElapsed = (Date.now() - this.hankStartTime) / 1000;
      const hankRemaining = this.budgetConfig.maxTimeSeconds - hankElapsed;
      remainingTimeSeconds =
        remainingTimeSeconds !== undefined
          ? Math.min(remainingTimeSeconds, hankRemaining)
          : hankRemaining;
    }

    const limits = resolveCodonBudget({
      codon: {
        maxDollars: codon.budget?.maxDollars,
        maxTimeSeconds: codon.budget?.maxTimeSeconds,
        maxOutputTokens: codon.budget?.maxOutputTokens,
        maxContextTokens: codon.budget?.maxContextTokens,
        onExceeded: codon.budget?.onExceeded,
      },
      remainingCodons,
      globalMaxDollars: effective.maxDollars,
      alreadySpent: loopSpent,
      allocationMode: effective.allocation,
      shares: effective.shares,
      codonConfigId: codon.id,
      strictAlreadyConsumed,
      remainingTimeSeconds,
      containerOnExceeded: effective.onExceeded ?? this.budgetConfig.onExceeded,
    });

    // Cap against hank remaining budget (loop budget is a sub-envelope of the hank)
    if (this.budgetConfig.maxDollars !== undefined) {
      const hankRemaining = Math.max(0, this.budgetConfig.maxDollars - this.getTotalSpent());
      const cappedDollars =
        limits.maxDollars !== undefined
          ? Math.min(limits.maxDollars, hankRemaining)
          : hankRemaining;
      return new BudgetLimits({ ...limits, maxDollars: cappedDollars });
    }

    return limits;
  }

  /**
   * Compute the loop's effective budget by capping it against the hank's allocation.
   */
  private resolveAndStoreLoopEffectiveBudget(
    loopId: string,
    loopBudget: NonNullable<NonNullable<ExecutionCodonEntry["loopContext"]>["loopBudget"]>,
  ): void {
    let effectiveMaxDollars = loopBudget.maxDollars;

    if (this.budgetConfig.maxDollars !== undefined) {
      // Determine the hank's allocation for this loop
      const hankAllocation = this.computeHankAllocationForLoop(loopId);
      if (hankAllocation !== undefined) {
        effectiveMaxDollars =
          effectiveMaxDollars !== undefined
            ? Math.min(effectiveMaxDollars, hankAllocation)
            : hankAllocation;
      }
    }

    // Loop time is independent (not proportioned), but cap by hank remaining time
    let effectiveMaxTimeSeconds = loopBudget.maxTimeSeconds;
    if (effectiveMaxTimeSeconds !== undefined && this.budgetConfig.maxTimeSeconds !== undefined) {
      const hankElapsed = (Date.now() - this.hankStartTime) / 1000;
      const hankRemaining = this.budgetConfig.maxTimeSeconds - hankElapsed;
      effectiveMaxTimeSeconds = Math.min(effectiveMaxTimeSeconds, hankRemaining);
    }

    this.loopEffectiveBudgets.set(loopId, {
      maxDollars: effectiveMaxDollars,
      maxTimeSeconds: effectiveMaxTimeSeconds,
      allocation: loopBudget.allocation,
      shares: loopBudget.shares,
      onExceeded: loopBudget.onExceeded,
    });

    this.logger.log(
      `Budget: loop ${loopId} effective budget: ` +
        `$${effectiveMaxDollars?.toFixed(4) ?? "unlimited"}, ` +
        `${effectiveMaxTimeSeconds?.toFixed(0) ?? "unlimited"}s`,
    );
  }

  /**
   * Compute how much the hank allocated to a specific loop, based on the hank's allocation mode.
   */
  private computeHankAllocationForLoop(loopId: string): number | undefined {
    const hankMaxDollars = this.budgetConfig.maxDollars;
    if (hankMaxDollars === undefined) return undefined;

    const mode = this.budgetConfig.allocationMode ?? "shared";

    if (mode === "shared") {
      // In shared mode, the loop can use up to the hank's remaining budget.
      return Math.max(0, hankMaxDollars - this.getTotalSpent());
    }

    // Proportional modes: look up the loop's share
    const shares = this.budgetConfig.shares;
    if (shares && loopId in shares) {
      return shares[loopId] * hankMaxDollars;
    }

    // Loop has no explicit share — it gets uniform split of unallocated remainder
    const totalShared = shares ? Object.values(shares).reduce((a, b) => a + b, 0) : 0;
    const unallocatedPool = Math.max(0, 1 - totalShared) * hankMaxDollars;

    // Count top-level children without shares (including this loop)
    let unsharedCount = 0;
    const seen = new Set<string>();
    for (const e of this.executionPlan) {
      const childId = e.loopContext ? String(e.loopContext.loopId) : e.codon.id;
      if (seen.has(childId)) continue;
      seen.add(childId);
      const hasShare = shares !== undefined && childId in shares;
      const hasExplicitBudget = !e.loopContext && e.codon.budget?.maxDollars !== undefined;
      if (!hasShare && !hasExplicitBudget) {
        unsharedCount++;
      }
    }

    return unsharedCount > 0 ? unallocatedPool / unsharedCount : unallocatedPool;
  }

  /**
   * Compute strict consumed amount for proportional-strict mode (hank-level scope).
   */
  private computeStrictConsumed(
    currentIndex: number,
    shares: Record<string, number> | undefined,
    maxDollars: number,
  ): number {
    let strictAlreadyConsumed = 0;
    for (let i = 0; i < currentIndex; i++) {
      const entry = this.executionPlan[i];
      const actualCost = this.completedSpending.get(entry.codonId) ?? 0;
      const configId = entry.codon.id;

      if (shares && configId in shares) {
        strictAlreadyConsumed += Math.max(shares[configId] * maxDollars, actualCost);
      } else {
        strictAlreadyConsumed += actualCost;
      }
    }
    return strictAlreadyConsumed;
  }

  /**
   * Compute strict consumed amount for proportional-strict mode within a loop.
   */
  private computeStrictConsumedInLoop(
    currentIndex: number,
    loopId: CodonId,
    shares: Record<string, number> | undefined,
    maxDollars: number,
  ): number {
    let strictAlreadyConsumed = 0;
    for (let i = 0; i < currentIndex; i++) {
      const entry = this.executionPlan[i];
      if (entry.loopContext?.loopId !== loopId) continue;
      const actualCost = this.completedSpending.get(entry.codonId) ?? 0;
      const configId = entry.codon.id;

      if (shares && configId in shares) {
        strictAlreadyConsumed += Math.max(shares[configId] * maxDollars, actualCost);
      } else {
        strictAlreadyConsumed += actualCost;
      }
    }
    return strictAlreadyConsumed;
  }
}
