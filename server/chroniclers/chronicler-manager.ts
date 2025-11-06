import { promises as fs } from "node:fs";
import * as path from "node:path";
import { generateObject, generateText } from "ai";
import { LlmProviderRegistry } from "../llm/llm-provider-registry.js";
import type { ServerEvent } from "../schemas/event-schemas.js";
import { EventId, type PhaseId } from "../types/branded-types.js";
import type { ChroniclerConfig } from "../types/chronicler-types.js";
import type {
  TadpoleGenerateObjectOptions,
  TadpoleGenerateObjectResult,
  TadpoleGenerateTextOptions,
  TadpoleGenerateTextResult,
} from "../types/llm-call-types.js";
import { generateId, type Logger } from "../utils.js";
import { Chronicler } from "./chronicler.js";
import { ChroniclerFatalError } from "./chronicler-fatal-error.js";

export interface ChroniclerManagerOptions {
  logger?: Logger;
  waitForHealthChecks?: boolean; // Option to wait for provider health checks
  healthCheckGracePeriodMs?: number; // Grace period to wait for health checks before loading chroniclers
  enablePersistence?: boolean; // Allow disabling persistence for testing
  providerRegistry?: LlmProviderRegistry;
}

/**
 * Manages multiple Chronicler instances for a phase.
 *
 * The ChroniclerManager orchestrates the lifecycle of all chroniclers within a phase,
 * handling event distribution, error management, and resource cleanup. It provides:
 *
 * - **Provider Integration**: Coordinates with LlmProviderRegistry for model availability
 * - **Lifecycle Management**: Loads chroniclers, distributes events, handles shutdown
 * - **Error Handling**: Implements three-category fatal error framework with smart unloading
 * - **Resource Management**: Manages filesystem persistence and provider health monitoring
 *
 * Initialization Pattern: Explicit async initialize() method
 * Rationale: Shared resource (filesystem directory) needs setup before chroniclers
 * can be created. Explicit call allows caller to control timing and handle failures.
 *
 * @example
 * const manager = new ChroniclerManager({
 *   logger,
 *   healthCheckGracePeriodMs: 300
 * });
 * await manager.initialize();
 * await manager.loadChroniclersForPhase(configs, phaseId, llmCall);
 */
export class ChroniclerManager {
  private chroniclers: Chronicler[] = [];
  private chroniclerDir?: string;
  private isDirectoryInitialized = false;
  private chroniclerConfigs: Map<string, ChroniclerConfig> = new Map();
  private chroniclerFailureCounts: Map<string, number> = new Map();
  private providerRegistry: LlmProviderRegistry;
  private healthCheckPromise?: Promise<void>;
  private logger?: Logger;
  private options: ChroniclerManagerOptions;
  private phaseId?: PhaseId;
  private executionPath?: string;

  constructor(options: ChroniclerManagerOptions = {}) {
    this.options = options;
    this.logger = options.logger;

    // Set up chronicler directory if persistence is enabled
    if (options.enablePersistence !== false) {
      this.chroniclerDir = path.join(".tadpole", "chroniclers", "history");
    }

    // Use injected registry or create a new one
    this.providerRegistry =
      options.providerRegistry ||
      new LlmProviderRegistry({
        logger: this.logger,
        performHealthCheckOnInit: false,
      });

    this.initializeProviderRegistry(options.waitForHealthChecks);
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
   * Initialize the chronicler directory for persistence.
   *
   * Creates the .tadpole/chroniclers directory if persistence is enabled.
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
    if (this.isDirectoryInitialized || !this.chroniclerDir) return;

    try {
      await fs.mkdir(this.chroniclerDir, { recursive: true });
      this.isDirectoryInitialized = true; // Mark as initialized on success
      this.logger?.log(
        `[ChroniclerManager] Created/verified chronicler directory at ${this.chroniclerDir}`,
        "debug",
      );
    } catch (error) {
      this.logger?.log(
        `[ChroniclerManager] Failed to create directory ${this.chroniclerDir}: ${error}. Running without persistence.`,
        "info",
      );
      this.chroniclerDir = undefined; // Disable persistence on error
      // Don't set isDirectoryInitialized to true on failure - allow retry
    }
  }

