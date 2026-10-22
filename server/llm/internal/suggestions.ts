import type { ModelInfo } from "./models-dev-schema.js";
import { REASONING_EFFORTS } from "./name-hints.js";

/**
 * "Did you mean" ranking for spellings that resolve to nothing (spec 72,
 * "Error message catalogue"). Suggestions only: nothing here ever picks a
 * model for a spelling.
 */

/** Similarity a suggestion needs (0–1, after boosts). */
const SUGGESTION_THRESHOLD = 0.6;

/** Levenshtein similarity of two strings, case-insensitive: 1 = identical. */
export function similarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;
  let previous = Array.from({ length: s1.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s2.length; i++) {
    const current = [i];
    for (let j = 1; j <= s1.length; j++) {
      current[j] =
        s2.charAt(i - 1) === s1.charAt(j - 1)
          ? previous[j - 1]
          : Math.min(previous[j - 1] + 1, current[j - 1] + 1, previous[j] + 1);
    }
    previous = current;
  }
  return 1 - previous[s1.length] / Math.max(s1.length, s2.length);
}

interface SuggestionMatch {
  model: ModelInfo;
  score: number;
  hasExactWordMatch: boolean;
}

const padDate = (date: string) => (date.length === 7 ? `${date}-01` : date);

/** Scores more than 0.2 apart order by score; closer ones prefer whole-word matches, then the newest. */
function compareSuggestions(a: SuggestionMatch, b: SuggestionMatch): number {
  if (Math.abs(a.score - b.score) > 0.2) return b.score - a.score;
  if (a.hasExactWordMatch !== b.hasExactWordMatch) return a.hasExactWordMatch ? -1 : 1;
  const dateDiff = padDate(b.model.last_updated).localeCompare(padDate(a.model.last_updated));
  return dateDiff !== 0 ? dateDiff : b.score - a.score;
}

/** Whether every search word (3+ characters) closely matches a word of the id or name. */
function wordMatch(
  query: string,
  id: string,
  name: string,
): { allId: boolean; allName: boolean; exact: boolean } {
  const searchWords = query.split(/[-_\s]+/).filter((w) => w.length >= 3);
  if (searchWords.length < 2) return { allId: false, allName: false, exact: false };
  const idWords = id.split(/[-_\s]+/);
  const nameWords = name.split(/[-_\s]+/);
  // mw.includes(sw) but not sw.includes(mw): "xhigh" must not match "high".
  const close = (sw: string, mw: string) =>
    mw === sw || mw.includes(sw) || similarity(sw, mw) >= 0.75;
  const all = (words: string[]) => searchWords.every((sw) => words.some((mw) => close(sw, mw)));
  const exact = (words: string[]) => searchWords.every((sw) => words.includes(sw));
  const allId = all(idWords);
  const allName = all(nameWords);
  return { allId, allName, exact: (allId && exact(idWords)) || (allName && exact(nameWords)) };
}

/**
 * Similarity to the model's id or display name, boosted for a substring
 * match and for every search word matching a word of the id or name.
 */
function scoreSuggestion(query: string, model: ModelInfo): SuggestionMatch {
  const lowerQuery = query.toLowerCase();
  const id = model.modelId.toLowerCase();
  const name = model.name.toLowerCase();
  const words = wordMatch(lowerQuery, id, name);
  const boosted = (raw: string, lower: string, allWords: boolean) =>
    Math.min(
      1,
      similarity(query, raw) + (lower.includes(lowerQuery) ? 0.2 : 0) + (allWords ? 0.15 : 0),
    );
  const score = Math.max(
    boosted(model.modelId, id, words.allId),
    boosted(model.name, name, words.allName),
  );
  return { model, score, hasExactWordMatch: words.exact };
}

const isEffortVariant = (id: string) => REASONING_EFFORTS.some((e) => id.endsWith(`-${e}`));

/**
 * Up to `limit` "provider/model" ids from `candidates` that look like
 * `query` (a model id without its provider). Effort variants are left out
 * unless the query asks for one: they would crowd out their base model.
 */
export function suggestIds(query: string, candidates: Iterable<ModelInfo>, limit = 3): string[] {
  const wantsEffortVariant = isEffortVariant(query.toLowerCase());
  const matches: SuggestionMatch[] = [];
  for (const model of candidates) {
    if (!wantsEffortVariant && isEffortVariant(model.modelId)) continue;
    const match = scoreSuggestion(query, model);
    if (match.score >= SUGGESTION_THRESHOLD) matches.push(match);
  }
  matches.sort(compareSuggestions);
  return [...new Set(matches.map(({ model }) => `${model.providerId}/${model.modelId}`))].slice(
    0,
    limit,
  );
}

/** Names within edit distance of `query` (similarity ≥ 0.6), closest first. */
export function closestNames(query: string, names: Iterable<string>, limit = 3): string[] {
  return [...names]
    .map((name) => ({ name, score: similarity(query, name) }))
    .filter(({ score }) => score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name }) => name);
}
