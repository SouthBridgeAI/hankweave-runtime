import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { codonSentinelEntrySchema } from "./config-validation/sentinel.schema.js";
import { CodonId } from "./types/branded-types.js";
import type { Codon, CodonConfig, RigSetupItem, ServerConfig } from "./types/types.js";

// -------------
// Constants
// -------------

export const TIMEOUTS = {
  RESULT_MESSAGE_MS: 30000, // 30 seconds to wait for result message
  PROCESS_KILL_GRACE_MS: 5000, // 5 seconds grace period before SIGKILL
  LOG_PARSER_DELAY_MS: 100, // 100ms delay for log parsing
  CODON_CLEANUP_DELAY_MS: 100, // 100ms delay for codon cleanup
} as const;

// -------------
// Error Formatting
// -------------

/**
 * Format Zod validation errors into a user-friendly message.
 * Provides context about which codon has the error and what field is affected.
 */
function formatZodErrors(error: z.ZodError, rawConfig: unknown): string {
  const errors: string[] = [];

  for (const issue of error.issues) {
    const path = issue.path;
    let errorMsg = "";

    // Determine if this is a codon-level error
    if (path[0] === undefined && issue.code === "too_small") {
      errorMsg = `  - ${issue.message}`;
    } else if (typeof path[0] === "number") {
      // This is an error in a specific codon
      const codonIndex = path[0];
      const codonData = Array.isArray(rawConfig) ? rawConfig[codonIndex] : null;
      const codonId = codonData?.id || `index ${codonIndex}`;
      const codonName = codonData?.name || "unnamed";

      if (path.length === 1) {
        // Top-level codon error
        errorMsg = `  - Codon "${codonName}" (${codonId}): ${issue.message}`;
      } else {
        // Field-specific error
        const fieldPath = path.slice(1).join(".");
        errorMsg = `  - Codon "${codonName}" (${codonId}) - ${fieldPath}: ${issue.message}`;
      }
    } else if (issue.code === "unrecognized_keys") {
      // Handle unrecognized keys specially
      const keys = (issue as z.ZodIssue & { keys?: string[] }).keys?.join(", ");
      const codonIndex = typeof path[0] === "number" ? path[0] : undefined;
      const codonData =
        codonIndex !== undefined && Array.isArray(rawConfig) ? rawConfig[codonIndex] : null;
      const codonId = codonData?.id || (codonIndex !== undefined ? `index ${codonIndex}` : "");
      const codonName = codonData?.name || "unnamed";

      if (codonIndex !== undefined) {
        const itemType = codonData?.type === "loop" ? "Loop" : "Codon";
        const validFields =
          codonData?.type === "loop"
            ? "type, id, name, description, terminateOn, codons"
            : "type, id, name, promptFile, promptText, appendSystemPromptFile, appendSystemPromptText, model, continuationMode, rigSetup, description, trackedFiles, env, outputFiles, sentinels";
        errorMsg = `  - ${itemType} "${codonName}" (${codonId}) has unrecognized field(s): ${keys}. Fix: Remove these fields or check for typos. Valid fields are: ${validFields}.`;
      } else {
        errorMsg = `  - Unrecognized field(s): ${keys}. Fix: Remove these fields or check for typos.`;
      }
    } else {
      // Generic error
      const fieldPath = path.join(".");
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

const shellCommandSchema = z.object({
  type: z.literal("command"),
  command: z.object({
    run: z.string().min(1, "Command cannot be empty"),
    workingDirectory: z.enum(shellCommandWorkingDirectory).optional().default("project"),
  }),
});

const rigShellCommandSchema = shellCommandSchema.extend({
  command: shellCommandSchema.shape.command.extend({
    workingDirectory: z.enum(rigSetupCommandWorkingDirectory).optional().default("project"),
  }),
});

const rigSetupItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("copy"),
    copy: z.object({
      from: z.string().min(1, "Source path cannot be empty"),
      to: z.string().min(1, "Target path cannot be empty"),
    }),
    allowFailure: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, failure of this operation won't fail the codon. Recommended for rig setup in loop codons.",
      ),
  }),
  rigShellCommandSchema.extend({
    allowFailure: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, failure of this operation won't fail the codon. Recommended for rig setup in loop codons.",
      ),
  }),
]);

// Output copy item schema (array of these under codon.outputFiles)
const codonOutputItemSchema = z
  .object({
    // An array of glob strings representing codon output files to copy
    copy: z.array(z.string()).min(1, "The 'copy' array cannot be empty."),
    // Optional shell commands to run before copying files. Cwd is executionPath
    beforeCopy: z.array(shellCommandSchema).optional(),
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
const loopTerminationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("iterationLimit"),
    limit: z.number().int().min(1, "Iteration limit must be at least 1"),
  }),
  z.object({
    type: z.literal("contextExceeded"),
  }),
]);

