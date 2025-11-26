import type { LanguageModel, Provider } from "ai";
import { generateText } from "ai";
import type { Logger } from "../utils.js";
import customModelsDataRaw from "./models-custom-data.json";
import modelsDataRaw from "./models-dev-data.json";
import { type ModelInfo, modelsDataSchema } from "./models-dev-schema.js";
import { PROVIDER_DEFINITIONS } from "./provider-config.js";

/**
 * Discriminated union for provider status
 */
export type ProviderStatus =
  | {
      status: "not-configured";
      id: string;
      error: string;
    }
  | {
      status: "available";
      id: string;
      healthy: boolean;
      lastChecked?: Date;
      error?: string; // Only present if healthy is false
    }
  | {
      status: "failed";
      id: string;
      error: string;
      lastChecked: Date;
    };

/**
 * Result types for better error handling
 */
export type ModelResult =
  | { success: true; model: LanguageModel }
  | {
      success: false;
      reason: "model-not-found" | "provider-unavailable" | "provider-unhealthy" | "model-blocked";
    };

export type ModelInfoResult =
  | { success: true; info: ModelInfo }
  | { success: false; reason: "model-not-found" | "model-blocked" };

export interface BlockList {
  providers?: string[]; // Block entire providers
  models?: string[]; // Block specific model IDs
}

export interface LlmProviderRegistryConfig {
  logger?: Logger;
  healthCheckTimeout?: number; // ms, default 5000
  performHealthCheckOnInit?: boolean; // default false
  blockList?: BlockList; // Optional blocklist for providers and models
}

export class LlmProviderRegistry {
  private providers = new Map<string, Provider>();
  private models = new Map<string, ModelInfo>();
  private uniqueModels = new Set<string>(); // Track unique model IDs
  private providerStatus = new Map<string, ProviderStatus>();
  private logger?: Logger;
  private healthCheckTimeout: number;
  private blockList: BlockList;

  constructor(config: LlmProviderRegistryConfig = {}) {
    this.logger = config.logger;
    this.healthCheckTimeout = config.healthCheckTimeout || 5000;
    this.blockList = config.blockList || {};

    this.loadModelsData();
    this.initializeProviders();

    if (config.performHealthCheckOnInit) {
      // Don't await, let it run in background
      this.performHealthChecks().catch((err) => {
        this.logger?.log(`Background health checks failed: ${err}`, "error");
      });
    }
  }

  // === Initialization ===

  private loadModelsData(): void {
    try {
      // Load main models data
      const validatedData = modelsDataSchema.parse(modelsDataRaw);

      // Load custom models data (directly imported, no try-catch needed)
      const customModels = modelsDataSchema.parse(customModelsDataRaw);

      if (customModels.providers.length > 0) {
        this.logger?.log(
          `Loaded ${customModels.providers.length} custom providers from extension file`,
          "info",
        );
      }

      // Combine models from both sources
      const allProviders = [...validatedData.providers, ...customModels.providers];

      // Process each provider's models
      for (const provider of allProviders) {
        // Check if provider is blocked
        if (this.blockList.providers?.includes(provider.id)) {
          this.logger?.log(`Skipping blocked provider: ${provider.id}`, "debug");
          continue;
        }

        for (const model of provider.models) {
          // Check if specific model is blocked
          if (this.blockList.models?.includes(model.modelId)) {
            this.logger?.log(`Skipping blocked model: ${model.modelId}`, "debug");
            continue;
          }

          const fullModelId = `${model.providerId}/${model.modelId}`;

          // Track unique models
          this.uniqueModels.add(fullModelId);

          // Register by both full and short names for convenience
          this.models.set(fullModelId, model);
          this.models.set(model.modelId, model); // Keep short ID for AI SDK compatibility
        }
      }

      this.logger?.log(`Loaded ${this.uniqueModels.size} unique models from data files`, "info");
    } catch (error) {
      this.logger?.log(`Failed to load models data: ${error}`, "error");
      // Continue with empty models map - providers may still work
    }
  }

  /**
   * Find the cheapest model for a provider for health checks
   * Uses input cost since health checks send minimal input and expect minimal output
   * Filters to:
   * - Chat models only (not embeddings)
   * - Models updated within last year
   * - Models that support both text input and text output
   */
  private findCheapestModel(providerId: string): string | undefined {
    let cheapestModel: ModelInfo | undefined;
    let lowestInputCost = Number.POSITIVE_INFINITY;

    // Calculate cutoff date (1 year ago)
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const cutoffDate = oneYearAgo.toISOString().substring(0, 7); // YYYY-MM format

    for (const model of this.models.values()) {
      // Skip if not the right provider or if we've already seen this model
      if (model.providerId !== providerId) continue;

      // Skip embedding models - must support text input AND text output for chat
      const isEmbeddingModel =
        !model.modalities.output.includes("text") ||
        !model.modalities.input.includes("text") ||
        (model.modalities.output.length === 1 && model.modalities.output[0] === "embedding");

      if (isEmbeddingModel) {
        this.logger?.log(
          `Skipping ${model.modelId} for health check (embedding or non-chat model)`,
          "debug",
        );
        continue;
      }

      // Skip models not updated in last year
      if (model.last_updated < cutoffDate) {
        this.logger?.log(
          `Skipping ${model.modelId} for health check (last updated: ${model.last_updated})`,
          "debug",
        );
        continue;
      }

      const cost = model.cost?.input;
      if (cost !== undefined && cost > 0 && cost < lowestInputCost) {
        lowestInputCost = cost;
        cheapestModel = model;
      }
    }

    if (cheapestModel) {
      this.logger?.log(
        `Selected ${cheapestModel.modelId} as cheapest for ${providerId} (input cost: $${cheapestModel.cost?.input}/M tokens, updated: ${cheapestModel.last_updated})`,
        "debug",
      );
    }

    return cheapestModel?.modelId;
  }

