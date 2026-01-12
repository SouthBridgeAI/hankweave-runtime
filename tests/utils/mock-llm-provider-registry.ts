import type { LanguageModel } from "ai";
import type {
  LlmProviderRegistryConfig,
  ProviderStatus,
} from "../../server/llm/llm-provider-registry.js";
import type { Logger } from "../../server/utils.js";

export interface MockModelInfo {
  providerId: string;
  modelId: string;
  name: string;
  fullModelId: string;
  costPerMillionInput: number;
  costPerMillionOutput: number;
  maxContext: number;
  maxOutput: number;
  deprecated: boolean;
}

export class MockLlmProviderRegistry {
  private mockProviders = new Map<string, boolean>();
  private mockModels = new Map<string, MockModelInfo>();
  private mockHealth = new Map<string, boolean>();
  private logger?: Logger;

  constructor(config: LlmProviderRegistryConfig = {}) {
    this.logger = config.logger;

    // Initialize with some default mock models
    this.addDefaultMockModels();
  }

  private addDefaultMockModels(): void {
    const defaultModels: MockModelInfo[] = [
      {
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        fullModelId: "anthropic/claude-3-5-sonnet-20241022",
        costPerMillionInput: 3.0,
        costPerMillionOutput: 15.0,
        maxContext: 200000,
        maxOutput: 8192,
        deprecated: false,
      },
      {
        providerId: "openai",
        modelId: "gpt-4o-mini",
        name: "GPT-4o mini",
        fullModelId: "openai/gpt-4o-mini",
        costPerMillionInput: 0.15,
        costPerMillionOutput: 0.6,
        maxContext: 128000,
        maxOutput: 16384,
        deprecated: false,
      },
      {
        providerId: "google",
        modelId: "gemini-1.5-flash",
        name: "Gemini 1.5 Flash",
        fullModelId: "google/gemini-1.5-flash",
        costPerMillionInput: 0.075,
        costPerMillionOutput: 0.3,
        maxContext: 1000000,
        maxOutput: 8192,
        deprecated: false,
      },
    ];

    for (const model of defaultModels) {
      this.addMockModel(model);
    }

    // Set all providers as available and healthy by default
    this.setProviderAvailable("anthropic", true);
    this.setProviderAvailable("openai", true);
    this.setProviderAvailable("google", true);
    this.setProviderHealth("anthropic", true);
    this.setProviderHealth("openai", true);
    this.setProviderHealth("google", true);
  }

  setProviderAvailable(providerId: string, available: boolean): void {
    this.mockProviders.set(providerId, available);
  }

  setProviderHealth(providerId: string, healthy: boolean): void {
    this.mockHealth.set(providerId, healthy);
  }

  addMockModel(model: MockModelInfo): void {
    this.mockModels.set(model.modelId, model);
    this.mockModels.set(model.fullModelId, model);
  }

  getProviderForModel(
    modelName: string,
  ): { success: true; model: LanguageModel } | { success: false; reason: string } {
    const model = this.mockModels.get(modelName);
    if (!model) {
      this.logger?.log(`Mock: Model not found: ${modelName}`, "debug");
      return { success: false, reason: `Model ${modelName} not found` };
    }

    const available = this.mockProviders.get(model.providerId) ?? false;
    const healthy = this.mockHealth.get(model.providerId) ?? true;

    if (!available) {
      this.logger?.log(`Mock: Provider ${model.providerId} not available`, "debug");
      return { success: false, reason: `Provider ${model.providerId} not configured` };
    }

    if (!healthy) {
      this.logger?.log(`Mock: Provider ${model.providerId} not healthy`, "debug");
      return { success: false, reason: `Provider ${model.providerId} unhealthy` };
    }

    // Return a mock LanguageModel
    const mockModel = {
      modelId: model.modelId,
      provider: model.providerId,
    } as LanguageModel;

    return { success: true, model: mockModel };
  }

  getModelInfo(
    modelName: string,
  ): { success: true; info: MockModelInfo } | { success: false; reason: string } {
    const model = this.mockModels.get(modelName);
    if (!model) {
      return { success: false, reason: `Model ${modelName} not found` };
    }
    return { success: true, info: model };
  }

