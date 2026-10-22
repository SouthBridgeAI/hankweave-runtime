/**
 * Stage 0 of model validation (spec 72, "The grammar" and "Error message
 * catalogue"): a spelling is "<provider>/<model>" in the exact case, for a
 * provider some harness runs. Trim is the only normalisation; nothing is
 * inferred, expanded, aliased or corrected. A failure names what to write
 * instead (classes A no provider, B unrunnable provider, D wrong case,
 * I "pi/" without a provider).
 *
 * The first half drives parseSpelling over a fixture catalog and fake
 * harness lists, so the exact message text is pinned independent of Pi's
 * provider list. The second half goes through the door the rest of
 * hankweave uses, Models.current().check, under the parse-mode Models the
 * test preload installs over the bundled catalog.
 */

import { describe, expect, test } from "bun:test";
import { PiModelCheck } from "../../server/harness/pi/model-check";
import { codonHarnesses, modelHarnesses, sentinelHarnesses } from "../../server/harnesses";
import { type HarnessModelCheck, type ModelCheck, Models } from "../../server/llm/index";
import { CatalogIndex } from "../../server/llm/internal/catalog-index";
import { bundledCatalogSnapshot } from "../../server/llm/internal/catalog-store";
import type { ModelInfo } from "../../server/llm/internal/models-dev-schema";
import { formerShortcutHint } from "../../server/llm/internal/name-hints";
import { parseSpelling } from "../../server/llm/internal/spelling";
import { runsOnClaudeAgentSdk, selectHarness } from "../../server/provider-ids";

// === Fixture catalog and harnesses ===

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
  row("anthropic", "claude-haiku-4-5-20251001", "2025-10-15"),
  row("amazon-bedrock", "us.anthropic.claude-opus-5-5-v1:0", "2026-09-22"),
  row("opencode", "claude-sonnet-5-5", "2026-09-28"),
  row("opencode", "gpt-5.4", "2026-03-05"),
  row("zhipuai", "glm-5.2", "2026-08-01"),
  row("zai", "glm-5.2", "2026-08-01"),
  row("deepseek", "deepseek-v4-pro", "2026-09-10"),
  row("openai", "gpt-5.6-sol", "2026-06-01", { reasoning: true }),
  row("google", "gemini-3.8-flash", "2026-09-02"),
  row("google", "gemini-3.8-flash-lite", "2026-09-10"),
  row("openrouter", "moonshotai/kimi-k3", "2026-07-15"),
];

function fakeHarness(
  harness: string,
  label: string,
  providers: string[],
  runs: (provider: string, modelId: string) => boolean = (p) => providers.includes(p),
): HarnessModelCheck {
  return {
    harness,
    label,
    providers: () => providers,
    runs,
    check: () => Promise.reject(new Error("stage 0 never asks a harness")),
  };
}

const CLAUDE = fakeHarness(
  "claude-agent-sdk",
  "the Claude Agent SDK",
  ["anthropic", "amazon-bedrock"],
  runsOnClaudeAgentSdk,
);
const PI = fakeHarness("pi", "Pi", [
  "anthropic",
  "amazon-bedrock",
  "deepseek",
  "google",
  "openai",
  "openai-codex",
  "opencode",
  "openrouter",
  "zai",
]);
const AI_SDK = fakeHarness("ai-sdk", "the AI SDK", ["anthropic", "openai", "google", "deepseek"]);

const RUNNABLE = new Set([CLAUDE, PI, AI_SDK].flatMap((h) => h.providers()));
const index = new CatalogIndex(ROWS, (provider) => RUNNABLE.has(provider));

const parse = (spelling: string, use: "codon" | "sentinel" = "codon") =>
  parseSpelling(spelling, {
    index,
    harnesses: use === "codon" ? [CLAUDE, PI] : [AI_SDK],
    use,
  });

const CODON_HARNESSES =
  "the Claude Agent SDK runs anthropic, amazon-bedrock; Pi runs anthropic, amazon-bedrock, " +
  "deepseek, google, openai, openai-codex, opencode, openrouter, zai";
const RULE = "Write models as '<provider>/<model>'.";

// === Stage 0 over the fixture catalog ===

