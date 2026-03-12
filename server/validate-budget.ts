// server/validate-budget.ts
// Budget resolution table for --validate display

import type { CodonConfig } from "./config.js";
import type {
  AllocationMode,
  BudgetSummaryData,
  CodonBudgetSummaryRow,
  OnExceededPolicy,
} from "./types/budget-types.js";

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Adaptive dollar formatting: 4 decimals for sub-cent values, 2 for the rest. */
function fmtDollars(value: number): string {
  return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

interface ContainerBudget {
  maxDollars?: number;
  maxTimeSeconds?: number;
  allocation?: AllocationMode;
  shares?: Record<string, number>;
  onExceeded?: OnExceededPolicy;
}

export interface BudgetDisplayParams {
  hankBudget: ContainerBudget;
  codons: CodonConfig[];
  terminalWidth: number;
  useColor: boolean;
  resolvedCeiling?: { maxDollars?: number; maxTimeSeconds?: number };
}

function cc(useColor: boolean, color: string, text: string): string {
  return useColor ? `${color}${text}${COLORS.reset}` : text;
}

function computeCeilingSource(hankValue?: number, resolvedValue?: number): string {
  if (resolvedValue === undefined) return "(hank)";
  if (hankValue === undefined) return "(runtime/cli)";
  if (resolvedValue === hankValue) return "(hank)";
  if (resolvedValue < hankValue) return `(--max-cost, hank wanted ${fmtDollars(hankValue)})`;
  return "(hank)";
}

function computeTimeCeilingSource(hankValue?: number, resolvedValue?: number): string {
  if (resolvedValue === undefined) return "(hank)";
  if (hankValue === undefined) return "(runtime/cli)";
  if (resolvedValue === hankValue) return "(hank)";
  if (resolvedValue < hankValue) return `(--max-time, hank wanted ${hankValue}s)`;
  return "(hank)";
}

function getAllocationLabel(mode?: AllocationMode): string {
  switch (mode) {
    case "proportional":
      return "proportional (unspent flows to later codons)";
    case "proportional-strict":
      return "proportional-strict (unspent evaporates)";
    default:
      return "shared sequentially";
  }
}

function computeHankAllocationForLoop(
  loopId: string,
  hankBudget: ContainerBudget,
  siblings: CodonConfig[],
): number | undefined {
  const hankMax = hankBudget.maxDollars;
  if (hankMax === undefined) return undefined;

  const mode = hankBudget.allocation ?? "shared";
  if (mode === "shared") return hankMax;

  // Proportional modes: look up share
  const shares = hankBudget.shares;
  if (shares && loopId in shares) {
    return shares[loopId] * hankMax;
  }

  // No explicit share → uniform split of unallocated remainder
  const totalShared = shares ? Object.values(shares).reduce((a, b) => a + b, 0) : 0;
  const unallocatedPool = Math.max(0, 1 - totalShared) * hankMax;
  const unsharedCount = siblings.filter((cfg) => {
    const hasShare = shares && cfg.id in shares;
    const hasExplicit = cfg.type !== "loop" ? cfg.budget?.maxDollars !== undefined : false;
    return !hasShare && !hasExplicit;
  }).length;
  return unsharedCount > 0 ? unallocatedPool / unsharedCount : unallocatedPool;
}

function computeLoopEffectiveContainer(
  loopBudget: ContainerBudget,
  loopId: string,
  hankBudget: ContainerBudget,
  topLevelCodons: CodonConfig[],
): ContainerBudget {
  if (loopBudget.maxDollars !== undefined) return loopBudget;

  const effectiveMaxDollars = computeHankAllocationForLoop(loopId, hankBudget, topLevelCodons);
  if (effectiveMaxDollars === undefined) return loopBudget;

  return { ...loopBudget, maxDollars: effectiveMaxDollars };
}

// ---------------------------------------------------------------------------
// Per-cell formatters
// ---------------------------------------------------------------------------

function formatDollarsCell(
  codonId: string,
  codonBudget: { maxDollars?: number } | undefined,
  containerBudget: ContainerBudget,
  siblings: CodonConfig[],
  useColor: boolean,
): string {
  const mode = containerBudget.allocation ?? "shared";
  const shares = containerBudget.shares;
  const globalMax = containerBudget.maxDollars;

  if (!globalMax && !codonBudget?.maxDollars) return cc(useColor, COLORS.dim, "(no limit)");

  if (mode === "shared") {
    if (codonBudget?.maxDollars) {
      const effective = globalMax
        ? Math.min(codonBudget.maxDollars, globalMax)
        : codonBudget.maxDollars;
      return `${cc(useColor, COLORS.green, fmtDollars(effective))} ${cc(useColor, COLORS.dim, "(codon cap)")}`;
    }
    if (globalMax) {
      return `${cc(useColor, COLORS.dim, "≤")} ${cc(useColor, COLORS.green, fmtDollars(globalMax))} ${cc(useColor, COLORS.dim, "(shared pool)")}`;
    }
    return cc(useColor, COLORS.dim, "(no limit)");
  }

  // Proportional modes
  const share = shares?.[codonId];
  if (share !== undefined && globalMax) {
    const allocation = share * globalMax;
    const pct = `${(share * 100).toFixed(0)}%`;
    const shareLabel = `(${pct} of ${fmtDollars(globalMax)})`;

    if (codonBudget?.maxDollars !== undefined && codonBudget.maxDollars < allocation) {
      return `${cc(useColor, COLORS.green, fmtDollars(codonBudget.maxDollars))} ${cc(useColor, COLORS.dim, `(codon cap, share was ${fmtDollars(allocation)})`)}`;
    }
    return `${cc(useColor, COLORS.green, fmtDollars(allocation))} ${cc(useColor, COLORS.dim, shareLabel)}`;
  }

  if (codonBudget?.maxDollars !== undefined) {
    const effective = globalMax
      ? Math.min(codonBudget.maxDollars, globalMax)
      : codonBudget.maxDollars;
    return `${cc(useColor, COLORS.green, fmtDollars(effective))} ${cc(useColor, COLORS.dim, "(codon cap)")}`;
  }

  if (globalMax) {
    const totalShared = shares ? Object.values(shares).reduce((a, b) => a + b, 0) : 0;
    const unallocatedPool = Math.max(0, 1 - totalShared) * globalMax;
    const unsharedCount = siblings.filter((s) => {
      const hasShare = shares && s.id in shares;
      const hasExplicit = s.type !== "loop" ? s.budget?.maxDollars !== undefined : false;
      return !hasShare && !hasExplicit;
    }).length;

    if (unsharedCount > 0) {
      const uniformAmt = unallocatedPool / unsharedCount;
      return `${cc(useColor, COLORS.green, fmtDollars(uniformAmt))} ${cc(useColor, COLORS.dim, "(uniform)")}`;
    }
  }

  return cc(useColor, COLORS.dim, "(no limit)");
}

function formatLoopDollarsCell(
  loopId: string,
  loopBudget: ContainerBudget,
  hankBudget: ContainerBudget,
  siblings: CodonConfig[],
  useColor: boolean,
): string {
  // If the loop has its own maxDollars, show it as a loop budget
  if (loopBudget.maxDollars !== undefined) {
    const hankAllocation = computeHankAllocationForLoop(loopId, hankBudget, siblings);
    if (hankAllocation !== undefined) {
      const capped = Math.min(loopBudget.maxDollars, hankAllocation);
      if (capped < loopBudget.maxDollars) {
        return `${cc(useColor, COLORS.green, fmtDollars(capped))} ${cc(useColor, COLORS.dim, "(loop, capped by hank)")}`;
      }
    }
    return `${cc(useColor, COLORS.green, fmtDollars(loopBudget.maxDollars))} ${cc(useColor, COLORS.dim, "(loop budget)")}`;
  }

  // Delegate to the regular formatter for the loop as a child of the hank
  return formatDollarsCell(loopId, loopBudget, hankBudget, siblings, useColor);
}

function formatTimeCell(
  codonBudget: { maxTimeSeconds?: number } | undefined,
  isLoopChild: boolean,
  loopHasTime: boolean,
  useColor: boolean,
): string {
  if (codonBudget?.maxTimeSeconds) {
    return `${codonBudget.maxTimeSeconds}s ${cc(useColor, COLORS.dim, "(cap)")}`;
  }
  if (isLoopChild && loopHasTime) {
    return cc(useColor, COLORS.dim, "≤ loop time");
  }
  return cc(useColor, COLORS.dim, "—");
}

function formatTokensCell(
  codonBudget: { maxOutputTokens?: number; maxContextTokens?: number } | undefined,
  useColor: boolean,
): string {
  const hasOutput = codonBudget?.maxOutputTokens !== undefined;
  const hasContext = codonBudget?.maxContextTokens !== undefined;
  if (hasOutput && hasContext) {
    return `out:${codonBudget?.maxOutputTokens} ctx:${codonBudget?.maxContextTokens}`;
  }
  if (hasOutput) {
    return `${codonBudget?.maxOutputTokens} ${cc(useColor, COLORS.dim, "(output cap)")}`;
  }
  if (hasContext) {
    return `${codonBudget?.maxContextTokens} ${cc(useColor, COLORS.dim, "(ctx cap)")}`;
  }
  return cc(useColor, COLORS.dim, "—");
}

function formatLoopTimeCell(loopBudget: ContainerBudget | undefined, useColor: boolean): string {
  if (loopBudget?.maxTimeSeconds) {
    return `${loopBudget.maxTimeSeconds}s ${cc(useColor, COLORS.dim, "(loop)")}`;
  }
  return cc(useColor, COLORS.dim, "—");
}

function formatOnExceededCell(
  codonBudget: { onExceeded?: OnExceededPolicy } | undefined,
  containerDefault: OnExceededPolicy | undefined,
  useColor: boolean,
): string {
  const effective = codonBudget?.onExceeded ?? containerDefault ?? "complete";
  if (effective === "fail") {
    return cc(useColor, COLORS.yellow, "⚠ fails run");
  }
  return cc(useColor, COLORS.dim, "completes");
}

function getModelName(config: CodonConfig): string {
  if (config.type === "loop") return "";
  return config.model?.name ?? "";
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  if (maxLen < 4) return str.slice(0, maxLen);
  return `${str.slice(0, maxLen - 1)}\u2026`;
}

function padTo(str: string, width: number): string {
  const vis = stripAnsi(str).length;
  if (vis >= width) return str;
  return str + " ".repeat(width - vis);
}

// ---------------------------------------------------------------------------
// Column visibility scan
// ---------------------------------------------------------------------------

interface ColumnVisibility {
  dollars: boolean;
  time: boolean;
  tokens: boolean;
  onExceeded: boolean;
}

function scanColumnVisibility(
  codons: CodonConfig[],
  hankBudget: ContainerBudget,
): ColumnVisibility {
  let hasDollars = hankBudget.maxDollars !== undefined;
  let hasTime = hankBudget.maxTimeSeconds !== undefined;
  let hasTokens = false;
  let hasOnExceeded = false;
  const defaultPolicy = hankBudget.onExceeded ?? "complete";

  for (const cfg of codons) {
    if (cfg.type === "loop") {
      if (cfg.budget?.maxDollars !== undefined) hasDollars = true;
      if (cfg.budget?.maxTimeSeconds !== undefined) hasTime = true;
      if (cfg.budget?.onExceeded && cfg.budget.onExceeded !== defaultPolicy) hasOnExceeded = true;
      for (const child of cfg.codons) {
        if (child.budget?.maxDollars !== undefined) hasDollars = true;
        if (child.budget?.maxTimeSeconds !== undefined) hasTime = true;
        if (child.budget?.maxOutputTokens !== undefined) hasTokens = true;
        if (child.budget?.maxContextTokens !== undefined) hasTokens = true;
        if (child.budget?.onExceeded === "fail") hasOnExceeded = true;
      }
    } else {
      if (cfg.budget?.maxDollars !== undefined) hasDollars = true;
      if (cfg.budget?.maxTimeSeconds !== undefined) hasTime = true;
      if (cfg.budget?.maxOutputTokens !== undefined) hasTokens = true;
      if (cfg.budget?.maxContextTokens !== undefined) hasTokens = true;
      if (cfg.budget?.onExceeded === "fail") hasOnExceeded = true;
    }
  }

  // Always show onExceeded if any codon has fail policy, or if there's a budget active
  if (hasDollars || hasTime || hasTokens) hasOnExceeded = true;

  return {
    dollars: hasDollars,
    time: hasTime,
    tokens: hasTokens,
    onExceeded: hasOnExceeded,
  };
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

export function renderBudgetResolutionTable(params: BudgetDisplayParams): string {
  const { hankBudget, codons, terminalWidth, useColor, resolvedCeiling } = params;
  const lines: string[] = [];
  const lineWidth = Math.min(65, terminalWidth - 2);

  const effectiveBudget: ContainerBudget = resolvedCeiling
    ? {
        ...hankBudget,
        maxDollars: resolvedCeiling.maxDollars ?? hankBudget.maxDollars,
        maxTimeSeconds: resolvedCeiling.maxTimeSeconds ?? hankBudget.maxTimeSeconds,
      }
    : hankBudget;

  // Title
  lines.push("");
  lines.push(cc(useColor, COLORS.cyan + COLORS.bold, "Budget"));
  lines.push(cc(useColor, COLORS.dim, "─".repeat(lineWidth)));

  // Summary section
  const hasGlobalCeiling =
    effectiveBudget.maxDollars !== undefined || effectiveBudget.maxTimeSeconds !== undefined;

  if (hasGlobalCeiling) {
    if (effectiveBudget.maxDollars !== undefined) {
      const source = computeCeilingSource(hankBudget.maxDollars, resolvedCeiling?.maxDollars);
      lines.push(
        `  Global ceiling:  ${cc(useColor, COLORS.green, fmtDollars(effectiveBudget.maxDollars))} ${cc(useColor, COLORS.dim, source)}`,
      );
    }
    if (effectiveBudget.maxTimeSeconds !== undefined) {
      const source = computeTimeCeilingSource(
        hankBudget.maxTimeSeconds,
        resolvedCeiling?.maxTimeSeconds,
      );
      lines.push(
        `  Time limit:      ${effectiveBudget.maxTimeSeconds}s ${cc(useColor, COLORS.dim, source)}`,
      );
    }
    lines.push(`  Allocation:      ${getAllocationLabel(hankBudget.allocation)}`);
  } else {
    const hasLoopBudget = codons.some(
      (cfg) => cfg.type === "loop" && (cfg.budget?.maxDollars || cfg.budget?.maxTimeSeconds),
    );
    const scopeLabel = hasLoopBudget ? "Loop and codon limits only." : "Per-codon limits only.";
    lines.push(`  ${cc(useColor, COLORS.dim, `No global budget. ${scopeLabel}`)}`);
  }

  lines.push("");

  // Determine which columns to show
  const vis = scanColumnVisibility(codons, effectiveBudget);

  // Column widths
  const MAX_NAME = 24;
  const MIN_NAME = 16;
  let maxNameLen = MIN_NAME;
  for (const config of codons) {
    const nameLen = Math.min(config.id.length, MAX_NAME);
    if (nameLen > maxNameLen) maxNameLen = nameLen;
    if (config.type === "loop") {
      for (const codon of config.codons) {
        const childLen = Math.min(5 + codon.id.length, 5 + MAX_NAME);
        if (childLen > maxNameLen) maxNameLen = childLen;
      }
    }
  }
  const COL_NAME = maxNameLen + 2;
  const COL_MODEL = 12;
  const COL_DOLLARS = 34;
  const COL_TIME = 18;
  const COL_TOKENS = 20;

  // Column headers
  let header = `  ${padTo(cc(useColor, COLORS.dim, "Codon"), COL_NAME)}`;
  header += padTo(cc(useColor, COLORS.dim, "Model"), COL_MODEL);
  if (vis.dollars) header += padTo(cc(useColor, COLORS.dim, "Max Dollars"), COL_DOLLARS);
  if (vis.time) header += padTo(cc(useColor, COLORS.dim, "Max Time"), COL_TIME);
  if (vis.tokens) header += padTo(cc(useColor, COLORS.dim, "Max Tokens"), COL_TOKENS);
  if (vis.onExceeded) header += cc(useColor, COLORS.dim, "On exceeded");
  lines.push(header);

  let separator = `  ${padTo(cc(useColor, COLORS.dim, "─────"), COL_NAME)}`;
  separator += padTo(cc(useColor, COLORS.dim, "─────"), COL_MODEL);
  if (vis.dollars) separator += padTo(cc(useColor, COLORS.dim, "───────────"), COL_DOLLARS);
  if (vis.time) separator += padTo(cc(useColor, COLORS.dim, "────────"), COL_TIME);
  if (vis.tokens) separator += padTo(cc(useColor, COLORS.dim, "────────"), COL_TOKENS);
  if (vis.onExceeded) separator += cc(useColor, COLORS.dim, "───────────");
  lines.push(separator);

  const containerOnExceeded = effectiveBudget.onExceeded;

  // Per-codon rows
  for (const config of codons) {
    if (config.type === "loop") {
      const loopBudget: ContainerBudget = config.budget ?? {};
      const loopDollars = formatLoopDollarsCell(
        config.id,
        loopBudget,
        effectiveBudget,
        codons,
        useColor,
      );
      const loopTime = formatLoopTimeCell(loopBudget, useColor);

      let loopRow = `  ${padTo(cc(useColor, COLORS.bold, truncate(config.id, MAX_NAME)), COL_NAME)}`;
      loopRow += padTo("", COL_MODEL);
      if (vis.dollars) loopRow += padTo(loopDollars, COL_DOLLARS);
      if (vis.time) loopRow += padTo(loopTime, COL_TIME);
      if (vis.tokens) loopRow += padTo(cc(useColor, COLORS.dim, "—"), COL_TOKENS);
      // No onExceeded for loop row
      lines.push(loopRow);

      const loopHasTime = loopBudget.maxTimeSeconds !== undefined;
      const childContainer = computeLoopEffectiveContainer(
        loopBudget,
        config.id,
        effectiveBudget,
        codons,
      );
      const loopOnExceeded = loopBudget.onExceeded ?? containerOnExceeded;

      for (const [i, codon] of config.codons.entries()) {
        const isLast = i === config.codons.length - 1;
        const prefix = isLast ? "  └─ " : "  ├─ ";
        const name = `${prefix}${truncate(codon.id, MAX_NAME)}`;
        const modelName = truncate(codon.model?.name ?? "", 10);

        const dollars = formatDollarsCell(
          codon.id,
          codon.budget,
          childContainer,
          config.codons as CodonConfig[],
          useColor,
        );
        const time = formatTimeCell(codon.budget, true, loopHasTime, useColor);
        const tokens = formatTokensCell(codon.budget, useColor);
        const exceeded = formatOnExceededCell(codon.budget, loopOnExceeded, useColor);

        let row = `  ${padTo(name, COL_NAME)}`;
        row += padTo(cc(useColor, COLORS.dim, modelName), COL_MODEL);
        if (vis.dollars) row += padTo(dollars, COL_DOLLARS);
        if (vis.time) row += padTo(time, COL_TIME);
        if (vis.tokens) row += padTo(tokens, COL_TOKENS);
        if (vis.onExceeded) row += exceeded;
        lines.push(row);
      }
    } else {
      const modelName = truncate(getModelName(config), 10);
      const dollars = formatDollarsCell(
        config.id,
        config.budget,
        effectiveBudget,
        codons,
        useColor,
      );
      const time = formatTimeCell(config.budget, false, false, useColor);
      const tokens = formatTokensCell(config.budget, useColor);
      const exceeded = formatOnExceededCell(config.budget, containerOnExceeded, useColor);

      let row = `  ${padTo(truncate(config.id, MAX_NAME), COL_NAME)}`;
      row += padTo(cc(useColor, COLORS.dim, modelName), COL_MODEL);
      if (vis.dollars) row += padTo(dollars, COL_DOLLARS);
      if (vis.time) row += padTo(time, COL_TIME);
      if (vis.tokens) row += padTo(tokens, COL_TOKENS);
      if (vis.onExceeded) row += exceeded;
      lines.push(row);
    }
  }

  // Footer: shared mode explanation
  const effectiveMode = effectiveBudget.allocation ?? "shared";
  if (hasGlobalCeiling && effectiveMode === "shared") {
    lines.push("");
    lines.push(
      `  ${cc(useColor, COLORS.dim, "Shared pool: codons run in order. Each uses what it needs;")}`,
    );
    lines.push(`  ${cc(useColor, COLORS.dim, "the remainder passes to the next.")}`);
  }

  return lines.join("\n");
}

// =============================================================================
// End-of-run budget summary table
// =============================================================================

export interface BudgetSummaryDisplayParams {
  summary: BudgetSummaryData;
  terminalWidth: number;
  useColor: boolean;
  showCosts: boolean;
}

function formatStatus(status: CodonBudgetSummaryRow["status"], useColor: boolean): string {
  switch (status) {
    case "completed":
      return cc(useColor, COLORS.green, "completed");
    case "exceeded":
      return cc(useColor, "\x1b[33m", "exceeded");
    case "failed":
      return cc(useColor, "\x1b[31m", "failed");
    case "skipped":
      return cc(useColor, COLORS.dim, "skipped");
    case "running":
      return cc(useColor, COLORS.dim, "running");
  }
}

function formatActualVsBudget(
  actual: number,
  budget: number | undefined,
  formatFn: (n: number) => string,
  useColor: boolean,
): string {
  if (budget === undefined) return formatFn(actual);
  const over = actual >= budget;
  const color = over ? "\x1b[33m" : COLORS.green;
  return `${cc(useColor, color, formatFn(actual))} ${cc(useColor, COLORS.dim, `/ ${formatFn(budget)}`)}`;
}

function fmtTime(n: number): string {
  return `${Math.round(n)}s`;
}

function fmtTokens(n: number): string {
  return `${n}`;
}

export function renderBudgetSummaryTable(params: BudgetSummaryDisplayParams): string {
  const { summary, terminalWidth, useColor, showCosts } = params;
  const lines: string[] = [];
  const lineWidth = Math.min(80, terminalWidth - 2);

  lines.push("");
  lines.push(cc(useColor, COLORS.cyan + COLORS.bold, "Budget Summary"));
  lines.push(cc(useColor, COLORS.dim, "─".repeat(lineWidth)));

  // Compute name column width dynamically
  const MAX_NAME = 30;
  const MIN_NAME = 22;
  let maxNameLen = MIN_NAME;
  for (const row of summary.rows) {
    const prefix = row.loopContext ? 5 : 0; // "  ├─ " is 5 chars
    const nameLen = Math.min(prefix + row.codonId.length, prefix + MAX_NAME);
    if (nameLen > maxNameLen) maxNameLen = nameLen;
  }
  const COL_NAME = maxNameLen + 2;

  // Build columns based on what data is available and showCosts flag
  const hasDollars =
    showCosts &&
    summary.rows.some((r) => r.budget.maxDollars !== undefined || r.actual.dollars > 0);
  const hasTime = summary.rows.some(
    (r) => r.budget.maxTimeSeconds !== undefined || r.actual.timeSeconds > 0,
  );
  const hasTokens = summary.rows.some(
    (r) => r.budget.maxOutputTokens !== undefined || r.actual.outputTokens > 0,
  );

  const COL_DOLLARS = 28;
  const COL_TIME = 20;
  const COL_TOKENS = 16;

  // Header
  let header = `  ${padTo(cc(useColor, COLORS.dim, "Codon"), COL_NAME)}`;
  if (hasDollars) header += padTo(cc(useColor, COLORS.dim, "Dollars"), COL_DOLLARS);
  if (hasTime) header += padTo(cc(useColor, COLORS.dim, "Time"), COL_TIME);
  if (hasTokens) header += padTo(cc(useColor, COLORS.dim, "Output Tokens"), COL_TOKENS);
  header += cc(useColor, COLORS.dim, "Status");
  lines.push(header);

  let sep = `  ${padTo(cc(useColor, COLORS.dim, "─────"), COL_NAME)}`;
  if (hasDollars) sep += padTo(cc(useColor, COLORS.dim, "───────"), COL_DOLLARS);
  if (hasTime) sep += padTo(cc(useColor, COLORS.dim, "────"), COL_TIME);
  if (hasTokens) sep += padTo(cc(useColor, COLORS.dim, "─────────────"), COL_TOKENS);
  sep += cc(useColor, COLORS.dim, "──────");
  lines.push(sep);

  // Track loop grouping for tree prefixes
  let currentLoopId: string | null = null;
  const loopChildCounts = new Map<string, number>();
  const loopChildSeen = new Map<string, number>();

  // Pre-count loop children for tree rendering
  for (const row of summary.rows) {
    if (row.loopContext) {
      const lid = row.loopContext.loopId;
      loopChildCounts.set(lid, (loopChildCounts.get(lid) ?? 0) + 1);
    }
  }

  for (const row of summary.rows) {
    let name: string;

    if (row.loopContext) {
      const lid = row.loopContext.loopId;

      // Emit loop header row on first encounter
      if (currentLoopId !== lid) {
        currentLoopId = lid;
        loopChildSeen.set(lid, 0);
        // Loop header row (no actual data, just the loop name)
        const loopRow = `  ${padTo(cc(useColor, COLORS.bold, truncate(lid, MAX_NAME)), COL_NAME)}`;
        lines.push(loopRow);
      }

      const seen = (loopChildSeen.get(lid) ?? 0) + 1;
      loopChildSeen.set(lid, seen);
      const total = loopChildCounts.get(lid) ?? 0;
      const isLast = seen === total;
      const prefix = isLast ? "  └─ " : "  ├─ ";
      name = `${prefix}${truncate(row.codonId, MAX_NAME)}`;
    } else {
      currentLoopId = null;
      name = truncate(row.codonId, MAX_NAME);
    }

    let line = `  ${padTo(name, COL_NAME)}`;
    if (hasDollars) {
      const cell = formatActualVsBudget(
        row.actual.dollars,
        row.budget.maxDollars,
        fmtDollars,
        useColor,
      );
      line += padTo(cell, COL_DOLLARS);
    }
    if (hasTime) {
      const cell = formatActualVsBudget(
        row.actual.timeSeconds,
        row.budget.maxTimeSeconds,
        fmtTime,
        useColor,
      );
      line += padTo(cell, COL_TIME);
    }
    if (hasTokens) {
      const cell =
        row.budget.maxOutputTokens !== undefined
          ? formatActualVsBudget(
              row.actual.outputTokens,
              row.budget.maxOutputTokens,
              fmtTokens,
              useColor,
            )
          : `${row.actual.outputTokens}`;
      line += padTo(cell, COL_TOKENS);
    }
    line += formatStatus(row.status, useColor);
    lines.push(line);
  }

  // Totals row
  lines.push(`  ${cc(useColor, COLORS.dim, "─".repeat(lineWidth - 2))}`);
  let totalLine = `  ${padTo(cc(useColor, COLORS.bold, "Total"), COL_NAME)}`;
  if (hasDollars) {
    const cell = formatActualVsBudget(
      summary.totals.actualDollars,
      summary.totals.budgetDollars,
      fmtDollars,
      useColor,
    );
    totalLine += padTo(cell, COL_DOLLARS);
  }
  if (hasTime) {
    totalLine += padTo(fmtTime(summary.totals.actualTimeSeconds), COL_TIME);
  }
  lines.push(totalLine);

  return lines.join("\n");
}
