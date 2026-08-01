// /**
//  * Integration tests for the Budget facade class.
//  *
//  * Tests allocation scenarios across multiple codons using mock CostTracker
//  * event emission — no LlmProviderRegistry, StateManager, or process
//  * management needed.
//  */

import { describe, expect, test } from "bun:test";
import { Budget, type BudgetConfig, type BudgetTelemetryReporter } from "../../server/budget.js";
import type { Codon } from "../../server/config.js";
import type { CostTrackerEvents } from "../../server/cost-tracker.js";
import type { ExecutionCodonEntry } from "../../server/execution-planner.js";
import { TypedEventEmitter } from "../../server/typed-event-emitter.js";
import type { CodonId, RunId } from "../../server/types/branded-types.js";
import type { BudgetExceededInfo } from "../../server/types/budget-types.js";
import type { CodonExecution, Run } from "../../server/types/state-types.js";
import type { Logger } from "../../server/utils.js";

const mockLogger = { log: () => {} } as unknown as Logger;

const ZERO_TOKENS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

/** Minimal codon shape — Budget only reads id and budget fields. */
function codon(
  id: string,
  budget?: {
    maxDollars?: number;
    maxTimeSeconds?: number;
    maxOutputTokens?: number;
    onExceeded?: "complete" | "fail";
  },
) {
  return { id, budget } as Codon & { id: string };
}

/** Build an execution plan from codon definitions. */
function plan(
  ...entries: Array<{
    codonId: string;
    codon: ExecutionCodonEntry["codon"];
    loopContext?: ExecutionCodonEntry["loopContext"];
  }>
): ExecutionCodonEntry[] {
  return entries.map((e) => ({
    codonId: e.codonId as CodonId,
    codon: e.codon,
    loopContext: e.loopContext,
  }));
}

function createBudget(config: BudgetConfig, executionPlan: ExecutionCodonEntry[]) {
  return new Budget({ config, executionPlan, logger: mockLogger });
}

function collectExceeded(budget: Budget): Array<{ codonId: string; info: BudgetExceededInfo }> {
  const events: Array<{ codonId: string; info: BudgetExceededInfo }> = [];
  budget.on("exceeded", (data) => events.push(data));
  return events;
}

function createMockCostTracker() {
  return new TypedEventEmitter<CostTrackerEvents>();
}

async function waitForCondition(
  condition: () => boolean,
  { timeoutMs = 1500, intervalMs = 10 } = {},
) {
  const start = Date.now();

  while (!condition()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Emit a cost increment on a mock CostTracker. */
function emitCost(ct: TypedEventEmitter<CostTrackerEvents>, amount: number) {
  ct.emit("costIncremented", { cost: amount, tokens: ZERO_TOKENS });
}

/** Emit an output token increment on a mock CostTracker. */
function emitOutputTokens(ct: TypedEventEmitter<CostTrackerEvents>, amount: number) {
  ct.emit("costIncremented", {
    cost: 0,
    tokens: { ...ZERO_TOKENS, outputTokens: amount },
  });
}

// =============================================================================
// Single codon
// =============================================================================

describe("Budget - single codon", () => {
  test("per-codon maxDollars triggers exceeded", () => {
    const c = codon("a", { maxDollars: 5 });
    const budget = createBudget({}, plan({ codonId: "a", codon: c }));
    const exceeded = collectExceeded(budget);
    const ct = createMockCostTracker();

    budget.trackCodon("a" as CodonId, c, ct);
    emitCost(ct, 3);
    expect(budget.isExceeded("a")).toBe(false);

    emitCost(ct, 3); // total=6, exceeds 5
    expect(budget.isExceeded("a")).toBe(true);
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0].info.currency).toBe("cost");
    expect(exceeded[0].info.limit).toBe(5);
  });
});

describe("Budget - seedCompletedSpending (resume hydration)", () => {
  test("seedCompletedSpending hydrates prior run costs into allocation", () => {
    const cA = codon("a");
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget({ maxDollars: 1.0 }, p);

    // Simulate resume: codon "a" cost $0.80 in a prior run
    budget.seedCompletedSpending(new Map([["a", 0.8]]));

    const ct = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ct);

    // With $1.00 global and $0.80 already spent, codon "b" should get $0.20
    expect(budget.getEffectiveLimits("b")?.maxDollars).toBeCloseTo(0.2, 2);
  });

  test("seeded spending causes immediate exceeded when pool is exhausted", () => {
    const cA = codon("a");
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget({ maxDollars: 0.5 }, p);
    const exceeded = collectExceeded(budget);

    // Prior run spent more than the total budget
    budget.seedCompletedSpending(new Map([["a", 0.8]]));

    const ct = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ct);

    // Pool is exhausted: max(0, 0.50 - 0.80) = 0
    expect(budget.getEffectiveLimits("b")?.maxDollars).toBe(0);

    // Any cost should trigger exceeded
    emitCost(ct, 0.01);
    expect(budget.isExceeded("b")).toBe(true);
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0].info.currency).toBe("cost");
  });

  test("seeded spending accumulates with current run spending", () => {
    const cA = codon("a");
    const cB = codon("b");
    const cC = codon("c");
    const p = plan(
      { codonId: "a", codon: cA },
      { codonId: "b", codon: cB },
      { codonId: "c", codon: cC },
    );
    const budget = createBudget({ maxDollars: 10.0 }, p);

    // Prior run: codon "a" cost $3
    budget.seedCompletedSpending(new Map([["a", 3.0]]));

    // Current run: codon "b" runs and costs $2
    const ctB = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ctB);
    emitCost(ctB, 2.0);
    budget.completeCodon("b", 2.0);

    // Codon "c": remaining = 10 - 3 - 2 = 5, only codon left → gets 5
    const ctC = createMockCostTracker();
    budget.trackCodon("c" as CodonId, cC, ctC);
    expect(budget.getEffectiveLimits("c")?.maxDollars).toBeCloseTo(5.0, 2);
  });
});

describe("Budget - single codon (continued)", () => {
  test("no limits means isExceeded always false", () => {
    const c = codon("a");
    const budget = createBudget({}, plan({ codonId: "a", codon: c }));
    const ct = createMockCostTracker();

    budget.trackCodon("a" as CodonId, c, ct);
    emitCost(ct, 1000);
    expect(budget.isExceeded("a")).toBe(false);
  });

  test("exceeded emits at most once (idempotent)", () => {
    const c = codon("a", { maxDollars: 1 });
    const budget = createBudget({}, plan({ codonId: "a", codon: c }));
    const exceeded = collectExceeded(budget);
    const ct = createMockCostTracker();

    budget.trackCodon("a" as CodonId, c, ct);
    emitCost(ct, 2);
    emitCost(ct, 2);
    expect(exceeded).toHaveLength(1);
  });

  test("output token limit triggers exceeded", () => {
    const c = codon("a", { maxOutputTokens: 100 });
    const budget = createBudget({}, plan({ codonId: "a", codon: c }));
    const ct = createMockCostTracker();

    budget.trackCodon("a" as CodonId, c, ct);
    emitOutputTokens(ct, 50);
    expect(budget.isExceeded("a")).toBe(false);

    emitOutputTokens(ct, 60); // total=110, exceeds 100
    expect(budget.isExceeded("a")).toBe(true);
    expect(budget.getExceededInfo("a")?.currency).toBe("outputTokens");
  });

  test("getEffectiveLimits returns resolved limits", () => {
    const c = codon("a", { maxDollars: 5, maxOutputTokens: 200 });
    const budget = createBudget({}, plan({ codonId: "a", codon: c }));
    const ct = createMockCostTracker();

    budget.trackCodon("a" as CodonId, c, ct);
    const limits = budget.getEffectiveLimits("a");
    expect(limits.maxDollars).toBe(5);
    expect(limits.maxOutputTokens).toBe(200);
  });
});

// =============================================================================
// Multi-codon shared allocation (default mode)
// =============================================================================

