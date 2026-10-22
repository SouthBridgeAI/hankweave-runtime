import { describe, expect, it } from "bun:test";
import {
  buildCatalogSnapshot,
  type CatalogLayers,
  familyKey,
} from "../../server/llm/internal/catalog-build.js";
import { normalizeLiteLlmPrices } from "../../server/llm/internal/litellm-prices.js";
import type { ModelInfo } from "../../server/llm/internal/models-dev-schema.js";
import {
  parseModelsDataRows,
  toModelsData,
  transformModelsDevApi,
} from "../../server/llm/internal/models-dev-transform.js";
import { type ModelOverlay, modelOverlaySchema } from "../../server/llm/internal/overlay.js";

const NOW = new Date("2026-09-29T00:00:00Z");

const row = (providerId: string, modelId: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  providerId,
  modelId,
  name: modelId,
  attachment: false,
  reasoning: true,
  tool_call: true,
  cost: { input: 3, output: 15 },
  limit: { context: 200000, output: 64000 },
  modalities: { input: ["text"], output: ["text"] },
  release_date: "2026-06-01",
  last_updated: "2026-06-01",
  ...extra,
});

const emptyOverlay: ModelOverlay = {
  schemaVersion: 1,
  updated: "2026-09-01",
  corrections: [],
};

const build = (layers: Partial<CatalogLayers> & Pick<CatalogLayers, "bundled">) =>
  buildCatalogSnapshot({
    overlay: { data: emptyOverlay, source: "test overlay" },
    now: NOW,
    ...layers,
  });

const find = (rows: readonly ModelInfo[], key: string) =>
  rows.find((r) => `${r.providerId}/${r.modelId}` === key);

