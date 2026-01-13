#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicTUI } from "./basic-tui.js";
import { ClaudeAgentSDKManager } from "./claude-agent-sdk-manager.js";
import { CleanupCommand } from "./cleanup-command.js";
import { resolveSettings, validateStrand } from "./config.js";
import type { ExecutionSetup } from "./execution-setup.js";
import { setupExecutionEnvironment } from "./execution-setup.js";
import { initProject } from "./init-command.js";
import { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import {
  displayStrandSummary,
  getStrandSummary,
  isRemoteStrandUrl,
  resolveRemoteStrand,
} from "./remote-strand.js";
import { StrandweaveRuntime } from "./strandweave-runtime.js";
import type { StrandweaveConfig } from "./types/types.js";
import { getMetadata, Logger } from "./utils.js";

// -------------
// Helper Functions
// -------------

/**
 * Read content from stdin.
 * Throws if stdin is a TTY (no piped input).
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('No input provided on stdin. Use: echo "text" | strandweave strand.json -');
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
    `strandweave-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
}

/**
 * Get value for a flag, supporting both --flag=value (deprecated) and --flag value syntax.
 * Returns undefined if flag is not present.
 */
function getFlagValue(args: string[], flagName: string): string | undefined {
  // Check for deprecated --flag=value syntax
  const equalsIndex = args.findIndex((arg) => arg.startsWith(`${flagName}=`));
  if (equalsIndex !== -1) {
    console.warn(
      `⚠️  Deprecation warning: '${args[equalsIndex]}' uses deprecated syntax. Use '${flagName} <value>' instead.`,
    );
    return args[equalsIndex].split("=")[1];
  }

  // Check for --flag value syntax
  const flagIndex = args.indexOf(flagName);
  if (flagIndex !== -1 && flagIndex + 1 < args.length) {
    const nextArg = args[flagIndex + 1];
    // Make sure next arg is not another flag
    if (!nextArg.startsWith("-")) {
      return nextArg;
    }
  }

  return undefined;
}

/**
 * Parse CLI arguments into a structured config object for resolveSettings()
 */
function parseCliArgs(args: string[]): Partial<StrandweaveConfig> {
  const cliArgs: Partial<StrandweaveConfig> = {};

  // Parse port
  const portArg = getFlagValue(args, "--port");
  if (portArg) {
    cliArgs.port = parseInt(portArg, 10);
  }

  // Parse model
  const modelArg = getFlagValue(args, "--model");
  if (modelArg) {
    cliArgs.model = modelArg as "sonnet" | "opus";
  }

  // Parse anthropicBaseUrl
  const baseUrlArg = getFlagValue(args, "--anthropic-base-url");
  if (baseUrlArg) {
    cliArgs.anthropicBaseUrl = baseUrlArg;
  }

  // Parse autostart (inverse of --no-autostart)
  if (args.includes("--no-autostart")) {
    cliArgs.autostart = false;
  }

  // Parse proxy flags (proxy is OFF by default)
  if (args.includes("--proxy")) {
    cliArgs.withoutProxy = false; // Enable proxy
  }
  // Keep --without-proxy for backward compatibility (now redundant since proxy is off by default)
  if (args.includes("--without-proxy")) {
    cliArgs.withoutProxy = true;
  }

  // Parse idleTimeout
  const idleTimeoutArg = getFlagValue(args, "--idle-timeout");
  if (idleTimeoutArg) {
    cliArgs.idleTimeout = parseInt(idleTimeoutArg, 10);
  }

  return cliArgs;
}

// -------------
// Main Entry Point
// -------------

async function main() {
  // Print version banner
  console.log(`\nStrandweave v${getMetadata().version}\n`);

  // Strict argument validation
  const rawArgs = process.argv.slice(2);

  // Flags that take no value
  const booleanFlags = new Set([
    "--headless",
    "--validate",
    "-v",
    "--cleanup",
    "-y",
    "--no-autostart",
    "--start-new",
    "--copy",
    "--proxy",
    "--without-proxy",
    "--init",
    "--help",
    "-h",
    "--force",
  ]);

  // Flags that take a value (support both --flag=value and --flag value)
  const valueFlags = new Set([
    "--config",
    "--data",
    "--execution",
    "--anthropic-base-url",
    "--port",
    "--model",
    "--idle-timeout",
    "--input",
  ]);

  // Validate arguments
  let i = 0;
  const positionalArgs: string[] = [];
  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (arg.startsWith("-")) {
      // Check for --flag=value syntax
      const equalsIndex = arg.indexOf("=");
      const flagName = equalsIndex > 0 ? arg.substring(0, equalsIndex) : arg;

      if (booleanFlags.has(flagName)) {
        if (equalsIndex > 0) {
          console.error(`❌ Error: Flag '${flagName}' does not take a value.`);
          process.exit(1);
        }
        i++;
      } else if (valueFlags.has(flagName)) {
        if (equalsIndex > 0) {
          // --flag=value syntax (deprecated but supported)
          i++;
        } else {
          // --flag value syntax
          if (i + 1 >= rawArgs.length || rawArgs[i + 1].startsWith("-")) {
            console.error(`❌ Error: Flag '${flagName}' requires a value.`);
            process.exit(1);
          }
          i += 2; // Skip flag and value
        }
      } else {
        console.error(
          `❌ Error: Unknown argument '${arg}'. Run with --help for available options.`,
        );
        process.exit(1);
      }
    } else {
      // Positional argument
      positionalArgs.push(arg);
      i++;
    }
  }

  // Validate positional args count
  if (positionalArgs.length > 2) {
    console.error(
      `❌ Error: Too many positional arguments. Expected at most 2 (strand-path, data-path), got ${positionalArgs.length}.`,
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);

  // Parse config path: positional[0] or --config flag, default to "strand.json"
  const configPath = positionalArgs[0] || getFlagValue(args, "--config") || "strand.json";

  // Parse data path: positional[1] or --data flag
  const dataSourcePath = positionalArgs[1] || getFlagValue(args, "--data");

  // Parse execution path
  const executionPath = getFlagValue(args, "--execution");

  const useSymlink = !args.includes("--copy");

  // TUI is now the default! Use --headless to disable
  const headlessMode = args.includes("--headless");

  const validateMode = args.includes("--validate") || args.includes("-v");
  const cleanupMode = args.includes("--cleanup");
  const skipConfirmation = args.includes("-y");
  const startNew = args.includes("--start-new");
  const forceMode = args.includes("--force");
  const initMode = args.includes("--init");
  // Note: Config-related args (port, model, anthropicBaseUrl, autostart, withoutProxy)
  // are now parsed by parseCliArgs() and handled by resolveSettings()

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Strandweave Runtime - Codon Orchestration

Usage: strandweave [strand-path] [data-path] [options]

Arguments:
  strand-path               Path to strand config, or remote Git URL (default: strand.json)
                            Remote URLs: https://github.com/user/repo#branch
  data-path                 Path to data file/directory, or "-" for stdin (default: cwd)

Options:
  --init                    Initialize a new strand in current directory
  --config <path>           Path to strand configuration file (alternative to positional arg)
  --data <path>             Path to data file or directory, or "-" for stdin
  --input <text>            Use inline text as data input (highest priority)
  --execution <path>        Resume in specific execution directory
  --start-new               Start a new execution (creates or reuses directory)
  --force                   Force operation in directories with existing .strandweave/
  --copy                    Copy data instead of symlinking (for compatibility)
  --port <port>             WebSocket server port (default: 7777)
  --headless                Run without TUI (for CI/CD and scripts)
  --validate, -v            Validate configuration without running
  --cleanup                 Clean up execution directories
  -y                        Skip confirmation prompts
  --no-autostart            Don't automatically start codons
  --model <model>           Override model for all codons (ignores per-codon settings)
  --anthropic-base-url <url> Custom Anthropic API base URL
  --proxy                   Enable the LLM proxy server (disabled by default)
  --idle-timeout <seconds>  Idle timeout for WebSocket and proxy servers (0-255, default: 0)
  --help, -h                Show this help message

Execution Safety:
  Strandweave implements a three-tier safety system for execution directories:
  - Tier 1: Cannot use ~/.strandweave-executions/ directly (reserved for auto-managed)
  - Tier 2: Directories with existing .strandweave/ require --force (backs up existing)
  - Tier 3: Non-empty directories show warning and prompt for confirmation

Execution Isolation:
  Strandweave runs in an isolated execution directory separate from your data.
  This enables clean rollbacks and multiple execution tracking.

  Your data is accessed via: <execution-dir>/read_only_data_source/

Template Variables:
  <%EXECUTION_DIR%>  - The execution directory path
  <%DATA_DIR%>       - The data directory path (execution-dir/read_only_data_source)

Examples:
  # Run with default data (current directory)
  strandweave

  # Run with specific strand and data (positional args)
  strandweave ./my-strand.json ./my-data

  # Use inline text as input
  strandweave strand.json --input "Analyze this text"

  # Pipe from stdin
  echo "Design a REST API" | strandweave strand.json -

  # Pipe file contents to stdin
  cat spec.md | strandweave strand.json --data -

  # Run a strand from a GitHub repository
  strandweave https://github.com/user/repo ./my-data

  # Run a specific branch/tag from a remote repo
  strandweave https://github.com/user/repo#v1.0.0 ./my-data
  strandweave https://github.com/user/repo/tree/feature-branch ./my-data

  # Run in headless mode for CI/CD
  strandweave --headless

  # Override all codon models to use Opus
  strandweave --model opus
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

  // Parse --input flag for inline text
  const inlineInput = getFlagValue(args, "--input");

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

  // Resolve config path before execution setup (needed for strand hash)
  // Handle remote strands (git URLs)
  let absoluteConfigPath: string;

  if (isRemoteStrandUrl(configPath)) {
    console.log(`\n🌐 Fetching remote strand: ${configPath}`);

    try {
      const cached = await resolveRemoteStrand(configPath);
      absoluteConfigPath = cached.strandPath;

      if (cached.wasFresh) {
        console.log(`  📦 Using cached version (fetched ${cached.cachedAt.toLocaleString()})`);
      } else {
        console.log(`  ✅ Cloned to cache`);
      }

      // Show strand summary (no confirmation needed - "power user" model)
      const parsed = await import("./remote-strand.js").then((m) =>
        m.parseRemoteStrandUrl(configPath),
      );
      const summary = getStrandSummary(absoluteConfigPath, configPath, parsed.ref);
      displayStrandSummary(summary);
    } catch (error) {
      console.error(`\n❌ Failed to fetch remote strand: ${(error as Error).message}`);
      process.exit(1);
    }
  } else {
    absoluteConfigPath = path.isAbsolute(configPath)
      ? configPath
      : path.resolve(originalCwd, configPath);
  }

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
      strandPath: absoluteConfigPath,
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

  // Initialize LLM Provider Registry singleton before ANY config parsing/validation
  // This must happen before validateStrand() since Zod transforms use it for model validation
  const validationLogger = new Logger(
    path.join(executionSetup.executionPath, "model-validation.log"),
  );
  LlmProviderRegistry.getInstance({
    logger: validationLogger,
    performHealthCheckOnInit: false,
  });

  try {
    // Validation mode
    if (validateMode) {
      console.log(`\n🔍 Validating configuration: ${absoluteConfigPath}\n`);

      const validationResult = await validateStrand(
        absoluteConfigPath,
        executionSetup.executionPath, // Changed from readOnlySourceData
        validationLogger,
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
      validationLogger,
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