// -------------
// Codon and Loop Schemas
// -------------

/**
 * Base codon object schema (before refinements).
 * The type field is optional and defaults to "codon".
 */
const codonObjectSchema = z.object({
  type: z.literal("codon").optional().default("codon"),
  id: z
    .string()
    .min(
      1,
      "Codon ID cannot be empty. This uniquely identifies your codon (e.g., 'codon-1', 'analysis'). Fix: Add a unique id field.",
    ),
  name: z
    .string()
    .min(
      1,
      "Codon name cannot be empty. This is the human-readable name shown in the UI. Fix: Add a descriptive name field.",
    ),
  promptFile: z.union([z.string(), z.array(z.string())]).optional(),
  promptText: z.string().optional(),
  appendSystemPromptFile: z.union([z.string(), z.array(z.string())]).optional(),
  appendSystemPromptText: z.string().optional(),
  model: z.enum(["sonnet", "opus"], {
    errorMap: () => ({
      message:
        "Model must be either 'sonnet' or 'opus'. This determines which Claude model to use. Fix: Change model to 'sonnet' (faster, cheaper) or 'opus' (more capable).",
    }),
  }),
  continuationMode: z.enum(["fresh", "continue-previous"], {
    errorMap: () => ({
      message:
        "continuationMode must be either 'fresh' or 'continue-previous'. This controls whether to start a new conversation or continue from the previous codon. Fix: Add continuationMode field with either 'fresh' (new conversation) or 'continue-previous' (maintain context).",
    }),
  }),
  rigSetup: z.array(rigSetupItemSchema).optional(),
  description: z.string().optional(),
  trackedFiles: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  outputFiles: codonOutputSchema,
  sentinels: z.array(codonSentinelEntrySchema).optional(),
});

/**
 * Single codon schema with refinements - represents one executable codon.
 */
const codonSchema = codonObjectSchema
  .strict()
  .refine((data) => data.promptFile || data.promptText, {
    message:
      "Either promptFile or promptText must be provided. The prompt tells Claude what to do in this codon. Fix: Add either promptFile (path to .md file) or promptText (inline prompt string).",
  })
  .refine((data) => !(data.appendSystemPromptFile && data.appendSystemPromptText), {
    message:
      "Cannot specify both appendSystemPromptFile and appendSystemPromptText. Use one or the other to add system-level instructions. Fix: Remove one of these fields.",
  });

/**
 * Loop schema - contains multiple codons that repeat.
 * Only allows Codon children (no nested loops in v1).
 *
 * Note: We use a forward reference approach here to prevent circular dependencies.
 * The codons array will be validated after the discriminated union is parsed.
 */
const loopSchema = z.object({
  type: z.literal("loop"),
  id: z
    .string()
    .min(
      1,
      "Loop ID cannot be empty. This uniquely identifies your loop (e.g., 'iterative-development'). Fix: Add a unique id field.",
    ),
  name: z
    .string()
    .min(
      1,
      "Loop name cannot be empty. This is the human-readable name shown in the UI. Fix: Add a descriptive name field.",
    ),
  description: z.string().optional(),
  terminateOn: loopTerminationSchema,
  codons: z
    .array(
      codonObjectSchema
        .strict()
        .refine((data) => data.promptFile || data.promptText, {
          message:
            "Either promptFile or promptText must be provided. The prompt tells Claude what to do in this codon. Fix: Add either promptFile (path to .md file) or promptText (inline prompt string).",
        })
        .refine((data) => !(data.appendSystemPromptFile && data.appendSystemPromptText), {
          message:
            "Cannot specify both appendSystemPromptFile and appendSystemPromptText. Use one or the other to add system-level instructions. Fix: Remove one of these fields.",
        }),
    )
    .min(1, "Loop must contain at least one codon. Fix: Add codons to the loop."),
});

/**
 * CodonConfig is a discriminated union of Codon and Loop.
 * Used in codon-sequence.json configuration.
 */
const codonConfigSchema = z.union([
  codonSchema, // type: "codon" (or omitted, defaults to "codon")
  loopSchema.strict(), // type: "loop"
]);

const codonConfigArraySchema = z.array(codonConfigSchema).min(1, "At least one codon required");

// -------------
// Default Configuration
// -------------

/**
 * Default server configuration values.
 * Can be overridden by passing config to StrandweaveRuntime constructor.
 *
 * Note: execution paths and codons must be provided by the user, as well as cwd
 */
