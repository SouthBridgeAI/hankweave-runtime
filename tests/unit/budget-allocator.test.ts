import { describe, expect, test } from "bun:test";
import { resolveCodonBudget } from "../../server/budget";

describe("resolveCodonBudget", () => {
  describe("no global budget", () => {
    test("no limits when no global and no codon maxDollars", () => {
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        alreadySpent: 0,
      });
      expect(result.maxDollars).toBeUndefined();
    });

    test("codon maxDollars used as-is without global", () => {
      const result = resolveCodonBudget({
        codon: { maxDollars: 5 },
        remainingCodons: [],
        alreadySpent: 0,
      });
      expect(result.maxDollars).toBe(5);
    });
  });

  describe("with global budget (shared mode, default)", () => {
    test("explicit maxDollars capped by global remaining", () => {
      const result = resolveCodonBudget({
        codon: { maxDollars: 10 },
        remainingCodons: [],
        globalMaxDollars: 20,
        alreadySpent: 15,
      });
      expect(result.maxDollars).toBe(5); // min(10, 20-15)
    });

    test("explicit maxDollars used when less than global remaining", () => {
      const result = resolveCodonBudget({
        codon: { maxDollars: 3 },
        remainingCodons: [],
        globalMaxDollars: 20,
        alreadySpent: 0,
      });
      expect(result.maxDollars).toBe(3);
    });

    test("first-past-the-post: codon gets full remaining pool", () => {
      // Global=100, spent=0, 3 remaining codons — codon gets full pool
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [{}, {}, {}],
        globalMaxDollars: 100,
        alreadySpent: 0,
      });
      expect(result.maxDollars).toBe(100);
    });

    test("first-past-the-post: remaining codons with maxDollars don't reduce pool", () => {
      // Global=100, spent=0 — other codons' maxDollars are irrelevant in shared mode
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [{ maxDollars: 20 }, { maxDollars: 30 }, {}],
        globalMaxDollars: 100,
        alreadySpent: 0,
      });
      expect(result.maxDollars).toBe(100);
    });

    test("codon gets only what remains after prior spending", () => {
      // Global=100, spent=95, only current codon left
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 95,
      });
      expect(result.maxDollars).toBe(5);
    });

    test("zero remaining budget when fully spent", () => {
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 100,
      });
      expect(result.maxDollars).toBe(0);
    });

    test("overspent global yields zero", () => {
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 120,
      });
      expect(result.maxDollars).toBe(0);
    });

    test("explicit allocationMode 'shared' behaves same as default", () => {
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [{}, {}, {}],
        globalMaxDollars: 100,
        alreadySpent: 0,
        allocationMode: "shared",
      });
      expect(result.maxDollars).toBe(100);
    });
  });

  describe("allocation mode: proportional", () => {
    test("codon with share gets share * globalMaxDollars", () => {
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 0,
        allocationMode: "proportional",
        shares: { "codon-a": 0.3, "codon-b": 0.5 },

        codonConfigId: "codon-a",
      });
      expect(result.maxDollars).toBe(30); // 0.3 * 100
    });

    test("share bounded by global remaining (generous: unspent flows back)", () => {
      // codon-a had share of 0.3 ($30) but only spent $10
      // global remaining = 100 - 10 = 90
      // codon-b share = 0.5 * 100 = $50, bounded by remaining $90 → $50
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 10,
        allocationMode: "proportional",
        shares: { "codon-a": 0.3, "codon-b": 0.5 },

        codonConfigId: "codon-b",
      });
      expect(result.maxDollars).toBe(50);
    });

    test("share bounded by global remaining when pool is low", () => {
      // codon-a had share 0.3 but spent $80 (overspent its share)
      // global remaining = 100 - 80 = 20
      // codon-b share = 0.5 * 100 = $50, bounded by remaining $20 → $20
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 80,
        allocationMode: "proportional",
        shares: { "codon-a": 0.3, "codon-b": 0.5 },

        codonConfigId: "codon-b",
      });
      expect(result.maxDollars).toBe(20);
    });

    test("unshared codon gets uniform share of unallocated remainder", () => {
      // shares: a=0.3, b=0.5 → total shared = 0.8
      // unallocated = 0.2 * 100 = $20
      // codon-c has no share, 1 remaining unshared codon-d → split $20 / 2
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [{ codonConfigId: "codon-d" }],
        globalMaxDollars: 100,
        alreadySpent: 0,
        allocationMode: "proportional",
        shares: { "codon-a": 0.3, "codon-b": 0.5 },

        codonConfigId: "codon-c",
      });
      expect(result.maxDollars).toBeCloseTo(10, 10); // $20 / 2
    });

    test("no shares → equal splits for all codons", () => {
      // No shares map at all → all codons are unshared
      // Unallocated = 100%, 3 remaining + 1 current = 4
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [{ codonConfigId: "b" }, { codonConfigId: "c" }, { codonConfigId: "d" }],
        globalMaxDollars: 100,
        alreadySpent: 0,
        allocationMode: "proportional",

        codonConfigId: "a",
      });
      expect(result.maxDollars).toBe(25); // 100 / 4
    });

    test("explicit codon maxDollars takes precedence over share", () => {
      const result = resolveCodonBudget({
        codon: { maxDollars: 15 },
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 0,
        allocationMode: "proportional",
        shares: { "codon-a": 0.3 },

        codonConfigId: "codon-a",
      });
      expect(result.maxDollars).toBe(15); // explicit takes precedence
    });

    test("codon maxDollars caps (not overrides) share allocation", () => {
      const result = resolveCodonBudget({
        codon: { maxDollars: 5 },
        remainingCodons: [],
        globalMaxDollars: 10,
        alreadySpent: 0,
        allocationMode: "proportional",
        shares: { "codon-a": 0.1 },
        codonConfigId: "codon-a",
      });
      // share allocation = 0.1 * 10 = $1, cap = $5 → should be $1
      expect(result.maxDollars).toBe(1);
    });

    test("shares summing to 1.0 give exact allocations", () => {
      const resultA = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 0,
        allocationMode: "proportional",
        shares: { "codon-a": 0.6, "codon-b": 0.4 },
        codonConfigId: "codon-a",
      });
      expect(resultA.maxDollars).toBe(60);

      const resultB = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 0,
        allocationMode: "proportional",
        shares: { "codon-a": 0.6, "codon-b": 0.4 },
        codonConfigId: "codon-b",
      });
      expect(resultB.maxDollars).toBe(40);
    });

    test("single codon with share=1.0 gets full budget", () => {
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 50,
        alreadySpent: 0,
        allocationMode: "proportional",
        shares: { only: 1.0 },
        codonConfigId: "only",
      });
      expect(result.maxDollars).toBe(50);
    });

    test("shared codons with explicit maxDollars excluded from unshared count", () => {
      // shares: a=0.5 → total shared = 0.5
      // unallocated = 0.5 * 100 = $50
      // remaining: codon-b has maxDollars=10 (excluded from unshared), codon-c unshared
      // current (codon-d) is unshared → 2 unshared codons → $50 / 2 = $25
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [
          { codonConfigId: "codon-b", maxDollars: 10 },
          { codonConfigId: "codon-c" },
        ],
        globalMaxDollars: 100,
        alreadySpent: 0,
        allocationMode: "proportional",
        shares: { "codon-a": 0.5 },

        codonConfigId: "codon-d",
      });
      expect(result.maxDollars).toBe(25);
    });
  });

  describe("allocation mode: proportional-strict", () => {
    test("codon with share gets share * globalMaxDollars", () => {
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 0,
        allocationMode: "proportional-strict",
        shares: { "codon-a": 0.3 },

        codonConfigId: "codon-a",
      });
      expect(result.maxDollars).toBe(30);
    });

    test("unspent budget evaporates (strict remaining)", () => {
      // codon-a had share 0.3 ($30) but only spent $10
      // Strict consumed = $30 (max of share $30, actual $10)
      // Strict remaining = 100 - 30 = $70
      // codon-b share = 0.5 * 100 = $50, bounded by strict remaining $70 → $50
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 10, // actual spend
        allocationMode: "proportional-strict",
        shares: { "codon-a": 0.3, "codon-b": 0.5 },

        codonConfigId: "codon-b",
        strictAlreadyConsumed: 30, // strict: codon-a's full share
      });
      expect(result.maxDollars).toBe(50);
    });

    test("strict remaining limits allocation when multiple shares consumed", () => {
      // codon-a share=0.3 ($30), codon-b share=0.5 ($50)
      // Both completed, strict consumed = 30 + 50 = $80
      // codon-c share = 0.2 * 100 = $20, strict remaining = 100 - 80 = $20 → $20
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 15, // actual: only $15 spent total
        allocationMode: "proportional-strict",
        shares: { "codon-a": 0.3, "codon-b": 0.5, "codon-c": 0.2 },

        codonConfigId: "codon-c",
        strictAlreadyConsumed: 80,
      });
      expect(result.maxDollars).toBe(20);
    });

    test("actual remaining is floor even in strict mode", () => {
      // Edge case: codon-a overspent its share
      // share=0.3 ($30), actual spend=$60
      // strict consumed = max($30, $60) = $60, strict remaining = $40
      // actual remaining = 100 - 60 = $40
      // codon-b share=0.5 → $50, bounded by min(strict=$40, actual=$40) → $40
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 60,
        allocationMode: "proportional-strict",
        shares: { "codon-a": 0.3, "codon-b": 0.5 },

        codonConfigId: "codon-b",
        strictAlreadyConsumed: 60, // max(30, 60) = 60
      });
      expect(result.maxDollars).toBe(40); // bounded by actual remaining
    });

    test("strictAlreadyConsumed falls back to alreadySpent when undefined", () => {
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 10,
        allocationMode: "proportional-strict",
        shares: { "codon-b": 0.5 },

        codonConfigId: "codon-b",
        // strictAlreadyConsumed NOT provided → falls back to alreadySpent
      });
      expect(result.maxDollars).toBe(50); // 0.5*100, bounded by min(90,90)=90, so 50
    });

    test("explicit codon maxDollars takes precedence in strict mode", () => {
      const result = resolveCodonBudget({
        codon: { maxDollars: 15 },
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 0,
        allocationMode: "proportional-strict",
        shares: { "codon-a": 0.3 },

        codonConfigId: "codon-a",
      });
      expect(result.maxDollars).toBe(15);
    });

    test("codon maxDollars caps (not overrides) share allocation in strict mode", () => {
      const result = resolveCodonBudget({
        codon: { maxDollars: 5 },
        remainingCodons: [],
        globalMaxDollars: 10,
        alreadySpent: 0,
        allocationMode: "proportional-strict",
        shares: { "codon-a": 0.1 },
        codonConfigId: "codon-a",
      });
      // share allocation = 0.1 * 10 = $1, cap = $5 → should be $1
      expect(result.maxDollars).toBe(1);
    });

    test("unshared codon gets zero when shares sum to 1.0", () => {
      // shares: a=0.6, b=0.4 → total = 1.0
      // unallocated = (1 - 1.0) * 100 = 0
      // codon-c has no share → uniform share = 0 / 1 = 0
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 0,
        allocationMode: "proportional-strict",
        shares: { "codon-a": 0.6, "codon-b": 0.4 },
        codonConfigId: "codon-c",
      });
      expect(result.maxDollars).toBe(0);
    });

    test("unshared codon in strict mode gets uniform share bounded by strict remaining", () => {
      // shares: a=0.3 → total shared = 0.3
      // unallocated = 0.7 * 100 = $70
      // strict consumed = $30 (codon-a's share)
      // strict remaining = 100 - 30 = $70
      // actual remaining = 100 - 10 = $90
      // current is only unshared codon → uniform share = $70 / 1 = $70
      // bounded by min($70, $90) = $70
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 100,
        alreadySpent: 10,
        allocationMode: "proportional-strict",
        shares: { "codon-a": 0.3 },

        codonConfigId: "codon-b",
        strictAlreadyConsumed: 30,
      });
      expect(result.maxDollars).toBe(70);
    });
  });

  describe("design spec example: proportional allocation with a loop", () => {
    test("$12 hank with proportional shares", () => {
      const shares = { research: 0.15, "dev-loop": 0.7, "final-review": 0.15 };

      // research gets 15% of $12 = $1.80
      const research = resolveCodonBudget({
        codon: {},
        remainingCodons: [{ codonConfigId: "dev-loop" }, { codonConfigId: "final-review" }],
        globalMaxDollars: 12,
        alreadySpent: 0,
        allocationMode: "proportional",
        shares,

        codonConfigId: "research",
      });
      expect(research.maxDollars).toBeCloseTo(1.8, 10);

      // dev-loop gets 70% of $12 = $8.40
      const devLoop = resolveCodonBudget({
        codon: {},
        remainingCodons: [{ codonConfigId: "final-review" }],
        globalMaxDollars: 12,
        alreadySpent: 0.8, // research spent $0.80
        allocationMode: "proportional",
        shares,

        codonConfigId: "dev-loop",
      });
      expect(devLoop.maxDollars).toBeCloseTo(8.4, 10);

      // final-review gets 15% of $12 = $1.80
      const finalReview = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        globalMaxDollars: 12,
        alreadySpent: 0.8 + 3.5, // research + dev-loop
        allocationMode: "proportional",
        shares,

        codonConfigId: "final-review",
      });
      expect(finalReview.maxDollars).toBeCloseTo(1.8, 10);
    });
  });

  describe("duration and output tokens (passthrough)", () => {
    test("passes through maxTimeSeconds from codon config", () => {
      const result = resolveCodonBudget({
        codon: { maxTimeSeconds: 120 },
        remainingCodons: [],
        alreadySpent: 0,
      });
      expect(result.maxTimeSeconds).toBe(120);
    });

    test("passes through maxOutputTokens from codon config", () => {
      const result = resolveCodonBudget({
        codon: { maxOutputTokens: 5000 },
        remainingCodons: [],
        alreadySpent: 0,
      });
      expect(result.maxOutputTokens).toBe(5000);
    });

    test("no duration/token limits when not configured", () => {
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        alreadySpent: 0,
      });
      expect(result.maxTimeSeconds).toBeUndefined();
      expect(result.maxOutputTokens).toBeUndefined();
    });
  });

  describe("hank-level time budget (remainingTimeSeconds)", () => {
    test("codon duration capped by remaining hank time", () => {
      const result = resolveCodonBudget({
        codon: { maxTimeSeconds: 120 },
        remainingCodons: [],
        alreadySpent: 0,
        remainingTimeSeconds: 45,
      });
      expect(result.maxTimeSeconds).toBe(45); // min(120, 45)
    });

    test("codon duration used when less than remaining hank time", () => {
      const result = resolveCodonBudget({
        codon: { maxTimeSeconds: 30 },
        remainingCodons: [],
        alreadySpent: 0,
        remainingTimeSeconds: 120,
      });
      expect(result.maxTimeSeconds).toBe(30); // min(30, 120)
    });

    test("codon without duration gets hank remaining time as limit", () => {
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        alreadySpent: 0,
        remainingTimeSeconds: 60,
      });
      expect(result.maxTimeSeconds).toBe(60);
    });

    test("hank time exhausted yields duration limit of 0", () => {
      const result = resolveCodonBudget({
        codon: { maxTimeSeconds: 120 },
        remainingCodons: [],
        alreadySpent: 0,
        remainingTimeSeconds: -5,
      });
      expect(result.maxTimeSeconds).toBe(0); // max(0, min(120, -5))
    });

    test("hank time exactly zero yields duration limit of 0", () => {
      const result = resolveCodonBudget({
        codon: {},
        remainingCodons: [],
        alreadySpent: 0,
        remainingTimeSeconds: 0,
      });
      expect(result.maxTimeSeconds).toBe(0);
    });

    test("no remainingTimeSeconds means duration is codon-only", () => {
      const result = resolveCodonBudget({
        codon: { maxTimeSeconds: 120 },
        remainingCodons: [],
        alreadySpent: 0,
        // remainingTimeSeconds not set
      });
      expect(result.maxTimeSeconds).toBe(120);
    });
  });
});
