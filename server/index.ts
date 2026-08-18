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
import { checkRegularFile } from "./fs-guards.js";
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
  getOrCreateClientId,
  resolveTelemetryConfig,
  showFirstRunNotice,
  TelemetryCollector,
  type TelemetryEventName,
} from "./telemetry/index.js";
import {
  getMetadata,
  Logger,
  renderStartupBanner,
  renderStartupInfo,
  type StartupInfo,
} from "./utils.js";
import { renderHankStructure } from "./validate-ascii.js";
import { renderBudgetResolutionTable } from "./validate-budget.js";
import { runValidation } from "./validate-command.js";
import { runWelcomeWizard } from "./wizard/welcome-wizard.js";

// -------------
// Helper Functions
// -------------

/**
 * Read the raw telemetry section of hankweave.json in the given directory.
 *
 * Deliberately bypasses the validating loader: resolveSettings strips the
 * telemetry field (HankweaveConfig omits it), and telemetry must never block
 * startup on a broken config. Never throws — any problem (missing file,
 * non-regular file such as a FIFO that would block readFileSync, bad JSON)
 * yields undefined.
 */
function readFileTelemetryConfig(dir: string): Parameters<typeof resolveTelemetryConfig>[0] {
  try {
    const runtimeConfigPath = path.join(dir, "hankweave.json");
    if (checkRegularFile(runtimeConfigPath, { read: false })) {
      return undefined;
    }
    const raw = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf-8"));
    return raw?.telemetry;
  } catch {
    // Silent fail - config is optional
    return undefined;
  }
}

/**
 * Fire-and-forget CLI telemetry event.
 * Used in early-exit paths (--init, --validate, --cleanup, --help)
 * where the full telemetry system isn't initialized.
 *
 * Reads hankweave.json from cwd to respect file-level telemetry opt-out,
 * matching the behavior of the full runtime path.
 */
async function sendCliTelemetry(
  event: TelemetryEventName,
  properties: Record<string, unknown>,
): Promise<void> {
  try {
    const telemetryConfig = resolveTelemetryConfig(readFileTelemetryConfig(process.cwd()));
    if (!telemetryConfig.enabled) return;
    const clientId = await getOrCreateClientId();
    const collector = new TelemetryCollector(telemetryConfig, clientId, false);
    await collector.trackCliEvent(event, properties);
    await collector.shutdown();
  } catch {
    // Silent fail - CLI telemetry should never block
  }
}

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
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }

  // Handle version flag - print version and exit
  if (cliArgs.showVersion) {
    console.log(getMetadata().version);
    process.exit(0);
  }

  // Show deprecation warnings for old flags (before any other output)
  showDeprecationWarnings(cliArgs);

  // ========== WELCOME WIZARD ==========
  // Detect "bare bones" invocation: no args, no flags.
  // This is the "I just heard about this and want to try it" entry point.
  const isBareBones =
    !cliArgs.hankPath &&
    !cliArgs.configPath &&
    !cliArgs.dataPath &&
    !cliArgs.dataFlag &&
    !cliArgs.executionPath &&
    !cliArgs.inputText &&
    !cliArgs.init &&
    !cliArgs.help &&
    !cliArgs.showVersion &&
    !cliArgs.validate &&
    !cliArgs.cleanup &&
    !cliArgs.attach &&
    !cliArgs.headless &&
    !cliArgs.replayDir;

  if (isBareBones) {
    try {
      await runWelcomeWizard();
      await sendCliTelemetry("cli_init", { source: "wizard" });
    } catch (error) {
      // If the wizard fails for any reason, don't crash - fall through to normal help
      console.error(`\nWizard error: ${(error as Error).message}\n`);
    }
    process.exit(0);
  }

  // Print startup banner
  renderStartupBanner();

  // Extract values with defaults
  // Note: configPath is resolved later with directory-aware logic
  const dataSourcePath = cliArgs.dataPath || cliArgs.dataFlag;
  let executionPath = cliArgs.executionPath;
  const inlineInput = cliArgs.inputText;
  const outputPath = cliArgs.outputPath; // --output flag

  const useSymlink = !cliArgs.copy;
  const headlessMode = cliArgs.headless || false;
  const validateMode = cliArgs.validate || false;
  const cleanupMode = cliArgs.cleanup || false;
  const skipConfirmation = cliArgs.skipConfirmation || false;
  const startNew = cliArgs.startNew || false;
  const forceMode = cliArgs.force || false;
  const noWipe = cliArgs.noWipe || false;
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
  --no-wipe                 With --start-new --force, preserve the existing
                            agentRoot/ workspace instead of wiping it
  -y                        Non-interactive mode, skip confirmation prompts

