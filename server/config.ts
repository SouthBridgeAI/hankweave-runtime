import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { validateModel } from "./config-validation/model-validator.js";
import { codonSentinelEntrySchema } from "./config-validation/sentinel.schema.js";
import { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import type { ModelInfo } from "./llm/models-dev-schema.js";
import { CodonId } from "./types/branded-types.js";
import type { ModelName, ShimSelfTestResult } from "./types/types.js";
import { deepMerge, getMetadata, type Logger } from "./utils.js";

// Get version from package metadata
const PACKAGE_VERSION = getMetadata().version;

// -------------
// Constants
// -------------

export const TIMEOUTS = {
  RESULT_MESSAGE_MS: 30000, // 30 seconds to wait for result message
  PROCESS_KILL_GRACE_MS: 5000, // 5 seconds grace period before SIGKILL
  LOG_PARSER_DELAY_MS: 100, // 100ms delay for log parsing
  CODON_CLEANUP_DELAY_MS: 100, // 100ms delay for codon cleanup
} as const;

/**
 * Common typos/mistakes mapped to correct field names.
 * Used to provide helpful "Did you mean X?" suggestions.
 */
export const FIELD_TYPO_MAP: Record<string, string> = {
  // System prompt typos
  systemPromptFile: "appendSystemPromptFile",
  systemPromptText: "appendSystemPromptText",
  systemPrompt: "appendSystemPromptFile or appendSystemPromptText",

  // Prompt typos
  prompt: "promptFile or promptText",
  prompts: "promptFile",
  promptFiles: "promptFile",

  // Checkpointing typos
  trackedFiles: "checkpointedFiles",
  tracking: "checkpointedFiles",
  tracked: "checkpointedFiles",
  watchedFiles: "checkpointedFiles",
  fileTracking: "checkpointedFiles",

  // Rig typos
  rig: "rigSetup",
  setup: "rigSetup",
  preSetup: "rigSetup",

  // Other typos
  environment: "env",
  envVars: "env",
  outputs: "outputFiles",
  output: "outputFiles",
  continuation: "continuationMode",
  mode: "continuationMode",
};

// -------------
// Error Formatting
// -------------

/**
 * Format Zod validation errors into a user-friendly message.
 * Provides context about which codon has the error and what field is affected.
 *
 * Handles both:
 * - Direct codon array validation (path: [0, "field"])
 * - Hank file validation (path: ["hank", 0, "field"])
 */
function formatZodErrors(error: z.ZodError, rawConfig: unknown): string {
  const errors: string[] = [];

  for (const issue of error.issues) {
    // Clone the path to avoid mutation
    let adjustedPath = [...issue.path];
    let errorMsg = "";

    // Handle paths that start with "hank" (from hankFileSchema)
    // Convert ["hank", 0, "field"] to [0, "field"] and extract the hank array
    let hankArray: unknown[] | null = null;
    if (adjustedPath[0] === "hank") {
      const hankFile = rawConfig as { hank?: unknown[] };
      if (hankFile?.hank && Array.isArray(hankFile.hank)) {
        hankArray = hankFile.hank;
      }
      adjustedPath = adjustedPath.slice(1); // Remove "hank" prefix
    } else if (Array.isArray(rawConfig)) {
      hankArray = rawConfig;
    }

    // Determine if this is a codon-level error
    if (adjustedPath[0] === undefined && issue.code === "too_small") {
      errorMsg = `  - ${issue.message}`;
    } else if (typeof adjustedPath[0] === "number") {
      // This is an error in a specific codon/loop
      const codonIndex = adjustedPath[0];
      const codonData = hankArray ? hankArray[codonIndex] : null;
      const codonId = (codonData as Record<string, unknown>)?.id || `index ${codonIndex}`;
      const codonName = (codonData as Record<string, unknown>)?.name || "unnamed";
      const isLoop = (codonData as Record<string, unknown>)?.type === "loop";
      const itemType = isLoop ? "Loop" : "Codon";

      if (isLoop && adjustedPath[1] === "codons" && typeof adjustedPath[2] === "number") {
        const nestedIndex = adjustedPath[2];
        const nestedCodons = (codonData as Record<string, unknown>)?.codons;
        const nestedData = Array.isArray(nestedCodons)
          ? (nestedCodons[nestedIndex] as Record<string, unknown> | undefined)
          : undefined;
        const nestedId = nestedData?.id || `index ${nestedIndex}`;
        const nestedName = nestedData?.name || "unnamed";

        if (adjustedPath.length === 3) {
          errorMsg = `  - ${itemType} "${codonName}" (${codonId}) -> Codon "${nestedName}" (${nestedId}): ${issue.message}`;
        } else {
          const fieldPath = adjustedPath.slice(3).join(".");
          errorMsg = `  - ${itemType} "${codonName}" (${codonId}) -> Codon "${nestedName}" (${nestedId}) - ${fieldPath}: ${issue.message}`;
        }
      } else if (adjustedPath.length === 1) {
        // Top-level codon/loop error
        errorMsg = `  - ${itemType} "${codonName}" (${codonId}): ${issue.message}`;
      } else {
        // Field-specific error
        const fieldPath = adjustedPath.slice(1).join(".");
        errorMsg = `  - ${itemType} "${codonName}" (${codonId}) - ${fieldPath}: ${issue.message}`;
      }
    } else if (issue.code === "unrecognized_keys") {
      // Handle unrecognized keys specially
      const keys = (issue as z.ZodIssue & { keys?: string[] }).keys?.join(", ");
      const codonIndex = typeof adjustedPath[0] === "number" ? adjustedPath[0] : undefined;
      const codonData = codonIndex !== undefined && hankArray ? hankArray[codonIndex] : null;
      const codonId =
        (codonData as Record<string, unknown>)?.id ||
        (codonIndex !== undefined ? `index ${codonIndex}` : "");
      const codonName = (codonData as Record<string, unknown>)?.name || "unnamed";

      if (codonIndex !== undefined) {
        const isLoop = (codonData as Record<string, unknown>)?.type === "loop";
        const itemType = isLoop ? "Loop" : "Codon";
        const validFields = isLoop ? VALID_LOOP_FIELDS.join(", ") : VALID_CODON_FIELDS.join(", ");
        errorMsg = `  - ${itemType} "${codonName}" (${codonId}) has unrecognized field(s): ${keys}. Fix: Remove these fields or check for typos. Valid fields are: ${validFields}.`;
      } else {
        errorMsg = `  - Unrecognized field(s): ${keys}. Fix: Remove these fields or check for typos.`;
      }
    } else {
      // Generic error
      const fieldPath = issue.path.join(".");
      errorMsg = `  - ${fieldPath || "Configuration"}: ${issue.message}`;
    }

    errors.push(errorMsg);
  }

  return errors.join("\n");
}

// -------------
// Configuration Schema
// -------------

const shellCommandWorkingDirectory = ["project"] as const;

// when running rig setup commands, it's useful to have "lastCopied" option
// to coordinate with copy commands
const rigSetupCommandWorkingDirectory = [...shellCommandWorkingDirectory, "lastCopied"] as const;

export const shellCommandSchema = z.object({
  type: z.literal("command").describe("Type of setup operation"),
  command: z.object({
    run: z.string().min(1, "Command cannot be empty").describe("Shell command to execute"),
    workingDirectory: z
      .enum(shellCommandWorkingDirectory)
      .optional()
      .default("project")
      .describe("Working directory for command execution (default: 'project')"),
  }),
});

export const rigShellCommandSchema = shellCommandSchema.extend({
  command: shellCommandSchema.shape.command.extend({
    workingDirectory: z
      .enum(rigSetupCommandWorkingDirectory)
      .optional()
      .default("project")
      .describe("Working directory for command execution (default: 'project')"),
  }),
});

export const rigSetupItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("copy").describe("Type of setup operation"),
    copy: z.object({
      from: z
        .string()
        .min(1, "Source path cannot be empty")
        .describe("Source path (relative to config file or absolute)"),
      to: z
        .string()
        .min(1, "Target path cannot be empty")
        .describe(
          "Target path relative to projectPath (parent directory must exist). Always specifies the full target path including name. Examples: from: '../templates/foo', to: 'src/foo' → copies directory foo to src/foo; from: '../templates/foo', to: 'src/bar' → copies directory foo as src/bar; from: '../config.json', to: 'src/config.json' → copies file; from: '../config.json', to: 'src/settings.json' → copies file with rename",
        ),
    }),
    allowFailure: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, failure of this operation won't fail the codon (default: false). Recommended for rig setup in loop codons where operations might fail in some iterations (e.g., copying files that don't exist yet).",
      ),
  }),
  rigShellCommandSchema.extend({
    allowFailure: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, failure of this operation won't fail the codon (default: false). Recommended for rig setup in loop codons where operations might fail in some iterations (e.g., running commands that might not succeed initially).",
      ),
  }),
]);

