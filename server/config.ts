import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PhaseId } from "./types/branded-types.js";
import type { PhaseConfig, ServerConfig } from "./types/types.js";

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
        errorMsg = `  - Phase "${phaseName}" (${phaseId}) has unrecognized field(s): ${keys}. Fix: Remove these fields or check for typos. Valid fields are: id, name, promptFile, promptText, appendSystemPromptFile, appendSystemPromptText, model, continuationMode, workspaceSetup, description, trackedFiles, env, outputFiles.`;
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

const shellCommandWorkingDirectory = ["project"] as const;

// when running workspace setup commands, it's useful to have "lastCopied" option
// to coordinate with copy commands
const workspaceSetupCommandWorkingDirectory = [
  ...shellCommandWorkingDirectory,
  "lastCopied",
] as const;

const shellCommandSchema = z.object({
  type: z.literal("command"),
  command: z.object({
    run: z.string().min(1, "Command cannot be empty"),
    workingDirectory: z.enum(shellCommandWorkingDirectory).optional().default("project"),
  }),
});

const workspaceShellCommandSchema = shellCommandSchema.extend({
  command: shellCommandSchema.shape.command.extend({
    workingDirectory: z.enum(workspaceSetupCommandWorkingDirectory).optional().default("project"),
  }),
});

const workspaceSetupItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("copy"),
    copy: z.object({
      from: z.string().min(1, "Source path cannot be empty"),
      to: z.string().min(1, "Target path cannot be empty"),
    }),
  }),
  workspaceShellCommandSchema,
]);

// Output copy item schema (array of these under phase.outputFiles)
const phaseOutputItemSchema = z
  .object({
    // An array of glob strings representing phase output files to copy
    copy: z.array(z.string()).min(1, "The 'copy' array cannot be empty."),
    // Optional shell commands to run before copying files. Cwd is executionPath
    beforeCopy: z.array(shellCommandSchema).optional(),
  })
  .strict();

const phaseOutputSchema = z.array(phaseOutputItemSchema).optional();

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
    description: z.string().optional(),
    trackedFiles: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    outputFiles: phaseOutputSchema,
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
 * Can be overridden by passing config to TadpoleServer constructor.
 *
 * Note: execution paths and phases must be provided by the user, as well as cwd
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
  | "phases"
