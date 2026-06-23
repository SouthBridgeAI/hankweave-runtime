import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Budget } from "./budget.js";
import { ClaudeAgentSDKManager } from "./claude-agent-sdk-manager.js";
import { ClaudeLogParser } from "./claude-log-parser.js";
import { TIMEOUTS } from "./config.js";
import { CostTracker } from "./cost-tracker.js";
import { classifyApiErrorText } from "./error-classification.js";
import type { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import type { ModelInfo } from "./llm/models-dev-schema.js";
import { isSupportedCodonProvider } from "./provider-ids.js";
import { ReplayProcessManager } from "./replay-process-manager.js";
import { ShimProcessManager } from "./shim-process-manager.js";
import {
  extractShimFiles,
  getExtractedShimPath,
  needsShimExtraction,
} from "./shim-runtime-extractor.js";
import type { StateManager } from "./state-manager.js";
import { TypedEventEmitter } from "./typed-event-emitter.js";
import type { CodonId, RunId, SessionId } from "./types/branded-types.js";
import type { BudgetExceededInfo } from "./types/budget-types.js";
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
  type ShimName = "gemini" | "codex" | "pi" | "opencode";

  // Map provider ID to shim name
  const shimNameMap: Record<string, ShimName> = {
    google: "gemini",
    openai: "codex",
    pi: "pi",
    opencode: "opencode",
  };

  const shimName = shimNameMap[providerId.toLowerCase()];
  if (!shimName) {
    throw new Error(`No shim available for provider: ${providerId}`);
  }

  // Check if running from compiled executable
  if (isCompiledExecutable()) {
    // Extract shims if needed
    if (needsShimExtraction(shimName)) {
      await extractShimFiles();
    }

    // Return path to extracted shim
    return getExtractedShimPath(shimName);
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
  budget: Budget;
  /** If provided, use ReplayProcessManager instead of real process managers */
  replayConfig?: {
    /** Absolute path to the source JSONL log file to replay */
    sourceLogPath: string;
    /** Delay in ms between writing lines (default: 5) */
    replaySpeed?: number;
  };
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
 * Failure reasons that prevent extension.
 * Shared with the runtime's failure-policy machinery (see event-schemas.ts).
 */
type FailureReason = import("./types/types.js").FailureReason;

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
  isBudgetExceeded?: boolean;
  errorResultReceived?: boolean;
}): boolean {
  // Cannot extend if no extension config
  if (!params.extensionConfig) return false;

  // Cannot extend if the result was an error. An empty subtype:"error" result is
  // the SDK placeholder (result:""); it intentionally leaves failureReason unset
  // so a later thrown error can be classified authoritatively, but it must still
  // block extension — the codon should fail, not be re-prompted.
  if (params.errorResultReceived) return false;

  // Cannot extend if interrupted (user skip/force-stop)
  if (params.isInterrupted) return false;

  // Cannot extend if budget exceeded
  if (params.isBudgetExceeded) return false;

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
  // CostTracker: "how much did this cost?" — computes cost from raw API usage via LLM registry
  private readonly costTracker: CostTracker;
  private processManager: ShimProcessManager | ClaudeAgentSDKManager | ReplayProcessManager;
  private readonly logPath: string;
  private readonly budgetExceededListener: (data: {
    codonId: string;
    info: BudgetExceededInfo;
  }) => void;
  private isCleanedUp = false;

  // Track successful result for post-success SDK error handling
  // See: intermediates/31-fixing-claude-sdk-bug/bug_investigation.md
  private successResultReceived = false;

  // Extension state - tracked internally
  private extensionCount = 0;
  private resultMessageReceived = false;
  // Whether the received result was an error (subtype:"error" or a disguised
  // success+is_error). Tracked separately from failureReason because an empty
  // error result (the SDK placeholder, result:"") leaves failureReason unset by
  // design, yet must still block extension.
  private errorResultReceived = false;
  private failureReason: FailureReason | undefined = undefined;
  private currentSessionId: SessionId | null = null;
  // Whether this codon attempt observed its first system/init message (the
  // session was established). Gates retriability of unrecognized crashes: a
  // process that died before establishing a session is a local setup failure,
  // not a transient API error. Monotonic within an attempt; reset on a fresh run.
  private systemMessageReceived = false;

  constructor(config: CodonRunnerConfig) {
    super();
    this.config = config;

    // Use provided log path or calculate default
    this.logPath = config.logPath;

    // Create cost tracker for this codon
    this.costTracker = new CostTracker(config.codon.model, config.llmRegistry, config.logger);

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

    // Initialize budget tracking — Budget subscribes to CostTracker internally
    config.budget.trackCodon(config.codonId, config.codon, this.costTracker);

    // Handle budget exceeded: Budget emits event, we kill the process
    this.budgetExceededListener = (data) => {
      if (data.codonId === (config.codonId as string)) {
        config.logger.log(`Budget exceeded for ${config.codonId}: ${data.info.message}`, "error");
        this.kill("SIGTERM");
      }
    };
    config.budget.on("exceeded", this.budgetExceededListener);

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
   * - DeepSeek, Pi, and OpenCode models via ShimProcessManager
   *
   * @param model - The ModelInfo to check
   * @returns true if the model can be executed, false otherwise
   */
  static canRun(model: ModelInfo): boolean {
    return isSupportedCodonProvider(model.providerId);
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
        // A system message means the agent process got far enough to start a
        // session — used to gate crash retriability (see getSystemMessageReceived).
        this.systemMessageReceived = true;
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
        // Track successful completion for post-success SDK error handling.
        // The SDK reports some API failures as subtype="success" with
        // is_error=true (disguised errors) — those are NOT successes, and
        // treating them as such would route the SDK's subsequent thrown error
        // through the post-success suppression path, masking the real failure.
        if (msg.subtype === "success" && !msg.is_error) {
          this.successResultReceived = true;
        }
        if (msg.subtype === "success") {
          // Process cost tracking for success results (tokens are spent even on is_error=true)
          this.costTracker.handleResultUsage(msg);
        }

        // Track that we received a result message (needed for extension decision)
        this.resultMessageReceived = true;

        // Check for failure reasons that would prevent extension:
        // explicit error results and disguised errors (success + is_error).
        //
        // Only classify when the result carries real text. The SDK strips the
        // `result` field from `subtype:"error"` messages (see
        // ClaudeAgentSDKManager.convertSDKMessageToJSONL, which fills `result:""`),
        // so classifying that empty placeholder always yields the default-retriable
        // api-error — and because the SDK-crash path prefers `this.failureReason ??
        // classifyApiErrorText(error.message)`, that placeholder would shadow the
        // REAL thrown billing/auth/400 error and wrongly retry a permanent failure.
        // Leaving `failureReason` unset here lets the later thrown error be
        // classified authoritatively. Disguised errors (success + is_error) keep
        // their real `result` text, so they still classify correctly.
        if (msg.subtype === "error" || (msg.subtype === "success" && msg.is_error)) {
          // Record the error regardless of whether it carries text, so the empty
          // placeholder still blocks extension even though we leave failureReason
          // unset for the later thrown error to classify.
          this.errorResultReceived = true;
          const resultText = String(msg.result || "");
          if (resultText) {
            this.failureReason = classifyApiErrorText(resultText);
          }
        }

        this.emit("resultMessage", msg);
      },
    });
  }

  /**
   * Create process manager (SDK, Shim, or Replay) based on model type with event forwarding
   */
  private createProcessManager():
    | ShimProcessManager
    | ClaudeAgentSDKManager
    | ReplayProcessManager {
    let processManager: ShimProcessManager | ClaudeAgentSDKManager | ReplayProcessManager;

    // Replay mode: use ReplayProcessManager instead of real process managers
    if (this.config.replayConfig) {
      this.config.logger.log(
        `Using ReplayProcessManager for codon ${this.config.codonId} (source: ${this.config.replayConfig.sourceLogPath})`,
        "info",
      );

      processManager = new ReplayProcessManager(
        this.config.executionPath,
        this.config.logger,
        this.logParser,
        this.config.replayConfig.sourceLogPath,
        this.config.replayConfig.replaySpeed,
      );
    } else {
      const modelInfo = this.config.codon.model;
      const isAnthropicModel = modelInfo.providerId.toLowerCase() === "anthropic";

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
    }

    // Forward process manager events to our listeners
    // The exit handler implements the internal extension loop
    processManager.on("exit", (code: number, isContextExceeded: boolean) => {
      this.handleProcessExit(code, isContextExceeded);
    });

    // Only the Claude Agent SDK manager surfaces *API/SDK* crashes through its
    // `error` event (a rejected queryPromise). ShimProcessManager and
    // ReplayProcessManager emit `error` solely for LOCAL child-process failures
    // (missing node/bun, bad cwd, an unexecutable shim) — those carry no API
    // status and must stay fatal, never get classified as a retriable API crash.
    const isClaudeAgentSDKManager = processManager instanceof ClaudeAgentSDKManager;

    processManager.on("error", (error: Error) => {
      // Handle budget exceeded: process was killed by us due to budget limit.
      // Convert to normal exit so handleCodonComplete can process the budget exceeded state.
      if (this.config.budget.isExceeded(this.config.codonId)) {
        this.config.logger.log(
          `[CodonRunner] Budget exceeded abort suppressed: ${error.message}`,
          "info",
        );
        this.emit("exit", 0, false, this.extensionCount);
        return;
      }

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
      } else if (!isClaudeAgentSDKManager) {
        // Non-SDK manager (shim/replay): this `error` event is a LOCAL
        // child-process failure (missing node/bun, bad cwd, unexecutable shim),
        // not an API crash. classifyApiErrorText would default its unfamiliar
        // text to retriable and wrongly route it into the exit/retry path — or,
        // under onFailure:abort, leak an exit(1) that leaves the runtime active
        // instead of failing the run. Keep it fatal. (Shim *API* errors travel
        // the exit path and are handled by synthesizeMissingFailureReason in
        // handleCodonComplete, never this listener.)
        this.emit("error", error);
      } else {
        // The SDK process raised an error without a clean success. Two shapes
        // converge here and both must honor `onFailure: retry`:
        //   - the subprocess crashed mid-conversation with NO result
        //     message (e.g. a 5xx/overloaded error that exhausted the SDK's own
        //     internal retries, or a dropped socket).
        //   - the SDK first emitted a retriable error result — including
        //     a disguised `subtype:"success", is_error:true` socket drop — which
        //     onResultMessage already classified into `this.failureReason`, and
        //     THEN threw.
        //
        // Decide on retriability, not on whether a result arrived: prefer the
        // reason classified from the result (it carries the real upstream error),
        // otherwise classify the crash text. Unrecognized text defaults to
        // retriable (bounded by retryConfig.maxAttempts) per classifyApiErrorText.
        //
        // Either way (retriable OR permanent) the failure is an SDK/API outcome,
        // so route it through the EXIT path with the classified reason rather
        // than emitting a runner "error": the runtime escalates runner errors to
        // FATAL shutdown, which never runs handleCodonComplete/resolveFailurePolicy
        // — skipping codon failed-state recording and overriding a codon
        // configured `onFailure: "ignore"`. Exiting lets resolveFailurePolicy
        // decide: retriable+retry → retry, permanent (billing/auth/400) → shutdown
        // for abort/retry but continue for ignore.
        //
        // Gate the thrown-error classification on session establishment: a crash
        // before the first message, with text matching no known transient API
        // pattern, is a local setup failure (bad executable, spawn error, bad
        // cwd) — non-retriable. A prior result-classified reason still wins.
        const failureReason =
          this.failureReason ??
          classifyApiErrorText(error.message, {
            sessionEstablished: this.getSystemMessageReceived(),
          });
        this.failureReason = failureReason;
        this.config.logger.log(
          `[CodonRunner] SDK crash classified ${
            failureReason.retriable ? "retriable" : "permanent"
          } — routing to exit path for failure policy: ${error.message}`,
          "error",
        );
        // Non-zero exit so handleCodonComplete marks the codon failed and the
        // runtime consults resolveFailurePolicy with the classified reason.
        this.emit("exit", 1, false, this.extensionCount);
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
    const isBudgetExceeded = this.config.budget.isExceeded(this.config.codonId);

    const shouldExtend = shouldExtendCodon({
      exitCode: code,
      resultMessageReceived: this.resultMessageReceived,
      isContextExceeded,
      extensionConfig: this.config.extensionConfig,
      extensionCount: this.extensionCount,
      isInterrupted,
      failureReason: this.failureReason,
      isBudgetExceeded,
      errorResultReceived: this.errorResultReceived,
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
    this.errorResultReceived = false;
    this.failureReason = undefined;
    this.successResultReceived = false;

    // Keep log parser running (don't stop/restart to avoid re-parsing entire log)
    // The parser will continue tracking from its current position

    // Re-run with the extension prompt
    await this.runExtension(sessionId, extensionPrompt);
  }

  /**
   * Spawn the underlying process manager using a unified adapter.
   * ShimProcessManager requires a runtime command array; SDK/Replay do not.
   */
  private async spawnCodonProcess(
    sessionToResume: SessionId | null,
    options: {
      logPath?: string;
      exhaustionPrompt?: string;
    },
  ): Promise<void> {
    if (this.processManager instanceof ShimProcessManager) {
      const __filename = fileURLToPath(import.meta.url);
      const shimPath = await resolveShimPath(__filename, this.config.codon.model.providerId);

      await this.processManager.spawn(
        getRuntimeCommand(shimPath),
        this.config.codon,
        sessionToResume,
        options,
      );
      return;
    }

    // ReplayProcessManager and ClaudeAgentSDKManager share this signature
    await this.processManager.spawn(this.config.codon, sessionToResume, options);
  }

  /**
   * Internal method to run an extension (resume session with exhaustion prompt).
   *
   * Uses the same spawn() method as initial run, but with exhaustionPrompt option.
   * This activates exhaustion mode: appends to log, forces resume.
   */
  private async runExtension(sessionId: SessionId, exhaustionPrompt: string): Promise<void> {
    await this.spawnCodonProcess(sessionId, {
      logPath: this.logPath,
      exhaustionPrompt,
    });

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
    this.errorResultReceived = false;
    this.failureReason = undefined;
    this.currentSessionId = null;
    // Establishment is tracked per attempt: a fresh run starts not-established.
    // (Not reset in performExtension — an extension continues the same session.)
    this.systemMessageReceived = false;

    this.config.logger.log(
      `CodonRunner: Starting execution of codon ${this.config.codonId}`,
      "info",
    );

    await this.spawnCodonProcess(previousSessionId || null, {
      logPath: this.logPath,
    });

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
   * The classified failure reason for the current attempt, if one was derived
   * from an error result message or a transient mid-stream crash. The runtime
   * adopts this on the exit path when it has no result-message-derived reason of
   * its own, so `onFailure: retry` can act on SDK crashes that never produced a
   * terminal result.
   */
  getFailureReason(): FailureReason | undefined {
    return this.failureReason;
  }

  /**
   * Whether the agent session was established (first system/init message
   * observed) before any failure. Used to gate the retriability of unrecognized
   * crashes: a process that dies before establishing a session, with text we
   * don't recognize as a transient API error, is a local setup failure, not a
   * transient one.
   *
   * ORs the log-parser-fed flag with the SDK manager's synchronous signal: the
   * SDK emits "error" after cleanup() without force-parsing the log, so the
   * parser-fed flag can lag a genuine establishment — `getSessionEstablished()`
   * (derived from the session id captured in the message loop) closes that race.
   */
  getSystemMessageReceived(): boolean {
    return (
      this.systemMessageReceived ||
      (this.processManager instanceof ClaudeAgentSDKManager &&
        this.processManager.getSessionEstablished())
    );
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

    // Unsubscribe from shared Budget instance to prevent listener leaks
    this.config.budget.off("exceeded", this.budgetExceededListener);

    // Remove all our event listeners
    this.removeAllListeners();

    this.isCleanedUp = true;

    this.config.logger.log(
      `CodonRunner: Cleanup complete for codon ${this.config.codonId}`,
      "info",
    );
  }
}