describe("Budget - shared allocation", () => {
  test("shared mode is first-past-the-post: codon gets full remaining pool", () => {
    // Spec: "All children draw from a single pool in execution order."
    // With $5 budget and 3 codons, the first codon should get access to
    // the entire $5 — not $5/3 = $1.67 (uniform splitting).
    const cA = codon("a");
    const cB = codon("b");
    const cC = codon("c");
    const p = plan(
      { codonId: "a", codon: cA },
      { codonId: "b", codon: cB },
      { codonId: "c", codon: cC },
    );
    const budget = createBudget({ maxDollars: 5 }, p);
    const ct = createMockCostTracker();

    // First codon gets full pool, not 5/3
    budget.trackCodon("a" as CodonId, cA, ct);
    expect(budget.getEffectiveLimits("a").maxDollars).toBe(5);

    // A spends $0.80
    emitCost(ct, 0.8);
    budget.completeCodon("a" as CodonId, 0.8);

    // B gets full remaining: 5 - 0.8 = 4.2 (not 4.2/2 = 2.1)
    const ctB = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBeCloseTo(4.2, 5);

    // B spends $3.50 — not exceeded since 3.50 < 4.20
    emitCost(ctB, 3.5);
    expect(budget.isExceeded("b")).toBe(false);
    budget.completeCodon("b" as CodonId, 3.5);

    // C gets remaining: 5 - 0.8 - 3.5 = 0.7
    const ctC = createMockCostTracker();
    budget.trackCodon("c" as CodonId, cC, ctC);
    expect(budget.getEffectiveLimits("c").maxDollars).toBeCloseTo(0.7, 5);

    // C spends $0.50 — not exceeded
    emitCost(ctC, 0.5);
    expect(budget.isExceeded("c")).toBe(false);

    // C spends another $0.30 (total $0.80) — exceeds $0.70 limit
    const exceeded = collectExceeded(budget);
    emitCost(ctC, 0.3);
    expect(budget.isExceeded("c")).toBe(true);
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0].codonId).toBe("c");
    expect(exceeded[0].info.currency).toBe("cost");
  });

  test("second codon gets remaining budget", () => {
    const cA = codon("a");
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget({ maxDollars: 10 }, p);
    const ctA = createMockCostTracker();
    const ctB = createMockCostTracker();

    // Codon A: first-past-the-post, gets full pool
    budget.trackCodon("a" as CodonId, cA, ctA);
    expect(budget.getEffectiveLimits("a").maxDollars).toBe(10);
    emitCost(ctA, 3);
    budget.completeCodon("a" as CodonId, 3);

    // Codon B: remaining = 10 - 3 = 7, only codon left → gets 7
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBe(7);

    emitCost(ctB, 6);
    expect(budget.isExceeded("b")).toBe(false);

    emitCost(ctB, 2); // total=8, exceeds 7
    expect(budget.isExceeded("b")).toBe(true);
  });

  test("explicit maxDollars takes precedence over allocation", () => {
    const cA = codon("a", { maxDollars: 3 });
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget({ maxDollars: 10 }, p);
    const ct = createMockCostTracker();

    // A has explicit maxDollars=3, capped by global remaining (10)
    budget.trackCodon("a" as CodonId, cA, ct);
    expect(budget.getEffectiveLimits("a").maxDollars).toBe(3);
  });

  test("explicit maxDollars capped by global remaining", () => {
    const cA = codon("a");
    const cB = codon("b", { maxDollars: 20 });
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget({ maxDollars: 10 }, p);
    const ctA = createMockCostTracker();
    const ctB = createMockCostTracker();

    budget.trackCodon("a" as CodonId, cA, ctA);
    emitCost(ctA, 8);
    budget.completeCodon("a" as CodonId, 8);

    // B explicit=20, but global remaining=2 → capped at 2
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBe(2);
  });

  test("three codons: first gets full pool", () => {
    const cA = codon("a");
    const cB = codon("b");
    const cC = codon("c");
    const p = plan(
      { codonId: "a", codon: cA },
      { codonId: "b", codon: cB },
      { codonId: "c", codon: cC },
    );
    const budget = createBudget({ maxDollars: 12 }, p);
    const ct = createMockCostTracker();

    // First-past-the-post: A gets full pool
    budget.trackCodon("a" as CodonId, cA, ct);
    expect(budget.getEffectiveLimits("a").maxDollars).toBe(12);
  });

  test("last codon gets $0 when budget fully spent", () => {
    const cA = codon("a");
    const cB = codon("b");
    const cC = codon("c");
    const p = plan(
      { codonId: "a", codon: cA },
      { codonId: "b", codon: cB },
      { codonId: "c", codon: cC },
    );
    const budget = createBudget({ maxDollars: 10 }, p);

    const ctA = createMockCostTracker();
    budget.trackCodon("a" as CodonId, cA, ctA);
    emitCost(ctA, 6);
    budget.completeCodon("a" as CodonId, 6);

    const ctB = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ctB);
    emitCost(ctB, 4);
    budget.completeCodon("b" as CodonId, 4);

    // C: remaining = 0
    const ctC = createMockCostTracker();
    budget.trackCodon("c" as CodonId, cC, ctC);
    expect(budget.getEffectiveLimits("c").maxDollars).toBe(0);

    // Any spend triggers exceeded
    emitCost(ctC, 0.01);
    expect(budget.isExceeded("c")).toBe(true);
  });

  test("failed codon spending counted in remaining", () => {
    const cA = codon("a");
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget({ maxDollars: 10 }, p);
    const ctA = createMockCostTracker();
    const ctB = createMockCostTracker();

    budget.trackCodon("a" as CodonId, cA, ctA);
    emitCost(ctA, 4);
    budget.failCodon("a" as CodonId, 4);

    // B: remaining = 10 - 4 = 6
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBe(6);
  });
});

// =============================================================================
// Proportional allocation
// =============================================================================

describe("Budget - proportional allocation", () => {
  test("codons get their share of parent budget", () => {
    const cA = codon("a");
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget(
      {
        maxDollars: 10,
        allocationMode: "proportional",
        shares: { a: 0.6, b: 0.4 },
      },
      p,
    );
    const ctA = createMockCostTracker();
    const ctB = createMockCostTracker();

    // A gets 0.6 * 10 = 6
    budget.trackCodon("a" as CodonId, cA, ctA);
    expect(budget.getEffectiveLimits("a").maxDollars).toBe(6);

    emitCost(ctA, 3);
    budget.completeCodon("a" as CodonId, 3);

    // B gets 0.4 * 10 = 4, but remaining=7, so min(4,7)=4
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBe(4);
  });

  test("unshared codon gets uniform share of unallocated pool", () => {
    const cA = codon("a");
    const cB = codon("b");
    const cC = codon("c");
    const p = plan(
      { codonId: "a", codon: cA },
      { codonId: "b", codon: cB },
      { codonId: "c", codon: cC },
    );
    const budget = createBudget(
      { maxDollars: 10, allocationMode: "proportional", shares: { a: 0.5 } },
      p,
    );
    const ctA = createMockCostTracker();
    const ctB = createMockCostTracker();

    // A gets 0.5 * 10 = 5
    budget.trackCodon("a" as CodonId, cA, ctA);
    expect(budget.getEffectiveLimits("a").maxDollars).toBe(5);

    emitCost(ctA, 2);
    budget.completeCodon("a" as CodonId, 2);

    // B and C unshared: unallocated = (1-0.5) * 10 = 5, split by 2 = 2.5 each
    // But remaining=8, so bounded by 8 → 2.5
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBe(2.5);
  });

  test("overspent codon reduces remaining for later codons", () => {
    const cA = codon("a");
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget(
      {
        maxDollars: 10,
        allocationMode: "proportional",
        shares: { a: 0.5, b: 0.5 },
      },
      p,
    );
    const ctA = createMockCostTracker();
    const ctB = createMockCostTracker();

    // A gets 0.5 * 10 = 5, but overspends to 8
    budget.trackCodon("a" as CodonId, cA, ctA);
    emitCost(ctA, 8);
    budget.completeCodon("a" as CodonId, 8);

    // B: share = 0.5 * 10 = 5, but remaining = 10 - 8 = 2 → min(5, 2) = 2
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBe(2);
  });

  test("mixed: explicit maxDollars takes precedence, unshared gets remainder", () => {
    const cA = codon("a", { maxDollars: 2 }); // explicit + has share
    const cB = codon("b"); // share only
    const cC = codon("c"); // neither share nor explicit
    const p = plan(
      { codonId: "a", codon: cA },
      { codonId: "b", codon: cB },
      { codonId: "c", codon: cC },
    );
    const budget = createBudget(
      {
        maxDollars: 10,
        allocationMode: "proportional",
        shares: { a: 0.3, b: 0.5 },
      },
      p,
    );

    // A: explicit maxDollars=2 takes precedence (over share 0.3*10=3)
    const ctA = createMockCostTracker();
    budget.trackCodon("a" as CodonId, cA, ctA);
    expect(budget.getEffectiveLimits("a").maxDollars).toBe(2);
    emitCost(ctA, 2);
    budget.completeCodon("a" as CodonId, 2);

    // B: share = 0.5 * 10 = 5, remaining = 8 → min(5, 8) = 5
    const ctB = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBe(5);
    emitCost(ctB, 4);
    budget.completeCodon("b" as CodonId, 4);

    // C: unshared, unallocated = (1 - 0.3 - 0.5) * 10 = 2, only unshared codon → 2
    // remaining = 4, min(2, 4) = 2
    const ctC = createMockCostTracker();
    budget.trackCodon("c" as CodonId, cC, ctC);
    expect(budget.getEffectiveLimits("c").maxDollars).toBeCloseTo(2, 10);
  });

  test("unspent budget flows back in proportional mode", () => {
    const cA = codon("a");
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget(
      {
        maxDollars: 10,
        allocationMode: "proportional",
        shares: { a: 0.5, b: 0.5 },
      },
      p,
    );
    const ctA = createMockCostTracker();
    const ctB = createMockCostTracker();

    // A gets 5, spends only 1
    budget.trackCodon("a" as CodonId, cA, ctA);
    emitCost(ctA, 1);
    budget.completeCodon("a" as CodonId, 1);

    // B gets min(5, 9) = 5 (unspent flows back via globalRemaining)
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBe(5);
  });
});

