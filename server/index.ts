#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicTUI } from "./basic-tui.js";
import { ClaudeAgentSDKManager } from "./claude-agent-sdk-manager.js";
import { CleanupCommand } from "./cleanup-command.js";
import { parseCliArgs, showDeprecationWarnings } from "./cli-parser.js";
import { ensureSchemaUrl, resolveSettings, validateHank } from "./config.js";
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
import {
  getMetadata,
  Logger,
  renderStartupBanner,
  renderStartupInfo,
  type StartupInfo,
} from "./utils.js";
import { renderHankStructure } from "./validate-ascii.js";
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
 * Get a stable, content-based file path for inline/stdin input.
 * This ensures the same input content produces the same data hash across runs,
 * enabling proper resume functionality with --execution.
 *
 * The path is deterministic based on content hash, stored in ~/.hankweave-cache/inputs/
 * to persist across runs. If the file already exists, we reuse it (preserving mtime)
 * which keeps the data hash stable.
 */
async function getStableInputPath(content: string, type: "input" | "stdin"): Promise<string> {
  const contentHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  const cacheDir = path.join(os.homedir(), ".hankweave-cache", "inputs");

  // Ensure cache directory exists
  await fs.promises.mkdir(cacheDir, { recursive: true });

  const filePath = path.join(cacheDir, `${type}-${contentHash}.txt`);

  // Only write if file doesn't exist (preserves mtime for stable hashing)
  if (!fs.existsSync(filePath)) {
    await fs.promises.writeFile(filePath, content);
  }

  return filePath;
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

  // Show deprecation warnings for old flags (before any other output)
  showDeprecationWarnings(cliArgs);

  // Print startup banner
  renderStartupBanner();

  // Extract values with defaults
  // Note: configPath is resolved later with directory-aware logic
  const dataSourcePath = cliArgs.dataPath || cliArgs.dataFlag;
  const executionPath = cliArgs.executionPath;
  const inlineInput = cliArgs.inputText;
  const outputPath = cliArgs.outputPath; // --output flag

  const useSymlink = !cliArgs.copy;
  const headlessMode = cliArgs.headless || false;
  const validateMode = cliArgs.validate || false;
  const cleanupMode = cliArgs.cleanup || false;
  const skipConfirmation = cliArgs.skipConfirmation || false;
  const startNew = cliArgs.startNew || false;
  const forceMode = cliArgs.force || false;
  const initMode = cliArgs.init || false;
  // --ignore-data-mismatch is deprecated, --force now handles this too
  const ignoreDataMismatch = cliArgs.ignoreDataMismatch || false;

  if (cliArgs.help) {
    console.log(`
Hankweave Runtime - Codon Orchestration

Usage: hankweave [options] [config-or-data-path]

Arguments:
  config-or-data-path       Path to hank.json or project directory
                            When only one argument provided:
                            - If ends with .json: treated as hank-path
                            - Otherwise: treated as data-path

Execution Control:
  -e, --execution <path>    Use specific execution directory
                            Creates if doesn't exist, resumes if has state
  -n, --new, --start-new    Start new execution, never resume
                            Use -n -f to overwrite existing state
  -f, --force               Override safety checks (hash mismatch, existing state)
  -y                        Non-interactive mode, skip confirmation prompts

Output:
  -o, --output <path>       Copy outputs to this path (default: stay in execution dir)

Configuration:
  --config <path>           Path to hank.json (alternative to positional arg)
  --data <path>             Path to data source (default: config directory)
  -i, --input <text>        Use inline text as data input (highest priority)
  -m, --model <model>       Model override (sonnet|opus|gemini-flash|etc)

Server:
  -p, --port <port>         WebSocket server port (default: auto-select free port)
  --headless                Run without TUI (for CI/CD and scripts)
  --no-autostart            Don't automatically start codons
  --proxy                   Enable the LLM proxy server (disabled by default)
  --anthropic-base-url <url> Custom Anthropic API base URL
  --idle-timeout <seconds>  Idle timeout for WebSocket and proxy servers (0-255, default: 0)

Other:
  --init                    Initialize a new hank in current directory
  -v, --validate            Validate configuration without running
  --cleanup                 Remove execution artifacts
  --copy                    Copy data instead of symlinking (for compatibility)
  --ignore-rig-failures     Ignore rig setup failures
  --attach                  Connect TUI to an already-running server (read-only mode)
  -h, --help                Show this help
  --version                 Show version

Execution Safety:
  Hankweave implements a three-tier safety system for execution directories:
  - Tier 1: Cannot use ~/.hankweave-executions/ directly (reserved for auto-managed)
  - Tier 2: Directories with existing .hankweave/ require --force (backs up existing)
  - Tier 3: Non-empty directories show warning and prompt for confirmation

Examples:
  hankweave                           Run with hank.json in current directory
  hankweave ./my-project              Run project, resume if possible
  hankweave ./my-project -n           Start fresh execution (--new)
  hankweave -e ./my-exec              Use specific execution directory
  hankweave -o ./results              Copy outputs to ./results
  hankweave -m opus -p 8080           Use opus model on port 8080

Outputs are stored in ~/.hankweave-executions/{id}/outputs/ by default.
Use --output to copy them elsewhere.
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

  // Handle attach mode - connect to existing server
  if (cliArgs.attach) {
    let port: number;

    if (cliArgs.port !== undefined) {
      // Explicit --port takes precedence
      port = cliArgs.port;
    } else if (cliArgs.executionPath) {
      // Try to read port from lock file
      const lockPath = path.join(cliArgs.executionPath, ".hankweave", "runtime.lock");
      try {
        const lockContent = await fs.promises.readFile(lockPath, "utf-8");
        const lockData = JSON.parse(lockContent);
        // NOTE: Use !== undefined for port (port 0 is valid but falsy)
        port = lockData.port !== undefined ? lockData.port : 7777;
        console.log(`📁 Read port ${port} from lock file: ${lockPath}`);
      } catch {
        console.error(`❌ Could not read lock file: ${lockPath}`);
        console.error("   Use --port to specify the server port directly.");
        process.exit(1);
      }
    } else {
      // Default to standard port
      port = 7777;
    }

    console.log(`🔌 Attaching to server on port ${port}...`);
    new BasicTUI({ port });
    // Don't exit - let the TUI run
    return;
  }

  // Ensure Claude SDK is available (unless we're in cleanup or validate mode)
  // this is a basic check for when we are running using an executable
  // more thorough checks happen during selftests
  let claudeSdkInfo: { version: string; cached: boolean } | null = null;
  if (!cleanupMode && !validateMode) {
    try {
      const sdkResult = await ClaudeAgentSDKManager.ensureSdkAvailable();
      claudeSdkInfo = { version: sdkResult.version, cached: sdkResult.cached };
    } catch (error) {
      console.error(`\n❌ ${(error as Error).message}\n`);
      if (error instanceof Error && error.stack) {
        console.error(`Stack: ${error.stack}`);
      }
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
    // Use stable content-based path for consistent data hashing across runs
    resolvedDataPath = await getStableInputPath(inlineInput, "input");
    inputSourceType = "inline-text";
    console.log(`📝 Using inline text input (${inlineInput.length} chars)`);
  } else if (dataSourcePath === "-") {
    // stdin input
    try {
      const stdinContent = await readStdin();
      // Use stable content-based path for consistent data hashing across runs
      resolvedDataPath = await getStableInputPath(stdinContent, "stdin");
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

  // Directory-aware config path resolution
  // Priority order:
  // 1. Explicit --hank/--config flag (if directory, append /hank.json)
  // 2. Data directory discovery (if data path is dir with hank.json and no explicit config)
  // 3. Default to ./hank.json
  let resolvedConfigPath = cliArgs.hankPath || cliArgs.configPath;

  // If explicit hank path is a directory, look for hank.json inside
  if (resolvedConfigPath && !isRemoteHankUrl(resolvedConfigPath)) {
    const absolutePath = path.isAbsolute(resolvedConfigPath)
      ? resolvedConfigPath
      : path.resolve(originalCwd, resolvedConfigPath);
    try {
      const stats = await fs.promises.stat(absolutePath);
      if (stats.isDirectory()) {
        resolvedConfigPath = path.join(absolutePath, "hank.json");
        console.log(`📁 Using hank.json from directory: ${resolvedConfigPath}`);
      }
    } catch {
      // Path doesn't exist yet, let it fail later with proper error message
    }
  }

  // If no explicit hank path and data path is a directory containing hank.json, use it
  if (!resolvedConfigPath && resolvedDataPath && inputSourceType === "path") {
    try {
      const stats = await fs.promises.stat(resolvedDataPath);
      if (stats.isDirectory()) {
        const potentialConfig = path.join(resolvedDataPath, "hank.json");
        if (fs.existsSync(potentialConfig)) {
          resolvedConfigPath = potentialConfig;
          console.log(`📁 Found hank.json in data directory: ${resolvedConfigPath}`);
        }
      }
    } catch {
      // Path doesn't exist or can't be accessed, continue with default
    }
  }

  // Default to hank.json in current directory
  const configPath = resolvedConfigPath || "hank.json";

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

  // Resolve settings from all 5 config layers EARLY
  // (default config, runtime config, hank overrides, env vars, CLI args)
  // This needs to happen before validation mode so we have the resolved model
  const resolvedConfig = resolveSettings({
    cliArgs,
    hankPath: absoluteConfigPath,
  });

  // ========== VALIDATION MODE BRANCH ==========
  // This block must run BEFORE any execution setup to prevent directory creation
  if (validateMode) {
    try {
      await runValidation({
        dataPath: resolvedDataPath,
        configPath: absoluteConfigPath,
        executionPath: executionPath ? path.resolve(executionPath) : undefined,
        startNew,
        modelOverride: resolvedConfig.model, // Pass resolved model override (from all config layers)
      });
      process.exit(0);
    } catch (error) {
      // Format validation errors with breathing room
      const errorMessage = (error as Error).message;
      const errorLines = errorMessage.split("\n");

      if (errorLines.length > 1) {
        // Multi-line error - add spacing and formatting
        console.error(`\n❌ Validation failed:\n`);
        console.error(`   ${errorLines[0]}\n`); // Header line

        // Add indentation and spacing for each error
        for (let i = 1; i < errorLines.length; i++) {
          const line = errorLines[i].trim();
          if (line) {
            console.error(`   • ${line}\n`);
          }
        }
      } else {
        // Single-line error
        console.error(`\n❌ Validation failed: ${errorMessage}\n`);
      }
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
      ignoreDataMismatch,
    });
  } catch (error) {
    console.error("[ERROR] Execution setup failed!");
    console.error(`❌ Execution setup failed: ${(error as Error).message}`);
    process.exit(1);
  }

  // Display grouped startup info
  const executionId = path.basename(executionSetup.executionPath);
  const sdks: StartupInfo["sdks"] = [];
  if (claudeSdkInfo) {
    sdks.push({
      name: "Claude",
      version: claudeSdkInfo.version,
      cached: claudeSdkInfo.cached,
    });
  }

  renderStartupInfo({
    executionId,
    isResuming: executionSetup.isResuming,
    sourcePath: executionSetup.readOnlySourceDataPath,
    executionPath: executionSetup.executionPath,
    linkType: executionSetup.linkType,
    sdks,
  });

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
  // Settings were already resolved earlier (before validation mode check)

  // Display model override message if model is set from any config layer
  if (resolvedConfig.model) {
    console.log(`⚙️  Using global model override: ${resolvedConfig.model} (applies to all codons)`);
  }

  // Initialize LLM Provider Registry singleton before ANY config parsing/validation
  // This must happen before validateHank() since Zod transforms use it for model validation
  const serverLogger = new Logger(path.join(executionSetup.executionPath, "model-validation.log"));
  LlmProviderRegistry.getInstance({
    logger: serverLogger,
    performHealthCheckOnInit: false,
  });

  // Auto-add $schema for editor support if missing
  const schemaAdded = ensureSchemaUrl(absoluteConfigPath);
  if (schemaAdded) {
    console.log(`✨ Added $schema to ${path.basename(absoluteConfigPath)} for editor support`);
  }

  try {
    // Normal server mode - validate config
    const validationResult = await validateHank({
      configPath: absoluteConfigPath,
      executionPath: executionSetup.executionPath,
      logger: serverLogger,
      modelOverride: resolvedConfig.model, // Use resolved model from all config layers
    });

    const { codons, globalSystemPrompt, warnings } = validationResult;

    // Display ASCII structure visualization before execution
    const terminalWidth =
      process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : 80;

    const structure = renderHankStructure(codons, {
      terminalWidth,
      hankMeta: validationResult.hankMeta,
      hasGlobalSystemPrompt: globalSystemPrompt !== null,
      configPath: absoluteConfigPath,
      promptLineCounts: validationResult.promptLineCounts,
    });

    console.log(structure);
    console.log("");

    // Log any non-fatal warnings
    if (warnings.length > 0) {
      console.log("⚠️  Configuration warnings:");
      for (const warning of warnings) {
        console.log(`  - ${warning}`);
      }
      console.log();
    }

    // Create server configuration by merging all config layers with execution properties
    const serverConfig = {
      // Start with resolved config from all 5 layers
      // (default config, runtime config, hank overrides, env vars, CLI args)
      ...resolvedConfig,

      // Override with execution-specific properties (these are not part of the config system)
      cwd: originalCwd,
      configPath: absoluteConfigPath,
      readOnlySourceDataPath: executionSetup.readOnlySourceDataPath,
      executionPath: executionSetup.executionPath,
      agentRootPath: executionSetup.agentRootPath,
      rigArchivePath: executionSetup.rigArchivePath,
      dataPathInExecutionDir: executionSetup.dataPathInExecutionDir,
      dataHash: executionSetup.dataHash,
      isNewExecution: executionSetup.isNewExecution,
      isResuming: executionSetup.isResuming,
      linkType: executionSetup.linkType,

      // Output directory: CLI flag takes precedence, then resolved config
      // If neither is set, outputDirectory remains undefined (outputs stay in execution dir)
      outputDirectory: outputPath || resolvedConfig.outputDirectory,

      // Required: codons from validation
      codons,

      // Optional: global system prompt (ENG-122)
      globalSystemPrompt,
    };

    // Preflight warning for potential output file conflicts
    if (serverConfig.outputDirectory) {
      const fullOutputPath = path.join(originalCwd, serverConfig.outputDirectory);
      try {
        if (fs.existsSync(fullOutputPath)) {
          const contents = fs.readdirSync(fullOutputPath);
          if (contents.length > 0) {
            console.log(
              `⚠️  Output directory '${serverConfig.outputDirectory}' is not empty. ` +
                `Conflicting files will be renamed (e.g., file.txt -> file_1_<timestamp>.txt).`,
            );
          }
        }
      } catch (_error) {
        // Directory doesn't exist yet or can't be read - no warning needed
        // The directory will be created during copy
      }
    }

    const server = new HankweaveRuntime(serverConfig);
    const actualPort = await server.start();

    // In headless mode, trigger autostart without waiting for client
    if (headlessMode) {
      console.log(`Running in headless mode on port ${actualPort}`);
      if (serverConfig.autostart !== false) {
        server.requestAutostart().catch((err) => {
          console.error(`[FATAL] Headless autostart failed: ${err}`);
          process.exit(1);
        });
      } else {
        console.log("Autostart disabled, waiting for WebSocket commands...");
      }
    } else {
      // TUI is the default. Use --headless to disable.
      // Give server a moment to start before connecting
      setTimeout(() => {
        new BasicTUI(server);
      }, 100);
      console.log("🎮 Running in TUI mode (use --headless to disable)");
    }
  } catch (error) {
    console.error("[ERROR] Server startup failed!");
    console.error(`Error message: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(`Stack trace:\n${error.stack}`);
    }
    if (error instanceof Error && "cause" in error && error.cause) {
      console.error(`Cause: ${error.cause}`);
    }
    process.exit(1);
  }
}

// Run main if this is the main module
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(`Stack:\n${error.stack}`);
    }
    process.exit(1);
  }
}
