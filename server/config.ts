import fs from "node:fs";
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
    model: z.string().min(1, "Model name cannot be empty"),
    continueFromPrevious: z.boolean().optional(),
    preStart: z.string().optional(),
    watch: z.string().optional(),
    description: z.string().optional(),
  })
  .refine((data) => data.promptFile || data.promptText, {
    message: "Either promptFile or promptText must be provided",
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

    return result.data;
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
