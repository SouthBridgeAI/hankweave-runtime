import fs from "node:fs";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import { logMessageSchema } from "../../server/types/claude-session-schema.js";
import type { TokenUsage } from "../../server/types/types.js";

// Local helper for testing log parsing - replaces the removed loadCodonStateFromLog.
// Shared by claude-log-parser.test.ts and real-claude-logs.test.ts, which used to
// carry byte-identical inline copies.
export function parseLogForTesting(logPath: string): {
  sessionId: string | null;
  success: boolean;
  cost: number;
  tokens: TokenUsage;
} {
  let sessionId: string | null = null;
  let modelId: string | null = null;
  let success = false;
  const tokens: TokenUsage & { _totalCost?: number } = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  try {
    if (!fs.existsSync(logPath)) {
      return { sessionId, success, cost: 0, tokens };
    }

    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const result = logMessageSchema.safeParse(JSON.parse(trimmed));
        if (!result.success) continue;

        const entry = result.data;

        if (entry.type === "system" && entry.subtype === "init") {
          sessionId = entry.session_id;
          modelId = entry.model;
        }

        if (entry.type === "result") {
          // Mark success only if subtype is "success" AND is_error is false
          if (entry.subtype === "success" && !entry.is_error) {
            success = true;
          }

          // Use final usage from result message if available (for both success and error)
          if (entry.usage) {
            tokens.inputTokens = entry.usage.input_tokens || 0;
            tokens.outputTokens = entry.usage.output_tokens || 0;
            tokens.cacheCreationTokens = entry.usage.cache_creation_input_tokens || 0;
            tokens.cacheReadTokens = entry.usage.cache_read_input_tokens || 0;
          }

          // If total_cost_usd is provided, we'll use it directly in cost calculation
          if (entry.total_cost_usd !== undefined) {
            // Store it temporarily - we'll return it directly
            tokens._totalCost = entry.total_cost_usd;
          }
        }

        // Only use assistant message usage if we haven't found result usage yet
        if (entry.type === "assistant" && entry.message.usage && !tokens._totalCost) {
          // Claude reports cumulative usage, so we take the last one
          const usage = entry.message.usage;
          tokens.inputTokens = usage.input_tokens || 0;
          tokens.outputTokens = usage.output_tokens || 0;
          tokens.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
          tokens.cacheReadTokens = usage.cache_read_input_tokens || 0;
        }
      } catch {
        // Skip invalid lines
      }
    }

    // Use the total cost from result message if available, otherwise calculate using LLM registry
    const tokensWithCost = tokens as TokenUsage & { _totalCost?: number };
    let cost = 0;

    if (tokensWithCost._totalCost !== undefined) {
      cost = tokensWithCost._totalCost;
    } else if (modelId) {
      // Use LLM registry to calculate cost based on model. The first getInstance()
      // caller's config wins process-wide, so be explicit: no background health checks.
      const registry = LlmProviderRegistry.getInstance({ performHealthCheckOnInit: false });
      const calculatedCost = registry.calculateCost(modelId, {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        cacheCreationTokens: tokens.cacheCreationTokens,
      });
      cost = calculatedCost ?? 0;
    }

    // Clean up temporary property
    if (tokensWithCost._totalCost !== undefined) {
      delete tokensWithCost._totalCost;
    }

    return { sessionId, success, cost, tokens };
  } catch (error) {
    console.error(`Error loading state from log ${logPath}:`, error);
    return { sessionId, success: false, cost: 0, tokens };
  }
}
