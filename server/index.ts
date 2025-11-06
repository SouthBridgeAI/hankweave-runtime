#!/usr/bin/env bun
import path from "node:path";
import { BasicTUI } from "./basic-tui.js";
import { CleanupCommand } from "./cleanup-command.js";
import { validatePhaseConfig } from "./config.js";
import type { ExecutionSetup } from "./execution-setup.js";
import { setupExecutionEnvironment } from "./execution-setup.js";
import { TadpoleServer } from "./tadpole-server.js";

// ============================================================================
// Main Entry Point
// ============================================================================

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
    args.find((arg) => arg.startsWith("--config="))?.split("=")[1] || "phases.json";
  const dataSourcePath = args.find((arg) => arg.startsWith("--data="))?.split("=")[1];
  const executionPath = args.find((arg) => arg.startsWith("--execution="))?.split("=")[1];
  const useSymlink = !args.includes("--copy");
  const basicMode = args.includes("--basic") || args.includes("-b");
  const validateMode = args.includes("--validate") || args.includes("-v");
  const cleanupMode = args.includes("--cleanup");
  const skipConfirmation = args.includes("-y");
  const noAutostart = args.includes("--no-autostart");
  const startNew = args.includes("--start-new");
  const anthropicBaseURL = args
    .find((arg) => arg.startsWith("--anthropic-base-url="))
    ?.split("=")[1];
  const port = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
  const modelOverride = args.find((arg) => arg.startsWith("--model="))?.split("=")[1] as
    | "sonnet"
    | "opus"
    | undefined;
  const withoutProxy = args.includes("--without-proxy");

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Tadpole Server - Phase Orchestration

Usage: bun server/index.ts [options]

Options:
  --config=<path>           Path to phases configuration file (default: phases.json)
  --data=<path>             Path to data file or directory (default: current directory)
  --execution=<path>        Resume in specific execution directory
  --start-new               Force creation of a new execution directory
  --copy                    Copy data instead of symlinking (for compatibility)
  --port=<port>             WebSocket server port (default: 7777)
  --basic, -b               Run in basic TUI mode
  --validate, -v            Validate configuration without running
  --cleanup                 Clean up execution directories
  -y                        Skip confirmation prompts
  --no-autostart            Don't automatically start phases
  --model=<sonnet|opus>     Override model for all phases (ignores per-phase settings)
  --anthropic-base-url=<url> Custom Anthropic API base URL
  --without-proxy           Disable the proxy server
  --help, -h                Show this help message

Execution Isolation:
  Tadpole runs in an isolated execution directory separate from your data.
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
  bun server/index.ts --execution=/home/.tadpole-executions/1234-abc

  # Start fresh execution (ignore existing)
  bun server/index.ts --data=/path/to/project --start-new

  # Start fresh in specific empty directory
  bun server/index.ts --data=/path/to/project --execution=/path/to/empty/dir --start-new

  # Copy data instead of symlinking (for Windows/permissions issues)
  bun server/index.ts --data=/path/to/project --copy

  # Clean up all executions for a data directory
  bun server/index.ts --cleanup --data=/path/to/project

  # Override all phase models to use Opus
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

  try {
    // Validation mode
    if (validateMode) {
      console.log(`\n🔍 Validating configuration: ${absoluteConfigPath}\n`);

      const validationResult = await validatePhaseConfig(
        absoluteConfigPath,
        executionSetup.executionPath, // Changed from readOnlySourceData
      );

      // Print summary
      console.log(`✅ Configuration is valid!\n`);
      console.log(`📋 Summary:`);
      console.log(`  - Phases: ${validationResult.phaseCount}`);
      console.log(`  - Total prompt files: ${validationResult.promptFileCount}`);
      console.log(`  - Total system prompt files: ${validationResult.systemPromptFileCount}`);
      console.log(`  - Workspace setup operations: ${validationResult.workspaceSetupCount}`);
      console.log(`  - Phases with file watching: ${validationResult.watchingPhaseCount}`);
      console.log(`  - Phases with checkpoints: ${validationResult.checkpointPhaseCount}`);

      // Display environment variables
      const hasSystemVars =
        Object.keys(validationResult.environmentVariables.fromSystem).length > 0;
      const hasPhaseVars = validationResult.environmentVariables.fromPhases.length > 0;

      if (hasSystemVars || hasPhaseVars) {
        console.log(`\n🔧 Environment Variables:`);

        if (hasSystemVars) {
          console.log(`\n  From System (TADPOLE_ prefixed):`);
          for (const [key, value] of Object.entries(
            validationResult.environmentVariables.fromSystem,
          )) {
            console.log(`    - ${key}: ${value}`);
          }
        }

        if (hasPhaseVars) {
          console.log(`\n  From Phase Configurations:`);
          for (const phaseEnv of validationResult.environmentVariables.fromPhases) {
            console.log(`    Phase "${phaseEnv.phaseName}" (${phaseEnv.phaseId}):`);
            for (const [key, value] of Object.entries(phaseEnv.variables)) {
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
    const { phases, warnings } = await validatePhaseConfig(
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

    // Create server configuration by merging ExecutionSetup with other config
    const serverConfig = {
      // This is where tadpole is running
      cwd: originalCwd,

      // Path to config file (for resolving relative chronicler paths)
      configPath: absoluteConfigPath,

      // Required execution properties from ExecutionSetup
      readOnlySourceDataPath: executionSetup.readOnlySourceDataPath,
      executionPath: executionSetup.executionPath,
      dataPathInExecutionDir: executionSetup.dataPathInExecutionDir,
      dataHash: executionSetup.dataHash,
      isNewExecution: executionSetup.isNewExecution,
      isResuming: executionSetup.isResuming,
      linkType: executionSetup.linkType,

      // Required phases
      phases,

      // Optional config (will use defaults if not provided)
      ...(anthropicBaseURL && { anthropicBaseURL }),
      ...(port && { port: parseInt(port, 10) }),
      ...(modelOverride && { modelOverride }),
      autostart: !noAutostart,
      withoutProxy,
    };

    const server = new TadpoleServer(serverConfig);
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
