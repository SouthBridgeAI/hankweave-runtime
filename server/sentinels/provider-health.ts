import type { LanguageModel, Provider } from "ai";
import { generateText } from "ai";
import { type ModelInfo, Models, priceUsage, type UsageTokens } from "../llm/index.js";
import { isProbeableProvider, probeProviderAccess } from "../provider-probe.js";
import type { Logger } from "../utils.js";
import { PROVIDER_DEFINITIONS } from "./provider-config.js";

/**
 * Sentinel provider health (spec 72 moved this out of the model registry):
 * which AI SDK providers have credentials, whether they answer, and the
 * LanguageModel a sentinel calls. Model records come from the model module
 * (`Models.current().get`, or the lookup a test passes); a sentinel model is
 * always a full "provider/model" id.
 */

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

/**
 * Bedrock's per-model access denial ("You don't have access to the model
 * with the specified model ID") — distinct from an IAM-level
 * bedrock:InvokeModel denial, which names the action instead. Reaching this
 * error proves the credential chain, request signing, and endpoint all work;
 * only console-granted model access is missing for the probed model.
 */
export function isModelAccessDenialError(error: unknown): boolean {
  const parts: string[] = [String(error)];
  if (error && typeof error === "object") {
    const { responseBody, cause } = error as { responseBody?: unknown; cause?: unknown };
    if (typeof responseBody === "string") parts.push(responseBody);
    if (cause) parts.push(String(cause));
  }
  return parts.some((part) => /don't have access to the model/i.test(part));
}

export interface ProviderHealthConfig {
  logger?: Logger;
  healthCheckTimeout?: number; // ms, default 5000
  performHealthCheckOnInit?: boolean; // default false
  blockList?: BlockList; // Optional blocklist for providers and models
  /** Where model records come from; defaults to the installed Models. */
  models?: Pick<Models, "get">;
}

/** Split a sentinel model id "provider/model" (first slash). */
function splitModelId(modelName: string): { provider: string; modelId: string } | undefined {
  // Trim, as model validation does: the only normalisation a spelling gets.
  const spelling = modelName.trim();
  const slash = spelling.indexOf("/");
  if (slash <= 0) return undefined;
  return { provider: spelling.substring(0, slash), modelId: spelling.substring(slash + 1) };
}

export class ProviderHealth {
  private providers = new Map<string, Provider>();
  private providerStatus = new Map<string, ProviderStatus>();
  /** API key per available provider (sentinel override first), for list-probe health checks. */
  private providerKeys = new Map<string, string | undefined>();
  private logger?: Logger;
  private healthCheckTimeout: number;
  private blockList: BlockList;
  private readonly models?: Pick<Models, "get">;

  constructor(config: ProviderHealthConfig = {}) {
    this.logger = config.logger;
    this.healthCheckTimeout = config.healthCheckTimeout || 5000;
    this.blockList = config.blockList || {};
    this.models = config.models;
    this.initializeProviders();

    if (config.performHealthCheckOnInit) {
      // Don't await, let it run in background
      this.performHealthChecks().catch((err) => {
        this.logger?.log(`Background health checks failed: ${err}`, "error");
      });
    }
  }

  private lookup(modelName: string): ModelInfo | undefined {
    const split = splitModelId(modelName);
    if (!split) return undefined;
    return (this.models ?? Models.current()).get(split.provider, split.modelId, "sentinel");
  }

  /**
   * Generation health-check candidates for a provider without a model-list
   * probe, in preference order: the provider's environment-dependent list.
   * The health check tries them in order — a region- or account-specific
   * failure on one candidate must not condemn the provider when a sibling
   * profile works.
   */
  public getHealthCheckModelCandidates(providerId: string): string[] {
    const def = PROVIDER_DEFINITIONS.find((d) => d.id === providerId);
    return def?.healthCheckModels?.() ?? [];
  }

  /**
   * Get the best model for a health check (first candidate).
   */
  public getHealthCheckModel(providerId: string): string | undefined {
    return this.getHealthCheckModelCandidates(providerId)[0];
  }

  private initializeProviders(): void {
    for (const def of PROVIDER_DEFINITIONS) {
      // Check HANKWEAVE_SENTINEL_ prefixed var first, then fall back to standard
      const sentinelEnvVar = `HANKWEAVE_SENTINEL_${def.apiKeyEnvVar}`;
      const apiKey = process.env[sentinelEnvVar] || process.env[def.apiKeyEnvVar];

      // Which credential source makes this provider available: the single-key
      // env var when set, else the provider's ambient credential chain
      // (amazon-bedrock — key pair, profile, container creds, …) when it
      // detects one.
      let credentialSource = apiKey
        ? process.env[sentinelEnvVar]
          ? sentinelEnvVar
          : def.apiKeyEnvVar
        : undefined;
      if (!credentialSource && def.detectAmbientCredentials) {
        credentialSource = def.detectAmbientCredentials() ?? undefined;
      }

      if (!credentialSource) {
        const status: ProviderStatus = {
          status: "not-configured",
          id: def.id,
          error: def.detectAmbientCredentials
            ? `No credentials found (checked: ${sentinelEnvVar}, ${def.apiKeyEnvVar}, and ambient detection${def.credentialsHelp ? ` — ${def.credentialsHelp}` : ""})`
            : `No API key found (checked: ${sentinelEnvVar}, ${def.apiKeyEnvVar})`,
        };
        // Store with normalized (lowercase) provider ID for case-insensitive lookup
        this.providerStatus.set(def.id.toLowerCase(), status);
        this.logger?.log(`Provider ${def.id}: ${status.error}`, "debug");
        continue;
      }

      try {
        const provider = def.createProvider(apiKey ?? "");
        // Store with normalized (lowercase) provider ID for case-insensitive lookup
        this.providers.set(def.id.toLowerCase(), provider);
        this.providerKeys.set(def.id.toLowerCase(), apiKey);
        const status: ProviderStatus = {
          status: "available",
          id: def.id,
          healthy: false, // Will be updated by health check
        };
        this.providerStatus.set(def.id.toLowerCase(), status);
        this.logger?.log(`Provider ${def.id}: Initialized (using ${credentialSource})`, "info");
      } catch (error) {
        const status: ProviderStatus = {
          status: "failed",
          id: def.id,
          error: `Failed to initialize: ${error}`,
          lastChecked: new Date(),
        };
        this.providerStatus.set(def.id.toLowerCase(), status);
        this.logger?.log(`Provider ${def.id}: ${status.error}`, "error");
      }
    }
  }

  /**
   * Check if a model is blocked by the blocklist.
   * Checks both model-level and provider-level blocking (case-insensitive).
   *
   * @param modelInfo - The model information to check
   * @returns true if the model or its provider is blocked
   */
  private isModelBlocked(modelInfo: ModelInfo): boolean {
    const isModelBlocked = this.blockList.models?.some(
      (blocked) => blocked.toLowerCase() === modelInfo.modelId.toLowerCase(),
    );
    const isProviderBlocked = this.blockList.providers?.some(
      (blocked) => blocked.toLowerCase() === modelInfo.providerId.toLowerCase(),
    );

    return isModelBlocked || isProviderBlocked || false;
  }

  // === Health Checks ===

  /**
   * Check every available provider. Providers with a model-list API are
   * checked by listing models (free, and no model id to keep current);
   * the rest (amazon-bedrock) by a one-token generation against the
   * health-check candidates.
   */
  public async performHealthChecks(): Promise<Map<string, ProviderStatus>> {
    this.logger?.log("Starting provider health checks", "debug");

    const checks = Array.from(this.providers.entries()).map(async ([id, provider]) => {
      const status = this.providerStatus.get(id);
      if (!status || status.status !== "available") {
        this.logger?.log(`Skipping health check for ${id} (not available)`, "debug");
        return;
      }

      const apiKey = this.providerKeys.get(id);
      const failure =
        apiKey && isProbeableProvider(id)
          ? await this.checkByListing(id, apiKey)
          : await this.checkByGeneration(id, provider);
      this.providerStatus.set(
        id,
        failure === undefined
          ? { ...status, healthy: true, error: undefined, lastChecked: new Date() }
          : { ...status, healthy: false, error: failure, lastChecked: new Date() },
      );
      if (failure !== undefined) this.logger?.log(`Provider ${id}: ${failure}`, "error");
    });

    await Promise.allSettled(checks);
    this.logger?.log("Health checks complete", "debug");

    return new Map(this.providerStatus);
  }

  /** List the provider's models (free). Returns the failure, or undefined when healthy. */
  private async checkByListing(id: string, apiKey: string): Promise<string | undefined> {
    const access = await probeProviderAccess(id, apiKey, { timeoutMs: this.healthCheckTimeout });
    if (access.ok) this.logger?.log(`Provider ${id}: Health check passed`, "debug");
    return access.ok ? undefined : `Health check failed: ${access.reason}`;
  }

  /**
   * A one-token generation against each candidate until one works. Returns
   * the failure, or undefined when healthy.
   */
  private async checkByGeneration(id: string, provider: Provider): Promise<string | undefined> {
    const candidates = this.getHealthCheckModelCandidates(id);
    if (candidates.length === 0) return "No models available";
    let lastError: unknown;
    for (const testModel of candidates) {
      const outcome = await this.generateOnce(id, provider, testModel);
      if (outcome === "healthy") return undefined;
      lastError = outcome.error;
    }
    return `Health check failed: ${lastError}`;
  }

  private async generateOnce(
    id: string,
    provider: Provider,
    testModel: string,
  ): Promise<"healthy" | { error: unknown }> {
    this.logger?.log(`Using ${testModel} for ${id} health check`, "debug");
    // Abort on timeout instead of racing a bare timer: a raced timeout
    // leaves the request in flight, so the candidate loop would start the
    // fallback while the first billable call still runs — and a slow
    // provider would keep receiving work after its status was returned.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.healthCheckTimeout);
    try {
      const result = await generateText({
        model: provider.languageModel(testModel),
        messages: [{ role: "user", content: "Hi" }],
        maxOutputTokens: 16, // Minimum required by most providers
        temperature: 0,
        abortSignal: controller.signal,
      });
      this.logger?.log(
        `Provider ${id}: Health check passed ("${result.text.substring(0, 50)}")`,
        "debug",
      );
      return "healthy";
    } catch (error) {
      // A per-model access denial proves credentials, signing, and the
      // endpoint all work — only console-granted model access differs,
      // which is per model anyway and surfaces properly at a sentinel's
      // own first call. Don't condemn the whole provider for it.
      if (isModelAccessDenialError(error)) {
        this.logger?.log(
          `Provider ${id}: Health check model ${testModel} not enabled for this account, but the denial proves credentials work — marking healthy`,
          "info",
        );
        return "healthy";
      }
      const failure = controller.signal.aborted ? new Error("Health check timeout") : error;
      this.logger?.log(
        `Provider ${id}: Health check with ${testModel} failed: ${failure}`,
        "debug",
      );
      return { error: failure };
    } finally {
      clearTimeout(timeoutId);
    }
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
    const modelInfo = this.lookup(modelName);
    if (!modelInfo) {
      this.logger?.log(`Model not found: ${modelName}`, "debug");
      return { success: false, reason: "model-not-found" };
    }

    // Check if model or provider is blocked (case-insensitive)
    // This ensures blocking works whether user provides "claude-x" or "anthropic/claude-x"
    if (this.isModelBlocked(modelInfo)) {
      this.logger?.log(`Model blocked: ${modelName}`, "error");
      return { success: false, reason: "model-blocked" };
    }

    // Normalize provider ID for case-insensitive lookup
    const normalizedProviderId = modelInfo.providerId.toLowerCase();
    const provider = this.providers.get(normalizedProviderId);
    if (!provider) {
      this.logger?.log(`Provider not available: ${modelInfo.providerId}`, "debug");
      return { success: false, reason: "provider-unavailable" };
    }

    // Check health status
    const status = this.providerStatus.get(normalizedProviderId);
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
    const info = this.lookup(modelName);
    if (!info) {
      return { success: false, reason: "model-not-found" };
    }

    // Check if model or provider is blocked (case-insensitive)
    // This ensures blocking works whether user provides "claude-x" or "anthropic/claude-x"
    if (this.isModelBlocked(info)) {
      return { success: false, reason: "model-blocked" };
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
   * Get provider status information.
   */
  public getProviderStatus(): Map<string, ProviderStatus> {
    return new Map(this.providerStatus);
  }

  /**
   * Calculate cost for a given token usage with full cache support, at the
   * rates budgets account at (see priceUsage: a disputed price uses the
   * higher source, an unknown price the flagged ceiling estimate).
   *
   * Token semantics are the Claude session schema's for every provider (see
   * UsageTokens). This method used to special-case `openai` as
   * cache-inclusive; that matched the codex shim's raw usage and became a
   * second subtraction once OpenAI models moved to pi, under-counting every
   * codon with cache hits.
   *
   * @param modelName - Model identifier (exact catalog key)
   * @param usage - Token usage breakdown, fresh input + additive cache tokens
   * @returns Cost in USD, or null if model not found or no pricing data available
   */
  public calculateCost(modelName: string, usage: UsageTokens): number | null {
    const result = this.getModelInfo(modelName);
    if (!result.success) {
      this.logger?.log(`Cannot calculate cost: model not found: ${modelName}`, "debug");
      return null;
    }
    const priced = priceUsage(result.info, usage);
    if (!priced) {
      this.logger?.log(`Cannot calculate cost: no pricing data for ${modelName}`, "debug");
      return null;
    }
    return priced.cost;
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
}
