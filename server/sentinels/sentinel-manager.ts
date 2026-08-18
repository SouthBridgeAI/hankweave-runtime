import { promises as fs } from "node:fs";
import * as path from "node:path";
import { generateObject, generateText } from "ai";
import { LlmProviderRegistry } from "../llm/llm-provider-registry.js";
import type { ServerEvent } from "../schemas/event-schemas.js";
import { type CodonId, EventId } from "../types/branded-types.js";
import type {
  HankweaveGenerateObjectOptions,
  HankweaveGenerateObjectResult,
  HankweaveGenerateTextOptions,
  HankweaveGenerateTextResult,
} from "../types/llm-call-types.js";
import type { SentinelConfig } from "../types/sentinel-types.js";
import { generateId, type Logger } from "../utils.js";
import { Sentinel } from "./sentinel.js";
import { SentinelFatalError } from "./sentinel-fatal-error.js";

export interface SentinelManagerOptions {
  logger?: Logger;
  waitForHealthChecks?: boolean; // Option to wait for provider health checks
  healthCheckGracePeriodMs?: number; // Grace period to wait for health checks before loading sentinels
  enablePersistence?: boolean; // Allow disabling persistence for testing
  providerRegistry?: LlmProviderRegistry;
  rootDirectory?: string; // Root directory for sentinel files (default: current working directory)
}

/**
 * Manages multiple Sentinel instances for a codon.
 *
 * The SentinelManager orchestrates the lifecycle of all sentinels within a codon,
 * handling event distribution, error management, and resource cleanup. It provides:
 *
 * - **Provider Integration**: Coordinates with LlmProviderRegistry for model availability
 * - **Lifecycle Management**: Loads sentinels, distributes events, handles shutdown
 * - **Error Handling**: Implements three-category fatal error framework with smart unloading
 * - **Resource Management**: Manages filesystem persistence and provider health monitoring
 *
 * Initialization Pattern: Explicit async initialize() method
 * Rationale: Shared resource (filesystem directory) needs setup before sentinels
 * can be created. Explicit call allows caller to control timing and handle failures.
 *
 * @example
 * const manager = new SentinelManager({
 *   logger,
 *   healthCheckGracePeriodMs: 300
 * });
 * await manager.initialize();
 * await manager.loadSentinelsForCodon(configs, codonId, llmCall);
 */
export class SentinelManager {
  private sentinels: Sentinel[] = [];
  private sentinelDir?: string;
  private isDirectoryInitialized = false;
  private sentinelConfigs: Map<string, SentinelConfig> = new Map();
  private sentinelFailureCounts: Map<string, number> = new Map();
  private providerRegistry: LlmProviderRegistry;
  private healthCheckPromise?: Promise<void>;
  private providerInitPromise?: Promise<void>;
  private logger?: Logger;
  private options: SentinelManagerOptions;
  private codonId?: CodonId;
  private executionPath?: string;

  constructor(options: SentinelManagerOptions = {}) {
    this.options = options;
    this.logger = options.logger;

    // Set up sentinel directory if persistence is enabled
    if (options.enablePersistence !== false) {
      const root = options.rootDirectory || ".";
      this.sentinelDir = path.join(root, ".hankweave", "sentinels", "history");
    }

    // Use injected registry or create a new one
    this.providerRegistry =
      options.providerRegistry ||
      new LlmProviderRegistry({
        logger: this.logger,
        performHealthCheckOnInit: false,
      });

    this.providerInitPromise = this.initializeProviderRegistry(options.waitForHealthChecks);
  }

