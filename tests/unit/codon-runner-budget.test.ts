/**
 * Tests for CodonRunner's integration with the Budget facade.
 *
 * Verifies that CodonRunner correctly initializes budget tracking via
 * trackCodon and responds to Budget exceeded events. Allocation logic
 * itself is tested in budget.test.ts and budget-allocator.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { useCodonRunnerSuite } from "../utils/codon-runner-test-harness.js";

describe("CodonRunner budget integration", () => {
  const suite = useCodonRunnerSuite("budget");

  test("constructs with a Budget instance and calls trackCodon", async () => {
    const h = await suite.makeRunner({ budget: { plan: "self" } });

    // Runner created successfully and trackCodon was called (limits resolved)
    expect(h.runner).toBeTruthy();
    expect(h.budget.getEffectiveLimits(h.codonId)).toBeDefined();
  });

  test("budget.isExceeded is false when no limits configured", async () => {
    const h = await suite.makeRunner({ budget: { plan: "self" } });

    expect(h.budget.isExceeded(h.codonId)).toBe(false);
  });

  test("budget exceeded event is emitted when limit is breached via CostTracker", async () => {
    const h = await suite.makeRunner({
      codon: { budget: { maxDollars: 1.0 } },
      budget: { plan: "self" },
      // Mock that returns a real cost so CostTracker emits non-zero costDelta
      llmRegistry: { calculateCost: () => 2.0 },
    });

    // Simulate cost via the runner's internal CostTracker by feeding raw usage
    // CostTracker.handleAssistantUsage emits costIncremented → Budget picks it up
    h.internals.costTracker.handleAssistantUsage({
      input_tokens: 1000,
      output_tokens: 1000,
    });

    expect(h.budget.isExceeded(h.codonId)).toBe(true);
    expect(h.budget.getExceededInfo(h.codonId)).toBeDefined();
    expect(h.budget.getExceededInfo(h.codonId)?.currency).toBe("cost");
  });

  test("budget with global maxDollars resolves limits", async () => {
    const h = await suite.makeRunner({
      budget: { config: { maxDollars: 10.0 }, plan: "self" },
    });

    expect(h.budget.isExceeded(h.codonId)).toBe(false);
    expect(h.budget.getEffectiveLimits(h.codonId).maxDollars).toBe(10.0);
  });
});