> = {
  port: 7777,
  version: "1.0.0",
  outputDirectory: "tadpole-results",
  lockFile: ".tadpole/server.lock",
  socketLogFile: ".tadpole/logs/websocket.log",
  serverLogFile: ".tadpole/logs/server.log",
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

// ============================================================================
// Enhanced Validation
// ============================================================================

export interface ValidationResult {
  phases: PhaseConfig[];
  phaseCount: number;
  promptFileCount: number;
  systemPromptFileCount: number;
  workspaceSetupCount: number;
  watchingPhaseCount: number;
  checkpointPhaseCount: number;
  warnings: string[];
  environmentVariables: {
    fromSystem: Record<string, string>;
    fromPhases: Array<{
      phaseId: string;
      phaseName: string;
      variables: Record<string, string>;
    }>;
  };
}

/**
 * Validate phase configuration with enhanced checks.
 *
 * This performs all the validation of loadPhaseConfig plus additional
 * checks that are useful for pre-flight validation but not strictly
 * required for running.
 *
 * @param configPath - Path to configuration file
 * @param executionPath - Execution directory for relative path resolution
 * @returns Validation result with statistics and warnings
 * @throws Error with detailed messages if validation fails
 */
export async function validatePhaseConfig(
  configPath: string,
  executionPath: string,
): Promise<ValidationResult> {
  // First, use loadPhaseConfig to do basic validation
  // This will throw if there are any structural issues
  const phases = loadPhaseConfig(configPath);

  const result: ValidationResult = {
    phases,
    phaseCount: phases.length,
    promptFileCount: 0,
    systemPromptFileCount: 0,
    workspaceSetupCount: 0,
    watchingPhaseCount: 0,
    checkpointPhaseCount: 0,
    warnings: [],
    environmentVariables: {
      fromSystem: {},
      fromPhases: [],
    },
  };

  // Collect TADPOLE_ prefixed environment variables from system
  for (const key in process.env) {
    if (key.startsWith("TADPOLE_")) {
      const newKey = key.substring("TADPOLE_".length);
      result.environmentVariables.fromSystem[newKey] = process.env[key] || "";
    }
  }

  // Additional validation checks
  const phaseIds = new Set<string>();
  const phaseNames = new Set<string>();

  for (const [index, phase] of phases.entries()) {
    const phaseLabel = `Phase ${index + 1} (${phase.id})`;

    // Check for duplicate IDs
    if (phaseIds.has(phase.id)) {
      throw new Error(`${phaseLabel}: Duplicate phase ID "${phase.id}"`);
    }
    phaseIds.add(phase.id);

    // Warn about duplicate names (not fatal)
    if (phaseNames.has(phase.name)) {
      result.warnings.push(`${phaseLabel}: Duplicate phase name "${phase.name}"`);
    }
    phaseNames.add(phase.name);

    // Collect phase environment variables
    if (phase.env && Object.keys(phase.env).length > 0) {
      result.environmentVariables.fromPhases.push({
        phaseId: phase.id,
        phaseName: phase.name,
        variables: phase.env,
      });
    }

    // Count prompt files
    if (phase.promptFile) {
      const files = Array.isArray(phase.promptFile) ? phase.promptFile : [phase.promptFile];
      result.promptFileCount += files.length;

      // Verify files are readable (loadPhaseConfig checks existence)
      for (const file of files) {
        try {
          const stats = await fs.promises.stat(file);
          if (stats.size === 0) {
            result.warnings.push(`${phaseLabel}: Prompt file "${file}" is empty`);
          }
          if (stats.size > 1024 * 1024) {
            // 1MB
            result.warnings.push(
              `${phaseLabel}: Prompt file "${file}" is large (${(stats.size / 1024 / 1024).toFixed(
                2,
              )}MB)`,
            );
          }
        } catch (error) {
          // Should not happen as loadPhaseConfig already checked
          throw new Error(`${phaseLabel}: Cannot stat prompt file "${file}": ${error}`);
        }
      }
    }

    // Count system prompt files
    if (phase.appendSystemPromptFile) {
      const files = Array.isArray(phase.appendSystemPromptFile)
        ? phase.appendSystemPromptFile
        : [phase.appendSystemPromptFile];
      result.systemPromptFileCount += files.length;
    }

    // Validate workspace setup
    if (phase.workspaceSetup) {
      result.workspaceSetupCount += phase.workspaceSetup.length;

      for (const [itemIndex, item] of phase.workspaceSetup.entries()) {
        if (item.type === "copy" && item.copy) {
          // Check source exists (already done by loadPhaseConfig)
          // Check target parent directory
          const targetPath = path.join(executionPath, item.copy.to);
          const targetParent = path.dirname(targetPath);

          try {
            const relativeParent = path.relative(executionPath, targetParent);
            if (relativeParent.startsWith("..")) {
              throw new Error(
                `${phaseLabel}, workspace setup item ${itemIndex + 1}: ` +
                  `Target path "${item.copy.to}" would write outside execution directory`,
              );
            }
          } catch (_error) {
            // Path resolution error
            throw new Error(
              `${phaseLabel}, workspace setup item ${itemIndex + 1}: ` +
                `Invalid target path "${item.copy.to}"`,
            );
          }

          // Warn if target already exists
          if (fs.existsSync(targetPath)) {
            result.warnings.push(
              `${phaseLabel}: Copy target "${item.copy.to}" already exists and will be overwritten`,
            );
          }
        } else if (item.type === "command" && item.command) {
          // Basic command validation
          const command = item.command.run.trim();
          if (!command) {
            throw new Error(`${phaseLabel}, workspace setup item ${itemIndex + 1}: Empty command`);
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
                `${phaseLabel}: Potentially dangerous command detected: "${command}"`,
              );
              break;
            }
          }
        }
      }
    }

    // Count phases with file tracking
    if (phase.trackedFiles && phase.trackedFiles.length > 0) {
      result.watchingPhaseCount++;
      result.checkpointPhaseCount++;
    }

    // Validate continuation mode
    if (phase.continuationMode === "continue-previous" && index === 0) {
      result.warnings.push(
        `${phaseLabel}: First phase has continuationMode "continue-previous" but there's no previous phase`,
      );
    }

    // Check phase dependencies
    if (phase.continuationMode === "continue-previous" && index > 0) {
      const previousPhase = phases[index - 1];
      // Warn if previous phase doesn't produce output that might be needed
      if (!previousPhase.trackedFiles || previousPhase.trackedFiles.length === 0) {
        result.warnings.push(
          `${phaseLabel}: Continues from previous phase "${previousPhase.id}" ` +
            `which doesn't track any files`,
        );
      }
    }
  }

  // Global warnings
  if (result.phaseCount === 0) {
    throw new Error("Configuration must contain at least one phase");
  }

  return result;
}