// Output copy item schema (array of these under codon.outputFiles)
const codonOutputItemSchema = z
  .object({
    copy: z
      .array(z.string())
      .min(1, "The 'copy' array cannot be empty.")
      .describe("Glob patterns to copy from execution directory to output directory"),
    beforeCopy: z
      .array(shellCommandSchema)
      .optional()
      .describe("Optional commands to run before copying (run in executionPath)"),
  })
  .strict();

const codonOutputSchema = z.array(codonOutputItemSchema).optional();

// -------------
// Loop Termination Conditions
// -------------

/**
 * Loop termination conditions define when a loop should stop iterating.
 * - iterationLimit: Stop after a fixed number of iterations
 * - contextExceeded: Stop when Claude signals context exhaustion
 */
export const loopTerminationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("iterationLimit"),
    limit: z.number().int().min(1, "Iteration limit must be at least 1"),
  }),
  z.object({
    type: z.literal("contextExceeded"),
  }),
]);

// -------------
// Model Validation Helpers
// -------------

/**
 * Reusable model validation refinement.
 * Returns true if model is valid or undefined, false otherwise.
 */
function modelValidationRefinement(model: string | undefined): boolean {
  if (!model) return true;
  const registry = LlmProviderRegistry.getInstance();
  const result = validateModel(model, registry);
  return result.valid;
}

/**
 * Reusable model validation error message generator.
 * Used in Zod refinements to provide consistent error messages.
 */
function modelValidationError(model: string | undefined) {
  const registry = LlmProviderRegistry.getInstance();
  if (!model) throw new Error("Unreachable");
  const result = validateModel(model, registry);
  return {
    message: `Invalid model '${model}': ${result.reason}`,
    path: ["model"],
  };
}

// -------------
// Codon and Loop Schemas
// -------------

/**
 * Base codon object schema (before refinements).
 * The type field is optional and defaults to "codon".
 */
export const codonObjectSchema = z.object({
  type: z
    .literal("codon")
    .optional()
    .default("codon")
    .describe("Type discriminator - optional, defaults to 'codon'"),
  id: z
    .string()
    .min(
      1,
      "Codon ID cannot be empty. This uniquely identifies your codon (e.g., 'codon-1', 'analysis'). Fix: Add a unique id field.",
    )
    .describe("Unique identifier for this codon (e.g., 'codon-1', 'data-analysis')"),
  name: z
    .string()
    .min(
      1,
      "Codon name cannot be empty. This is the human-readable name shown in the UI. Fix: Add a descriptive name field.",
    )
    .describe("Human-readable name displayed in UI and logs"),
  promptFile: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Path to a file containing the prompt (mutually exclusive with promptText)"),
  promptText: z
    .string()
    .optional()
    .describe("Inline prompt text (mutually exclusive with promptFile)"),
  appendSystemPromptFile: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      "Path to a file containing system prompt to append (mutually exclusive with appendSystemPromptText)",
    ),
  appendSystemPromptText: z
    .string()
    .optional()
    .describe(
      "Inline system prompt text to append (mutually exclusive with appendSystemPromptFile)",
    ),
  model: z
    .string()
    .min(1, "Model cannot be empty")
    .describe(
      "Model to use for this codon. Can be a Claude model ('sonnet', 'opus'), Gemini model ('gemini-2.0-flash-exp', 'flash'), or any other model supported by the configured shim.",
    ),
  continuationMode: z
    .enum(["fresh", "continue-previous"], {
      errorMap: () => ({
        message:
          "continuationMode must be either 'fresh' or 'continue-previous'. This controls whether to start a new conversation or continue from the previous codon. Fix: Add continuationMode field with either 'fresh' (new conversation) or 'continue-previous' (maintain context).",
      }),
    })
    .describe(
      "How this codon should handle continuation from previous codons. 'fresh': Start a new session (default for most cases). 'continue-previous': Continue from the previous codon's session, maintaining context and conversation history. The previous codon must have completed successfully.",
    ),
  rigSetup: z
    .array(rigSetupItemSchema)
    .optional()
    .describe(
      "Rig setup operations to run before codon starts. Each operation must complete successfully for codon to start.",
    ),
  description: z
    .string()
    .optional()
    .describe("Optional description shown to users about what this codon does"),
  checkpointedFiles: z
    .array(z.string())
    .optional()
    .describe(
      "Glob patterns for files to checkpoint during codon execution. These files will be: watched for changes and streamed to the client, tracked in the git-based checkpoint system, and resolved using gitignore rules for consistency.",
    ),
  env: z
    .record(z.string())
    .optional()
    .describe("Optional environment variables to set for the Claude process"),
  outputFiles: codonOutputSchema.describe(
    "Optional output copy steps to run after codon completion: files to copy out from a completed codon, with optional pre-copy commands.",
  ),
  sentinels: z
    .array(codonSentinelEntrySchema)
    .optional()
    .describe(
      "Sentinels to run during this codon. Sentinels are parallel observation agents that process the event stream. Each entry is a wrapper object with sentinelConfig (portable sentinel configuration, file or inline) and settings (codon-specific settings like output paths and load requirements). This wrapper pattern keeps sentinel configs reusable across codons.",
    ),
});

/**
 * Single codon schema with refinements and model resolution.
 * Represents one executable codon.
 *
 * NOTE: This schema TRANSFORMS the model field from string to ModelInfo object.
 * This is different from config schemas (hankRecommendationsSchema, runtimeConfigSchema)
 * which keep model as string to allow for config layer merging.
 */