describe("buildCatalogSnapshot", () => {
  it("lets live models.dev rows update bundled rows field by field, keeping fields live omits", () => {
    const built = build({
      bundled: {
        rows: [row("anthropic", "claude-x", { knowledge: "2026-01" })],
        lastUpdated: "2026-09-25T00:00:00Z",
      },
      live: {
        rows: [
          row("anthropic", "claude-x", { cost: { input: 2, output: 10 }, knowledge: undefined }),
        ],
        fetchedAt: "2026-09-29T06:00:00Z",
      },
    });
    const model = find(built.rows, "anthropic/claude-x");
    expect(model?.cost).toEqual({ input: 2, output: 10 });
    expect(model?.knowledge).toBe("2026-01");
    expect(model?.provenance?.source).toBe("models.dev live 2026-09-29 06:00Z");
  });

  it("ignores live rows for providers the bundled data does not carry", () => {
    const built = build({
      bundled: { rows: [row("anthropic", "claude-x")] },
      live: { rows: [row("brand-new-cloud", "model-a")], fetchedAt: "2026-09-29T06:00:00Z" },
    });
    expect(find(built.rows, "brand-new-cloud/model-a")).toBeUndefined();
  });

  it("builds a provisional record from a probe, inheriting from the newest same-family sibling but never its price", () => {
    const built = build({
      bundled: {
        rows: [
          row("anthropic", "claude-sonnet-4-5", {
            release_date: "2025-09-29",
            cost: { input: 3, output: 15 },
          }),
          row("anthropic", "claude-sonnet-5", {
            release_date: "2026-06-29",
            cost: { input: 2, output: 10 },
            limit: { context: 1000000, output: 128000 },
            modalities: { input: ["text", "image"], output: ["text"] },
          }),
        ],
      },
      probes: [
        {
          providerId: "anthropic",
          modelId: "claude-sonnet-6",
          probedAt: "2026-09-29T07:00:00Z",
          source: "anthropic GET /v1/models/claude-sonnet-6",
          name: "Claude Sonnet 6",
        },
      ],
    });
    const model = find(built.rows, "anthropic/claude-sonnet-6");
    expect(model?.provenance?.confidence).toBe("provisional");
    expect(model?.provenance?.inheritedFrom).toBe("anthropic/claude-sonnet-5");
    expect(model?.limit).toEqual({ context: 1000000, output: 128000 });
    expect(model?.modalities.input).toEqual(["text", "image"]);
    expect(model?.cost).toBeUndefined();
    expect(model?.provenance?.priceStatus).toBe("unknown");
    // Ceiling across the family: the higher of each rate.
    expect(model?.provenance?.budgetCost).toEqual({ input: 3, output: 15 });
  });

  it("never lets a probe replace a record a registry already lists", () => {
    const built = build({
      bundled: { rows: [row("anthropic", "claude-x", { name: "Registry Name" })] },
      probes: [
        {
          providerId: "anthropic",
          modelId: "claude-x",
          probedAt: "2026-09-29T07:00:00Z",
          source: "anthropic GET /v1/models/claude-x",
          name: "Probe Name",
        },
      ],
    });
    expect(find(built.rows, "anthropic/claude-x")?.name).toBe("Registry Name");
  });

  it("marks a price disputed only when LiteLLM is more than 5% higher, and budgets at the higher rate", () => {
    const built = build({
      bundled: {
        rows: [
          row("deepseek", "deepseek-flash", { cost: { input: 0.15, output: 0.6 } }),
          row("openai", "gpt-close", { cost: { input: 1.0, output: 4.0 } }),
          row("openai", "gpt-cheaper-on-litellm", { cost: { input: 3.3, output: 16.5 } }),
        ],
      },
      litellm: {
        prices: {
          "deepseek/deepseek-flash": { input: 0.3, output: 1.2, cache_read: 0.006 },
          "openai/gpt-close": { input: 1.04, output: 4.1 },
          "openai/gpt-cheaper-on-litellm": { input: 3, output: 15 },
        },
        fetchedAt: "2026-09-29T00:00:00Z",
      },
    });
    const disputed = find(built.rows, "deepseek/deepseek-flash")?.provenance;
    expect(disputed?.priceStatus).toBe("disputed");
    expect(disputed?.budgetCost).toEqual({ input: 0.3, output: 1.2, cache_read: 0.006 });
    expect(find(built.rows, "openai/gpt-close")?.provenance?.priceStatus).toBe("known");
    const cheaper = find(built.rows, "openai/gpt-cheaper-on-litellm")?.provenance;
    expect(cheaper?.priceStatus).toBe("known");
    expect(cheaper?.budgetCost).toBeUndefined();
  });

  it("fills a missing price from LiteLLM for first-party providers only", () => {
    const built = build({
      bundled: {
        rows: [
          row("openai", "gpt-unpriced", { cost: undefined }),
          row("some-reseller", "gpt-unpriced", { cost: undefined }),
        ],
      },
      litellm: {
        prices: {
          "openai/gpt-unpriced": { input: 2, output: 8 },
          "some-reseller/gpt-unpriced": { input: 2, output: 8 },
        },
        fetchedAt: "2026-09-29T00:00:00Z",
      },
    });
    const firstParty = find(built.rows, "openai/gpt-unpriced");
    expect(firstParty?.cost).toEqual({ input: 2, output: 8 });
    expect(firstParty?.provenance?.priceStatus).toBe("known");
    expect(firstParty?.provenance?.priceSource).toBe("LiteLLM 2026-09-29");
    expect(find(built.rows, "some-reseller/gpt-unpriced")?.provenance?.priceStatus).toBe("unknown");
  });

  it("applies overlay corrections and exempts them from the LiteLLM cross-check", () => {
    const built = buildCatalogSnapshot({
      now: NOW,
      bundled: {
        rows: [row("deepseek", "deepseek-v4-pro", { cost: { input: 0.435, output: 0.87 } })],
      },
      litellm: {
        prices: { "deepseek/deepseek-v4-pro": { input: 0.5, output: 1 } },
        fetchedAt: "2026-09-29T00:00:00Z",
      },
      overlay: {
        source: "bundled overlay",
        data: {
          ...emptyOverlay,
          corrections: [
            {
              model: "deepseek/deepseek-v4-pro",
              cost: { input: 1.32, output: 3.96, cache_read: 0.044 },
              reason: "peak rate",
              source: "https://api-docs.deepseek.com/quick_start/pricing",
            },
          ],
        },
      },
    });
    const model = find(built.rows, "deepseek/deepseek-v4-pro");
    expect(model?.cost).toEqual({ input: 1.32, output: 3.96, cache_read: 0.044 });
    expect(model?.provenance?.priceStatus).toBe("known");
  });

  it("distinguishes a listed zero price from an unknown one", () => {
    const built = build({
      bundled: {
        rows: [
          row("groq", "free-model", { cost: { input: 0, output: 0 } }),
          row("groq", "lonely-model", { cost: undefined, release_date: "2020-01-01" }),
        ],
      },
    });
    expect(find(built.rows, "groq/free-model")?.provenance?.priceStatus).toBe("zero");
    const lonely = find(built.rows, "groq/lonely-model")?.provenance;
    expect(lonely?.priceStatus).toBe("unknown");
    // No priced sibling in its family or model line: no estimate at all.
    expect(lonely?.budgetCost).toBeUndefined();
  });

  it("marks a $0 price filled in from LiteLLM as zero, so budgets are warned it cannot bind", () => {
    const built = build({
      bundled: { rows: [row("google", "gemini-x-exp", { cost: undefined })] },
      litellm: {
        prices: { "google/gemini-x-exp": { input: 0, output: 0 } },
        fetchedAt: "2026-09-29T00:00:00Z",
      },
    });
    const provenance = find(built.rows, "google/gemini-x-exp")?.provenance;
    expect(provenance?.priceStatus).toBe("zero");
    expect(provenance?.priceSource).toBe("LiteLLM 2026-09-29");
  });

  it("budgets an unpriced model at its recent siblings' prices, else at its whole family's", () => {
    const gpt4 = row("openai", "gpt-4", {
      release_date: "2023-03-14",
      cost: { input: 30, output: 60 },
    });
    const probe = {
      providerId: "openai",
      modelId: "gpt-7",
      probedAt: "2026-09-29T07:00:00Z",
      source: "openai GET /v1/models/gpt-7",
    };
    const withRecent = build({
      bundled: {
        rows: [
          gpt4,
          row("openai", "gpt-5.5", { release_date: "2026-04-01", cost: { input: 5, output: 20 } }),
        ],
      },
      probes: [probe],
    });
    expect(find(withRecent.rows, "openai/gpt-7")?.provenance?.budgetCost).toEqual({
      input: 5,
      output: 20,
    });

    const onlyOld = build({ bundled: { rows: [gpt4] }, probes: [probe] });
    expect(find(onlyOld.rows, "openai/gpt-7")?.provenance?.budgetCost).toEqual({
      input: 30,
      output: 60,
    });
  });

  it("merges user models over the catalog, hankweave.json over hank.json, and reports an unknown basedOn", () => {
    const built = build({
      bundled: { rows: [row("anthropic", "claude-sonnet-5", { cost: { input: 2, output: 10 } })] },
      user: [
        {
          origin: "hank.json",
          models: [
            {
              id: "anthropic/claude-sonnet-6",
              basedOn: "anthropic/claude-sonnet-5",
              cost: { input: 5, output: 25 },
            },
            { id: "anthropic/claude-ghost", basedOn: "anthropic/claude-missing" },
          ],
        },
        {
          origin: "hankweave.json",
          models: [
            {
              id: "anthropic/claude-sonnet-6",
              basedOn: "anthropic/claude-sonnet-5",
              cost: { input: 3, output: 15 },
            },
          ],
        },
      ],
    });
    const model = find(built.rows, "anthropic/claude-sonnet-6");
    expect(model?.cost).toEqual({
      input: 3,
      output: 15,
      cache_read: undefined,
      cache_write: undefined,
    });
    expect(model?.limit).toEqual({ context: 200000, output: 64000 });
    expect(model?.provenance?.confidence).toBe("user");
    expect(model?.provenance?.source).toBe("hankweave.json models block");
    expect(find(built.rows, "anthropic/claude-ghost")).toBeUndefined();
    expect(built.problems).toEqual([
      "hank.json models: 'anthropic/claude-ghost' is based on 'anthropic/claude-missing', which is not in the model catalog",
    ]);
  });

  it("a models block that corrects a registry record's price leaves it a registry record", () => {
    const built = build({
      bundled: {
        rows: [
          row("anthropic", "claude-sonnet-5", { release_date: "2026-06-29" }),
          row("anthropic", "claude-sonnet-5-5", { release_date: "2026-09-22" }),
        ],
      },
      user: [
        {
          origin: "hank.json",
          models: [{ id: "anthropic/claude-sonnet-5-5", cost: { input: 2.5, output: 12 } }],
        },
      ],
    });
    const corrected = find(built.rows, "anthropic/claude-sonnet-5-5");
    expect(corrected?.cost).toMatchObject({ input: 2.5, output: 12 });
    expect(corrected?.provenance).toMatchObject({
      confidence: "registry",
      source: "models.dev snapshot (bundled)",
      priceDeclared: true,
      priceSource: "hank.json models block",
    });
  });

  it("a models entry that prices only input and output keeps its base record's cache rates", () => {
    const cached = { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 };
    const built = build({
      bundled: { rows: [row("anthropic", "claude-sonnet-5-5", { cost: cached })] },
      user: [
        {
          origin: "hank.json",
          models: [
            { id: "anthropic/claude-sonnet-5-5", cost: { input: 3, output: 15 } },
            {
              id: "anthropic/claude-sonnet-6",
              basedOn: "anthropic/claude-sonnet-5-5",
              cost: { input: 3, output: 15, cacheRead: 0.3 },
            },
          ],
        },
      ],
    });
    expect(find(built.rows, "anthropic/claude-sonnet-5-5")?.cost).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.2,
      cache_write: 2.5,
    });
    expect(find(built.rows, "anthropic/claude-sonnet-6")?.cost).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 2.5,
    });
  });

  it("refuses a models entry whose provider the catalog does not list", () => {
    const built = build({
      bundled: { rows: [row("deepseek", "deepseek-v4-pro")] },
      user: [
        {
          origin: "hank.json",
          models: [
            { id: "brand-new-cloud/model-a", limit: { context: 1000, output: 100 } },
            { id: "deepseek/deepseek-v4-flash", basedOn: "deepseek/deepseek-v4-pro" },
          ],
        },
      ],
    });
    expect(find(built.rows, "brand-new-cloud/model-a")).toBeUndefined();
    expect(find(built.rows, "deepseek/deepseek-v4-flash")?.provenance?.confidence).toBe("user");
    expect(built.problems).toEqual([
      "hank.json models: 'brand-new-cloud/model-a' names provider 'brand-new-cloud', which the model catalog does not list, and a models entry cannot add a provider; Pi's own catalog decides whether 'brand-new-cloud/model-a' runs",
    ]);
  });

  it("points a models entry for a pricing-aliased provider at the provider it is priced under", () => {
    const built = build({
      bundled: { rows: [row("openai", "gpt-6-luna")] },
      user: [
        {
          origin: "hankweave.json",
          models: [{ id: "openai-codex/gpt-6-luna", cost: { input: 9, output: 9 } }],
        },
      ],
    });
    expect(find(built.rows, "openai-codex/gpt-6-luna")).toBeUndefined();
    expect(built.problems).toHaveLength(1);
    expect(built.problems[0]).toContain("declare it as 'openai/gpt-6-luna'");
  });
});

