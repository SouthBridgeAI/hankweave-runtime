import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, validateHank } from "./config.js";
import { hashDataSource } from "./data-hasher.js";
import { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import { Logger } from "./utils.js";

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
    const executionRoot = path.join(os.homedir(), ".hankweave-executions");
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
    const executionRoot = path.join(os.homedir(), ".hankweave-executions");
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
  result: {
    codonCount: number;
    promptFileCount: number;
    systemPromptFileCount: number;
    rigSetupCount: number;
    trackingCodonCount: number;
    checkpointCodonCount: number;
    environmentVariables: {
      fromSystem: Record<string, string>;
      fromCodons: Array<{
        codonId: string;
        codonName: string;
        variables: Record<string, string>;
      }>;
    };
    warnings: string[];
  };
}

function displayValidationResult(options: ValidationDisplayOptions): void {
  console.log(`\n✅ Configuration is valid!\n`);
  console.log(`📋 Summary:`);
  console.log(`  - Codons: ${options.result.codonCount}`);
  console.log(`  - Total prompt files: ${options.result.promptFileCount}`);
  console.log(`  - Total system prompt files: ${options.result.systemPromptFileCount}`);
  console.log(`  - Rig setup operations: ${options.result.rigSetupCount}`);
  console.log(`  - Codons with file watching: ${options.result.trackingCodonCount}`);
  console.log(`  - Codons with checkpoints: ${options.result.checkpointCodonCount}`);

  // Display environment variables
  const hasSystemVars = Object.keys(options.result.environmentVariables.fromSystem).length > 0;
  const hasCodonVars = options.result.environmentVariables.fromCodons.length > 0;

  if (hasSystemVars || hasCodonVars) {
    console.log(`\n🔧 Environment Variables:`);

    if (hasSystemVars) {
      console.log(`\n  From System (HANKWEAVE_ prefixed):`);
      for (const [key, value] of Object.entries(options.result.environmentVariables.fromSystem)) {
        console.log(`    - ${key}: ${value}`);
      }
    }

    if (hasCodonVars) {
      console.log(`\n  From Codon Configurations:`);
      for (const codonEnv of options.result.environmentVariables.fromCodons) {
        console.log(`    Codon "${codonEnv.codonName}" (${codonEnv.codonId}):`);
        for (const [key, value] of Object.entries(codonEnv.variables)) {
          console.log(`      - ${key}: ${value}`);
        }
      }
    }
  }

  if (options.result.warnings.length > 0) {
    console.log(`\n⚠️  Warnings:`);
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
  const { dataPath, configPath, executionPath, startNew } = options;

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

  // 6. Print validation header
  console.log(`\n🔍 Validating configuration: ${configPath}\n`);
  console.log(`📁 Data source: ${dataPath}`);
  console.log(`🏃 Would execute in: ${paths.executionPath}`);

  // 7. Run validation
  const validationResult = await validateHank(configPath, paths.executionPath, validationLogger);

  // 8. Display results
  displayValidationResult({
    configPath,
    dataPath,
    executionPath: paths.executionPath,
    result: validationResult,
  });
}