Output:
  -o, --output <path>       Copy outputs to this path (default: stay in execution dir)
  --overwrite-output        Overwrite existing output files instead of renaming

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
  --shim-idle-timeout <seconds>   Harness idle timeout in seconds (default: 120, per-codon)

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

Outputs are stored in the agent workspace (~/.hankweave-executions/{id}/agentRoot) by default.
Use --output to copy them elsewhere.
`);
    await sendCliTelemetry("cli_help", {});
    process.exit(0);
  }

  // Handle init mode
  if (initMode) {
    try {
      await initProject(process.cwd());
      await sendCliTelemetry("cli_init", { success: true });
      process.exit(0);
    } catch (error) {
      await sendCliTelemetry("cli_init", { success: false });
      console.error(`\nInit failed: ${(error as Error).message}\n`);
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
        console.log(`> Read port ${port} from lock file: ${lockPath}`);
      } catch {
        console.error(`Error: Could not read lock file: ${lockPath}`);
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
      console.error(`\nError: ${(error as Error).message}\n`);
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
    console.log(`> Using inline text input (${inlineInput.length} chars)`);
  } else if (dataSourcePath === "-") {
    // stdin input
    try {
      const stdinContent = await readStdin();
      // Use stable content-based path for consistent data hashing across runs
      resolvedDataPath = await getStableInputPath(stdinContent, "stdin");
      inputSourceType = "stdin";
      console.log(`> Using stdin input (${stdinContent.length} chars)`);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  } else {
    // Normal path (existing behavior)
    resolvedDataPath = path.resolve(dataSourcePath || originalCwd);
  }

  // When resuming an existing execution without explicit --data,
  // use the data source path stored in execution metadata.
  // This prevents hash mismatches when CWD differs from original creation dir.
  if (executionPath && !dataSourcePath && !inlineInput && inputSourceType === "path") {
    const execMetaPath = path.join(
      path.resolve(executionPath),
      ".hankweave",
      "execution-meta.json",
    );
    if (fs.existsSync(execMetaPath)) {
      try {
        const execMeta = JSON.parse(fs.readFileSync(execMetaPath, "utf-8"));
        if (execMeta.readOnlySourceDataPath && fs.existsSync(execMeta.readOnlySourceDataPath)) {
          resolvedDataPath = execMeta.readOnlySourceDataPath;
          console.log(`> Using data source from execution metadata: ${resolvedDataPath}`);
        }
      } catch {
        // Non-fatal — fall through to CWD-based resolution
      }
    }
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
        console.log(`> Using hank.json from directory: ${resolvedConfigPath}`);
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
          console.log(`> Found hank.json in data directory: ${resolvedConfigPath}`);
        }
      }
    } catch {
      // Path doesn't exist or can't be accessed, continue with default
    }
  }

  // In replay mode, auto-discover hank config and data paths from execution
  // metadata when the user didn't explicitly provide them. This makes
  // `--replay <dir>` self-contained — no need to separately locate the
  // original hank.json or data source.
  if (cliArgs.replayDir) {
    const replayMetaPath = path.join(
      path.resolve(cliArgs.replayDir),
      ".hankweave",
      "execution-meta.json",
    );
    if (fs.existsSync(replayMetaPath)) {
      try {
        const replayMeta = JSON.parse(fs.readFileSync(replayMetaPath, "utf-8"));

        if (!resolvedConfigPath && replayMeta.hankPath) {
          resolvedConfigPath = replayMeta.hankPath;
          console.log(`[REPLAY] Using hank config from execution metadata: ${resolvedConfigPath}`);
        }

        if (!dataSourcePath && !inlineInput && replayMeta.readOnlySourceDataPath) {
          resolvedDataPath = replayMeta.readOnlySourceDataPath;
          console.log(`[REPLAY] Using data source from execution metadata: ${resolvedDataPath}`);
        }
      } catch {
        // Non-fatal — user can still provide --config and --data explicitly
      }
    }
  }

  // Default to hank.json in current directory
  const configPath = resolvedConfigPath || "hank.json";

  // Resolve config path before execution setup (needed for hank hash)
  // Handle remote hanks (git URLs)
  let absoluteConfigPath: string;

  if (isRemoteHankUrl(configPath)) {
    console.log(`\n> Fetching remote hank: ${configPath}`);

    try {
      const cached = await resolveRemoteHank(configPath);
      absoluteConfigPath = cached.hankPath;

      if (cached.wasFresh) {
        console.log(`  > Using cached version (fetched ${cached.cachedAt.toLocaleString()})`);
      } else {
        console.log(`  ✓ Cloned to cache`);
      }

      // Show hank summary (no confirmation needed - "power user" model)
      // Use resolvedRef from the cache result (handles slashed branch names correctly)
      const displayRef =
        cached.resolvedRef ??
        (await import("./remote-hank.js").then((m) => m.parseRemoteHankUrl(configPath))).ref;
      const summary = getHankSummary(absoluteConfigPath, configPath, displayRef);
      displayHankSummary(summary);
    } catch (error) {
      console.error(`\nError: Failed to fetch remote hank: ${(error as Error).message}`);
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
        originalUrl: isRemoteHankUrl(configPath) ? configPath : undefined,
        resolvedBudget: resolvedConfig.budget,
      });
      await sendCliTelemetry("cli_validate", {
        success: true,
        error_count: 0,
        warning_count: 0,
      });
      process.exit(0);
    } catch (error) {
      await sendCliTelemetry("cli_validate", {
        success: false,
        error_count: 1,
      });
      // Format validation errors with breathing room
      const errorMessage = (error as Error).message;
      const errorLines = errorMessage.split("\n");

      if (errorLines.length > 1) {
        // Multi-line error - add spacing and formatting
        console.error(`\nValidation failed:\n`);
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
        console.error(`\nValidation failed: ${errorMessage}\n`);
      }
      process.exit(1);
    }
  }

  // ========== REPLAY MODE: copy execution directory ==========
  // --replay and --execution are mutually exclusive
  if (resolvedConfig.replayDir && executionPath) {
    console.error("Error: --replay and --execution cannot be used together.");
    process.exit(1);
  }

  // When --replay is used, copy the replay dir to a temp location
  // so the original execution directory is preserved as a read-only artifact.
  if (resolvedConfig.replayDir) {
    const replaySourceDir = path.resolve(resolvedConfig.replayDir);
    const tempExecDir = path.join(
      os.tmpdir(),
      `hankweave-replay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    try {
      fs.cpSync(replaySourceDir, tempExecDir, { recursive: true });
    } catch (error) {
      console.error(
        `Failed to copy replay directory "${replaySourceDir}": ${(error as Error).message}`,
      );
      process.exit(1);
    }
    // Remove copied runtime lock so a live source run doesn't block replay startup
    const copiedLock = path.join(tempExecDir, ".hankweave", "runtime.lock");
    if (fs.existsSync(copiedLock)) {
      fs.unlinkSync(copiedLock);
    }
    executionPath = tempExecDir;
    process.on("exit", () => {
      try {
        fs.rmSync(tempExecDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    });
    console.log(`[REPLAY] Copied execution dir to ${tempExecDir}`);
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
      ignoreDataMismatch: ignoreDataMismatch || !!resolvedConfig.replayDir,
      noWipe,
    });
  } catch (error) {
    console.error("[ERROR] Execution setup failed!");
    console.error(`Error: Execution setup failed: ${(error as Error).message}`);
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
      await sendCliTelemetry("cli_cleanup", { success: result.success });
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      await sendCliTelemetry("cli_cleanup", { success: false });
      console.error(`\nError: Cleanup failed: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  // Load and validate configuration
  // Config path already resolved above before execution setup
  // Settings were already resolved earlier (before validation mode check)

  // Display model override message if model is set from any config layer
  if (resolvedConfig.model) {
    console.log(`> Using global model override: ${resolvedConfig.model} (applies to all codons)`);
  }

  // Apply HANKWEAVE_*=unset to process.env BEFORE provider initialization.
  // This ensures sentinel providers (which use AI SDK in-process) don't inherit
  // proxy URLs that break health checks. Child process stripping (in
  // claude-agent-sdk-manager.ts and pi-sdk-manager.ts) still handles
  // codon agents separately.
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("HANKWEAVE_") &&
      !key.startsWith("HANKWEAVE_RUNTIME_") &&
      !key.startsWith("HANKWEAVE_SENTINEL_") &&
      value === "unset"
    ) {
      const targetKey = key.substring("HANKWEAVE_".length);
      if (process.env[targetKey]) {
        delete process.env[targetKey];
        console.log(`> Stripped ${targetKey} from process environment (${key}=unset)`);
      }
    }
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
    console.log(`+ Added $schema to ${path.basename(absoluteConfigPath)} for editor support`);
  }

  try {
    // Normal server mode - validate config
    const validationResult = await validateHank({
      configPath: absoluteConfigPath,
      executionPath: executionSetup.executionPath,
      logger: serverLogger,
      modelOverride: resolvedConfig.model, // Use resolved model from all config layers
      // Replay never contacts a provider — don't require harness credentials.
      skipSelfTests: !!resolvedConfig.replayDir,
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

    // Budget resolution table (if any budget config exists)
    const hasAnyBudget =
      validationResult.hankBudget ||
      codons.some((cfg) =>
        cfg.type === "loop" ? cfg.budget || cfg.codons.some((cc) => cc.budget) : cfg.budget,
      );

    if (hasAnyBudget) {
      const useColor = process.stdout.isTTY ?? false;
      const budgetTable = renderBudgetResolutionTable({
        hankBudget: validationResult.hankBudget ?? {},
        codons,
        terminalWidth,
        useColor,
        resolvedCeiling: resolvedConfig.budget,
      });
      console.log(budgetTable);
      console.log("");
    }

    // Log any non-fatal warnings
    if (warnings.length > 0) {
      console.log("!  Configuration warnings:");
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

      // Whether an interactive client is driving the run. In headless mode a
      // retriable failure under onFailure:"abort" must shut down rather than
      // park in "stay-active" (no client will ever issue a manual retry).
      headless: headlessMode,

      // Output directory: CLI flag takes precedence, then resolved config
      // If neither is set, outputDirectory remains undefined (outputs stay in execution dir)
      // IMPORTANT: Resolve to absolute path here so downstream code can use it directly
      // without path.join(cwd, ...) — path.join treats absolute paths as relative segments.
      outputDirectory: outputPath
        ? path.resolve(originalCwd, outputPath)
        : resolvedConfig.outputDirectory
          ? path.resolve(originalCwd, resolvedConfig.outputDirectory)
          : undefined,

      // Output overwrite mode: when true, overwrite existing files instead of renaming
      overwriteOutput: cliArgs.overwriteOutput || false,

      // Required: codons from validation
      codons,

      // Optional: global system prompt (ENG-122)
      globalSystemPrompt,
    };

    // Preflight warning for potential output file conflicts
    if (serverConfig.outputDirectory) {
      const fullOutputPath = serverConfig.outputDirectory; // Already resolved to absolute
      try {
        if (fs.existsSync(fullOutputPath)) {
          const contents = fs.readdirSync(fullOutputPath);
          if (contents.length > 0) {
            if (serverConfig.overwriteOutput) {
              console.log(
                `!  Output directory '${serverConfig.outputDirectory}' is not empty. ` +
                  `Existing files will be overwritten (--overwrite-output).`,
              );
            } else {
              console.log(
                `!  Output directory '${serverConfig.outputDirectory}' is not empty. ` +
                  `Conflicting files will be renamed (e.g., file.txt -> file_1_<timestamp>.txt).`,
              );
            }
          }
        }
      } catch (_error) {
        // Directory doesn't exist yet or can't be read - no warning needed
        // The directory will be created during copy
      }
    }

    // Initialize telemetry (readFileTelemetryConfig bypasses resolveSettings,
    // which strips the telemetry field)
    const telemetryConfig = resolveTelemetryConfig(readFileTelemetryConfig(originalCwd));

    // Show first-run notice (one-time, even if telemetry is disabled)
    await showFirstRunNotice(telemetryConfig);

    // Create telemetry collector
    const clientId = await getOrCreateClientId();
    const isCompiled = !import.meta.main; // Rough heuristic: compiled binaries don't have import.meta.main
    const telemetryCollector = new TelemetryCollector(telemetryConfig, clientId, isCompiled);
    telemetryCollector.setHankConfig(codons);
    telemetryCollector.setProviders(validationResult.shimSelfTests);

    // cli_run event (spec: fires when normal execution invoked, before run starts)
    await telemetryCollector.trackCliEvent("cli_run", {
      flags: {
        headless: headlessMode,
        start_new: startNew,
        force: forceMode,
        no_wipe: noWipe,
        attach: false,
        ignore_rig_failures: cliArgs.ignoreRigFailures || false,
      },
      config_source: cliArgs.configPath ? "flag" : cliArgs.hankPath ? "positional" : "default",
      has_data_path: !!dataSourcePath,
      data_from_stdin: inputSourceType === "stdin",
    });

    const server = new HankweaveRuntime(serverConfig);

    // Wire telemetry into the runtime
    server.setTelemetryCollector(telemetryCollector);

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
      console.log("> Running in TUI mode (use --headless to disable)");
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

    // Capture startup failure in telemetry (covers the cli_run → run_started gap)
    try {
      const { captureError, flushErrorTracking } = await import("./telemetry/error-tracking.js");
      const err = error instanceof Error ? error : new Error(String(error));
      err.name = err.name || "StartupFailure";
      captureError(err, {
        runStatus: "startup_failed",
        failureType: "startup_error",
      });
      await flushErrorTracking(2000);
    } catch {
      // Silent fail
    }

    process.exit(1);
  }
}

// Global unhandled error capture for telemetry.
// NOTE: PostHog's enableExceptionAutocapture (set in telemetry-client.ts) also
// captures these with full stack traces. These handlers serve as a fallback for
// the window before PostHog is initialized (startup errors) and add hankweave-
// specific context (runStatus, failureType) that autocapture doesn't include.
process.on("uncaughtException", (error) => {
  try {
    const { captureError } = require("./telemetry/error-tracking.js");
    captureError(error, {
      runStatus: "crashed",
      failureType: "uncaught_exception",
    });
  } catch {
    // Silent fail
  }
});

process.on("unhandledRejection", (reason) => {
  try {
    const { captureError } = require("./telemetry/error-tracking.js");
    const err = reason instanceof Error ? reason : new Error(String(reason));
    err.name = err.name || "UnhandledRejection";
    captureError(err, {
      runStatus: "crashed",
      failureType: "unhandled_rejection",
    });
  } catch {
    // Silent fail
  }
});

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
