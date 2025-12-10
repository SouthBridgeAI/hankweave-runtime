#!/usr/bin/env bun
import path from "node:path";
import { BasicTUI } from "./basic-tui.js";
import { CleanupCommand } from "./cleanup-command.js";
import { resolveSettings, validateStrand } from "./config.js";
import type { ExecutionSetup } from "./execution-setup.js";
import { setupExecutionEnvironment } from "./execution-setup.js";
import { StrandweaveRuntime } from "./strandweave-runtime.js";
import type { StrandweaveConfig } from "./types/types.js";

// -------------
// Helper Functions
// -------------

/**
 * Parse CLI arguments into a structured config object for resolveSettings()
 */
function parseCliArgs(args: string[]): Partial<StrandweaveConfig> {
  const cliArgs: Partial<StrandweaveConfig> = {};

  // Parse port
  const portArg = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
  if (portArg) {
    cliArgs.port = parseInt(portArg, 10);
  }

  // Parse model
  const modelArg = args.find((arg) => arg.startsWith("--model="))?.split("=")[1];
  if (modelArg) {
    cliArgs.model = modelArg as "sonnet" | "opus";
  }

  // Parse anthropicBaseUrl
  const baseUrlArg = args.find((arg) => arg.startsWith("--anthropic-base-url="))?.split("=")[1];
  if (baseUrlArg) {
    cliArgs.anthropicBaseUrl = baseUrlArg;
  }

  // Parse autostart (inverse of --no-autostart)
  if (args.includes("--no-autostart")) {
    cliArgs.autostart = false;
  }

  // Parse withoutProxy
  if (args.includes("--without-proxy")) {
    cliArgs.withoutProxy = true;
  }

  return cliArgs;
}

// -------------
// Main Entry Point
// -------------

