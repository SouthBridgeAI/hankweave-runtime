import { z } from "zod";

/**
 * LiteLLM's model_prices_and_context_window.json as a price cross-check
 * (spec 70, "Prices and budgets"). Only first-party providers are read: a
 * provider's own list price is what hankweave budgets against, and LiteLLM's
 * reseller rows would compare different products.
 */

/** LiteLLM `litellm_provider` → catalog provider id. */
const LITELLM_PROVIDERS: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  gemini: "google",
  deepseek: "deepseek",
  xai: "xai",
  mistral: "mistral",
  groq: "groq",
  bedrock: "amazon-bedrock",
  bedrock_converse: "amazon-bedrock",
};

/** USD per million tokens, in the catalog's field names. */
export interface PriceReference {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

const litellmRowSchema = z.object({
  litellm_provider: z.string(),
  mode: z.string().optional(),
  input_cost_per_token: z.number().nonnegative(),
  output_cost_per_token: z.number().nonnegative(),
  cache_read_input_token_cost: z.number().nonnegative().optional(),
  cache_creation_input_token_cost: z.number().nonnegative().optional(),
});

/** Per-token → per-million, rounded to drop float noise (3e-6 * 1e6 = 2.9999…). */
const perMillion = (perToken: number) => Math.round(perToken * 1e12) / 1e6;

/**
 * Normalize LiteLLM's price map to "provider/model" (lowercased) → rates.
 * Keys are LiteLLM's model names with the provider prefix removed
 * ("gemini/gemini-3.8-flash" → google/gemini-3.8-flash); keys that still
 * contain a slash after that (region- or deployment-specific rows) are
 * skipped, as are non-chat rows and rows without both rates.
 */
export function normalizeLiteLlmPrices(raw: unknown): Record<string, PriceReference> {
  const rows = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!rows.success) return {};
  return Object.fromEntries(
    Object.entries(rows.data).flatMap(([key, value]) => {
      const entry = priceEntry(key, value);
      return entry ? [entry] : [];
    }),
  );
}

/** LiteLLM `mode` values for chat models; rows without a mode are chat rows. */
const CHAT_MODES = new Set<string | undefined>([undefined, "chat", "responses"]);

type LiteLlmRow = z.infer<typeof litellmRowSchema>;

/** A row's per-token costs as per-million rates, cache rates only when LiteLLM lists them. */
function ratesOf(row: LiteLlmRow): PriceReference {
  const rates: PriceReference = {
    input: perMillion(row.input_cost_per_token),
    output: perMillion(row.output_cost_per_token),
  };
  if (row.cache_read_input_token_cost !== undefined) {
    rates.cache_read = perMillion(row.cache_read_input_token_cost);
  }
  if (row.cache_creation_input_token_cost !== undefined) {
    rates.cache_write = perMillion(row.cache_creation_input_token_cost);
  }
  return rates;
}

/** One LiteLLM row as ["provider/model", rates], or undefined when it is not a first-party chat row. */
function priceEntry(key: string, value: unknown): [string, PriceReference] | undefined {
  const row = litellmRowSchema.safeParse(value);
  if (!row.success || !CHAT_MODES.has(row.data.mode)) return undefined;
  const provider = LITELLM_PROVIDERS[row.data.litellm_provider];
  const prefix = `${row.data.litellm_provider}/`;
  const modelId = key.startsWith(prefix) ? key.substring(prefix.length) : key;
  if (!provider || modelId.includes("/")) return undefined;
  return [`${provider}/${modelId.toLowerCase()}`, ratesOf(row.data)];
}
