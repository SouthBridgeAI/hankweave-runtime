import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ValidationResult } from "./config.js";
import { DEFAULT_CONFIG, ensureSchemaUrl, validateHank } from "./config.js";
import { hashDataSource } from "./data-hasher.js";
import { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import { formatEnvVarForDisplay, getManagedExecutionsRoot, Logger } from "./utils.js";
import { renderHankStructure } from "./validate-ascii.js";
import { renderBudgetResolutionTable } from "./validate-budget.js";

// -------------
// Path Determination (for validation mode)
// -------------

interface PathsForValidation {
  executionPath: string;
  dataPathInExecutionDir: string;
  configPath: string;
}

/**
 * Determines what paths WOULD be used without creating any directories or files.
 * Used by validation mode to simulate execution setup without side effects.
 */
function determinePaths(options: {
  readOnlySourceDataPath: string;
  executionPath?: string;
  startNew?: boolean;
  dataHash: string;
}): PathsForValidation {
  if (options.executionPath) {
    // Explicit execution path provided
    return {
      executionPath: options.executionPath,
      dataPathInExecutionDir: path.join(options.executionPath, "read_only_data_source"),
      configPath: options.executionPath,
    };
  } else if (options.startNew) {
    // Would create new directory in managed executions
    const executionRoot = getManagedExecutionsRoot();
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6);
    const dirName = `${timestamp}-${random}-${options.dataHash.substring(0, 6)}`;
    const execPath = path.join(executionRoot, dirName);
    return {
      executionPath: execPath,
      dataPathInExecutionDir: path.join(execPath, "read_only_data_source"),
      configPath: execPath,
    };
  } else {
    // Would search for existing or create new
    // For validation, we generate a synthetic path since we don't want to search the filesystem
    const executionRoot = getManagedExecutionsRoot();
    const dirName = `validation-${options.dataHash.substring(0, 6)}`;
    const execPath = path.join(executionRoot, dirName);
    return {
      executionPath: execPath,
      dataPathInExecutionDir: path.join(execPath, "read_only_data_source"),
      configPath: execPath,
    };
  }
}

// -------------
// Validation Result Display
// -------------

interface ValidationDisplayOptions {
  configPath: string;
  dataPath: string;
  executionPath: string;
  result: ValidationResult;
  originalUrl?: string; // Original remote hank URL (if remote)
  resolvedBudget?: { maxDollars?: number; maxTimeSeconds?: number };
}

function displayValidationResult(options: ValidationDisplayOptions): void {
  console.log(`\n✓ Configuration is valid!\n`);

  // ASCII structure visualization
  const terminalWidth =
    process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : 80;

  const structure = renderHankStructure(options.result.codons, {
    terminalWidth,
    hankMeta: options.result.hankMeta,
    hasGlobalSystemPrompt: options.result.globalSystemPrompt !== null,
    configPath: options.configPath,
    promptLineCounts: options.result.promptLineCounts,
  });

  console.log(structure);
  console.log("");

  // Summary box with rounded corners
  const useColor = process.stdout.isTTY ?? false;

  // Budget resolution table (only if any budget config exists)
  const hasAnyBudget =
    options.result.hankBudget ||
    options.result.codons.some((cfg) =>
      cfg.type === "loop" ? cfg.budget || cfg.codons.some((cc) => cc.budget) : cfg.budget,
    );

  if (hasAnyBudget) {
    const budgetTable = renderBudgetResolutionTable({
      hankBudget: options.result.hankBudget ?? {},
      codons: options.result.codons,
      terminalWidth,
      useColor,
      resolvedCeiling: options.resolvedBudget,
    });
    console.log(budgetTable);
    console.log("");
  }
  const green = useColor ? "\x1b[32m" : "";
  const cyan = useColor ? "\x1b[36m" : "";
  const bold = useColor ? "\x1b[1m" : "";
  const dim = useColor ? "\x1b[2m" : "";
  const reset = useColor ? "\x1b[0m" : "";

  // Build summary stats line
  const stats = [
    `${options.result.codonCount} codons`,
    `${options.result.promptFileCount} prompts`,
    `${options.result.systemPromptFileCount} system prompts`,
    `${options.result.rigSetupCount} rigs`,
    `${options.result.checkpointCodonCount} checkpoints`,
  ].join(" • ");

  // Calculate box width (fit to terminal or default 80)
  const boxWidth = Math.min(terminalWidth - 2, Math.max(stats.length + 6, 50));
  const innerWidth = boxWidth - 4;

  // Render the summary box
  // Top border: ╭─ GOOD TO RUN! ───...╮
  // "─ GOOD TO RUN! " = 16 visible chars between ╭ and the trailing dashes + ╮
  const titleChars = "─ GOOD TO RUN! ".length; // 16
  const topDashes = Math.max(0, innerWidth + 2 - titleChars);
  console.log(
    `${cyan}╭─ ${green}${bold}GOOD TO RUN!${reset}${cyan} ${"─".repeat(topDashes)}╮${reset}`,
  );
  console.log(`${cyan}│${reset}  ${dim}${stats.padEnd(innerWidth)}${reset}${cyan}│${reset}`);
  console.log(`${cyan}╰${"─".repeat(innerWidth + 2)}╯${reset}`);

  // Show run command hint
  // For remote hanks (cached in /tmp), the configPath is the cache path — not useful.
  // Use the original URL if available (passed as originalUrl), otherwise make relative to CWD.
  const hankArg = options.originalUrl
    ? options.originalUrl
    : path.relative(process.cwd(), options.configPath) || options.configPath;
  console.log(`\n${dim}Run it:  hankweave ${hankArg} <data_path>${reset}`);

  // Display environment variables
  const hasSystemVars = Object.keys(options.result.environmentVariables.fromSystem).length > 0;
  const hasCodonVars = options.result.environmentVariables.fromCodons.length > 0;

  if (hasSystemVars || hasCodonVars) {
    console.log(`\nEnvironment Variables:`);

    if (hasSystemVars) {
      console.log(`\n  From System (HANKWEAVE_ prefixed):`);
      for (const [key, value] of Object.entries(options.result.environmentVariables.fromSystem)) {
        console.log(`    - ${key}: ${formatEnvVarForDisplay(key, value)}`);
      }
    }

    if (hasCodonVars) {
      console.log(`\n  From Codon Configurations:`);
      for (const codonEnv of options.result.environmentVariables.fromCodons) {
        console.log(`    Codon "${codonEnv.codonName}" (${codonEnv.codonId}):`);
        for (const [key, value] of Object.entries(codonEnv.variables)) {
          console.log(`      - ${key}: ${formatEnvVarForDisplay(key, value)}`);
        }
      }
    }
  }

  if (options.result.warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const warning of options.result.warnings) {
      console.log(`  - ${warning}`);
    }
  }
}

