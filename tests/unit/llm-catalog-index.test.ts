/**
 * Unit tests for the strict catalog index and the suggestion ranking behind
 * model errors (spec 72, step 2):
 *
 * - CatalogIndex: exact, case-sensitive "provider/model" lookup; the
 *   case-insensitive index exists only to name the right casing in a
 *   wrong-case error; rows of providers no harness runs are dropped at load;
 *   OpenAI reasoning models gain "-high"/"-xhigh" effort variants.
 * - suggestions.ts: "did you mean" ranking. Nothing here resolves a model.
 */

import { describe, expect, test } from "bun:test";
import { CatalogIndex } from "../../server/llm/internal/catalog-index";
import type { ModelInfo } from "../../server/llm/internal/models-dev-schema";
import { closestNames, similarity, suggestIds } from "../../server/llm/internal/suggestions";

const row = (
  providerId: string,
  modelId: string,
  release: string,
  extra: Partial<ModelInfo> = {},
): ModelInfo => ({
  providerId,
  modelId,
  name: modelId,
  attachment: false,
  reasoning: false,
  tool_call: true,
  cost: { input: 1, output: 5 },
  limit: { context: 200000, output: 64000 },
  modalities: { input: ["text"], output: ["text"] },
  release_date: release,
  last_updated: release,
  ...extra,
});

const ROWS: ModelInfo[] = [
  row("anthropic", "claude-sonnet-5-5", "2026-09-28"),
  row("anthropic", "claude-sonnet-5", "2026-06-29"),
  row("anthropic", "claude-sonnet-4-5-20250929", "2025-09-29"),
  row("anthropic", "claude-haiku-4-5", "2025-10-15"),
  // A reseller listing a first-party id, and a reasoning model that is not OpenAI's.
  row("opencode", "claude-sonnet-5-5", "2026-09-28"),
  row("opencode", "gpt-5.4", "2026-03-05", { reasoning: true }),
  // zhipuai has no client in any harness; zai serves the same ids.
  row("zhipuai", "glm-5.2", "2026-08-01"),
  row("zai", "glm-5.2", "2026-08-01"),
  row("openai", "gpt-5.6-sol", "2026-06-01", {
    reasoning: true,
    cost: { input: 4, output: 20, cache_read: 0.4 },
    provenance: {
      confidence: "registry",
      source: "fixture",
      priceStatus: "disputed",
      budgetCost: { input: 5, output: 25 },
    },
  }),
  row("openai", "gpt-4o", "2024-05-13"),
  row("google", "gemini-3.8-flash", "2026-09-02"),
  row("google", "gemini-3.8-flash-lite", "2026-09-10"),
  row("google", "gemini-3.7-flash", "2026-05-02"),
  // Ids with capitals exist (models.dev lists them verbatim).
  row("huggingface", "tencent/Hy3", "2026-07-01"),
];

const UNRUNNABLE = new Set(["zhipuai"]);
const index = new CatalogIndex(ROWS, (provider) => !UNRUNNABLE.has(provider));
const idOf = (m: ModelInfo | undefined) => (m ? `${m.providerId}/${m.modelId}` : undefined);