describe("parseSpelling — what parses", () => {
  test("provider/model in the exact case parses to its parts", () => {
    expect(parse("anthropic/claude-haiku-4-5")).toEqual({
      ok: true,
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      piForced: false,
    });
  });

  test("trim is the only normalisation", () => {
    expect(parse("  anthropic/claude-haiku-4-5\n")).toMatchObject({
      ok: true,
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
    });
    // Inner whitespace is part of the provider name, which no harness runs.
    expect(parse("anthropic /claude-haiku-4-5")).toMatchObject({
      ok: false,
      kind: "unrunnable-provider",
    });
  });

  test("stage 0 does not ask whether the model exists (the harness does)", () => {
    expect(parse("anthropic/claude-sonnet-9")).toMatchObject({
      ok: true,
      modelId: "claude-sonnet-9",
    });
    expect(parse("anthropic/claude-new-Model")).toMatchObject({
      ok: true,
      modelId: "claude-new-Model",
    });
  });

  test("openrouter/<org>/<model> keeps the rest of the spelling as the id", () => {
    expect(parse("openrouter/moonshotai/kimi-k3")).toEqual({
      ok: true,
      provider: "openrouter",
      modelId: "moonshotai/kimi-k3",
      piForced: false,
    });
  });

  test("openai-codex/<model> parses as its own provider", () => {
    expect(parse("openai-codex/gpt-5.6-sol")).toEqual({
      ok: true,
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      piForced: false,
    });
  });

  test("pi/<provider>/<model> forces Pi", () => {
    expect(parse("pi/anthropic/claude-haiku-4-5")).toEqual({
      ok: true,
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      piForced: true,
    });
    expect(parse("pi/openrouter/moonshotai/kimi-k3")).toEqual({
      ok: true,
      provider: "openrouter",
      modelId: "moonshotai/kimi-k3",
      piForced: true,
    });
  });

  test("an OpenAI effort variant parses with its suffix in the id", () => {
    expect(parse("openai/gpt-5.6-sol-xhigh")).toMatchObject({
      ok: true,
      provider: "openai",
      modelId: "gpt-5.6-sol-xhigh",
    });
  });
});

describe("parseSpelling — A: no provider", () => {
  test("a former shortcut word names the newest id of its family", () => {
    const result = parse("sonnet");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("no-provider");
    expect(result.suggestions).toEqual([
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-4-5-20250929",
    ]);
    expect(result.message).toStartWith(
      "'sonnet' is not a model id; model shortcuts were removed. The newest Anthropic Sonnet is anthropic/claude-sonnet-5-5",
    );
    expect(result.message).toContain(
      "others: anthropic/claude-sonnet-5, anthropic/claude-sonnet-4-5-20250929",
    );
    expect(result.message).toEndWith(RULE);
  });

  // The catalogue's sentence carries the alternatives before its full stop
  // ("… is anthropic/claude-sonnet-5-5 (others: …)."); spelling.ts appends
  // "(others: …)" after the hint sentence's own period instead.
  test("the former-shortcut message reads as the catalogue writes it", () => {
    const result = parse("sonnet");
    expect(result.ok || result.message).toBe(
      "'sonnet' is not a model id; model shortcuts were removed. The newest Anthropic Sonnet is " +
        "anthropic/claude-sonnet-5-5 (others: anthropic/claude-sonnet-5, " +
        `anthropic/claude-sonnet-4-5-20250929). ${RULE}`,
    );
  });

  test("a former shortcut with one member has no 'others'", () => {
    expect(parse("gemini-flash")).toEqual({
      ok: false,
      kind: "no-provider",
      message:
        "'gemini-flash' is not a model id; model shortcuts were removed. The newest Gemini Flash " +
        `is google/gemini-3.8-flash. ${RULE}`,
      suggestions: ["google/gemini-3.8-flash"],
    });
  });

  test("a former shortcut whose family the catalog lacks still says shortcuts are gone", () => {
    expect(parse("fable")).toEqual({
      ok: false,
      kind: "no-provider",
      message: `'fable' is not a model id; model shortcuts were removed. ${RULE}`,
      suggestions: [],
    });
  });

  test("a bare id lists the providers carrying it, the maker first", () => {
    expect(parse("claude-sonnet-5-5")).toEqual({
      ok: false,
      kind: "no-provider",
      message:
        `Model 'claude-sonnet-5-5' has no provider. ${RULE} ` +
        "Ids with this name: anthropic/claude-sonnet-5-5, opencode/claude-sonnet-5-5.",
      suggestions: ["anthropic/claude-sonnet-5-5", "opencode/claude-sonnet-5-5"],
    });
  });

  test("a bare id only an unrunnable provider shares is offered under the runnable one", () => {
    expect(parse("glm-5.2")).toEqual({
      ok: false,
      kind: "no-provider",
      message: `Model 'glm-5.2' has no provider. ${RULE} Ids with this name: zai/glm-5.2.`,
      suggestions: ["zai/glm-5.2"],
    });
  });

  test("a bare id no provider lists suggests the closest ids", () => {
    const result = parse("claude-sonnet-4-5-2025");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("no-provider");
    expect(result.suggestions[0]).toBe("anthropic/claude-sonnet-4-5-20250929");
    expect(result.message).toBe(
      `Model 'claude-sonnet-4-5-2025' has no provider. ${RULE} Closest: ${result.suggestions.join(", ")}.`,
    );
  });

  // opencode (a reseller) also lists a gpt-* id; openai's catalog is all
  // gpt-*, so openai is the line's maker and its ids come first.
  test("a bare id no provider lists suggests the maker's ids first", () => {
    // The reseller's id is the closer spelling; the maker's still wins.
    const withReseller = new CatalogIndex(
      [...ROWS, row("opencode", "gpt-5.6-hi", "2026-06-01")],
      (p) => RUNNABLE.has(p),
    );
    const result = parseSpelling("gpt-5.6-high", {
      index: withReseller,
      harnesses: [CLAUDE, PI],
      use: "codon",
    });
    // The maker's effort variants count: "gpt-5.6-sol-high" is a spelling that runs.
    const closest = ["openai/gpt-5.6-sol-high", "openai/gpt-5.6-sol-xhigh", "openai/gpt-5.6-sol"];
    expect(result).toEqual({
      ok: false,
      kind: "no-provider",
      message: `Model 'gpt-5.6-high' has no provider. ${RULE} Closest: ${closest.join(", ")}.`,
      suggestions: closest,
    });
  });

  test("a bare id like nothing gets the rule alone", () => {
    expect(parse("totally-nonexistent-xyz123")).toEqual({
      ok: false,
      kind: "no-provider",
      message: `Model 'totally-nonexistent-xyz123' has no provider. ${RULE}`,
      suggestions: [],
    });
  });

  test("an empty spelling, or one missing a half, is refused", () => {
    expect(parse("   ")).toEqual({
      ok: false,
      kind: "no-provider",
      message: `Model is empty. ${RULE}`,
      suggestions: [],
    });
    for (const spelling of ["anthropic/", "/claude-haiku-4-5", "pi/anthropic/"]) {
      expect(parse(spelling)).toEqual({
        ok: false,
        kind: "no-provider",
        message: `Model '${spelling}' needs both a provider and a model id. ${RULE}`,
        suggestions: [],
      });
    }
  });
});

