import { describe, expect, test } from "bun:test";
import { CostTracker, type CostTrackerEvents } from "../../server/cost-tracker.js";
import type { ModelInfo } from "../../server/llm/index.js";
import { CatalogIndex } from "../../server/llm/internal/catalog-index.js";
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
    cost: { input: 1, output: 2 },
    limit: { context: 1_000_000, output: 384_000 },
    modalities: { input: ["text"], output: ["text"] },
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

/** A real catalog index over fixture rows: pricing goes through the same exact lookup as production. */
function registryWith(rows: ModelInfo[]): CatalogIndex {
  return new CatalogIndex(rows, () => true);
}

function track(model: ModelInfo, registry: CatalogIndex) {
  const tracker = new CostTracker(model, registry, createLogger());
  const increments: CostTrackerEvents["costIncremented"][0][] = [];
  let final: CostTrackerEvents["finalCostSet"][0] | undefined;
  tracker.on("costIncremented", (delta) => increments.push(delta));
  tracker.on("finalCostSet", (event) => {
    final = event;
  });
  return { tracker, increments, final: () => final };
}

const MILLION = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

describe("CostTracker", () => {
  test("prices by the provider-qualified key, never a same-id row from another provider", () => {
    const registry = registryWith([
      createModel(),
      createModel({ providerId: "reseller", cost: { input: 100, output: 200 } }),
    ]);
    const { tracker, final } = track(createModel({ cost: undefined }), registry);

    tracker.handleResultUsage({ usage: { ...MILLION, cache_read_input_tokens: 0 } });

    expect(final()?.cost).toBe(3);
    expect(final()?.modelId).toBe("deepseek-v4-pro");
  });

  test("looks the pricing record up exactly, never by a differently cased id", () => {
    const registry = registryWith([createModel({ modelId: "DeepSeek-V4-Pro" })]);
    const { tracker, final } = track(createModel({ cost: undefined }), registry);

    tracker.handleResultUsage({ total_cost_usd: 0.5, usage: MILLION });

    expect(final()?.cost).toBe(0.5);
  });

  test("prices model ids containing slashes under their own provider", () => {
    const registry = registryWith([
      createModel({
        providerId: "gateway",
        modelId: "vendor/model",
        cost: { input: 1, output: 1 },
      }),
      createModel({ providerId: "vendor", modelId: "model", cost: { input: 100, output: 100 } }),
    ]);
    const { tracker, final } = track(
      createModel({ providerId: "gateway", modelId: "vendor/model", cost: undefined }),
      registry,
    );

    tracker.handleResultUsage({ usage: MILLION });

    expect(final()?.cost).toBe(2);
    expect(final()?.modelId).toBe("vendor/model");
  });

  test("prices pi-forced models by their real provider key", () => {
    const registry = registryWith([
      createModel({
        providerId: "anthropic",
        modelId: "claude-haiku-4-5",
        cost: { input: 1, output: 5 },
      }),
    ]);
    const { tracker, final } = track(
      createModel({
        providerId: "anthropic",
        modelId: "claude-haiku-4-5",
        harnessOverride: "pi",
        cost: undefined,
      }),
      registry,
    );

    tracker.handleResultUsage({ usage: MILLION });

    expect(final()?.cost).toBe(6);
  });

  test("prices openai-codex (ChatGPT-login) models as openai, incrementally too", () => {
    // The catalog has no `openai-codex` provider. Before the pricing alias,
    // every incremental token.usage for a codex codon read $0 and only the
    // final result carried pi's total — so budgets could not enforce mid-codon.
    const registry = registryWith([
      createModel({
        providerId: "openai",
        modelId: "gpt-5.6-luna",
        cost: { input: 0.2, output: 1.2 },
      }),
    ]);
    const { tracker, increments, final } = track(
      createModel({ providerId: "openai-codex", modelId: "gpt-5.6-luna", cost: undefined }),
      registry,
    );

    tracker.handleAssistantUsage({ input_tokens: 2_000, output_tokens: 50 });
    tracker.handleResultUsage({ usage: { input_tokens: 2_000, output_tokens: 50 } });

    expect(increments).toHaveLength(1);
    expect(increments[0].cost).toBeCloseTo(0.00046, 10);
    expect(final()?.cost).toBeCloseTo(0.00046, 10);
    // The executable identity is untouched: events still name the model pi ran.
    expect(final()?.modelId).toBe("gpt-5.6-luna");
  });

  test("keeps the harness-reported total when every entry was priced by the harness", () => {
    const registry = registryWith([createModel({ cost: { input: 100, output: 100 } })]);
    const { tracker, final } = track(createModel(), registry);

    tracker.handleResultUsage({
      total_cost_usd: 0.111,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        "deepseek-v4-pro": {
          inputTokens: 1,
          outputTokens: 1,
          costUSD: 0.111,
          costBasis: "list",
        },
      },
    });

    expect(final()?.cost).toBe(0.111);
  });

  test("prices from the plan's persisted record when it carries catalog provenance", () => {
    // A resumed run prices exactly as it was validated, even after the live
    // catalog's price changed.
    const registry = registryWith([createModel({ cost: { input: 100, output: 100 } })]);
    const persisted = createModel({
      cost: { input: 1, output: 2 },
      provenance: {
        confidence: "registry",
        source: "models.dev snapshot 2026-09-25",
        priceStatus: "known",
      },
    });
    const { tracker, final } = track(persisted, registry);

    tracker.handleResultUsage({ usage: MILLION });

    expect(final()?.cost).toBe(3);
  });

  test("re-prices entries Claude Code billed at a guessed rate (costBasis unknown)", () => {
    const sonnet6 = createModel({
      providerId: "anthropic",
      modelId: "claude-sonnet-6",
      cost: { input: 2, output: 10 },
      provenance: {
        confidence: "provisional",
        source: "anthropic GET /v1/models",
        priceStatus: "known",
      },
    });
    const { tracker, final } = track(sonnet6, registryWith([]));

    tracker.handleResultUsage({
      total_cost_usd: 24.001,
      usage: MILLION,
      modelUsage: {
        // Claude Code priced its unknown model at the default model's $4/$20.
        "claude-sonnet-6": {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          costUSD: 24,
          costBasis: "unknown",
        },
        "claude-haiku-4-5": {
          inputTokens: 1_000,
          outputTokens: 0,
          costUSD: 0.001,
          costBasis: "list",
        },
      },
    });

    expect(final()?.cost).toBeCloseTo(12.001, 10);
    const usage = final()?.modelUsage as Record<string, { costUSD: number }>;
    expect(usage["claude-sonnet-6"].costUSD).toBe(12);
    expect(usage["claude-haiku-4-5"].costUSD).toBe(0.001);
  });

  test("counts an unknown price at the catalog's ceiling estimate instead of $0", () => {
    const unpriced = createModel({
      modelId: "deepseek-v5-preview",
      cost: undefined,
      provenance: {
        confidence: "provisional",
        source: "deepseek GET /models",
        priceStatus: "unknown",
        budgetCost: { input: 3, output: 6 },
        budgetCostBasis: "ceiling estimate",
      },
    });
    const { tracker, increments, final } = track(unpriced, registryWith([]));

    tracker.handleAssistantUsage({ input_tokens: 1_000_000, output_tokens: 0 });
    tracker.handleResultUsage({ usage: MILLION });

    expect(increments[0].cost).toBe(3);
    expect(final()?.cost).toBe(9);
  });

  const declared = (cost: ModelInfo["cost"]) =>
    createModel({
      providerId: "anthropic",
      modelId: "claude-haiku-4-5",
      cost,
      provenance: {
        confidence: "user",
        source: "hank.json models block",
        priceStatus: "known",
        priceSource: "hank.json models block",
        priceDeclared: true,
      },
    });

  test("records the codon's model at its declared price even when Claude Code priced it", () => {
    const { tracker, final } = track(declared({ input: 1000, output: 1000 }), registryWith([]));

    tracker.handleResultUsage({
      total_cost_usd: 2.001,
      usage: MILLION,
      modelUsage: {
        // Claude Code priced the model it knows at its own list price.
        "claude-haiku-4-5": {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          costUSD: 2,
          costBasis: "list",
        },
        // Another model Claude Code called keeps the CLI's price.
        "claude-opus-5-5": { inputTokens: 1_000, outputTokens: 0, costUSD: 0.001 },
      },
    });

    expect(final()?.cost).toBeCloseTo(2000.001, 10);
    const usage = final()?.modelUsage as Record<string, { costUSD: number }>;
    expect(usage["claude-haiku-4-5"].costUSD).toBe(2000);
    expect(usage["claude-opus-5-5"].costUSD).toBe(0.001);
  });

  test("records a declared price over pi's total, which carries no per-model usage", () => {
    const { tracker, final } = track(declared({ input: 1000, output: 1000 }), registryWith([]));

    tracker.handleResultUsage({ total_cost_usd: 2, usage: MILLION });

    expect(final()?.cost).toBe(2000);
  });

  test("a disputed price still records the harness total", () => {
    const disputed = createModel({
      cost: { input: 1, output: 2 },
      provenance: {
        confidence: "registry",
        source: "models.dev snapshot",
        priceStatus: "disputed",
        budgetCost: { input: 2, output: 4 },
      },
    });
    const { tracker, final } = track(disputed, registryWith([]));

    tracker.handleResultUsage({ total_cost_usd: 3, usage: MILLION });

    expect(final()?.cost).toBe(3);
  });
});
