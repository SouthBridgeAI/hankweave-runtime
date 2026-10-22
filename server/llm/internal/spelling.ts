import { PI_HARNESS } from "../../provider-ids.js";
import type { HarnessModelCheck, ModelFailureKind, ModelUse } from "../types.js";
import type { CatalogIndex } from "./catalog-index.js";
import type { ModelInfo } from "./models-dev-schema.js";
import { formerShortcutHint } from "./name-hints.js";
import { closestNames, similarity, suggestIds } from "./suggestions.js";

/**
 * Stage 0 (spec 72, "Order of validation"): is the spelling a fully
 * qualified "<provider>/<model>" id for a provider some harness runs, written
 * in the exact case? Offline and in memory. Trim is the only normalisation:
 * nothing is inferred, expanded, aliased or corrected — a failure names the
 * ids to write instead (classes A, B, D and I).
 */

export interface ParsedSpelling {
  ok: true;
  provider: string;
  modelId: string;
  /** Written "pi/<provider>/<model>": run on Pi whatever the provider. */
  piForced: boolean;
}

export interface SpellingFailure {
  ok: false;
  kind: Extract<
    ModelFailureKind,
    "no-provider" | "unrunnable-provider" | "wrong-case" | "bad-prefix"
  >;
  message: string;
  suggestions: string[];
}

export interface SpellingContext {
  index: CatalogIndex;
  /** The harnesses for this use, in routing order. */
  harnesses: readonly HarnessModelCheck[];
  use: ModelUse;
}

const PI_PREFIX = `${PI_HARNESS}/`;
const MAX_LISTED_PROVIDERS = 12;

const idOf = (row: Pick<ModelInfo, "providerId" | "modelId">) => `${row.providerId}/${row.modelId}`;
const lineOf = (modelId: string) => modelId.toLowerCase().split(/[-_.]/)[0] ?? "";

/** Every provider the harnesses for this use run, in routing order, deduplicated. */
function runnableProviders(harnesses: readonly HarnessModelCheck[]): string[] {
  return [...new Set(harnesses.flatMap((h) => h.providers()))];
}

