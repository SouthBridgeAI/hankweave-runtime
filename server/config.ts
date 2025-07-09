import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PhaseId } from "./branded-types.js";
import type { PhaseConfig, ServerConfig } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

export const TIMEOUTS = {
  RESULT_MESSAGE_MS: 30000, // 30 seconds to wait for result message
  PROCESS_KILL_GRACE_MS: 5000, // 5 seconds grace period before SIGKILL
  LOG_PARSER_DELAY_MS: 100, // 100ms delay for log parsing
  PHASE_CLEANUP_DELAY_MS: 100, // 100ms delay for phase cleanup
} as const;

// ============================================================================
// Error Formatting
// ============================================================================

/**
 * Format Zod validation errors into a user-friendly message.
 * Provides context about which phase has the error and what field is affected.
 */
function formatZodErrors(error: z.ZodError, rawConfig: unknown): string {
  const errors: string[] = [];

  for (const issue of error.issues) {
    const path = issue.path;
    let errorMsg = "";

    // Determine if this is a phase-level error
    if (path[0] === undefined && issue.code === "too_small") {
      errorMsg = `  - ${issue.message}`;
    } else if (typeof path[0] === "number") {
      // This is an error in a specific phase
      const phaseIndex = path[0];
      const phaseData = Array.isArray(rawConfig) ? rawConfig[phaseIndex] : null;
      const phaseId = phaseData?.id || `index ${phaseIndex}`;
      const phaseName = phaseData?.name || "unnamed";

      if (path.length === 1) {
        // Top-level phase error
        errorMsg = `  - Phase "${phaseName}" (${phaseId}): ${issue.message}`;
      } else {
        // Field-specific error
        const fieldPath = path.slice(1).join(".");
        errorMsg = `  - Phase "${phaseName}" (${phaseId}) - ${fieldPath}: ${issue.message}`;
      }
    } else if (issue.code === "unrecognized_keys") {
      // Handle unrecognized keys specially
      const keys = (issue as z.ZodIssue & { keys?: string[] }).keys?.join(", ");
      const phaseIndex = typeof path[0] === "number" ? path[0] : undefined;
      const phaseData =
        phaseIndex !== undefined && Array.isArray(rawConfig) ? rawConfig[phaseIndex] : null;
      const phaseId = phaseData?.id || (phaseIndex !== undefined ? `index ${phaseIndex}` : "");
      const phaseName = phaseData?.name || "unnamed";

      if (phaseIndex !== undefined) {
        errorMsg = `  - Phase "${phaseName}" (${phaseId}) has unrecognized field(s): ${keys}. Fix: Remove these fields or check for typos. Valid fields are: id, name, promptFile, promptText, appendSystemPromptFile, appendSystemPromptText, model, continuationMode, workspaceSetup, watch, description, checkpointAndWatch.`;
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

// ============================================================================
// Configuration Schema
// ============================================================================

const workspaceSetupItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("copy"),
    copy: z.object({
      from: z.string().min(1, "Source path cannot be empty"),
      to: z.string().min(1, "Target path cannot be empty"),
    }),
  }),
  z.object({
    type: z.literal("command"),
    command: z.object({
      run: z.string().min(1, "Command cannot be empty"),
      workingDirectory: z.enum(["project", "lastCopied"]).optional().default("project"),
    }),
  }),
]);

const phaseConfigSchema = z
  .object({
    id: z
      .string()
      .min(
        1,
        "Phase ID cannot be empty. This uniquely identifies your phase (e.g., 'phase-1', 'analysis'). Fix: Add a unique id field.",
      ),
    name: z
      .string()
      .min(
        1,
        "Phase name cannot be empty. This is the human-readable name shown in the UI. Fix: Add a descriptive name field.",
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
          "continuationMode must be either 'fresh' or 'continue-previous'. This controls whether to start a new conversation or continue from the previous phase. Fix: Add continuationMode field with either 'fresh' (new conversation) or 'continue-previous' (maintain context).",
      }),
    }),
    workspaceSetup: z.array(workspaceSetupItemSchema).optional(),
    watch: z.string().optional(),
    description: z.string().optional(),
    checkpointAndWatch: z.array(z.string()).optional(),
  })
  .strict()
  .refine((data) => data.promptFile || data.promptText, {
    message:
      "Either promptFile or promptText must be provided. The prompt tells Claude what to do in this phase. Fix: Add either promptFile (path to .md file) or promptText (inline prompt string).",
  })
  .refine((data) => !(data.appendSystemPromptFile && data.appendSystemPromptText), {
    message:
      "Cannot specify both appendSystemPromptFile and appendSystemPromptText. Use one or the other to add system-level instructions. Fix: Remove one of these fields.",
  });

const phaseConfigArraySchema = z.array(phaseConfigSchema).min(1, "At least one phase required");

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default server configuration values.
 * Can be overridden by passing config to LangtonServer constructor.
 *
 * Note: projectPath and phases must be provided by the user.
 */