export const DEFAULT_CONFIG: Omit<
  ServerConfig,
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
  version: "1.0.0",
  outputDirectory: "strandweave-results",
  lockFile: ".strandweave/runtime.lock",
  socketLogFile: ".strandweave/logs/websocket.log",
  serverLogFile: ".strandweave/logs/server.log",
  costsPerMTok: {
    input: 3.0, // $3 per million input tokens
    inputCache: 3.75, // $3.75 per million tokens when creating cache
    cacheRead: 0.3, // $0.30 per million tokens from cache
    output: 15.0, // $15 per million output tokens
  },
  logParsingInterval: 1000, // Check for new log entries every second
  autostart: true, // Default to current behavior
  dataHashTimeLimit: 5000, // 5 seconds for directory hashing
  toolResultTruncateLength: 2500, // Default truncation length for tool results
  withoutProxy: false, // Enable proxy by default
  handshakeHistoryLimit: 50, // Maximum recent events to include in handshake response
  sentinel: {
    enablePersistence: true,
    healthCheckGracePeriodMs: 2000, // 2 seconds
    waitForAllHealthChecks: false,
  },
};

// -------------
// Configuration Loading
// -------------

/**
 * Load and validate codon configuration from a JSON file.
 *
 * The file should contain an array of codon configurations.
 * Each codon is validated against the schema to ensure required
 * fields are present and either promptFile or promptText is provided.
 *
 * @param configPath - Path to the JSON configuration file
 * @returns Validated array of codon configurations
 * @throws Error with detailed validation messages if config is invalid
 */
export function loadCodonSequence(configPath: string): CodonConfig[] {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const rawConfig = JSON.parse(content);
    // Validate the configuration
    const result = codonConfigArraySchema.safeParse(rawConfig);
    if (!result.success) {
      const errors = formatZodErrors(result.error, rawConfig);
      throw new Error(`Invalid codon configuration:\n${errors}`);
    }

    // Resolve relative paths for promptFile and appendSystemPromptFile
    const configDir = path.dirname(configPath);

    /**
     * Recursively resolve paths in a codon configuration.
     * Handles both Codon and Loop types.
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

    const resolvedConfig = result.data.map((config) =>
      resolveCodonOrLoopPaths(config as CodonConfig),
    );

    // Validate file existence, readability, and model names
    const validationErrors: string[] = [];
    const validModels = ["sonnet", "opus"];

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
      // Validate model name
      if (!validModels.includes(config.model)) {
        validationErrors.push(
          `${context}: model "${
            config.model
          }" is not valid. Must be one of: ${validModels.join(", ")}`,
        );
      }

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
// Token Cost Calculation
// -------------

/**
 * Calculate the cost in dollars for a given token usage.
 *
 * Uses the configured costs per million tokens for each token type.
 * This matches Claude's pricing model with separate rates for:
 * - Standard input tokens
 * - Cache creation tokens
 * - Cache read tokens
 * - Output tokens
 *
 * @param usage - Token counts by type
 * @param costs - Cost configuration per million tokens
 * @returns Total cost in dollars
 */
export function calculateCost(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  },
  costs: ServerConfig["costsPerMTok"],
): number {
  const inputCost = (usage.inputTokens / 1_000_000) * costs.input;
  const cacheCreationCost = (usage.cacheCreationTokens / 1_000_000) * costs.inputCache;
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * costs.cacheRead;
  const outputCost = (usage.outputTokens / 1_000_000) * costs.output;

  return inputCost + cacheCreationCost + cacheReadCost + outputCost;
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
}

/**
 * Validate strand configuration with enhanced checks.
 *
 * This performs all the validation of loadCodonSequence plus additional
 * checks that are useful for pre-flight validation but not strictly
 * required for running.
 *
 * @param configPath - Path to configuration file
 * @param executionPath - Execution directory for relative path resolution
 * @returns Validation result with statistics and warnings
 * @throws Error with detailed messages if validation fails
 */
export async function validateStrand(
  configPath: string,
  executionPath: string,
): Promise<ValidationResult> {
  const codons = loadCodonSequence(configPath);

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

  // Collect STRANDWEAVE_ prefixed environment variables from system
  for (const key in process.env) {
    if (key.startsWith("STRANDWEAVE_")) {
      const newKey = key.substring("STRANDWEAVE_".length);
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
    if (codon.trackedFiles && codon.trackedFiles.length > 0) {
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

        // Warn if the codon doesn't produce output that might be needed
        if (!codonToCheck.trackedFiles || codonToCheck.trackedFiles.length === 0) {
          result.warnings.push(`${codonLabel}: ${warningContext} doesn't track any files`);
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

  return result;
}