// =============================================================================
// Proportional-strict allocation
// =============================================================================

describe("Budget - proportional-strict allocation", () => {
  test("unspent budget evaporates in strict mode", () => {
    const cA = codon("a");
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget(
      {
        maxDollars: 10,
        allocationMode: "proportional-strict",
        shares: { a: 0.5, b: 0.3 },
      },
      p,
    );
    const ctA = createMockCostTracker();
    const ctB = createMockCostTracker();

    // A: share = 5, spends only 1
    budget.trackCodon("a" as CodonId, cA, ctA);
    emitCost(ctA, 1);
    budget.completeCodon("a" as CodonId, 1);

    // Strict consumed = max(5 share, 1 actual) = 5
    // Strict remaining = 10 - 5 = 5
    // B share = 0.3 * 10 = 3, bounded by min(5 strict, 9 actual) → 3
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBe(3);

    emitCost(ctB, 2.5);
    expect(budget.isExceeded("b")).toBe(false);
    emitCost(ctB, 1); // total=3.5 > 3
    expect(budget.isExceeded("b")).toBe(true);
  });

  test("overspent codon in strict mode reduces remainder", () => {
    const cA = codon("a");
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget(
      {
        maxDollars: 10,
        allocationMode: "proportional-strict",
        shares: { a: 0.3, b: 0.5 },
      },
      p,
    );
    const ctA = createMockCostTracker();
    const ctB = createMockCostTracker();

    // A: share = 3, actually spends 4 (overspent)
    budget.trackCodon("a" as CodonId, cA, ctA);
    emitCost(ctA, 4);
    budget.completeCodon("a" as CodonId, 4);

    // Strict consumed = max(3 share, 4 actual) = 4
    // Strict remaining = 10 - 4 = 6
    // Actual remaining = 10 - 4 = 6
    // B share = 0.5 * 10 = 5, bounded by min(6, 6) → 5
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBe(5);
  });
});

// =============================================================================
// Loop iterations
// =============================================================================

describe("Budget - loop iterations", () => {
  test("per-codon budget cap resets per iteration", () => {
    const c = codon("work", { maxDollars: 5 });
    const p = plan(
      {
        codonId: "work#0",
        codon: c,
        loopContext: {
          loopId: "loop" as CodonId,
          iteration: 0,
          codonIndexInLoop: 0,
        },
      },
      {
        codonId: "work#1",
        codon: c,
        loopContext: {
          loopId: "loop" as CodonId,
          iteration: 1,
          codonIndexInLoop: 0,
        },
      },
    );
    const budget = createBudget({ maxDollars: 20 }, p);
    const ct0 = createMockCostTracker();
    const ct1 = createMockCostTracker();

    // Iteration 0: cap is min(5, 20)=5, spend 3
    budget.trackCodon("work#0" as CodonId, c, ct0);
    expect(budget.getEffectiveLimits("work#0").maxDollars).toBe(5);
    emitCost(ct0, 3);
    budget.completeCodon("work#0" as CodonId, 3);

    // Iteration 1: cap is min(5, 17)=5 (per-iteration, NOT 5-3=2)
    budget.trackCodon("work#1" as CodonId, c, ct1);
    expect(budget.getEffectiveLimits("work#1").maxDollars).toBe(5);

    emitCost(ct1, 4.5);
    expect(budget.isExceeded("work#1")).toBe(false);
  });

  test("loop with two codons per iteration draws from shared pool", () => {
    const cImpl = codon("implement", { maxDollars: 3 });
    const cTest = codon("test");
    const p = plan(
      {
        codonId: "implement#0",
        codon: cImpl,
        loopContext: {
          loopId: "loop" as CodonId,
          iteration: 0,
          codonIndexInLoop: 0,
        },
      },
      {
        codonId: "test#0",
        codon: cTest,
        loopContext: {
          loopId: "loop" as CodonId,
          iteration: 0,
          codonIndexInLoop: 1,
        },
      },
      {
        codonId: "implement#1",
        codon: cImpl,
        loopContext: {
          loopId: "loop" as CodonId,
          iteration: 1,
          codonIndexInLoop: 0,
        },
      },
      {
        codonId: "test#1",
        codon: cTest,
        loopContext: {
          loopId: "loop" as CodonId,
          iteration: 1,
          codonIndexInLoop: 1,
        },
      },
    );
    const budget = createBudget({ maxDollars: 10 }, p);

    // implement#0: explicit $3, capped by remaining=10 → 3
    const ct0 = createMockCostTracker();
    budget.trackCodon("implement#0" as CodonId, cImpl, ct0);
    expect(budget.getEffectiveLimits("implement#0").maxDollars).toBe(3);
    emitCost(ct0, 2.5);
    budget.completeCodon("implement#0" as CodonId, 2.5);

    // test#0: no explicit, uniform share of remaining
    const ct1 = createMockCostTracker();
    budget.trackCodon("test#0" as CodonId, cTest, ct1);
    const testLimit = budget.getEffectiveLimits("test#0").maxDollars;
    expect(testLimit).toBeGreaterThan(0);
    emitCost(ct1, 0.5);
    budget.completeCodon("test#0" as CodonId, 0.5);

    // implement#1: explicit $3, capped by remaining (7.0) → 3
    const ct2 = createMockCostTracker();
    budget.trackCodon("implement#1" as CodonId, cImpl, ct2);
    expect(budget.getEffectiveLimits("implement#1").maxDollars).toBe(3);
    emitCost(ct2, 3);
    budget.completeCodon("implement#1" as CodonId, 3);

    // test#1: remaining = 4, only codon → 4
    const ct3 = createMockCostTracker();
    budget.trackCodon("test#1" as CodonId, cTest, ct3);
    expect(budget.getEffectiveLimits("test#1").maxDollars).toBe(4);
  });

  test("global budget limits loop iterations", () => {
    const c = codon("work", { maxDollars: 5 });
    const p = plan(
      {
        codonId: "work#0",
        codon: c,
        loopContext: {
          loopId: "loop" as CodonId,
          iteration: 0,
          codonIndexInLoop: 0,
        },
      },
      {
        codonId: "work#1",
        codon: c,
        loopContext: {
          loopId: "loop" as CodonId,
          iteration: 1,
          codonIndexInLoop: 0,
        },
      },
    );
    const budget = createBudget({ maxDollars: 7 }, p);
    const ct0 = createMockCostTracker();
    const ct1 = createMockCostTracker();

    // Iteration 0: cap = min(5, 7) = 5, spend 4
    budget.trackCodon("work#0" as CodonId, c, ct0);
    emitCost(ct0, 4);
    budget.completeCodon("work#0" as CodonId, 4);

    // Iteration 1: cap = min(5, 3) = 3 (global remaining limits it)
    budget.trackCodon("work#1" as CodonId, c, ct1);
    expect(budget.getEffectiveLimits("work#1").maxDollars).toBe(3);
  });
});

// =============================================================================
// Execution plan updates (loop expansion)
// =============================================================================

describe("Budget - execution plan updates", () => {
  test("updateExecutionPlan allows new codons to resolve correctly", () => {
    const c = codon("work");
    const initialPlan = plan({
      codonId: "work#0",
      codon: c,
      loopContext: {
        loopId: "loop" as CodonId,
        iteration: 0,
        codonIndexInLoop: 0,
      },
    });
    const budget = createBudget({ maxDollars: 10 }, initialPlan);
    const ct0 = createMockCostTracker();
    const ct1 = createMockCostTracker();

    // Complete iteration 0
    budget.trackCodon("work#0" as CodonId, c, ct0);
    emitCost(ct0, 3);
    budget.completeCodon("work#0" as CodonId, 3);

    // Loop expansion adds iteration 1
    const expandedPlan = plan(
      {
        codonId: "work#0",
        codon: c,
        loopContext: {
          loopId: "loop" as CodonId,
          iteration: 0,
          codonIndexInLoop: 0,
        },
      },
      {
        codonId: "work#1",
        codon: c,
        loopContext: {
          loopId: "loop" as CodonId,
          iteration: 1,
          codonIndexInLoop: 0,
        },
      },
    );
    budget.updateExecutionPlan(expandedPlan);

    // Iteration 1: remaining = 10 - 3 = 7
    budget.trackCodon("work#1" as CodonId, c, ct1);
    expect(budget.getEffectiveLimits("work#1").maxDollars).toBe(7);
  });
});