export const codonSchema = codonObjectSchema
  .strict()
  .refine((data) => data.promptFile || data.promptText, {
    message:
      "Either promptFile or promptText must be provided. The prompt tells Claude what to do in this codon. Fix: Add either promptFile (path to .md file) or promptText (inline prompt string).",
  })
  .refine((data) => !(data.appendSystemPromptFile && data.appendSystemPromptText), {
    message:
      "Cannot specify both appendSystemPromptFile and appendSystemPromptText. Use one or the other to add system-level instructions. Fix: Remove one of these fields.",
  })
  .transform((codon, ctx) => {
    const registry = LlmProviderRegistry.getInstance();
    const result = validateModel(codon.model, registry);

    if (!result.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid model '${codon.model}': ${result.reason}`,
        path: ["model"],
      });
      return z.NEVER;
    }

    // Replace model string with ModelInfo object
    // This transformation is specific to codons - config schemas keep model as string
    return {
      ...codon,
      model: result.modelInfo,
    };
  });

/**
 * Loop schema - contains multiple codons that repeat.
 * Only allows Codon children (no nested loops in v1).
 *
 * Note: We use a forward reference approach here to prevent circular dependencies.
 * The codons array will be validated after the discriminated union is parsed.
 */
export const loopSchema = z.object({
  type: z.literal("loop").describe("Type discriminator - required for loops"),
  id: z
    .string()
    .min(
      1,
      "Loop ID cannot be empty. This uniquely identifies your loop (e.g., 'iterative-development'). Fix: Add a unique id field.",
    )
    .describe("Unique identifier for this loop (e.g., 'iterative-development')"),
  name: z
    .string()
    .min(
      1,
      "Loop name cannot be empty. This is the human-readable name shown in the UI. Fix: Add a descriptive name field.",
    )
    .describe("Human-readable name displayed in UI and logs"),
  description: z
    .string()
    .optional()
    .describe("Optional description shown to users about what this loop does"),
  terminateOn: loopTerminationSchema.describe("Termination condition for the loop"),
  codons: z
    .array(codonSchema)
    .min(1, "Loop must contain at least one codon. Fix: Add codons to the loop.")
    .describe(
      "Array of codons to execute in each iteration. Only Codon objects allowed (no nested loops).",
    ),
});

/**
 * CodonConfig is a discriminated union of Codon and Loop.
 * Used in hank.json configuration.
 */
export const codonConfigSchema = z.union([
  codonSchema, // type: "codon" (or omitted, defaults to "codon")
  loopSchema.strict(), // type: "loop"
]);

// Note: codonConfigArraySchema is kept for backwards compatibility but
// hankFileSchema now uses codonConfigArraySchemaWithDetailedErrors for better errors
const _codonConfigArraySchema = z.array(codonConfigSchema).min(1, "At least one codon required");

// -------------
// Field Validation (Derived from Schemas)
// -------------

/**
 * Valid fields for codon objects - derived from codonObjectSchema.
 * This ensures the valid field list stays in sync with the schema automatically.
 */
export const VALID_CODON_FIELDS = Object.keys(codonObjectSchema.shape) as Array<
  keyof typeof codonObjectSchema.shape
>;

/**
 * Valid fields for loop objects - derived from loopSchema.
 * This ensures the valid field list stays in sync with the schema automatically.
 */
export const VALID_LOOP_FIELDS = Object.keys(loopSchema.shape) as Array<
  keyof typeof loopSchema.shape
>;

/**
 * Helper function to check for unrecognized fields and provide typo suggestions.
 * Returns an error message if unrecognized fields are found, or null if valid.
 */
function checkUnrecognizedFields(
  item: Record<string, unknown>,
  isLoop: boolean,
): Array<{
  field: string;
  suggestion: string | null;
  validFields: readonly string[];
}> {
  const validFields: readonly string[] = isLoop ? VALID_LOOP_FIELDS : VALID_CODON_FIELDS;
  const results: Array<{
    field: string;
    suggestion: string | null;
    validFields: readonly string[];
  }> = [];

  for (const key of Object.keys(item)) {
    if (!validFields.includes(key)) {
      const suggestion = FIELD_TYPO_MAP[key] || null;
      results.push({ field: key, suggestion, validFields });
    }
  }

  return results;
}

/**
 * Schema for the hank array that validates each item individually.
 *
 * This provides much better error messages than z.union() by:
 * 1. Detecting item type and using the correct schema
 * 2. Catching unrecognized keys with typo suggestions
 * 3. Providing codon-specific context in errors
 *
 * The key insight is that z.union() gives generic "Invalid input" errors when
 * neither branch matches (e.g., when a codon has an unrecognized field).
 * By validating each item individually, we can provide detailed errors.
 */
const codonConfigArraySchemaWithDetailedErrors = z
  .array(z.unknown())
  .min(1, "At least one codon required")
  .superRefine((items, ctx) => {
    for (const [index, item] of items.entries()) {
      // Skip non-objects
      if (!item || typeof item !== "object") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Item at index ${index} must be an object (codon or loop)`,
        });
        continue;
      }

      const itemObj = item as Record<string, unknown>;
      const itemType = itemObj.type;
      const isLoop = itemType === "loop";
      // Check for unrecognized fields FIRST with typo suggestions (top-level item)
      const unrecognizedChecks = checkUnrecognizedFields(itemObj, isLoop);
      for (const { field, suggestion, validFields } of unrecognizedChecks) {
        if (suggestion) {
          // Known typo - provide helpful suggestion
          // Don't include itemLabel here since formatZodErrors adds context
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, field],
            message: `Unknown field "${field}". Did you mean "${suggestion}"?`,
          });
        } else {
          // Unknown field - list valid options
          ctx.addIssue({
            code: z.ZodIssueCode.unrecognized_keys,
            keys: [field],
            path: [index],
            message: `Unrecognized field "${field}". Valid fields are: ${validFields.join(", ")}.`,
          });
        }
      }

      // If this is a loop, also check nested codons for unrecognized fields
      if (isLoop && Array.isArray(itemObj.codons)) {
        for (const [codonIndex, codon] of itemObj.codons.entries()) {
          if (!codon || typeof codon !== "object") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, "codons", codonIndex],
              message: `Loop codon at index ${codonIndex} must be an object`,
            });
            continue;
          }

          const codonObj = codon as Record<string, unknown>;
          const nestedChecks = checkUnrecognizedFields(codonObj, false);
          for (const { field, suggestion, validFields } of nestedChecks) {
            if (suggestion) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [index, "codons", codonIndex, field],
                message: `Unknown field "${field}". Did you mean "${suggestion}"?`,
              });
            } else {
              ctx.addIssue({
                code: z.ZodIssueCode.unrecognized_keys,
                keys: [field],
                path: [index, "codons", codonIndex],
                message: `Unrecognized field "${field}". Valid fields are: ${validFields.join(", ")}.`,
              });
            }
          }
        }
      }

      // Validate against the appropriate schema
      const schema = isLoop ? loopSchema.strict() : codonSchema;
      const result = schema.safeParse(item);

      if (!result.success) {
        // Forward each error with the correct path
        for (const issue of result.error.issues) {
          // Skip unrecognized_keys only for top-level items (already handled above)
          if (issue.code === "unrecognized_keys" && issue.path.length === 0) {
            continue;
          }

          ctx.addIssue({
            ...issue,
            path: [index, ...issue.path],
          });
        }
      }
    }
  })
  .transform((items) => {
    // After superRefine passes, re-validate and transform each item
    // This is needed because superRefine doesn't transform the data
    return items.map((item) => {
      const itemType = (item as Record<string, unknown>)?.type;
      if (itemType === "loop") {
        return loopSchema.strict().parse(item);
      }
      return codonSchema.parse(item);
    });
  });

// -------------
// New Config System Schemas
// -------------

/**
 * Schema for hank metadata
 */
export const hankMetaSchema = z.object({
  name: z.string().min(1, "Hank name cannot be empty").describe("Human-readable name for the hank"),
  version: z
    .string()
    .min(1, "Hank version cannot be empty")
    .describe("Version number (e.g., '1.0.0')"),
  description: z.string().optional().describe("Optional description of what this hank does"),
  author: z.string().optional().describe("Optional author information"),
});

/**
 * Shared schema for sentinel system settings.
 * Used in both overrides and runtime config.
 */
const sentinelSettingsSchema = z
  .object({
    enablePersistence: z
      .boolean()
      .optional()
      .describe("Enable filesystem persistence for sentinel outputs"),
    healthCheckGracePeriodMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Grace period for sentinel health checks (milliseconds)"),
    waitForAllHealthChecks: z
      .boolean()
      .optional()
      .describe("Wait for all health checks before loading sentinels"),
  })
  .strict();

/**
 * Schema for architect's overrides
 *
 * NOTE: This schema keeps model as a STRING (does NOT transform to ModelInfo).
 * This allows overrides to be merged with other config layers during resolveSettings().
 * The model string is validated but not transformed, maintaining flexibility for config merging.
 */
export const hankOverridesSchema = z
  .object({
    model: z
      .string()
      .optional()
      .describe(
        "Override model for this hank (e.g., 'sonnet' for Claude, 'flash' for Gemini, 'This task needs high reasoning')",
      ),
    dataHashTimeLimit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Override time limit for data hashing in milliseconds"),
    sentinel: sentinelSettingsSchema.optional().describe("Override sentinel system settings"),
  })
  .strict()
  .refine(
    (overrides) => modelValidationRefinement(overrides.model),
    (overrides) => modelValidationError(overrides.model),
  );

/**
 * Schema for hank file (hank.json).
 *
 * Must contain a hank array, with optional meta and overrides.
 *
 * Uses codonConfigArraySchemaWithDetailedErrors for better validation errors
 * when codon fields have typos or unrecognized fields.
 */
export const hankFileSchema = z.object({
  meta: hankMetaSchema.optional().describe("Metadata for sharing/indexing (optional)"),
  overrides: hankOverridesSchema
    .optional()
    .describe("Architect's overrides for optimal execution (optional)"),
  hank: codonConfigArraySchemaWithDetailedErrors.describe(
    "The immutable logic sequence (required)",
  ),
});

// -------------
// Schemas for JSON Schema Generation (authoring/input types)
// IMPORTANT: Keep these synchronized with the runtime schemas above.
// The test suite (json-schema.test.ts) includes parity tests to catch drift.
// See the "Schema Strictness Reference" table in the implementation plan for strictness behavior.
// -------------

/**
 * Authoring schema for loops - uses codonObjectSchema (no transform) instead of codonSchema.
 * This describes what users write in JSON files.
 *
 * STRICTNESS: .strict() is called here directly, matching how loopSchema.strict() is called
 * in the codonConfigSchema union (config.ts line 467). Both result in strict validation.
 */
export const loopAuthoringSchema = z
  .object({
    type: z.literal("loop").describe("Type discriminator - required for loops"),
    id: z.string().min(1).describe("Unique identifier for this loop"),
    name: z.string().min(1).describe("Human-readable name displayed in UI and logs"),
    description: z.string().optional().describe("Optional description shown to users"),
    terminateOn: loopTerminationSchema.describe("Termination condition for the loop"),
    codons: z
      .array(codonObjectSchema.strict())
      .min(1)
      .describe("Array of codons to execute in each iteration"),
  })
  .strict(); // Matches loopSchema.strict() in codonConfigSchema

/**
 * Authoring schema for codon config - union of codon and loop, both using input types.
 *
 * STRICTNESS: Mirrors codonConfigSchema (config.ts line 465-468).
 * - codonObjectSchema.strict() matches codonSchema which has .strict() at line 394
 * - loopAuthoringSchema already has .strict() (see above)
 */
