import { describe, expect, test } from "bun:test";
import { CostTracker, type CostTrackerEvents } from "../../server/cost-tracker.js";
import type { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import type { ModelInfo } from "../../server/llm/models-dev-schema.js";
import { Logger } from "../../server/utils.js";

function createModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    cost: {
      input: 0.435,
      output: 0.87,
      cache_read: 0.003625,
    },
    limit: {
      context: 1_000_000,
      output: 384_000,
    },
    modalities: {
      input: ["text"],
      output: ["text"],
    },
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    ...overrides,
  };
}

function createLogger(): Logger {
  const logger = new Logger("/dev/null");
  logger.log = () => {};
  return logger;
}

function createRegistry(costs: Record<string, number | null>) {
  const calls: Array<{
    modelName: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    };
  }> = [];

  const registry = {
    calculateCost: (
      modelName: string,
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      },
    ) => {
      calls.push({ modelName, usage });
      return costs[modelName] ?? null;
    },
  } as unknown as LlmProviderRegistry;

  return { registry, calls };
}

describe("CostTracker", () => {
  test("uses provider-qualified lookup for regular provider models", () => {
    const { registry, calls } = createRegistry({
      "deepseek/deepseek-v4-pro": 0.123,
      "deepseek-v4-pro": 9.999,
    });
    const tracker = new CostTracker(createModel(), registry, createLogger());
    let final: CostTrackerEvents["finalCostSet"][0] | undefined;
    tracker.on("finalCostSet", (event) => {
      final = event;
    });

    tracker.handleResultUsage({
      usage: {
        input_tokens: 1_000,
        output_tokens: 200,
        cache_read_input_tokens: 300,
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].modelName).toBe("deepseek/deepseek-v4-pro");
    expect(calls[0].usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheCreationTokens: 0,
    });
    expect(final?.cost).toBe(0.123);
    expect(final?.modelId).toBe("deepseek-v4-pro");
  });

  test("uses provider-qualified lookup for non-passthrough model IDs containing slashes", () => {
    const { registry, calls } = createRegistry({
      "gateway/vendor/model": 0.456,
      "vendor/model": 9.999,
    });
    const tracker = new CostTracker(
      createModel({
        providerId: "gateway",
        modelId: "vendor/model",
        name: "Gateway Vendor Model",
      }),
      registry,
      createLogger(),
    );
    let final: CostTrackerEvents["finalCostSet"][0] | undefined;
    tracker.on("finalCostSet", (event) => {
      final = event;
    });

    tracker.handleResultUsage({
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].modelName).toBe("gateway/vendor/model");
    expect(final?.cost).toBe(0.456);
    expect(final?.modelId).toBe("vendor/model");
  });

  test("prices pi-harness models by the same provider-qualified key", () => {
    // A model forced onto the pi harness carries its real identity; pricing
    // uses the identical "<provider>/<model>" key as agent-sdk models.
    const { registry, calls } = createRegistry({
      "anthropic/claude-haiku-4-5": 0.789,
      "pi/anthropic/claude-haiku-4-5": 9.999,
    });
    const tracker = new CostTracker(
      createModel({
        providerId: "anthropic",
        modelId: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        harnessOverride: "pi",
      }),
      registry,
      createLogger(),
    );
    let final: CostTrackerEvents["finalCostSet"][0] | undefined;
    tracker.on("finalCostSet", (event) => {
      final = event;
    });

    tracker.handleResultUsage({
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].modelName).toBe("anthropic/claude-haiku-4-5");
    expect(final?.cost).toBe(0.789);
    expect(final?.modelId).toBe("claude-haiku-4-5");
  });

  test("prices routing-derived pi models by their real provider key", () => {
    const { registry, calls } = createRegistry({
      "openai/gpt-4o": 0.321,
      "gpt-4o": 9.999,
    });
    const tracker = new CostTracker(
      createModel({
        providerId: "openai",
        modelId: "gpt-4o",
        name: "GPT-4o",
      }),
      registry,
      createLogger(),
    );
    let delta: CostTrackerEvents["costIncremented"][0] | undefined;
    tracker.on("costIncremented", (event) => {
      delta = event;
    });

    tracker.handleAssistantUsage({
      input_tokens: 1,
      output_tokens: 1,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].modelName).toBe("openai/gpt-4o");
    expect(delta?.cost).toBe(0.321);
  });

  test("does not re-resolve pricing when the result message provides total cost", () => {
    const { registry, calls } = createRegistry({
      "deepseek/deepseek-v4-pro": 9.999,
    });
    const tracker = new CostTracker(createModel(), registry, createLogger());
    let final: CostTrackerEvents["finalCostSet"][0] | undefined;
    tracker.on("finalCostSet", (event) => {
      final = event;
    });

    tracker.handleResultUsage({
      total_cost_usd: 0.111,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    });

    expect(calls).toHaveLength(0);
    expect(final?.cost).toBe(0.111);
    expect(final?.modelId).toBe("deepseek-v4-pro");
  });
});
