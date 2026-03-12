import { describe, expect, test } from "bun:test";
import type { CodonConfig } from "../../server/config.js";
import { computeBudgetWarnings } from "../../server/config.js";
import { renderBudgetResolutionTable } from "../../server/validate-budget.js";

function makeCodon(
  id: string,
  budget?: {
    maxDollars?: number;
    maxTimeSeconds?: number;
    maxOutputTokens?: number;
    maxContextTokens?: number;
    onExceeded?: "complete" | "fail";
  },
  modelName = "Haiku",
): CodonConfig {
  return {
    type: "codon",
    id,
    name: id,
    model: {
      modelId: "haiku",
      name: modelName,
      providerId: "anthropic",
      cost: { input: 0.25, output: 1.25 },
      // biome-ignore lint/suspicious/noExplicitAny: test helper
    } as any,
    continuationMode: "fresh",
    budget,
  } as CodonConfig;
}

function makeLoop(
  id: string,
  codons: CodonConfig[],
  budget?: {
    maxDollars?: number;
    maxTimeSeconds?: number;
    allocation?: "shared" | "proportional" | "proportional-strict";
    shares?: Record<string, number>;
    onExceeded?: "complete" | "fail";
  },
): CodonConfig {
  return {
    type: "loop",
    id,
    name: id,
    terminateOn: { type: "iterationLimit", limit: 3 },
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    codons: codons as any,
    budget,
  } as CodonConfig;
}

// ─── Warning Tests ───────────────────────────────────────────