  calculateCost(
    modelName: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
  ): number | null {
    const model = this.mockModels.get(modelName);
    if (!model) return null;

    // Mock currently doesn't have cache token costs, so we ignore them
    return (
      (usage.inputTokens / 1_000_000) * model.costPerMillionInput +
      (usage.outputTokens / 1_000_000) * model.costPerMillionOutput
    );
  }

  formatCost(cost: number): string {
    if (cost === 0) {
      return "$0.0000";
    }
    if (cost < 0.01) {
      return `$${(cost * 100).toFixed(4)}¢`; // Show in cents for small amounts
    }
    return `$${cost.toFixed(4)}`;
  }

  isModelAvailable(modelName: string): boolean {
    const result = this.getProviderForModel(modelName);
    return result.success;
  }

  getAvailableModels(): string[] {
    return Array.from(this.mockModels.values())
      .filter((m) => this.isModelAvailable(m.modelId))
      .map((m) => m.fullModelId);
  }

  getModelsForProvider(providerId: string): string[] {
    const models: string[] = [];
    for (const [_, model] of this.mockModels) {
      if (model.providerId === providerId) {
        models.push(model.fullModelId);
      }
    }
    return models;
  }

  async performHealthChecks(): Promise<Map<string, ProviderStatus>> {
    // Mock health check - return status based on mock data
    const statuses = new Map<string, ProviderStatus>();

    const providerIds = ["anthropic", "openai", "google", "groq"];
    for (const id of providerIds) {
      const available = this.mockProviders.get(id) ?? false;
      const healthy = this.mockHealth.get(id) ?? true;

      if (!available) {
        statuses.set(id, {
          status: "not-configured",
          id,
          error: "Mock: No API key found",
        });
      } else {
        // Provider is available (has API key)
        statuses.set(id, {
          status: "available",
          id,
          healthy: healthy,
          error: !healthy ? "Mock: Health check failed" : undefined,
          lastChecked: new Date(),
        });
      }
    }

    return statuses;
  }

  getProviderStatus(): Map<string, ProviderStatus> {
    // Return synchronous version of health check results
    const statuses = new Map<string, ProviderStatus>();

    const providerIds = ["anthropic", "openai", "google", "groq"];
    for (const id of providerIds) {
      const available = this.mockProviders.get(id) ?? false;
      const healthy = this.mockHealth.get(id) ?? true;

      if (!available) {
        statuses.set(id, {
          status: "not-configured",
          id,
          error: "Mock: No API key found",
        });
      } else {
        // Provider is available (has API key)
        statuses.set(id, {
          status: "available",
          id,
          healthy: healthy,
          error: !healthy ? "Mock: Health check failed" : undefined,
          lastChecked: new Date(),
        });
      }
    }

    return statuses;
  }

  getStats(): {
    totalModels: number;
    totalProviders: number;
    availableProviders: number;
    healthyProviders: number;
  } {
    const totalModels = this.mockModels.size / 2; // Divided by 2 because we store each model twice
    const totalProviders = 4; // anthropic, openai, google, groq
    const availableProviders = Array.from(this.mockProviders.values()).filter(Boolean).length;
    const healthyProviders = Array.from(this.mockHealth.values()).filter(Boolean).length;

    return {
      totalModels,
      totalProviders,
      availableProviders,
      healthyProviders,
    };
  }

  // Mock-specific utilities for testing
  clearAllModels(): void {
    this.mockModels.clear();
  }

  clearAllProviders(): void {
    this.mockProviders.clear();
    this.mockHealth.clear();
  }

  reset(): void {
    this.clearAllModels();
    this.clearAllProviders();
    this.addDefaultMockModels();
  }
}

/**
 * Factory function to create a mock registry for tests
 */
export function createMockLlmProviderRegistry(
  config: LlmProviderRegistryConfig = {},
): MockLlmProviderRegistry {
  return new MockLlmProviderRegistry(config);
}
