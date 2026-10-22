#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicTUI } from "./basic-tui.js";
import { ClaudeAgentSDKManager } from "./claude-agent-sdk-manager.js";
import { CleanupCommand } from "./cleanup-command.js";
import { HELP_TEXT, parseCliArgs, showDeprecationWarnings } from "./cli-parser.js";
import { ensureSchemaUrl, resolveSettings, validateHank } from "./config.js";
import { findExecutionDirs, hashDataSource } from "./data-hasher.js";
import { registerReplayCleanup } from "./execution-cleanup.js";
import { ExecutionLayout } from "./execution-layout.js";
import type { ExecutionPlan, ExecutionSetup } from "./execution-setup.js";
import {
  planExecutionEnvironment,
  resolveAttachPort,
  setupExecutionEnvironment,
} from "./execution-setup.js";
import { assertGitAvailable, GitMissingError } from "./git-support.js";
import { HANKWEAVE_ENV_UNSET, hankweaveEnvEntries } from "./hankweave-env.js";
import {
  HankweaveRuntime,
  RuntimeLock,
  RuntimeLockHeldError,
  type RuntimeShutdownResult,
} from "./hankweave-runtime.js";
import { modelHarnesses, readModelConfigs } from "./harnesses.js";
import { initProject } from "./init-command.js";
import { maintainJournal } from "./journal-command.js";
import { Models } from "./llm/index.js";
import { runPackCommand } from "./pack/pack-command.js";
import { applyEnvOverlay, buildEnvOverlay } from "./pi-sdk-manager.js";
import { LOCK_TAKEOVER_WAIT_MS } from "./runtime-lock.js";
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
  lock: RuntimeLock;
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

async function attachToServer(cliArgs: CliArgs): Promise<void> {
  const port = await resolveAttachPort(cliArgs);

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

/**
 * An error's stack frames without the "Name: message" header the stack
 * starts with: the message is already printed above it, and a multi-line
 * message (a hank validation report) would otherwise appear twice.
 */
function stackFrames(error: Error): string {
  const stack = error.stack ?? "";
  const firstFrame = stack.search(/^\s+at /m);
  return firstFrame === -1 ? "" : stack.slice(firstFrame);
}

function reportSdkFailure(error: unknown): never {
  console.error(`\nError: ${(error as Error).message}\n`);
  if (error instanceof Error && stackFrames(error)) {
    console.error(`Stack: ${stackFrames(error)}`);
  }
  process.exit(1);
}

/** Cleanup and validation run no codon; replay runs no harness: none needs a Claude executable. */
function needsClaudeSdk(cliArgs: CliArgs): boolean {
  return !cliArgs.cleanup && !cliArgs.validate && !cliArgs.replayDir;
}

async function ensureClaudeSdk(cliArgs: CliArgs) {
  if (!needsClaudeSdk(cliArgs)) return null;
  try {
    const sdkResult = await ClaudeAgentSDKManager.ensureSdkAvailable();
    return { version: sdkResult.version, cached: sdkResult.cached };
  } catch (error) {
    reportSdkFailure(error);
  }
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

  // Choose an isolated replay destination; copy only after the command acquires it.
  if (replayDir) {
    return path.join(os.tmpdir(), `hankweave-replay-${randomUUID()}`);
  }

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
  assertGitAvailable("hankweave run");
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
  };
}

