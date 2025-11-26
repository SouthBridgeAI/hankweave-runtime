/**
 * This file defines simplified, Zod-validated schemas for the parameters and return
 * types of the Vercel AI SDK's core functions: `generateText`, `streamText`, and
 * `generateObject`.
 *
 * These schemas are designed to be compatible subsets of the official AI SDK types,
 * enabling us to create strongly-typed mocks and internal functions while ensuring
 * they can be used with the real SDK.
 */

import type { LanguageModel } from "ai";
import { z } from "zod";
import { strandweaveModelMessageSchema } from "./input-ai-types.js";

// --- Base Schemas ---

/**
 * A schema for common model-calling parameters that can be configured by sentinels.
 * We are intentionally keeping this simple, focusing on the most frequently used options
 * and omitting others like topP, topK, abortSignal, etc.
 */
export const strandweaveLlmCallParamsSchema = z.object({
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("Temperature for response generation (0=deterministic, 2=creative)"),
  maxOutputTokens: z
    .number()
    .int()
    .positive()
    .max(100000)
    .optional()
    .describe("Maximum tokens in the response"),
  maxRetries: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe("Number of retry attempts for failed LLM calls"),
});

// --- `generateText` Schemas ---

/**
 * Input parameters for a `generateText` call.
 * This is a subset of the AI SDK's `GenerateTextOptions`.
 * We're removing the prompt field and focusing on messages for consistency.
 *
 * Note: Model is optional here because the concrete LLM call implementation
 * (in SentinelManager) provides it. Sentinels don't have direct access
 * to the model instance - it's injected by the manager.
 */
export const strandweaveGenerateTextOptionsSchema = strandweaveLlmCallParamsSchema.extend({
  model: z.custom<LanguageModel>().optional(), // Optional - provided by concrete implementation
  system: z.string().optional(),
  messages: z.array(strandweaveModelMessageSchema),
});

/**
 * The result from a `generateText` call.
 * This is a subset of the AI SDK's `GenerateTextResult`.
 */
export const strandweaveGenerateTextResultSchema = z.object({
  text: z.string(),
  finishReason: z.enum(["stop", "length", "content-filter", "tool-calls", "error", "other"]),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
});

// --- `streamText` Schemas ---

/**
 * Input parameters for a `streamText` call.
 * This is a subset of the AI SDK's `StreamTextOptions`.
 */
export const strandweaveStreamTextOptionsSchema = strandweaveGenerateTextOptionsSchema; // Same options as generateText

/**
 * The result from a `streamText` call.
 * We simplify this to focus on the text stream and the final result promise.
 * The textStream is an AsyncIterableStream<string> according to the docs.
 */
export const strandweaveStreamTextResultSchema = z.object({
  textStream: z.custom<AsyncIterable<string>>(), // AsyncIterableStream<string> is AsyncIterable<string> & ReadableStream<string>
  // We can't easily represent the full promise-based result in Zod,
  // so we'll handle that with TypeScript types.
});

// --- `generateObject` Schemas ---

/**
 * Input parameters for a `generateObject` call.
 * This is a subset of the AI SDK's `GenerateObjectOptions`.
 * Supports both schema-based and no-schema generation.
 *
 * Note: Model is optional for the same reason as in generateText -
 * it's provided by the concrete implementation.
 */
export const strandweaveGenerateObjectOptionsSchema = strandweaveLlmCallParamsSchema.extend({
  model: z.custom<LanguageModel>().optional(), // Optional - provided by concrete implementation
  schema: z.custom<z.ZodSchema<unknown>>().optional(), // Optional for 'no-schema' or enum output
  messages: z.array(strandweaveModelMessageSchema),
  system: z.string().optional(),
  mode: z.enum(["auto", "json", "tool"]).optional(),
  output: z.enum(["object", "array", "enum", "no-schema"]).optional(),
  enum: z.array(z.string()).optional(), // For enum output mode
  schemaName: z.string().optional(),
  schemaDescription: z.string().optional(),
});

/**
 * The result from a `generateObject` call.
 * This is a subset of the AI SDK's `GenerateObjectResult`.
 */
export const strandweaveGenerateObjectResultSchema = z.object({
  object: z.any(),
  finishReason: z.enum(["stop", "length", "content-filter", "error", "other"]),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
});

// --- Exported TypeScript Types ---

export type StrandweaveLlmCallParams = z.infer<typeof strandweaveLlmCallParamsSchema>;
export type StrandweaveGenerateTextOptions = z.infer<typeof strandweaveGenerateTextOptionsSchema>;
export type StrandweaveGenerateTextResult = z.infer<typeof strandweaveGenerateTextResultSchema>;
export type StrandweaveStreamTextOptions = z.infer<typeof strandweaveStreamTextOptionsSchema>;
// StreamTextResult is complex, so we define it more carefully.
// According to the docs, textStream is AsyncIterableStream<string> which is AsyncIterable<string> & ReadableStream<string>
export type StrandweaveStreamTextResult = {
  textStream: AsyncIterable<string> & ReadableStream<string>;
  // The promises for the final state are essential for testing.
  usage: Promise<{ inputTokens: number; outputTokens: number }>;
  finishReason: Promise<"stop" | "length" | "content-filter" | "tool-calls" | "error" | "other">;
  // Add other promises as needed for tests, e.g., `text`.
  text: Promise<string>;
};
export type StrandweaveGenerateObjectOptions = z.infer<
  typeof strandweaveGenerateObjectOptionsSchema
>;
export type StrandweaveGenerateObjectResult<T> = Omit<
  z.infer<typeof strandweaveGenerateObjectResultSchema>,
  "object"
> & { object: T };

// --- Structured Output Context ---

/**
 * Context for structured output configuration in sentinels.
 * Contains the loaded Zod schema and output mode settings.
 */
export interface StructuredOutputContext {
  zodSchema?: z.ZodType<unknown>; // Optional - undefined for enum mode
  output: "object" | "array" | "enum";
  schemaName?: string;
  schemaDescription?: string;
  enumValues?: string[]; // For enum output mode only
}

// --- TYPE COMPATIBILITY NOTES ---
// These types are designed to be compatible subsets of the AI SDK types.
// They should be usable as parameters for generateText, streamText, and generateObject
// functions from the AI SDK, though they may be more restrictive than the full SDK types.
