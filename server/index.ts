#!/usr/bin/env bun
import { BasicTUI } from "./basic-tui.js";
import { loadPhaseConfig, validatePhaseConfig } from "./config.js";
import { LangtonServer } from "./langton-server.js";
import type { PhaseConfig, ServerConfig } from "./types.js";

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const basicMode = args.includes("--basic") || args.includes("-b");
  const validateMode = args.includes("--validate") || args.includes("-v");
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
  --anthropic-base-url=<url> Custom Anthropic API base URL (for proxies/gateways)
  --help, -h                Show this help message

Examples:
  bun server/index.ts                          # Normal WebSocket server
  bun server/index.ts --basic                  # Basic TUI mode
  bun server/index.ts --config=my-phases.json  # Custom config file
  bun server/index.ts --validate               # Validate configuration only
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

    // Normal server startup
    const phases = loadPhaseConfig(configPath);
    const serverConfig: Partial<ServerConfig> & {
      projectPath: string;
      phases: PhaseConfig[];
    } = {
      projectPath: process.cwd(),
      phases,
      anthropicBaseURL,
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