async function prepareExecution(
  cliArgs: CliArgs,
  source: StartupSource,
  resolvedConfig: ResolvedConfig,
): Promise<ExecutionPlan> {
  const executionPath = prepareReplayExecution(resolvedConfig.replayDir, cliArgs.executionPath);
  return planExecutionEnvironment(executionOptions(cliArgs, source, resolvedConfig, executionPath));
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

/** Cleanup only selects existing executions; runtime planning may invent a new path. */
async function resolveCleanupTarget(
  cliArgs: CliArgs,
  source: StartupSource,
): Promise<string | undefined> {
  if (cliArgs.executionPath) return path.resolve(cliArgs.executionPath);
  const dirs = await findExecutionDirs(await hashDataSource(source.dataPath));
  return dirs[0];
}

async function runCleanupCli(cliArgs: CliArgs, source: StartupSource): Promise<never> {
  try {
    const executionPath = await resolveCleanupTarget(cliArgs, source);
    if (!executionPath) {
      console.log("No execution directories found for this data source.");
      await sendCliTelemetry("cli_cleanup", { success: true });
      process.exit(0);
    }
    const cleanup = new CleanupCommand({
      dataSourcePath: source.dataPath,
      executionPath,
      skipConfirmation: Boolean(cliArgs.skipConfirmation),
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

  const modelTable = Models.current().report();
  if (modelTable.length > 0) {
    console.log(modelTable.join("\n"));
    console.log("");
  }

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
  lock: RuntimeLock,
): Promise<RuntimeShutdownResult> {
  const headlessMode = serverConfig.headless;
  const server = new HankweaveRuntime(serverConfig, lock);

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
  return server.waitForShutdown();
}

function printStartupErrorDetails(error: Error): void {
  const frames = stackFrames(error);
  if (frames) {
    console.error(`Stack trace:\n${frames}`);
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

async function startRuntime(context: RuntimeStartup): Promise<RuntimeShutdownResult> {
  const { source, resolvedConfig, executionSetup } = context;
  const { configPath: absoluteConfigPath } = source.hank;
  // Load and validate configuration
  // Config path already resolved above before execution setup
  // Settings were already resolved earlier (before validation mode check)

  // Display model override message if model is set from any config layer
  if (resolvedConfig.model) {
    console.log(`> Using global model override: ${resolvedConfig.model} (applies to all codons)`);
  }

  const serverLogger = new Logger(path.join(executionSetup.executionPath, "model-validation.log"));
  Models.current().attachLogger(serverLogger);

  try {
    // Normal server mode - validate config
    const validationResult = await validateHank({
      configPath: absoluteConfigPath,
      executionPath: executionSetup.executionPath,
      logger: serverLogger,
      modelOverride: resolvedConfig.model, // Use resolved model from all config layers
      // Replay never contacts a provider — don't require harness credentials.
      skipSelfTests: !!resolvedConfig.replayDir,
      budgetPolicy: resolvedConfig.budget,
    });

    displayValidatedHank(validationResult, absoluteConfigPath, resolvedConfig);
    const serverConfig = createServerConfig(context, validationResult);
    warnOutputConflicts(serverConfig);
    const telemetryCollector = await initializeRunTelemetry(context, validationResult);
    return await launchRuntime(serverConfig, telemetryCollector, context.lock);
  } catch (error) {
    // The CLI boundary prints once, after main's finally blocks release ownership.
    await captureStartupFailure(error);
    throw error;
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

async function acquireRuntimeLock(executionPath: string): Promise<RuntimeLock> {
  try {
    return await RuntimeLock.acquire(executionPath);
  } catch (error) {
    if (!(error instanceof RuntimeLockHeldError)) throw error;
    console.error(
      `Execution ${error.executionPath} is locked; waiting up to ~${LOCK_TAKEOVER_WAIT_MS / 1000} seconds for release or recovery. Ctrl+C to cancel.`,
    );
    return RuntimeLock.acquire(executionPath, { waitForStale: true });
  }
}

/**
 * Check every model before any config parsing (spec 72): the harness that
 * would run it confirms it first, then the catalog prices it. Settings
 * resolution and hank validation read the results. Replay and cleanup only
 * parse the hank — no credentials, no network: replay must see the catalog
 * the recorded run saw, and cleanup never runs a model.
 */
async function loadModels(cliArgs: CliArgs, source: StartupSource): Promise<void> {
  const parseOnly = !!cliArgs.replayDir || !!cliArgs.cleanup;
  const models = await Models.load({
    raw: readModelConfigs(source.hank.configPath),
    cliModel: cliArgs.model,
    harnesses: modelHarnesses(),
    env: applyEnvOverlay(process.env, buildEnvOverlay()),
    network: !parseOnly,
    prerequisites: !parseOnly,
    background: !cliArgs.validate && !parseOnly,
  });
  for (const problem of models.problems()) console.log(`! ${problem}`);
}

async function main() {
  if (dispatchPackCommand(process.argv.slice(2))) return;
  const cliArgs = parseArguments();
  if (await handleEarlyCommands(cliArgs)) return;
  // A run applies HANKWEAVE_*=unset before anything reads provider
  // credentials from process.env. The first such reader is not the model
  // pre-pass but bundle resolution: verifying an extraction walks the
  // closure, which parses the hank's models (parse mode, no credentials).
  // --validate and --cleanup exit before a run starts and keep the
  // environment as it is.
  if (!cliArgs.validate && !cliArgs.cleanup) stripUnsetEnvironment();

  const claudeSdkInfo = await ensureClaudeSdk(cliArgs);
  const originalCwd = process.cwd();
  const source = await resolveSource(cliArgs, originalCwd);
  await loadModels(cliArgs, source);
  // Resolve all five config layers before validation or execution setup.
  const resolvedConfig = resolveSettings({ cliArgs, hankPath: source.hank.configPath });
  if (cliArgs.validate) await runValidationCli(cliArgs, source, resolvedConfig);

  if (cliArgs.cleanup) await runCleanupCli(cliArgs, source);
  const plan = await prepareExecution(cliArgs, source, resolvedConfig);

  // The runtime is what supervisors relaunch after a crash, often within seconds,
  // while the killed predecessor's heartbeat is still fresh. Wait for that lease
  // to expire rather than failing the relaunch (see AcquireOptions.waitForStale).
  const lock = await acquireRuntimeLock(plan.executionPath);
  let result: RuntimeShutdownResult | undefined;
  let cleanupReplay: (() => Promise<void>) | undefined;
  try {
    try {
      if (resolvedConfig.replayDir) {
        cleanupReplay = registerReplayCleanup(plan.executionPath, lock);
        await fs.promises.cp(path.resolve(resolvedConfig.replayDir), plan.executionPath, {
          recursive: true,
          // The destination already holds its own lease. Never merge the
          // source's lock into it or copy locks from nested executions.
          filter: (source) => path.basename(source) !== ExecutionLayout.RUNTIME_LOCK,
        });
        console.log(`[REPLAY] Copied execution dir to ${plan.executionPath}`);
      }
      await prepareHankForExecution(source.hank.configPath, {
        skipSchemaRewrite: source.hank.skipSchemaRewrite,
      });
      const executionSetup = await setupExecutionEnvironment(plan);
      displayExecutionStartup(executionSetup, claudeSdkInfo);
      process.chdir(executionSetup.executionPath);
      result = await startRuntime({
        lock,
        cliArgs,
        source,
        resolvedConfig,
        executionSetup,
        originalCwd,
      });
    } finally {
      try {
        // Windows keeps the process cwd open. Leave the execution tree before
        // deleting a replay or releasing it to a successor that may remove it.
        process.chdir(os.tmpdir());
        await cleanupReplay?.();
      } finally {
        await lock.release();
      }
    }
    // All remaining work uses the independent snapshot, never the execution directory.
    await result.trace?.upload();
  } finally {
    await result?.trace?.dispose();
  }
  process.exit(result.exitCode);
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
    if (
      error instanceof Error &&
      !(error instanceof RuntimeLockHeldError) &&
      !(error instanceof GitMissingError)
    ) {
      printStartupErrorDetails(error);
    }
    process.exit(1);
  }
}