  private initializeProviders(): void {
    for (const def of PROVIDER_DEFINITIONS) {
      // Check STRANDWEAVE_SENTINEL_ prefixed var first, then fall back to standard
      const sentinelEnvVar = `STRANDWEAVE_SENTINEL_${def.apiKeyEnvVar}`;
      const apiKey = process.env[sentinelEnvVar] || process.env[def.apiKeyEnvVar];

      if (!apiKey) {
        const status: ProviderStatus = {
          status: "not-configured",
          id: def.id,
          error: `No API key found (checked: ${sentinelEnvVar}, ${def.apiKeyEnvVar})`,
        };
        this.providerStatus.set(def.id, status);
        this.logger?.log(`Provider ${def.id}: ${status.error}`, "debug");
        continue;
      }

      // Log which env var was used (helpful for debugging)
      const usedEnvVar = process.env[sentinelEnvVar] ? sentinelEnvVar : def.apiKeyEnvVar;

      try {
        const provider = def.createProvider(apiKey);
        this.providers.set(def.id, provider);
        const status: ProviderStatus = {
          status: "available",
          id: def.id,
          healthy: false, // Will be updated by health check
        };
        this.providerStatus.set(def.id, status);
        this.logger?.log(`Provider ${def.id}: Initialized (using ${usedEnvVar})`, "info");
      } catch (error) {
        const status: ProviderStatus = {
          status: "failed",
          id: def.id,
          error: `Failed to initialize: ${error}`,
          lastChecked: new Date(),
        };
        this.providerStatus.set(def.id, status);
        this.logger?.log(`Provider ${def.id}: ${status.error}`, "error");
      }
    }
  }

  // === Health Checks ===