describe("familyKey", () => {
  it.each([
    ["claude-sonnet-5-5", "claude-sonnet"],
    ["claude-3-5-sonnet-20241022", "claude-sonnet"],
    ["gpt-6-luna", "gpt-luna"],
    ["gemini-3.8-flash", "gemini-flash"],
    ["deepseek-v4-pro", "deepseek-pro"],
  ])("%s → %s", (modelId, family) => {
    expect(familyKey({ modelId })).toBe(family);
  });

  it("prefers models.dev's own family field", () => {
    expect(familyKey({ modelId: "claude-sonnet-5-5", family: "Claude-Sonnet" })).toBe(
      "claude-sonnet",
    );
  });
});

describe("row-by-row parsing", () => {
  it("skips a malformed row in hankweave's data file and keeps the rest", () => {
    const parsed = parseModelsDataRows({
      version: "1.0.0",
      lastUpdated: "2026-09-25T00:00:00Z",
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: [
            row("anthropic", "claude-good"),
            { ...row("anthropic", "claude-bad"), limit: { context: -1, output: 5 } },
          ],
        },
        "not-a-provider",
      ],
    });
    expect(parsed.rows.map((r) => r.modelId)).toEqual(["claude-good"]);
    expect(parsed.skipped.map((s) => s.key)).toEqual(["anthropic/claude-bad", "providers[1]"]);
    expect(parsed.lastUpdated).toBe("2026-09-25T00:00:00Z");
  });

  it("transforms models.dev's api.json, skipping unknown-limit and malformed rows", () => {
    const upstream = (extra: Record<string, unknown> = {}) => ({
      name: "M",
      family: "fam",
      attachment: false,
      reasoning: true,
      tool_call: true,
      release_date: "2026-09-01",
      last_updated: "2026-09-01",
      cost: { input: 1, output: 2 },
      limit: { context: 1000, output: 100 },
      modalities: { input: ["text"], output: ["text"] },
      ...extra,
    });
    const parsed = transformModelsDevApi({
      acme: {
        name: "Acme",
        models: {
          good: upstream(),
          unlimited: upstream({ limit: { context: 0, output: 0 } }),
          broken: upstream({ tool_call: "yes" }),
        },
      },
    });
    expect(parsed.rows.map((r) => r.modelId)).toEqual(["good"]);
    expect(parsed.rows[0]?.family).toBe("fam");
    expect(parsed.skipped.map((s) => s.key).sort()).toEqual(["acme/broken", "acme/unlimited"]);

    const file = toModelsData(parsed, "2026-09-29T00:00:00Z");
    expect(parseModelsDataRows(file).rows).toEqual(parsed.rows);
  });
});

