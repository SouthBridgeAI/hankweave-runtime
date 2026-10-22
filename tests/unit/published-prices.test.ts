import { describe, expect, it } from "bun:test";
import { bundledCatalogSnapshot } from "../../server/llm/internal/catalog-store.js";
import type { ModelCost } from "../../server/llm/internal/models-dev-schema.js";
import { priceUsage } from "../../server/llm/internal/pricing.js";

/**
 * Rates copied by hand from each provider's own pricing page, for the models
 * hanks and tests run (spec 70, "Prices and budgets"). The bundled snapshot
 * plus the overlay must reproduce them: models.dev and LiteLLM are both
 * second-hand, and the LiteLLM cross-check only raises budgets, so a rate
 * that is too high, or a wrong cache rate, passes it (the snapshot of
 * 2026-09-29 listed Sonnet 5.5's cache read at twice the published rate).
 *
 * When this fails after a snapshot refresh, check the page first: prices do
 * change (gpt-5.6-sol's rate is promotional through 2026-11-21; Gemini 3.8
 * Flash doubles on 2027-01-01). Cache write is the shortest TTL the page
 * lists (Anthropic 5m, OpenAI 30m). Gemini bills cache storage per hour,
 * not per written token, so it has no cache_write rate.
 */
interface PublishedPrice {
  model: string;
  url: string;
  /** When the page was read. */
  checked: string;
  cost: NonNullable<ModelCost>;
}

const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
const GOOGLE = "https://ai.google.dev/gemini-api/docs/pricing";

const PUBLISHED: PublishedPrice[] = [
  {
    model: "anthropic/claude-haiku-4-5",
    url: ANTHROPIC,
    checked: "2026-10-21",
    cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  },
  {
    model: "anthropic/claude-sonnet-4-6",
    url: ANTHROPIC,
    checked: "2026-10-21",
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  {
    model: "anthropic/claude-opus-4-6",
    url: ANTHROPIC,
    checked: "2026-10-21",
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  // Cache hits on Sonnet 5.5 and Opus 5.5 are 0.05x input (page footnote 2).
  {
    model: "anthropic/claude-sonnet-5-5",
    url: ANTHROPIC,
    checked: "2026-10-21",
    cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
  },
  {
    model: "anthropic/claude-opus-5-5",
    url: ANTHROPIC,
    checked: "2026-10-21",
    cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  },
  // Cache hits on Fable 5.1 are 0.025x input (page footnote 1).
  {
    model: "anthropic/claude-fable-5-1",
    url: ANTHROPIC,
    checked: "2026-10-21",
    cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  },
  // OpenAI lists no cache write rate for GPT-5.2: writes cost nothing beyond input.
  {
    model: "openai/gpt-5.2",
    url: OPENAI,
    checked: "2026-10-21",
    cost: { input: 1.75, output: 14, cache_read: 0.175 },
  },
  {
    model: "openai/gpt-5.6-sol",
    url: OPENAI,
    checked: "2026-10-21",
    cost: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 },
  },
  {
    model: "openai/gpt-5.6-terra",
    url: OPENAI,
    checked: "2026-10-21",
    cost: { input: 2, output: 12, cache_read: 0.2, cache_write: 2.5 },
  },
  {
    model: "openai/gpt-5.6-luna",
    url: OPENAI,
    checked: "2026-10-21",
    cost: { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 },
  },
  {
    model: "google/gemini-2.5-flash",
    url: GOOGLE,
    checked: "2026-10-21",
    cost: { input: 0.3, output: 2.5, cache_read: 0.03 },
  },
  {
    model: "google/gemini-3.8-flash",
    url: GOOGLE,
    checked: "2026-10-21",
    cost: { input: 0.75, output: 3.75, cache_read: 0.075 },
  },
];

/** A million fresh input tokens, 200k output, 500k cache reads, 100k cache writes. */
const MIX = {
  inputTokens: 1_000_000,
  outputTokens: 200_000,
  cacheReadTokens: 500_000,
  cacheCreationTokens: 100_000,
};

/** Dollars for MIX, worked by hand from the page: input + 0.2·output + 0.5·cache_read + 0.1·cache_write. */
const EXPECTED_MIX_COST: Record<string, number> = {
  "anthropic/claude-haiku-4-5": 1 + 1 + 0.05 + 0.125,
  "anthropic/claude-sonnet-5-5": 2 + 2 + 0.05 + 0.25,
  "openai/gpt-5.6-sol": 4 + 4 + 0.2 + 0.5,
  "openai/gpt-5.2": 1.75 + 2.8 + 0.0875,
  "google/gemini-3.8-flash": 0.75 + 0.75 + 0.0375,
};

const record = (key: string) =>
  bundledCatalogSnapshot().rows.find((row) => `${row.providerId}/${row.modelId}` === key);

describe("published prices", () => {
  for (const entry of PUBLISHED) {
    it(`${entry.model} is priced as ${entry.url} listed on ${entry.checked}`, () => {
      const row = record(entry.model);
      expect(row).toBeDefined();
      expect(row?.cost).toEqual(entry.cost);
      expect(row?.provenance?.priceStatus).toBe("known");
      expect(row?.provenance?.budgetCost).toBeUndefined();
    });
  }

  for (const [key, dollars] of Object.entries(EXPECTED_MIX_COST)) {
    it(`${key} prices a fixed token mix at the published rates`, () => {
      const row = record(key);
      expect(row).toBeDefined();
      if (!row) return;
      const priced = priceUsage(row, MIX);
      expect(priced?.estimated).toBe(false);
      expect(priced?.cost).toBeCloseTo(dollars, 10);
    });
  }
});