describe("computeBudgetWarnings", () => {
  test("no budget config → no warnings", () => {
    const codons = [makeCodon("a"), makeCodon("b")];
    expect(computeBudgetWarnings(undefined, codons)).toEqual([]);
  });

  test("codon cap > share allocation → warning", () => {
    const codons = [makeCodon("a", { maxDollars: 5.0 }), makeCodon("b")];
    const hankBudget = {
      maxDollars: 10.0,
      allocation: "proportional" as const,
      shares: { a: 0.1 },
    };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("'a'");
    expect(warnings[0]).toContain("cap will never be reached");
  });

  test("codon cap < share allocation → no warning", () => {
    const codons = [makeCodon("a", { maxDollars: 0.5 }), makeCodon("b")];
    const hankBudget = {
      maxDollars: 10.0,
      allocation: "proportional" as const,
      shares: { a: 0.5 },
    };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.length).toBe(0);
  });

  test("loop maxDollars > hank share → warning", () => {
    const loop = makeLoop("my-loop", [makeCodon("x")], { maxDollars: 8.0 });
    const codons = [makeCodon("a"), loop];
    const hankBudget = {
      maxDollars: 10.0,
      allocation: "proportional" as const,
      shares: { "my-loop": 0.3 },
    };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("'my-loop'");
    expect(warnings[0]).toContain("cap will never be reached");
  });

  test("unallocated budget, no unshared codons → warning", () => {
    const codons = [makeCodon("a"), makeCodon("b")];
    const hankBudget = {
      maxDollars: 10.0,
      allocation: "proportional" as const,
      shares: { a: 0.3, b: 0.3 },
    };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("40%");
    expect(warnings[0]).toContain("unallocated");
  });

  test("unallocated budget, unshared codons present → no warning", () => {
    const codons = [makeCodon("a"), makeCodon("b"), makeCodon("c")];
    const hankBudget = {
      maxDollars: 10.0,
      allocation: "proportional" as const,
      shares: { a: 0.3, b: 0.3 },
    };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.length).toBe(0);
  });

  test("loop-scoped: child cap > loop share → warning", () => {
    const loop = makeLoop("my-loop", [makeCodon("x", { maxDollars: 5.0 }), makeCodon("y")], {
      maxDollars: 10.0,
      allocation: "proportional",
      shares: { x: 0.1 },
    });
    const codons = [loop];
    const warnings = computeBudgetWarnings(undefined, codons);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("'x'");
    expect(warnings[0]).toContain("loop 'my-loop'");
  });

  test("shared allocation → no proportional warnings", () => {
    const codons = [makeCodon("a", { maxDollars: 50.0 }), makeCodon("b")];
    const hankBudget = { maxDollars: 10.0 };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.length).toBe(0);
  });

  test("W7: zero effective budget — codon with no share when shares sum to 100%", () => {
    const codons = [makeCodon("a"), makeCodon("b"), makeCodon("orphan")];
    const hankBudget = {
      maxDollars: 10.0,
      allocation: "proportional" as const,
      shares: { a: 0.5, b: 0.5 },
    };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.some((w) => w.includes("orphan") && w.includes("$0 budget"))).toBe(true);
  });

  test("W7: no warning when shares < 100% (unshared codons get remainder)", () => {
    const codons = [makeCodon("a"), makeCodon("b"), makeCodon("c")];
    const hankBudget = {
      maxDollars: 10.0,
      allocation: "proportional" as const,
      shares: { a: 0.3, b: 0.3 },
    };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.some((w) => w.includes("$0 budget"))).toBe(false);
  });

  test("W8: onExceeded fail + onFailure retry → warning", () => {
    const codon = {
      ...makeCodon("risky", { onExceeded: "fail" as const }),
      onFailure: "retry",
    } as CodonConfig;
    const codons = [codon];
    const hankBudget = { maxDollars: 10.0 };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.some((w) => w.includes("risky") && w.includes("retry"))).toBe(true);
  });

  test("W8: no warning when onExceeded is complete", () => {
    const codon = {
      ...makeCodon("safe"),
      onFailure: "retry",
    } as CodonConfig;
    const codons = [codon];
    const hankBudget = { maxDollars: 10.0 };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.some((w) => w.includes("retry") && w.includes("Budget-exceeded"))).toBe(false);
  });

  test("W9: fail-policy codon late in shared pool → warning", () => {
    const codons = [makeCodon("first"), makeCodon("second", { onExceeded: "fail" as const })];
    const hankBudget = { maxDollars: 10.0 };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.some((w) => w.includes("second") && w.includes("not first"))).toBe(true);
  });

  test("W9: no warning when fail-policy codon is first", () => {
    const codons = [makeCodon("first", { onExceeded: "fail" as const }), makeCodon("second")];
    const hankBudget = { maxDollars: 10.0 };
    const warnings = computeBudgetWarnings(hankBudget, codons);
    expect(warnings.some((w) => w.includes("not first"))).toBe(false);
  });

  test("W10: codon time cap > loop time cap → warning", () => {
    const loop = makeLoop("my-loop", [makeCodon("slow", { maxTimeSeconds: 600 })], {
      maxTimeSeconds: 300,
    });
    const codons = [loop];
    const warnings = computeBudgetWarnings(undefined, codons);
    expect(warnings.some((w) => w.includes("slow") && w.includes("300s"))).toBe(true);
  });

  test("W10: no warning when codon time cap ≤ loop time cap", () => {
    const loop = makeLoop("my-loop", [makeCodon("fast", { maxTimeSeconds: 100 })], {
      maxTimeSeconds: 300,
    });
    const codons = [loop];
    const warnings = computeBudgetWarnings(undefined, codons);
    expect(warnings.some((w) => w.includes("fast") && w.includes("never be reached"))).toBe(false);
  });
});

// ─── Table Rendering Tests ───────────────────────────────────

