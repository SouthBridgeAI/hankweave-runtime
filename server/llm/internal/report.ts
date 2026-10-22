import type { ModelInfo } from "./models-dev-schema.js";

/**
 * How a hank's models resolved, for `--validate`, the startup summary, and
 * the journal (spec 70, "Confidence levels and provenance"; spec 72,
 * "Evidence vocabulary"). One line per distinct model: the spelling as
 * written, the record it resolved to, the harness that runs it, how far to
 * trust the record, its price, where the record came from, and what
 * confirmed the harness can run it. A second line explains anything a reader
 * must act on: an estimated or disputed price, fields inherited from a
 * sibling.
 */

const rate = (value: number | undefined) => `$${Number((value ?? 0).toFixed(4))}`;

function priceText(model: ModelInfo): string {
  const p = model.provenance;
  const listed = model.cost ? `${rate(model.cost.input)}/${rate(model.cost.output)} per M` : "";
  switch (p?.priceStatus) {
    case "zero":
      return "$0 (listed free)";
    case "disputed":
      return `${listed} (disputed)`;
    case "unknown":
      return "price unknown";
    default:
      return listed || "price unknown";
  }
}

/** The second line for a model, when there is something to explain. */
function noteText(model: ModelInfo): string | undefined {
  const p = model.provenance;
  if (!p) return undefined;
  const notes: string[] = [];
  if (p.budgetCost && p.budgetCostBasis) {
    notes.push(
      `budgets use ${rate(p.budgetCost.input)}/${rate(p.budgetCost.output)} per M (${p.budgetCostBasis})`,
    );
  } else if (p.priceStatus === "unknown") {
    notes.push("no price and no estimate: dollar budgets cannot count this model's cost");
  }
  if (p.inheritedFrom) notes.push(`unlisted fields copied from ${p.inheritedFrom}`);
  if (p.priceSource) notes.push(`price from ${p.priceSource}`);
  return notes.length > 0 ? notes.join("; ") : undefined;
}

export interface ReportRow {
  model: ModelInfo;
  /** "claude-agent-sdk", "pi", "ai-sdk". */
  harness: string;
  /** "codon" or "sentinel". */
  use: string;
}

/** Lines for the "Models" block; empty when there are no rows. */
export function renderModelTable(input: readonly ReportRow[]): string[] {
  if (input.length === 0) return [];
  const rows = input.map(({ model, harness, use }) => ({
    requested: model.provenance?.requestedAs ?? `${model.providerId}/${model.modelId}`,
    resolved: `${model.providerId}/${model.modelId}`,
    harness: use === "sentinel" ? `${harness} (sentinel)` : harness,
    confidence: model.provenance?.confidence ?? "registry",
    price: priceText(model),
    source: model.provenance?.source ?? "",
    evidence: model.provenance?.evidence,
    note: noteText(model),
  }));
  const width = (pick: (row: (typeof rows)[number]) => string) =>
    Math.max(...rows.map((row) => pick(row).length));
  const w = {
    requested: width((r) => r.requested),
    resolved: width((r) => r.resolved),
    harness: width((r) => r.harness),
    confidence: width((r) => r.confidence),
    price: width((r) => r.price),
  };

  const lines = ["Models"];
  for (const row of rows) {
    lines.push(
      `  ${row.requested.padEnd(w.requested)} → ${row.resolved.padEnd(w.resolved)}  ` +
        `${row.harness.padEnd(w.harness)}  ${row.confidence.padEnd(w.confidence)}  ` +
        `${row.price.padEnd(w.price)}  ${row.source}`.trimEnd(),
    );
    const notes = [row.evidence && `confirmed by ${row.evidence}`, row.note].filter(Boolean);
    if (notes.length > 0) lines.push(`${" ".repeat(w.requested + 5)}${notes.join("; ")}`);
  }
  return lines;
}

/**
 * The journal notice for a codon whose model a reader should know about —
 * provisional, user-defined, or harness-only records; unknown or disputed
 * prices; and declared prices (a `models` block or overlay correction),
 * which the run records over the harness's own. Undefined for a registry
 * record with a known, undeclared price.
 */
export function modelNoticeForCodon(codonId: string, model: ModelInfo): string | undefined {
  const p = model.provenance;
  if (!p) return undefined;
  const notable =
    p.confidence === "provisional" ||
    p.confidence === "user" ||
    p.confidence === "harness" ||
    p.confidence === "unverified" ||
    p.priceStatus === "unknown" ||
    p.priceStatus === "disputed" ||
    p.priceDeclared === true;
  if (!notable) return undefined;
  const note = noteText(model);
  return (
    `Codon ${codonId} runs ${model.providerId}/${model.modelId} (${p.confidence} record from ` +
    `${p.source}; ${priceText(model)})${note ? `: ${note}` : ""}`
  );
}
