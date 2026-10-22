import { z } from "zod";
import {
  type ModelInfo,
  type Models,
  type PricedUsage,
  priceUsage,
  type UsageTokens,
} from "./llm/index.js";
import { pricingProviderId } from "./provider-ids.js";
import { TypedEventEmitter } from "./typed-event-emitter.js";
import type { TokenUsage } from "./types/types.js";
import type { Logger } from "./utils.js";

/**
 * Raw API usage fields from assistant messages.
 */
export interface RawApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Raw fields from a result message relevant to cost tracking.
 */
export interface RawResultUsage {
  usage?: RawApiUsage;
  total_cost_usd?: number;
  modelUsage?: unknown;
}

/**
 * One entry of the Claude Agent SDK's per-model usage (`ModelUsage` in the
 * SDK's sdk.d.ts). `costBasis: "unknown"` means Claude Code had no price for
 * the model and billed it at its default model's rate — a guess.
 */
const modelUsageEntrySchema = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number().optional(),
    cacheCreationInputTokens: z.number().optional(),
    costUSD: z.number(),
    costBasis: z.string().optional(),
  })
  .passthrough();
const modelUsageSchema = z.record(z.string(), modelUsageEntrySchema);
type ModelUsageEntry = z.infer<typeof modelUsageEntrySchema>;

/**
 * Events emitted by CostTracker.
 */
export interface CostTrackerEvents extends Record<string, unknown[]> {
  /** Incremental cost from an assistant message */
  costIncremented: [delta: { cost: number; tokens: TokenUsage }];
  /** Authoritative final cost from result message */
  finalCostSet: [
    final: {
      cost: number;
      tokens: TokenUsage;
      modelUsage?: unknown;
      modelId?: string;
    },
  ];
}

/**
 * Encapsulates cost computation and accumulation for a single codon execution.
 *
 * Receives raw API messages, prices them from the codon's model record,
 * maintains running totals, and emits typed events for external consumers
 * (state transitions, event broadcasting).
 *
 * The record priced with is the codon's own ModelInfo when it carries catalog
 * provenance — the facts persisted in the execution plan, so a resumed run
 * prices exactly as it was validated — else the live catalog record (plans
 * persisted before provenance existed).
 *
 * Owned by CodonRunner. The runtime subscribes to its events.
 */
export class CostTracker extends TypedEventEmitter<CostTrackerEvents> {
  private runningCost = 0;
  private runningTokens: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  private readonly executableModelId: string | undefined;
  private readonly pricingModelId: string | undefined;
  private readonly pricingRecord: ModelInfo | undefined;

  constructor(
    private readonly model: ModelInfo | undefined,
    private readonly models: Pick<Models, "get">,
    private readonly logger: Logger,
  ) {
    super();
    this.executableModelId = model?.modelId;
    // ModelInfo always carries the real provider id, so pi-run models price by
    // the same "provider/model" key as everything else (pricing aliases aside).
    this.pricingModelId = model
      ? `${pricingProviderId(model.providerId)}/${model.modelId}`
      : undefined;
    if (model?.provenance) {
      this.pricingRecord = model;
    } else if (model) {
      this.pricingRecord = models.get(pricingProviderId(model.providerId), model.modelId);
    }
  }

  private price(tokens: UsageTokens): PricedUsage | null {
    return this.pricingRecord ? priceUsage(this.pricingRecord, tokens) : null;
  }

  /**
   * Process usage from an assistant message. Calculates incremental cost,
   * accumulates running totals, and emits costIncremented.
   */
  handleAssistantUsage(usage: RawApiUsage): void {
    const tokensDelta: TokenUsage = {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
    };

    const priced = this.price(tokensDelta);
    if (!priced) {
      this.logger.log(
        `Cannot calculate incremental cost for model: ${this.pricingModelId ?? "(none)"}`,
        "debug",
      );
    }
    const costDelta = priced?.cost ?? 0;

    // Accumulate running totals
    this.runningCost += costDelta;
    this.runningTokens.inputTokens += tokensDelta.inputTokens;
    this.runningTokens.outputTokens += tokensDelta.outputTokens;
    this.runningTokens.cacheCreationTokens += tokensDelta.cacheCreationTokens;
    this.runningTokens.cacheReadTokens += tokensDelta.cacheReadTokens;

    this.emit("costIncremented", { cost: costDelta, tokens: tokensDelta });
  }

  /**
   * Process usage from a result message and record the codon's final cost
   * (spec 70, "Prices and budgets"):
   * - normally the harness-reported total (Claude Code's total_cost_usd, pi's
   *   summed usage cost). A disputed price still records the harness total —
   *   both sources are real list prices; the higher one is for enforcement —
   *   and so does a price the catalog filled in from LiteLLM;
   * - a declared price (a models block or overlay correction: provenance
   *   priceDeclared) is what the run records for the codon's own model, over
   *   the harness's price;
   * - Claude Code modelUsage entries marked `costBasis: "unknown"` (a model the
   *   CLI does not know, billed at its default model's rate) are re-priced
   *   from the catalog;
   * - with no harness total, a catalog calculation (pi omits its total when it
   *   has no price, pi-translation.ts; for an unpriced model that is the
   *   ceiling estimate), else the running total.
   * Known limit: re-pricing a Claude Code entry drops any non-token component
   * the CLI folded into that entry's costUSD (web search requests).
   */
  handleResultUsage(msg: RawResultUsage): void {
    if (!msg.usage) return;

    const finalTokens: TokenUsage = {
      inputTokens: msg.usage.input_tokens || 0,
      outputTokens: msg.usage.output_tokens || 0,
      cacheCreationTokens: msg.usage.cache_creation_input_tokens || 0,
      cacheReadTokens: msg.usage.cache_read_input_tokens || 0,
    };
    const { cost: finalCost, modelUsage } = this.recordedCost(msg, finalTokens);

    // Log cost discrepancy
    if (Math.abs(this.runningCost - finalCost) > 0.0001) {
      this.logger.log(
        `Cost discrepancy - Accumulated: $${this.runningCost.toFixed(4)}, ` +
          `Final: $${finalCost.toFixed(4)} (using final from result message)`,
      );
    }

    this.emit("finalCostSet", {
      cost: finalCost,
      tokens: finalTokens,
      modelUsage,
      modelId: this.executableModelId,
    });
  }

