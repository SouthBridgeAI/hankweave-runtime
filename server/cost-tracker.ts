import type { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import type { ModelInfo } from "./llm/models-dev-schema.js";
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
 * Receives raw API messages, calculates costs via LlmProviderRegistry, maintains
 * running totals, and emits typed events for external consumers (state transitions,
 * event broadcasting).
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

  constructor(
    model: ModelInfo | undefined,
    private readonly llmRegistry: LlmProviderRegistry,
    private readonly logger: Logger,
  ) {
    super();
    this.executableModelId = model?.modelId;
    // ModelInfo always carries the real provider id, so pi-run models price by
    // the same "provider/model" key as everything else.
    this.pricingModelId = model ? `${model.providerId}/${model.modelId}` : undefined;
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

    // Calculate cost delta using LLM registry
    let costDelta = 0;

    if (this.pricingModelId) {
      const calculatedCost = this.llmRegistry.calculateCost(this.pricingModelId, {
        inputTokens: tokensDelta.inputTokens,
        outputTokens: tokensDelta.outputTokens,
        cacheReadTokens: tokensDelta.cacheReadTokens,
        cacheCreationTokens: tokensDelta.cacheCreationTokens,
      });

      if (calculatedCost !== null) {
        costDelta = calculatedCost;
      } else {
        this.logger.log(
          `Cannot calculate incremental cost for model: ${this.pricingModelId}`,
          "debug",
        );
      }
    } else {
      this.logger.log("Cannot calculate incremental cost: no model ID in current codon", "debug");
    }

    // Accumulate running totals
    this.runningCost += costDelta;
    this.runningTokens.inputTokens += tokensDelta.inputTokens;
    this.runningTokens.outputTokens += tokensDelta.outputTokens;
    this.runningTokens.cacheCreationTokens += tokensDelta.cacheCreationTokens;
    this.runningTokens.cacheReadTokens += tokensDelta.cacheReadTokens;

    this.emit("costIncremented", { cost: costDelta, tokens: tokensDelta });
  }

  /**
   * Process usage from a result message. Resolves authoritative final cost
   * using priority chain (CLI-provided > registry calc > accumulated fallback),
   * logs discrepancies, and emits finalCostSet.
   */
  handleResultUsage(msg: RawResultUsage): void {
    if (!msg.usage) return;

    const finalTokens: TokenUsage = {
      inputTokens: msg.usage.input_tokens || 0,
      outputTokens: msg.usage.output_tokens || 0,
      cacheCreationTokens: msg.usage.cache_creation_input_tokens || 0,
      cacheReadTokens: msg.usage.cache_read_input_tokens || 0,
    };

    // Get final cost: prefer CLI-provided, fallback to registry calculation, then accumulated cost
    let finalCost = msg.total_cost_usd;

    if (finalCost === undefined) {
      if (this.pricingModelId) {
        const calculatedCost = this.llmRegistry.calculateCost(this.pricingModelId, {
          inputTokens: finalTokens.inputTokens,
          outputTokens: finalTokens.outputTokens,
          cacheReadTokens: finalTokens.cacheReadTokens,
          cacheCreationTokens: finalTokens.cacheCreationTokens,
        });

        if (calculatedCost !== null) {
          finalCost = calculatedCost;
        } else {
          // Fall back to accumulated cost if registry lookup fails
          this.logger.log(
            `Cannot calculate final cost for model: ${this.pricingModelId}, using accumulated cost: $${this.runningCost.toFixed(4)}`,
            "debug",
          );
          finalCost = this.runningCost;
        }
      } else {
        // Fall back to accumulated cost if no model ID
        this.logger.log(
          `Cannot calculate final cost: no model ID, using accumulated cost: $${this.runningCost.toFixed(4)}`,
          "debug",
        );
        finalCost = this.runningCost;
      }
    }

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
      modelUsage: msg.modelUsage,
      modelId: this.executableModelId,
    });
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
