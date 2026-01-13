import { z } from "zod";

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

  // Optional metadata
  knowledge: z.string().optional(), // Knowledge cutoff date (YYYY-MM or YYYY-MM-DD)
  release_date: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/), // First release date
  last_updated: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/), // Most recent update date
});

// Provider schema
export const providerInfoSchema = z.object({
  id: z.string().min(1), // Provider ID (e.g., "anthropic")
  name: z.string().min(1), // Provider display name
  models: z.array(modelInfoSchema).min(1), // Must have at least one model
});

// Root data structure from models.dev API
export const modelsDevApiResponseSchema = z.record(
  z.string(), // Provider ID key
  z.object({
    name: z.string(),
    models: z.record(
      z.string(),
      z.object({
        name: z.string(),
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
      }),
    ),
  }),
);

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
export type ProviderInfo = z.infer<typeof providerInfoSchema>;
export type ModelsData = z.infer<typeof modelsDataSchema>;
export type ModelsDevApiResponse = z.infer<typeof modelsDevApiResponseSchema>;