describe("renderBudgetResolutionTable", () => {
  test("shared mode with maxDollars → shows shared pool and model", () => {
    const codons = [makeCodon("a"), makeCodon("b")];
    const result = renderBudgetResolutionTable({
      hankBudget: { maxDollars: 10.0 },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("Budget");
    expect(result).toContain("$10.00");
    expect(result).toContain("shared sequentially");
    expect(result).toContain("shared pool");
    expect(result).toContain("Model");
    expect(result).toContain("Haiku");
    expect(result).toContain("Max Dollars");
  });

  test("proportional mode with shares → shows percentage of total", () => {
    const codons = [makeCodon("planning"), makeCodon("execution")];
    const result = renderBudgetResolutionTable({
      hankBudget: {
        maxDollars: 10.0,
        allocation: "proportional",
        shares: { planning: 0.2, execution: 0.8 },
      },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("$2.00");
    expect(result).toContain("20% of $10.00");
    expect(result).toContain("$8.00");
    expect(result).toContain("80% of $10.00");
    expect(result).toContain("proportional (unspent flows to later codons)");
  });

  test("proportional with codon cap < share → shows cap annotation", () => {
    const codons = [makeCodon("big", { maxDollars: 2.0 }), makeCodon("small")];
    const result = renderBudgetResolutionTable({
      hankBudget: {
        maxDollars: 10.0,
        allocation: "proportional",
        shares: { big: 0.6 },
      },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("$2.00");
    expect(result).toContain("codon cap");
    expect(result).toContain("share was $6.00");
    expect(result).toContain("uniform");
  });

  test("uniform allocation for unshared codons", () => {
    const codons = [makeCodon("a"), makeCodon("b"), makeCodon("c")];
    const result = renderBudgetResolutionTable({
      hankBudget: {
        maxDollars: 9.0,
        allocation: "proportional",
        shares: {},
      },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("$3.00");
    expect(result).toContain("uniform");
  });

  test("loop with own budget → shows loop row and indented children", () => {
    const loop = makeLoop("dev-loop", [makeCodon("impl"), makeCodon("test")], {
      maxDollars: 5.0,
      maxTimeSeconds: 600,
    });
    const codons = [makeCodon("plan"), loop];
    const result = renderBudgetResolutionTable({
      hankBudget: { maxDollars: 10.0 },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("dev-loop");
    expect(result).toContain("600s");
    expect(result).toContain("├─ impl");
    expect(result).toContain("└─ test");
    expect(result).toContain("loop budget");
  });

  test("proportional: loop maxDollars clamped by proportional hank allocation", () => {
    const loop = makeLoop("dev-loop", [makeCodon("impl"), makeCodon("test")], {
      maxDollars: 8.0,
    });
    const codons = [makeCodon("other"), loop];
    const result = renderBudgetResolutionTable({
      hankBudget: {
        maxDollars: 10.0,
        allocation: "proportional",
        shares: { "dev-loop": 0.2 },
      },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    // 20% of $10 = $2.00 allocation, loop declared $8.00 → capped to $2.00
    expect(result).toContain("$2.00");
    expect(result).toContain("capped by hank");
    // The loop row itself should show capped value, not the raw $8.00 loop budget
    expect(result).toContain("$2.00 (loop, capped by hank)");
    expect(result).not.toContain("$8.00 (loop");
  });

  test("proportional: no-share codon with maxDollars gets min(cap, global) not uniform", () => {
    const codons = [makeCodon("a"), makeCodon("b", { maxDollars: 9.0 })];
    const result = renderBudgetResolutionTable({
      hankBudget: {
        maxDollars: 10.0,
        allocation: "proportional",
        shares: { a: 0.2 },
      },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("$9.00");
    expect(result).toContain("codon cap");
    expect(result).not.toContain("$8.00");
  });

  test("no hank budget, only codon caps → shows 'No global budget' and individual caps", () => {
    const codons = [
      makeCodon("a", { maxDollars: 2.0 }),
      makeCodon("b", { maxTimeSeconds: 300 }),
      makeCodon("c", { maxOutputTokens: 5000 }),
    ];
    const result = renderBudgetResolutionTable({
      hankBudget: {},
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("No global budget");
    expect(result).toContain("Per-codon limits only");
    expect(result).not.toContain("Ceiling:");
    expect(result).not.toContain("Allocation:");
    expect(result).toContain("$2.00");
    expect(result).toContain("codon cap");
    expect(result).toContain("300s");
    expect(result).toContain("5000");
  });

  test("sub-cent budget displays with 4 decimal places", () => {
    const codons = [makeCodon("a", { maxDollars: 0.0001 }), makeCodon("b")];
    const result = renderBudgetResolutionTable({
      hankBudget: {},
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("$0.0001");
    expect(result).not.toContain("$0.00 ");
  });

  test("no global budget with loop → shows 'Loop and codon limits only'", () => {
    const loop = makeLoop("my-loop", [makeCodon("x")], { maxDollars: 5.0 });
    const codons = [makeCodon("a"), loop];
    const result = renderBudgetResolutionTable({
      hankBudget: {},
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("No global budget");
    expect(result).toContain("Loop and codon limits only");
  });

  test("color disabled → no ANSI codes in output", () => {
    const codons = [makeCodon("a")];
    const result = renderBudgetResolutionTable({
      hankBudget: { maxDollars: 5.0 },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    // biome-ignore lint/suspicious/noControlCharactersInRegex: testing ANSI escape removal
    expect(result).not.toMatch(/\x1b\[/);
  });

  test("onExceeded: fail shown per-codon as '⚠ fails run'", () => {
    const codons = [makeCodon("a", { onExceeded: "fail" })];
    const result = renderBudgetResolutionTable({
      hankBudget: { maxDollars: 5.0 },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("⚠ fails run");
  });

  test("shared mode: codon cap clamped to hank ceiling", () => {
    const codons = [makeCodon("a", { maxDollars: 20.0 }), makeCodon("b")];
    const result = renderBudgetResolutionTable({
      hankBudget: { maxDollars: 10.0 },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("$10.00");
    expect(result).toContain("codon cap");
    expect(result).not.toContain("$20.00");
  });

  test("time shown at hank level", () => {
    const codons = [makeCodon("a")];
    const result = renderBudgetResolutionTable({
      hankBudget: { maxTimeSeconds: 3600 },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("3600s");
    expect(result).toContain("(hank)");
  });

  test("multi-source ceiling: CLI overrides hank", () => {
    const codons = [makeCodon("a")];
    const result = renderBudgetResolutionTable({
      hankBudget: { maxDollars: 15.0 },
      codons,
      terminalWidth: 80,
      useColor: false,
      resolvedCeiling: { maxDollars: 5.0 },
    });

    expect(result).toContain("$5.00");
    expect(result).toContain("hank wanted $15.00");
  });

  test("shared mode footer appears with global budget", () => {
    const codons = [makeCodon("a"), makeCodon("b")];
    const result = renderBudgetResolutionTable({
      hankBudget: { maxDollars: 10.0 },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("Shared pool: codons run in order");
    expect(result).toContain("remainder passes to the next");
  });

  test("shared mode footer does NOT appear without global budget", () => {
    const codons = [makeCodon("a", { maxDollars: 1.0 })];
    const result = renderBudgetResolutionTable({
      hankBudget: {},
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).not.toContain("Shared pool:");
  });

  test("empty columns are hidden", () => {
    const codons = [makeCodon("a", { maxDollars: 1.0 })];
    const result = renderBudgetResolutionTable({
      hankBudget: {},
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).not.toContain("Max Time");
    expect(result).not.toContain("Max Tokens");
    expect(result).toContain("Max Dollars");
  });

  test("model name appears in codon rows", () => {
    const codons = [
      makeCodon("analyze", { maxDollars: 5.0 }, "Opus"),
      makeCodon("review", undefined, "Haiku"),
    ];
    const result = renderBudgetResolutionTable({
      hankBudget: { maxDollars: 10.0 },
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("Opus");
    expect(result).toContain("Haiku");
  });

  test("(no limit) shown for codons without budget in no-global mode", () => {
    const codons = [makeCodon("a", { maxDollars: 1.0 }), makeCodon("b")];
    const result = renderBudgetResolutionTable({
      hankBudget: {},
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("(no limit)");
  });

  test("maxContextTokens only → shows tokens column with ctx cap", () => {
    const codons = [makeCodon("a", { maxContextTokens: 100000 })];
    const result = renderBudgetResolutionTable({
      hankBudget: {},
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("Max Tokens");
    expect(result).toContain("100000");
    expect(result).toContain("(ctx cap)");
  });

  test("maxOutputTokens only → shows tokens column with output cap", () => {
    const codons = [makeCodon("a", { maxOutputTokens: 5000 })];
    const result = renderBudgetResolutionTable({
      hankBudget: {},
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("Max Tokens");
    expect(result).toContain("5000");
    expect(result).toContain("(output cap)");
  });

  test("both maxOutputTokens and maxContextTokens → shows both values", () => {
    const codons = [makeCodon("a", { maxOutputTokens: 5000, maxContextTokens: 100000 })];
    const result = renderBudgetResolutionTable({
      hankBudget: {},
      codons,
      terminalWidth: 80,
      useColor: false,
    });

    expect(result).toContain("Max Tokens");
    expect(result).toContain("out:5000");
    expect(result).toContain("ctx:100000");
  });
});
