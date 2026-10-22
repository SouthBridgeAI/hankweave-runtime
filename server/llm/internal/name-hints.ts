import type { ModelInfo } from "./models-dev-schema.js";

/**
 * Hints for former model shortcuts (spec 72). Shortcuts ("sonnet",
 * "gemini-flash", "gpt-5.6") were removed: a spelling is a fully qualified
 * "<provider>/<model>" id and nothing expands it. A config written with one
 * fails with class A, and the hint below names the id the word used to
 * mean, so the fix is copy-paste. These tables never resolve anything.
 */
interface FormerFamily {
  provider: string;
  /** Matched against the model id. */
  pattern: RegExp;
  /** Words for the message ("Anthropic Sonnet"). */
  label: string;
}

const FORMER_FAMILIES: Readonly<Record<string, FormerFamily>> = {
  opus: { provider: "anthropic", pattern: /^claude-opus-\d/, label: "Anthropic Opus" },
  sonnet: { provider: "anthropic", pattern: /^claude-sonnet-\d/, label: "Anthropic Sonnet" },
  haiku: { provider: "anthropic", pattern: /^claude-haiku-\d/, label: "Anthropic Haiku" },
  fable: { provider: "anthropic", pattern: /^claude-fable-\d/, label: "Anthropic Fable" },
  "claude-opus": { provider: "anthropic", pattern: /^claude-opus-\d/, label: "Anthropic Opus" },
  "claude-sonnet": {
    provider: "anthropic",
    pattern: /^claude-sonnet-\d/,
    label: "Anthropic Sonnet",
  },
  "claude-haiku": { provider: "anthropic", pattern: /^claude-haiku-\d/, label: "Anthropic Haiku" },
  "claude-fable": { provider: "anthropic", pattern: /^claude-fable-\d/, label: "Anthropic Fable" },
  "gemini-flash": {
    provider: "google",
    pattern: /^gemini-\d+(\.\d+)?-flash(-preview)?$/,
    label: "Gemini Flash",
  },
  "gemini-pro": {
    provider: "google",
    pattern: /^gemini-\d+(\.\d+)?-pro(-preview)?$/,
    label: "Gemini Pro",
  },
  "gpt-5.6": { provider: "openai", pattern: /^gpt-5\.6-[a-z]+$/, label: "GPT-5.6" },
};

/**
 * Reasoning-effort suffixes registered as model variants for reasoning-capable
 * OpenAI models ("openai/gpt-5.6-sol-high"). The catalog index synthesizes
 * them; Pi carries the suffix as its thinking level.
 */
export const REASONING_EFFORTS = ["high", "xhigh"] as const;

/** Pad a models.dev "YYYY-MM" date to "YYYY-MM-01" so dates compare as strings. */
function padDate(date: string): string {
  return date.length === 7 ? `${date}-01` : date;
}

/**
 * Newest first: latest release date, then latest update, then the shorter id
 * (an undated alias over its dated snapshot, claude-haiku-4-5 over
 * claude-haiku-4-5-20251001), then id order for determinism.
 */
export function compareNewest(a: ModelInfo, b: ModelInfo): number {
  const release = padDate(b.release_date).localeCompare(padDate(a.release_date));
  if (release !== 0) return release;
  const updated = padDate(b.last_updated).localeCompare(padDate(a.last_updated));
  if (updated !== 0) return updated;
  if (a.modelId.length !== b.modelId.length) return a.modelId.length - b.modelId.length;
  return a.modelId.localeCompare(b.modelId);
}

/**
 * For a slash-free spelling that used to be a shortcut: a sentence naming
 * the newest id of the family it meant, and up to three ids. Undefined for
 * any other word.
 */
export function formerShortcutHint(
  word: string,
  rows: Iterable<ModelInfo>,
): { sentence: string; ids: string[] } | undefined {
  const family = FORMER_FAMILIES[word.trim().toLowerCase()];
  if (!family) return undefined;
  const members = [...rows]
    .filter((m) => m.providerId === family.provider && family.pattern.test(m.modelId))
    .sort(compareNewest);
  const ids = members.slice(0, 3).map((m) => `${m.providerId}/${m.modelId}`);
  const [newest, ...others] = ids;
  const more = others.length > 0 ? ` (others: ${others.join(", ")})` : "";
  return {
    sentence: newest
      ? `'${word}' is not a model id; model shortcuts were removed. The newest ${family.label} is ${newest}${more}.`
      : `'${word}' is not a model id; model shortcuts were removed.`,
    ids,
  };
}