// =============================================================================
// Hank-level time budget (maxTimeSeconds)
// =============================================================================

describe("Budget - hank-level time budget", () => {
  test("trackCodon passes remaining time to codon resolution", () => {
    const c = codon("a", { maxTimeSeconds: 300 });
    const p = plan({ codonId: "a", codon: c });
    const budget = createBudget({ maxTimeSeconds: 60 }, p);
    const ct = createMockCostTracker();

    budget.trackCodon("a" as CodonId, c, ct);
    const limits = budget.getEffectiveLimits("a");
    // maxTimeSeconds=60, elapsed ~0s → remaining ~60s
    // effective = min(300, ~60) ≈ 60
    const dur = limits.maxTimeSeconds;
    expect(dur).toBeDefined();
    expect(dur).toBeLessThanOrEqual(60);
    expect(dur).toBeGreaterThan(59); // should be ~60 minus tiny elapsed
  });

  test("codon without duration gets hank remaining time as limit", () => {
    const c = codon("a"); // no maxTimeSeconds
    const p = plan({ codonId: "a", codon: c });
    const budget = createBudget({ maxTimeSeconds: 120 }, p);
    const ct = createMockCostTracker();

    budget.trackCodon("a" as CodonId, c, ct);
    const dur = budget.getEffectiveLimits("a").maxTimeSeconds;
    expect(dur).toBeDefined();
    expect(dur).toBeLessThanOrEqual(120);
    expect(dur).toBeGreaterThan(119);
  });

  test("no maxTimeSeconds means no duration limit from hank level", () => {
    const c = codon("a"); // no per-codon or hank-level time budget
    const p = plan({ codonId: "a", codon: c });
    const budget = createBudget({}, p);
    const ct = createMockCostTracker();

    budget.trackCodon("a" as CodonId, c, ct);
    const limits = budget.getEffectiveLimits("a");
    expect(limits.maxTimeSeconds).toBeUndefined();
  });

  test("maxTimeSeconds and maxDollars resolve independently", () => {
    const c = codon("a", { maxDollars: 5 });
    const p = plan({ codonId: "a", codon: c });
    const budget = createBudget({ maxDollars: 10, maxTimeSeconds: 30 }, p);
    const ct = createMockCostTracker();

    budget.trackCodon("a" as CodonId, c, ct);
    const limits = budget.getEffectiveLimits("a");
    expect(limits.maxDollars).toBe(5);
    const dur = limits.maxTimeSeconds;
    expect(dur).toBeDefined();
    expect(dur).toBeLessThanOrEqual(30);
  });
});

// =============================================================================
// Retry cost tracking
// =============================================================================

describe("Budget - retry cost tracking", () => {
  test("accumulateRetryCost and getAndClearRetryCost", () => {
    const budget = createBudget({}, []);

    budget.accumulateRetryCost("a", 2.0);
    budget.accumulateRetryCost("a", 1.5);
    expect(budget.getAndClearRetryCost("a")).toBe(3.5);
    // Cleared after get
    expect(budget.getAndClearRetryCost("a")).toBe(0);
  });

  test("getAndClearRetryCost returns 0 for unknown codon", () => {
    const budget = createBudget({}, []);
    expect(budget.getAndClearRetryCost("unknown")).toBe(0);
  });
});

// =============================================================================
// Spending tracking
// =============================================================================

describe("Budget - spending tracking", () => {
  test("getTotalSpent reflects completed and failed codons", () => {
    const cA = codon("a");
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget({}, p);
    const ctA = createMockCostTracker();
    const ctB = createMockCostTracker();

    expect(budget.getTotalSpent()).toBe(0);

    budget.trackCodon("a" as CodonId, cA, ctA);
    budget.completeCodon("a" as CodonId, 5);
    expect(budget.getTotalSpent()).toBe(5);

    budget.trackCodon("b" as CodonId, cB, ctB);
    budget.failCodon("b" as CodonId, 2);
    expect(budget.getTotalSpent()).toBe(7);
  });

  test("skipCodon leaves full budget for next codon", () => {
    const cA = codon("a");
    const cB = codon("b");
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget({ maxDollars: 10 }, p);
    const ctA = createMockCostTracker();

    budget.trackCodon("a" as CodonId, cA, ctA);
    budget.skipCodon("a" as CodonId);

    // B: remaining = 10 - 0 = 10, only codon → 10
    const ctB = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").maxDollars).toBe(10);
  });

  test("skipCodon records 0 cost", () => {
    const c = codon("a");
    const budget = createBudget({}, plan({ codonId: "a", codon: c }));
    const ct = createMockCostTracker();

    budget.trackCodon("a" as CodonId, c, ct);
    budget.skipCodon("a" as CodonId);
    expect(budget.getTotalSpent()).toBe(0);
  });
});

// =============================================================================
// Combined currencies
// =============================================================================

describe("Budget - combined currencies", () => {
  test("output tokens exceeded before cost on same codon", () => {
    const c = codon("a", {
      maxDollars: 10,
      maxOutputTokens: 100,
      maxTimeSeconds: 300,
    });
    const budget = createBudget({}, plan({ codonId: "a", codon: c }));
    const exceeded = collectExceeded(budget);
    const ct = createMockCostTracker();

    budget.trackCodon("a" as CodonId, c, ct);

    // Emit output tokens that exceed limit, but cost stays under
    emitOutputTokens(ct, 150); // exceeds 100
    expect(budget.isExceeded("a")).toBe(true);
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0].info.currency).toBe("outputTokens");
    expect(exceeded[0].info.limit).toBe(100);
    expect(exceeded[0].info.used).toBe(150);
  });

  test("two codons each emit their own exceeded event", () => {
    const cA = codon("a", { maxDollars: 2 });
    const cB = codon("b", { maxDollars: 3 });
    const p = plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB });
    const budget = createBudget({}, p);
    const exceeded = collectExceeded(budget);

    const ctA = createMockCostTracker();
    budget.trackCodon("a" as CodonId, cA, ctA);
    emitCost(ctA, 2.5); // exceeds 2
    expect(budget.isExceeded("a")).toBe(true);
    budget.completeCodon("a" as CodonId, 2.5);

    const ctB = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ctB);
    emitCost(ctB, 4); // exceeds 3
    expect(budget.isExceeded("b")).toBe(true);

    expect(exceeded).toHaveLength(2);
    expect(exceeded[0].codonId).toBe("a");
    expect(exceeded[1].codonId).toBe("b");
  });
});

// =============================================================================
// Design spec examples
// =============================================================================

describe("Budget - design spec: simple shared budget", () => {
  test("three codons sharing $5: plan $0.80, execute $3.50, review gets $0.70", () => {
    const cPlan = codon("plan");
    const cExec = codon("execute");
    const cReview = codon("review");
    const p = plan(
      { codonId: "plan", codon: cPlan },
      { codonId: "execute", codon: cExec },
      { codonId: "review", codon: cReview },
    );
    const budget = createBudget({ maxDollars: 5 }, p);
    const exceeded = collectExceeded(budget);

    // Plan: first-past-the-post, gets full $5 pool
    const ctPlan = createMockCostTracker();
    budget.trackCodon("plan" as CodonId, cPlan, ctPlan);
    expect(budget.getEffectiveLimits("plan").maxDollars).toBe(5);
    emitCost(ctPlan, 0.8);
    budget.completeCodon("plan" as CodonId, 0.8);

    // Execute: remaining=4.2, gets full remaining pool
    const ctExec = createMockCostTracker();
    budget.trackCodon("execute" as CodonId, cExec, ctExec);
    const execLimit = budget.getEffectiveLimits("execute").maxDollars;
    expect(execLimit).toBeCloseTo(4.2, 5);
    // Execute spends $3.50 — not exceeded since 3.50 < 4.20
    emitCost(ctExec, 3.5);
    expect(budget.isExceeded("execute")).toBe(false);
    budget.completeCodon("execute" as CodonId, 3.5);

    // Review: remaining = 5 - 0.8 - 3.5 = 0.7, gets 0.7
    const ctReview = createMockCostTracker();
    budget.trackCodon("review" as CodonId, cReview, ctReview);
    expect(budget.getEffectiveLimits("review").maxDollars).toBeCloseTo(0.7, 5);

    // Review hits limit
    emitCost(ctReview, 0.8); // exceeds 0.7
    expect(budget.isExceeded("review")).toBe(true);
    // Only review exceeded its limit
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0].codonId).toBe("review");
    expect(exceeded[0].info.currency).toBe("cost");
  });
});

