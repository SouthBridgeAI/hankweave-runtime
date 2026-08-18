import fs from "node:fs";
import path from "node:path";
import { sentinelConfigSchema } from "../config-validation/sentinel.schema.js";
import { checkRegularFile } from "../fs-guards.js";
import {
  readRef,
  refViolationMessage,
  resolveRef,
  sentinelOwnRefs,
  validateRef,
} from "../hank-refs.js";
import type { SentinelConfig } from "../types/sentinel-types.js";
import type { CodonSentinelEntry } from "../types/types.js";
import type { Logger } from "../utils.js";

/**
 * Loaded sentinel config with metadata.
 */
export interface LoadedSentinelConfig {
  config: SentinelConfig;
  failCodonIfNotLoaded: boolean;
  outputPaths?: {
    logFile?: string;
    lastValueFile?: string;
  };
  source: "file" | "inline";
  sourcePath?: string; // For file-based configs
  configDirectory: string; // For resolving relative paths (promptFile, schemaFile, etc.)
}

/**
 * Result of loading sentinel configs.
 */
export interface SentinelConfigLoadResult {
  configs: LoadedSentinelConfig[];
  errors: Array<{
    ref: string;
    error: string;
    fatal: boolean; // True if failCodonIfNotLoaded was set
  }>;
}

/**
 * Loads and validates sentinel configurations from files or inline objects.
 * Caches file-based configs to avoid redundant reads.
 *
 * This utility loads CONFIGS, not Sentinel instances. The SentinelManager
 * handles actual instantiation.
 */
export class SentinelConfigLoader {
  private configCache: Map<string, SentinelConfig> = new Map();

  constructor(private logger?: Logger) {}

  /**
   * Load sentinel configs for a codon.
   *
   * @param entries - Array of sentinel entries (wrapper objects)
   * @param codonId - ID of the codon (for error messages)
   * @param codonConfigDir - Directory containing hank.json (for resolving relative paths)
   * @returns Load result with successful configs and errors
   */
  loadConfigsForCodon(
    entries: CodonSentinelEntry[],
    codonId: string,
    codonConfigDir: string,
  ): SentinelConfigLoadResult {
    const configs: LoadedSentinelConfig[] = [];
    const errors: SentinelConfigLoadResult["errors"] = [];
    const seenIds = new Set<string>();

    for (const entry of entries) {
      try {
        let config: SentinelConfig;
        let configDir: string;
        let source: "file" | "inline";
        let sourcePath: string | undefined;

        // Extract settings from wrapper
        const failCodonIfNotLoaded = entry.settings?.failCodonIfNotLoaded ?? false;
        const outputPaths = entry.settings?.outputPaths;

        if (typeof entry.sentinelConfig === "string") {
          // File reference — strict-ref policy on the entry ref before it is
          // resolved or read (sentinels load at codon start, not only during
          // static validation, so this gate runs here too).
          const vettedEntry = validateRef(entry.sentinelConfig, codonConfigDir, codonConfigDir);
          if (typeof vettedEntry !== "string") {
            throw new Error(refViolationMessage(vettedEntry));
          }
          const resolvedPath = resolveRef(vettedEntry, codonConfigDir);

          // Check cache first
          if (this.configCache.has(resolvedPath)) {
            const cachedConfig = this.configCache.get(resolvedPath);
            if (!cachedConfig) {
              throw new Error(`Cache inconsistency for ${resolvedPath}`);
            }
            config = cachedConfig;
            this.logger?.log(
              `Using cached sentinel config: ${path.basename(resolvedPath)}`,
              "debug",
            );
          } else {
            // Load and validate. Guarded rather than existsSync-checked: this
            // runs at codon startup even when validation only warned (a
            // sentinel without failCodonIfNotLoaded), and reading a FIFO here
            // would block forever.
            const problem = checkRegularFile(resolvedPath, { read: false });
            if (problem) {
              throw new Error(
                problem.kind === "missing"
                  ? `Config file not found: ${entry.sentinelConfig}`
                  : `Config file ${problem.phrase}: ${entry.sentinelConfig}`,
              );
            }

            const content = readRef(vettedEntry, codonConfigDir).text;
            const parsed = JSON.parse(content);
            config = sentinelConfigSchema.parse(parsed);

            // Cache for reuse
            this.configCache.set(resolvedPath, config);
            this.logger?.log(
              `Loaded and cached sentinel config: ${path.basename(resolvedPath)}`,
              "debug",
            );
          }

          configDir = path.dirname(resolvedPath);
          source = "file";
          sourcePath = resolvedPath;
        } else {
          // Inline config
          config = sentinelConfigSchema.parse(entry.sentinelConfig);
          configDir = codonConfigDir;
          source = "inline";
        }

        // Strict-ref policy for the config's OWN refs. Anchor rule (mirrored
        // in config.ts static sentinel validation): file-based refs resolve
        // from the config file's own directory, inline refs from the hank
        // dir; the hank dir is always the containment anchor. Runs on cache
        // hits too — the parsed config is reusable, but the disk can change
        // between codons and re-checking a handful of refs is nearly free.
        for (const { field, raw } of sentinelOwnRefs(config)) {
          const violation = validateRef(raw, configDir, codonConfigDir);
          if (typeof violation !== "string") {
            throw new Error(`${field}: ${refViolationMessage(violation)}`);
          }
        }

        // Check for duplicate IDs
        if (seenIds.has(config.id)) {
          throw new Error(`Duplicate sentinel ID '${config.id}' in codon ${codonId}`);
        }
        seenIds.add(config.id);

        configs.push({
          config,
          failCodonIfNotLoaded,
          outputPaths,
          source,
          sourcePath,
          configDirectory: configDir,
        });

        this.logger?.log(
          `Loaded sentinel config '${config.id}' (${source})${failCodonIfNotLoaded ? " [REQUIRED]" : ""}`,
          "debug",
        );
      } catch (error) {
        const refStr =
          typeof entry.sentinelConfig === "string"
            ? entry.sentinelConfig
            : `inline:${(entry.sentinelConfig as { id?: string }).id || "unknown"}`;
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isFatal = entry.settings?.failCodonIfNotLoaded ?? false;

        errors.push({
          ref: refStr,
          error: errorMsg,
          fatal: isFatal,
        });

        this.logger?.log(
          `Failed to load sentinel config ${refStr}: ${errorMsg}${isFatal ? " [FATAL]" : ""}`,
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
    this.logger?.log("Sentinel config cache cleared", "debug");
  }
}