export const DEFAULT_CONFIG: Omit<ServerConfig, "projectPath" | "phases"> = {
  port: 7777,
  version: "1.0.0",
  lockFile: ".langton/server.lock",
  socketLogFile: ".langton/logs/websocket.log",
  serverLogFile: ".langton/logs/server.log",
  costsPerMTok: {
    input: 3.0, // $3 per million input tokens
    inputCache: 3.75, // $3.75 per million tokens when creating cache
    cacheRead: 0.3, // $0.30 per million tokens from cache
    output: 15.0, // $15 per million output tokens
  },
  logParsingInterval: 1000, // Check for new log entries every second
};

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Load and validate phase configuration from a JSON file.
 *
 * The file should contain an array of phase configurations.
 * Each phase is validated against the schema to ensure required
 * fields are present and either promptFile or promptText is provided.
 *
 * @param configPath - Path to the JSON configuration file
 * @returns Validated array of phase configurations
 * @throws Error with detailed validation messages if config is invalid
 */
export function loadPhaseConfig(configPath: string): PhaseConfig[] {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const rawConfig = JSON.parse(content);

    // Validate the configuration
    const result = phaseConfigArraySchema.safeParse(rawConfig);
    if (!result.success) {
      const errors = formatZodErrors(result.error, rawConfig);
      throw new Error(`Invalid phase configuration:\n${errors}`);
    }

    // Resolve relative paths for promptFile and appendSystemPromptFile
    const configDir = path.dirname(configPath);
    const resolvedConfig = result.data.map((phase) => {
      const resolved = { ...phase };

      // Handle promptFile - can be string or array
      if (phase.promptFile) {
        if (Array.isArray(phase.promptFile)) {
          resolved.promptFile = phase.promptFile.map((file) =>
            path.isAbsolute(file) ? file : path.resolve(configDir, file),
          );
        } else if (!path.isAbsolute(phase.promptFile)) {
          resolved.promptFile = path.resolve(configDir, phase.promptFile);
        }
      }

      // Handle appendSystemPromptFile - can be string or array
      if (phase.appendSystemPromptFile) {
        if (Array.isArray(phase.appendSystemPromptFile)) {
          resolved.appendSystemPromptFile = phase.appendSystemPromptFile.map((file) =>
            path.isAbsolute(file) ? file : path.resolve(configDir, file),
          );
        } else if (!path.isAbsolute(phase.appendSystemPromptFile)) {
          resolved.appendSystemPromptFile = path.resolve(configDir, phase.appendSystemPromptFile);
        }
      }

      // Handle workspaceSetup - resolve paths for copy operations
      if (phase.workspaceSetup) {
        resolved.workspaceSetup = phase.workspaceSetup.map((item) => {
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
    });

    // Validate file existence, readability, and model names
    const validationErrors: string[] = [];
    const validModels = ["sonnet", "opus"];

    for (const [index, phase] of resolvedConfig.entries()) {
      // Validate model name
      if (!validModels.includes(phase.model)) {
        validationErrors.push(
          `Phase ${index + 1} (${phase.id}): model "${
            phase.model
          }" is not valid. Must be one of: ${validModels.join(", ")}`,
        );
      }

      // Validate promptFile existence and readability
      if (phase.promptFile) {
        const promptFiles = Array.isArray(phase.promptFile) ? phase.promptFile : [phase.promptFile];
        for (const file of promptFiles) {
          if (!fs.existsSync(file)) {
            validationErrors.push(
              `Phase ${index + 1} (${phase.id}): promptFile "${file}" does not exist`,
            );
          } else {
            try {
              fs.readFileSync(file, "utf-8");
            } catch (error) {
              validationErrors.push(
                `Phase ${index + 1} (${phase.id}): promptFile "${file}" is not readable: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
      }

      // Validate appendSystemPromptFile existence and readability
      if (phase.appendSystemPromptFile) {
        const systemPromptFiles = Array.isArray(phase.appendSystemPromptFile)
          ? phase.appendSystemPromptFile
          : [phase.appendSystemPromptFile];
        for (const file of systemPromptFiles) {
          if (!fs.existsSync(file)) {
            validationErrors.push(
              `Phase ${index + 1} (${phase.id}): appendSystemPromptFile "${file}" does not exist`,
            );
          } else {
            try {
              fs.readFileSync(file, "utf-8");
            } catch (error) {
              validationErrors.push(
                `Phase ${index + 1} (${
                  phase.id
                }): appendSystemPromptFile "${file}" is not readable: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
      }

      // Validate workspaceSetup items
      if (phase.workspaceSetup) {
        for (const [itemIndex, item] of phase.workspaceSetup.entries()) {
          if (item.type === "copy" && item.copy) {
            // Check if source exists
            if (!fs.existsSync(item.copy.from)) {
              validationErrors.push(
                `Phase ${index + 1} (${phase.id}), workspace setup item ${
                  itemIndex + 1
                }: source path "${item.copy.from}" does not exist`,
              );
            }
          }
        }
      }
    }

    if (validationErrors.length > 0) {
      throw new Error(`Phase configuration validation failed:\n${validationErrors.join("\n")}`);
    }

    // Transform string IDs to PhaseId branded types
    return resolvedConfig.map((phase) => ({
      ...phase,
      id: PhaseId(phase.id),
    }));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load phase config from ${configPath}: ${error.message}`);
    }
    throw error;
  }
}

// ============================================================================
// Token Cost Calculation
// ============================================================================

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