  /**
   * Execute an action with centralized error handling and failure tracking.
   *
   * Tracks consecutive failures per chronicler and implements unloading policies:
   * - On success: Resets failure counter
   * - On ChroniclerFatalError: Consults shouldUnloadChronicler policy
   * - On regular error: Increments counter, unloads after threshold (non-conversational only)
   *
   * @param chroniclerId - ID of the chronicler executing the action
   * @param action - Async or sync function to execute safely
   */
  private async _safelyExecute(
    chroniclerId: string,
    action: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await action();
      // Success - reset failure counter
      this.chroniclerFailureCounts.set(chroniclerId, 0);
    } catch (error) {
      // Failure - increment counter and handle error
      const currentFailureCount = this.chroniclerFailureCounts.get(chroniclerId) || 0;
      this.chroniclerFailureCounts.set(chroniclerId, currentFailureCount + 1);

      if (error instanceof ChroniclerFatalError) {
        // Fatal error - chronicler is signaling a serious issue
        this.logger?.log(
          `[ChroniclerManager] Chronicler ${chroniclerId} threw fatal error (${error.errorType}): ${error.message}`,
          "error",
        );

        const chronicler = this.chroniclers.find((c) => c.getId() === chroniclerId);
        if (chronicler && (await this.shouldUnloadChronicler(chronicler, error))) {
          await this.unloadChronicler(chroniclerId, "fatal-error", error.errorType);
        } else {
          this.logger?.log(
            `[ChroniclerManager] Keeping chronicler ${chroniclerId} despite fatal error based on policy`,
            "info",
          );
        }
      } else {
        // Regular error - check if we should unload based on consecutive failures
        const config = this.chroniclerConfigs.get(chroniclerId);
        const newFailureCount = this.chroniclerFailureCounts.get(chroniclerId) || 0;

        this.logger?.log(
          `[ChroniclerManager] Chronicler ${chroniclerId} failed (${newFailureCount} consecutive): ${error}`,
          "error",
        );

        // For non-conversational chroniclers, check threshold from config
        if (!config?.conversational) {
          const threshold = config?.errorHandling?.maxConsecutiveFailures ?? 3; // Use config value or default to 3

          if (newFailureCount >= threshold) {
            this.logger?.log(
              `[ChroniclerManager] Unloading non-conversational chronicler ${chroniclerId} after ${newFailureCount} consecutive failures (threshold: ${threshold})`,
              "info",
            );
            await this.unloadChronicler(chroniclerId, "consecutive-failures");
          }
        }
      }
    }
  }

  /**
   * Load and instantiate chroniclers for a phase.
   * Phase 2 Refactor: Uses options object for cleaner API (spec Section 3.2).
   *
   * @param configs - Chronicler configurations
   * @param phaseId - Phase ID
   * @param options - Configuration options (all optional with sensible defaults)
   */
  public async loadChroniclersForPhase(
    configs: ChroniclerConfig[],
    phaseId: PhaseId,
    options: {
      configDirectory?: string;
      runStartTime?: Date;
      executionPath?: string;
      outputPathsMap?: Map<string, { logFile?: string; lastValueFile?: string }>;
      llmCallOverride?: (
        chroniclerId: string,
        options: TadpoleGenerateTextOptions,
      ) => Promise<TadpoleGenerateTextResult>;
      llmObjectCallOverride?: (
        chroniclerId: string,
        options: TadpoleGenerateObjectOptions,
      ) => Promise<TadpoleGenerateObjectResult<unknown>>;
      onExecute?: (id: string, events: ServerEvent[]) => void;
    } = {},
  ): Promise<void> {
    // Destructure options for cleaner code
    const {
      configDirectory,
      runStartTime,
      executionPath,
      outputPathsMap,
      llmCallOverride: mockOrFallbackLlmCall,
      llmObjectCallOverride: mockOrFallbackLlmObjectCall,
      onExecute,
    } = options;

    // Store for later use
    this.phaseId = phaseId;
    this.executionPath = executionPath;

    // Unload any chroniclers from previous phase before loading new ones
    // This emits chronicler.unloaded events and performs proper cleanup
    await this.unloadAllChroniclers("phase-complete");

    // Ensure we're initialized
    await this.initialize();

    // Determine if we should use overrides or real providers
    // Simple rule: If override provided, use it. Otherwise, use real providers.
    const useOverride = !!(mockOrFallbackLlmCall || mockOrFallbackLlmObjectCall);

    // Hoist provider availability check outside loop (only if NOT using override)
    const hasRealProviders =
      !useOverride &&
      this.providerRegistry &&
      Array.from(this.providerRegistry.getProviderStatus().values()).some(
        (s) => s.status === "available",
      );

    for (const config of configs) {
      let chronicler: Chronicler | undefined; // Hoist outside try block

      try {
        // Check if model is a full model ID (contains "/")
        const isFullModelId = config.model?.includes("/");

        // Only check provider availability if NOT using override
        if (!useOverride && hasRealProviders && isFullModelId) {
          this.logger?.log(
            `Checking availability of model ${config.model} for chronicler ${config.id}`,
            "debug",
          );

          const modelInfoResult = this.providerRegistry.getModelInfo(config.model);
          if (!modelInfoResult.success) {
            this.logger?.log(
              `Skipping chronicler ${config.id}: Model ${config.model} not found in registry`,
              "info",
            );
            continue;
          }

          const modelInfo = modelInfoResult.info;
          const providerId = modelInfo.providerId;
          const providerStatus = this.providerRegistry.getProviderStatus().get(providerId);

          if (!providerStatus || providerStatus.status !== "available") {
            this.logger?.log(
              `Skipping chronicler ${config.id}: Provider '${providerId}' for model ${config.model} is not configured (missing API key?)`,
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
              `Skipping chronicler ${config.id}: Provider '${providerId}' for model ${config.model} is not healthy (${reason})`,
              "info",
            );
            continue;
          }
        }

        // Create the concrete LLM call function for production
        const concreteLlmCall = async (
          chroniclerId: string,
          options: TadpoleGenerateTextOptions,
        ): Promise<TadpoleGenerateTextResult> => {
          if (!config.model) {
            throw new ChroniclerFatalError(
              chroniclerId,
              `Model configuration required for chronicler ${chroniclerId}`,
              "configuration",
              true,
            );
          }

          const modelResult = this.providerRegistry.getProviderForModel(config.model);
          if (!modelResult.success) {
            throw new ChroniclerFatalError(
              chroniclerId,
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

        // Get model cost per million tokens for this chronicler
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

        // Create generateObject closure if chronicler has structured output
        let concreteLlmObjectCall:
          | ((
              id: string,
              opts: TadpoleGenerateObjectOptions,
            ) => Promise<TadpoleGenerateObjectResult<unknown>>)
          | undefined;

        if (config.structuredOutput && hasRealProviders && isFullModelId) {
          concreteLlmObjectCall = async (
            chroniclerId: string,
            options: TadpoleGenerateObjectOptions,
          ): Promise<TadpoleGenerateObjectResult<unknown>> => {
            if (!config.model) {
              throw new ChroniclerFatalError(
                chroniclerId,
                `Model required for ${chroniclerId}`,
                "configuration",
                true,
              );
            }

            const modelResult = this.providerRegistry.getProviderForModel(config.model);
            if (!modelResult.success) {
              throw new ChroniclerFatalError(
                chroniclerId,
                `Model ${config.model} not available: ${modelResult.reason}`,
                "configuration",
                true,
              );
            }

            // Check structured output capability (use tool_call as proxy)
            const modelInfo = this.providerRegistry.getModelInfo(config.model);
            if (modelInfo.success && modelInfo.info.tool_call === false) {
              throw new ChroniclerFatalError(
                chroniclerId,
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

        // Get output paths for this chronicler from the map (if provided)
        const chroniclerOutputPaths = outputPathsMap?.get(config.id);

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

        // Create chronicler with optional directory for persistence
        chronicler = new Chronicler(
          config,
          phaseId,
          llmCallFn,
          this.logger,
          this.chroniclerDir, // Pass directory (may be undefined)
          configDirectory, // For resolving relative prompt file paths
          runStartTime, // Start time of the current run
          onExecute, // Pass callback
          modelCost, // Pass cost per million tokens
          llmObjectCallFn,
          executionPath, // For path resolution
          chroniclerOutputPaths, // outputPaths from phase config (if provided)
          this.eventCallback, // Phase 2: Pass event callback for event emission
        );

        // Only add to collections after successful creation
        this.chroniclers.push(chronicler);

        // Store config for later reference in unloading decisions
        this.chroniclerConfigs.set(config.id, config);

        // Initialize failure counter
        this.chroniclerFailureCounts.set(config.id, 0);

        this.logger?.log(
          `[ChroniclerManager] Loaded chronicler '${config.id}' for phase '${phaseId}'`,
          "info",
        );
      } catch (error) {
        if (error instanceof ChroniclerFatalError) {
          this.logger?.log(
            `Fatal error loading chronicler ${config.id}: ${error.message}`,
            "error",
          );
          // Don't load this chronicler
          continue;
        }

        this.logger?.log(
          `[ChroniclerManager] Failed to load chronicler ${config.id}: ${error}`,
          "error",
        );
      }
    }

    this.logger?.log(`Loaded ${this.chroniclers.length} chroniclers for phase ${phaseId}`, "info");
  }

  /**
   * Distribute an event to all active chroniclers.
   *
   * Events are processed in parallel across all chroniclers using Promise.allSettled,
   * ensuring that errors in one chronicler don't affect others. Failed chroniclers
   * are tracked for potential unloading based on failure threshold.
   *
   * @param event - Server event to distribute to chroniclers
   */
  public async handleEvent(event: ServerEvent): Promise<void> {
    // Use centralized error handling for event processing
    const promises = Array.from(this.chroniclers.values()).map((chronicler) =>
      this._safelyExecute(chronicler.getId(), () => chronicler.handleEvent(event)),
    );
    await Promise.allSettled(promises);
  }

  /**
   * Complete all pending work from all chroniclers.
   *
   * Triggers immediate processing of any buffered events in debounce/count/timeWindow
   * strategies, then waits for all queued triggers to execute.
   * Used when phase completes or server shuts down to ensure no events are lost.
   *
   * Errors during completion are caught and logged but don't prevent completion.
   */
  public async completeAllWork(): Promise<void> {
    // Use centralized error handling for completion operations
    const promises = Array.from(this.chroniclers.values()).map((chronicler) =>
      this._safelyExecute(chronicler.getId(), () => chronicler.completeAllWork()),
    );
    await Promise.allSettled(promises);
  }

  /**
   * Shutdown the manager and all chroniclers.
   *
   * Performs graceful shutdown:
   * 1. Completes all pending work (finalizes buffers, drains queues)
   * 2. Explicitly destroys each chronicler (timers, buffers, state)
   * 3. Clears all internal maps and arrays
   *
   * Errors during individual chronicler cleanup are caught and logged
   * but don't prevent shutdown from completing.
   */
  public async shutdown(): Promise<void> {
    await this.completeAllWork();

    // Unload all chroniclers with proper event emission
    await this.unloadAllChroniclers("shutdown");

    // Clear remaining collections
    this.chroniclerConfigs.clear();
    this.chroniclerFailureCounts.clear();

    this.logger?.log("[ChroniclerManager] Shutdown complete", "debug");
  }

  /**
   * Get the number of active chroniclers.
   */
  public getChroniclerCount(): number {
    return this.chroniclers.length;
  }

  /**
   * Get the IDs of all active chroniclers.
   */
  public getChroniclerIds(): string[] {
    return this.chroniclers.map((c) => c.getId());
  }

  /**
   * Get total cost for each currently loaded chronicler.
   *
   * IMPORTANT: Only returns costs for chroniclers loaded in the CURRENT phase.
   * When loadChroniclersForPhase() is called for a new phase, previous chroniclers
   * are unloaded and their cost data is lost. If you need historical costs,
   * capture them before phase completion.
   *
   * @returns Map of chronicler ID to total accumulated cost
   */
  public getChroniclerCosts(): Map<string, number> {
    const costs = new Map<string, number>();
    for (const chronicler of this.chroniclers) {
      costs.set(chronicler.getId(), chronicler.getTotalCost());
    }
    return costs;
  }

  /**
   * Phase 2: Get full chronicler states for all active chroniclers.
   * Returns complete state snapshots for persistence in phase state.
   *
   * @returns Array of ChroniclerState objects with all metadata
   */
  public getChroniclerStates(): import("../types/state-types.js").ChroniclerState[] {
    return this.chroniclers.map((chronicler) => chronicler.getChroniclerState());
  }

  /**
   * Phase 2: Set event callback for chronicler event emission.
   * Chroniclers will call this callback to emit their events back to the main stream.
   *
   * @param callback - Function to call when chroniclers emit events
   */
  private eventCallback?: (event: import("../schemas/event-schemas.js").ChroniclerEvent) => void;

  public setEventCallback(
    callback: (event: import("../schemas/event-schemas.js").ChroniclerEvent) => void,
  ): void {
    this.eventCallback = callback;
    this.logger?.log("[ChroniclerManager] Event callback registered", "debug");
  }

  /**
   * Determine if a chronicler should be unloaded based on a fatal error.
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
   * @param chronicler - The chronicler that encountered the error
   * @param fatalError - The fatal error that was thrown
   * @returns true if chronicler should be unloaded, false to keep it active
   */
  private async shouldUnloadChronicler(
    chronicler: Chronicler,
    fatalError: ChroniclerFatalError,
  ): Promise<boolean> {
    const chroniclerId = chronicler.getId();
    const config = this.chroniclerConfigs.get(chroniclerId);

    if (!config) {
      this.logger?.log(
        `[ChroniclerManager] Cannot find config for chronicler ${chroniclerId}, defaulting to unload`,
        "error",
      );
      return true;
    }

    // Error explicitly recommends unloading (override for special cases) - CHECK FIRST
    if (fatalError.shouldUnload) {
      this.logger?.log(
        `[ChroniclerManager] Unloading ${chroniclerId} - error explicitly requested unload`,
        "info",
      );
      return true;
    }

    // Category 1: Errors that will definitely recur every time (structural problems)
    if (fatalError.errorType === "template" || fatalError.errorType === "configuration") {
      this.logger?.log(
        `[ChroniclerManager] Unloading ${chroniclerId} - ${fatalError.errorType} errors will recur on every execution`,
        "info",
      );
      return true;
    }

    // Category 2: Errors that may recur (context-dependent, LLM/data related)
    if (fatalError.errorType === "corruption") {
      if (config.conversational) {
        // For conversational chroniclers, respect continueOnError setting
        const shouldContinue = config.conversational.continueOnError === true;
        this.logger?.log(
          `[ChroniclerManager] Conversational chronicler ${chroniclerId} corruption error - continueOnError: ${shouldContinue}`,
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
        `[ChroniclerManager] Not unloading ${chroniclerId} - resource errors are often transient`,
        "info",
      );
      return false;
    }

    // Default: don't unload for unknown error types
    return false;
  }

  /**
   * Unload a specific chronicler by ID.
   *
   * Performs cleanup and removes the chronicler from the active list.
   * Called when a chronicler hits its error threshold or encounters
   * a fatal error that requires unloading.
   *
   * @param chroniclerId - ID of the chronicler to unload
   * @param reason - Reason for unloading
   * @param errorType - Type of error if unloading due to error
   */
  private async unloadChronicler(
    chroniclerId: string,
    reason:
      | "phase-complete"
      | "fatal-error"
      | "consecutive-failures"
      | "shutdown" = "phase-complete",
    errorType?: "template" | "configuration" | "corruption" | "resource",
  ): Promise<void> {
    const index = this.chroniclers.findIndex((c) => c.getId() === chroniclerId);

    if (index === -1) {
      this.logger?.log(
        `[ChroniclerManager] Cannot unload chronicler ${chroniclerId} - not found`,
        "error",
      );
      return;
    }

    const chronicler = this.chroniclers[index];

    // Get final state before destroying
    const finalCost = chronicler.getTotalCost();
    const chroniclerState = chronicler.getChroniclerState();

    // Phase 2: Emit chronicler.unloaded event if callback is set
    if (this.eventCallback && this.phaseId) {
      this.eventCallback({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "chronicler.unloaded",
        data: {
          chroniclerId,
          phaseId: this.phaseId,
          reason,
          errorType,
          finalCost,
          llmCallCount: chroniclerState.llmCallCount,
        },
      });
    }

    try {
      // Clean up the chronicler
      chronicler.destroy();
    } catch (error) {
      this.logger?.log(
        `[ChroniclerManager] Error during chronicler ${chroniclerId} cleanup: ${error}`,
        "error",
      );
    }

    // Remove from active list
    this.chroniclers.splice(index, 1);

    this.logger?.log(
      `[ChroniclerManager] Unloaded chronicler ${chroniclerId}. Remaining chroniclers: ${this.chroniclers.length}`,
      "info",
    );
  }

  /**
   * Phase 2: Unload all chroniclers with given reason.
   * Called during phase completion or shutdown.
   */
  private async unloadAllChroniclers(reason: "phase-complete" | "shutdown"): Promise<void> {
    const chroniclerIds = this.chroniclers.map((c) => c.getId());
    for (const id of chroniclerIds) {
      await this.unloadChronicler(id, reason);
    }
  }
}