  private async initializeProviderRegistry(waitForHealthChecks = false): Promise<void> {
    try {
      this.logger?.log("Initializing LLM Provider Registry", "info");

      // Perform health checks
      this.healthCheckPromise = this.providerRegistry
        .performHealthChecks()
        .then((statuses) => {
          const healthy = Array.from(statuses.values()).filter(
            (s) => s.status === "available" && s.healthy,
          );
          const available = Array.from(statuses.values()).filter((s) => s.status === "available");
          this.logger?.log(
            `LLM providers initialized: ${healthy.length}/${available.length} healthy, ${statuses.size} total`,
            "info",
          );

          // Log each provider status for visibility
          for (const [id, status] of statuses) {
            if (status.status === "available") {
              this.logger?.log(
                `Provider ${id}: available=${true}, healthy=${status.healthy}`,
                "debug",
              );
            } else {
              this.logger?.log(`Provider ${id}: ${status.status}`, "debug");
            }
          }
        })
        .catch((error) => {
          this.logger?.log(`Provider health checks failed: ${error}`, "error");
        });

      // Three modes of operation for health check timing
      if (waitForHealthChecks) {
        // Mode 1: Wait for ALL health checks to complete
        this.logger?.log("Waiting for ALL provider health checks to complete...", "info");
        await this.healthCheckPromise;
      } else if (
        this.options.healthCheckGracePeriodMs !== undefined &&
        this.options.healthCheckGracePeriodMs > 0
      ) {
        // Mode 2: Wait for grace period (allows SOME checks to complete)
        const gracePeriod = this.options.healthCheckGracePeriodMs;
        this.logger?.log(
          `Waiting ${gracePeriod}ms grace period for health checks to complete...`,
          "info",
        );

        await Promise.race([
          this.healthCheckPromise,
          new Promise((resolve) => setTimeout(resolve, gracePeriod)),
        ]);

        // Log how many completed in grace period
        const statuses = this.providerRegistry.getProviderStatus();
        const checked = Array.from(statuses.values()).filter(
          (s) => s.status === "available" && s.lastChecked,
        ).length;
        this.logger?.log(
          `Grace period complete: ${checked}/${statuses.size} providers checked`,
          "info",
        );
      }
      // Mode 3 (default): No waiting, checks run in background
    } catch (error) {
      this.logger?.log(`Failed to initialize LLM providers: ${error}`, "error");
    }
  }

  /**
   * Initialize the sentinel directory for persistence.
   *
   * Creates the .hankweave/sentinels directory if persistence is enabled.
   * This method is idempotent - safe to call multiple times. After first
   * successful initialization, subsequent calls return immediately.
   *
   * If directory creation fails, persistence is disabled and manager continues
   * in memory-only mode.
   *
   * @throws Never throws - gracefully degrades to memory-only mode on errors
   */
  public async initialize(): Promise<void> {
    // Early return if already initialized or no directory configured
    if (this.isDirectoryInitialized || !this.sentinelDir) return;

    try {
      await fs.mkdir(this.sentinelDir, { recursive: true });
      this.isDirectoryInitialized = true; // Mark as initialized on success
      this.logger?.log(
        `[SentinelManager] Created/verified sentinel directory at ${this.sentinelDir}`,
        "debug",
      );
    } catch (error) {
      this.logger?.log(
        `[SentinelManager] Failed to create directory ${this.sentinelDir}: ${error}. Running without persistence.`,
        "info",
      );
      this.sentinelDir = undefined; // Disable persistence on error
      // Don't set isDirectoryInitialized to true on failure - allow retry
    }
  }