describe("Budget - design spec: proportional with loop", () => {
  test("$12 hank with proportional shares and loop iterations", () => {
    const cResearch = codon("research");
    const cImplement = codon("implement", { maxDollars: 3 });
    const cTest = codon("test");
    const cFinalReview = codon("final-review");

    // Execution plan: research, implement#0, test#0, implement#1, test#1, final-review
    const p = plan(
      { codonId: "research", codon: cResearch },
      {
        codonId: "implement#0",
        codon: cImplement,
        loopContext: {
          loopId: "dev-loop" as CodonId,
          iteration: 0,
          codonIndexInLoop: 0,
        },
      },
      {
        codonId: "test#0",
        codon: cTest,
        loopContext: {
          loopId: "dev-loop" as CodonId,
          iteration: 0,
          codonIndexInLoop: 1,
        },
      },
      {
        codonId: "implement#1",
        codon: cImplement,
        loopContext: {
          loopId: "dev-loop" as CodonId,
          iteration: 1,
          codonIndexInLoop: 0,
        },
      },
      {
        codonId: "test#1",
        codon: cTest,
        loopContext: {
          loopId: "dev-loop" as CodonId,
          iteration: 1,
          codonIndexInLoop: 1,
        },
      },
      { codonId: "final-review", codon: cFinalReview },
    );

    const budget = createBudget(
      {
        maxDollars: 12,
        allocationMode: "proportional",
        shares: { research: 0.15, "dev-loop": 0.7, "final-review": 0.15 },
      },
      p,
    );

    // Research: share = 0.15 * 12 = $1.80
    const ctRes = createMockCostTracker();
    budget.trackCodon("research" as CodonId, cResearch, ctRes);
    expect(budget.getEffectiveLimits("research").maxDollars).toBeCloseTo(1.8, 5);
    emitCost(ctRes, 0.8);
    budget.completeCodon("research" as CodonId, 0.8);

    // implement#0: explicit maxDollars=3, takes precedence
    const ctImpl0 = createMockCostTracker();
    budget.trackCodon("implement#0" as CodonId, cImplement, ctImpl0);
    expect(budget.getEffectiveLimits("implement#0").maxDollars).toBe(3);
    emitCost(ctImpl0, 2.5);
    budget.completeCodon("implement#0" as CodonId, 2.5);

    // test#0: inside dev-loop (share=0.70 → $8.40 loop pool).
    // Loop spent so far = $2.50 (implement#0), so test#0 gets $8.40 - $2.50 = $5.90
    // (first-past-the-post within the loop, capped by hank remaining $8.70)
    const ctTest0 = createMockCostTracker();
    budget.trackCodon("test#0" as CodonId, cTest, ctTest0);
    const test0Limit = budget.getEffectiveLimits("test#0").maxDollars;
    expect(test0Limit).toBeCloseTo(5.9, 5);
    emitCost(ctTest0, 0.5);
    budget.completeCodon("test#0" as CodonId, 0.5);

    // implement#1: explicit $3 cap
    const ctImpl1 = createMockCostTracker();
    budget.trackCodon("implement#1" as CodonId, cImplement, ctImpl1);
    expect(budget.getEffectiveLimits("implement#1").maxDollars).toBe(3);
    emitCost(ctImpl1, 2.0);
    budget.completeCodon("implement#1" as CodonId, 2.0);

    // test#1
    const ctTest1 = createMockCostTracker();
    budget.trackCodon("test#1" as CodonId, cTest, ctTest1);
    emitCost(ctTest1, 0.3);
    budget.completeCodon("test#1" as CodonId, 0.3);

    // final-review: share = 0.15 * 12 = $1.80
    // remaining = 12 - 0.8 - 2.5 - 0.5 - 2.0 - 0.3 = $5.90
    // allocation = min(1.80, 5.90) = 1.80
    const ctFR = createMockCostTracker();
    budget.trackCodon("final-review" as CodonId, cFinalReview, ctFR);
    expect(budget.getEffectiveLimits("final-review").maxDollars).toBeCloseTo(1.8, 5);

    expect(budget.getTotalSpent()).toBeCloseTo(6.1, 5);
  });
});

describe("Budget - design spec: operator ceiling override", () => {
  test("hank $12 budget with $5 operator ceiling scales proportional shares", () => {
    // effectiveDollars = min(operator=5, hank=12) = 5
    // Budget config gets maxDollars: 5 with the same shares
    const cRes = codon("research");
    const cDev = codon("dev-loop");
    const cFR = codon("final-review");
    const p = plan(
      { codonId: "research", codon: cRes },
      { codonId: "dev-loop", codon: cDev },
      { codonId: "final-review", codon: cFR },
    );
    const budget = createBudget(
      {
        maxDollars: 5,
        allocationMode: "proportional",
        shares: { research: 0.15, "dev-loop": 0.7, "final-review": 0.15 },
      },
      p,
    );

    // research: 0.15 * 5 = $0.75
    const ctRes = createMockCostTracker();
    budget.trackCodon("research" as CodonId, cRes, ctRes);
    expect(budget.getEffectiveLimits("research").maxDollars).toBeCloseTo(0.75, 5);

    emitCost(ctRes, 0.5);
    budget.completeCodon("research" as CodonId, 0.5);

    // dev-loop: 0.7 * 5 = $3.50
    const ctDev = createMockCostTracker();
    budget.trackCodon("dev-loop" as CodonId, cDev, ctDev);
    expect(budget.getEffectiveLimits("dev-loop").maxDollars).toBeCloseTo(3.5, 5);

    emitCost(ctDev, 3.0);
    budget.completeCodon("dev-loop" as CodonId, 3.0);

    // final-review: 0.15 * 5 = $0.75
    const ctFR = createMockCostTracker();
    budget.trackCodon("final-review" as CodonId, cFR, ctFR);
    expect(budget.getEffectiveLimits("final-review").maxDollars).toBeCloseTo(0.75, 5);
  });
});

// =============================================================================
// hydrateFromPriorRuns
// =============================================================================

/** Build a minimal Run object for testing hydrateFromPriorRuns. */
function makeRun(
  runId: string,
  codons: Array<{ codonId: string; cost: number; status?: string }>,
): Run {
  return {
    runId: runId as RunId,
    runFolder: `/tmp/${runId}`,
    gitBranch: `run-${runId}`,
    startingConditions: { type: "fresh" },
    codons: codons.map(
      (c) =>
        ({
          codonId: c.codonId as CodonId,
          status: c.status ?? "completed",
          finalCost: c.status === "failed" ? undefined : c.cost,
          partialCost: c.status === "failed" ? c.cost : undefined,
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
        }) as unknown as CodonExecution,
    ),
    status: "completed",
    startTime: new Date().toISOString(),
    serverPid: 1,
  };
}

/** Build a Run with explicit per-codon startTime/endTime for testing time hydration. */
function makeRunWithTimes(
  runId: string,
  codons: Array<{
    codonId: string;
    cost: number;
    startTime: string;
    endTime: string;
    status?: string;
  }>,
): Run {
  return {
    runId: runId as RunId,
    runFolder: `/tmp/${runId}`,
    gitBranch: `run-${runId}`,
    startingConditions: { type: "fresh" },
    codons: codons.map(
      (c) =>
        ({
          codonId: c.codonId as CodonId,
          status: c.status ?? "completed",
          finalCost: c.status === "failed" ? undefined : c.cost,
          partialCost: c.status === "failed" ? c.cost : undefined,
          startTime: c.startTime,
          endTime: c.endTime,
        }) as unknown as CodonExecution,
    ),
    status: "completed",
    startTime: codons[0]?.startTime ?? new Date().toISOString(),
    serverPid: 1,
  };
}