describe("normalizeLiteLlmPrices", () => {
  it("keeps first-party chat rows, strips the provider prefix, and converts to per-million", () => {
    const prices = normalizeLiteLlmPrices({
      "claude-sonnet-5-5": {
        litellm_provider: "anthropic",
        mode: "chat",
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
        cache_read_input_token_cost: 3e-7,
      },
      "gemini/gemini-3.8-flash": {
        litellm_provider: "gemini",
        mode: "chat",
        input_cost_per_token: 7.5e-7,
        output_cost_per_token: 3.75e-6,
      },
      "text-embedding-9": {
        litellm_provider: "openai",
        mode: "embedding",
        input_cost_per_token: 1e-7,
        output_cost_per_token: 0,
      },
      "bedrock/us-east-1/anthropic.claude-x": {
        litellm_provider: "bedrock",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 5e-6,
      },
      "openrouter/some/model": {
        litellm_provider: "openrouter",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 5e-6,
      },
      sample_spec: { note: "not a row" },
    });
    expect(prices).toEqual({
      "anthropic/claude-sonnet-5-5": { input: 3, output: 15, cache_read: 0.3 },
      "google/gemini-3.8-flash": { input: 0.75, output: 3.75 },
    });
  });
});

describe("modelOverlaySchema", () => {
  it("rejects name data (aliases, retirements) and any other field outside the schema", () => {
    for (const extra of [
      { aliases: [] },
      { retired: [] },
      { baseUrls: { anthropic: "https://evil.example" } },
    ]) {
      expect(modelOverlaySchema.safeParse({ ...emptyOverlay, ...extra }).success).toBe(false);
    }
  });

  it("matches ids exactly: an entry written with other capitals does not apply", () => {
    const overlay = modelOverlaySchema.parse({
      ...emptyOverlay,
      corrections: [
        {
          model: "anthropic/Claude-Haiku-4-5",
          cost: { input: 9, output: 9 },
          reason: "r",
          source: "https://example.com",
        },
      ],
    });
    const built = build({
      bundled: { rows: [row("anthropic", "claude-haiku-4-5")] },
      overlay: { data: overlay, source: "bundled overlay" },
    });
    // Ids are case-sensitive (spec 72): Claude-Haiku-4-5 is not claude-haiku-4-5.
    expect(built.rows[0]?.cost).not.toMatchObject({ input: 9, output: 9 });
  });

  it("keeps ids that differ only by case apart", () => {
    const built = build({
      bundled: { rows: [row("anthropic", "ReviewModel"), row("anthropic", "reviewmodel")] },
    });
    expect(built.rows.map((r) => r.modelId).sort()).toEqual(["ReviewModel", "reviewmodel"]);
  });
});
