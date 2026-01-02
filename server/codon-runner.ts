import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAgentSDKManager } from "./claude-agent-sdk-manager.js";
import { ClaudeLogParser } from "./claude-log-parser.js";
import { TIMEOUTS } from "./config.js";
import { ShimProcessManager } from "./shim-process-manager.js";
import { TypedEventEmitter } from "./typed-event-emitter.js";
import type { CodonId, SessionId } from "./types/branded-types.js";
import type {
  AssistantMessage,
  ResultMessage,
  SystemMessage,
  UserMessage,
} from "./types/claude-session-schema.js";
import type { Codon } from "./types/types.js";
import type { Logger } from "./utils.js";

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
   * Detect if the model is an Anthropic model (Claude)
   */
  private isAnthropicModel(model: string): boolean {
    // Check for common Anthropic model names
    const anthropicKeywords = ["sonnet", "opus", "claude"];
    const modelLower = model.toLowerCase();

    return anthropicKeywords.some((keyword) => modelLower.includes(keyword));
  }

  /**
   * Create ClaudeLogParser for this codon with event forwarding
   */
  private createLogParser(): ClaudeLogParser {
    return new ClaudeLogParser({
      logPath: this.logPath,
      codonId: this.config.codonId,
      parsingInterval: this.config.logParsingInterval ?? 100,

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
    const model = this.config.codon.model;
    const isAnthropicModel = this.isAnthropicModel(model);

    let processManager: ShimProcessManager | ClaudeAgentSDKManager;

    if (isAnthropicModel) {
      // Use Claude Agent SDK for Anthropic models
      this.config.logger.log(`Using Claude Agent SDK for Anthropic model: ${model}`, "info");

      processManager = new ClaudeAgentSDKManager(
        this.config.executionPath,
        this.config.logger,
        this.logParser,
        this.config.anthropicBaseUrl,
        model,
      );
    } else {
      // Use Shim for non-Anthropic models (e.g., Gemini)
      this.config.logger.log(`Using Gemini shim for model: ${model}`, "info");

      processManager = new ShimProcessManager(
        this.config.executionPath,
        this.config.logger,
        this.logParser,
        this.config.anthropicBaseUrl,
        "gemini-3-pro-preview", // Hardcoded model override for gemini shim
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
      const __dirname = path.dirname(__filename);
      const shimPath = path.resolve(__dirname, "../shims/gemini/index.mjs");

      await this.processManager.spawn(
        ["bun", shimPath], // Hardcoded gemini shim command
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
      `CodonRunner: Cleaning up resources for codon ${this.config.codonId}`,
      "info",
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