describe("Budget - hydrateFromPriorRuns", () => {
  test("hydrates spending from prior runs", () => {
    const cB = codon("b");
    const execPlan = plan({ codonId: "b", codon: cB });

    const budget = createBudget({ maxDollars: 2.0 }, execPlan);
    const runs = [makeRun("run-1", [{ codonId: "a", cost: 0.5 }]), makeRun("run-current", [])];

    budget.hydrateFromPriorRuns(runs, "run-current");

    // $2.00 global - $0.50 prior = $1.50 remaining for codon b
    const ct = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ct);
    expect(budget.getEffectiveLimits("b").maxDollars).toBeCloseTo(1.5, 2);
  });

  test("skips the current run", () => {
    const cB = codon("b");
    const execPlan = plan({ codonId: "b", codon: cB });

    const budget = createBudget({ maxDollars: 2.0 }, execPlan);
    const runs = [
      makeRun("run-1", [{ codonId: "a", cost: 0.5 }]),
      makeRun("run-current", [{ codonId: "x", cost: 0.8 }]),
    ];

    budget.hydrateFromPriorRuns(runs, "run-current");

    // Only $0.50 from run-1 counted, not $0.80 from run-current
    const ct = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ct);
    expect(budget.getEffectiveLimits("b").maxDollars).toBeCloseTo(1.5, 2);
  });

  test("aggregates same codonId across multiple runs", () => {
    const cA = codon("a");
    const execPlan = plan({ codonId: "a", codon: cA });

    const budget = createBudget({ maxDollars: 3.0 }, execPlan);
    const runs = [
      makeRun("run-1", [{ codonId: "a", cost: 0.5 }]),
      makeRun("run-2", [{ codonId: "a", cost: 0.3 }]),
      makeRun("run-current", []),
    ];

    budget.hydrateFromPriorRuns(runs, "run-current");

    // $3.00 - $0.80 (0.5 + 0.3) = $2.20
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, cA, ct);
    expect(budget.getEffectiveLimits("a").maxDollars).toBeCloseTo(2.2, 2);
  });

  test("skips zero-cost codons (skipped status)", () => {
    const cB = codon("b");
    const execPlan = plan({ codonId: "b", codon: cB });

    const budget = createBudget({ maxDollars: 2.0 }, execPlan);
    const runs = [
      makeRun("run-1", [
        { codonId: "a", cost: 0, status: "skipped" },
        { codonId: "c", cost: 0.4 },
      ]),
      makeRun("run-current", []),
    ];

    budget.hydrateFromPriorRuns(runs, "run-current");

    // Only $0.40 from codon c counted (skipped codon a has 0 cost)
    const ct = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ct);
    expect(budget.getEffectiveLimits("b").maxDollars).toBeCloseTo(1.6, 2);
  });

  test("no-op when no prior runs have spending", () => {
    const cA = codon("a");
    const execPlan = plan({ codonId: "a", codon: cA });

    const budget = createBudget({ maxDollars: 2.0 }, execPlan);
    budget.hydrateFromPriorRuns([], "run-current");

    // Full budget available
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, cA, ct);
    expect(budget.getEffectiveLimits("a").maxDollars).toBeCloseTo(2.0, 2);
  });

  test("includes failed codon partial costs", () => {
    const cB = codon("b");
    const execPlan = plan({ codonId: "b", codon: cB });

    const budget = createBudget({ maxDollars: 2.0 }, execPlan);
    const runs = [
      makeRun("run-1", [{ codonId: "a", cost: 0.7, status: "failed" }]),
      makeRun("run-current", []),
    ];

    budget.hydrateFromPriorRuns(runs, "run-current");

    // $2.00 - $0.70 partial cost = $1.30
    const ct = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ct);
    expect(budget.getEffectiveLimits("b").maxDollars).toBeCloseTo(1.3, 2);
  });

  test("constructor accepts priorRuns for hydration", () => {
    const cB = codon("b");
    const execPlan = plan({ codonId: "b", codon: cB });

    const runs = [makeRun("run-1", [{ codonId: "a", cost: 0.6 }]), makeRun("run-current", [])];

    const budget = new Budget({
      config: { maxDollars: 2.0 },
      executionPlan: execPlan,
      logger: mockLogger,
      priorRuns: { runs, currentRunId: "run-current" },
    });

    // $2.00 - $0.60 = $1.40
    const ct = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ct);
    expect(budget.getEffectiveLimits("b").maxDollars).toBeCloseTo(1.4, 2);
  });

  test("aggregates loop time across multiple prior runs for the same codon ID", () => {
    const cWork = codon("work");
    const loopId = "loop" as CodonId;

    // Execution plan: a loop with maxTimeSeconds: 60
    const execPlan: ExecutionCodonEntry[] = [
      {
        codonId: "work#0" as CodonId,
        codon: cWork,
        loopContext: {
          loopId,
          iteration: 0,
          codonIndexInLoop: 0,
          loopBudget: { maxTimeSeconds: 60 },
        },
      },
      {
        codonId: "work#1" as CodonId,
        codon: cWork,
        loopContext: {
          loopId,
          iteration: 1,
          codonIndexInLoop: 0,
          loopBudget: { maxTimeSeconds: 60 },
        },
      },
    ];

    const budget = createBudget({}, execPlan);

    // Two prior runs each ran work#0 for 10 seconds (total: 20s consumed)
    const t0 = "2025-01-01T00:00:00.000Z";
    const t10 = "2025-01-01T00:00:10.000Z";
    const runs = [
      makeRunWithTimes("run-1", [{ codonId: "work#0", cost: 0.1, startTime: t0, endTime: t10 }]),
      makeRunWithTimes("run-2", [{ codonId: "work#0", cost: 0.1, startTime: t0, endTime: t10 }]),
      makeRunWithTimes("run-current", []),
    ];

    budget.hydrateFromPriorRuns(runs, "run-current");

    const ct = createMockCostTracker();
    budget.trackCodon("work#0" as CodonId, cWork, ct);
    const limits = budget.getEffectiveLimits("work#0");

    // 60s loop budget - 20s prior elapsed = 40s remaining
    // With the bug, only 10s is counted (last snapshot only), giving ~50s remaining
    const maxTime = limits.maxTimeSeconds;
    expect(maxTime).toBeDefined();
    expect(maxTime).toBeLessThanOrEqual(42); // ~40s + small tolerance
    expect(maxTime).toBeGreaterThanOrEqual(38); // ~40s - small tolerance
  });
});

// =============================================================================
// Loop-level budget scoping
// =============================================================================