async function main() {
  // Strict argument validation
  const rawArgs = process.argv.slice(2);
  const validPatterns = [
    /^--basic$/,
    /^-b$/,
    /^--validate$/,
    /^-v$/,
    /^--cleanup$/,
    /^-y$/,
    /^--no-autostart$/,
    /^--start-new$/,
    /^--config=.+$/,
    /^--data=.+$/,
    /^--execution=.+$/,
    /^--copy$/,
    /^--anthropic-base-url=.+$/,
    /^--port=\d+$/,
    /^--model=(sonnet|opus)$/,
    /^--without-proxy$/,
    /^--help$/,
    /^-h$/,
  ];
  for (const arg of rawArgs) {
    if (!validPatterns.some((pattern) => pattern.test(arg))) {
      console.error(`❌ Error: Unknown argument '${arg}'. Run with --help for available options.`);
      process.exit(1);
    }
  }
  const args = process.argv.slice(2);
  const configPath =
    args.find((arg) => arg.startsWith("--config="))?.split("=")[1] || "strand.json";
  const dataSourcePath = args.find((arg) => arg.startsWith("--data="))?.split("=")[1];
  const executionPath = args.find((arg) => arg.startsWith("--execution="))?.split("=")[1];
  const useSymlink = !args.includes("--copy");
  const basicMode = args.includes("--basic") || args.includes("-b");
  const validateMode = args.includes("--validate") || args.includes("-v");
  const cleanupMode = args.includes("--cleanup");
  const skipConfirmation = args.includes("-y");
  const startNew = args.includes("--start-new");
  // Note: Config-related args (port, model, anthropicBaseUrl, autostart, withoutProxy)
  // are now parsed by parseCliArgs() and handled by resolveSettings()

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Strandweave Runtime - Codon Orchestration

Usage: bun server/index.ts [options]

Options:
  --config=<path>           Path to strand configuration file (default: strand.json)
  --data=<path>             Path to data file or directory (default: current directory)
  --execution=<path>        Resume in specific execution directory
  --start-new               Force creation of a new execution directory
  --copy                    Copy data instead of symlinking (for compatibility)
  --port=<port>             WebSocket server port (default: 7777)
  --basic, -b               Run in basic TUI mode
  --validate, -v            Validate configuration without running
  --cleanup                 Clean up execution directories
  -y                        Skip confirmation prompts
  --no-autostart            Don't automatically start codons
  --model=<sonnet|opus>     Override model for all codons (ignores per-codon settings)
  --anthropic-base-url=<url> Custom Anthropic API base URL
  --without-proxy           Disable the proxy server
  --help, -h                Show this help message

Execution Isolation:
  Strandweave runs in an isolated execution directory separate from your data.
  This enables clean rollbacks and multiple execution tracking.

  Your data is accessed via: <execution-dir>/read_only_data_source/

Template Variables:
  <%EXECUTION_DIR%>  - The execution directory path
  <%DATA_DIR%>       - The data directory path (execution-dir/read_only_data_source)

Examples:
  # Run with default data (current directory)
  bun server/index.ts

  # Run with specific data directory
  bun server/index.ts --data=/path/to/project

  # Run with specific data file
  bun server/index.ts --data=/path/to/file.txt

  # Resume specific execution
  bun server/index.ts --execution=/home/.strandweave-executions/1234-abc

  # Start fresh execution (ignore existing)
  bun server/index.ts --data=/path/to/project --start-new

  # Start fresh in specific empty directory
  bun server/index.ts --data=/path/to/project --execution=/path/to/empty/dir --start-new

  # Copy data instead of symlinking (for Windows/permissions issues)
  bun server/index.ts --data=/path/to/project --copy

  # Clean up all executions for a data directory
  bun server/index.ts --cleanup --data=/path/to/project

  # Override all codon models to use Opus
  bun server/index.ts --model=opus

  # Run in basic TUI mode with Sonnet override
  bun server/index.ts --basic --model=sonnet
`);
    process.exit(0);
  }

  // Resolve data source path
  const originalCwd = process.cwd(); // Save original CWD
  const resolvedDataPath = path.resolve(dataSourcePath || originalCwd);

  // Set up execution environment
  let executionSetup: ExecutionSetup;
  try {
    executionSetup = await setupExecutionEnvironment({
      readOnlySourceDataPath: resolvedDataPath,
      executionPath: executionPath ? path.resolve(executionPath) : undefined,
      useSymlink,
      startNew,
    });
  } catch (error) {
    console.error(`❌ Execution setup failed: ${(error as Error).message}`);
    process.exit(1);
  }

  console.log(`📁 Data source: ${executionSetup.readOnlySourceDataPath}`);
  console.log(`🏃 Execution: ${executionSetup.executionPath}`);
  console.log(`🔗 Link type: ${executionSetup.linkType}`);

  // Change to execution directory for server operation
  process.chdir(executionSetup.executionPath);

  // Handle cleanup mode - UPDATED FOR LATEST EXECUTION ONLY
  if (cleanupMode) {
    try {
      const cleanup = new CleanupCommand({
        dataSourcePath: executionSetup.readOnlySourceDataPath,
        executionPath: executionSetup.executionPath,
        skipConfirmation,
      });

      const result = await cleanup.execute();
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(`\n❌ Cleanup failed: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  // Load and validate configuration
  // Config path is resolved relative to original CWD, not execution dir
  const absoluteConfigPath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(originalCwd, configPath);

  // Parse CLI arguments into structured config
  const cliArgs = parseCliArgs(args);

  // Resolve settings from all 5 config layers
  // (default config, runtime config, strand recommendations, env vars, CLI args)
  // Note: We're now in the execution directory, so strandweave.json will be
  // auto-discovered from process.cwd() if it exists
  const resolvedConfig = resolveSettings({
    cliArgs,
    strandPath: absoluteConfigPath,
  });

  try {
    // Validation mode
    if (validateMode) {
      console.log(`\n🔍 Validating configuration: ${absoluteConfigPath}\n`);

      const validationResult = await validateStrand(
        absoluteConfigPath,
        executionSetup.executionPath, // Changed from readOnlySourceData
      );

      // Print summary
      console.log(`✅ Configuration is valid!\n`);
      console.log(`📋 Summary:`);
      console.log(`  - Codons: ${validationResult.codonCount}`);
      console.log(`  - Total prompt files: ${validationResult.promptFileCount}`);
      console.log(`  - Total system prompt files: ${validationResult.systemPromptFileCount}`);
      console.log(`  - Rig setup operations: ${validationResult.rigSetupCount}`);
      console.log(`  - Codons with file watching: ${validationResult.trackingCodonCount}`);
      console.log(`  - Codons with checkpoints: ${validationResult.checkpointCodonCount}`);

      // Display environment variables
      const hasSystemVars =
        Object.keys(validationResult.environmentVariables.fromSystem).length > 0;
      const hasCodonVars = validationResult.environmentVariables.fromCodons.length > 0;

      if (hasSystemVars || hasCodonVars) {
        console.log(`\n🔧 Environment Variables:`);

        if (hasSystemVars) {
          console.log(`\n  From System (STRANDWEAVE_ prefixed):`);
          for (const [key, value] of Object.entries(
            validationResult.environmentVariables.fromSystem,
          )) {
            console.log(`    - ${key}: ${value}`);
          }
        }

        if (hasCodonVars) {
          console.log(`\n  From Codon Configurations:`);
          for (const codonEnv of validationResult.environmentVariables.fromCodons) {
            console.log(`    Codon "${codonEnv.codonName}" (${codonEnv.codonId}):`);
            for (const [key, value] of Object.entries(codonEnv.variables)) {
              console.log(`      - ${key}: ${value}`);
            }
          }
        }
      }

      if (validationResult.warnings.length > 0) {
        console.log(`\n⚠️  Warnings:`);
        for (const warning of validationResult.warnings) {
          console.log(`  - ${warning}`);
        }
      }

      process.exit(0);
    }

    // Normal server mode - validate config
    const { codons, warnings } = await validateStrand(
      absoluteConfigPath,
      executionSetup.executionPath, // Changed from readOnlySourceData
    );

    // Log any non-fatal warnings
    if (warnings.length > 0) {
      console.log("\n⚠️  Configuration warnings:");
      for (const warning of warnings) {
        console.log(`  - ${warning}`);
      }
      console.log();
    }

    // Create server configuration by merging all config layers with execution properties
    const serverConfig = {
      // Start with resolved config from all 5 layers
      // (default config, runtime config, strand recommendations, env vars, CLI args)
      ...resolvedConfig,

      // Override with execution-specific properties (these are not part of the config system)
      cwd: originalCwd,
      configPath: absoluteConfigPath,
      readOnlySourceDataPath: executionSetup.readOnlySourceDataPath,
      executionPath: executionSetup.executionPath,
      dataPathInExecutionDir: executionSetup.dataPathInExecutionDir,
      dataHash: executionSetup.dataHash,
      isNewExecution: executionSetup.isNewExecution,
      isResuming: executionSetup.isResuming,
      linkType: executionSetup.linkType,

      // Required: codons from validation
      codons,
    };

    const server = new StrandweaveRuntime(serverConfig);
    await server.start();

    if (basicMode) {
      // Give server a moment to start before connecting
      setTimeout(() => {
        new BasicTUI(server);
      }, 100);
      console.log("🎮 Running in basic TUI mode");
    }
  } catch (error) {
    console.error(
      `Failed to start server: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
