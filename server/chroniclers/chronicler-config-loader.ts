import fs from "node:fs";
import path from "node:path";
import { chroniclerConfigSchema } from "../config-validation/chronicler.schema.js";
import type { ChroniclerConfig } from "../types/chronicler-types.js";
import type { PhaseChroniclerEntry } from "../types/types.js";
import type { Logger } from "../utils.js";

/**
 * Loaded chronicler config with metadata.
 */
export interface LoadedChroniclerConfig {
  config: ChroniclerConfig;
  failPhaseIfNotLoaded: boolean;
  outputPaths?: {
    logFile?: string;
    lastValueFile?: string;
  };
  source: "file" | "inline";
  sourcePath?: string; // For file-based configs
  configDirectory: string; // For resolving relative paths (promptFile, schemaFile, etc.)
}

/**
 * Result of loading chronicler configs.
 */
export interface ChroniclerConfigLoadResult {
  configs: LoadedChroniclerConfig[];
  errors: Array<{
    ref: string;
    error: string;
    fatal: boolean; // True if failPhaseIfNotLoaded was set
  }>;
}

/**
 * Loads and validates chronicler configurations from files or inline objects.
 * Caches file-based configs to avoid redundant reads.
 *
 * This utility loads CONFIGS, not Chronicler instances. The ChroniclerManager
 * handles actual instantiation.
 */
export class ChroniclerConfigLoader {
  private configCache: Map<string, ChroniclerConfig> = new Map();

  constructor(private logger?: Logger) {}

  /**
   * Load chronicler configs for a phase.
   *
   * @param entries - Array of chronicler entries (wrapper objects)
   * @param phaseId - ID of the phase (for error messages)
   * @param phaseConfigDir - Directory containing phases.json (for resolving relative paths)
   * @returns Load result with successful configs and errors
   */
  loadConfigsForPhase(
    entries: PhaseChroniclerEntry[],
    phaseId: string,
    phaseConfigDir: string,
  ): ChroniclerConfigLoadResult {
    const configs: LoadedChroniclerConfig[] = [];
    const errors: ChroniclerConfigLoadResult["errors"] = [];
    const seenIds = new Set<string>();

    for (const entry of entries) {
      try {
        let config: ChroniclerConfig;
        let configDir: string;
        let source: "file" | "inline";
        let sourcePath: string | undefined;

        // Extract settings from wrapper
        const failPhaseIfNotLoaded = entry.settings?.failPhaseIfNotLoaded ?? false;
        const outputPaths = entry.settings?.outputPaths;

        if (typeof entry.chroniclerConfig === "string") {
          // File reference
          const resolvedPath = path.isAbsolute(entry.chroniclerConfig)
            ? entry.chroniclerConfig
            : path.resolve(phaseConfigDir, entry.chroniclerConfig);

          // Check cache first
          if (this.configCache.has(resolvedPath)) {
            const cachedConfig = this.configCache.get(resolvedPath);
            if (!cachedConfig) {
              throw new Error(`Cache inconsistency for ${resolvedPath}`);
            }
            config = cachedConfig;
            this.logger?.log(
              `Using cached chronicler config: ${path.basename(resolvedPath)}`,
              "debug",
            );
          } else {
            // Load and validate
            if (!fs.existsSync(resolvedPath)) {
              throw new Error(`Config file not found: ${entry.chroniclerConfig}`);
            }

            const content = fs.readFileSync(resolvedPath, "utf-8");
            const parsed = JSON.parse(content);
            config = chroniclerConfigSchema.parse(parsed);

            // Cache for reuse
            this.configCache.set(resolvedPath, config);
            this.logger?.log(
              `Loaded and cached chronicler config: ${path.basename(resolvedPath)}`,
              "debug",
            );
          }

          configDir = path.dirname(resolvedPath);
          source = "file";
          sourcePath = resolvedPath;
        } else {
          // Inline config
          config = chroniclerConfigSchema.parse(entry.chroniclerConfig);
          configDir = phaseConfigDir;
          source = "inline";
        }

        // Check for duplicate IDs
        if (seenIds.has(config.id)) {
          throw new Error(`Duplicate chronicler ID '${config.id}' in phase ${phaseId}`);
        }
        seenIds.add(config.id);

        configs.push({
          config,
          failPhaseIfNotLoaded,
          outputPaths,
          source,
          sourcePath,
          configDirectory: configDir,
        });

        this.logger?.log(
          `Loaded chronicler config '${config.id}' (${source})${failPhaseIfNotLoaded ? " [REQUIRED]" : ""}`,
          "debug",
        );
      } catch (error) {
        const refStr =
          typeof entry.chroniclerConfig === "string"
            ? entry.chroniclerConfig
            : `inline:${(entry.chroniclerConfig as { id?: string }).id || "unknown"}`;
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isFatal = entry.settings?.failPhaseIfNotLoaded ?? false;

        errors.push({
          ref: refStr,
          error: errorMsg,
          fatal: isFatal,
        });

        this.logger?.log(
          `Failed to load chronicler config ${refStr}: ${errorMsg}${isFatal ? " [FATAL]" : ""}`,
          isFatal ? "error" : "info",
        );
      }
    }

    return { configs, errors };
  }

  /**
   * Clear the config cache.
   * Useful for testing or hot-reload scenarios.
   */
  clearCache(): void {
    this.configCache.clear();
    this.logger?.log("Chronicler config cache cleared", "debug");
  }
}