  public async performHealthChecks(): Promise<Map<string, ProviderStatus>> {
    this.logger?.log("Starting provider health checks", "debug");

    const checks = Array.from(this.providers.entries()).map(async ([id, provider]) => {
      const status = this.providerStatus.get(id);
      if (!status || status.status !== "available") {
        this.logger?.log(`Skipping health check for ${id} (not available)`, "debug");
        return;
      }

      // Find cheapest model for this provider programmatically
      const testModel = this.findCheapestModel(id);

      if (!testModel) {
        // No models available for this provider
        this.logger?.log(`No models found for provider ${id}, marking as unhealthy`, "error");
        const updatedStatus: ProviderStatus = {
          ...status,
          healthy: false,
          error: "No models available",
          lastChecked: new Date(),
        };
        this.providerStatus.set(id, updatedStatus);
        return;
      }

      this.logger?.log(`Using ${testModel} for ${id} health check (cheapest model)`, "debug");

      try {
        // Create a timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Health check timeout")), this.healthCheckTimeout);
        });

        // Race the health check against timeout
        const model = provider.languageModel(testModel);
        const result = await Promise.race([
          generateText({
            model,
            messages: [{ role: "user", content: "Hi" }],
            maxOutputTokens: 16, // Minimum required by most providers
            temperature: 0,
          }),
          timeoutPromise,
        ]);

        // Log the actual response from the model (fun!)
        this.logger?.log(
          `Provider ${id} health check response: "${result.text.substring(0, 50)}${result.text.length > 50 ? "..." : ""}"`,
          "debug",
        );

        const updatedStatus: ProviderStatus = {
          ...status,
          healthy: true,
          error: undefined,
          lastChecked: new Date(),
        };
        this.providerStatus.set(id, updatedStatus);
        this.logger?.log(`Provider ${id}: Health check passed`, "debug");
      } catch (error) {
        const updatedStatus: ProviderStatus = {
          ...status,
          healthy: false,
          error: `Health check failed: ${error}`,
          lastChecked: new Date(),
        };
        this.providerStatus.set(id, updatedStatus);
        this.logger?.log(`Provider ${id}: ${updatedStatus.error}`, "error");
      }
    });

    await Promise.allSettled(checks);
    this.logger?.log("Health checks complete", "debug");

    return new Map(this.providerStatus);
  }

  // === Public API ===

  /**
   * Get a provider and model for a specific model name with parameter validation.
   * Returns a result object with success/failure information.
   */
  public getProviderForModel(
    modelName: string,
    llmParams?: { temperature?: number; maxOutputTokens?: number },
  ): ModelResult {
    // Check if model is blocked
    if (this.blockList.models?.includes(modelName)) {
      this.logger?.log(`Model blocked: ${modelName}`, "error");
      return { success: false, reason: "model-blocked" };
    }

    const modelInfo = this.models.get(modelName);
    if (!modelInfo) {
      this.logger?.log(`Model not found: ${modelName}`, "debug");
      return { success: false, reason: "model-not-found" };
    }

    const provider = this.providers.get(modelInfo.providerId);
    if (!provider) {
      this.logger?.log(`Provider not available: ${modelInfo.providerId}`, "debug");
      return { success: false, reason: "provider-unavailable" };
    }

    // Check health status
    const status = this.providerStatus.get(modelInfo.providerId);
    if (status?.status === "available" && status.healthy === false) {
      this.logger?.log(`Provider unhealthy: ${modelInfo.providerId}`, "debug");
      return { success: false, reason: "provider-unhealthy" };
    }

    // Validate and adjust parameters based on model capabilities
    if (llmParams) {
      // Check temperature support
      if (llmParams.temperature !== undefined && !modelInfo.temperature) {
        this.logger?.log(
          `Model ${modelName} doesn't support temperature control, parameter will be ignored`,
          "info",
        );
      }

      // Trim maxOutputTokens to model's limit
      if (
        llmParams.maxOutputTokens !== undefined &&
        llmParams.maxOutputTokens > modelInfo.limit.output
      ) {
        this.logger?.log(
          `Trimming maxOutputTokens from ${llmParams.maxOutputTokens} to model limit ${modelInfo.limit.output}`,
          "info",
        );
        llmParams.maxOutputTokens = modelInfo.limit.output;
      }
    }

    // Return the actual model instance
    return { success: true, model: provider.languageModel(modelInfo.modelId) };
  }

  /**
   * Get cost information for a model.
   */
  public getModelInfo(modelName: string): ModelInfoResult {
    // Check if model is blocked
    if (this.blockList.models?.includes(modelName)) {
      return { success: false, reason: "model-blocked" };
    }

    const info = this.models.get(modelName);
    if (!info) {
      return { success: false, reason: "model-not-found" };
    }

    return { success: true, info };
  }

  /**
   * Check if a model is available (provider exists and is healthy).
   */
  public isModelAvailable(modelName: string): boolean {
    const result = this.getProviderForModel(modelName);
    return result.success;
  }

  /**
   * Get all available models.
   */
  public getAvailableModels(): string[] {
    const available = new Set<string>();

    for (const fullModelId of this.uniqueModels) {
      if (this.isModelAvailable(fullModelId)) {
        available.add(fullModelId);
      }
    }

    return Array.from(available);
  }

  /**
   * Get provider status information.
   */
  public getProviderStatus(): Map<string, ProviderStatus> {
    return new Map(this.providerStatus);
  }

  /**
   * Calculate cost for a given token usage.
   */
  public calculateCost(
    modelName: string,
    inputTokens: number,
    outputTokens: number,
  ): number | null {
    const result = this.getModelInfo(modelName);
    if (!result.success) return null;

    const info = result.info;
    const inputCost = parseFloat(((inputTokens / 1_000_000) * (info.cost?.input || 0)).toFixed(10));
    const outputCost = parseFloat(
      ((outputTokens / 1_000_000) * (info.cost?.output || 0)).toFixed(10),
    );

    return inputCost + outputCost;
  }

  /**
   * Format cost as a readable string.
   */
  public formatCost(cost: number): string {
    if (cost === 0) {
      return "$0.0000";
    }
    if (cost < 0.01) {
      return `$${(cost * 100).toFixed(4)}¢`; // Show in cents for small amounts
    }
    return `$${cost.toFixed(4)}`;
  }

  /**
   * Get models for a specific provider
   */
  public getModelsForProvider(providerId: string): string[] {
    const models: string[] = [];
    for (const fullModelId of this.uniqueModels) {
      const model = this.models.get(fullModelId);
      if (model && model.providerId === providerId) {
        models.push(fullModelId);
      }
    }
    return models;
  }

  /**
   * Get summary statistics
   */
  public getStats(): {
    totalModels: number;
    totalProviders: number;
    availableProviders: number;
    healthyProviders: number;
  } {
    const totalModels = this.uniqueModels.size; // Use unique models count
    const totalProviders = PROVIDER_DEFINITIONS.length;
    const availableProviders = Array.from(this.providerStatus.values()).filter(
      (s) => s.status === "available",
    ).length;
    const healthyProviders = Array.from(this.providerStatus.values()).filter(
      (s) => s.status === "available" && s.healthy === true,
    ).length;

    return {
      totalModels,
      totalProviders,
      availableProviders,
      healthyProviders,
    };
  }
}