describe("loop-level budget", () => {
  function loopEntry(
    codonId: string,
    codonConfig: ExecutionCodonEntry["codon"],
    loopId: string,
    iteration: number,
    codonIndexInLoop: number,
    loopBudget?: ExecutionCodonEntry["loopContext"] extends infer T
      ? T extends { loopBudget?: infer LB }
        ? LB
        : never
      : never,
  ): {
    codonId: string;
    codon: ExecutionCodonEntry["codon"];
    loopContext: ExecutionCodonEntry["loopContext"];
  } {
    return {
      codonId,
      codon: codonConfig,
      loopContext: {
        loopId: loopId as CodonId,
        iteration,
        codonIndexInLoop,
        ...(loopBudget ? { loopBudget } : {}),
      },
    };
  }

  test("loop with maxDollars scopes codons to loop remaining", () => {
    const cWork = codon("work");
    const cTest = codon("test");

    const execPlan = plan(
      loopEntry("work#0", cWork, "loop", 0, 0, { maxDollars: 1.0 }),
      loopEntry("test#0", cTest, "loop", 0, 1, { maxDollars: 1.0 }),
      loopEntry("work#1", cWork, "loop", 1, 0, { maxDollars: 1.0 }),
      loopEntry("test#1", cTest, "loop", 1, 1, { maxDollars: 1.0 }),
    );

    const budget = createBudget({ maxDollars: 10.0 }, execPlan);

    // Track work#0 — should see loop maxDollars ($1.00) as its global, not hank ($10)
    const ct0 = createMockCostTracker();
    budget.trackCodon("work#0" as CodonId, cWork, ct0);
    // First-past-the-post: work#0 gets full loop pool ($1.00)
    expect(budget.getEffectiveLimits("work#0").maxDollars).toBeCloseTo(1.0, 2);

    // Complete work#0 with $0.20
    budget.completeCodon("work#0" as CodonId, 0.2);

    // Track test#0 — should see $0.80 remaining in loop (full remaining pool)
    const ct1 = createMockCostTracker();
    budget.trackCodon("test#0" as CodonId, cTest, ct1);
    expect(budget.getEffectiveLimits("test#0").maxDollars).toBeCloseTo(0.8, 2);
  });

  test("loop budget capped by hank proportional allocation", () => {
    const cWork = codon("work");

    const execPlan = plan(
      { codonId: "pre", codon: codon("pre") },
      loopEntry("work#0", cWork, "loop", 0, 0, { maxDollars: 5.0 }),
    );

    // Hank allocates 30% of $10 = $3 to the loop via proportional shares
    const budget = createBudget(
      {
        maxDollars: 10.0,
        allocationMode: "proportional",
        shares: { loop: 0.3 },
      },
      execPlan,
    );

    // Complete pre codon
    budget.completeCodon("pre" as CodonId, 0.5);

    // Track work#0 — loop declared $5.00 but hank only gave it $3.00
    const ct = createMockCostTracker();
    budget.trackCodon("work#0" as CodonId, cWork, ct);
    // Effective loop budget = min($5.00, $3.00) = $3.00
    // Single codon in loop, so it gets the full $3.00
    expect(budget.getEffectiveLimits("work#0").maxDollars).toBeCloseTo(3.0, 2);
  });

  test("isLoopBudgetExceeded returns true when loop spending exceeds maxDollars", () => {
    const cWork = codon("work");

    const execPlan = plan(
      loopEntry("work#0", cWork, "loop", 0, 0, { maxDollars: 1.0 }),
      loopEntry("work#1", cWork, "loop", 1, 0, { maxDollars: 1.0 }),
    );

    const budget = createBudget({ maxDollars: 10.0 }, execPlan);

    // Track and complete work#0 with $0.80
    const ct0 = createMockCostTracker();
    budget.trackCodon("work#0" as CodonId, cWork, ct0);
    budget.completeCodon("work#0" as CodonId, 0.8);

    expect(budget.isLoopBudgetExceeded("loop")).toBe(false);

    // Track and complete work#1 with $0.30 — total $1.10 > $1.00
    const ct1 = createMockCostTracker();
    budget.trackCodon("work#1" as CodonId, cWork, ct1);
    budget.completeCodon("work#1" as CodonId, 0.3);

    expect(budget.isLoopBudgetExceeded("loop")).toBe(true);
  });

  test("loop without budget uses hank-level scoping (unchanged behavior)", () => {
    const cWork = codon("work");

    // No loopBudget in loopContext
    const execPlan = plan(
      loopEntry("work#0", cWork, "loop", 0, 0),
      loopEntry("work#1", cWork, "loop", 1, 0),
    );

    const budget = createBudget({ maxDollars: 4.0 }, execPlan);

    // Track work#0 — should see hank-level maxDollars ($4.00), not loop-scoped
    const ct = createMockCostTracker();
    budget.trackCodon("work#0" as CodonId, cWork, ct);
    // First-past-the-post: gets full hank pool ($4.00)
    expect(budget.getEffectiveLimits("work#0").maxDollars).toBeCloseTo(4.0, 2);
  });

  test("codon sees loop scope, not hank scope when loop has budget", () => {
    const cWork = codon("work");

    const execPlan = plan(
      { codonId: "pre", codon: codon("pre") },
      loopEntry("work#0", cWork, "loop", 0, 0, { maxDollars: 2.0 }),
    );

    // Hank has $10 total, loop has $2
    const budget = createBudget({ maxDollars: 10.0 }, execPlan);

    // Complete pre with $1
    budget.completeCodon("pre" as CodonId, 1.0);

    // Track work#0 — should see loop's $2.00, not hank's remaining $9.00
    const ct = createMockCostTracker();
    budget.trackCodon("work#0" as CodonId, cWork, ct);
    expect(budget.getEffectiveLimits("work#0").maxDollars).toBeCloseTo(2.0, 2);
  });

  test("isLoopBudgetExceeded returns false for loop without budget", () => {
    const budget = createBudget({ maxDollars: 10.0 }, []);
    expect(budget.isLoopBudgetExceeded("nonexistent")).toBe(false);
  });

  test("hank proportional share for loop ID allocates correctly without explicit loopBudget", () => {
    // Mirrors a hank config like:
    //   budget: { maxDollars: 5, allocation: "proportional",
    //             shares: { "step-one": 0.40, "my-loop": 0.60 } }
    //   hank: [step-one codon, loop "my-loop" with 2 iterations of "loop-step"]
    // The loop has NO budget field of its own — its allocation comes solely from hank shares.
    const cStepOne = codon("step-one");
    const cLoopStep = codon("loop-step");

    const execPlan = plan(
      { codonId: "step-one", codon: cStepOne },
      {
        codonId: "loop-step#0",
        codon: cLoopStep,
        loopContext: {
          loopId: "my-loop" as CodonId,
          iteration: 0,
          codonIndexInLoop: 0,
          // No loopBudget — budget comes from hank shares["my-loop"]
        },
      },
      {
        codonId: "loop-step#1",
        codon: cLoopStep,
        loopContext: {
          loopId: "my-loop" as CodonId,
          iteration: 1,
          codonIndexInLoop: 0,
          // No loopBudget
        },
      },
    );

    const budget = createBudget(
      {
        maxDollars: 5.0,
        allocationMode: "proportional",
        shares: { "step-one": 0.4, "my-loop": 0.6 },
      },
      execPlan,
    );

    // step-one gets 40% of $5.00 = $2.00
    const ctStepOne = createMockCostTracker();
    budget.trackCodon("step-one" as CodonId, cStepOne, ctStepOne);
    expect(budget.getEffectiveLimits("step-one").maxDollars).toBe(2.0);
    emitCost(ctStepOne, 1.5);
    budget.completeCodon("step-one" as CodonId, 1.5);

    // my-loop gets 60% of $5.00 = $3.00 (shared pool across all iterations)
    // loop-step#0: first-past-the-post within loop pool → gets full $3.00
    const ct0 = createMockCostTracker();
    budget.trackCodon("loop-step#0" as CodonId, cLoopStep, ct0);
    expect(budget.getEffectiveLimits("loop-step#0").maxDollars).toBe(3.0);
    emitCost(ct0, 1.5);
    budget.completeCodon("loop-step#0" as CodonId, 1.5);

    // loop-step#1: remaining loop budget = $3.00 - $1.50 = $1.50
    const ct1 = createMockCostTracker();
    budget.trackCodon("loop-step#1" as CodonId, cLoopStep, ct1);
    expect(budget.getEffectiveLimits("loop-step#1").maxDollars).toBe(1.5);
  });

  test("loop with proportional allocation distributes to codons by share", () => {
    const cA = codon("a");
    const cB = codon("b");

    const loopBudget = {
      maxDollars: 6.0,
      allocation: "proportional" as const,
      shares: { a: 0.6, b: 0.4 },
    };

    const execPlan = plan(
      loopEntry("a#0", cA, "loop", 0, 0, loopBudget),
      loopEntry("b#0", cB, "loop", 0, 1, loopBudget),
    );

    const budget = createBudget({ maxDollars: 10.0 }, execPlan);

    // Track a#0 — should get 60% of $6.00 = $3.60
    const ct0 = createMockCostTracker();
    budget.trackCodon("a#0" as CodonId, cA, ct0);
    expect(budget.getEffectiveLimits("a#0").maxDollars).toBeCloseTo(3.6, 2);

    // Complete a#0 with $2.00
    budget.completeCodon("a#0" as CodonId, 2.0);

    // Track b#0 — should get 40% of $6.00 = $2.40, bounded by remaining ($4.00)
    const ct1 = createMockCostTracker();
    budget.trackCodon("b#0" as CodonId, cB, ct1);
    expect(budget.getEffectiveLimits("b#0").maxDollars).toBeCloseTo(2.4, 2);
  });

  test("loop budget is capped by hank remaining, not hank max (shared mode)", () => {
    const cPre = codon("pre");
    const cWork = codon("work");

    const execPlan = plan(
      { codonId: "pre", codon: cPre },
      loopEntry("work#0", cWork, "loop", 0, 0, { maxDollars: 5.0 }),
      loopEntry("work#1", cWork, "loop", 1, 0, { maxDollars: 5.0 }),
    );

    // Hank max = $10, shared mode (default)
    const budget = createBudget({ maxDollars: 10.0 }, execPlan);

    // Pre-loop codon spent $9 — only $1 remains in hank
    budget.completeCodon("pre" as CodonId, 9.0);

    // Track work#0 — loop declared $5 but hank only has $1 remaining
    const ct = createMockCostTracker();
    budget.trackCodon("work#0" as CodonId, cWork, ct);

    // BUG: without fix, this returns $5.00 (loop max) instead of $1.00 (hank remaining)
    expect(budget.getEffectiveLimits("work#0").maxDollars).toBeCloseTo(1.0, 2);
  });

  test("loop budget with only maxTimeSeconds still inherits hank maxDollars", () => {
    const cPre = codon("pre");
    const cWork = codon("work");

    const execPlan = plan(
      { codonId: "pre", codon: cPre },
      loopEntry("work#0", cWork, "loop", 0, 0, { maxTimeSeconds: 30 }),
      loopEntry("work#1", cWork, "loop", 1, 0, { maxTimeSeconds: 30 }),
    );

    // Hank has a $10 dollar limit
    const budget = createBudget({ maxDollars: 10.0 }, execPlan);

    // Pre-loop codon spent $3
    budget.completeCodon("pre" as CodonId, 3.0);

    // Track work#0 — loop has no maxDollars, but hank has $7 remaining
    const ct = createMockCostTracker();
    budget.trackCodon("work#0" as CodonId, cWork, ct);

    // Codon should be capped by hank remaining ($7), not unlimited
    expect(budget.getEffectiveLimits("work#0").maxDollars).toBeDefined();
    expect(budget.getEffectiveLimits("work#0").maxDollars).toBeCloseTo(7.0, 2);
  });
});