export const codonConfigAuthoringSchema = z.union([
  codonObjectSchema.strict(), // Matches codonSchema's built-in .strict()
  loopAuthoringSchema, // Already .strict()
]);

/**
 * Authoring schema for hank files - used for JSON Schema generation.
 * Explicitly allows $schema for editor support.
 *
 * STRICTNESS: NOT strict - matches hankFileSchema (config.ts line 712) which allows
 * unknown keys at root level. This is intentional: $schema and other unknown keys
 * should be allowed at the root for extensibility.
 */
export const hankFileAuthoringSchema = z.object({
  $schema: z.string().optional().describe("JSON Schema URL for editor support"),
  meta: hankMetaSchema.optional().describe("Metadata for sharing/indexing (optional)"),
  overrides: hankOverridesSchema.optional().describe("Architect's overrides (optional)"),
  hank: z
    .array(codonConfigAuthoringSchema)
    .min(1)
    .describe("The immutable logic sequence (required)"),
}); // NOT .strict() - intentionally allows unknown root keys like $schema

/**
 * Schema for runtime configuration (hankweave.json)
 *
 * NOTE: This schema keeps model as a STRING (does NOT transform to ModelInfo).
 * This allows runtime config to be merged with other config layers (CLI args, env vars, defaults)
 * during resolveSettings(). The model string is validated but not transformed, maintaining
 * flexibility for the config merging process.
 */
export const runtimeConfigSchema = z
  .object({
    // Server Behaviors
    port: z.number().int().positive().optional().describe("WebSocket server port"),
    autostart: z.boolean().optional().describe("If true, run immediately on client connect"),
    withoutProxy: z.boolean().optional().describe("Bypass internal LLM proxy"),

    // Model & API
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "User's preferred default model. Can be a short name like 'sonnet' or 'opus', a Gemini model like 'gemini-2.0-flash', or any model supported by the configured providers. Validation happens at runtime via LLMRegistry.",
      ),
    anthropicBaseUrl: z
      .string()
      .url()
      .optional()
      .describe("Custom Anthropic API base URL (for corporate proxies)"),

    // Resources & Limits
    outputDirectory: z.string().optional().describe("Where to put results (relative to CWD)"),
    executionBaseDir: z.string().optional().describe("Where to create temp execution environments"),
    logParsingInterval: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Interval for parsing Claude log files (milliseconds)"),
    dataHashTimeLimit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Time limit for hashing directories (milliseconds)"),
    idleTimeout: z
      .number()
      .int()
      .min(0, "Idle timeout must be at least 0")
      .max(255, "Idle timeout must be at most 255")
      .optional()
      .describe(
        "Idle timeout for WebSocket and proxy servers in seconds (0-255). This is the maximum amount of time a connection is allowed to be idle before the server closes it. A connection is idling if there is no data sent or received.",
      ),

    // Sentinel System
    sentinel: sentinelSettingsSchema.optional().describe("Sentinel system configuration"),
  })
  .strict()
  .refine(
    (config) => modelValidationRefinement(config.model),
    (config) => modelValidationError(config.model),
  );

// -------------
// Inferred Types from Schemas
// -------------

export type ShellCommand = z.input<typeof shellCommandSchema>;
export type RigShellCommand = z.input<typeof rigShellCommandSchema>;
export type RigSetupItem = z.output<typeof rigSetupItemSchema>;
export type LoopTermination = z.infer<typeof loopTerminationSchema>;

// After parsing through Zod, model fields in Codons are transformed to ModelInfo
// Use z.output to get the type after transforms
// Explicitly type model as ModelInfo since the transform can't infer it from dynamic require()
export type Codon = Omit<z.infer<typeof codonObjectSchema>, "model"> & {
  model: ModelInfo;
};
export type Loop = Omit<z.infer<typeof loopSchema>, "codons"> & {
  codons: Codon[];
};
export type CodonConfig = Codon | Loop;
export type HankMeta = z.infer<typeof hankMetaSchema>;

// RuntimeConfig and HankOverrides keep model as string (no transform in schemas)
// This allows for config merging with raw string values
export type HankOverrides = z.infer<typeof hankOverridesSchema>;
export type HankFile = z.infer<typeof hankFileSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

/**
 * Main server configuration containing all runtime settings.
 * Extends RuntimeConfig with all fields required (defaults filled in) plus additional internal/execution properties.
 * This is the complete, finalized config assembled from all layers (CLI, env, files, defaults).
 */
export interface HankweaveConfig
  extends Omit<Required<RuntimeConfig>, "model" | "anthropicBaseUrl"> {
  // Fields from RuntimeConfig that remain optional
  /** Optional custom base URL for Anthropic API (e.g., for proxies or gateways) */
  anthropicBaseUrl?: string;

  /**
   * Model setting - behavior depends on resolution layer:
   * - If set via CLI/Env/RuntimeConfig (layers 1-3): Overrides ALL codon models globally
   * - If set via Recommendations/Defaults (layers 4-5): Used as fallback for codons without model specified
   */
  model?: ModelName;

  // Additional internal properties (not in RuntimeConfig)
  /** Server version for client compatibility checks */
  version: string;

  /** Path to lock file preventing multiple server instances */
  lockFile: string;

  /** Path to WebSocket traffic log file */
  socketLogFile: string;

  /** Path to general server log file */
  serverLogFile: string;

  /** Current working directory for the server process */
  cwd: string;

  /** Path to the codon configuration file (for resolving relative sentinel paths) */
  configPath?: string;

  /** Maximum length for tool result content before truncation (default: 2500) */
  toolResultTruncateLength: number;

  /** Maximum number of recent events to include in handshake response (default: 50) */
  handshakeHistoryLimit: number;

  // Execution-specific properties (from ExecutionSetup)
  /** Original data location (for reference only) */
  readOnlySourceDataPath: string;
  /** Primary directory where everything runs */
  executionPath: string;
  /** executionPath + '/data' - ONLY for setup */
  dataPathInExecutionDir: string;
  /** Hash of the data directory structure */
  dataHash: string;
  /** Whether this is a new execution */
  isNewExecution: boolean;
  /** Whether we're resuming an existing execution */
  isResuming: boolean;
  /** How data is linked (symlink or copy) */
  linkType: "symlink" | "copy";

  /** Array of codon configurations to execute */
  codons: CodonConfig[];
}

// -------------
// Default Configuration
// -------------

/**
 * Default server configuration values.
 * Can be overridden by passing config to HankweaveRuntime constructor.
 *
 * Note: execution paths and codons must be provided by the user, as well as cwd
 */
export const DEFAULT_CONFIG: Omit<
  HankweaveConfig,
  | "cwd"
  | "readOnlySourceDataPath"
  | "executionPath"
  | "dataPathInExecutionDir"
  | "dataHash"
  | "isNewExecution"
  | "isResuming"
  | "linkType"
  | "codons"
> = {
  port: 7777,
  version: PACKAGE_VERSION,
  outputDirectory: "hankweave-results",
  executionBaseDir: path.join(os.homedir(), ".hankweave-executions"),
  lockFile: ".hankweave/runtime.lock",
  socketLogFile: ".hankweave/logs/websocket.log",
  serverLogFile: ".hankweave/logs/server.log",
  logParsingInterval: 1000, // Check for new log entries every second
  autostart: true, // Default to current behavior
  dataHashTimeLimit: 5000, // 5 seconds for directory hashing
  toolResultTruncateLength: 2500, // Default truncation length for tool results
  withoutProxy: true, // Proxy disabled by default (enable with --proxy)
  handshakeHistoryLimit: 50, // Maximum recent events to include in handshake response
  idleTimeout: 0, // 0 seconds idle timeout (ie no timeout) for WebSocket and proxy servers (0-255)
  sentinel: {
    enablePersistence: true,
    healthCheckGracePeriodMs: 2000, // 2 seconds
    waitForAllHealthChecks: false,
  },
};

// -------------
// Configuration Loading
// -------------

/** Default schema URL for hank.json files (unpkg CDN for npm package) */
export const HANK_SCHEMA_URL = "https://unpkg.com/hankweave@latest/schemas/hank.schema.json";

/**
 * Ensure a hank.json file has a $schema property for editor support.
 * If missing, adds it and writes the file back.
 *
 * @param hankPath - Path to the hank.json file
 * @returns true if $schema was added, false if it already existed
 */