describe("CatalogIndex — exact lookup", () => {
  test("get finds a record by its exact provider and id", () => {
    expect(idOf(index.get("anthropic", "claude-sonnet-5-5"))).toBe("anthropic/claude-sonnet-5-5");
    expect(idOf(index.get("huggingface", "tencent/Hy3"))).toBe("huggingface/tencent/Hy3");
  });

  test("get never folds case, in the provider or the id", () => {
    expect(index.get("Anthropic", "claude-sonnet-5-5")).toBeUndefined();
    expect(index.get("anthropic", "Claude-Sonnet-5-5")).toBeUndefined();
    expect(index.get("huggingface", "tencent/hy3")).toBeUndefined();
  });

  test("get never infers, expands or substitutes", () => {
    expect(index.get("anthropic", "sonnet")).toBeUndefined();
    expect(index.get("anthropic", "claude-sonnet")).toBeUndefined();
    expect(index.get("anthropic", "claude-sonnet-4-5")).toBeUndefined();
    expect(index.get("", "claude-sonnet-5-5")).toBeUndefined();
  });

  test("getIgnoringCase names the record a wrongly cased spelling meant", () => {
    expect(idOf(index.getIgnoringCase("Anthropic", "Claude-Sonnet-5-5"))).toBe(
      "anthropic/claude-sonnet-5-5",
    );
    expect(idOf(index.getIgnoringCase("huggingface", "TENCENT/hy3"))).toBe(
      "huggingface/tencent/Hy3",
    );
    expect(idOf(index.getIgnoringCase("OpenAI", "GPT-5.6-Sol-XHigh"))).toBe(
      "openai/gpt-5.6-sol-xhigh",
    );
    expect(index.getIgnoringCase("anthropic", "claude-sonnet-9")).toBeUndefined();
  });

  test("the first record of a duplicated key wins", () => {
    const first = row("anthropic", "claude-haiku-4-5", "2025-10-15", { name: "first" });
    const second = row("anthropic", "claude-haiku-4-5", "2025-10-15", { name: "second" });
    const dup = new CatalogIndex([first, second], () => true);
    expect(dup.get("anthropic", "claude-haiku-4-5")?.name).toBe("first");
    expect(dup.rowsOf("anthropic")).toHaveLength(1);
  });

  test("sameModelId lists every provider carrying the identical id", () => {
    expect(index.sameModelId("claude-sonnet-5-5").map(idOf)).toEqual([
      "anthropic/claude-sonnet-5-5",
      "opencode/claude-sonnet-5-5",
    ]);
    expect(index.sameModelId("Claude-Sonnet-5-5")).toEqual([]);
    expect(index.sameModelId("claude-sonnet")).toEqual([]);
  });

  test("hasProvider, providers and rowsOf describe the loaded providers", () => {
    expect(index.hasProvider("anthropic")).toBe(true);
    expect(index.hasProvider("Anthropic")).toBe(false);
    expect(index.providers().sort()).toEqual([
      "anthropic",
      "google",
      "huggingface",
      "openai",
      "opencode",
      "zai",
    ]);
    expect(index.rowsOf("google").map((m) => m.modelId)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.8-flash-lite",
      "gemini-3.7-flash",
    ]);
    expect(index.rowsOf("nobody")).toEqual([]);
  });
});

describe("CatalogIndex — providers no harness runs", () => {
  test("their rows are dropped at load and counted", () => {
    expect([...index.dropped]).toEqual(["zhipuai"]);
    expect(index.droppedRows).toBe(1);
  });

  test("a dropped provider's rows neither resolve nor appear anywhere", () => {
    expect(index.get("zhipuai", "glm-5.2")).toBeUndefined();
    expect(index.getIgnoringCase("zhipuai", "glm-5.2")).toBeUndefined();
    expect(index.hasProvider("zhipuai")).toBe(false);
    expect(index.rowsOf("zhipuai")).toEqual([]);
    expect(index.sameModelId("glm-5.2").map(idOf)).toEqual(["zai/glm-5.2"]);
    expect([...index.rows()].some((m) => m.providerId === "zhipuai")).toBe(false);
  });

  test("every row is kept when every provider is runnable", () => {
    const all = new CatalogIndex(ROWS, () => true);
    expect(all.dropped.size).toBe(0);
    expect(all.droppedRows).toBe(0);
    expect([...all.rows()]).toHaveLength(ROWS.length);
  });
});

describe("CatalogIndex — reasoning-effort variants", () => {
  test("an OpenAI reasoning model gains -high and -xhigh variants", () => {
    const high = index.get("openai", "gpt-5.6-sol-high");
    const xhigh = index.get("openai", "gpt-5.6-sol-xhigh");
    expect(high?.name).toBe("gpt-5.6-sol (high)");
    expect(xhigh?.name).toBe("gpt-5.6-sol (xhigh)");
    expect(high?.providerId).toBe("openai");
  });

  test("-high is priced at the base rate and -xhigh at twice it", () => {
    expect(index.get("openai", "gpt-5.6-sol-high")?.cost).toEqual({
      input: 4,
      output: 20,
      cache_read: 0.4,
    });
    expect(index.get("openai", "gpt-5.6-sol-xhigh")?.cost).toEqual({
      input: 8,
      output: 40,
      cache_read: 0.8,
    });
  });

  test("budget rates scale with the variant too", () => {
    expect(index.get("openai", "gpt-5.6-sol-xhigh")?.provenance?.budgetCost).toEqual({
      input: 10,
      output: 50,
    });
    expect(index.get("openai", "gpt-5.6-sol-high")?.provenance?.budgetCost).toEqual({
      input: 5,
      output: 25,
    });
  });

  test("only OpenAI's reasoning models get variants", () => {
    expect(index.get("openai", "gpt-4o-high")).toBeUndefined();
    expect(index.get("opencode", "gpt-5.4-high")).toBeUndefined();
    expect(index.get("anthropic", "claude-sonnet-5-5-high")).toBeUndefined();
  });

  test("variants stay out of rows, rowsOf and sameModelId unless asked for", () => {
    expect([...index.rows()].some((m) => m.modelId.endsWith("-high"))).toBe(false);
    expect(index.rowsOf("openai").map((m) => m.modelId)).toEqual(["gpt-5.6-sol", "gpt-4o"]);
    expect(index.rowsOf("openai", true).map((m) => m.modelId)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-sol-high",
      "gpt-5.6-sol-xhigh",
      "gpt-4o",
    ]);
    expect(index.sameModelId("gpt-5.6-sol-high")).toEqual([]);
  });

  test("a catalog row with a variant's id wins over the synthesized variant", () => {
    const listed = row("openai", "gpt-5.6-sol-high", "2026-06-01", {
      reasoning: true,
      cost: { input: 7, output: 7 },
    });
    const withListed = new CatalogIndex(
      [row("openai", "gpt-5.6-sol", "2026-06-01", { reasoning: true }), listed],
      () => true,
    );
    expect(withListed.get("openai", "gpt-5.6-sol-high")?.cost).toEqual({ input: 7, output: 7 });
  });
});

