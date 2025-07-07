#!/usr/bin/env bun
import { BasicTUI } from "./basic-tui.js";
import { loadPhaseConfig } from "./config.js";
import { LangtonServer } from "./langton-server.js";
import type { PhaseConfig, ServerConfig } from "./types.js";

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const basicMode = args.includes("--basic") || args.includes("-b");
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
  --anthropic-base-url=<url> Custom Anthropic API base URL (for proxies/gateways)
  --help, -h                Show this help message

Examples:
  bun server/index.ts                          # Normal WebSocket server
  bun server/index.ts --basic                  # Basic TUI mode
  bun server/index.ts --config=my-phases.json  # Custom config file
  bun server/index.ts --anthropic-base-url=https://proxy.example.com
`);
    process.exit(0);
  }

  try {
    const phases = loadPhaseConfig(configPath);
    const serverConfig: Partial<ServerConfig> & { projectPath: string; phases: PhaseConfig[] } = {
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
