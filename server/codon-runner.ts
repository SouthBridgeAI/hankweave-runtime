import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAgentSDKManager } from "./claude-agent-sdk-manager.js";
import { ClaudeLogParser } from "./claude-log-parser.js";
import { TIMEOUTS } from "./config.js";
import type { ModelInfo } from "./llm/models-dev-schema.js";
import { ShimProcessManager } from "./shim-process-manager.js";
import {
  extractShimFiles,
  getExtractedShimPath,
  needsShimExtraction,
} from "./shim-runtime-extractor.js";
import { TypedEventEmitter } from "./typed-event-emitter.js";
import type { CodonId, SessionId } from "./types/branded-types.js";
import type {
  AssistantMessage,
  ResultMessage,
  SystemMessage,
  UserMessage,
} from "./types/claude-session-schema.js";
import type { Codon, ShimSelfTestResult } from "./types/types.js";
import { getRuntimeCommand, isCompiledExecutable, type Logger } from "./utils.js";

/**
 * Helper function to resolve shim path correctly for all execution contexts.
 *
 * Execution contexts:
 * 1. Source (development):
 *    - Current file is in server/codon-runner.ts
 *    - Shims are at shims/gemini/index.mjs (project root)
 *    - Need to go up one level: ../shims/gemini/index.mjs
 *
 * 2. Bundled NPX package (npx @southbridgeai/strandweave):
 *    - Current file is in dist/index.js (bundled)
 *    - Shims are at dist/shims/gemini/index.mjs
 *    - Need to use same directory: ./shims/gemini/index.mjs
 *
 * 3. Compiled executable (strandweave binary):
 *    - Shims are embedded in the executable
 *    - Extract to ~/.strandweave/shims/<version>/
 *    - Return path to extracted shim
 *
 * @param currentFilePath - Path to current file (from import.meta.url)
 * @returns Absolute path to the shim
 * @throws Error if shims are not available
 */
async function resolveShimPath(currentFilePath: string): Promise<string> {
  // Check if running from compiled executable
  if (isCompiledExecutable()) {
    // Extract shims if needed
    if (needsShimExtraction("gemini")) {
      await extractShimFiles();
    }

    // Return path to extracted gemini shim
    return getExtractedShimPath("gemini");
  }

  const currentDir = path.dirname(currentFilePath);

  // Check if we're running from dist (bundled NPX) or server (source)
  // When bundled, currentDir will contain '/dist'
  // When source, currentDir will contain '/server'
  const isRunningFromDist = currentDir.includes("/dist") || currentDir.includes("\\dist");

  if (isRunningFromDist) {
    // Running from dist/index.js -> shims are at dist/shims/
    return path.resolve(currentDir, "shims/gemini/index.mjs");
  }
  // Running from server/codon-runner.ts -> shims are at ../shims/
  return path.resolve(currentDir, "../shims/gemini/index.mjs");
}

/**
 * Events emitted by CodonRunner during execution
 */
export interface CodonRunnerEvents extends Record<string, unknown[]> {
  // Process lifecycle
  exit: [code: number, contextExceeded: boolean];
  error: [error: Error];

  // Log parser events (forwarded with specific types)
  systemMessage: [msg: SystemMessage];
  assistantMessage: [msg: AssistantMessage];
  userMessage: [msg: UserMessage];
  resultMessage: [msg: ResultMessage];

  // Process output
  stdout: [data: string];
  stderr: [data: string];
}

/**
 * Configuration for creating a CodonRunner
 */
export interface CodonRunnerConfig {
  codon: Codon;
  codonId: CodonId;
  executionPath: string;
  logger: Logger;
  logParsingInterval?: number;
  anthropicBaseUrl?: string;
  logPath: string;
}

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
export class CodonRunner extends TypedEventEmitter<CodonRunnerEvents> {
  private readonly config: CodonRunnerConfig;
  private readonly logParser: ClaudeLogParser;
  private readonly processManager: ShimProcessManager | ClaudeAgentSDKManager;
  private readonly logPath: string;
  private isCleanedUp = false;

  constructor(config: CodonRunnerConfig) {
    super();
    this.config = config;

    // Use provided log path or calculate default
    this.logPath = config.logPath;

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
   *
   * @param model - The ModelInfo to check
   * @returns true if the model can be executed, false otherwise
   */
  static canRun(model: ModelInfo): boolean {
    const supportedProviders = ["anthropic", "google"];
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

        const manager = new ClaudeAgentSDKManager(
          executionPath,
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
        const shimPath = await resolveShimPath(__filename);

        const manager = new ShimProcessManager(
          executionPath,
          logger,
          tempLogParser,
          anthropicBaseUrl,
        );

        result = await manager.runSelfTest(getRuntimeCommand(shimPath));
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

      // Forward log parser events to our listeners
      onSystemMessage: (msg) => this.emit("systemMessage", msg),
      onAssistantMessage: (msg) => this.emit("assistantMessage", msg),
      onUserMessage: (msg) => this.emit("userMessage", msg),
      onResultMessage: (msg) => this.emit("resultMessage", msg),
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
        this.config.logger,
        this.logParser,
        this.config.anthropicBaseUrl,
        // TODO: look into this
        undefined, // No runtime model override (would come from runtime config)
      );
    } else {
      // Use Shim for non-Anthropic models (e.g., Gemini)
      this.config.logger.log(
        `Using shim for model: ${modelInfo.name} (${modelInfo.providerId}/${modelInfo.modelId})`,
        "info",
      );

      processManager = new ShimProcessManager(
        this.config.executionPath,
        this.config.logger,
        this.logParser,
        this.config.anthropicBaseUrl,
        // TODO: look into this
        undefined, // No runtime model override (would come from runtime config)
      );
    }

    // Forward process manager events to our listeners
    processManager.on("exit", (code: number, isContextExceeded: boolean) => {
      this.emit("exit", code, isContextExceeded);
    });

    processManager.on("error", (error: Error) => {
      this.emit("error", error);
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
   * Start executing the codon
   *
   * @param previousSessionId - Optional session ID to continue from
   */
  async run(previousSessionId?: SessionId): Promise<void> {
    this.config.logger.log(
      `CodonRunner: Starting execution of codon ${this.config.codonId}`,
      "info",
    );

    // Spawn using the appropriate method based on process manager type
    if (this.processManager instanceof ClaudeAgentSDKManager) {
      // Claude Agent SDK doesn't need a command array
      await this.processManager.spawn(this.config.codon, previousSessionId || null, this.logPath);
    } else {
      // ShimProcessManager needs command array
      const __filename = fileURLToPath(import.meta.url);
      const shimPath = await resolveShimPath(__filename);

      await this.processManager.spawn(
        getRuntimeCommand(shimPath),
        this.config.codon,
        previousSessionId || null,
        this.logPath,
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
   * Kill the running process
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
