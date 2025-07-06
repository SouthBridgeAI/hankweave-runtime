#!/usr/bin/env bun
import { BasicTUI } from "./basic-tui.js";
import { loadPhaseConfig } from "./config.js";
import { LangtonServer } from "./langton-server.js";

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const basicMode = args.includes("--basic") || args.includes("-b");
  const configPath =
    args.find((arg) => arg.startsWith("--config="))?.split("=")[1] || "phases.json";

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Langton Server - Claude Phase Orchestration

Usage: bun server/index.ts [options]

Options:
  --config=<path>    Path to phases configuration file (default: phases.json)
  --basic, -b        Run in basic TUI mode (prints events to console)
  --help, -h         Show this help message

Examples:
  bun server/index.ts                          # Normal WebSocket server
  bun server/index.ts --basic                  # Basic TUI mode
  bun server/index.ts --config=my-phases.json  # Custom config file
`);
    process.exit(0);
  }

  try {
    const phases = loadPhaseConfig(configPath);
    const server = new LangtonServer({
      projectPath: process.cwd(),
      phases,
    });

    await server.start();

    if (basicMode) {
      new BasicTUI(server);
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