/** "a, b, c, … (+N more)" */
function listProviders(providers: readonly string[]): string {
  const shown = providers.slice(0, MAX_LISTED_PROVIDERS);
  const rest = providers.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, … (+${rest} more)` : "");
}

/**
 * "(the Claude Agent SDK runs anthropic, amazon-bedrock; Pi runs …)". A list
 * too long to show whole (Pi's) leads with the providers closest to what was
 * written, then those with the most catalog models, the ones people use.
 */
function describeHarnesses(
  harnesses: readonly HarnessModelCheck[],
  index: CatalogIndex,
  written: string,
): string {
  const size = (provider: string) => index.rowsOf(provider).length;
  const closeness = (provider: string) => similarity(written, provider);
  return harnesses
    .map((h) => {
      const providers =
        h.providers().length > MAX_LISTED_PROVIDERS
          ? [...h.providers()].sort(
              (a, b) => closeness(b) - closeness(a) || size(b) - size(a) || a.localeCompare(b),
            )
          : h.providers();
      return `${h.label} runs ${listProviders(providers)}`;
    })
    .join("; ");
}

/**
 * Records listing exactly this model id, the model's maker first: the
 * provider whose catalog is most made of the model's line ("claude-*" →
 * anthropic, "deepseek-*" → deepseek, "glm-*" → zai), then the one with most
 * of the line. Counted from the catalog, not a list of makers.
 */
function sameIdRows(index: CatalogIndex, modelId: string): ModelInfo[] {
  const line = lineOf(modelId);
  const weight = (provider: string) => {
    const rows = index.rowsOf(provider);
    const inLine = rows.filter((r) => lineOf(r.modelId) === line).length;
    return { share: rows.length > 0 ? inLine / rows.length : 0, count: inLine };
  };
  return [...index.sameModelId(modelId)].sort((a, b) => {
    const wa = weight(a.providerId);
    const wb = weight(b.providerId);
    return wb.share - wa.share || wb.count - wa.count || a.providerId.localeCompare(b.providerId);
  });
}

function fail(
  kind: SpellingFailure["kind"],
  message: string,
  suggestions: string[] = [],
): SpellingFailure {
  return { ok: false, kind, message, suggestions };
}

/** The provider whose catalog is most made of the id's model line, if any lists the line. */
function makerOf(index: CatalogIndex, modelId: string): string | undefined {
  const line = lineOf(modelId);
  let best: { provider: string; share: number } | undefined;
  for (const provider of index.providers()) {
    const rows = index.rowsOf(provider);
    const share = rows.filter((r) => lineOf(r.modelId) === line).length / Math.max(rows.length, 1);
    if (share > 0 && (!best || share > best.share)) best = { provider, share };
  }
  return best?.provider;
}

/** Class A: no "/" at all. */
function noProvider(spelling: string, ctx: SpellingContext): SpellingFailure {
  const rule = "Write models as '<provider>/<model>'.";
  const hint = formerShortcutHint(spelling, ctx.index.rows());
  if (hint) return fail("no-provider", `${hint.sentence} ${rule}`, hint.ids);
  const same = sameIdRows(ctx.index, spelling).map(idOf).slice(0, 3);
  if (same.length > 0) {
    return fail(
      "no-provider",
      `Model '${spelling}' has no provider. ${rule} Ids with this name: ${same.join(", ")}.`,
      same,
    );
  }
  // Closest ids, the model line's maker first ("gpt-*" → openai), so a
  // reseller's copy is not the first thing suggested.
  const maker = makerOf(ctx.index, spelling);
  const own = maker ? suggestIds(spelling, ctx.index.rowsOf(maker, true)) : [];
  const closest = own.length > 0 ? own : suggestIds(spelling, ctx.index.rows());
  const tail = closest.length > 0 ? ` Closest: ${closest.join(", ")}.` : "";
  return fail("no-provider", `Model '${spelling}' has no provider. ${rule}${tail}`, closest);
}

/** Class I: "pi/<model>" with no provider. */
function piWithoutProvider(spelling: string, rest: string, ctx: SpellingContext): SpellingFailure {
  const pi = ctx.harnesses.find((h) => h.harness === PI_HARNESS);
  const same = sameIdRows(ctx.index, rest)
    .filter((row) => pi?.runs(row.providerId, row.modelId))
    .map((row) => `${PI_PREFIX}${idOf(row)}`)
    .slice(0, 3);
  const example = same[0] ?? `${PI_PREFIX}<provider>/${rest || "<model>"}`;
  return fail(
    "bad-prefix",
    `'${spelling}' names no provider. Write '${PI_PREFIX}<provider>/<model>': ${example}.`,
    same,
  );
}

/** Class B: the provider is not one any harness for this use runs. */
function unrunnableProvider(
  provider: string,
  modelId: string,
  ctx: SpellingContext,
  harnesses: readonly HarnessModelCheck[],
): SpellingFailure {
  const runnable = runnableProviders(harnesses);
  const subject =
    ctx.use === "sentinel"
      ? `'${provider}' is not a provider sentinels can run (${describeHarnesses(harnesses, ctx.index, provider)}).`
      : `'${provider}' is not a provider hankweave can run (${describeHarnesses(harnesses, ctx.index, provider)}).`;
  const same = sameIdRows(ctx.index, modelId)
    .filter((row) => harnesses.some((h) => h.runs(row.providerId, row.modelId)))
    .map(idOf)
    .slice(0, 3);
  // A near miss of a runnable name is a typo ("anthropc"); otherwise point
  // at the providers that list the same id ("zhipuai/glm-5.2" → zai/glm-5.2).
  const typo = closestNames(provider, runnable, 1).find(
    (name) => similarity(provider, name) >= 0.75,
  );
  if (typo) {
    const fixed = `${typo}/${modelId}`;
    return fail(
      "unrunnable-provider",
      `${subject} Did you mean '${typo}'? Write '${fixed}'.`,
      [...new Set([fixed, ...same])].slice(0, 3),
    );
  }
  if (same.length > 0) {
    return fail(
      "unrunnable-provider",
      `${subject} The same model id is listed by: ${same.join(", ")}.`,
      same,
    );
  }
  return fail("unrunnable-provider", subject);
}

/** Class D: the spelling differs from the id to write only in case. */
function wrongCase(fixed: string, spelling: string): SpellingFailure {
  return fail(
    "wrong-case",
    `Model ids are case-sensitive: write '${fixed}' (you wrote '${spelling}').`,
    [fixed],
  );
}

/**
 * Strip a leading "pi/" (`head` is the text before the first "/"): what is
 * left to parse and whether Pi is forced, or the failure for a mis-cased
 * "pi/", a sentinel's "pi/" or "pi/<model>" with no provider.
 */
function stripPiPrefix(
  spelling: string,
  head: string,
  ctx: SpellingContext,
): { ok: true; rest: string; piForced: boolean } | SpellingFailure {
  if (head.toLowerCase() !== PI_HARNESS) return { ok: true, rest: spelling, piForced: false };
  if (head !== PI_HARNESS) {
    return wrongCase(`${PI_PREFIX}${spelling.substring(head.length + 1)}`, spelling);
  }
  if (ctx.use === "sentinel") {
    return fail(
      "bad-prefix",
      `'${spelling}': the '${PI_PREFIX}' prefix chooses the Pi harness for a codon; sentinels run on the AI SDK. Write '<provider>/<model>'.`,
      [spelling.substring(PI_PREFIX.length)],
    );
  }
  const rest = spelling.substring(PI_PREFIX.length);
  if (!rest.includes("/")) return piWithoutProvider(spelling, rest, ctx);
  return { ok: true, rest, piForced: true };
}

/** A "<provider>/<model>" spelling split, with the "pi/" it was written with (or ""). */
interface Qualified {
  spelling: string;
  provider: string;
  modelId: string;
  prefix: string;
}

/** The provider is not one these harnesses run: wrong case of one, or class B. */
function providerFailure(
  q: Qualified,
  ctx: SpellingContext,
  harnesses: readonly HarnessModelCheck[],
): SpellingFailure | undefined {
  const runnable = runnableProviders(harnesses);
  if (runnable.includes(q.provider)) return undefined;
  const cased = runnable.find((p) => p.toLowerCase() === q.provider.toLowerCase());
  if (!cased) return unrunnableProvider(q.provider, q.modelId, ctx, harnesses);
  const record = ctx.index.getIgnoringCase(cased, q.modelId);
  return wrongCase(`${q.prefix}${cased}/${record?.modelId ?? q.modelId}`, q.spelling);
}

/**
 * Wrong case only when no catalog — hankweave's or the harness's own
 * offline one — lists the exact spelling: the harness's casing wins.
 */
function modelCaseFailure(
  q: Qualified,
  ctx: SpellingContext,
  harnesses: readonly HarnessModelCheck[],
): SpellingFailure | undefined {
  const listedExactly =
    ctx.index.get(q.provider, q.modelId) !== undefined ||
    harnesses.some((h) => h.offlineRow?.(q.provider, q.modelId) !== undefined);
  if (listedExactly) return undefined;
  const record = ctx.index.getIgnoringCase(q.provider, q.modelId);
  return record && record.modelId !== q.modelId
    ? wrongCase(`${q.prefix}${idOf(record)}`, q.spelling)
    : undefined;
}

/** Parse what is left after any "pi/": "<provider>/<model>" for these harnesses. */
function parseQualified(
  spelling: string,
  rest: string,
  piForced: boolean,
  ctx: SpellingContext,
): ParsedSpelling | SpellingFailure {
  const restSlash = rest.indexOf("/");
  const provider = rest.substring(0, restSlash);
  const modelId = rest.substring(restSlash + 1);
  if (provider === "" || modelId === "") {
    return fail(
      "no-provider",
      `Model '${spelling}' needs both a provider and a model id. Write models as '<provider>/<model>'.`,
    );
  }
  const harnesses = piForced
    ? ctx.harnesses.filter((h) => h.harness === PI_HARNESS)
    : ctx.harnesses;
  const q: Qualified = { spelling, provider, modelId, prefix: piForced ? PI_PREFIX : "" };
  const failure = providerFailure(q, ctx, harnesses) ?? modelCaseFailure(q, ctx, harnesses);
  if (failure) return failure;
  if (!harnesses.some((h) => h.runs(provider, modelId))) {
    return unrunnableProvider(provider, modelId, ctx, harnesses);
  }
  return { ok: true, provider, modelId, piForced };
}

/**
 * Parse a spelling for one use. Harness lists are in routing order; "pi/"
 * narrows them to Pi (and is refused for sentinels, which only the AI SDK
 * runs).
 */
export function parseSpelling(raw: string, ctx: SpellingContext): ParsedSpelling | SpellingFailure {
  const spelling = raw.trim();
  if (spelling === "")
    return fail("no-provider", "Model is empty. Write models as '<provider>/<model>'.");
  const slash = spelling.indexOf("/");
  if (slash < 0) return noProvider(spelling, ctx);
  const stripped = stripPiPrefix(spelling, spelling.substring(0, slash), ctx);
  if (!stripped.ok) return stripped;
  return parseQualified(spelling, stripped.rest, stripped.piForced, ctx);
}
