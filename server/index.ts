#!/usr/bin/env bun
import { BasicTUI } from "./basic-tui.js";
import { CleanupCommand } from "./cleanup-command.js";
import { validatePhaseConfig } from "./config.js";
import { LangtonServer } from "./langton-server.js";
import type { PhaseConfig, ServerConfig } from "./types.js";

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
    /^--config=.+$/,
    /^--anthropic-base-url=.+$/,
    /^--port=\d+$/,
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
  const basicMode = args.includes("--basic") || args.includes("-b");
  const validateMode = args.includes("--validate") || args.includes("-v");
  const cleanupMode = args.includes("--cleanup");
  const skipConfirmation = args.includes("-y");
  const noAutostart = args.includes("--no-autostart");
  const configPath =
    args.find((arg) => arg.startsWith("--config="))?.split("=")[1] || "phases.json";
  const anthropicBaseURL = args
    .find((arg) => arg.startsWith("--anthropic-base-url="))
    ?.split("=")[1];
  const port = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Langton Server - Claude Phase Orchestration

Usage: bun server/index.ts [options]

Options:
  --config=<path>           Path to phases configuration file (default: phases.json)
  --port=<port>             WebSocket server port (default: 7777)
  --basic, -b               Run in basic TUI mode (prints events to console)
  --validate, -v            Validate configuration without running server
  --cleanup                 Clean up all Langton artifacts (requires --config)
  -y                        Skip confirmation prompts (for scripts/tests)
  --no-autostart            Don't automatically start phases (wait for commands)
  --anthropic-base-url=<url> Custom Anthropic API base URL (for proxies/gateways)
  --help, -h                Show this help message

Examples:
  bun server/index.ts                          # Normal WebSocket server
  bun server/index.ts --basic                  # Basic TUI mode
  bun server/index.ts --config=my-phases.json  # Custom config file
  bun server/index.ts --validate               # Validate configuration only
  bun server/index.ts --cleanup --config=phases.json     # Clean up project
  bun server/index.ts --cleanup --config=phases.json -y  # Clean up without prompts
  bun server/index.ts --anthropic-base-url=https://proxy.example.com
`);
    process.exit(0);
  }

  try {
    // If validate mode, just validate and exit
    if (validateMode) {
      console.log(`\n🔍 Validating configuration: ${configPath}\n`);

      try {
        const validationResult = await validatePhaseConfig(configPath, process.cwd());

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
      } catch (error) {
        console.error(`\n❌ Validation failed:\n`);
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    }

    // Add cleanup mode handling
    if (cleanupMode) {
      if (!configPath || configPath === "phases.json") {
        console.error("❌ Error: --cleanup requires explicit --config=<path>");
        console.error("   This ensures you're cleaning up the right project.");
        process.exit(1);
      }

      try {
        const cleanup = new CleanupCommand({
          configPath,
          projectPath: process.cwd(),
          skipConfirmation,
        });

        const result = await cleanup.execute();
        process.exit(result.success ? 0 : 1);
      } catch (error) {
        console.error(
          `\n❌ Cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    }

    // Normal server startup
    // Validate config on every startup, not just with --validate
    const { phases, warnings } = await validatePhaseConfig(configPath, process.cwd());

    // Log any non-fatal warnings
    if (warnings.length > 0) {
      console.log("\n⚠️  Configuration warnings:");
      for (const warning of warnings) {
        console.log(`  - ${warning}`);
      }
      console.log();
    }

    const serverConfig: Partial<ServerConfig> & {
      projectPath: string;
      phases: PhaseConfig[];
    } = {
      projectPath: process.cwd(),
      phases,
      anthropicBaseURL,
      autostart: !noAutostart, // New property
    };

    if (port) {
      serverConfig.port = parseInt(port, 10);
    }

    const server = new LangtonServer(serverConfig);

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
