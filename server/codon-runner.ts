import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAgentSDKManager } from "./claude-agent-sdk-manager.js";
import { ClaudeLogParser } from "./claude-log-parser.js";
import { TIMEOUTS } from "./config.js";
import { CostTracker } from "./cost-tracker.js";
import type { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import type { ModelInfo } from "./llm/models-dev-schema.js";
import { ShimProcessManager } from "./shim-process-manager.js";
import {
  extractShimFiles,
  getExtractedShimPath,
  needsShimExtraction,
} from "./shim-runtime-extractor.js";
import type { StateManager } from "./state-manager.js";
import { TypedEventEmitter } from "./typed-event-emitter.js";
import type { CodonId, RunId, SessionId } from "./types/branded-types.js";
import type {
  AssistantMessage,
  ResultMessage,
  SystemMessage,
  UserMessage,
} from "./types/claude-session-schema.js";
import type { Codon, ShimSelfTestResult, TokenUsage } from "./types/types.js";
import { getRuntimeCommand, isCompiledExecutable, type Logger } from "./utils.js";

/**
 * Helper function to resolve shim path correctly for all execution contexts.
 *
 * Execution contexts:
 * 1. Source (development):
 *    - Current file is in server/codon-runner.ts
 *    - Shims are at shims/{provider}/index.js (project root)
 *    - Need to go up one level: ../shims/{provider}/index.js
 *
 * 2. Bundled NPX package (npx @southbridgeai/hankweave):
 *    - Current file is in dist/index.js (bundled)
 *    - Shims are at dist/shims/{provider}/index.js
 *    - Need to use same directory: ./shims/{provider}/index.js
 *
 * 3. Compiled executable (hankweave binary):
 *    - Shims are embedded in the executable
 *    - Extract to ~/.hankweave/shims/<version>/
 *    - Return path to extracted shim
 *
 * @param currentFilePath - Path to current file (from import.meta.url)
 * @param providerId - Provider ID (e.g., "google", "openai")
 * @returns Absolute path to the shim
 * @throws Error if shims are not available
 */
async function resolveShimPath(currentFilePath: string, providerId: string): Promise<string> {
  // Map provider ID to shim name
  const shimNameMap: Record<string, string> = {
    google: "gemini",
    openai: "codex",
  };

  const shimName = shimNameMap[providerId.toLowerCase()];
  if (!shimName) {
    throw new Error(`No shim available for provider: ${providerId}`);
  }

  // Check if running from compiled executable
  if (isCompiledExecutable()) {
    // Extract shims if needed
    if (needsShimExtraction(shimName as "gemini" | "codex")) {
      await extractShimFiles();
    }

    // Return path to extracted shim
    return getExtractedShimPath(shimName as "gemini" | "codex");
  }

  const currentDir = path.dirname(currentFilePath);

  // Check if we're running from dist (bundled NPX) or server (source)
  // When bundled, currentDir will contain '/dist'
  // When source, currentDir will contain '/server'
  const isRunningFromDist = currentDir.includes("/dist") || currentDir.includes("\\dist");

  if (isRunningFromDist) {
    // Running from dist/index.js -> shims are at dist/shims/
    return path.resolve(currentDir, `shims/${shimName}/index.js`);
  }
  // Running from server/codon-runner.ts -> shims are at ../shims/
  return path.resolve(currentDir, `../shims/${shimName}/index.js`);
}

/**
 * Information about an extension, passed to the onExtension callback
 */
export interface ExtensionInfo {
  extensionNumber: number;
  sessionId: SessionId;
  previousExitCode: number;
  wasContextExceeded: boolean;
  /** The prompt being used for this extension */
  exhaustWithPrompt: string;
}

/**
 * Events emitted by CodonRunner during execution
 */
export interface CodonRunnerEvents extends Record<string, unknown[]> {
  // Process lifecycle - extensionCount is the final count when codon truly completes
  exit: [code: number, contextExceeded: boolean, extensionCount: number];
  error: [error: Error];

  // Log parser events (forwarded with specific types)
  systemMessage: [msg: SystemMessage];
  assistantMessage: [msg: AssistantMessage];
  userMessage: [msg: UserMessage];
  resultMessage: [msg: ResultMessage];

  // Cost events (enriched, ready for server forwarding)
  costIncremented: [
    data: {
      codonId: string;
      tokens: TokenUsage;
      totalCost: number;
      modelId?: string;
    },
  ];
  finalCostSet: [
    data: {
      codonId: string;
      tokens: TokenUsage;
      totalCost: number;
      modelUsage?: unknown;
      modelId?: string;
    },
  ];

  // Process output
  stdout: [data: string];
  stderr: [data: string];
}

/**
 * Extension configuration for codons that support context exhaustion
 */
export interface ExtensionConfig {
  /** Prompt to send for each extension */
  exhaustWithPrompt: string;
  /** Maximum number of extensions before forcing completion (default: 100) */
  maxExtensions: number;
}

/**
 * Base configuration shared by all CodonRunner instances
 */
interface BaseCodonRunnerConfig {
  codon: Codon;
  codonId: CodonId;
  runId: RunId;
  stateManager: StateManager;
  executionPath: string;
  agentRootPath: string; // Agent workspace directory (where agents work)
  logger: Logger;
  llmRegistry: LlmProviderRegistry;
  logParsingInterval?: number;
  anthropicBaseUrl?: string;
  logPath: string;
  globalSystemPrompt?: string | null;
  shimIdleTimeout?: number;
}

/**
 * Configuration for a CodonRunner without extension support
 */
interface CodonRunnerConfigWithoutExtension extends BaseCodonRunnerConfig {
  extensionConfig?: undefined;
  shouldInterrupt?: undefined;
  onExtension?: undefined;
}

/**
 * Configuration for a CodonRunner with extension support.
 * When extensions are enabled, interrupt check and event callbacks are required.
 */
interface CodonRunnerConfigWithExtension extends BaseCodonRunnerConfig {
  /** Extension configuration - enables automatic re-running until context exhaustion */
  extensionConfig: ExtensionConfig;
  /** Required: Check if user requested skip/force-stop */
  shouldInterrupt: () => boolean;
  /** Required: Called on each extension to emit events and update state */
  onExtension: (info: ExtensionInfo) => void;
}

/**
 * Configuration for creating a CodonRunner.
 *
 * Uses discriminated union: when extensionConfig is provided,
 * shouldInterrupt and onExtension become required.
 */
export type CodonRunnerConfig = CodonRunnerConfigWithoutExtension | CodonRunnerConfigWithExtension;

/**
 * CodonRunner encapsulates all logic needed to execute a single codon.
 *
 * Responsibilities:
 * - Create and manage ClaudeLogParser for this codon
 * - Create and manage ShimProcessManager for this codon
 * - Forward events from parser and process manager
 * - Provide clean lifecycle: construct → run → cleanup
 *
 * The runner owns both the LogParser and ProcessManager instances,
 * ensuring they are created together, used together, and cleaned up together.
 */
/**
 * Failure reasons that prevent extension
 */
type FailureReason =
  | { type: "timeout"; retriable: boolean }
  | { type: "rate-limit"; retriable: boolean }
  | { type: "api-error"; retriable: boolean }
  | { type: "unknown"; retriable: boolean };

/**
 * Determines whether a codon should extend based on exit conditions.
 * Pure function for unit testing.
 *
 * Extension triggers when ALL conditions are met:
 * - Extension config provided
 * - Not interrupted (skip/force-stop)
 * - Under max extensions
 * - Exit code 0
 * - Result message received
 * - No failure reason
 * - Context not yet exceeded
 */
export function shouldExtendCodon(params: {
  exitCode: number;
  resultMessageReceived: boolean;
  isContextExceeded: boolean;
  extensionConfig: ExtensionConfig | undefined;
  extensionCount: number;
  isInterrupted: boolean;
  failureReason: FailureReason | undefined;
}): boolean {
  // Cannot extend if no extension config
  if (!params.extensionConfig) return false;

  // Cannot extend if interrupted (user skip/force-stop)
  if (params.isInterrupted) return false;

  // Cannot extend if we've hit the max
  if (params.extensionCount >= params.extensionConfig.maxExtensions) return false;

  // Cannot extend if exit wasn't clean
  if (params.exitCode !== 0) return false;

  // Cannot extend if we didn't receive a result message (indicates crash or timeout)
  if (!params.resultMessageReceived) return false;

  // Cannot extend if we have a failure reason
  if (params.failureReason !== undefined) return false;

  // Cannot extend if context is already exceeded (we're done!)
  if (params.isContextExceeded) return false;

  // All conditions met - extend!
  return true;
}

export class CodonRunner extends TypedEventEmitter<CodonRunnerEvents> {
  private readonly config: CodonRunnerConfig;
  private readonly logParser: ClaudeLogParser;
  private readonly costTracker: CostTracker;
  private processManager: ShimProcessManager | ClaudeAgentSDKManager;
  private readonly logPath: string;
  private isCleanedUp = false;

  // Track successful result for post-success SDK error handling
  // See: intermediates/31-fixing-claude-sdk-bug/bug_investigation.md
  private successResultReceived = false;

  // Extension state - tracked internally
  private extensionCount = 0;
  private resultMessageReceived = false;
  private failureReason: FailureReason | undefined = undefined;
  private currentSessionId: SessionId | null = null;

  constructor(config: CodonRunnerConfig) {
    super();
    this.config = config;

    // Use provided log path or calculate default
    this.logPath = config.logPath;

    // Create cost tracker for this codon
    this.costTracker = new CostTracker(
      config.codon.model.modelId,
      config.llmRegistry,
      config.logger,
    );

    // Wire cost tracking: CostTracker events → state transitions + enriched runner events
    this.costTracker.on("costIncremented", (delta) => {
      this.config.stateManager.transition({
        type: "CostsIncremented",
        data: {
          runId: this.config.runId,
          codonId: this.config.codonId,
          costDelta: delta.cost,
          tokensDelta: delta.tokens,
        },
      });

      this.config.logger.log(
        `Codon ${this.config.codonId} token update - Call cost: $${delta.cost.toFixed(
          4,
        )}, Running total: $${this.costTracker.getRunningCost().toFixed(4)} ` +
          `(${delta.tokens.inputTokens} in, ${delta.tokens.outputTokens} out, ` +
          `${delta.tokens.cacheCreationTokens} cache create, ${delta.tokens.cacheReadTokens} cache read)`,
      );

      this.emit("costIncremented", {
        codonId: this.config.codonId as string,
        tokens: delta.tokens,
        totalCost: delta.cost,
        modelId: this.config.codon.model.modelId,
      });
    });

    this.costTracker.on("finalCostSet", (final) => {
      this.config.stateManager.transition({
        type: "CodonFinalCostSet",
        data: {
          runId: this.config.runId,
          codonId: this.config.codonId,
          finalCost: final.cost,
          finalTokens: final.tokens,
        },
      });

      this.emit("finalCostSet", {
        codonId: this.config.codonId as string,
        tokens: final.tokens,
        totalCost: final.cost,
        modelUsage: final.modelUsage,
        modelId: final.modelId,
      });
    });

    // Create log parser with event forwarding
    this.logParser = this.createLogParser();

    // Create process manager with event forwarding
    this.processManager = this.createProcessManager();

    this.config.logger.log(`CodonRunner initialized for codon ${this.config.codonId}`, "info");
  }

  /**
   * Check if a model can be run by CodonRunner.
   *
   * CodonRunner supports:
   * - Anthropic models via ClaudeAgentSDKManager
   * - Google models via ShimProcessManager (gemini shim)
   * - OpenAI models via ShimProcessManager (codex shim)
   *
   * @param model - The ModelInfo to check
   * @returns true if the model can be executed, false otherwise
   */
  static canRun(model: ModelInfo): boolean {
    const supportedProviders = ["anthropic", "google", "openai"];
    return supportedProviders.includes(model.providerId.toLowerCase());
  }

  /**
   * Run self-test for a model without creating a full CodonRunner instance.
   * Useful for validation and testing where you only have model info.
   *
   * @param modelInfo - The model to test
   * @param executionPath - Temporary execution path for the test
   * @param logger - Logger instance for recording test progress
   * @param anthropicBaseUrl - Optional custom Anthropic API base URL
   * @returns Promise resolving to self-test results
   */
  static async runSelfTestForModel(
    modelInfo: ModelInfo,
    executionPath: string,
    logger: Logger,
    anthropicBaseUrl?: string,
  ): Promise<ShimSelfTestResult> {
    const isAnthropicModel = modelInfo.providerId.toLowerCase() === "anthropic";

    // Create temporary log parser (required by managers)
    const tempLogParserPath = path.join(os.tmpdir(), `self-test-parser-${Date.now()}.jsonl`);
    const tempLogParser = new ClaudeLogParser({
      logPath: tempLogParserPath,
      codonId: "self-test" as CodonId,
      parsingInterval: 100,
      logger,
    });

    try {
      let result: ShimSelfTestResult;

      if (isAnthropicModel) {
        // Use Claude Agent SDK Manager for Anthropic models
        logger.log(
          `Testing Claude Agent SDK for model: ${modelInfo.name} (${modelInfo.providerId}/${modelInfo.modelId})`,
          "info",
        );

        // For self-tests, use executionPath as agentRootPath (temporary directory, no nested structure)
        const manager = new ClaudeAgentSDKManager(
          executionPath,
          executionPath, // Self-tests don't need the full nested structure
          logger,
          tempLogParser,
          anthropicBaseUrl,
        );

        result = await manager.runSelfTest();
      } else {
        // Use Shim Process Manager for non-Anthropic models
        logger.log(
          `Testing shim for model: ${modelInfo.name} (${modelInfo.providerId}/${modelInfo.modelId})`,
          "info",
        );

        const __filename = fileURLToPath(import.meta.url);
        const shimPath = await resolveShimPath(__filename, modelInfo.providerId);

        // For self-tests, use executionPath as agentRootPath (temporary directory, no nested structure)
        const manager = new ShimProcessManager(
          executionPath,
          executionPath, // Self-tests don't need the full nested structure
          logger,
          tempLogParser,
          anthropicBaseUrl,
        );

        result = await manager.runSelfTest(getRuntimeCommand(shimPath), modelInfo.providerId);
      }

      // Log results
      logger.log(
        `Self-test ${result.overall.passed ? "PASSED" : "FAILED"}: ${result.overall.message}`,
        result.overall.passed ? "info" : "error",
      );

      for (const check of result.checks) {
        logger.log(
          `  - ${check.name}: ${check.passed ? "✓" : "✗"} ${check.message}`,
          check.passed ? "info" : "error",
        );
      }

      return result;
    } finally {
      // Clean up temporary log parser
      tempLogParser.stop();

      // Clean up temporary log file if it exists
      const fs = await import("node:fs");
      if (fs.existsSync(tempLogParserPath)) {
        fs.unlinkSync(tempLogParserPath);
      }
    }
  }

  /**
   * Create ClaudeLogParser for this codon with event forwarding
   */
  private createLogParser(): ClaudeLogParser {
    return new ClaudeLogParser({
      logPath: this.logPath,
      codonId: this.config.codonId,
      parsingInterval: this.config.logParsingInterval ?? 100,
      logger: this.config.logger,

      // Forward log parser events to our listeners, and track state for extensions
      onSystemMessage: (msg) => {
        // Track session ID from init messages
        if (msg.subtype === "init" && msg.session_id) {
          this.currentSessionId = msg.session_id as SessionId;
        }
        this.emit("systemMessage", msg);
      },
      onAssistantMessage: (msg) => {
        if (msg.message.usage) {
          this.costTracker.handleAssistantUsage(msg.message.usage);
        }
        this.emit("assistantMessage", msg);
      },
      onUserMessage: (msg) => this.emit("userMessage", msg),
      onResultMessage: (msg) => {
        // Track successful completion for post-success SDK error handling
        // Only set on actual success, not on error results
        if (msg.subtype === "success") {
          this.successResultReceived = true;
          // Process cost tracking for success results (tokens are spent even on is_error=true)
          this.costTracker.handleResultUsage(msg);
        }

        // Track that we received a result message (needed for extension decision)
        this.resultMessageReceived = true;

        // Check for failure reasons that would prevent extension
        if (msg.subtype === "error") {
          // Determine failure reason from error type
          const errorText = String(msg.error || "").toLowerCase();
          if (errorText.includes("timeout") || errorText.includes("timed out")) {
            this.failureReason = { type: "timeout", retriable: true };
          } else if (errorText.includes("rate") || errorText.includes("429")) {
            this.failureReason = { type: "rate-limit", retriable: true };
          } else if (errorText.includes("api") || errorText.includes("500")) {
            this.failureReason = { type: "api-error", retriable: true };
          } else {
            this.failureReason = { type: "unknown", retriable: false };
          }
        }

        this.emit("resultMessage", msg);
      },
    });
  }

  /**
   * Create process manager (SDK or Shim) based on model type with event forwarding
   */
  private createProcessManager(): ShimProcessManager | ClaudeAgentSDKManager {
    const modelInfo = this.config.codon.model;

    // Determine if this is an Anthropic model using providerId
    const isAnthropicModel = modelInfo.providerId.toLowerCase() === "anthropic";

    let processManager: ShimProcessManager | ClaudeAgentSDKManager;

    if (isAnthropicModel) {
      // Use Claude Agent SDK for Anthropic models
      this.config.logger.log(
        `Using Claude Agent SDK for Anthropic model: ${modelInfo.name} (${modelInfo.providerId}/${modelInfo.modelId})`,
        "info",
      );

      processManager = new ClaudeAgentSDKManager(
        this.config.executionPath,
        this.config.agentRootPath,
        this.config.logger,
        this.logParser,
        this.config.anthropicBaseUrl,
        this.config.globalSystemPrompt ?? null,
        this.config.shimIdleTimeout,
      );
    } else {
      // Use Shim for non-Anthropic models (e.g., Gemini)
      this.config.logger.log(
        `Using shim for model: ${modelInfo.name} (${modelInfo.providerId}/${modelInfo.modelId})`,
        "info",
      );

      processManager = new ShimProcessManager(
        this.config.executionPath,
        this.config.agentRootPath,
        this.config.logger,
        this.logParser,
        this.config.anthropicBaseUrl,
        this.config.globalSystemPrompt ?? null,
        this.config.shimIdleTimeout,
      );
    }

    // Forward process manager events to our listeners
    // The exit handler implements the internal extension loop
    processManager.on("exit", (code: number, isContextExceeded: boolean) => {
      this.handleProcessExit(code, isContextExceeded);
    });

    processManager.on("error", (error: Error) => {
      // Handle known SDK bug: error emitted after successful completion
      // The SDK sometimes emits "only prompt commands are supported in streaming mode"
      // after already reporting success. In this case, treat as successful completion.
      // See: intermediates/31-fixing-claude-sdk-bug/bug_investigation.md
      if (this.successResultReceived) {
        this.config.logger.log(
          `[CodonRunner] [POST-SUCCESS-ERROR] Post-success SDK error suppressed: ${error.message}`,
          "error",
        );
        this.config.logger.log(
          `[CodonRunner] Treating as successful exit (SDK cleanup error after conversation completed)`,
          "info",
        );
        // Transform error into normal exit - conversation completed successfully
        this.emit("exit", 0, false, this.extensionCount);
      } else {
        // No success result yet - this is a real error, forward it
        this.emit("error", error);
      }
    });

    processManager.on("stdout", (data: string) => {
      this.emit("stdout", data);
    });

    processManager.on("stderr", (data: string) => {
      this.emit("stderr", data);
    });

    return processManager;
  }

  /**
   * Handle process exit - implements internal extension loop.
   *
   * When the process exits, this checks if we should extend:
   * - If yes: calls onExtension callback, resets state, and re-runs
   * - If no: emits final "exit" event with extensionCount
   */
  private async handleProcessExit(code: number, isContextExceeded: boolean): Promise<void> {
    // Check if we should extend - only possible when extensionConfig is provided
    // The discriminated union guarantees shouldInterrupt exists when extensionConfig does
    const isInterrupted = this.config.shouldInterrupt?.() ?? false;

    const shouldExtend = shouldExtendCodon({
      exitCode: code,
      resultMessageReceived: this.resultMessageReceived,
      isContextExceeded,
      extensionConfig: this.config.extensionConfig,
      extensionCount: this.extensionCount,
      isInterrupted,
      failureReason: this.failureReason,
    });

    // Type narrowing: if shouldExtend is true, extensionConfig must be defined
    // (shouldExtendCodon returns false when extensionConfig is undefined)
    // Also check currentSessionId - we need it to resume the session
    if (shouldExtend && this.currentSessionId && this.config.extensionConfig) {
      // Now TypeScript knows this.config is CodonRunnerConfigWithExtension
      // Pass currentSessionId explicitly to avoid non-null assertion in performExtension
      await this.performExtension(
        this.currentSessionId,
        this.config.extensionConfig,
        this.config.onExtension,
        code,
        isContextExceeded,
      );
    } else {
      // No more extensions - emit final exit
      this.emit("exit", code, isContextExceeded, this.extensionCount);
    }
  }

  /**
   * Perform an extension: notify callback, reset state, re-run with prompt override.
   *
   * Parameters are passed explicitly to avoid type narrowing issues with class properties.
   */
  private async performExtension(
    sessionId: SessionId,
    extensionConfig: ExtensionConfig,
    onExtension: (info: ExtensionInfo) => void,
    previousExitCode: number,
    wasContextExceeded: boolean,
  ): Promise<void> {
    this.extensionCount++;

    const extensionPrompt = extensionConfig.exhaustWithPrompt;

    this.config.logger.log(
      `CodonRunner: Extending codon ${this.config.codonId} (extension #${this.extensionCount})`,
      "info",
    );

    // Notify runtime via callback (emit events, update state)
    onExtension({
      extensionNumber: this.extensionCount,
      sessionId,
      previousExitCode,
      wasContextExceeded,
      exhaustWithPrompt: extensionPrompt,
    });

    // Reset per-extension state
    this.resultMessageReceived = false;
    this.failureReason = undefined;
    this.successResultReceived = false;

    // Keep log parser running (don't stop/restart to avoid re-parsing entire log)
    // The parser will continue tracking from its current position

    // Re-run with the extension prompt
    await this.runExtension(sessionId, extensionPrompt);
  }

  /**
   * Internal method to run an extension (resume session with exhaustion prompt).
   *
   * Uses the same spawn() method as initial run, but with exhaustionPrompt option.
   * This activates exhaustion mode: appends to log, forces resume.
   */
  private async runExtension(sessionId: SessionId, exhaustionPrompt: string): Promise<void> {
    // Spawn using the unified spawn method with exhaustion mode
    if (this.processManager instanceof ClaudeAgentSDKManager) {
      await this.processManager.spawn(this.config.codon, sessionId, {
        logPath: this.logPath,
        exhaustionPrompt,
      });
    } else {
      // ShimProcessManager
      const __filename = fileURLToPath(import.meta.url);
      const shimPath = await resolveShimPath(__filename, this.config.codon.model.providerId);

      await this.processManager.spawn(getRuntimeCommand(shimPath), this.config.codon, sessionId, {
        logPath: this.logPath,
        exhaustionPrompt,
      });
    }

    const pid = this.processManager.getPid();
    this.config.logger.log(
      `CodonRunner: Extension spawned for codon ${this.config.codonId} (PID: ${pid})`,
      "info",
    );

    // Log parser continues running (already started during initial run)
  }

  /**
   * Start executing the codon.
   *
   * If extensionConfig is provided, the runner will automatically extend
   * until context is exhausted or maxExtensions is reached.
   *
   * @param previousSessionId - Optional session ID to continue from
   */
  async run(previousSessionId?: SessionId): Promise<void> {
    // Reset extension state at start of new run
    this.extensionCount = 0;
    this.resultMessageReceived = false;
    this.failureReason = undefined;
    this.currentSessionId = null;

    this.config.logger.log(
      `CodonRunner: Starting execution of codon ${this.config.codonId}`,
      "info",
    );

    // Spawn using the unified spawn method
    if (this.processManager instanceof ClaudeAgentSDKManager) {
      // Claude Agent SDK doesn't need a command array
      await this.processManager.spawn(this.config.codon, previousSessionId || null, {
        logPath: this.logPath,
      });
    } else {
      // ShimProcessManager needs command array
      const __filename = fileURLToPath(import.meta.url);
      const shimPath = await resolveShimPath(__filename, this.config.codon.model.providerId);

      await this.processManager.spawn(
        getRuntimeCommand(shimPath),
        this.config.codon,
        previousSessionId || null,
        { logPath: this.logPath },
      );
    }

    const pid = this.processManager.getPid();
    this.config.logger.log(
      `CodonRunner: Process spawned for codon ${this.config.codonId} (PID: ${pid})`,
      "info",
    );

    // Start log parsing with delay
    setTimeout(() => {
      this.logParser.start();
    }, TIMEOUTS.LOG_PARSER_DELAY_MS);
  }

  /**
   * Get the current extension count.
   * Returns 0 if no extensions have occurred.
   */
  getExtensionCount(): number {
    return this.extensionCount;
  }

  /**
   * Kill the running process gracefully (SIGTERM with wait and SIGKILL escalation).
   */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.isCleanedUp && this.processManager) {
      this.config.logger.log(
        `CodonRunner: Killing process for codon ${this.config.codonId} with ${signal}`,
        "info",
      );
      await this.processManager.kill(signal);
    }
  }

  /**
   * Force-kill the running process immediately (SIGKILL for shims, abort for SDK).
   * Used by forceShutdown() when the user presses q/Ctrl+C a second time.
   */
  async forceKill(): Promise<void> {
    if (!this.isCleanedUp && this.processManager) {
      this.config.logger.log(
        `CodonRunner: Force killing process for codon ${this.config.codonId}`,
        "info",
      );
      await this.processManager.forceKill();
    }
  }

  /**
   * Check if the process is currently running
   */
  isRunning(): boolean {
    return this.processManager?.isRunning() ?? false;
  }

  /**
   * Get the process ID (if running)
   */
  getPid(): number | undefined {
    return this.processManager?.getPid();
  }

  /**
   * Get the prompt frontmatter (if any was parsed from the prompt file)
   */
  getPromptFrontmatter(): import("./prompt-frontmatter.js").PromptFrontmatter | undefined {
    return this.processManager?.promptFrontmatter;
  }

  /**
   * Clean up all resources owned by this runner
   *
   * This should be called when the codon execution is complete
   * (whether successful, failed, or skipped)
   */
  async cleanup(): Promise<void> {
    if (this.isCleanedUp) {
      this.config.logger.log(
        `CodonRunner: Already cleaned up for codon ${this.config.codonId}`,
        "debug",
      );
      return;
    }

    this.config.logger.log(
      `[CodonRunner.cleanup] ======= ENTERED cleanup for codon ${this.config.codonId} =======`,
      "info",
    );
    this.config.logger.log(
      `[CodonRunner.cleanup] hasProcessManager=${!!this
        .processManager}, hasLogParser=${!!this.logParser}`,
      "info",
    );

    this.config.logger.log(
      `CodonRunner: Cleaning up resources for codon ${this.config.codonId}`,
      "info",
    );

    // Log stack trace to understand why cleanup was called
    const stack = new Error().stack;
    this.config.logger.log(
      `[CLEANUP-STACK] Cleanup called from:\n${stack?.split("\n").slice(1, 6).join("\n")}`,
      "debug",
    );

    // Stop log parser
    if (this.logParser) {
      this.logParser.stop();
    }

    // Clean up process manager
    if (this.processManager) {
      this.processManager.removeAllListeners();
      await this.processManager.closeLogStream();
    }

    // Remove all our event listeners
    this.removeAllListeners();

    this.isCleanedUp = true;

    this.config.logger.log(
      `CodonRunner: Cleanup complete for codon ${this.config.codonId}`,
      "info",
    );
  }
}
