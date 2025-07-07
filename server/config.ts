import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PhaseConfig, ServerConfig } from "./types.js";

// ============================================================================
// Configuration Schema
// ============================================================================

const phaseConfigSchema = z
  .object({
    id: z.string().min(1, "Phase ID cannot be empty"),
    name: z.string().min(1, "Phase name cannot be empty"),
    promptFile: z.string().optional(),
    promptText: z.string().optional(),
    appendSystemPromptFile: z.string().optional(),
    appendSystemPromptText: z.string().optional(),
    model: z.string().min(1, "Model name cannot be empty"),
    continueFromPrevious: z.boolean().optional(),
    preStart: z.string().optional(),
    watch: z.string().optional(),
    description: z.string().optional(),
  })
  .refine((data) => data.promptFile || data.promptText, {
    message: "Either promptFile or promptText must be provided",
  })
  .refine((data) => !(data.appendSystemPromptFile && data.appendSystemPromptText), {
    message: "Cannot specify both appendSystemPromptFile and appendSystemPromptText",
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
  lockFile: ".langton-server.lock",
  socketLogFile: ".logs/websocket.log",
  serverLogFile: ".logs/server.log",
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
      const errors = result.error.errors
        .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
        .join("\n");
      throw new Error(`Invalid phase configuration:\n${errors}`);
    }

    // Resolve relative paths for promptFile and appendSystemPromptFile
    const configDir = path.dirname(configPath);
    const resolvedConfig = result.data.map((phase) => {
      const resolved = { ...phase };
      
      if (phase.promptFile && !path.isAbsolute(phase.promptFile)) {
        resolved.promptFile = path.resolve(configDir, phase.promptFile);
      }
      
      if (phase.appendSystemPromptFile && !path.isAbsolute(phase.appendSystemPromptFile)) {
        resolved.appendSystemPromptFile = path.resolve(configDir, phase.appendSystemPromptFile);
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
          `Phase ${index + 1} (${phase.id}): model "${phase.model}" is not valid. Must be one of: ${validModels.join(", ")}`,
        );
      }

      // Validate promptFile existence and readability
      if (phase.promptFile) {
        if (!fs.existsSync(phase.promptFile)) {
          validationErrors.push(
            `Phase ${index + 1} (${phase.id}): promptFile "${phase.promptFile}" does not exist`,
          );
        } else {
          try {
            fs.readFileSync(phase.promptFile, "utf-8");
          } catch (error) {
            validationErrors.push(
              `Phase ${index + 1} (${phase.id}): promptFile "${phase.promptFile}" is not readable: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      // Validate appendSystemPromptFile existence and readability
      if (phase.appendSystemPromptFile) {
        if (!fs.existsSync(phase.appendSystemPromptFile)) {
          validationErrors.push(
            `Phase ${index + 1} (${phase.id}): appendSystemPromptFile "${phase.appendSystemPromptFile}" does not exist`,
          );
        } else {
          try {
            fs.readFileSync(phase.appendSystemPromptFile, "utf-8");
          } catch (error) {
            validationErrors.push(
              `Phase ${index + 1} (${phase.id}): appendSystemPromptFile "${phase.appendSystemPromptFile}" is not readable: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }

    if (validationErrors.length > 0) {
      throw new Error(`Phase configuration validation failed:\n${validationErrors.join("\n")}`);
    }

    return resolvedConfig;
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