describe("formerShortcutHint", () => {
  test("prefers the undated alias over its dated snapshot", () => {
    expect(formerShortcutHint("haiku", ROWS)?.ids).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-haiku-4-5-20251001",
    ]);
  });

  test("gemini-flash never means a -lite sibling, even a newer one", () => {
    expect(formerShortcutHint("gemini-flash", ROWS)?.ids).toEqual(["google/gemini-3.8-flash"]);
  });

  test("matches the word case-insensitively and quotes it as written", () => {
    expect(formerShortcutHint("SONNET", ROWS)?.sentence).toStartWith("'SONNET' is not a model id;");
  });

  test("only looks in the family's own provider", () => {
    // The Bedrock opus row is an Opus, but the "opus" hint is Anthropic's.
    expect(formerShortcutHint("opus", ROWS)?.ids).toEqual([]);
  });

  test("is undefined for any word that was never a shortcut", () => {
    expect(formerShortcutHint("claude-sonnet-5-5", ROWS)).toBeUndefined();
    expect(formerShortcutHint("kimi-k3", ROWS)).toBeUndefined();
  });
});

describe("parseSpelling — B: unknown or unrunnable provider", () => {
  test("a provider no harness runs names who lists the same id", () => {
    expect(parse("zhipuai/glm-5.2")).toEqual({
      ok: false,
      kind: "unrunnable-provider",
      message:
        `'zhipuai' is not a provider hankweave can run (${CODON_HARNESSES}). ` +
        "The same model id is listed by: zai/glm-5.2.",
      suggestions: ["zai/glm-5.2"],
    });
  });

  test("a near miss of a runnable provider is a typo", () => {
    expect(parse("anthropc/claude-haiku-4-5")).toEqual({
      ok: false,
      kind: "unrunnable-provider",
      message:
        `'anthropc' is not a provider hankweave can run (${CODON_HARNESSES}). ` +
        "Did you mean 'anthropic'? Write 'anthropic/claude-haiku-4-5'.",
      suggestions: ["anthropic/claude-haiku-4-5"],
    });
  });

  test("a provider with neither a near name nor the same id gets the list alone", () => {
    expect(parse("deepinfra/some-model")).toEqual({
      ok: false,
      kind: "unrunnable-provider",
      message: `'deepinfra' is not a provider hankweave can run (${CODON_HARNESSES}).`,
      suggestions: [],
    });
  });

  test("a long provider list is cut at twelve", () => {
    const many = Array.from({ length: 14 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const result = parseSpelling("nobody/x", {
      index,
      harnesses: [fakeHarness("pi", "Pi", many)],
      use: "codon",
    });
    expect(result.ok || result.message).toBe(
      `'nobody' is not a provider hankweave can run (Pi runs ${many.slice(0, 12).join(", ")}, … (+2 more)).`,
    );
  });

  test("a long provider list leads with the names closest to what was written", () => {
    const many = [
      ...Array.from({ length: 14 }, (_, i) => `p${String(i).padStart(2, "0")}`),
      "moonshotai",
    ];
    const result = parseSpelling("moonshot/kimi-k3", {
      index,
      harnesses: [fakeHarness("pi", "Pi", many)],
      use: "codon",
    });
    expect(result.ok || result.message).toStartWith(
      "'moonshot' is not a provider hankweave can run (Pi runs moonshotai, p00, ",
    );
  });

  test("pi/ narrows the runnable set to Pi's providers", () => {
    const claudeOnly = fakeHarness(
      "claude-agent-sdk",
      "the Claude Agent SDK",
      ["anthropic"],
      (p) => p === "anthropic",
    );
    const piWithoutAnthropic = fakeHarness("pi", "Pi", ["openai"]);
    const result = parseSpelling("pi/anthropic/claude-haiku-4-5", {
      index,
      harnesses: [claudeOnly, piWithoutAnthropic],
      use: "codon",
    });
    expect(result).toMatchObject({ ok: false, kind: "unrunnable-provider" });
    expect(result.ok || result.message).toStartWith(
      "'anthropic' is not a provider hankweave can run (Pi runs openai).",
    );
  });
});

describe("parseSpelling — D: wrong case", () => {
  test("a wrongly cased provider and id name the exact spelling", () => {
    expect(parse("Anthropic/Claude-Sonnet-5-5")).toEqual({
      ok: false,
      kind: "wrong-case",
      message:
        "Model ids are case-sensitive: write 'anthropic/claude-sonnet-5-5' (you wrote 'Anthropic/Claude-Sonnet-5-5').",
      suggestions: ["anthropic/claude-sonnet-5-5"],
    });
  });

  test("a wrongly cased id under the right provider", () => {
    expect(parse("anthropic/Claude-Sonnet-5-5")).toMatchObject({
      ok: false,
      kind: "wrong-case",
      suggestions: ["anthropic/claude-sonnet-5-5"],
    });
  });

  test("a wrongly cased provider of an id the catalog lacks fixes the provider only", () => {
    expect(parse("Anthropic/claude-new-model")).toEqual({
      ok: false,
      kind: "wrong-case",
      message:
        "Model ids are case-sensitive: write 'anthropic/claude-new-model' (you wrote 'Anthropic/claude-new-model').",
      suggestions: ["anthropic/claude-new-model"],
    });
  });

  // The harness's own casing wins: a harness whose offline catalog lists
  // the exact spelling gets asked, whatever casing hankweave's catalog has.
  test("is not raised for a casing a harness's offline catalog lists", () => {
    const piListing: HarnessModelCheck = {
      ...PI,
      offlineRow: (provider, modelId) =>
        `${provider}/${modelId}` === "deepseek/DeepSeek-V4-Pro" ? { name: "Pi's row" } : undefined,
    };
    const withRow = (spelling: string) =>
      parseSpelling(spelling, { index, harnesses: [CLAUDE, piListing], use: "codon" });

    expect(withRow("deepseek/DeepSeek-V4-Pro")).toEqual({
      ok: true,
      provider: "deepseek",
      modelId: "DeepSeek-V4-Pro",
      piForced: false,
    });
    expect(withRow("pi/deepseek/DeepSeek-V4-Pro")).toMatchObject({ ok: true, piForced: true });
    // Another casing the harness does not list is still class D.
    expect(withRow("deepseek/Deepseek-V4-Pro")).toMatchObject({
      ok: false,
      kind: "wrong-case",
      suggestions: ["deepseek/deepseek-v4-pro"],
    });
    // Without the harness's row it is class D.
    expect(parse("deepseek/DeepSeek-V4-Pro")).toEqual({
      ok: false,
      kind: "wrong-case",
      message:
        "Model ids are case-sensitive: write 'deepseek/deepseek-v4-pro' (you wrote 'deepseek/DeepSeek-V4-Pro').",
      suggestions: ["deepseek/deepseek-v4-pro"],
    });
  });

  test("the pi/ and openrouter/ prefixes are case-sensitive too", () => {
    expect(parse("PI/anthropic/claude-haiku-4-5")).toEqual({
      ok: false,
      kind: "wrong-case",
      message:
        "Model ids are case-sensitive: write 'pi/anthropic/claude-haiku-4-5' (you wrote 'PI/anthropic/claude-haiku-4-5').",
      suggestions: ["pi/anthropic/claude-haiku-4-5"],
    });
    expect(parse("pi/Anthropic/claude-haiku-4-5")).toMatchObject({
      kind: "wrong-case",
      suggestions: ["pi/anthropic/claude-haiku-4-5"],
    });
    expect(parse("OpenRouter/moonshotai/kimi-k3")).toMatchObject({
      kind: "wrong-case",
      suggestions: ["openrouter/moonshotai/kimi-k3"],
    });
  });
});

describe("parseSpelling — I: pi/ without a provider", () => {
  test("names the provider that lists the id", () => {
    expect(parse("pi/deepseek-v4-pro")).toEqual({
      ok: false,
      kind: "bad-prefix",
      message:
        "'pi/deepseek-v4-pro' names no provider. Write 'pi/<provider>/<model>': pi/deepseek/deepseek-v4-pro.",
      suggestions: ["pi/deepseek/deepseek-v4-pro"],
    });
  });

  test("'pi/' alone gets the full placeholder", () => {
    expect(parse("pi/")).toEqual({
      ok: false,
      kind: "bad-prefix",
      message: "'pi/' names no provider. Write 'pi/<provider>/<model>': pi/<provider>/<model>.",
      suggestions: [],
    });
  });

  test("an id no provider lists gets the placeholder", () => {
    expect(parse("pi/nothing-here")).toEqual({
      ok: false,
      kind: "bad-prefix",
      message:
        "'pi/nothing-here' names no provider. Write 'pi/<provider>/<model>': pi/<provider>/nothing-here.",
      suggestions: [],
    });
  });
});

describe("parseSpelling — sentinels", () => {
  test("pi/ is refused: sentinels run on the AI SDK", () => {
    expect(parse("pi/anthropic/claude-haiku-4-5", "sentinel")).toEqual({
      ok: false,
      kind: "bad-prefix",
      message:
        "'pi/anthropic/claude-haiku-4-5': the 'pi/' prefix chooses the Pi harness for a codon; sentinels run on the AI SDK. Write '<provider>/<model>'.",
      suggestions: ["anthropic/claude-haiku-4-5"],
    });
  });

  test("a provider only a codon harness runs is refused for a sentinel", () => {
    expect(parse("zai/glm-5.2", "sentinel")).toEqual({
      ok: false,
      kind: "unrunnable-provider",
      message:
        "'zai' is not a provider sentinels can run (the AI SDK runs anthropic, openai, google, deepseek).",
      suggestions: [],
    });
    expect(parse("zai/glm-5.2", "codon")).toMatchObject({ ok: true });
  });

  test("the same model under a sentinel provider is offered", () => {
    const result = parse("openai-codex/gpt-5.6-sol", "sentinel");
    expect(result).toMatchObject({
      ok: false,
      kind: "unrunnable-provider",
      suggestions: ["openai/gpt-5.6-sol"],
    });
    expect(result.ok || result.message).toEndWith(
      "The same model id is listed by: openai/gpt-5.6-sol.",
    );
  });
});

// === Through Models.current().check over the bundled catalog ===

const check = (spelling: string, use: "codon" | "sentinel" = "codon") =>
  Models.current().check(spelling, use);

function failed(result: ModelCheck): Extract<ModelCheck, { ok: false }> {
  if (result.ok) {
    throw new Error(
      `expected a failure, resolved ${result.model.providerId}/${result.model.modelId}`,
    );
  }
  return result;
}

function resolved(result: ModelCheck): ModelInfo {
  if (!result.ok) throw new Error(`expected a resolution, got ${result.kind}: ${result.message}`);
  return result.model;
}

function rates(model: ModelInfo): { input: number; output: number } {
  const { input, output } = model.cost ?? {};
  if (input === undefined || output === undefined) throw new Error(`${model.modelId} is unpriced`);
  return { input, output };
}

describe("Models.check — class messages over the bundled catalog", () => {
  test.each([
    ["sonnet", "anthropic/claude-sonnet-5-5", "Anthropic Sonnet"],
    ["gpt-5.6", "openai/gpt-5.6-sol", "GPT-5.6"],
    ["gemini-flash", "google/gemini-3.8-flash", "Gemini Flash"],
  ])("A: former shortcut '%s' fails and names %s", (word, newest, label) => {
    const result = failed(check(word));
    expect(result.kind).toBe("no-provider");
    expect(result.stage).toBe("name");
    expect(result.suggestions[0]).toBe(newest);
    expect(result.message).toStartWith(
      `'${word}' is not a model id; model shortcuts were removed. The newest ${label} is ${newest}`,
    );
  });

  test("A: a bare id fails and lists the providers carrying it", () => {
    expect(check("claude-sonnet-5-5")).toEqual({
      ok: false,
      kind: "no-provider",
      message:
        `Model 'claude-sonnet-5-5' has no provider. ${RULE} ` +
        "Ids with this name: anthropic/claude-sonnet-5-5, opencode/claude-sonnet-5-5.",
      suggestions: ["anthropic/claude-sonnet-5-5", "opencode/claude-sonnet-5-5"],
      stage: "name",
    });
  });

  test("A: a bare effort id is answered with the maker's ids, not a reseller's", () => {
    const result = failed(check("gpt-5.6-high"));
    expect(result.kind).toBe("no-provider");
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions.every((s) => s.startsWith("openai/"))).toBe(true);
    expect(result.message).toEndWith(`Closest: ${result.suggestions.join(", ")}.`);
  });

  test("I: 'pi/' alone gets the full placeholder", () => {
    expect(check("pi/")).toEqual({
      ok: false,
      kind: "bad-prefix",
      message: "'pi/' names no provider. Write 'pi/<provider>/<model>': pi/<provider>/<model>.",
      suggestions: [],
      stage: "name",
    });
  });

  test("B: zhipuai/glm-5.2 fails and points at zai/glm-5.2", () => {
    const result = failed(check("zhipuai/glm-5.2"));
    expect(result.kind).toBe("unrunnable-provider");
    expect(result.stage).toBe("name");
    expect(result.suggestions[0]).toBe("zai/glm-5.2");
    expect(result.message).toStartWith(
      "'zhipuai' is not a provider hankweave can run (the Claude Agent SDK runs anthropic, amazon-bedrock; Pi runs ",
    );
    expect(result.message).toContain("The same model id is listed by: zai/glm-5.2");
  });

  test("B: the 'anthropc' typo fails with 'Did you mean'", () => {
    const result = failed(check("anthropc/claude-sonnet-5-5"));
    expect(result.kind).toBe("unrunnable-provider");
    expect(result.suggestions[0]).toBe("anthropic/claude-sonnet-5-5");
    expect(result.message).toEndWith(
      "Did you mean 'anthropic'? Write 'anthropic/claude-sonnet-5-5'.",
    );
  });

  test("B: former provider aliases fail", () => {
    for (const spelling of ["z-ai/glm-5.2", "moonshot/kimi-k3"]) {
      expect(failed(check(spelling)).kind).toBe("unrunnable-provider");
    }
  });

  test("D: a wrongly cased spelling fails with the exact one", () => {
    expect(check("Anthropic/Claude-Sonnet-5-5")).toEqual({
      ok: false,
      kind: "wrong-case",
      message:
        "Model ids are case-sensitive: write 'anthropic/claude-sonnet-5-5' (you wrote 'Anthropic/Claude-Sonnet-5-5').",
      suggestions: ["anthropic/claude-sonnet-5-5"],
      stage: "name",
    });
    expect(failed(check("PI/anthropic/claude-haiku-4-5")).suggestions).toEqual([
      "pi/anthropic/claude-haiku-4-5",
    ]);
    expect(failed(check("Pi/anthropic/claude-haiku-4-5")).kind).toBe("wrong-case");
  });

  test("I: pi/deepseek-v4-pro fails and names pi/deepseek/deepseek-v4-pro", () => {
    const result = failed(check("pi/deepseek-v4-pro"));
    expect(result.kind).toBe("bad-prefix");
    expect(result.stage).toBe("name");
    expect(result.message).toBe(
      "'pi/deepseek-v4-pro' names no provider. Write 'pi/<provider>/<model>': pi/deepseek/deepseek-v4-pro.",
    );
    expect(result.suggestions[0]).toBe("pi/deepseek/deepseek-v4-pro");
  });

  test("sentinel: pi/ is refused", () => {
    expect(check("pi/anthropic/claude-haiku-4-5", "sentinel")).toEqual({
      ok: false,
      kind: "bad-prefix",
      message:
        "'pi/anthropic/claude-haiku-4-5': the 'pi/' prefix chooses the Pi harness for a codon; sentinels run on the AI SDK. Write '<provider>/<model>'.",
      suggestions: ["anthropic/claude-haiku-4-5"],
      stage: "name",
    });
    // The same spelling is fine for a codon.
    expect(check("pi/anthropic/claude-haiku-4-5", "codon").ok).toBe(true);
  });

  test("sentinel: a provider the AI SDK does not run is refused", () => {
    const aiSdkProviders = sentinelHarnesses()[0]?.providers() ?? [];
    expect(aiSdkProviders).not.toContain("zai");
    const result = failed(check("zai/glm-5.2", "sentinel"));
    expect(result.kind).toBe("unrunnable-provider");
    expect(result.message).toBe(
      `'zai' is not a provider sentinels can run (the AI SDK runs ${aiSdkProviders.join(", ")}).`,
    );
    expect(failed(check("openai-codex/gpt-5.6-sol", "sentinel")).suggestions).toEqual([
      "openai/gpt-5.6-sol",
    ]);
  });
});

describe("Models.check — what resolves", () => {
  test("trim is the only normalisation", () => {
    const model = resolved(check("  anthropic/claude-haiku-4-5  "));
    expect(model.providerId).toBe("anthropic");
    expect(model.modelId).toBe("claude-haiku-4-5");
  });

  test("a resolved record is exact and records its evidence", () => {
    const model = resolved(check("anthropic/claude-haiku-4-5"));
    expect(model.harnessOverride).toBeUndefined();
    expect(model.provenance?.requestedAs).toBe("anthropic/claude-haiku-4-5");
    expect(model.provenance?.matchType).toBe("exact");
    expect(model.provenance?.evidence).toBe("catalog (parse mode)");
  });

  test("openrouter/<org>/<model> resolves under openrouter and runs on Pi", () => {
    const model = resolved(check("openrouter/moonshotai/kimi-k3"));
    expect(model.providerId).toBe("openrouter");
    expect(model.modelId).toBe("moonshotai/kimi-k3");
    expect(selectHarness(model)).toBe("pi");
  });

  test("moonshotai/kimi-k3 resolves under moonshotai (no OpenRouter rerouting)", () => {
    const model = resolved(check("moonshotai/kimi-k3"));
    expect(model.providerId).toBe("moonshotai");
    expect(selectHarness(model)).toBe("pi");
  });

  test("openai-codex/<model> resolves under openai-codex, priced as openai", () => {
    const codex = resolved(check("openai-codex/gpt-5.6-sol"));
    const openai = resolved(check("openai/gpt-5.6-sol"));
    expect(codex.providerId).toBe("openai-codex");
    expect(codex.modelId).toBe("gpt-5.6-sol");
    expect(codex.cost).toEqual(openai.cost);
    expect(selectHarness(codex)).toBe("pi");
  });

  test("pi/<provider>/<model> keeps the real identity and forces Pi", () => {
    const model = resolved(check("pi/anthropic/claude-haiku-4-5"));
    expect(model.providerId).toBe("anthropic");
    expect(model.modelId).toBe("claude-haiku-4-5");
    expect(model.harnessOverride).toBe("pi");
    expect(selectHarness(model)).toBe("pi");
  });

  test("effort variants resolve with the scaled price", () => {
    const base = rates(resolved(check("openai/gpt-5.6-sol")));
    const high = resolved(check("openai/gpt-5.6-sol-high"));
    const xhigh = resolved(check("openai/gpt-5.6-sol-xhigh"));
    expect(high.modelId).toBe("gpt-5.6-sol-high");
    expect(rates(high).input).toBe(base.input);
    expect(xhigh.modelId).toBe("gpt-5.6-sol-xhigh");
    expect(rates(xhigh)).toEqual({ input: base.input * 2, output: base.output * 2 });
  });

  test("opencode/claude-haiku-4-5 is OpenCode Zen's model, not a rewrite to anthropic", () => {
    const model = resolved(check("opencode/claude-haiku-4-5"));
    expect(model.providerId).toBe("opencode");
    expect(model.modelId).toBe("claude-haiku-4-5");
    expect(model.harnessOverride).toBeUndefined();
    expect(selectHarness(model)).toBe("pi");
  });

  test("opencode/anthropic/claude-haiku-4-5 fails as an unknown OpenCode Zen model", () => {
    const result = failed(check("opencode/anthropic/claude-haiku-4-5"));
    expect(result.kind).toBe("unknown-model");
    expect(result.stage).toBe("harness");
    expect(result.suggestions).toContain("opencode/claude-haiku-4-5");
  });

  // Class J: "amazon-bedrock/opus" fails as C "with Bedrock ids containing the
  // word". It fails as C, but the suggestion scorer finds no Bedrock id close
  // enough to "opus", so no Opus id is offered.
  test("J: a former family word under a provider suggests that provider's ids of the family", () => {
    const result = failed(check("amazon-bedrock/opus"));
    expect(result.kind).toBe("unknown-model");
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions.every((s) => /^amazon-bedrock\/.*opus/.test(s))).toBe(true);
  });
});