export function ensureSchemaUrl(hankPath: string): boolean {
  try {
    const content = fs.readFileSync(hankPath, "utf-8");
    const rawConfig = JSON.parse(content);

    // Already has $schema - nothing to do
    if (rawConfig.$schema) {
      return false;
    }

    // Add $schema at the beginning of the object
    const updatedConfig = {
      $schema: HANK_SCHEMA_URL,
      ...rawConfig,
    };

    // Write back with same formatting (2-space indent)
    fs.writeFileSync(hankPath, `${JSON.stringify(updatedConfig, null, 2)}\n`);
    return true;
  } catch {
    // If anything goes wrong (file not found, invalid JSON, etc.), silently skip
    // The actual validation will catch these errors with proper messages
    return false;
  }
}

/**
 * Load and parse a hank file (hank.json).
 * Returns the structured file with meta, overrides, and hank (codons array).
 *
 * @param hankPath - Path to the hank.json file
 * @returns Parsed and validated hank file (with un-branded IDs from Zod)
 * @throws Error with detailed validation messages if file is invalid
 */
export function loadHankFile(options: {
  hankPath: string;
  modelOverride?: string;
}): z.infer<typeof hankFileSchema> {
  try {
    const { hankPath, modelOverride } = options;
    const content = fs.readFileSync(hankPath, "utf-8");
    const rawConfig = JSON.parse(content);

    // Apply model override directly to the raw hank JSON before schema validation.
    // This keeps the full Zod validation + model transformation pipeline intact while ensuring per-codon model strings don't block a
    // valid global override.
    // It avoids duplicating schemas or bypassing validation, and makes override
    // semantics explicit: we validate the effective config that will run.
    const applyModelOverrideRecursive = (configs: unknown): unknown => {
      if (!Array.isArray(configs)) {
        return configs;
      }
      return configs.map((config) => {
        if (!config || typeof config !== "object") {
          return config;
        }
        const configObj = config as Record<string, unknown>;
        if (configObj.type === "loop") {
          return {
            ...configObj,
            codons: applyModelOverrideRecursive(configObj.codons),
          };
        }
        return {
          ...configObj,
          model: modelOverride,
        };
      });
    };

    if (modelOverride && rawConfig && typeof rawConfig === "object") {
      const configObj = rawConfig as Record<string, unknown>;
      if ("hank" in configObj) {
        configObj.hank = applyModelOverrideRecursive(configObj.hank);
      }
    }

    // Validate with hankFileSchema
    const result = hankFileSchema.safeParse(rawConfig);
    if (!result.success) {
      const errors = formatZodErrors(result.error, rawConfig);
      throw new Error(`Invalid hank file:\n${errors}`);
    }

    return result.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Hank file not found: ${options.hankPath}`);
    }
    throw error;
  }
}

/**
 * Load and validate runtime configuration from hankweave.json.
 *
 * This file is optional and provides runtime settings like port, model, sentinel config, etc.
 * If the file doesn't exist, returns an empty object (all settings will use defaults or CLI overrides).
 *
 * @param runtimeConfigPath - Path to the hankweave.json file (optional, defaults to "hankweave.json" in cwd)
 * @returns Parsed and validated runtime config, or empty object if file doesn't exist
 * @throws Error with detailed validation messages if file exists but is invalid
 */
export function loadRuntimeConfig(runtimeConfigPath?: string): RuntimeConfig {
  const configPath = runtimeConfigPath || path.join(process.cwd(), "hankweave.json");

  // If file doesn't exist, return empty object (runtime config is optional)
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const rawConfig = JSON.parse(content);

    // Validate with runtimeConfigSchema
    const result = runtimeConfigSchema.safeParse(rawConfig);
    if (!result.success) {
      const errors = formatZodErrors(result.error, rawConfig);
      throw new Error(`Invalid runtime config file:\n${errors}`);
    }

    return result.data;
  } catch (error) {
    // Re-throw validation errors
    if (error instanceof Error && error.message.startsWith("Invalid runtime config")) {
      throw error;
    }
    // For other errors (like invalid JSON), provide helpful message
    throw new Error(
      `Failed to load runtime config from ${configPath}: ${(error as Error).message}`,
    );
  }
}

/**
 * Load configuration from HANKWEAVE_RUNTIME_* environment variables.
 *
 * Parses environment variables with the HANKWEAVE_RUNTIME_ prefix and converts them
 * to the runtime config structure. Handles type conversions and nested paths.
 *
 * Environment variable mapping:
 * - HANKWEAVE_RUNTIME_PORT -> port (number)
 * - HANKWEAVE_RUNTIME_MODEL -> model (enum: "sonnet" | "opus")
 * - HANKWEAVE_RUNTIME_AUTOSTART -> autostart (boolean)
 * - HANKWEAVE_RUNTIME_SENTINEL_ENABLE_PERSISTENCE -> sentinel.enablePersistence (boolean)
 *
 * Type conversions:
 * - Numbers: Parsed from strings (e.g., "8080" -> 8080)
 * - Booleans: "true"/"1" -> true, "false"/"0" -> false
 * - Strings: Passed through as-is
 *
 * @returns Parsed config object from environment variables (validated against schema)
 * @throws Error if environment variables contain invalid values
 */
export function loadHankweaveRuntimeEnvVars(): RuntimeConfig {
  const config: Record<string, unknown> = {};

  // Helper to convert snake_case to camelCase
  const toCamelCase = (str: string): string => {
    return str.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  };

  // Helper to parse value based on expected type
  const parseValue = (key: string, value: string): unknown => {
    // Boolean fields
    if (
      key === "autostart" ||
      key === "withoutProxy" ||
      key === "enablePersistence" ||
      key === "waitForAllHealthChecks"
    ) {
      return value === "true" || value === "1";
    }

    // Number fields
    if (
      key === "port" ||
      key === "logParsingInterval" ||
      key === "dataHashTimeLimit" ||
      key === "healthCheckGracePeriodMs" ||
      key === "idleTimeout"
    ) {
      const num = Number(value);
      if (Number.isNaN(num)) {
        throw new Error(`Invalid number value for ${key}: "${value}"`);
      }
      return num;
    }

    // String fields (including URLs and enums - will be validated by schema)
    return value;
  };

  // Process all HANKWEAVE_RUNTIME_* environment variables
  for (const [envKey, envValue] of Object.entries(process.env)) {
    if (!envKey.startsWith("HANKWEAVE_RUNTIME_") || !envValue) {
      continue;
    }

    // Remove prefix: HANKWEAVE_RUNTIME_PORT -> PORT
    const withoutPrefix = envKey.substring("HANKWEAVE_RUNTIME_".length);

    // Handle nested sentinel config: SENTINEL_ENABLE_PERSISTENCE
    if (withoutPrefix.startsWith("SENTINEL_")) {
      const sentinelKey = withoutPrefix.substring("SENTINEL_".length);
      const camelKey = toCamelCase(sentinelKey);

      if (!config.sentinel) {
        config.sentinel = {};
      }

      (config.sentinel as Record<string, unknown>)[camelKey] = parseValue(camelKey, envValue);
    } else {
      // Top-level config: PORT, MODEL, etc.
      const camelKey = toCamelCase(withoutPrefix);
      config[camelKey] = parseValue(camelKey, envValue);
    }
  }

  // Validate against schema
  const result = runtimeConfigSchema.safeParse(config);
  if (!result.success) {
    const errors = formatZodErrors(result.error, config);
    throw new Error(`Invalid environment variable configuration:\n${errors}`);
  }

  return result.data;
}

/**
 * Resolve final runtime configuration by merging all configuration layers.
 *
 * Configuration layers (in order of precedence, highest to lowest):
 * 1. CLI arguments (passed as cliArgs parameter) - highest priority
 * 2. Environment variables (HANKWEAVE_RUNTIME_*)
 * 3. Hank file overrides (hank.json > overrides)
 * 4. Runtime config file (hankweave.json)
 * 5. Default configuration (DEFAULT_CONFIG) - lowest priority
 *
 * @param options Configuration resolution options
 * @param options.cliArgs CLI arguments to merge (highest priority)
 * @param options.hankPath Path to hank.json file (for extracting overrides)
 * @param options.runtimeConfigPath Path to hankweave.json (defaults to ./hankweave.json)
 * @returns Fully resolved HankweaveConfig with all layers merged
 */
export function resolveSettings(options?: {
  cliArgs?: Partial<HankweaveConfig>;
  hankPath?: string;
  runtimeConfigPath?: string;
}): Partial<HankweaveConfig> {
  const { cliArgs = {}, hankPath, runtimeConfigPath } = options || {};

  // Layer 1 (base): Start with default configuration
  let config: Partial<HankweaveConfig> = { ...DEFAULT_CONFIG };

  // Layer 2: Merge runtime config file (hankweave.json)
  try {
    const runtimeConfig = loadRuntimeConfig(runtimeConfigPath);
    config = deepMerge(config, runtimeConfig);
  } catch (_error) {
    // Runtime config is optional, so silently continue if it doesn't exist
    // (loadRuntimeConfig already returns {} for missing files)
  }

  // Layer 3: Merge hank file overrides (if hank path provided)
  if (hankPath) {
    try {
      const hankFile = loadHankFile({ hankPath });

      if (hankFile.overrides) {
        config = deepMerge(config, hankFile.overrides);
      }
    } catch (_error) {
      // Hank file errors should not prevent config resolution
      // The hank file is validated separately during codon loading
    }
  }

  // Layer 4: Merge environment variables (HANKWEAVE_RUNTIME_*)
  const envConfig = loadHankweaveRuntimeEnvVars();
  config = deepMerge(config, envConfig);

  // Layer 5 (highest priority): Merge CLI arguments
  config = deepMerge(config, cliArgs);

  return config;
}

/**
 * Load and validate codon configuration from a hank file.
 *
 * Loads the hank file (object format with {meta, overrides, hank}),
 * extracts the hank (codons array), and resolves relative file paths.
 * Optionally applies model override to all codons.
 *
 * @param options.configPath - Path to the hank JSON configuration file
 * @param options.modelOverride - Optional model to override all codon models
 * @returns Validated array of codon configurations with resolved paths (and overridden models if specified)
 * @throws Error with detailed validation messages if config is invalid
 */
export function loadCodonSequence(options: {
  configPath: string;
  modelOverride?: string;
}): CodonConfig[] {
  const { configPath, modelOverride } = options;
  try {
    // Load and validate hank file (apply model override before validation when provided)
    const hankFile = loadHankFile({ hankPath: configPath, modelOverride });
    const rawCodons = hankFile.hank;

    // Resolve relative paths for promptFile and appendSystemPromptFile
    const configDir = path.dirname(configPath);

    /**
     * Recursively resolve paths in a codon configuration.
     * Handles both Codon and Loop types.
     * Works with transformed types (after Zod parsing).
     */
    function resolveCodonOrLoopPaths(config: CodonConfig): CodonConfig {
      // If it's a loop, resolve paths in nested codons
      if (config.type === "loop") {
        return {
          ...config,
          codons: config.codons.map((codon) => resolveCodonOrLoopPaths(codon) as Codon),
        };
      }

      // It's a codon - resolve its paths
      const resolved = { ...config };

      // Handle promptFile - can be string or array
      if (resolved.promptFile) {
        if (Array.isArray(resolved.promptFile)) {
          resolved.promptFile = resolved.promptFile.map((file: string) =>
            path.isAbsolute(file) ? file : path.resolve(configDir, file),
          );
        } else if (!path.isAbsolute(resolved.promptFile)) {
          resolved.promptFile = path.resolve(configDir, resolved.promptFile);
        }
      }

      // Handle appendSystemPromptFile - can be string or array
      if (resolved.appendSystemPromptFile) {
        if (Array.isArray(resolved.appendSystemPromptFile)) {
          resolved.appendSystemPromptFile = resolved.appendSystemPromptFile.map((file: string) =>
            path.isAbsolute(file) ? file : path.resolve(configDir, file),
          );
        } else if (!path.isAbsolute(resolved.appendSystemPromptFile)) {
          resolved.appendSystemPromptFile = path.resolve(
            configDir,
            resolved.appendSystemPromptFile,
          );
        }
      }

      // Handle rigSetup - resolve paths for copy operations
      if (resolved.rigSetup) {
        resolved.rigSetup = resolved.rigSetup.map((item: RigSetupItem) => {
          if (item.type === "copy" && item.copy) {
            return {
              ...item,
              copy: {
                from: path.isAbsolute(item.copy.from)
                  ? item.copy.from
                  : path.resolve(configDir, item.copy.from),
                to: item.copy.to, // Keep 'to' as relative to projectPath
              },
            };
          }
          return item;
        });
      }

      return resolved;
    }

    const resolvedConfig = rawCodons.map((config) =>
      resolveCodonOrLoopPaths(config as CodonConfig),
    );

    // Validate file existence and readability
    // Note: Model validation happens at a later stage via LLMProviderRegistry
    const validationErrors: string[] = [];

    /**
     * Recursively validate a codon or loop configuration.
     * @param config - Codon or Loop to validate
     * @param context - Context string for error messages (e.g., "Loop 'my-loop' > Codon 'write-code'")
     * @param index - Index of the codon within its parent
     * @param isInLoop - Whether this codon is inside a loop
     */
    function validateCodonOrLoop(
      config: CodonConfig,
      context: string,
      index: number,
      _isInLoop = false,
    ): void {
      if (config.type === "loop") {
        // Validate loop's nested codons recursively
        for (const [codonIndex, codon] of config.codons.entries()) {
          const codonContext = `Loop '${config.id}' > Codon ${codonIndex + 1} (${codon.id})`;
          validateCodonOrLoop(codon, codonContext, codonIndex, true);
        }
        return;
      }

      // It's a codon - validate it
      // Validate promptFile existence and readability
      if (config.promptFile) {
        const promptFiles = Array.isArray(config.promptFile)
          ? config.promptFile
          : [config.promptFile];
        for (const file of promptFiles) {
          if (!fs.existsSync(file)) {
            validationErrors.push(`${context}: promptFile "${file}" does not exist`);
          } else {
            try {
              fs.readFileSync(file, "utf-8");
            } catch (error) {
              validationErrors.push(
                `${context}: promptFile "${file}" is not readable: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
      }

      // Validate appendSystemPromptFile existence and readability
      if (config.appendSystemPromptFile) {
        const systemPromptFiles = Array.isArray(config.appendSystemPromptFile)
          ? config.appendSystemPromptFile
          : [config.appendSystemPromptFile];
        for (const file of systemPromptFiles) {
          if (!fs.existsSync(file)) {
            validationErrors.push(`${context}: appendSystemPromptFile "${file}" does not exist`);
          } else {
            try {
              fs.readFileSync(file, "utf-8");
            } catch (error) {
              validationErrors.push(
                `${context}: appendSystemPromptFile "${file}" is not readable: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
      }

      // Validate rigSetup items
      if (config.rigSetup) {
        for (const [itemIndex, item] of config.rigSetup.entries()) {
          if (item.type === "copy" && item.copy) {
            // Check if source exists
            if (!fs.existsSync(item.copy.from)) {
              validationErrors.push(
                `${context}, rig setup item ${itemIndex + 1}: source path "${
                  item.copy.from
                }" does not exist`,
              );
            }
          }
        }
      }

      // Validate sentinels
      if (config.sentinels && config.sentinels.length > 0) {
        const seenSentinelIds = new Set<string>();
        const configDir = path.dirname(configPath);

        for (const [sentIndex, entry] of config.sentinels.entries()) {
          const entryLabel = `Codon ${index + 1} (${config.id}), sentinel ${sentIndex + 1}`;

          // Extract sentinel config to check ID
          let sentinelConfig: unknown;
          if (typeof entry.sentinelConfig === "string") {
            // File reference - resolve and load
            const resolvedPath = path.isAbsolute(entry.sentinelConfig)
              ? entry.sentinelConfig
              : path.resolve(configDir, entry.sentinelConfig);

            if (!fs.existsSync(resolvedPath)) {
              const severity = entry.settings?.failCodonIfNotLoaded ? "ERROR" : "WARNING";
              validationErrors.push(
                `${entryLabel}: Sentinel config file not found: ${entry.sentinelConfig} [${severity}]`,
              );
              continue; // Skip further validation for this sentinel
            }

            try {
              const content = fs.readFileSync(resolvedPath, "utf-8");
              sentinelConfig = JSON.parse(content);
            } catch (error) {
              const severity = entry.settings?.failCodonIfNotLoaded ? "ERROR" : "WARNING";
              const errorMsg = error instanceof Error ? error.message : String(error);
              validationErrors.push(
                `${entryLabel}: Failed to parse sentinel config file ${entry.sentinelConfig}: ${errorMsg} [${severity}]`,
              );
              continue;
            }
          } else {
            // Inline config
            sentinelConfig = entry.sentinelConfig;
          }

          // Check for duplicate sentinel IDs
          if (sentinelConfig && typeof sentinelConfig === "object" && "id" in sentinelConfig) {
            const sentinelId = (sentinelConfig as { id: string }).id;
            if (seenSentinelIds.has(sentinelId)) {
              validationErrors.push(
                `${entryLabel}: Duplicate sentinel ID '${sentinelId}' in codon ${config.id}`,
              );
            }
            seenSentinelIds.add(sentinelId);
          }
        }
      }
    }

    // Validate all top-level items
    for (const [index, config] of resolvedConfig.entries()) {
      const context =
        config.type === "loop"
          ? `Loop ${index + 1} (${config.id})`
          : `Codon ${index + 1} (${config.id})`;
      validateCodonOrLoop(config as CodonConfig, context, index);
    }

    if (validationErrors.length > 0) {
      throw new Error(`Codon configuration validation failed:\n${validationErrors.join("\n")}`);
    }

    // Transform string IDs to CodonId branded types (recursively for loops)
    function transformIds(config: CodonConfig): CodonConfig {
      if (config.type === "loop") {
        return {
          ...config,
          id: CodonId(config.id as string),
          codons: config.codons.map((codon) => transformIds(codon) as Codon),
        };
      }
      return {
        ...config,
        id: CodonId(config.id as string),
      };
    }

    return resolvedConfig.map((config) => transformIds(config as CodonConfig));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load codon config from ${configPath}: ${error.message}`);
    }
    throw error;
  }
}

// -------------
// Enhanced Validation
// -------------

export interface ValidationResult {
  codons: CodonConfig[];
  codonCount: number;
  promptFileCount: number;
  systemPromptFileCount: number;
  rigSetupCount: number;
  trackingCodonCount: number;
  checkpointCodonCount: number;
  warnings: string[];
  environmentVariables: {
    fromSystem: Record<string, string>;
    fromCodons: Array<{
      codonId: string;
      codonName: string;
      variables: Record<string, string>;
    }>;
  };
  shimSelfTests?: Array<{
    modelId: string;
    modelName: string;
    provider: string;
    passed: boolean;
    result: ShimSelfTestResult;
  }>;
}

/**
 * Validate hank configuration with enhanced checks.
 *
 * This performs all the validation of loadCodonSequence plus additional
 * checks that are useful for pre-flight validation but not strictly
 * required for running.
 *
 * @param options.configPath - Path to configuration file
 * @param options.executionPath - Execution directory for relative path resolution
 * @param options.logger - Logger instance for writing self-test logs
 * @param options.modelOverride - Optional model to override all codon models
 * @returns Validation result with statistics and warnings
 * @throws Error with detailed messages if validation fails
 */
export async function validateHank(options: {
  configPath: string;
  executionPath: string;
  logger: Logger;
  modelOverride?: string;
}): Promise<ValidationResult> {
  const { configPath, executionPath, logger, modelOverride } = options;
  const codons = loadCodonSequence({ configPath, modelOverride });

  const result: ValidationResult = {
    codons,
    codonCount: 0, // Will be counted recursively
    promptFileCount: 0,
    systemPromptFileCount: 0,
    rigSetupCount: 0,
    trackingCodonCount: 0,
    checkpointCodonCount: 0,
    warnings: [],
    environmentVariables: {
      fromSystem: {},
      fromCodons: [],
    },
  };

  // Collect HANKWEAVE_ prefixed environment variables from system
  // Exclude HANKWEAVE_RUNTIME_* (server config) and HANKWEAVE_SENTINEL_* (sentinel API keys)
  for (const key in process.env) {
    if (
      key.startsWith("HANKWEAVE_") &&
      !key.startsWith("HANKWEAVE_RUNTIME_") &&
      !key.startsWith("HANKWEAVE_SENTINEL_")
    ) {
      const newKey = key.substring("HANKWEAVE_".length);
      result.environmentVariables.fromSystem[newKey] = process.env[key] || "";
    }
  }

  /**
   * Recursively validate and collect statistics from a codon or loop.
   * @param config - Codon or Loop to validate
   * @param context - Context string for error messages (e.g., "Loop 'my-loop' > Codon 'write-code'")
   * @param topLevelIndex - Index within top-level codons array (for continuation mode checks)
   * @param isTopLevel - Whether this is a top-level config (not nested in a loop)
   * @param codonIds - Set to track duplicate IDs across all codons
   * @param codonNames - Set to track duplicate names (for warnings)
   */
  async function validateCodonOrLoopRecursive(
    config: CodonConfig,
    context: string,
    topLevelIndex: number,
    isTopLevel: boolean,
    codonIds: Set<string>,
    codonNames: Set<string>,
  ): Promise<void> {
    if (config.type === "loop") {
      const loopLabel = context || `Loop ${topLevelIndex + 1} (${config.id})`;

      // Check for duplicate loop ID at top level
      if (codonIds.has(config.id)) {
        throw new Error(`${loopLabel}: Duplicate loop ID "${config.id}"`);
      }
      codonIds.add(config.id);

      // Validate codons within loop have unique IDs
      const loopCodonIds = new Set<string>();
      for (const codon of config.codons) {
        if (loopCodonIds.has(codon.id)) {
          throw new Error(`${loopLabel}: Duplicate codon ID "${codon.id}" within loop`);
        }
        loopCodonIds.add(codon.id);
      }

      // ContextExceeded loops cannot have codons with fresh continuationMode
      // This would cause infinite loops since context never builds up
      if (config.terminateOn.type === "contextExceeded") {
        for (const codon of config.codons) {
          if (codon.continuationMode === "fresh") {
            throw new Error(
              `${loopLabel}: Loop with contextExceeded termination cannot contain codons with continuationMode "fresh". ` +
                `Codon "${codon.name}" (${codon.id}) has continuationMode "fresh", which would prevent context from building up ` +
                `and cause an infinite loop. Change to "continue-previous" to allow context to accumulate.`,
            );
          }
        }
      }

      // Validate model compatibility within loop codons
      for (const [codonIndex, codon] of config.codons.entries()) {
        if (codon.continuationMode === "continue-previous" && codonIndex > 0) {
          const previousCodon = config.codons[codonIndex - 1];
          if (codon.model.modelId !== previousCodon.model.modelId) {
            throw new Error(
              `${loopLabel} > Codon ${codonIndex + 1} (${
                codon.id
              }): Cannot use continuationMode "continue-previous" when model differs from previous codon in loop. ` +
                `Different models cannot share the same session ID. Change to "fresh" to start a new conversation with a different model.`,
            );
          }
        }
      }

      // Recursively validate each codon in the loop
      for (const [codonIndex, codon] of config.codons.entries()) {
        const codonContext = `Loop '${config.id}' > Codon ${codonIndex + 1} (${codon.id})`;
        await validateCodonOrLoopRecursive(
          codon,
          codonContext,
          codonIndex,
          false, // Not top-level
          codonIds,
          codonNames,
        );
      }

      return;
    }

    // It's a codon - validate all codon-specific logic
    const codon = config;
    const codonLabel = context || `Codon ${topLevelIndex + 1} (${codon.id})`;

    // Check for duplicate IDs
    if (codonIds.has(codon.id)) {
      throw new Error(`${codonLabel}: Duplicate codon ID "${codon.id}"`);
    }
    codonIds.add(codon.id);

    // Warn about duplicate names (not fatal)
    if (codonNames.has(codon.name)) {
      result.warnings.push(`${codonLabel}: Duplicate codon name "${codon.name}"`);
    }
    codonNames.add(codon.name);

    // Warn about rig setup in loop codons without allowFailure flag
    if (!isTopLevel && codon.rigSetup && codon.rigSetup.length > 0) {
      const hasItemsWithoutAllowFailure = codon.rigSetup.some((item) => !item.allowFailure);

      if (hasItemsWithoutAllowFailure) {
        result.warnings.push(
          `${codonLabel}: rigSetup in loop codon should use 'allowFailure: true' ` +
            `to prevent loop termination on setup failures. This is especially important ` +
            `if subsequent iterations might fail (e.g., trying to copy files to where they already exist).`,
        );
      }
    }

    // Increment codon count
    result.codonCount++;

    // Collect codon environment variables
    if (codon.env && Object.keys(codon.env).length > 0) {
      result.environmentVariables.fromCodons.push({
        codonId: codon.id,
        codonName: codon.name,
        variables: codon.env,
      });
    }

    // Count prompt files
    if (codon.promptFile) {
      const files = Array.isArray(codon.promptFile) ? codon.promptFile : [codon.promptFile];
      result.promptFileCount += files.length;

      // Verify files are readable (loadCodonSequence checks existence)
      for (const file of files) {
        try {
          const stats = await fs.promises.stat(file);
          if (stats.size === 0) {
            result.warnings.push(`${codonLabel}: Prompt file "${file}" is empty`);
          }
          if (stats.size > 1024 * 1024) {
            // 1MB
            result.warnings.push(
              `${codonLabel}: Prompt file "${file}" is large (${(stats.size / 1024 / 1024).toFixed(
                2,
              )}MB)`,
            );
          }
        } catch (error) {
          // Should not happen as loadCodonSequence already checked
          throw new Error(`${codonLabel}: Cannot stat prompt file "${file}": ${error}`);
        }
      }
    }

    // Count system prompt files
    if (codon.appendSystemPromptFile) {
      const files = Array.isArray(codon.appendSystemPromptFile)
        ? codon.appendSystemPromptFile
        : [codon.appendSystemPromptFile];
      result.systemPromptFileCount += files.length;
    }

    // Validate rig setup
    if (codon.rigSetup) {
      result.rigSetupCount += codon.rigSetup.length;

      for (const [itemIndex, item] of codon.rigSetup.entries()) {
        if (item.type === "copy" && item.copy) {
          // Check source exists (already done by loadCodonSequence)
          // Check target parent directory
          const targetPath = path.join(executionPath, item.copy.to);
          const targetParent = path.dirname(targetPath);

          try {
            const relativeParent = path.relative(executionPath, targetParent);
            if (relativeParent.startsWith("..")) {
              throw new Error(
                `${codonLabel}, rig setup item ${itemIndex + 1}: ` +
                  `Target path "${item.copy.to}" would write outside execution directory`,
              );
            }
          } catch (_error) {
            // Path resolution error
            throw new Error(
              `${codonLabel}, rig setup item ${itemIndex + 1}: ` +
                `Invalid target path "${item.copy.to}"`,
            );
          }

          // Warn if target already exists
          if (fs.existsSync(targetPath)) {
            result.warnings.push(
              `${codonLabel}: Copy target "${item.copy.to}" already exists and will be overwritten`,
            );
          }
        } else if (item.type === "command" && item.command) {
          // Basic command validation
          const command = item.command.run.trim();
          if (!command) {
            throw new Error(`${codonLabel}, rig setup item ${itemIndex + 1}: Empty command`);
          }

          // Warn about potentially dangerous commands
          const dangerousPatterns = [
            /rm\s+-rf\s+\//, // rm -rf /
            /rm\s+-rf\s+~/, // rm -rf ~
            />\s*\/dev\/sda/, // Writing to disk devices
            /format\s+/i, // Format commands
            /del\s+\/s\s+\/q\s+c:/i, // Windows delete
          ];

          for (const pattern of dangerousPatterns) {
            if (pattern.test(command)) {
              result.warnings.push(
                `${codonLabel}: Potentially dangerous command detected: "${command}"`,
              );
              break;
            }
          }
        }
      }
    }

    // Count codons with file tracking
    if (codon.checkpointedFiles && codon.checkpointedFiles.length > 0) {
      result.trackingCodonCount++;
      result.checkpointCodonCount++;
    }

    // Validate continuation mode - only for top-level codons
    if (isTopLevel) {
      if (codon.continuationMode === "continue-previous" && topLevelIndex === 0) {
        result.warnings.push(
          `${codonLabel}: First codon has continuationMode "continue-previous" but there's no previous codon`,
        );
      }

      // Check codon dependencies
      if (codon.continuationMode === "continue-previous" && topLevelIndex > 0) {
        const previousConfig = codons[topLevelIndex - 1];

        // Cannot continue from a contextExceeded loop
        // The loop only terminates when context is exhausted, so there's nothing to continue from
        if (
          previousConfig.type === "loop" &&
          previousConfig.terminateOn.type === "contextExceeded"
        ) {
          throw new Error(
            `${codonLabel}: Cannot use continuationMode "continue-previous" after a loop with contextExceeded termination. ` +
              `Loop "${previousConfig.name}" (${previousConfig.id}) terminates only when context is exhausted, ` +
              `meaning there's no meaningful conversation to continue. Change to "fresh" to start a new conversation.`,
          );
        }

        // Determine which codon to check based on whether previous config is a loop or codon
        let codonToCheck: Codon;
        let warningContext: string;

        if (previousConfig.type === "loop") {
          // For loops, check the last codon in the loop
          codonToCheck = previousConfig.codons[previousConfig.codons.length - 1];
          warningContext = `Continues from previous loop "${previousConfig.id}" whose last codon "${codonToCheck.id}"`;
        } else {
          codonToCheck = previousConfig;
          warningContext = `Continues from previous codon "${codonToCheck.id}"`;
        }

        // Error if models don't match - cannot share session ID between different models
        if (codon.model.modelId !== codonToCheck.model.modelId) {
          throw new Error(
            `${codonLabel}: Cannot use continuationMode "continue-previous" when model differs from previous codon. ` +
              `Different models cannot share the same session ID. Change to "fresh" to start a new conversation with a different model.`,
          );
        }

        // Warn if the codon doesn't produce output that might be needed
        if (!codonToCheck.checkpointedFiles || codonToCheck.checkpointedFiles.length === 0) {
          result.warnings.push(`${codonLabel}: ${warningContext} doesn't checkpoint any files`);
        }
      }
    }
  }

  // Additional validation checks
  const codonIds = new Set<string>();
  const codonNames = new Set<string>();

  // Recursively validate all codons and loops
  for (const [index, config] of codons.entries()) {
    await validateCodonOrLoopRecursive(
      config,
      "", // No context for top-level
      index,
      true, // Is top-level
      codonIds,
      codonNames,
    );
  }

  // Global warnings
  if (result.codonCount === 0) {
    throw new Error("Configuration must contain at least one codon");
  }

  // Collect unique models and run self-tests for shims
  // Only run self-tests if explicitly requested (e.g., in --validate mode)

  const uniqueModels = new Map<string, ModelInfo>();

  function collectModelsRecursive(config: CodonConfig): void {
    if ("codons" in config) {
      // Loop: collect from all nested codons
      for (const codon of config.codons) {
        collectModelsRecursive(codon);
      }
    } else {
      // Codon: add model to map (using modelId as key for uniqueness)
      uniqueModels.set(config.model.modelId, config.model);
    }
  }

  // Collect all unique models
  for (const config of codons) {
    collectModelsRecursive(config);
  }

  // Run self-tests for each unique model
  if (uniqueModels.size > 0) {
    result.shimSelfTests = [];

    for (const [modelId, modelInfo] of uniqueModels) {
      logger.log(
        `Running self-test for model: ${modelInfo.name} (${modelInfo.providerId}/${modelId})`,
      );

      // Create temporary execution path for self-test
      const tempExecutionPath = path.join(os.tmpdir(), `hankweave-self-test-exec-${Date.now()}`);
      if (!fs.existsSync(tempExecutionPath)) {
        fs.mkdirSync(tempExecutionPath, { recursive: true });
      }

      try {
        // Use CodonRunner's static method to run self-test
        const { CodonRunner } = await import("./codon-runner.js");
        const selfTestResult = await CodonRunner.runSelfTestForModel(
          modelInfo,
          tempExecutionPath,
          logger,
          undefined, // anthropicBaseUrl - could be passed from config if needed
        );

        // Record result
        result.shimSelfTests.push({
          modelId,
          modelName: modelInfo.name,
          provider: modelInfo.providerId,
          passed: selfTestResult.overall.passed,
          result: selfTestResult,
        });

        // Add warning if self-test failed
        if (!selfTestResult.overall.passed) {
          result.warnings.push(
            `Self-test failed for ${modelInfo.name} (${modelInfo.providerId}/${modelId}): ${selfTestResult.overall.message}`,
          );
        }

        logger.log(
          `Self-test ${selfTestResult.overall.passed ? "PASSED" : "FAILED"} for ${modelInfo.name}`,
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.log(`Self-test error for ${modelInfo.name}: ${errorMessage}`, "error");

        // Record as a failed test so it will be caught by the failure check
        result.shimSelfTests.push({
          modelId,
          modelName: modelInfo.name,
          provider: modelInfo.providerId,
          passed: false,
          result: {
            shim: { name: "unknown", version: "unknown" },
            agent: { name: "unknown", version: "unknown", found: false },
            checks: [],
            overall: {
              passed: false,
              message: errorMessage,
            },
          },
        });

        result.warnings.push(
          `Self-test error for ${modelInfo.name} (${modelInfo.providerId}/${modelId}): ${errorMessage}`,
        );
      } finally {
        // Clean up temporary execution path
        if (fs.existsSync(tempExecutionPath)) {
          fs.rmSync(tempExecutionPath, { recursive: true, force: true });
        }
      }
    }
  }

  // Check if any self-tests failed and throw error if so
  if (result.shimSelfTests && result.shimSelfTests.length > 0) {
    const failedTests = result.shimSelfTests.filter((test) => !test.passed);
    if (failedTests.length > 0) {
      const errorMessages = failedTests.map(
        (test) =>
          `  - ${test.modelName} (${test.provider}/${test.modelId}): ${test.result.overall.message}`,
      );
      throw new Error(
        `Self-test failed for ${failedTests.length} model(s):\n${errorMessages.join("\n")}\n\nPlease ensure all required API keys and dependencies are configured correctly.`,
      );
    }
  }

  return result;
}
