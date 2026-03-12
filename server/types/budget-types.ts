/**
 * Shared budget types used across the codebase.
 *
 * These types are consumed by state management, event schemas, CodonRunner,
 * and the budget module itself.
 */

/** What happens when a budget limit is exceeded. */
export type OnExceededPolicy = "complete" | "fail";

/** Options for constructing a BudgetLimits instance. */
export interface BudgetLimitsOptions {
  maxDollars?: number;
  maxTimeSeconds?: number;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  onExceeded?: OnExceededPolicy;
  /** Human-readable description of where the cost limit came from. */
  costSource?: string;
}

/**
 * Resolved budget limits for a single codon execution.
 */
export class BudgetLimits {
  readonly maxDollars?: number;
  readonly maxTimeSeconds?: number;
  readonly maxOutputTokens?: number;
  readonly maxContextTokens?: number;
  readonly onExceeded?: OnExceededPolicy;
  /** Human-readable description of where the cost limit came from. */
  readonly costSource?: string;

  constructor(opts: BudgetLimitsOptions = {}) {
    this.maxDollars = opts.maxDollars;
    this.maxTimeSeconds = opts.maxTimeSeconds;
    this.maxOutputTokens = opts.maxOutputTokens;
    this.maxContextTokens = opts.maxContextTokens;
    this.onExceeded = opts.onExceeded;
    this.costSource = opts.costSource;
  }

  /** Whether any numeric limits are configured. */
  hasLimits(): boolean {
    return (
      this.maxDollars !== undefined ||
      this.maxTimeSeconds !== undefined ||
      this.maxOutputTokens !== undefined ||
      this.maxContextTokens !== undefined
    );
  }
}

/** The budget currencies tracked by the system. */
export const BUDGET_CURRENCIES = ["cost", "duration", "outputTokens", "contextTokens"] as const;
export type BudgetCurrency = (typeof BUDGET_CURRENCIES)[number];

/** Snapshot of a budget limit breach — which currency, what limit, how much was used. */
export interface BudgetExceededData {
  currency: BudgetCurrency;
  limit: number;
  used: number;
}

/** Full info about a budget breach, including a human-readable message. */
export interface BudgetExceededInfo extends BudgetExceededData {
  message: string;
}

/** How budget is distributed among codons in a container. */
export type AllocationMode = "shared" | "proportional" | "proportional-strict";

// ---------------------------------------------------------------------------
// End-of-run budget summary
// ---------------------------------------------------------------------------

/** Per-codon row in the end-of-run budget summary table. */
export interface CodonBudgetSummaryRow {
  codonId: string;
  loopContext?: { loopId: string; iteration: number; codonIndexInLoop: number };
  status: "completed" | "failed" | "skipped" | "exceeded" | "running";
  budget: { maxDollars?: number; maxTimeSeconds?: number; maxOutputTokens?: number };
  actual: { dollars: number; timeSeconds: number; outputTokens: number };
}

/** Full payload for the budget.summary event emitted at end of run. */
export interface BudgetSummaryData {
  ceiling: { maxDollars?: number; maxTimeSeconds?: number };
  allocation: AllocationMode;
  rows: CodonBudgetSummaryRow[];
  totals: { budgetDollars?: number; actualDollars: number; actualTimeSeconds: number };
}
