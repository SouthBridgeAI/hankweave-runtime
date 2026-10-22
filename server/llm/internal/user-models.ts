import { z } from "zod";

/**
 * `models` blocks in hank.json (root) and hankweave.json (spec 70,
 * "User-defined models"): the author's or operator's own model records.
 * Entries merge per id, hank.json first and hankweave.json over it — the
 * operator knows the deployment's real prices.
 *
 * An entry for a model the catalog already has, not based on another model,
 * corrects it (price, limits) and leaves it the record it was — a registry
 * record stays one, so its family shortcut still reaches it. Any other entry
 * is a new model: it names a record to inherit unspecified fields from
 * (`basedOn`) or gives the limits a record cannot exist without. The catalog
 * merge (model-catalog.ts, applyUserModel) reports an entry that does
 * neither, and refuses one under a provider the catalog lacks or for an id
 * the overlay renames or retires.
 */

const rate = z.number().nonnegative();

const userModelSchema = z
  .object({
    id: z
      .string()
      .regex(/^[^/\s]+\/\S+$/, "must be 'provider/model', e.g. 'anthropic/claude-sonnet-6'")
      .describe("Model id as 'provider/model'."),
    basedOn: z
      .string()
      .regex(/^[^/\s]+\/\S+$/, "must be 'provider/model'")
      .optional()
      .describe("A catalog model ('provider/model') to inherit every unspecified field from."),
    name: z.string().min(1).optional().describe("Display name."),
    cost: z
      .object({
        input: rate.describe("USD per million input tokens."),
        output: rate.describe("USD per million output tokens."),
        cacheRead: rate.optional().describe("USD per million cache-read tokens."),
        cacheWrite: rate.optional().describe("USD per million cache-write tokens."),
      })
      .strict()
      .optional()
      .describe(
        "Price per million tokens: what runs record for this model, over the harness's own " +
          "price. Omit to keep the price of basedOn, or of the catalog's record for this id.",
      ),
    limit: z
      .object({
        context: z.number().int().positive().describe("Context window, tokens."),
        output: z.number().int().positive().describe("Maximum output tokens per request."),
      })
      .strict()
      .optional()
      .describe(
        "Token limits. Required for a model the catalog does not know, unless basedOn " +
          "supplies them.",
      ),
    reasoning: z.boolean().optional().describe("Supports extended reasoning."),
    toolCall: z.boolean().optional().describe("Supports tool calling."),
    attachment: z.boolean().optional().describe("Accepts file attachments."),
  })
  .strict();

export const modelsBlockSchema = z
  .array(userModelSchema)
  .describe(
    "Model records added to the model catalog for this run: new models, or corrected prices " +
      "and limits for known ones.",
  );

export type UserModelDefinition = z.infer<typeof userModelSchema>;

/** Where a block of user models was declared (shown in provenance). */
export type UserModelOrigin = "hank.json" | "hankweave.json";

export interface UserModelLayer {
  origin: UserModelOrigin;
  models: readonly UserModelDefinition[];
}
