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

export type ResolveModelResult =
  | {
      success: true;
      modelInfo: ModelInfo;
      matchType: "exact" | "exact-with-inferred-provider" | "fuzzy";
    }
  | {
      success: false;
      reason: "model-not-found" | "model-blocked";
    };

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
  private static instance: LlmProviderRegistry | null = null;

  /**
   * Common shortcuts for model names that map to search patterns.
   * These are expanded before model resolution to improve matching.
   *
   * Applied via applyModelShortcuts(), which also matches provider-qualified
   * forms ("openai/gpt-5.6") and reasoning-effort-suffixed forms
   * ("gpt-5.6-high") so shortcuts can't be bypassed by qualification.
   */
  private static readonly MODEL_SHORTCUTS: Record<string, string> = {
    opus: "claude-opus",
    sonnet: "claude-sonnet",
    haiku: "claude-haiku",
    // gpt-5.6 ships as sibling variants (sol/luna/terra); the bare name should
    // land on the default "sol" variant rather than the abstract gpt-5.6 alias.
    // Codex has no "gpt-5.6" slug — sending it fails at runtime — so every
    // spelling that would strip down to bare gpt-5.6 must route to sol.
    "gpt-5.6": "gpt-5.6-sol",
  };

  /**
   * Reasoning-effort suffixes auto-generated as model variants for
   * reasoning-capable OpenAI models (see loadModelsData). The codex shim
   * strips these suffixes and passes them as model_reasoning_effort.
   */
  private static readonly REASONING_EFFORTS = ["high", "xhigh"] as const;

  /**
   * Expand a model name through MODEL_SHORTCUTS.
   *
   * Handles three spellings beyond the exact key:
   * - Provider-qualified: "openai/gpt-5.6" → "openai/gpt-5.6-sol"
   * - Effort-suffixed: "gpt-5.6-high" → "gpt-5.6-sol-high" (these variants are
   *   auto-generated from the abstract record by loadModelsData, so they
   *   resolve successfully but would fail at runtime otherwise)
   * - Both: "openai/gpt-5.6-xhigh" → "openai/gpt-5.6-sol-xhigh"
   *
   * Returns the input unchanged when no shortcut applies.
   */
  private static applyModelShortcuts(model: string): string {
    const lower = model.toLowerCase();

    const direct = LlmProviderRegistry.MODEL_SHORTCUTS[lower];
    if (direct) return direct;

    // Provider-qualified: apply the shortcut to the part after the first "/"
    const slashIndex = lower.indexOf("/");
    if (slashIndex > 0) {
      const prefix = lower.substring(0, slashIndex);
      const rest = lower.substring(slashIndex + 1);
      const expanded = LlmProviderRegistry.applyModelShortcuts(rest);
      return expanded === rest ? model : `${prefix}/${expanded}`;
    }

    // Effort-suffixed: apply the shortcut to the base, keep the suffix
    for (const effort of LlmProviderRegistry.REASONING_EFFORTS) {
      const suffix = `-${effort}`;
      if (lower.endsWith(suffix)) {
        const base = lower.substring(0, lower.length - suffix.length);
        const target = LlmProviderRegistry.MODEL_SHORTCUTS[base];
        if (target) return `${target}${suffix}`;
      }
    }

    return model;
  }

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

  /**
   * Get the singleton instance of LlmProviderRegistry.
   * Creates a new instance with the provided config if one doesn't exist.
   *
   * @param config - Configuration for the registry (only used on first call)
   * @returns The singleton instance
   */
  public static getInstance(config?: LlmProviderRegistryConfig): LlmProviderRegistry {
    if (!LlmProviderRegistry.instance) {
      LlmProviderRegistry.instance = new LlmProviderRegistry(config);
    }
    return LlmProviderRegistry.instance;
  }

  /**
   * Reset the singleton instance (primarily for testing).
   */
  public static resetInstance(): void {
    LlmProviderRegistry.instance = null;
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

      // Auto-generate reasoning effort variants for all reasoning-capable OpenAI models.
      // The codex shim strips the suffix (e.g. "-high") and passes it as model_reasoning_effort.
      // We register these so the registry can resolve and return cost info for them.
      const REASONING_EFFORTS = LlmProviderRegistry.REASONING_EFFORTS;
      const effortCostMultiplier: Record<string, number> = {
        high: 1,
        xhigh: 2,
      };
      const reasoningEffortModels: ModelInfo[] = [];

      for (const provider of allProviders) {
        if (provider.id !== "openai") continue;
        for (const model of provider.models) {
          if (!model.reasoning) continue;
          for (const effort of REASONING_EFFORTS) {
            const multiplier = effortCostMultiplier[effort];
            reasoningEffortModels.push({
              ...model,
              modelId: `${model.modelId}-${effort}`,
              name: `${model.name} (${effort})`,
              cost: model.cost
                ? {
                    input:
                      model.cost.input !== undefined ? model.cost.input * multiplier : undefined,
                    output:
                      model.cost.output !== undefined ? model.cost.output * multiplier : undefined,
                    cache_read:
                      model.cost.cache_read !== undefined
                        ? model.cost.cache_read * multiplier
                        : undefined,
                    cache_write:
                      model.cost.cache_write !== undefined
                        ? model.cost.cache_write * multiplier
                        : undefined,
                  }
                : undefined,
            });
          }
        }
      }

      // Process each provider's models
      // Note: We load all models regardless of blocklist, and check blocklist during resolution
      for (const provider of allProviders) {
        for (const model of provider.models) {
          const fullModelId = `${model.providerId}/${model.modelId}`;

          // Track unique models (normalized to lowercase for consistency)
          this.uniqueModels.add(fullModelId.toLowerCase());

          // Register by both full and short names for convenience
          // Normalize keys to lowercase for case-insensitive lookup
          this.models.set(fullModelId.toLowerCase(), model);
          // Only register by short ID if it doesn't contain a slash
          // (to avoid conflicts where providers have modelIds like "google/gemini-xxx")
          if (!model.modelId.includes("/")) {
            const shortKey = model.modelId.toLowerCase();
            const existing = this.models.get(shortKey);
            // Don't let resellers overwrite the preferred/canonical provider for a model
            if (!existing || existing.providerId !== this.getPreferredProvider(model.modelId)) {
              this.models.set(shortKey, model);
            }
          }
        }
      }

      // Register reasoning effort variant models
      for (const model of reasoningEffortModels) {
        const fullModelId = `${model.providerId}/${model.modelId}`;
        this.uniqueModels.add(fullModelId.toLowerCase());
        this.models.set(fullModelId.toLowerCase(), model);
        this.models.set(model.modelId.toLowerCase(), model);
      }

      this.logger?.log(`Loaded ${this.uniqueModels.size} unique models from data files`, "info");
    } catch (error) {
      this.logger?.log(`Failed to load models data: ${error}`, "error");
      // Continue with empty models map - providers may still work
    }
  }

  /**
   * Find the cheapest model for a provider.
   * Used for health checks and credit validation where we want the
   * lowest-cost model that still works as a chat model.
   *
   * Filters to:
   * - Chat models only (not embeddings)
   * - Models that support both text input and text output
   *
   * Prefers models updated in the last 6 months (more likely to still be
   * active on the provider's API). Falls back to 1 year if nothing recent
   * enough is found, then drops the date filter entirely as a last resort.
   */
  public findCheapestModel(providerId: string): string | undefined {
    // Build a filtered list of candidate chat models for this provider
    const candidates: ModelInfo[] = [];
    for (const model of this.models.values()) {
      if (model.providerId.toLowerCase() !== providerId.toLowerCase()) continue;

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

      if (!model.cost?.input || model.cost.input <= 0) continue;

      candidates.push(model);
    }

    if (candidates.length === 0) return undefined;

    // Tiered date filtering: prefer recent models, widen if needed
    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    // Pad YYYY-MM to YYYY-MM-01 for consistent comparison
    const padDate = (d: string) => (d.length === 7 ? `${d}-01` : d);
    const sixMoCutoff = sixMonthsAgo.toISOString().substring(0, 10);
    const oneYrCutoff = oneYearAgo.toISOString().substring(0, 10);

    const recentCandidates = candidates.filter((m) => padDate(m.last_updated) >= sixMoCutoff);
    const yearCandidates = candidates.filter((m) => padDate(m.last_updated) >= oneYrCutoff);

    // Dated preview models (e.g. "gemini-2.5-flash-lite-preview-09-2025") are
    // ephemeral and get deprecated without notice. Prefer stable model IDs
    // when costs are equal.
    const isDatedPreview = (id: string) => /preview-\d{2}/.test(id);

    const pickCheapest = (models: ModelInfo[]): ModelInfo | undefined => {
      let best: ModelInfo | undefined;
      let lowestCost = Number.POSITIVE_INFINITY;
      for (const m of models) {
        const cost = m.cost?.input ?? Number.POSITIVE_INFINITY;
        if (cost < lowestCost) {
          lowestCost = cost;
          best = m;
        } else if (
          cost === lowestCost &&
          best &&
          isDatedPreview(best.modelId) &&
          !isDatedPreview(m.modelId)
        ) {
          best = m;
        }
      }
      return best;
    };

    // Try 6-month window first, then 1-year, then all candidates
    const chosen =
      pickCheapest(recentCandidates) ?? pickCheapest(yearCandidates) ?? pickCheapest(candidates);

    if (chosen) {
      this.logger?.log(
        `Selected ${chosen.modelId} as cheapest for ${providerId} (input cost: $${chosen.cost?.input}/M tokens, updated: ${chosen.last_updated})`,
        "debug",
      );
    }

    return chosen?.modelId;
  }

  /**
   * Get the best model for a health check.
   * Tries provider-configured preferred models first (stable, non-preview IDs),
   * then falls back to findCheapestModel.
   */
  public getHealthCheckModel(providerId: string): string | undefined {
    const def = PROVIDER_DEFINITIONS.find((d) => d.id.toLowerCase() === providerId.toLowerCase());

    if (def?.healthCheckModels) {
      for (const modelId of def.healthCheckModels) {
        if (this.models.has(modelId.toLowerCase())) {
          this.logger?.log(
            `Using preferred health check model ${modelId} for ${providerId}`,
            "debug",
          );
          return modelId;
        }
      }
      this.logger?.log(
        `No preferred health check models found for ${providerId}, falling back to cheapest`,
        "debug",
      );
    }

    return this.findCheapestModel(providerId);
  }

  private initializeProviders(): void {
    for (const def of PROVIDER_DEFINITIONS) {
      // Check HANKWEAVE_SENTINEL_ prefixed var first, then fall back to standard
      const sentinelEnvVar = `HANKWEAVE_SENTINEL_${def.apiKeyEnvVar}`;
      const apiKey = process.env[sentinelEnvVar] || process.env[def.apiKeyEnvVar];

      if (!apiKey) {
        const status: ProviderStatus = {
          status: "not-configured",
          id: def.id,
          error: `No API key found (checked: ${sentinelEnvVar}, ${def.apiKeyEnvVar})`,
        };
        // Store with normalized (lowercase) provider ID for case-insensitive lookup
        this.providerStatus.set(def.id.toLowerCase(), status);
        this.logger?.log(`Provider ${def.id}: ${status.error}`, "debug");
        continue;
      }

      // Log which env var was used (helpful for debugging)
      const usedEnvVar = process.env[sentinelEnvVar] ? sentinelEnvVar : def.apiKeyEnvVar;

      try {
        const provider = def.createProvider(apiKey);
        // Store with normalized (lowercase) provider ID for case-insensitive lookup
        this.providers.set(def.id.toLowerCase(), provider);
        const status: ProviderStatus = {
          status: "available",
          id: def.id,
          healthy: false, // Will be updated by health check
        };
        this.providerStatus.set(def.id.toLowerCase(), status);
        this.logger?.log(`Provider ${def.id}: Initialized (using ${usedEnvVar})`, "info");
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

  // === Blocklist Helpers ===

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

  // === Model Resolution Helpers ===

  /**
   * Calculate Levenshtein distance between two strings
   * Returns a similarity score from 0 to 1 (1 = identical)
   */
  private calculateStringSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;

    // Levenshtein distance algorithm
    const matrix: number[][] = [];

    // Initialize first column
    for (let i = 0; i <= s2.length; i++) {
      matrix[i] = [i];
    }

    // Initialize first row
    for (let j = 0; j <= s1.length; j++) {
      matrix[0][j] = j;
    }

    // Fill in the rest of the matrix
    for (let i = 1; i <= s2.length; i++) {
      for (let j = 1; j <= s1.length; j++) {
        if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1, // deletion
          );
        }
      }
    }

    const distance = matrix[s2.length][s1.length];
    const maxLength = Math.max(s1.length, s2.length);

    return 1 - distance / maxLength;
  }

  /**
   * Get preferred provider for a model based on naming patterns
   * Uses fuzzy matching to handle typos
   */
  private getPreferredProvider(modelName: string): string | null {
    const lowerModel = modelName.toLowerCase();

    // Exact matching first
    if (lowerModel.includes("claude")) return "anthropic";
    if (lowerModel.includes("gemini")) return "google";
    // DeepSeek models are also resold by aggregators (e.g. poe, venice); the
    // first-party "deepseek" provider is the canonical home, so prefer it for
    // any deepseek-named model rather than letting a reseller win the bare id.
    if (lowerModel.includes("deepseek")) return "deepseek";
    // GLM models are made by Zhipu AI (canonical provider id "zhipuai"; "zai"/
    // "Z.AI" is its international brand) and widely resold across aggregators;
    // prefer the first-party "zhipuai" provider so a bare "glm-*" id resolves
    // deterministically instead of to whichever reseller loads last. Runtime
    // execution still goes through the pi shim's "zai" provider (pi has no
    // "zhipuai" provider) — see rewriteGlmModel in model-validator.ts.
    if (lowerModel.startsWith("glm-")) return "zhipuai";
    if (
      lowerModel.startsWith("gpt-") ||
      lowerModel.startsWith("o1-") ||
      lowerModel.startsWith("o3-")
    ) {
      return "openai";
    }

    // Fuzzy matching for typos (threshold 0.75)
    const patterns = [
      { term: "claude", provider: "anthropic" },
      { term: "gemini", provider: "google" },
      { term: "gpt", provider: "openai" },
      { term: "deepseek", provider: "deepseek" },
    ];

    for (const { term, provider } of patterns) {
      const similarity = this.calculateStringSimilarity(lowerModel, term);
      if (similarity >= 0.75) {
        return provider;
      }
      // Also check if the search query contains a fuzzy match
      // by checking each word in the query
      const words = lowerModel.split(/[-_\s]/);
      for (const word of words) {
        if (word.length >= 3) {
          const wordSimilarity = this.calculateStringSimilarity(word, term);
          if (wordSimilarity >= 0.75) {
            return provider;
          }
        }
      }
    }

    return null;
  }

  /**
   * Find models matching the query using fuzzy matching
   * Returns the most recent model above the similarity threshold
   *
   * @internal Match object: { model: ModelInfo, score: number, hasExactWordMatch: boolean }
   */
  private fuzzyMatchModels(
    modelName: string,
    threshold: number,
    ignoreBlockList: boolean,
    providerId?: string,
  ): ModelInfo | null {
    const matches: Array<{
      model: ModelInfo;
      score: number;
      hasExactWordMatch: boolean;
    }> = [];
    const preferredProvider = providerId || this.getPreferredProvider(modelName);

    // Search through all unique models
    for (const fullModelId of this.uniqueModels) {
      const model = this.models.get(fullModelId);
      if (!model) continue;

      // Filter by provider if specified (case-insensitive comparison)
      if (providerId && model.providerId.toLowerCase() !== providerId.toLowerCase()) continue;

      // Check blocklist (case-insensitive)
      if (!ignoreBlockList) {
        if (
          this.blockList.models?.some(
            (blocked) => blocked.toLowerCase() === model.modelId.toLowerCase(),
          )
        )
          continue;
        if (
          this.blockList.providers?.some(
            (blocked) => blocked.toLowerCase() === model.providerId.toLowerCase(),
          )
        )
          continue;
      }

      // Calculate similarity against both modelId and name
      let modelIdScore = this.calculateStringSimilarity(modelName, model.modelId);
      let nameScore = this.calculateStringSimilarity(modelName, model.name);

      // Boost score for substring/prefix matches (more natural matches)
      const lowerModelName = modelName.toLowerCase();
      const lowerModelId = model.modelId.toLowerCase();
      const lowerName = model.name.toLowerCase();

      if (lowerModelId.includes(lowerModelName) || lowerModelId.startsWith(lowerModelName)) {
        modelIdScore = Math.min(1.0, modelIdScore + 0.2); // Boost substring matches
      }
      if (lowerName.includes(lowerModelName) || lowerName.startsWith(lowerModelName)) {
        nameScore = Math.min(1.0, nameScore + 0.2); // Boost substring matches
      }

      // Additional boost for word-level matches (helps with typos and version numbers)
      // If search has multiple words, boost models where all words closely match
      const searchWords = lowerModelName.split(/[-_\s]+/).filter((w) => w.length >= 3);
      let hasExactWordMatch = false;

      if (searchWords.length >= 2) {
        const modelIdWords = lowerModelId.split(/[-_\s]+/);
        const nameWords = lowerName.split(/[-_\s]+/);

        // Check if all search words have close matches in model
        const allWordsMatchId = searchWords.every((sw) =>
          modelIdWords.some((mw) => {
            // Exact match or high similarity (0.75+) or contains
            return (
              mw === sw ||
              mw.includes(sw) ||
              // Removed sw.includes(mw) to prevent "xhigh" from matching "high"
              this.calculateStringSimilarity(sw, mw) >= 0.75
            );
          }),
        );

        const allWordsMatchName = searchWords.every((sw) =>
          nameWords.some((mw) => {
            return (
              mw === sw ||
              mw.includes(sw) ||
              // Removed sw.includes(mw) to prevent "xhigh" from matching "high"
              this.calculateStringSimilarity(sw, mw) >= 0.75
            );
          }),
        );

        // Track whether ALL words are exact matches (not just fuzzy)
        if (allWordsMatchId) {
          const hasExactWordMatchId = searchWords.every((sw) =>
            modelIdWords.some((mw) => mw === sw),
          );
          if (hasExactWordMatchId) {
            hasExactWordMatch = true;
          }
        }

        if (allWordsMatchName) {
          const hasExactWordMatchName = searchWords.every((sw) =>
            nameWords.some((mw) => mw === sw),
          );
          if (hasExactWordMatchName) {
            hasExactWordMatch = true;
          }
        }

        if (allWordsMatchId) {
          modelIdScore = Math.min(1.0, modelIdScore + 0.15); // Boost word-level matches
        }
        if (allWordsMatchName) {
          nameScore = Math.min(1.0, nameScore + 0.15); // Boost word-level matches
        }
      }

      let score = Math.max(modelIdScore, nameScore);

      // Boost score for models from the preferred provider (helps with provider preference)
      // Case-insensitive comparison
      if (preferredProvider && model.providerId.toLowerCase() === preferredProvider.toLowerCase()) {
        score = Math.min(1.0, score + 0.1); // Boost preferred provider models
      }

      if (score >= threshold) {
        matches.push({ model, score, hasExactWordMatch });
      }
    }

    if (matches.length === 0) return null;

    // Sort by score (descending), then by preferred provider, then by date (newest first), then by score again
    // Use 0.20 threshold to prefer recency and provider when scores are close
    matches.sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.2) {
        return b.score - a.score;
      }

      // When scores are close, prefer the preferred provider
      // Case-insensitive comparison
      if (preferredProvider && !providerId) {
        const aIsPreferred = a.model.providerId.toLowerCase() === preferredProvider.toLowerCase();
        const bIsPreferred = b.model.providerId.toLowerCase() === preferredProvider.toLowerCase();
        if (aIsPreferred !== bIsPreferred) {
          return aIsPreferred ? -1 : 1;
        }
      }

      // When scores are close, prefer exact word matches over fuzzy matches
      if (a.hasExactWordMatch !== b.hasExactWordMatch) {
        return a.hasExactWordMatch ? -1 : 1;
      }

      // Inline date comparison - Pad YYYY-MM to YYYY-MM-01 for comparison
      const dateA = new Date(
        a.model.last_updated.length === 7 ? `${a.model.last_updated}-01` : a.model.last_updated,
      );
      const dateB = new Date(
        b.model.last_updated.length === 7 ? `${b.model.last_updated}-01` : b.model.last_updated,
      );
      const dateDiff = dateB.getTime() - dateA.getTime();

      // If dates are equal, use score as final tiebreaker
      if (dateDiff === 0) {
        return b.score - a.score; // Higher score wins
      }

      return dateDiff; // Descending (newest first)
    });

    // Return the best match (now properly sorted with provider preference)
    return matches[0].model;
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

      const testModel = this.getHealthCheckModel(id);

      if (!testModel) {
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

      this.logger?.log(`Using ${testModel} for ${id} health check`, "debug");

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
          `Provider ${id} health check response: "${result.text.substring(
            0,
            50,
          )}${result.text.length > 50 ? "..." : ""}"`,
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
    // Normalize model name for case-insensitive lookup
    const normalizedName = modelName.toLowerCase();

    // First, look up the model to get its ModelInfo (which has the short modelId)
    const modelInfo = this.models.get(normalizedName);
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
    // Normalize model name for case-insensitive lookup
    const normalizedName = modelName.toLowerCase();

    // First, look up the model to get its ModelInfo (which has the short modelId)
    const info = this.models.get(normalizedName);
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
   * Resolve a model name to model information with support for:
   * - Exact matching with explicit provider
   * - Exact matching with provider inference
   * - Fuzzy matching with provider preferences
   *
   * @param input.providerId - Optional provider ID (e.g., "anthropic", "google", "openai")
   * @param input.model - Model name (exact or fuzzy, e.g., "claude-3-5-sonnet" or "claude-sonnet")
   * @param input.ignoreBlockList - Whether to ignore the blocklist (default: true)
   * @returns ResolveModelResult with model info and match type, or failure reason
   */
  public resolveModel(input: {
    providerId?: string;
    model: string;
    ignoreBlockList?: boolean;
  }): ResolveModelResult {
    let { providerId, model, ignoreBlockList = true } = input;
    const FUZZY_THRESHOLD = 0.6;

    // Apply shortcuts: expand common short names to search patterns.
    // Handles bare, provider-qualified, and effort-suffixed spellings.
    model = LlmProviderRegistry.applyModelShortcuts(model);

    // Helper to check if a model is blocked (case-insensitive)
    const isBlocked = (modelInfo: ModelInfo): boolean => {
      if (ignoreBlockList) return false;
      return (
        this.blockList.models?.some(
          (blocked) => blocked.toLowerCase() === modelInfo.modelId.toLowerCase(),
        ) ||
        this.blockList.providers?.some(
          (blocked) => blocked.toLowerCase() === modelInfo.providerId.toLowerCase(),
        ) ||
        false
      );
    };

    // Phase 1: Exact match with provider
    if (providerId) {
      // Check if the provider itself is blocked (case-insensitive)
      if (
        !ignoreBlockList &&
        this.blockList.providers?.some(
          (blocked) => blocked.toLowerCase() === providerId.toLowerCase(),
        )
      ) {
        return { success: false, reason: "model-blocked" };
      }

      const fullModelId = `${providerId}/${model}`;
      // Normalize for case-insensitive lookup
      let modelInfo = this.models.get(fullModelId.toLowerCase());

      // Also try just the model name in case it's already a full ID
      if (!modelInfo) {
        modelInfo = this.models.get(model.toLowerCase());
        // Verify it's from the requested provider (case-insensitive comparison)
        if (modelInfo && modelInfo.providerId.toLowerCase() !== providerId.toLowerCase()) {
          modelInfo = undefined;
        }
      }

      if (modelInfo) {
        if (isBlocked(modelInfo)) {
          return { success: false, reason: "model-blocked" };
        }

        return {
          success: true,
          modelInfo,
          matchType: "exact",
        };
      }

      // No exact match with the specified provider - fall through to fuzzy matching
    }

    // Phase 2: Exact match with provider inference (only if no provider specified)
    if (!providerId) {
      // Check for preferred provider first
      const preferredProvider = this.getPreferredProvider(model);

      // Try preferred provider first if available
      if (preferredProvider) {
        const preferredModelId = `${preferredProvider}/${model}`;
        // Normalize for case-insensitive lookup
        const preferredMatch = this.models.get(preferredModelId.toLowerCase());

        if (preferredMatch) {
          if (isBlocked(preferredMatch)) {
            return { success: false, reason: "model-blocked" };
          }

          return {
            success: true,
            modelInfo: preferredMatch,
            matchType: "exact-with-inferred-provider",
          };
        }
      }

      // Fall back to any provider if preferred not found
      // Normalize for case-insensitive lookup
      const directMatch = this.models.get(model.toLowerCase());
      if (directMatch) {
        if (isBlocked(directMatch)) {
          return { success: false, reason: "model-blocked" };
        }

        return {
          success: true,
          modelInfo: directMatch,
          matchType: "exact-with-inferred-provider",
        };
      }
    }

    // Phase 3: Fuzzy matching
    const fuzzyMatch = this.fuzzyMatchModels(model, FUZZY_THRESHOLD, ignoreBlockList, providerId);

    return fuzzyMatch
      ? {
          success: true,
          modelInfo: fuzzyMatch,
          matchType: "fuzzy",
        }
      : { success: false, reason: "model-not-found" };
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
   * Calculate cost for a given token usage with full cache support.
   *
   * Handles provider-specific token semantics:
   * - OpenAI: inputTokens INCLUDES cached tokens (cache_read is a subset)
   * - Anthropic: inputTokens is fresh only (cache_read is additive)
   *
   * @param modelName - Model identifier (will be resolved via registry)
   * @param usage - Token usage breakdown
   * @returns Cost in USD, or null if model not found or no pricing data available
   */
  public calculateCost(
    modelName: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
  ): number | null {
    const result = this.getModelInfo(modelName);
    if (!result.success) {
      this.logger?.log(`Cannot calculate cost: model not found: ${modelName}`, "debug");
      return null;
    }

    const { cost, providerId } = result.info;
    if (!cost) {
      this.logger?.log(`Cannot calculate cost: no pricing data for ${modelName}`, "debug");
      return null;
    }

    const cacheReadTokens = usage.cacheReadTokens || 0;

    // Handle provider-specific token semantics for cache reads
    // OpenAI: inputTokens includes cached tokens (cache_read is a subset)
    // Anthropic and others: inputTokens is fresh only (cache_read is additive)
    const isOpenAI = providerId === "openai";
    let inputCost: number;

    if (isOpenAI && cacheReadTokens > 0) {
      // OpenAI: Subtract cached from total to get fresh input tokens
      const freshInputTokens = Math.max(0, usage.inputTokens - cacheReadTokens);
      inputCost = (freshInputTokens / 1_000_000) * (cost.input || 0);
    } else {
      // Anthropic-style: inputTokens is already fresh only
      inputCost = (usage.inputTokens / 1_000_000) * (cost.input || 0);
    }

    const outputCost = (usage.outputTokens / 1_000_000) * (cost.output || 0);
    const cacheReadCost = (cacheReadTokens / 1_000_000) * (cost.cache_read || 0);
    const cacheWriteCost = ((usage.cacheCreationTokens || 0) / 1_000_000) * (cost.cache_write || 0);

    return inputCost + outputCost + cacheReadCost + cacheWriteCost;
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
    // Normalize provider ID for case-insensitive comparison
    const normalizedProviderId = providerId.toLowerCase();
    for (const fullModelId of this.uniqueModels) {
      const model = this.models.get(fullModelId);
      if (model && model.providerId.toLowerCase() === normalizedProviderId) {
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
