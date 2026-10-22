import { z } from "zod";
// Value-only import; provider-ids' ModelInfo import is type-only, so there is
// no runtime cycle between the two modules.
import { PI_HARNESS } from "../../provider-ids.js";

// Cost schema for model pricing
export const modelCostSchema = z
  .object({
    input: z.number().nonnegative().optional(), // Cost per million input tokens (USD)
    output: z.number().nonnegative().optional(), // Cost per million output tokens (USD)
    cache_read: z.number().nonnegative().optional(), // Cost per million cached read tokens (USD)
    cache_write: z.number().nonnegative().optional(), // Cost per million cached write tokens (USD)
  })
  .optional();

// Limits schema for model constraints
export const modelLimitsSchema = z.object({
  context: z.number().positive().int(), // Maximum context window (tokens)
  output: z.number().positive().int(), // Maximum output tokens
});

// Modalities schema for supported input/output formats
export const modalitiesSchema = z.object({
  input: z.array(z.string()).min(1), // Supported input modalities (e.g., ["text", "image"])
  output: z.array(z.string()).min(1), // Supported output modalities (e.g., ["text"])
});

/**
 * How far to trust a catalog record (spec 70, "Confidence levels"):
 * - registry: a registry lists it (bundled snapshot or live models.dev)
 * - provisional: only the provider's own model list confirms it
 * - user: declared as a new model in a `models` block (a correction of a
 *   catalog record keeps the record's confidence)
 * - harness: no catalog lists it; the harness that runs it confirmed it, and
 *   its own catalog row (Pi's) supplied price and limits
 * - unverified: never produced (spec 72 removed unverified pi/… passthroughs);
 *   accepted so plans persisted by earlier versions still load
 */
const modelConfidenceSchema = z.enum(["registry", "provisional", "user", "harness", "unverified"]);

/**
 * Whether a record's price can be trusted for budgets:
 * - known: a positive price, and no cross-check source lists it higher
 * - disputed: LiteLLM lists input or output more than 5% higher; budgets use
 *   the higher rates
 * - zero: a price is present and every rate is 0 (possibly free, possibly not)
 * - unknown: no price anywhere; budgets use a flagged ceiling estimate
 */
const priceStatusSchema = z.enum(["known", "disputed", "zero", "unknown"]);

/**
 * Where a record came from and how resolution reached it. Persisted with the
 * ModelInfo in the execution plan, so a finished run records which model
 * data it ran on.
 */
const modelProvenanceSchema = z.object({
  confidence: modelConfidenceSchema,
  /** Human-readable source of the record, e.g. "models.dev live 2026-09-29T06:00Z". */
  source: z.string(),
  priceStatus: priceStatusSchema,
  /** Where the price came from, when not the record's own source. */
  priceSource: z.string().optional(),
  /**
   * The price was declared by a models block or an overlay correction. A
   * declared price is what a run records for this model, over the harness's
   * own total (CostTracker); any other price leaves the harness total alone.
   */
  priceDeclared: z.literal(true).optional(),
  /** Rates budgets use instead of `cost` (disputed: the higher; unknown: a ceiling). */
  budgetCost: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cache_read: z.number().nonnegative().optional(),
      cache_write: z.number().nonnegative().optional(),
    })
    .optional(),
  /** Why budgetCost differs from cost. */
  budgetCostBasis: z.string().optional(),
  /** provider/model whose fields filled this record's gaps. */
  inheritedFrom: z.string().optional(),
  /** The spelling as written in the config. */
  requestedAs: z.string().optional(),
  /**
   * How requestedAs resolved. Always "exact" since spec 72; a string, not an
   * enum, so plans persisted with "shortcut", "alias" or
   * "exact-with-inferred-provider" still load.
   */
  matchType: z.string().optional(),
  /**
   * Set on an effort variant ("<id>-xhigh"): the base model id it was derived
   * from, at scaled rates. The harness runs the base at that effort, so the
   * base id is what gets injected into a harness catalog (spec 72).
   */
  effortOf: z.string().optional(),
  /** What confirmed the harness can run it ("pi catalog", "catalog", …; spec 72). */
  evidence: z.string().optional(),
});

// Individual model schema based on models.dev specification
export const modelInfoSchema = z.object({
  // Model identification
  providerId: z.string().min(1), // e.g., "anthropic", "openai"
  modelId: z.string().min(1), // e.g., "claude-3-5-sonnet-20241022"
  name: z.string().min(1), // Human-readable display name

  // Model capabilities
  attachment: z.boolean(), // Supports file attachments
  reasoning: z.boolean(), // Supports reasoning / chain-of-thought
  tool_call: z.boolean(), // Supports tool calling (also implies structured output support)
  temperature: z.boolean().optional(), // Supports temperature control

  // Pricing and limits
  cost: modelCostSchema,
  limit: modelLimitsSchema,

  // Supported formats
  modalities: modalitiesSchema,

  // Harness routing override: set only by config validation when the user
  // explicitly spelled "pi/…" — never present in models.dev data. Harness
  // selection is otherwise late-bound at dispatch (selectHarness in
  // provider-ids.ts); this field forces the pi harness for models that would
  // default to the Claude Agent SDK.
  harnessOverride: z.literal(PI_HARNESS).optional(),

  // Optional metadata
  family: z.string().optional(), // models.dev family, e.g. "claude-sonnet" (sibling lookups)
  knowledge: z.string().optional(), // Knowledge cutoff date (YYYY-MM or YYYY-MM-DD)
  release_date: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/), // First release date
  last_updated: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/), // Most recent update date

  // Catalog provenance (spec 70). Absent on raw snapshot rows; the catalog
  // attaches it when it builds records, and model validation records the
  // spelling and the harness evidence.
  provenance: modelProvenanceSchema.optional(),
});

// Provider schema
export const providerInfoSchema = z.object({
  id: z.string().min(1), // Provider ID (e.g., "anthropic")
  name: z.string().min(1), // Provider display name
  models: z.array(modelInfoSchema).min(1), // Must have at least one model
});

/**
 * One model as models.dev's api.json publishes it (the fields hankweave
 * keeps). Validated per row by the transform in models-dev-transform.ts, so
 * one malformed upstream row is skipped instead of failing the whole catalog.
 */
export const modelsDevModelSchema = z.object({
  name: z.string(),
  family: z.string().optional(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  tool_call: z.boolean(),
  temperature: z.boolean().optional(),
  knowledge: z.string().optional(),
  release_date: z.string(),
  last_updated: z.string(),
  cost: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      cache_read: z.number().optional(),
      cache_write: z.number().optional(),
    })
    .optional(),
  limit: z.object({
    context: z.number(),
    output: z.number(),
  }),
  modalities: z.object({
    input: z.array(z.string()),
    output: z.array(z.string()),
  }),
});

// Our processed data structure for internal use
export const modelsDataSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/), // Semver format
  lastUpdated: z.string().datetime(), // ISO timestamp when data was fetched
  providers: z.array(providerInfoSchema),
});

// Type exports for TypeScript
export type ModelCost = z.infer<typeof modelCostSchema>;
export type ModelLimits = z.infer<typeof modelLimitsSchema>;
export type Modalities = z.infer<typeof modalitiesSchema>;
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export type ModelsData = z.infer<typeof modelsDataSchema>;
export type ModelConfidence = z.infer<typeof modelConfidenceSchema>;
export type PriceStatus = z.infer<typeof priceStatusSchema>;
export type ModelProvenance = z.infer<typeof modelProvenanceSchema>;
