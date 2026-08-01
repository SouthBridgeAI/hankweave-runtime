import os from "node:os";
import path from "node:path";
import type { Budget } from "./budget.js";
import { ClaudeAgentSDKManager } from "./claude-agent-sdk-manager.js";
import { ClaudeLogParser } from "./claude-log-parser.js";
import { TIMEOUTS } from "./config.js";
import { CostTracker } from "./cost-tracker.js";
import { classifyApiErrorText } from "./error-classification.js";
import type { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import type { ModelInfo } from "./llm/models-dev-schema.js";
import { PiSdkManager } from "./pi-sdk-manager.js";
import { isSupportedCodonProvider } from "./provider-ids.js";
import { ReplayProcessManager } from "./replay-process-manager.js";
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
import { APITimeoutError } from "./types/error-types.js";
import type { ClaudeLogMessage, Codon, ShimSelfTestResult, TokenUsage } from "./types/types.js";
import { isSyntheticTimeout } from "./types/types.js";
import type { Logger } from "./utils.js";

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

  // Live-display only: emitted when the runner classifies a failure from an
  // error result or a timeout. The runtime forwards it as a non-fatal error
  // event and stores nothing — the authoritative record is getOutcome(). SDK
  // crashes do NOT emit this; their failure surfaces via codon.completed.
  codonFailure: [data: { reason: FailureReason; error?: Error }];

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
 * - Create and manage the process manager (Claude SDK / Pi SDK / replay) for this codon
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
 * The per-attempt outcome of a codon execution, read once by the runtime in
 * handleCodonComplete. CodonRunner owns "what happened"; the runtime owns
 * "what to do" (final status, failure policy, state transitions). All fields
 * are final by the time the runner emits `exit`.
 */
export interface CodonOutcome {
  /** A terminal result message was parsed for the current attempt */
  resultReceived: boolean;
  /** The result was a genuine success (subtype:"success" with is_error:false) */
  success: boolean;
  /**
   * The result was an error (subtype:"error" or disguised success+is_error).
   * Tracked separately from failureReason because the SDK's empty error
   * placeholder (result:"") contributes no classifiable text, so it derives to
   * no failureReason — yet must still count as an error result.
   */
  errorResultReceived: boolean;
  /** Classified failure, if any (error result text, timeout, or crash) */
  failureReason?: FailureReason;
  /** The Error behind failureReason (e.g. APITimeoutError) — for telemetry stacks */
  failureError?: Error;
  /** Whether the agent session was ever established this attempt */
  sessionEstablished: boolean;
}

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

  // Cannot extend if the result was an error — including the SDK's empty
  // placeholder (result:""), which derives no failureReason but must still
  // fail the codon rather than re-prompt it.
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

/**
 * Derive the attempt's failure classification from raw evidence — the single
 * classification site for everything CodonRunner observes. Handlers record
 * evidence only, never a verdict, so the outcome is a pure function of what
 * happened and cannot depend on which handler wrote first (empty result text
 * — the SDK placeholder — simply contributes no evidence).
 *
 * Priority (first match wins):
 * 1. Non-empty error-result text — the real upstream error, which beats the
 *    (often less specific) thrown crash text. The typed APITimeoutError rides
 *    along when present; otherwise the crash Error is attached for telemetry.
 * 2. A runner-initiated assistant-message timeout (the session hung and was
 *    torn down; no result will ever arrive).
 * 3. The thrown SDK crash error, gated on session establishment: unrecognized
 *    crash text before the first message is a local setup failure.
 * 4. No evidence → undefined (the runtime synthesizes a backstop).
 */
export function deriveAttemptFailure(evidence: {
  /** Raw text of the last error-shaped result ("" for none or the SDK placeholder) */
  errorResultText: string;
  /** Typed APITimeoutError built from the CLI's exact timeout result text */
  resultTimeoutError?: Error;
  /** Typed APITimeoutError from a runner-initiated assistant-timeout teardown */
  assistantTimeoutError?: Error;
  /** The error the SDK process manager raised (crash / post-result throw) */
  crashError?: Error;
  sessionEstablished: boolean;
}): { reason: FailureReason; error?: Error } | undefined {
  if (evidence.errorResultText) {
    return {
      reason: classifyApiErrorText(evidence.errorResultText),
      error: evidence.resultTimeoutError ?? evidence.crashError,
    };
  }
  if (evidence.assistantTimeoutError) {
    return {
      reason: {
        type: "timeout",
        retriable: true,
        message: "API Error: Request timed out.",
      },
      error: evidence.assistantTimeoutError,
    };
  }
  if (evidence.crashError) {
    return {
      reason: classifyApiErrorText(evidence.crashError.message, {
        sessionEstablished: evidence.sessionEstablished,
      }),
      error: evidence.crashError,
    };
  }
  return undefined;
}

export class CodonRunner extends TypedEventEmitter<CodonRunnerEvents> {
  private readonly config: CodonRunnerConfig;
  private readonly logParser: ClaudeLogParser;
  // CostTracker: "how much did this cost?" — computes cost from raw API usage via LLM registry
  private readonly costTracker: CostTracker;
  private processManager: ClaudeAgentSDKManager | PiSdkManager | ReplayProcessManager;
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
  // success+is_error). Tracked separately from the failure evidence below
  // because an empty error result (the SDK placeholder, result:"") carries no
  // classifiable text, yet must still block extension.
  private errorResultReceived = false;
  // Failure EVIDENCE, never a verdict: classification happens exclusively in
  // deriveAttemptFailure at read time. Do not add a stored FailureReason field
  // back — write-ordering shadow bugs are exactly what this shape eliminates.
  private errorResultText = "";
  private resultTimeoutError: Error | undefined = undefined;
  private assistantTimeoutError: Error | undefined = undefined;
  private crashError: Error | undefined = undefined;
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
   * - Anthropic models via ClaudeAgentSDKManager (in-process Claude SDK)
   * - Everything else via PiSdkManager (in-process Pi coding agent); model
   *   validation rewrites google/openai/GLM/Kimi/etc. spellings to pi/...
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
        // Use the in-process Pi SDK manager for non-Anthropic models
        logger.log(
          `Testing Pi SDK for model: ${modelInfo.name} (${modelInfo.providerId}/${modelInfo.modelId})`,
          "info",
        );

        // For self-tests, use executionPath as agentRootPath (temporary directory, no nested structure)
        const manager = new PiSdkManager(
          executionPath,
          executionPath, // Self-tests don't need the full nested structure
          logger,
          tempLogParser,
        );

        result = await manager.runSelfTest(modelInfo.modelId);
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
        // Timeout messages are classified and torn down, not forwarded (no
        // assistant.action event is emitted for timeout text).
        if (this.detectAssistantTimeout(msg)) {
          return;
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

        // Record failure EVIDENCE (no verdict — see deriveAttemptFailure) for
        // explicit error results and disguised errors (success + is_error).
        // The SDK strips `result` from `subtype:"error"` messages
        // (ClaudeAgentSDKManager.convertSDKMessageToJSONL fills `result:""`);
        // that placeholder records an empty string, which derivation ignores so
        // the SDK's subsequently THROWN error classifies authoritatively.
        if (msg.subtype === "error" || (msg.subtype === "success" && msg.is_error)) {
          // Recorded even without text, so the empty placeholder still blocks
          // extension.
          this.errorResultReceived = true;
          // Some passthrough shapes carry the real text in an `error` field
          // alongside an empty `result`; without the fallback a permanent
          // billing/auth error there would fall to the retriable backstop.
          const passthroughError = (msg as { error?: unknown }).error;
          const resultText =
            String(msg.result || "") ||
            (typeof passthroughError === "string" ? passthroughError : "");
          this.errorResultText = resultText;
          if (resultText) {
            // Classified locally ONLY for the live codonFailure display event;
            // the authoritative classification happens in deriveAttemptFailure.
            const reason = classifyApiErrorText(resultText);
            // Only the Claude CLI's exact timeout text gets the typed
            // APITimeoutError (whose message is Claude-specific). Other
            // timeout-classified results (e.g. the Pi agent's idle timeout)
            // keep their real provider text in reason.message and carry no
            // Error here.
            let failureError: Error | undefined;
            if (reason.type === "timeout" && resultText === "API Error: Request timed out.") {
              failureError = new APITimeoutError(this.config.codonId as string, {
                message: resultText,
                timestamp: new Date().toISOString(),
                is_error: msg.is_error,
                duration_ms: msg.duration_ms,
                duration_api_ms: msg.duration_api_ms,
              });
              this.resultTimeoutError = failureError;
            }
            this.emit("codonFailure", { reason, error: failureError });
          }
        }

        this.emit("resultMessage", msg);
      },
    });
  }

  /**
   * Detect an API timeout surfaced through an ASSISTANT message. Two shapes:
   * the CLI's synthetic message (model "<synthetic>", string content) and a
   * plain text content item reading exactly "API Error: Request timed out."
   *
   * On detection: record the APITimeoutError, emit codonFailure for live
   * display, and tear the process down — the session is hung mid-request and
   * will never produce a result. Returns true when the message was a timeout
   * (caller suppresses forwarding).
   */
  private detectAssistantTimeout(msg: AssistantMessage): boolean {
    const synthetic = isSyntheticTimeout(msg as ClaudeLogMessage);
    let textTimeout = false;
    if (!synthetic) {
      // Content may be a plain string (the schema allows both shapes); a
      // string-content timeout must match too.
      const content = msg.message.content;
      const items = Array.isArray(content) ? content : [{ type: "text" as const, text: content }];
      textTimeout = items.some(
        (item) =>
          "text" in item && item.type === "text" && item.text === "API Error: Request timed out.",
      );
    }
    if (!synthetic && !textTimeout) return false;

    this.config.logger.log(
      `[CodonRunner] API timeout detected in ${synthetic ? "synthetic" : "assistant"} message for codon ${this.config.codonId}`,
      "error",
    );

    const timeoutError = new APITimeoutError(this.config.codonId as string, {
      message: "API Error: Request timed out.",
      timestamp: new Date().toISOString(),
      ...(synthetic ? { synthetic: true } : {}),
    });
    this.assistantTimeoutError = timeoutError;
    // errorResultReceived stays false: no RESULT message arrived — the timeout
    // evidence derives a failureReason, which alone blocks extension in
    // shouldExtendCodon.
    this.emit("codonFailure", {
      reason: { type: "timeout", retriable: true, message: "API Error: Request timed out." },
      error: timeoutError,
    });

    this.kill().catch((err) => {
      this.config.logger.log(
        `[CodonRunner] Failed to kill timed-out process for codon ${this.config.codonId}: ${err}`,
        "error",
      );
    });
    return true;
  }

  /**
   * Create process manager (SDK, Shim, or Replay) based on model type with event forwarding
   */
  private createProcessManager(): ClaudeAgentSDKManager | PiSdkManager | ReplayProcessManager {
    let processManager: ClaudeAgentSDKManager | PiSdkManager | ReplayProcessManager;

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
      } else if (modelInfo.providerId.toLowerCase() === "pi") {
        // Everything non-Anthropic runs on the IN-PROCESS Pi SDK — like the
        // Claude SDK, not as a child shim. Model validation has already
        // rewritten google/openai/GLM/Kimi/opencode spellings to pi/...
        this.config.logger.log(
          `Using in-process Pi SDK for model: ${modelInfo.name} (${modelInfo.providerId}/${modelInfo.modelId})`,
          "info",
        );

        processManager = new PiSdkManager(
          this.config.executionPath,
          this.config.agentRootPath,
          this.config.logger,
          this.logParser,
          this.config.globalSystemPrompt ?? null,
          this.config.shimIdleTimeout,
        );
      } else {
        throw new Error(
          `No process manager available for provider: ${modelInfo.providerId} (model: ${modelInfo.modelId})`,
        );
      }
    }

    // Forward process manager events to our listeners
    // The exit handler implements the internal extension loop
    processManager.on("exit", (code: number, isContextExceeded: boolean) => {
      this.handleProcessExit(code, isContextExceeded);
    });

    // The in-process SDK managers (Claude Agent SDK, Pi SDK) surface *API/SDK*
    // crashes through their `error` event (a rejected query/run promise).
    // ReplayProcessManager emits `error` solely for LOCAL failures — those
    // carry no API status and must stay fatal, never get classified as a
    // retriable API crash.
    const isInProcessSdkManager =
      processManager instanceof ClaudeAgentSDKManager || processManager instanceof PiSdkManager;

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
      } else if (!isInProcessSdkManager) {
        // Non-SDK manager (replay): this `error` event is a LOCAL failure
        // (missing source log, bad cwd), not an API crash.
        // classifyApiErrorText would default its unfamiliar text to retriable
        // and wrongly route it into the exit/retry path — or, under
        // onFailure:abort, leak an exit(1) that leaves the runtime active
        // instead of failing the run. Keep it fatal.
        this.emit("error", error);
      } else {
        // An SDK/API crash without a clean success (mid-conversation crash
        // with no result, or an error result followed by a throw). Record the
        // thrown error as evidence and route through the EXIT path — never a
        // runner "error", which the runtime escalates to FATAL shutdown,
        // bypassing handleCodonComplete and the failure policy entirely.
        // Exiting with the classified reason lets the policy decide:
        // retriable+retry → retry, permanent → shutdown for abort/retry,
        // continue for ignore.
        this.crashError = error;
        const derived = this.deriveFailure();
        this.config.logger.log(
          `[CodonRunner] SDK crash classified ${
            derived?.reason.retriable ? "retriable" : "permanent"
          } — routing to exit path for failure policy: ${error.message}`,
          "error",
        );
        // Context-exceeded detection must ride along: the Claude SDK surfaces
        // input overflow as an error result and THEN throws, so this is the
        // only exit path that error takes — the manager's own emitExit() never
        // runs. Passing `false` here would fail a `terminateOn:
        // contextExceeded` loop instead of terminating it. Pinned by
        // tests/integration/claude-sdk-context-exceeded-mock.test.ts.
        this.emit("exit", 1, processManager.detectContextExceeded(), this.extensionCount);
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
      failureReason: this.deriveFailure()?.reason,
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
    this.errorResultText = "";
    this.resultTimeoutError = undefined;
    this.assistantTimeoutError = undefined;
    this.crashError = undefined;
    this.successResultReceived = false;

    // Keep log parser running (don't stop/restart to avoid re-parsing entire log)
    // The parser will continue tracking from its current position

    // Re-run with the extension prompt
    await this.runExtension(sessionId, extensionPrompt);
  }

  /**
   * Spawn the underlying process manager using a unified adapter.
   * All managers (SDK, Pi, Replay) share the same spawn signature.
   */
  private async spawnCodonProcess(
    sessionToResume: SessionId | null,
    options: {
      logPath?: string;
      exhaustionPrompt?: string;
    },
  ): Promise<void> {
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
    this.errorResultText = "";
    this.resultTimeoutError = undefined;
    this.assistantTimeoutError = undefined;
    this.crashError = undefined;
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
   * Classify the current attempt's failure evidence. Pure over the recorded
   * evidence, so every caller gets the same answer for the same evidence.
   */
  private deriveFailure(): { reason: FailureReason; error?: Error } | undefined {
    return deriveAttemptFailure({
      errorResultText: this.errorResultText,
      resultTimeoutError: this.resultTimeoutError,
      assistantTimeoutError: this.assistantTimeoutError,
      crashError: this.crashError,
      sessionEstablished: this.getSystemMessageReceived(),
    });
  }

  /**
   * The per-attempt outcome (see CodonOutcome), read once by the runtime in
   * handleCodonComplete. All evidence is recorded before an exit can be
   * emitted, so this is final by the time `exit` fires.
   */
  getOutcome(): CodonOutcome {
    const derived = this.deriveFailure();
    return {
      resultReceived: this.resultMessageReceived,
      success: this.successResultReceived,
      errorResultReceived: this.errorResultReceived,
      failureReason: derived?.reason,
      failureError: derived?.error,
      sessionEstablished: this.getSystemMessageReceived(),
    };
  }

  /**
   * Whether the agent session was established (first system/init message
   * observed). Gates the retriability of unrecognized crashes: dying before
   * establishment is a local setup failure.
   *
   * ORs the log-parser-fed flag with the SDK managers' synchronous
   * `getSessionEstablished()`: both SDKs emit "error" without force-parsing
   * the log, so the parser-fed flag can lag a genuine establishment and
   * misclassify an established-session crash as a permanent pre-session
   * failure, skipping onFailure: "retry".
   */
  getSystemMessageReceived(): boolean {
    return (
      this.systemMessageReceived ||
      ((this.processManager instanceof ClaudeAgentSDKManager ||
        this.processManager instanceof PiSdkManager) &&
        this.processManager.getSessionEstablished())
    );
  }

  /**
   * Whether this attempt's result message has been parsed out of the log.
   *
   * Used by `handleCodonComplete` to decide when the parser has genuinely
   * caught up: on every exit path `emitExit` force-parses the log before the
   * exit event fires, so this is normally already true when the runtime's
   * completion handler runs — the exception is a result line still buffered in
   * the manager's write stream at that moment, which the next `parseLog()`
   * picks up.
   */
  hasResultMessage(): boolean {
    return this.resultMessageReceived;
  }

  /**
   * Synchronously re-parse the codon log from the parser's last position.
   * Idempotent and cheap; exists so the completion path can drain the log on
   * demand instead of sleeping for a poll interval.
   */
  parseLog(): void {
    this.logParser.parseNow();
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