// -------------
// Main Validation Entry Point
// -------------

export interface ValidateOptions {
  /** Resolved absolute path to data source */
  dataPath: string;
  /** Resolved absolute path to config file */
  configPath: string;
  /** Optional explicit execution path */
  executionPath?: string;
  /** Whether --start-new was provided */
  startNew: boolean;
  /** Optional model override from CLI --model flag */
  modelOverride?: string;
  /** Original URL if this is a remote hank (for display in run hint) */
  originalUrl?: string;
  /** Resolved budget from all config layers (runtime, hank, CLI) for accurate ceiling display */
  resolvedBudget?: { maxDollars?: number; maxTimeSeconds?: number };
}

/**
 * Runs configuration validation without creating any directories or files.
 *
 * This is a comprehensive preflight check that:
 * - Verifies the data source exists
 * - Calculates what execution path would be used
 * - Validates the hank configuration
 * - Tests model connectivity (requires API keys)
 *
 * @throws Error if validation fails
 */
export async function runValidation(options: ValidateOptions): Promise<void> {
  const { dataPath, configPath, executionPath, startNew, modelOverride } = options;

  // 1. Verify data source exists (validation should fail fast if it doesn't)
  if (!fs.existsSync(dataPath)) {
    throw new Error(`Data source not found: ${dataPath}`);
  }

  // 2. Calculate data hash (needed for path determination)
  console.log("Calculating data signature for validation...");
  const dataHash = await hashDataSource(dataPath, DEFAULT_CONFIG.dataHashTimeLimit);

  // 3. Determine paths WITHOUT creating any directories
  const paths = determinePaths({
    readOnlySourceDataPath: dataPath,
    executionPath: executionPath ? path.resolve(executionPath) : undefined,
    startNew,
    dataHash,
  });

  // 4. Create logger in temp directory to AVOID creating execution directories
  // CRITICAL: The Logger class auto-creates directories (utils.ts:40-43).
  // Using paths.executionPath here would defeat the entire bug fix!
  const validationLogger = new Logger(
    path.join(os.tmpdir(), `hankweave-validation-${Date.now()}.log`),
  );

  // 5. Initialize LLM Provider Registry (required before validation can run)
  LlmProviderRegistry.getInstance({
    logger: validationLogger,
    performHealthCheckOnInit: false,
  });

  // 6. Auto-add $schema for editor support if missing
  const schemaAdded = ensureSchemaUrl(configPath);
  if (schemaAdded) {
    console.log(`+ Added $schema to ${path.basename(configPath)} for editor support`);
  }

  // 7. Print validation header
  console.log(`\n> Validating configuration: ${configPath}\n`);
  console.log(`  Data source:    ${dataPath}`);
  console.log(`  Execution path: ${paths.executionPath}`);

  // 8. Run validation
  const validationResult = await validateHank({
    configPath,
    executionPath: paths.executionPath,
    logger: validationLogger,
    modelOverride, // Pass through CLI model override if provided
  });

  // 9. Display results
  displayValidationResult({
    configPath,
    dataPath,
    executionPath: paths.executionPath,
    result: validationResult,
    originalUrl: options.originalUrl,
    resolvedBudget: options.resolvedBudget,
  });
}
