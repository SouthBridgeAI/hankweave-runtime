import { z } from "zod";
import bundledOverlayRaw from "./model-overlay.json" with { type: "json" };

/**
 * The model overlay (spec 70, "The overlay"; spec 72): a small, reviewed data
 * file of facts the registries get wrong. Every entry cites a reason and a
 * source URL. It ships inside each release
 * (server/llm/internal/model-overlay.json) and changes only with one: nothing
 * fetches a newer copy, so no remote party can change what a running install
 * does.
 *
 * Trust boundary: the overlay changes numbers (prices, limits) and nothing
 * else. It carries no name data (no aliases, no retirements:
 * a spelling means exactly the id written) and cannot add providers, base
 * URLs, headers, or credentials — none of those fields exist in the schema,
 * and every entry is strict.
 */

const OVERLAY_SCHEMA_VERSION = 1;

const modelKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*\/\S+$/, "must be a 'provider/model' id with a lowercase provider");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const citation = {
  reason: z.string().min(1),
  source: z.string().url(),
};

const rate = z.number().nonnegative();
const overlayCorrectionSchema = z
  .object({
    model: modelKey,
    cost: z
      .object({
        input: rate,
        output: rate,
        cache_read: rate.optional(),
        cache_write: rate.optional(),
      })
      .strict()
      .optional(),
    limit: z
      .object({
        context: z.number().int().positive().optional(),
        output: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    ...citation,
  })
  .strict()
  .refine((correction) => correction.cost || correction.limit, {
    message: "a correction must change cost or limit",
  });

export const modelOverlaySchema = z
  .object({
    schemaVersion: z.literal(OVERLAY_SCHEMA_VERSION),
    /** Date of the newest entry. */
    updated: isoDate,
    corrections: z.array(overlayCorrectionSchema),
  })
  .strict();

export type ModelOverlay = z.infer<typeof modelOverlaySchema>;

/** The overlay compiled into this build. A malformed bundled file is a build bug. */
export const BUNDLED_OVERLAY: ModelOverlay = modelOverlaySchema.parse(bundledOverlayRaw);