// =============================================================================
// onExceeded resolution
// =============================================================================

describe("Budget - onExceeded resolution", () => {
  test("defaults to 'complete' when no onExceeded is set", () => {
    const c = codon("a", { maxDollars: 5 });
    const budget = createBudget({}, plan({ codonId: "a", codon: c }));
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, c, ct);
    expect(budget.getEffectiveLimits("a").onExceeded).toBe("complete");
  });

  test("hank-level onExceeded applies to all codons", () => {
    const cA = codon("a", { maxDollars: 5 });
    const cB = codon("b", { maxDollars: 5 });
    const budget = createBudget(
      { maxDollars: 20, onExceeded: "fail" },
      plan({ codonId: "a", codon: cA }, { codonId: "b", codon: cB }),
    );

    const ctA = createMockCostTracker();
    budget.trackCodon("a" as CodonId, cA, ctA);
    expect(budget.getEffectiveLimits("a").onExceeded).toBe("fail");

    budget.completeCodon("a" as CodonId, 3);

    const ctB = createMockCostTracker();
    budget.trackCodon("b" as CodonId, cB, ctB);
    expect(budget.getEffectiveLimits("b").onExceeded).toBe("fail");
  });

  test("codon-level onExceeded overrides hank-level", () => {
    const c = codon("a", { maxDollars: 5, onExceeded: "complete" });
    const budget = createBudget(
      { maxDollars: 20, onExceeded: "fail" },
      plan({ codonId: "a", codon: c }),
    );
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, c, ct);
    expect(budget.getEffectiveLimits("a").onExceeded).toBe("complete");
  });

  test("codon-level onExceeded='fail' overrides hank default 'complete'", () => {
    const c = codon("a", { maxDollars: 5, onExceeded: "fail" });
    const budget = createBudget({ maxDollars: 20 }, plan({ codonId: "a", codon: c }));
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, c, ct);
    expect(budget.getEffectiveLimits("a").onExceeded).toBe("fail");
  });
});

// =============================================================================
// Watchdog timer — active time enforcement
// =============================================================================

describe("Budget - watchdog timer", () => {
  test("timer fires exceeded without any cost events", async () => {
    const c = codon("a", { maxTimeSeconds: 0 });
    const budget = createBudget({}, plan({ codonId: "a", codon: c }));
    const events = collectExceeded(budget);
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, c, ct);
    await waitForCondition(() => events.length === 1);
    expect(events.length).toBe(1);
    expect(events[0].codonId).toBe("a");
    expect(events[0].info.currency).toBe("duration");
    budget.completeCodon("a" as CodonId, 0);
  });

  test("completeCodon clears watchdog — no late exceeded event", async () => {
    const c = codon("a", { maxTimeSeconds: 0 });
    const budget = createBudget({}, plan({ codonId: "a", codon: c }));
    const events = collectExceeded(budget);
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, c, ct);
    budget.completeCodon("a" as CodonId, 0);
    // Negative assertion: there is no event to await, so the only way to prove
    // the watchdog was cleared is to outlast a full tick of its 1s setInterval.
    await new Promise((r) => setTimeout(r, 1100));
    expect(events.length).toBe(0);
  });

  test("no timer started for cost-only budgets", async () => {
    const c = codon("a", { maxDollars: 5 });
    const budget = createBudget({}, plan({ codonId: "a", codon: c }));
    const events = collectExceeded(budget);
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, c, ct);
    await new Promise((r) => setTimeout(r, 25));
    expect(events.length).toBe(0);
    budget.completeCodon("a" as CodonId, 0);
  });

  test("loop time watchdog fires exceeded for codon in loop", async () => {
    const c = codon("loop-codon");
    const executionPlan = plan({
      codonId: "loop-codon",
      codon: c,
      loopContext: {
        loopId: "loop1" as CodonId,
        iteration: 0,
        codonIndexInLoop: 0,
        loopBudget: { maxTimeSeconds: 0 },
      },
    });
    const budget = createBudget({}, executionPlan);
    const events = collectExceeded(budget);
    const ct = createMockCostTracker();
    budget.trackCodon("loop-codon" as CodonId, c, ct);
    await waitForCondition(() => events.length === 1);
    expect(events.length).toBe(1);
    expect(events[0].codonId).toBe("loop-codon");
    expect(events[0].info.currency).toBe("duration");
    budget.completeCodon("loop-codon" as CodonId, 0);
  });
});

// =============================================================================
// Telemetry reporter integration
// =============================================================================

function createMockTelemetry() {
  const calls = {
    budgetSet: [] as Parameters<BudgetTelemetryReporter["reportBudgetSet"]>[0][],
    budgetExceeded: [] as Parameters<BudgetTelemetryReporter["reportBudgetExceeded"]>[0][],
  };
  const reporter: BudgetTelemetryReporter = {
    reportBudgetSet: (data) => calls.budgetSet.push(data),
    reportBudgetExceeded: (data) => calls.budgetExceeded.push(data),
  };
  return { reporter, calls };
}

describe("Budget telemetry reporter", () => {
  test("reportBudgetSet is called per-codon in trackCodon with resolved limits", () => {
    const { reporter, calls } = createMockTelemetry();
    const c = codon("a");
    const executionPlan = plan({ codonId: "a", codon: c });
    const budget = new Budget({
      config: { maxDollars: 10 },
      executionPlan,
      logger: mockLogger,
      telemetry: reporter,
    });

    // Not called in constructor
    expect(calls.budgetSet.length).toBe(0);

    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, c, ct);

    // Called after trackCodon resolves limits
    expect(calls.budgetSet.length).toBe(1);
    expect(calls.budgetSet[0].codonId).toBe("a");
    expect(calls.budgetSet[0].limits.maxDollars).toBe(10);
  });

  test("reportBudgetSet includes costSource from resolved limits", () => {
    const { reporter, calls } = createMockTelemetry();
    const c = codon("a", { maxDollars: 2.0 });
    const executionPlan = plan({ codonId: "a", codon: c });
    const budget = new Budget({
      config: {},
      executionPlan,
      logger: mockLogger,
      telemetry: reporter,
    });
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, c, ct);

    expect(calls.budgetSet.length).toBe(1);
    expect(calls.budgetSet[0].limits.maxDollars).toBe(2.0);
    expect(calls.budgetSet[0].limits.costSource).toBe("codon cap");
  });

  test("reportBudgetExceeded is called when codon exceeds budget", () => {
    const { reporter, calls } = createMockTelemetry();
    const c = codon("a");
    const executionPlan = plan({ codonId: "a", codon: c });
    const budget = new Budget({
      config: { maxDollars: 1.0 },
      executionPlan,
      logger: mockLogger,
      telemetry: reporter,
    });
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, c, ct);
    emitCost(ct, 1.5);

    expect(calls.budgetExceeded.length).toBe(1);
    expect(calls.budgetExceeded[0].codonId).toBe("a");
    expect(calls.budgetExceeded[0].info.currency).toBe("cost");
    expect(calls.budgetExceeded[0].info.limit).toBe(1.0);
    expect(calls.budgetExceeded[0].info.used).toBe(1.5);
  });

  test("reportBudgetSet is NOT called when no limits are resolved", () => {
    const { reporter, calls } = createMockTelemetry();
    const c = codon("a");
    const executionPlan = plan({ codonId: "a", codon: c });
    const budget = new Budget({
      config: {},
      executionPlan,
      logger: mockLogger,
      telemetry: reporter,
    });
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, c, ct);

    expect(calls.budgetSet.length).toBe(0);
  });

  test("no crash when telemetry reporter is not provided", () => {
    const c = codon("a");
    const executionPlan = plan({ codonId: "a", codon: c });
    const budget = new Budget({
      config: { maxDollars: 1.0 },
      executionPlan,
      logger: mockLogger,
    });
    const ct = createMockCostTracker();
    budget.trackCodon("a" as CodonId, c, ct);
    emitCost(ct, 1.5);
    expect(budget.isExceeded("a")).toBe(true);
  });
});