describe("Models.check — properties of the bundled catalog", () => {
  const built = bundledCatalogSnapshot();
  const harnesses = modelHarnesses();
  const all = [...harnesses.codon, ...harnesses.sentinel];
  const runnable = new Set(all.flatMap((h) => h.providers()));
  const catalog = new CatalogIndex(built.rows, (provider) => runnable.has(provider));

  test("the runnable set contains anthropic and amazon-bedrock (guards a pi-ai rename)", () => {
    const pi = new PiModelCheck().providers();
    expect(pi).toContain("anthropic");
    expect(pi).toContain("amazon-bedrock");
    const codon = new Set(codonHarnesses().flatMap((h) => h.providers()));
    expect(codon.has("anthropic")).toBe(true);
    expect(codon.has("amazon-bedrock")).toBe(true);
  });

  test("no loaded row belongs to a provider no harness runs", () => {
    const rows = [...catalog.rows()];
    expect(rows.length).toBeGreaterThan(0);
    const unrunnable = rows.filter((m) => !all.some((h) => h.runs(m.providerId, m.modelId)));
    expect(unrunnable.map((m) => `${m.providerId}/${m.modelId}`)).toEqual([]);
    // The bundled snapshot does carry resellers no harness runs; they are dropped.
    expect(catalog.dropped.size).toBeGreaterThan(0);
  });

  test("a row of a dropped provider fails at stage 0", () => {
    const seen = new Set<string>();
    for (const m of built.rows) {
      if (!catalog.dropped.has(m.providerId) || seen.has(m.providerId)) continue;
      seen.add(m.providerId);
      const result = failed(check(`${m.providerId}/${m.modelId}`));
      expect({ spelling: `${m.providerId}/${m.modelId}`, kind: result.kind }).toEqual({
        spelling: `${m.providerId}/${m.modelId}`,
        kind: "unrunnable-provider",
      });
    }
    expect(seen.size).toBe(catalog.dropped.size);
  });

  test("every loaded row resolves when written as provider/model", () => {
    const unresolved: string[] = [];
    for (const m of catalog.rows()) {
      const spelling = `${m.providerId}/${m.modelId}`;
      const result = check(spelling);
      if (
        !result.ok ||
        result.model.providerId !== m.providerId ||
        result.model.modelId !== m.modelId
      ) {
        unresolved.push(spelling);
      }
    }
    expect(unresolved).toEqual([]);
  });

  test("no slash-free spelling resolves", () => {
    const words = new Set([
      ...[...catalog.rows()].map((m) => m.modelId).filter((id) => !id.includes("/")),
      "sonnet",
      "opus",
      "haiku",
      "fable",
      "claude-sonnet",
      "gpt-5.6",
      "gemini-flash",
      "gemini-pro",
    ]);
    const resolvedWords = [...words].filter((word) => check(word).ok || check(word, "sentinel").ok);
    expect(resolvedWords).toEqual([]);
    for (const word of ["claude-sonnet-5-5", "gpt-5.6-sol", "kimi-k3"]) {
      expect(failed(check(word)).kind).toBe("no-provider");
    }
  });
});
