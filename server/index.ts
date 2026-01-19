#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicTUI } from "./basic-tui.js";
import { ClaudeAgentSDKManager } from "./claude-agent-sdk-manager.js";
import { CleanupCommand } from "./cleanup-command.js";
import { parseCliArgs } from "./cli-parser.js";
import { resolveSettings, validateHank } from "./config.js";
import type { ExecutionSetup } from "./execution-setup.js";
import { setupExecutionEnvironment } from "./execution-setup.js";
import { HankweaveRuntime } from "./hankweave-runtime.js";
import { initProject } from "./init-command.js";
import { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import {
  displayHankSummary,
  getHankSummary,
  isRemoteHankUrl,
  resolveRemoteHank,
} from "./remote-hank.js";
import { getMetadata, Logger } from "./utils.js";
import { runValidation } from "./validate-command.js";

// -------------
// Helper Functions
// -------------

/**
 * Read content from stdin.
 * Throws if stdin is a TTY (no piped input).
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('No input provided on stdin. Use: echo "text" | hankweave hank.json -');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Generate a unique temporary file path.
 */
function generateTempFilePath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `hankweave-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
}

// -------------
// Main Entry Point
// -------------

async function main() {
  const args = process.argv.slice(2);

  // Parse ALL CLI arguments in one place (with validation)
  let cliArgs: ReturnType<typeof parseCliArgs>;
  try {
    cliArgs = parseCliArgs(args);
  } catch (error) {
    console.error(`❌ Error: ${(error as Error).message}`);
    process.exit(1);
  }

  // Handle version flag - print version and exit
  if (cliArgs.showVersion) {
    console.log(getMetadata().version);
    process.exit(0);
  }

  // Print version banner
  console.log(`\nHankweave v${getMetadata().version}\n`);

  // Extract values with defaults
  const configPath = cliArgs.hankPath || cliArgs.configPath || "hank.json";
  const dataSourcePath = cliArgs.dataPath || cliArgs.dataFlag;
  const executionPath = cliArgs.executionPath;
  const inlineInput = cliArgs.inputText;

  const useSymlink = !cliArgs.copy;
  const headlessMode = cliArgs.headless || false;
  const validateMode = cliArgs.validate || false;
  const cleanupMode = cliArgs.cleanup || false;
  const skipConfirmation = cliArgs.skipConfirmation || false;
  const startNew = cliArgs.startNew || false;
  const forceMode = cliArgs.force || false;
  const initMode = cliArgs.init || false;

  if (cliArgs.help) {
    console.log(`
Hankweave Runtime - Codon Orchestration

Usage: hankweave [hank-path] [data-path] [options]

Arguments:
  data-path                 Path to data file/directory, or "-" for stdin (default: cwd)
                            When only one argument provided:
                            - If ends with .json: treated as hank-path
                            - Otherwise: treated as data-path
  hank-path                Path to hank config, or remote Git URL (default: hank.json)
                            Remote URLs: https://github.com/user/repo#branch
                            Requires both arguments to specify custom hank path
Options:
  --init                    Initialize a new hank in current directory
  --config <path>           Path to hank configuration file (alternative to positional arg)
  --data <path>             Path to data file or directory, or "-" for stdin
  --input <text>            Use inline text as data input (highest priority)
  --execution <path>        Resume in specific execution directory
  --start-new               Start a new execution (don't resume existing)
                            - Creates directory if it doesn't exist
                            - Requires --force if directory has .hankweave/
  --force                   Force operation in directories with existing .hankweave/
                            - Backs up existing .hankweave.backup-{timestamp}
                            - Overwrites read_only_data_source link
  --copy                    Copy data instead of symlinking (for compatibility)
  --port <port>             WebSocket server port (default: 7777)
  --headless                Run without TUI (for CI/CD and scripts)
  --validate, -v            Validate configuration without creating directories
                            - Performs comprehensive preflight checks
                            - No filesystem side effects
  --cleanup                 Clean up execution directories
  -y                        Skip confirmation prompts
  --no-autostart            Don't automatically start codons
  --model <model>           Override model for all codons (ignores per-codon settings)
  --anthropic-base-url <url> Custom Anthropic API base URL
  --proxy                   Enable the LLM proxy server (disabled by default)
  --idle-timeout <seconds>  Idle timeout for WebSocket and proxy servers (0-255, default: 0)
  --help, -h                Show this help message

Execution Safety:
  Hankweave implements a three-tier safety system for execution directories:
  - Tier 1: Cannot use ~/.hankweave-executions/ directly (reserved for auto-managed)
  - Tier 2: Directories with existing .hankweave/ require --force (backs up existing)
  - Tier 3: Non-empty directories show warning and prompt for confirmation

Execution Isolation:
  Hankweave runs in an isolated execution directory separate from your data.
  This enables clean rollbacks and multiple execution tracking.

  Your data is accessed via: <execution-dir>/read_only_data_source/

Template Variables:
  <%EXECUTION_DIR%>  - The execution directory path
  <%DATA_DIR%>       - The data directory path (execution-dir/read_only_data_source)

Examples:
  # Run with default data (current directory)
  hankweave

  # Run with specific hank and data (positional args)
  hankweave ./my-hank.json ./my-data

  # Use inline text as input
  hankweave hank.json --input "Analyze this text"

  # Pipe from stdin
  echo "Design a REST API" | hankweave hank.json -

  # Pipe file contents to stdin
  cat spec.md | hankweave hank.json --data -

  # Run a hank from a GitHub repository
  hankweave https://github.com/user/repo ./my-data

  # Run a specific branch/tag from a remote repo
  hankweave https://github.com/user/repo#v1.0.0 ./my-data
  hankweave https://github.com/user/repo/tree/feature-branch ./my-data

  # Run in headless mode for CI/CD
  hankweave --headless

  # Override all codon models to use Opus
  hankweave --model opus
`);
    process.exit(0);
  }

  // Handle init mode
  if (initMode) {
    try {
      await initProject(process.cwd());
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Init failed: ${(error as Error).message}\n`);
      process.exit(1);
    }
  }

  // Ensure Claude SDK is available (unless we're in cleanup or validate mode)
  // this is a basic check for when we are running using en executable
  // more thorough checks happen during selftests
  if (!cleanupMode && !validateMode) {
    try {
      await ClaudeAgentSDKManager.ensureSdkAvailable();
    } catch (error) {
      console.error(`\n❌ ${(error as Error).message}\n`);
      process.exit(1);
    }
  }

  // Resolve data source path
  const originalCwd = process.cwd(); // Save original CWD

  // Determine resolved data path based on input mode
  let resolvedDataPath: string;
  let inputSourceType: "inline-text" | "stdin" | "path" = "path";

  if (inlineInput) {
    // Inline text provided via --input
    const tempFile = generateTempFilePath("input");
    await fs.promises.writeFile(tempFile, inlineInput);
    resolvedDataPath = tempFile;
    inputSourceType = "inline-text";
    console.log(`📝 Using inline text input (${inlineInput.length} chars)`);
  } else if (dataSourcePath === "-") {
    // stdin input
    try {
      const stdinContent = await readStdin();
      const tempFile = generateTempFilePath("stdin");
      await fs.promises.writeFile(tempFile, stdinContent);
      resolvedDataPath = tempFile;
      inputSourceType = "stdin";
      console.log(`📝 Using stdin input (${stdinContent.length} chars)`);
    } catch (error) {
      console.error(`❌ ${(error as Error).message}`);
      process.exit(1);
    }
  } else {
    // Normal path (existing behavior)
    resolvedDataPath = path.resolve(dataSourcePath || originalCwd);
  }

  // Resolve config path before execution setup (needed for hank hash)
  // Handle remote hanks (git URLs)
  let absoluteConfigPath: string;

  if (isRemoteHankUrl(configPath)) {
    console.log(`\n🌐 Fetching remote hank: ${configPath}`);

    try {
      const cached = await resolveRemoteHank(configPath);
      absoluteConfigPath = cached.hankPath;

      if (cached.wasFresh) {
        console.log(`  📦 Using cached version (fetched ${cached.cachedAt.toLocaleString()})`);
      } else {
        console.log(`  ✅ Cloned to cache`);
      }

      // Show hank summary (no confirmation needed - "power user" model)
      const parsed = await import("./remote-hank.js").then((m) => m.parseRemoteHankUrl(configPath));
      const summary = getHankSummary(absoluteConfigPath, configPath, parsed.ref);
      displayHankSummary(summary);
    } catch (error) {
      console.error(`\n❌ Failed to fetch remote hank: ${(error as Error).message}`);
      process.exit(1);
    }
  } else {
    absoluteConfigPath = path.isAbsolute(configPath)
      ? configPath
      : path.resolve(originalCwd, configPath);
  }

  // ========== VALIDATION MODE BRANCH ==========
  // This block must run BEFORE any execution setup to prevent directory creation
  if (validateMode) {
    try {
      await runValidation({
        dataPath: resolvedDataPath,
        configPath: absoluteConfigPath,
        executionPath: executionPath ? path.resolve(executionPath) : undefined,
        startNew,
      });
      process.exit(0);
    } catch (error) {
      console.error(`❌ Validation failed: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  // ========== NORMAL MODE BRANCH ==========
  // Only reaches here if NOT in validation mode

  // Set up execution environment
  let executionSetup: ExecutionSetup;
  try {
    executionSetup = await setupExecutionEnvironment({
      readOnlySourceDataPath: resolvedDataPath,
      executionPath: executionPath ? path.resolve(executionPath) : undefined,
      // For inline text and stdin, always copy (temp files shouldn't be symlinked)
      useSymlink: inputSourceType === "path" ? useSymlink : false,
      startNew,
      forceMode,
      skipConfirmation,
      hankPath: absoluteConfigPath,
    });
  } catch (error) {
    console.error(`❌ Execution setup failed: ${(error as Error).message}`);
    process.exit(1);
  }

  // Log input source type if not a regular path
  if (inputSourceType !== "path") {
    console.log(`📥 Input type: ${inputSourceType}`);
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
  // Config path already resolved above before execution setup

  // Resolve settings from all 5 config layers
  // (default config, runtime config, hank recommendations, env vars, CLI args)
  // Note: We're now in the execution directory, so hankweave.json will be
  // auto-discovered from process.cwd() if it exists
  const resolvedConfig = resolveSettings({
    cliArgs,
    hankPath: absoluteConfigPath,
  });

  // Initialize LLM Provider Registry singleton before ANY config parsing/validation
  // This must happen before validateHank() since Zod transforms use it for model validation
  const serverLogger = new Logger(path.join(executionSetup.executionPath, "model-validation.log"));
  LlmProviderRegistry.getInstance({
    logger: serverLogger,
    performHealthCheckOnInit: false,
  });

  try {
    // Normal server mode - validate config
    const { codons, warnings } = await validateHank(
      absoluteConfigPath,
      executionSetup.executionPath,
      serverLogger,
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
      // (default config, runtime config, hank recommendations, env vars, CLI args)
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

    const server = new HankweaveRuntime(serverConfig);
    await server.start();

    // TUI is now the default. Use --headless to disable.
    if (!headlessMode) {
      // Give server a moment to start before connecting
      setTimeout(() => {
        new BasicTUI(server);
      }, 100);
      console.log("🎮 Running in TUI mode (use --headless to disable)");
    }
  } catch (error) {
    console.error(
      `Failed to start server: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

// Run main if this is the main module
if (import.meta.main) {
  main();
}