  /**
   * Execute an action with centralized error handling and failure tracking.
   *
   * Tracks consecutive failures per sentinel and implements unloading policies:
   * - On success: Resets failure counter
   * - On SentinelFatalError: Consults shouldUnloadSentinel policy
   * - On regular error: Increments counter, unloads after threshold (non-conversational only)
   *
   * @param sentinelId - ID of the sentinel executing the action
   * @param action - Async or sync function to execute safely
   */
  private async _safelyExecute(
    sentinelId: string,
    action: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await action();
      // Success - reset failure counter
      this.sentinelFailureCounts.set(sentinelId, 0);
    } catch (error) {
      // Failure - increment counter and handle error
      const currentFailureCount = this.sentinelFailureCounts.get(sentinelId) || 0;
      this.sentinelFailureCounts.set(sentinelId, currentFailureCount + 1);

      if (error instanceof SentinelFatalError) {
        // Fatal error - sentinel is signaling a serious issue
        this.logger?.log(
          `[SentinelManager] Sentinel ${sentinelId} threw fatal error (${error.errorType}): ${error.message}`,
          "error",
        );

        const sentinel = this.sentinels.find((c) => c.getId() === sentinelId);
        if (sentinel && (await this.shouldUnloadSentinel(sentinel, error))) {
          await this.unloadSentinel(sentinelId, "fatal-error", error.errorType);
        } else {
          this.logger?.log(
            `[SentinelManager] Keeping sentinel ${sentinelId} despite fatal error based on policy`,
            "info",
          );
        }
      } else {
        // Regular error - check if we should unload based on consecutive failures
        const config = this.sentinelConfigs.get(sentinelId);
        const newFailureCount = this.sentinelFailureCounts.get(sentinelId) || 0;

        this.logger?.log(
          `[SentinelManager] Sentinel ${sentinelId} failed (${newFailureCount} consecutive): ${error}`,
          "error",
        );

        // For non-conversational sentinels, check threshold from config
        if (!config?.conversational) {
          const threshold = config?.errorHandling?.maxConsecutiveFailures ?? 3; // Use config value or default to 3

          if (newFailureCount >= threshold) {
            this.logger?.log(
              `[SentinelManager] Unloading non-conversational sentinel ${sentinelId} after ${newFailureCount} consecutive failures (threshold: ${threshold})`,
              "info",
            );
            await this.unloadSentinel(sentinelId, "consecutive-failures");
          }
        }
      }
    }
  }

  /**
   * Load and instantiate sentinels for a codon.
   * Sentinel 2 Refactor: Uses options object for cleaner API (spec Section 3.2).
   *
   * @param configs - Sentinel configurations
   * @param codonId - Codon ID
   * @param options - Configuration options (all optional with sensible defaults)
   */
  public async loadSentinelsForCodon(
    configs: SentinelConfig[],
    codonId: CodonId,
    options: {
      configDirectory?: string;
      configDirectories?: Map<string, string>; // Per-sentinel config directory by config id; wins over configDirectory
      hankDirectory?: string; // Containment anchor for strict-ref checks (the hank/codon-config dir)
      runStartTime?: Date;
      executionPath?: string;
      agentRootPath?: string; // For sentinel output path resolution
      outputPathsMap?: Map<string, { logFile?: string; lastValueFile?: string }>;
      llmCallOverride?: (
        sentinelId: string,
        options: HankweaveGenerateTextOptions,
      ) => Promise<HankweaveGenerateTextResult>;
      llmObjectCallOverride?: (
        sentinelId: string,
        options: HankweaveGenerateObjectOptions,
      ) => Promise<HankweaveGenerateObjectResult<unknown>>;
      onExecute?: (id: string, events: ServerEvent[]) => void;
    } = {},
  ): Promise<{ loadedIds: string[] }> {
    // Destructure options for cleaner code
    const {
      configDirectory,
      configDirectories,
      hankDirectory,
      runStartTime,
      executionPath,
      agentRootPath,
      outputPathsMap,
      llmCallOverride: mockOrFallbackLlmCall,
      llmObjectCallOverride: mockOrFallbackLlmObjectCall,
      onExecute,
    } = options;

    // Unload any sentinels from previous codon before loading new ones
    // This emits sentinel.unloaded events and performs proper cleanup
    // IMPORTANT: Do this BEFORE updating this.codonId so unloaded events have correct codonId
    await this.unloadAllSentinels("codon-complete");

    // Store for later use
    this.codonId = codonId;
    this.executionPath = executionPath;

    // Ensure we're initialized
    await this.initialize();

    // Determine if we should use overrides or real providers
    // Simple rule: If override provided, use it. Otherwise, use real providers.
    const useOverride = !!(mockOrFallbackLlmCall || mockOrFallbackLlmObjectCall);

    // Optionally wait for provider health checks before loading sentinels
    if (!useOverride) {
      const shouldWaitForProviders =
        this.options.waitForHealthChecks ||
        (this.options.healthCheckGracePeriodMs !== undefined &&
          this.options.healthCheckGracePeriodMs > 0);

      if (shouldWaitForProviders) {
        if (!this.providerInitPromise) {
          this.providerInitPromise = this.initializeProviderRegistry(
            this.options.waitForHealthChecks,
          );
        }
        await this.providerInitPromise;
      }
    }

    // Hoist provider availability check outside loop (only if NOT using override)
    const hasRealProviders =
      !useOverride &&
      this.providerRegistry &&
      Array.from(this.providerRegistry.getProviderStatus().values()).some(
        (s) => s.status === "available",
      );

    const loadedIds: string[] = [];

    for (const config of configs) {
      let sentinel: Sentinel | undefined; // Hoist outside try block

      try {
        // Check if model is a full model ID (contains "/")
        const isFullModelId = config.model?.includes("/");

        // Only check provider availability if NOT using override. Deliberately
        // not gated on hasRealProviders: with zero available providers a
        // full-model-id sentinel must be skipped here like any other
        // unavailable-provider case — loading it anyway would create its
        // output files and then fail every trigger at call time.
        if (!useOverride && this.providerRegistry && isFullModelId) {
          this.logger?.log(
            `Checking availability of model ${config.model} for sentinel ${config.id}`,
            "debug",
          );

          const modelInfoResult = this.providerRegistry.getModelInfo(config.model);
          if (!modelInfoResult.success) {
            this.logger?.log(
              `Skipping sentinel ${config.id}: Model ${config.model} not found in registry`,
              "info",
            );
            continue;
          }

          const modelInfo = modelInfoResult.info;
          const providerId = modelInfo.providerId;
          const providerStatus = this.providerRegistry.getProviderStatus().get(providerId);

          if (!providerStatus || providerStatus.status !== "available") {
            this.logger?.log(
              `Skipping sentinel ${config.id}: Provider '${providerId}' for model ${config.model} is not configured (missing API key?)`,
              "info",
            );
            continue;
          }

          if (providerStatus.status === "available" && !providerStatus.healthy) {
            // Health check might still be running or failed
            const reason = providerStatus.lastChecked
              ? `health check failed: ${providerStatus.error}`
              : "health check pending";
            this.logger?.log(
              `Skipping sentinel ${config.id}: Provider '${providerId}' for model ${config.model} is not healthy (${reason})`,
              "info",
            );
            continue;
          }
        }

        // Create the concrete LLM call function for production
        const concreteLlmCall = async (
          sentinelId: string,
          options: HankweaveGenerateTextOptions,
        ): Promise<HankweaveGenerateTextResult> => {
          if (!config.model) {
            throw new SentinelFatalError(
              sentinelId,
              `Model configuration required for sentinel ${sentinelId}`,
              "configuration",
              true,
            );
          }

          const modelResult = this.providerRegistry.getProviderForModel(config.model);
          if (!modelResult.success) {
            throw new SentinelFatalError(
              sentinelId,
              `Model ${config.model} is not available: ${modelResult.reason}`,
              "configuration",
              true,
            );
          }

          // Extract model from options to avoid duplicate
          const { model: _, ...optionsWithoutModel } = options;

          const response = await generateText({
            model: modelResult.model,
            ...optionsWithoutModel,
          });

          // Map AI SDK finish reason to our type
          const finishReasonMap: Record<
            string,
            "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other"
          > = {
            stop: "stop",
            length: "length",
            "content-filter": "content-filter",
            "tool-calls": "tool-calls",
            error: "error",
          };

          const finishReason = finishReasonMap[response.finishReason] ?? "other";

          // Return pure AI SDK subset (no cost calculation here)
          return {
            text: response.text,
            finishReason,
            usage: {
              inputTokens: response.usage?.inputTokens || 0,
              outputTokens: response.usage?.outputTokens || 0,
            },
          };
        };

        // Get model cost per million tokens for this sentinel
        let modelCost: { input: number; output: number } | undefined;
        if (config.model && hasRealProviders && isFullModelId) {
          const modelInfoResult = this.providerRegistry.getModelInfo(config.model);
          if (modelInfoResult.success && modelInfoResult.info.cost) {
            const pricing = modelInfoResult.info.cost;
            if (pricing.input !== undefined && pricing.output !== undefined) {
              modelCost = { input: pricing.input, output: pricing.output };
            }
          }
        }

        // Create generateObject closure if sentinel has structured output
        let concreteLlmObjectCall:
          | ((
              id: string,
              opts: HankweaveGenerateObjectOptions,
            ) => Promise<HankweaveGenerateObjectResult<unknown>>)
          | undefined;

        if (config.structuredOutput && hasRealProviders && isFullModelId) {
          concreteLlmObjectCall = async (
            sentinelId: string,
            options: HankweaveGenerateObjectOptions,
          ): Promise<HankweaveGenerateObjectResult<unknown>> => {
            if (!config.model) {
              throw new SentinelFatalError(
                sentinelId,
                `Model required for ${sentinelId}`,
                "configuration",
                true,
              );
            }

            const modelResult = this.providerRegistry.getProviderForModel(config.model);
            if (!modelResult.success) {
              throw new SentinelFatalError(
                sentinelId,
                `Model ${config.model} not available: ${modelResult.reason}`,
                "configuration",
                true,
              );
            }

            // Check structured output capability (use tool_call as proxy)
            const modelInfo = this.providerRegistry.getModelInfo(config.model);
            if (modelInfo.success && modelInfo.info.tool_call === false) {
              throw new SentinelFatalError(
                sentinelId,
                `Model ${config.model} doesn't support structured output (no tool_call capability)`,
                "configuration",
                true,
              );
            }

            const { model: _, ...optionsWithoutModel } = options;

            const response = await generateObject({
              model: modelResult.model,
              ...optionsWithoutModel,
            });

            const finishReasonMap: Record<
              string,
              "stop" | "length" | "content-filter" | "error" | "other"
            > = {
              stop: "stop",
              length: "length",
              "content-filter": "content-filter",
              error: "error",
            };

            const finishReason = finishReasonMap[response.finishReason] ?? "other";

            return {
              object: response.object,
              finishReason,
              usage: {
                inputTokens: response.usage?.inputTokens || 0,
                outputTokens: response.usage?.outputTokens || 0,
              },
            };
          };
        }

        // Get output paths for this sentinel from the map (if provided)
        const sentinelOutputPaths = outputPathsMap?.get(config.id);

        // Determine which LLM call function to use
        // Priority: Override > Real Provider > Error
        const llmCallFn =
          mockOrFallbackLlmCall ||
          (hasRealProviders && isFullModelId
            ? concreteLlmCall
            : async () => {
                throw new Error("No LLM provider available");
              });

        // Determine which LLM object call function to use (same priority)
        const llmObjectCallFn =
          mockOrFallbackLlmObjectCall ||
          (config.structuredOutput && hasRealProviders && isFullModelId
            ? concreteLlmObjectCall
            : async () => {
                throw new Error("No LLM provider available");
              });

        // Create sentinel with optional directory for persistence
        sentinel = new Sentinel(
          config,
          codonId,
          llmCallFn,
          this.logger,
          this.sentinelDir, // Pass directory (may be undefined)
          configDirectories?.get(config.id) ?? configDirectory, // For resolving relative prompt file paths
          runStartTime, // Start time of the current run
          onExecute, // Pass callback
          modelCost, // Pass cost per million tokens
          llmObjectCallFn,
          executionPath, // For path resolution
          agentRootPath, // For sentinel output path resolution
          sentinelOutputPaths, // outputPaths from codon config (if provided)
          this.eventCallback, // Sentinel 2: Pass event callback for event emission
          hankDirectory, // Containment anchor for strict-ref checks at prompt/schema load
        );

        // Only add to collections after successful creation
        this.sentinels.push(sentinel);

        // Store config for later reference in unloading decisions
        this.sentinelConfigs.set(config.id, config);

        // Initialize failure counter
        this.sentinelFailureCounts.set(config.id, 0);

        loadedIds.push(config.id);

        this.logger?.log(
          `[SentinelManager] Loaded sentinel '${config.id}' for codon '${codonId}'`,
          "info",
        );
      } catch (error) {
        if (error instanceof SentinelFatalError) {
          this.logger?.log(`Fatal error loading sentinel ${config.id}: ${error.message}`, "error");
          // Don't load this sentinel
          continue;
        }

        this.logger?.log(
          `[SentinelManager] Failed to load sentinel ${config.id}: ${error}`,
          "error",
        );
      }
    }

    this.logger?.log(`Loaded ${this.sentinels.length} sentinels for codon ${codonId}`, "info");
    return { loadedIds };
  }

  /**
   * Distribute an event to all active sentinels.
   *
   * Events are processed in parallel across all sentinels using Promise.allSettled,
   * ensuring that errors in one sentinel don't affect others. Failed sentinels
   * are tracked for potential unloading based on failure threshold.
   *
   * @param event - Server event to distribute to sentinels
   */
  public async handleEvent(event: ServerEvent): Promise<void> {
    // Use centralized error handling for event processing
    const promises = Array.from(this.sentinels.values()).map((sentinel) =>
      this._safelyExecute(sentinel.getId(), () => sentinel.handleEvent(event)),
    );
    await Promise.allSettled(promises);
  }

  /**
   * Complete all pending work from all sentinels.
   *
   * Triggers immediate processing of any buffered events in debounce/count/timeWindow
   * strategies, then waits for all queued triggers to execute.
   * Used when codon completes or server shuts down to ensure no events are lost.
   *
   * Errors during completion are caught and logged but don't prevent completion.
   */
  public async completeAllWork(): Promise<void> {
    // Use centralized error handling for completion operations
    const promises = Array.from(this.sentinels.values()).map((sentinel) =>
      this._safelyExecute(sentinel.getId(), () => sentinel.completeAllWork()),
    );
    await Promise.allSettled(promises);
  }

  /**
   * Shutdown the manager and all sentinels.
   *
   * Performs graceful shutdown:
   * 1. Completes all pending work (finalizes buffers, drains queues)
   * 2. Explicitly destroys each sentinel (timers, buffers, state)
   * 3. Clears all internal maps and arrays
   *
   * Errors during individual sentinel cleanup are caught and logged
   * but don't prevent shutdown from completing.
   */
  public async shutdown(): Promise<void> {
    await this.completeAllWork();

    // Unload all sentinels with proper event emission
    await this.unloadAllSentinels("shutdown");

    // Clear remaining collections
    this.sentinelConfigs.clear();
    this.sentinelFailureCounts.clear();

    this.logger?.log("[SentinelManager] Shutdown complete", "debug");
  }

  /**
   * Get the number of active sentinels.
   */
  public getSentinelCount(): number {
    return this.sentinels.length;
  }

  /**
   * Get the IDs of all active sentinels.
   */
  public getSentinelIds(): string[] {
    return this.sentinels.map((c) => c.getId());
  }

  /**
   * Get total cost for each currently loaded sentinel.
   *
   * IMPORTANT: Only returns costs for sentinels loaded in the CURRENT codon.
   * When loadSentinelsForCodon() is called for a new codon, previous sentinels
   * are unloaded and their cost data is lost. If you need historical costs,
   * capture them before codon completion.
   *
   * @returns Map of sentinel ID to total accumulated cost
   */
  public getSentinelCosts(): Map<string, number> {
    const costs = new Map<string, number>();
    for (const sentinel of this.sentinels) {
      costs.set(sentinel.getId(), sentinel.getTotalCost());
    }
    return costs;
  }

  /**
   * Sentinel 2: Get full sentinel states for all active sentinels.
   * Returns complete state snapshots for persistence in codon state.
   *
   * @returns Array of SentinelState objects with all metadata
   */
  public getSentinelStates(): import("../types/state-types.js").SentinelState[] {
    return this.sentinels.map((sentinel) => sentinel.getSentinelState());
  }

  /**
   * Sentinel 2: Set event callback for sentinel event emission.
   * Sentinels will call this callback to emit their events back to the main stream.
   *
   * @param callback - Function to call when sentinels emit events
   */
  private eventCallback?: (event: import("../schemas/event-schemas.js").SentinelEvent) => void;

  public setEventCallback(
    callback: (event: import("../schemas/event-schemas.js").SentinelEvent) => void,
  ): void {
    this.eventCallback = callback;
    this.logger?.log("[SentinelManager] Event callback registered", "debug");
  }

  /**
   * Determine if a sentinel should be unloaded based on a fatal error.
   *
   * Implements three-category decision framework:
   *
   * Category 1 - Will definitely recur (structural problems):
   *   - template errors: Template syntax is broken
   *   - configuration errors: Config is invalid
   *   → Always unload
   *
   * Category 2 - May recur (context-dependent):
   *   - corruption errors: Data/history file corrupted
   *   → For conversational: Check continueOnError config
   *   → For non-conversational: Let consecutive failure tracking handle it
   *
   * Category 3 - Won't recur (transient issues):
   *   - resource errors: Network timeout, temporary API failure
   *   → Never unload
   *
   * @param sentinel - The sentinel that encountered the error
   * @param fatalError - The fatal error that was thrown
   * @returns true if sentinel should be unloaded, false to keep it active
   */
  private async shouldUnloadSentinel(
    sentinel: Sentinel,
    fatalError: SentinelFatalError,
  ): Promise<boolean> {
    const sentinelId = sentinel.getId();
    const config = this.sentinelConfigs.get(sentinelId);

    if (!config) {
      this.logger?.log(
        `[SentinelManager] Cannot find config for sentinel ${sentinelId}, defaulting to unload`,
        "error",
      );
      return true;
    }

    // Error explicitly recommends unloading (override for special cases) - CHECK FIRST
    if (fatalError.shouldUnload) {
      this.logger?.log(
        `[SentinelManager] Unloading ${sentinelId} - error explicitly requested unload`,
        "info",
      );
      return true;
    }

    // Category 1: Errors that will definitely recur every time (structural problems)
    if (fatalError.errorType === "template" || fatalError.errorType === "configuration") {
      this.logger?.log(
        `[SentinelManager] Unloading ${sentinelId} - ${fatalError.errorType} errors will recur on every execution`,
        "info",
      );
      return true;
    }

    // Category 2: Errors that may recur (context-dependent, LLM/data related)
    if (fatalError.errorType === "corruption") {
      if (config.conversational) {
        // For conversational sentinels, respect continueOnError setting
        const shouldContinue = config.conversational.continueOnError === true;
        this.logger?.log(
          `[SentinelManager] Conversational sentinel ${sentinelId} corruption error - continueOnError: ${shouldContinue}`,
          "info",
        );
        return !shouldContinue; // Unload if NOT configured to continue
      } else {
        // For non-conversational, handled by consecutive failure logic in handleEvent
        // Don't unload here - let consecutive failure tracking handle it
        return false;
      }
    }

    // Category 3: Errors that reasonably won't recur (transient issues)
    if (fatalError.errorType === "resource") {
      this.logger?.log(
        `[SentinelManager] Not unloading ${sentinelId} - resource errors are often transient`,
        "info",
      );
      return false;
    }

    // Default: don't unload for unknown error types
    return false;
  }

  /**
   * Unload a specific sentinel by ID.
   *
   * Performs cleanup and removes the sentinel from the active list.
   * Called when a sentinel hits its error threshold or encounters
   * a fatal error that requires unloading.
   *
   * @param sentinelId - ID of the sentinel to unload
   * @param reason - Reason for unloading
   * @param errorType - Type of error if unloading due to error
   */
  private async unloadSentinel(
    sentinelId: string,
    reason:
      | "codon-complete"
      | "fatal-error"
      | "consecutive-failures"
      | "shutdown" = "codon-complete",
    errorType?: "template" | "configuration" | "corruption" | "resource",
  ): Promise<void> {
    const index = this.sentinels.findIndex((c) => c.getId() === sentinelId);

    if (index === -1) {
      this.logger?.log(
        `[SentinelManager] Cannot unload sentinel ${sentinelId} - not found`,
        "error",
      );
      return;
    }

    const sentinel = this.sentinels[index];

    // Get final state before destroying
    const finalCost = sentinel.getTotalCost();
    const sentinelState = sentinel.getSentinelState();

    // Sentinel 2: Emit sentinel.unloaded event if callback is set
    if (this.eventCallback && this.codonId) {
      this.eventCallback({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "sentinel.unloaded",
        data: {
          sentinelId,
          codonId: this.codonId,
          reason,
          errorType,
          finalCost,
          llmCallCount: sentinelState.llmCallCount,
        },
      });
    }

    try {
      // Clean up the sentinel
      sentinel.destroy();
    } catch (error) {
      this.logger?.log(
        `[SentinelManager] Error during sentinel ${sentinelId} cleanup: ${error}`,
        "error",
      );
    }

    // Remove from active list
    this.sentinels.splice(index, 1);

    this.logger?.log(
      `[SentinelManager] Unloaded sentinel ${sentinelId}. Remaining sentinels: ${this.sentinels.length}`,
      "info",
    );
  }

  /**
   * Sentinel 2: Unload all sentinels with given reason.
   * Called during codon completion or shutdown.
   */
  private async unloadAllSentinels(reason: "codon-complete" | "shutdown"): Promise<void> {
    const sentinelIds = this.sentinels.map((c) => c.getId());
    for (const id of sentinelIds) {
      await this.unloadSentinel(id, reason);
    }
  }
}
