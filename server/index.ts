#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicTUI } from "./basic-tui.js";
import { ClaudeAgentSDKManager } from "./claude-agent-sdk-manager.js";
import { CleanupCommand } from "./cleanup-command.js";
import { HELP_TEXT, parseCliArgs, showDeprecationWarnings } from "./cli-parser.js";
import { ensureSchemaUrl, resolveSettings, validateHank } from "./config.js";
import { ExecutionLayout } from "./execution-layout.js";
import type { ExecutionSetup } from "./execution-setup.js";
import { setupExecutionEnvironment } from "./execution-setup.js";
import { assertGitAvailable } from "./git-support.js";
import { HANKWEAVE_ENV_UNSET, hankweaveEnvEntries } from "./hankweave-env.js";
import { HankweaveRuntime } from "./hankweave-runtime.js";
import { initProject } from "./init-command.js";
import { maintainJournal } from "./journal-command.js";
import { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import { runPackCommand } from "./pack/pack-command.js";
import { resolveStartupSource, type StartupSource, StartupSourceError } from "./startup-source.js";
import {
  getOrCreateClientId,
  resolveTelemetryConfig,
  showFirstRunNotice,
  TelemetryCollector,
  type TelemetryEventName,
} from "./telemetry/index.js";
import {
  checkRegularFile,
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

// -------------
// Main Entry Point
// -------------

type CliArgs = ReturnType<typeof parseCliArgs>;
type ResolvedConfig = ReturnType<typeof resolveSettings>;
type ValidationResult = Awaited<ReturnType<typeof validateHank>>;
type RuntimeStartup = {
  cliArgs: CliArgs;
  source: StartupSource;
  resolvedConfig: ResolvedConfig;
  executionSetup: ExecutionSetup;
  originalCwd: string;
};

/**
 * `hankweave pack` owns its own flag namespace and dispatches before the
 * run-mode parser ever sees the args (U2 phase 2). Breaking corner: a bare
 * data-dir positional literally named "pack" must now be written "./pack"
 * (see CHANGELOG). Returns true when the pack command ran.
 */
function dispatchPackCommand(args: string[]): boolean {
  if (args[0] !== "pack") return false;
  // exitCode + return, NOT process.exit: with stdout redirected to a slow
  // pipe, exit() would truncate queued findings / the bundle tree. Pack
  // starts no servers, so the process ends once the streams drain.
  process.exitCode = runPackCommand(args.slice(1));
  return true;
}

function parseArguments(): CliArgs {
  const args = process.argv.slice(2);

  // Parse ALL CLI arguments in one place (with validation)
  let cliArgs: ReturnType<typeof parseCliArgs>;
  try {
    cliArgs = parseCliArgs(args);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }

  return cliArgs;
}

function journalCliOptions(cliArgs: CliArgs) {
  const executionDir = path.resolve(cliArgs.restoreJournalPath || cliArgs.dietJournalPath || "");
  const isRestore = Boolean(cliArgs.restoreJournalPath);
  return { executionDir, isRestore };
}

async function runJournalCli(cliArgs: CliArgs): Promise<never> {
  const { executionDir, isRestore } = journalCliOptions(cliArgs);
  const event = isRestore ? "cli_restore_journal" : "cli_diet_journal";
  try {
    await maintainJournal(executionDir, isRestore);
    await sendCliTelemetry(event, {
      success: true,
    });
    process.exit(0);
  } catch (error) {
    await sendCliTelemetry(event, {
      success: false,
    });
    console.error(
      `\nError: journal ${isRestore ? "restore" : "diet"} failed: ${(error as Error).message}`,
    );
    process.exit(1);
  }
}

async function runInitCli(): Promise<never> {
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

async function readAttachPort(executionPath: string): Promise<number> {
  // Try to read port from lock file
  const lockPath = new ExecutionLayout(executionPath).lockPath;
  try {
    const lockContent = await fs.promises.readFile(lockPath, "utf-8");
    const lockData = JSON.parse(lockContent);
    // NOTE: Use !== undefined for port (port 0 is valid but falsy)
    const port = lockData.port !== undefined ? lockData.port : 7777;
    console.log(`> Read port ${port} from lock file: ${lockPath}`);
    return port;
  } catch {
    console.error(`Error: Could not read lock file: ${lockPath}`);
    console.error("   Use --port to specify the server port directly.");
    process.exit(1);
  }
}

async function attachToServer(cliArgs: CliArgs): Promise<void> {
  let port: number;

  if (cliArgs.port !== undefined) {
    // Explicit --port takes precedence
    port = cliArgs.port;
  } else if (cliArgs.executionPath) {
    port = await readAttachPort(cliArgs.executionPath);
  } else {
    // Default to standard port
    port = 7777;
  }

  console.log(`🔌 Attaching to server on port ${port}...`);
  new BasicTUI({ port });
}

async function runWizardCli(): Promise<never> {
  try {
    await runWelcomeWizard();
    await sendCliTelemetry("cli_init", { source: "wizard" });
  } catch (error) {
    // If the wizard fails for any reason, don't crash - fall through to normal help
    console.error(`\nWizard error: ${(error as Error).message}\n`);
  }
  process.exit(0);
}

async function handleInformationalCommands(cliArgs: CliArgs): Promise<void> {
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
  const isBareBones = [
    cliArgs.hankPath,
    cliArgs.configPath,
    cliArgs.dataPath,
    cliArgs.dataFlag,
    cliArgs.executionPath,
    cliArgs.inputText,
    cliArgs.init,
    cliArgs.help,
    cliArgs.showVersion,
    cliArgs.validate,
    cliArgs.cleanup,
    cliArgs.attach,
    cliArgs.headless,
    cliArgs.replayDir,
    cliArgs.restoreJournalPath,
    cliArgs.dietJournalPath,
  ].every((value) => !value);

  if (isBareBones) {
    await runWizardCli();
  }

  // Print startup banner
  renderStartupBanner();

  if (cliArgs.help) {
    console.log(HELP_TEXT);
    await sendCliTelemetry("cli_help", {});
    process.exit(0);
  }
}

async function handleEarlyCommands(cliArgs: CliArgs): Promise<boolean> {
  await handleInformationalCommands(cliArgs);

  // Handle journal restore/diet modes (events.jsonl diet P4). Early-exit
  // paths like --cleanup: no hank config, no SDK, no server.
  if ([cliArgs.restoreJournalPath, cliArgs.dietJournalPath].some(Boolean)) {
    await runJournalCli(cliArgs);
  }

  if (cliArgs.init) await runInitCli();

  if (cliArgs.attach) {
    await attachToServer(cliArgs);
    return true;
  }
  return false;
}

function reportSdkFailure(error: unknown): never {
  console.error(`\nError: ${(error as Error).message}\n`);
  if (error instanceof Error && error.stack) {
    console.error(`Stack: ${error.stack}`);
  }
  process.exit(1);
}

async function ensureClaudeSdk(cliArgs: CliArgs) {
  let claudeSdkInfo: { version: string; cached: boolean } | null = null;
  if (!cliArgs.cleanup && !cliArgs.validate) {
    try {
      const sdkResult = await ClaudeAgentSDKManager.ensureSdkAvailable();
      claudeSdkInfo = { version: sdkResult.version, cached: sdkResult.cached };
    } catch (error) {
      reportSdkFailure(error);
    }
  }

  return claudeSdkInfo;
}

function printValidationError(error: unknown): void {
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
}

async function runValidationCli(
  cliArgs: CliArgs,
  source: StartupSource,
  resolvedConfig: ResolvedConfig,
): Promise<never> {
  const { dataPath, hank } = source;
  try {
    // Git is a hard requirement for validation: copy-tree ignore rules
    // run on the git binary (hank-dir.ts).
    assertGitAvailable("hankweave validate");
    await runValidation({
      dataPath,
      configPath: hank.configPath,
      executionPath: cliArgs.executionPath ? path.resolve(cliArgs.executionPath) : undefined,
      startNew: Boolean(cliArgs.startNew),
      modelOverride: resolvedConfig.model, // Pass resolved model override (from all config layers)
      originalUrl: hank.displayPath,
      skipSchemaRewrite: hank.skipSchemaRewrite,
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
    printValidationError(error);
    process.exit(1);
  }
}

function copyReplayExecution(replayDir: string): string {
  const replaySourceDir = path.resolve(replayDir);
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
  const copiedLock = new ExecutionLayout(tempExecDir).lockPath;
  if (fs.existsSync(copiedLock)) {
    fs.unlinkSync(copiedLock);
  }
  process.on("exit", () => {
    try {
      fs.rmSync(tempExecDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });
  console.log(`[REPLAY] Copied execution dir to ${tempExecDir}`);
  return tempExecDir;
}

function prepareReplayExecution(
  replayDir: string | undefined,
  executionPath: string | undefined,
): string | undefined {
  // ========== REPLAY MODE: copy execution directory ==========
  // --replay and --execution are mutually exclusive
  if (replayDir && executionPath) {
    console.error("Error: --replay and --execution cannot be used together.");
    process.exit(1);
  }

  // When --replay is used, copy the replay dir to a temp location
  // so the original execution directory is preserved as a read-only artifact.
  if (replayDir) return copyReplayExecution(replayDir);

  return executionPath;
}

async function prepareHankForExecution(
  absoluteConfigPath: string,
  options: { skipSchemaRewrite: boolean },
): Promise<void> {
  // Add the editor schema before setup hashes the hank and data directory.
  const schemaAdded = !options.skipSchemaRewrite && ensureSchemaUrl(absoluteConfigPath);
  if (schemaAdded) {
    console.log(`+ Added $schema to ${path.basename(absoluteConfigPath)} for editor support`);
  }
  // Checkpointing requires git before execution setup touches the directory.
  try {
    assertGitAvailable("hankweave run");
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

function executionOptions(
  cliArgs: CliArgs,
  source: StartupSource,
  resolvedConfig: ResolvedConfig,
  executionPath: string | undefined,
) {
  const { dataPath, hank, inputSourceType } = source;
  return {
    readOnlySourceDataPath: dataPath,
    executionPath: executionPath ? path.resolve(executionPath) : undefined,
    // For inline text and stdin, always copy (temp files shouldn't be symlinked)
    useSymlink: inputSourceType === "path" ? !cliArgs.copy : false,
    startNew: Boolean(cliArgs.startNew),
    forceMode: Boolean(cliArgs.force),
    skipConfirmation: Boolean(cliArgs.skipConfirmation),
    hankPath: hank.configPath,
    ...hank.executionMetadata,
    ignoreDataMismatch: cliArgs.ignoreDataMismatch || !!resolvedConfig.replayDir,
    noWipe: Boolean(cliArgs.noWipe),
    // --headless runs unattended: never prompt, fail closed like CI
    headless: Boolean(cliArgs.headless),
    skipJournalRestore: Boolean(cliArgs.cleanup),
  };
}

async function prepareExecution(
  cliArgs: CliArgs,
  source: StartupSource,
  resolvedConfig: ResolvedConfig,
): Promise<ExecutionSetup> {
  const { configPath: absoluteConfigPath } = source.hank;
  const executionPath = prepareReplayExecution(resolvedConfig.replayDir, cliArgs.executionPath);
  if (!cliArgs.cleanup)
    await prepareHankForExecution(absoluteConfigPath, {
      skipSchemaRewrite: source.hank.skipSchemaRewrite,
    });

  // Set up execution environment
  let executionSetup: ExecutionSetup;
  try {
    executionSetup = await setupExecutionEnvironment(
      executionOptions(cliArgs, source, resolvedConfig, executionPath),
    );
  } catch (error) {
    console.error("[ERROR] Execution setup failed!");
    console.error(`Error: Execution setup failed: ${(error as Error).message}`);
    process.exit(1);
  }

  return executionSetup;
}

function displayExecutionStartup(
  executionSetup: ExecutionSetup,
  claudeSdkInfo: Awaited<ReturnType<typeof ensureClaudeSdk>>,
): void {
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
}

async function runCleanupCli(cliArgs: CliArgs, executionSetup: ExecutionSetup): Promise<never> {
  try {
    const cleanup = new CleanupCommand({
      dataSourcePath: executionSetup.readOnlySourceDataPath,
      executionPath: executionSetup.executionPath,
      skipConfirmation: cliArgs.skipConfirmation || false,
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

function stripUnsetEnvironment(): void {
  // Apply HANKWEAVE_*=unset to process.env BEFORE provider initialization.
  // This ensures sentinel providers (which use AI SDK in-process) don't inherit
  // proxy URLs that break health checks. Child process stripping (in
  // claude-agent-sdk-manager.ts and pi-sdk-manager.ts) still handles
  // codon agents separately.
  for (const { name, value } of hankweaveEnvEntries()) {
    if (value !== HANKWEAVE_ENV_UNSET) continue;
    if (process.env[name]) {
      delete process.env[name];
      console.log(`> Stripped ${name} from process environment (HANKWEAVE_${name}=unset)`);
    }
  }
}

function printBudgetResolution(
  validationResult: ValidationResult,
  resolvedConfig: ResolvedConfig,
  terminalWidth: number,
): void {
  const { codons } = validationResult;
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

function displayHankBudget(
  validationResult: ValidationResult,
  resolvedConfig: ResolvedConfig,
  terminalWidth: number,
): void {
  const { codons } = validationResult;
  // Budget resolution table (if any budget config exists)
  const hasAnyBudget =
    validationResult.hankBudget ||
    codons.some((cfg) =>
      cfg.type === "loop" ? cfg.budget || cfg.codons.some((cc) => cc.budget) : cfg.budget,
    );

  if (hasAnyBudget) {
    printBudgetResolution(validationResult, resolvedConfig, terminalWidth);
  }
}

function displayConfigurationWarnings(warnings: string[]): void {
  // Log any non-fatal warnings
  if (warnings.length > 0) {
    console.log("!  Configuration warnings:");
    for (const warning of warnings) {
      console.log(`  - ${warning}`);
    }
    console.log();
  }
}

function displayValidatedHank(
  validationResult: ValidationResult,
  absoluteConfigPath: string,
  resolvedConfig: ResolvedConfig,
): void {
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

  displayHankBudget(validationResult, resolvedConfig, terminalWidth);
  displayConfigurationWarnings(warnings);
}

function createServerConfig(context: RuntimeStartup, validationResult: ValidationResult) {
  const { cliArgs, source, resolvedConfig, executionSetup, originalCwd } = context;
  const { configPath: absoluteConfigPath } = source.hank;
  const { codons, globalSystemPrompt } = validationResult;
  const headlessMode = Boolean(cliArgs.headless);
  const outputPath = cliArgs.outputPath;
  // Create server configuration by merging all config layers with execution properties
  return {
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
    overwriteOutput: Boolean(cliArgs.overwriteOutput),

    // Required: codons from validation
    codons,

    // Optional: global system prompt (ENG-122)
    globalSystemPrompt,
  };
}

function hasOutputContents(outputDirectory: string): boolean {
  return fs.existsSync(outputDirectory) && fs.readdirSync(outputDirectory).length > 0;
}

function printOutputConflictWarning(serverConfig: ReturnType<typeof createServerConfig>): void {
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

function warnOutputConflicts(serverConfig: ReturnType<typeof createServerConfig>): void {
  if (!serverConfig.outputDirectory) return;
  try {
    if (hasOutputContents(serverConfig.outputDirectory)) printOutputConflictWarning(serverConfig);
  } catch {
    // Directory cannot be read yet; output copying will create it if necessary.
  }
}

async function initializeRunTelemetry(context: RuntimeStartup, validationResult: ValidationResult) {
  const { cliArgs, source, originalCwd } = context;
  const { codons } = validationResult;
  const headlessMode = Boolean(cliArgs.headless);
  const startNew = Boolean(cliArgs.startNew);
  const forceMode = Boolean(cliArgs.force);
  const noWipe = Boolean(cliArgs.noWipe);
  const dataSourcePath = cliArgs.dataPath || cliArgs.dataFlag;
  const { inputSourceType } = source;
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
      ignore_rig_failures: Boolean(cliArgs.ignoreRigFailures),
    },
    config_source: cliArgs.configPath ? "flag" : cliArgs.hankPath ? "positional" : "default",
    has_data_path: !!dataSourcePath,
    data_from_stdin: inputSourceType === "stdin",
  });

  return telemetryCollector;
}

async function launchRuntime(
  serverConfig: ReturnType<typeof createServerConfig>,
  telemetryCollector: TelemetryCollector,
): Promise<void> {
  const headlessMode = serverConfig.headless;
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
}

function printStartupErrorDetails(error: Error): void {
  if (error.stack) {
    console.error(`Stack trace:\n${error.stack}`);
  }
  if ("cause" in error && error.cause) {
    console.error(`Cause: ${error.cause}`);
  }
}

async function captureStartupFailure(error: unknown): Promise<void> {
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
}

async function reportStartupFailure(error: unknown): Promise<never> {
  console.error("[ERROR] Server startup failed!");
  console.error(`Error message: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error) printStartupErrorDetails(error);
  await captureStartupFailure(error);
  process.exit(1);
}

async function startRuntime(context: RuntimeStartup): Promise<void> {
  const { source, resolvedConfig, executionSetup } = context;
  const { configPath: absoluteConfigPath } = source.hank;
  // Load and validate configuration
  // Config path already resolved above before execution setup
  // Settings were already resolved earlier (before validation mode check)

  // Display model override message if model is set from any config layer
  if (resolvedConfig.model) {
    console.log(`> Using global model override: ${resolvedConfig.model} (applies to all codons)`);
  }

  stripUnsetEnvironment();

  // Initialize LLM Provider Registry singleton before ANY config parsing/validation
  // This must happen before validateHank() since Zod transforms use it for model validation
  const serverLogger = new Logger(path.join(executionSetup.executionPath, "model-validation.log"));
  LlmProviderRegistry.getInstance({
    logger: serverLogger,
    performHealthCheckOnInit: false,
  });

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

    displayValidatedHank(validationResult, absoluteConfigPath, resolvedConfig);
    const serverConfig = createServerConfig(context, validationResult);
    warnOutputConflicts(serverConfig);
    const telemetryCollector = await initializeRunTelemetry(context, validationResult);
    await launchRuntime(serverConfig, telemetryCollector);
  } catch (error) {
    await reportStartupFailure(error);
  }
}

/**
 * A source the user named that cannot be loaded (no piped stdin, a remote
 * hank that will not clone, a bundle failing verification) is a user error:
 * print its message and exit 1. Anything else is a bug and keeps its stack
 * via the top-level catch.
 */
async function resolveSource(cliArgs: CliArgs, originalCwd: string): Promise<StartupSource> {
  try {
    return await resolveStartupSource(cliArgs, originalCwd);
  } catch (error) {
    if (!(error instanceof StartupSourceError)) throw error;
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  }
}

async function main() {
  if (dispatchPackCommand(process.argv.slice(2))) return;
  const cliArgs = parseArguments();
  if (await handleEarlyCommands(cliArgs)) return;

  const claudeSdkInfo = await ensureClaudeSdk(cliArgs);
  const originalCwd = process.cwd();
  const source = await resolveSource(cliArgs, originalCwd);
  // Resolve all five config layers before validation or execution setup.
  const resolvedConfig = resolveSettings({ cliArgs, hankPath: source.hank.configPath });
  if (cliArgs.validate) await runValidationCli(cliArgs, source, resolvedConfig);

  const executionSetup = await prepareExecution(cliArgs, source, resolvedConfig);
  displayExecutionStartup(executionSetup, claudeSdkInfo);
  process.chdir(executionSetup.executionPath);
  if (cliArgs.cleanup) await runCleanupCli(cliArgs, executionSetup);

  await startRuntime({ cliArgs, source, resolvedConfig, executionSetup, originalCwd });
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