describe("suggestions — similarity and closestNames", () => {
  test("similarity is a case-insensitive Levenshtein ratio", () => {
    expect(similarity("anthropic", "anthropic")).toBe(1);
    expect(similarity("Anthropic", "ANTHROPIC")).toBe(1);
    expect(similarity("", "anthropic")).toBe(0);
    expect(similarity("anthropc", "anthropic")).toBeCloseTo(8 / 9);
  });

  test("closestNames ranks near misses first and drops distant names", () => {
    const providers = ["anthropic", "amazon-bedrock", "openai", "openai-codex", "zai"];
    expect(closestNames("anthropc", providers)).toEqual(["anthropic"]);
    expect(closestNames("openai-codx", providers)).toEqual(["openai-codex"]);
    expect(closestNames("deepinfra", providers)).toEqual([]);
  });

  test("closestNames breaks score ties by name and honours the limit", () => {
    expect(closestNames("abc", ["abe", "abd", "xyz"])).toEqual(["abd", "abe"]);
    expect(closestNames("abc", ["abe", "abd"], 1)).toEqual(["abd"]);
  });
});

describe("suggestions — suggestIds", () => {
  const all = () => index.rows();

  test("a partial dated id suggests the full dated id first", () => {
    expect(suggestIds("claude-sonnet-4-5-2025", all())[0]).toBe(
      "anthropic/claude-sonnet-4-5-20250929",
    );
  });

  test("nothing is suggested when nothing is similar enough", () => {
    expect(suggestIds("totally-nonexistent-xyz123", all())).toEqual([]);
  });

  test("candidates bound the suggestions (within one provider)", () => {
    const suggestions = suggestIds("gemini-3.8-flashh", index.rowsOf("google"));
    expect(suggestions).toContain("google/gemini-3.8-flash");
    expect(suggestions.every((s) => s.startsWith("google/"))).toBe(true);
  });

  test("close scores prefer whole-word matches, then the newest", () => {
    expect(suggestIds("claude-sonnet", index.rowsOf("anthropic"))).toEqual([
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-4-5-20250929",
    ]);
  });

  test("at most `limit` ids, three by default", () => {
    expect(suggestIds("claude-sonnet", index.rowsOf("anthropic"), 1)).toEqual([
      "anthropic/claude-sonnet-5-5",
    ]);
    expect(suggestIds("claude", all()).length).toBeLessThanOrEqual(3);
  });

  test("effort variants are left out unless the query names an effort", () => {
    const openai = index.rowsOf("openai", true);
    expect(suggestIds("gpt-5.6-sool", openai)).toEqual(["openai/gpt-5.6-sol"]);
    expect(suggestIds("gpt-5.6-sool-xhigh", openai)).toContain("openai/gpt-5.6-sol-xhigh");
  });

  test("suggestions are copy-pasteable provider/model ids, never a resolution", () => {
    for (const id of suggestIds("claude-sonnet-5-6", all())) {
      expect(id).toMatch(/^[a-z0-9-]+\/.+/);
    }
    // The exact id is not in the catalog: suggestions are all the index offers.
    expect(index.get("anthropic", "claude-sonnet-5-6")).toBeUndefined();
  });
});