  /** The final cost to record and the per-model usage that sums to it. */
  private recordedCost(
    msg: RawResultUsage,
    tokens: TokenUsage,
  ): { cost: number; modelUsage: unknown } {
    const reported = msg.total_cost_usd;
    if (reported === undefined)
      return { cost: this.catalogCost(tokens), modelUsage: msg.modelUsage };
    if (msg.modelUsage !== undefined) {
      const repriced = this.repriceModelUsage(msg.modelUsage, reported);
      return repriced
        ? { cost: repriced.total, modelUsage: repriced.modelUsage }
        : { cost: reported, modelUsage: msg.modelUsage };
    }
    // A total without per-model usage (pi): only a declared price replaces it.
    return { cost: this.declaredCost(tokens, reported) ?? reported, modelUsage: undefined };
  }

  /** The catalog's price for the codon's tokens, else the running total. */
  private catalogCost(tokens: TokenUsage): number {
    const priced = this.price(tokens);
    if (priced) return priced.cost;
    this.logger.log(
      `Cannot calculate final cost for model: ${this.pricingModelId ?? "(none)"}, ` +
        `using accumulated cost: $${this.runningCost.toFixed(4)}`,
      "debug",
    );
    return this.runningCost;
  }

  /** The codon's tokens at its declared price, when it has one. */
  private declaredCost(tokens: TokenUsage, reported: number): number | undefined {
    if (!this.pricingRecord?.provenance?.priceDeclared) return undefined;
    const priced = this.price(tokens);
    if (!priced) return undefined;
    this.logger.log(
      `Recorded at its declared price (${this.pricingRecord.provenance.priceSource ?? "declared"}): ` +
        `$${priced.cost.toFixed(4)}; the harness reported $${reported.toFixed(4)}`,
      "info",
    );
    return priced.cost;
  }

  /**
   * Re-price the modelUsage entries the catalog prices instead of Claude Code:
   * those marked `costBasis: "unknown"`, and the codon's own model when its
   * price is declared. Returns the corrected total and per-model usage, or
   * undefined when no entry needed (or could get) a catalog price.
   */
  private repriceModelUsage(
    rawModelUsage: unknown,
    reportedTotal: number,
  ): { total: number; modelUsage: Record<string, unknown> } | undefined {
    const parsed = modelUsageSchema.safeParse(rawModelUsage);
    if (!parsed.success) return undefined;

    let total = reportedTotal;
    let changed = false;
    const corrected: Record<string, unknown> = { ...parsed.data };
    for (const [key, entry] of Object.entries(parsed.data)) {
      const priced = this.catalogPriceFor(key, entry);
      if (priced === undefined) continue;
      total += priced - entry.costUSD;
      corrected[key] = { ...entry, costUSD: priced };
      changed = true;
    }
    return changed ? { total: Math.max(0, total), modelUsage: corrected } : undefined;
  }

  /** The catalog's cost for one modelUsage entry, when the catalog prices it; logs why. */
  private catalogPriceFor(key: string, entry: ModelUsageEntry): number | undefined {
    const unknownBasis = entry.costBasis === "unknown";
    const declared =
      this.isCodonModel(key) && this.pricingRecord?.provenance?.priceDeclared === true;
    if (!unknownBasis && !declared) return undefined;
    const record = this.recordForUsageKey(key);
    const priced = record
      ? priceUsage(record, {
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheReadTokens: entry.cacheReadInputTokens,
          cacheCreationTokens: entry.cacheCreationInputTokens,
        })
      : null;
    if (!priced) {
      this.logger.log(
        `Claude Code had no price for '${key}' and billed it at its default model's rate ` +
          `($${entry.costUSD.toFixed(4)}); the model catalog has no price either — keeping it`,
        "info",
      );
      return undefined;
    }
    this.logger.log(
      declared
        ? `Recorded '${key}' at its declared price: $${priced.cost.toFixed(4)} ` +
            `(Claude Code reported $${entry.costUSD.toFixed(4)})`
        : `Claude Code had no price for '${key}' (costBasis "unknown", reported ` +
            `$${entry.costUSD.toFixed(4)}); re-priced from the model catalog: ` +
            `$${priced.cost.toFixed(4)}${priced.estimated ? " (ceiling estimate)" : ""}`,
      "info",
    );
    return priced.cost;
  }

  private isCodonModel(key: string): boolean {
    return this.model !== undefined && key.toLowerCase() === this.model.modelId.toLowerCase();
  }

  /** The catalog record for a modelUsage key (the raw model string Claude Code ran). */
  private recordForUsageKey(key: string): ModelInfo | undefined {
    if (this.isCodonModel(key)) return this.pricingRecord;
    const provider = this.model ? pricingProviderId(this.model.providerId) : "anthropic";
    return this.models.get(provider, key);
  }

  /** Current accumulated cost (for logging/fallback). */
  getRunningCost(): number {
    return this.runningCost;
  }

  /** Current accumulated token usage. */
  getRunningTokens(): TokenUsage {
    return { ...this.runningTokens };
  }
}
