# Plan 2: LLM Provider Manager Implementation

## Global Intent
Enable chroniclers to make real LLM calls through various providers while managing costs, availability, and health checks. The manager acts as the central point for provider management.

## Context & Why This Is Being Built
- **Current State**: Chroniclers have mock LLM functionality but no real provider access
- **Goal**: Provide a unified interface for accessing multiple LLM providers with health monitoring
- **This Plan's Role**: Build the provider management layer that uses the data from Plan 1

## What's Done So Far
- Plan 1: Created models data schema and download script (`server/llm/models-dev-data.json` and `server/llm/models-dev-schema.ts`)

## Objective
Build a lightweight LLM Provider Manager that loads provider configurations, performs health checks, and provides a simple API for chroniclers to get providers and cost information.

## Context
- Depends on Plan 1's models data file (`server/llm/models-dev-data.json`)
- Uses AI SDK providers (@ai-sdk/anthropic, @ai-sdk/openai, @ai-sdk/groq)
- Must handle missing API keys gracefully
- Custom models can be added via an extension file following the same schema

## Important Note
**The code examples below are suggestions**. Feel free to modify them as needed and add comments to explain your implementation decisions.

## Implementation Steps

### 1. Install Required Dependencies
```bash
bun add @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/groq
```

### 2. Create Provider Configuration (`server/llm/provider-config.ts`)

```typescript
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGroq } from '@ai-sdk/groq';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { Provider } from 'ai';

export interface ProviderDefinition {
  id: string;
  apiKeyEnvVar: string;
  createProvider: (apiKey: string) => Provider;
  testModel?: string; // Model to use for health check
  defaultHeaders?: Record<string, string>; // Optional headers
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    createProvider: (apiKey) => createAnthropic({
      apiKey,
      // Can add baseURL for proxies if needed
    }),
    // testModel will be determined programmatically from cheapest available
  },
  {
    id: 'openai',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    createProvider: (apiKey) => createOpenAI({
      apiKey,
      compatibility: 'strict' // Ensure compatibility mode
    }),
  },
  {
    id: 'groq',
    apiKeyEnvVar: 'GROQ_API_KEY',
    createProvider: (apiKey) => createGroq({ apiKey }),
  },
  {
    id: 'google',
    apiKeyEnvVar: 'GOOGLE_API_KEY',
    createProvider: (apiKey) => createGoogleGenerativeAI({ apiKey }),
  }
];
```

### 3. Create the LLM Provider Registry (`server/llm/llm-provider-registry.ts`)

```typescript
import { generateText } from 'ai';
import type { Provider, LanguageModel } from 'ai';
import type { Logger } from '../types/types.js';
import { PROVIDER_DEFINITIONS, type ModelFilters } from './provider-config.js';
import modelsDataRaw from './models-dev-data.json';
import { modelsDataSchema, type ModelInfo, type ModelsData } from './models-dev.schema.js';

export interface ProviderStatus {
  id: string;
  available: boolean;
  healthy: boolean;
  error?: string;
  lastChecked?: Date;
}

export interface LlmProviderRegistryConfig {
  logger?: Logger;
  healthCheckTimeout?: number; // ms, default 5000
  performHealthCheckOnInit?: boolean; // default false
}

export class LlmProviderRegistry {
  private providers = new Map<string, Provider>();
  private models = new Map<string, ModelInfo>();
  private providerHealth = new Map<string, boolean>();
  private providerStatus = new Map<string, ProviderStatus>();
  private logger?: Logger;
  private healthCheckTimeout: number;

  constructor(config: LlmProviderRegistryConfig = {}) {
    this.logger = config.logger;
    this.healthCheckTimeout = config.healthCheckTimeout || 5000;

    this.loadModelsData();
    this.initializeProviders();

    if (config.performHealthCheckOnInit) {
      // Don't await, let it run in background
      this.performHealthChecks().catch(err => {
        this.logger?.log(`Background health checks failed: ${err}`, 'error');
      });
    }
  }

  // === Initialization ===

  private loadModelsData(): void {
    try {
      // Load main models data
      const validatedData = modelsDataSchema.parse(modelsDataRaw);

      // Load custom models extension if it exists (follows same schema)
      let customModels: ModelsData | null = null;
      try {
        const customDataRaw = require('./models-custom-data.json');
        customModels = modelsDataSchema.parse(customDataRaw);
        this.logger?.log(
          `Loaded ${customModels.models.length} custom models from extension file`,
          'info'
        );
      } catch (error) {
        // No custom models file, that's fine - log it for debugging
        this.logger?.log(
          `No custom models file found at models-custom-data.json (this is normal): ${error}`,
          'debug'
        );
      }

      // Combine models from both sources
      const allModels = [
        ...validatedData.models,
        ...(customModels?.models || [])
      ];

      for (const model of allModels) {
        const fullModelId = `${model.providerId}/${model.modelId}`;
        const info: ModelInfo = {
          providerId: model.providerId,
          modelId: model.modelId,
          fullModelId,
          costPerMillionInput: model.cost.input,
          costPerMillionOutput: model.cost.output,
          maxContext: model.limits.context,
          maxOutput: model.limits.output,
          description: model.description,
          deprecated: model.deprecated,
        };

        // Register by both full and short names
        this.models.set(fullModelId, info);
        this.models.set(model.modelId, info);
      }

      this.logger?.log(
        `Loaded ${this.models.size / 2} models from data files`,
        'info'
      );
    } catch (error) {
      this.logger?.log(`Failed to load models data: ${error}`, 'error');
      // Continue with empty models map - providers may still work
    }
  }

  /**
   * Find the cheapest model for a provider for health checks
   * Uses only input cost since health checks send minimal input and expect minimal output
   */
  private findCheapestModel(providerId: string): string | undefined {
    let cheapestModel: ModelInfo | undefined;
    let lowestInputCost = Infinity;

    for (const [_, model] of this.models) {
      if (model.providerId === providerId && !model.deprecated) {
        // Use only input cost for comparison
        if (model.costPerMillionInput < lowestInputCost) {
          lowestInputCost = model.costPerMillionInput;
          cheapestModel = model;
        }
      }
    }

    if (cheapestModel) {
      this.logger?.log(
        `Selected ${cheapestModel.modelId} as cheapest for ${providerId} (input cost: $${cheapestModel.costPerMillionInput}/M tokens)`,
        'debug'
      );
    }

    return cheapestModel?.modelId;
  }


  private initializeProviders(): void {
    for (const def of PROVIDER_DEFINITIONS) {
      const apiKey = process.env[def.apiKeyEnvVar];

      const status: ProviderStatus = {
        id: def.id,
        available: false,
        healthy: false,
      };

      if (!apiKey) {
        status.error = `No API key found (${def.apiKeyEnvVar})`;
        this.providerStatus.set(def.id, status);
        this.logger?.log(`Provider ${def.id}: ${status.error}`, 'debug');
        continue;
      }

      try {
        const provider = def.createProvider(apiKey);
        this.providers.set(def.id, provider);
        status.available = true;
        this.providerStatus.set(def.id, status);
        this.logger?.log(`Provider ${def.id}: Initialized`, 'info');
      } catch (error) {
        status.error = `Failed to initialize: ${error}`;
        this.providerStatus.set(def.id, status);
        this.logger?.log(`Provider ${def.id}: ${status.error}`, 'error');
      }
    }
  }

  // === Health Checks ===

  public async performHealthChecks(): Promise<Map<string, ProviderStatus>> {
    this.logger?.log('Starting provider health checks', 'debug');

    const checks = Array.from(this.providers.entries()).map(async ([id, provider]) => {
      const status = this.providerStatus.get(id)!;
      const def = PROVIDER_DEFINITIONS.find(d => d.id === id);

      // Find cheapest model for this provider programmatically
      const testModel = this.findCheapestModel(id);

      if (!testModel) {
        // No models available for this provider
        this.logger?.log(`No models found for provider ${id}, skipping health check`, 'warn');
        status.healthy = false;
        status.error = 'No models available';
        status.lastChecked = new Date();
        this.providerHealth.set(id, false);
        return;
      }

      this.logger?.log(`Using ${testModel} for ${id} health check (cheapest model)`, 'debug');

      try {
        // Create a timeout promise
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Health check timeout')), this.healthCheckTimeout);
        });

        // Race the health check against timeout
        const model = provider(testModel);
        await Promise.race([
          generateText({
            model,
            messages: [{ role: 'user', content: 'Hi' }],
            maxOutputTokens: 1,
            temperature: 0,
          }),
          timeoutPromise
        ]);

        status.healthy = true;
        status.error = undefined;
        this.providerHealth.set(id, true);
        this.logger?.log(`Provider ${id}: Health check passed`, 'debug');
      } catch (error) {
        status.healthy = false;
        status.error = `Health check failed: ${error}`;
        this.providerHealth.set(id, false);
        this.logger?.log(`Provider ${id}: ${status.error}`, 'warn');
      }

      status.lastChecked = new Date();
    });

    await Promise.allSettled(checks);
    this.logger?.log('Health checks complete', 'debug');

    return new Map(this.providerStatus);
  }

  // === Public API ===

  /**
   * Get a provider and model for a specific model name.
   * Returns null if model not found or provider unavailable.
   */
  public getProviderForModel(modelName: string): LanguageModel | null {
    const modelInfo = this.models.get(modelName);
    if (!modelInfo) {
      this.logger?.log(`Model not found: ${modelName}`, 'warn');
      return null;
    }

    const provider = this.providers.get(modelInfo.providerId);
    if (!provider) {
      this.logger?.log(`Provider not available: ${modelInfo.providerId}`, 'warn');
      return null;
    }

    // Check health status
    const isHealthy = this.providerHealth.get(modelInfo.providerId) ?? true; // Default to true if not checked
    if (!isHealthy) {
      this.logger?.log(`Provider unhealthy: ${modelInfo.providerId}`, 'warn');
      return null;
    }

    // Return the actual model instance
    return provider(modelInfo.modelId);
  }

  /**
   * Get cost information for a model.
   */
  public getModelInfo(modelName: string): ModelInfo | null {
    return this.models.get(modelName) ?? null;
  }

  /**
   * Check if a model is available (provider exists and is healthy).
   */
  public isModelAvailable(modelName: string): boolean {
    const modelInfo = this.models.get(modelName);
    if (!modelInfo) return false;

    const status = this.providerStatus.get(modelInfo.providerId);
    return status?.available && (status?.healthy ?? true) || false;
  }

  /**
   * Get all available models.
   */
  public getAvailableModels(): string[] {
    const available = new Set<string>();

    for (const [modelId, info] of this.models) {
      if (this.isModelAvailable(modelId)) {
        available.add(info.fullModelId);
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
    outputTokens: number
  ): number | null {
    const info = this.getModelInfo(modelName);
    if (!info) return null;

    const inputCost = (inputTokens / 1_000_000) * info.costPerMillionInput;
    const outputCost = (outputTokens / 1_000_000) * info.costPerMillionOutput;

    return inputCost + outputCost;
  }

  /**
   * Format cost as a readable string.
   */
  public formatCost(cost: number): string {
    if (cost < 0.01) {
      return `$${(cost * 100).toFixed(4)}¢`; // Show in cents for small amounts
    }
    return `$${cost.toFixed(4)}`;
  }
}
```

### 4. Create Mock for Testing (`tests/utils/mock-llm-provider-registry.ts`)

```typescript
import type { LanguageModel } from 'ai';
import type { ModelInfo } from '../../server/llm/models-dev.schema.js';
import type { ProviderStatus } from '../../server/llm/llm-provider-registry.js';

export class MockLlmProviderRegistry {
  private mockProviders = new Map<string, boolean>();
  private mockModels = new Map<string, ModelInfo>();
  private mockHealth = new Map<string, boolean>();

  setProviderAvailable(providerId: string, available: boolean): void {
    this.mockProviders.set(providerId, available);
  }

  setProviderHealth(providerId: string, healthy: boolean): void {
    this.mockHealth.set(providerId, healthy);
  }

  addMockModel(model: ModelInfo): void {
    this.mockModels.set(model.modelId, model);
    this.mockModels.set(model.fullModelId, model);
  }

  getProviderForModel(modelName: string): LanguageModel | null {
    const model = this.mockModels.get(modelName);
    if (!model) return null;

    const available = this.mockProviders.get(model.providerId) ?? false;
    const healthy = this.mockHealth.get(model.providerId) ?? true;

    if (!available || !healthy) return null;

    // Return a mock model
    return {} as LanguageModel; // Mock implementation
  }

  calculateCost(modelName: string, inputTokens: number, outputTokens: number): number | null {
    const model = this.mockModels.get(modelName);
    if (!model) return null;

    return (inputTokens / 1_000_000) * model.costPerMillionInput +
           (outputTokens / 1_000_000) * model.costPerMillionOutput;
  }

  isModelAvailable(modelName: string): boolean {
    return this.getProviderForModel(modelName) !== null;
  }

  getAvailableModels(): string[] {
    return Array.from(this.mockModels.values())
      .filter(m => this.isModelAvailable(m.modelId))
      .map(m => m.fullModelId);
  }

  async performHealthChecks(): Promise<Map<string, ProviderStatus>> {
    // Mock health check
    const statuses = new Map<string, ProviderStatus>();
    for (const [id, available] of this.mockProviders) {
      statuses.set(id, {
        id,
        available,
        healthy: this.mockHealth.get(id) ?? true,
        lastChecked: new Date(),
      });
    }
    return statuses;
  }
}
```

### 5. Write Unit Tests (`tests/unit/llm-provider-registry.test.ts`)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { LlmProviderRegistry } from '../../server/llm/llm-provider-registry.js';
import type { Logger } from '../../server/types/types.js';

describe('LlmProviderRegistry', () => {
  let registry: LlmProviderRegistry;
  let logs: Array<{ message: string; level: string }> = [];

  const mockLogger: Logger = {
    log: (message: string, level = 'info') => {
      logs.push({ message, level });
    }
  };

  beforeEach(() => {
    logs = [];
    // Save original env
    process.env.TEST_ORIGINAL_ENV = JSON.stringify(process.env);
  });

  afterEach(() => {
    // Restore env
    if (process.env.TEST_ORIGINAL_ENV) {
      const original = JSON.parse(process.env.TEST_ORIGINAL_ENV);
      process.env = original;
    }
  });

  describe('initialization', () => {
    it('should load models from static data', () => {
      registry = new LlmProviderRegistry({ logger: mockLogger });

      // Check that models were loaded
      const sonnetInfo = registry.getModelInfo('claude-3-5-sonnet-20241022');
      expect(sonnetInfo).toBeDefined();
      expect(sonnetInfo?.providerId).toBe('anthropic');
    });

    it('should handle missing API keys gracefully', () => {
      // Clear all API keys
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;

      registry = new LlmProviderRegistry({ logger: mockLogger });

      // Should log about missing keys
      const missingKeyLogs = logs.filter(l => l.message.includes('No API key'));
      expect(missingKeyLogs.length).toBeGreaterThan(0);

      // Should not crash when getting provider
      const provider = registry.getProviderForModel('claude-3-5-sonnet-20241022');
      expect(provider).toBeNull();
    });

    it('should apply model filters', () => {
      registry = new LlmProviderRegistry({
        logger: mockLogger,
        modelFilters: {
          allowList: ['claude-3-5-sonnet-20241022', 'gpt-3.5-turbo']
        }
      });

      // Allowed model should be available
      const sonnet = registry.getModelInfo('claude-3-5-sonnet-20241022');
      expect(sonnet).toBeDefined();

      // Non-allowed model should not be available
      const haiku = registry.getModelInfo('claude-3-haiku-20240307');
      expect(haiku).toBeNull();
    });

    it('should respect deny list', () => {
      registry = new LlmProviderRegistry({
        logger: mockLogger,
        modelFilters: {
          denyList: ['gpt-4-turbo-preview']
        }
      });

      // Denied model should not be available
      const gpt4 = registry.getModelInfo('gpt-4-turbo-preview');
      expect(gpt4).toBeNull();

      // Other models should be available
      const gpt35 = registry.getModelInfo('gpt-3.5-turbo');
      expect(gpt35).toBeDefined();
    });
  });

  describe('cost calculation', () => {
    beforeEach(() => {
      registry = new LlmProviderRegistry({ logger: mockLogger });
    });

    it('should calculate costs correctly', () => {
      const cost = registry.calculateCost(
        'claude-3-5-sonnet-20241022',
        1000,    // 1K input tokens
        500      // 500 output tokens
      );

      // Cost should be: (1000/1M * 3.00) + (500/1M * 15.00)
      // = 0.003 + 0.0075 = 0.0105
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it('should return null for unknown models', () => {
      const cost = registry.calculateCost('unknown-model', 1000, 500);
      expect(cost).toBeNull();
    });

    it('should format costs readably', () => {
      // Small cost in cents
      expect(registry.formatCost(0.0001)).toBe('$0.0100¢');

      // Larger cost in dollars
      expect(registry.formatCost(0.1234)).toBe('$0.1234');
    });
  });

  describe('model availability', () => {
    it('should report models as unavailable when provider is missing', () => {
      delete process.env.ANTHROPIC_API_KEY;
      registry = new LlmProviderRegistry({ logger: mockLogger });

      expect(registry.isModelAvailable('claude-3-5-sonnet-20241022')).toBe(false);
    });

    it('should list only available models', () => {
      // Set only OpenAI key
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      registry = new LlmProviderRegistry({ logger: mockLogger });

      const available = registry.getAvailableModels();
      // Should only include OpenAI models
      expect(available.every(m => m.startsWith('openai/'))).toBe(true);
    });
  });
});
```

## Potential Issues & Solutions

### Issue 1: Provider Initialization Failures
**Problem**: Provider might fail to initialize even with valid API key.
**Solution**:
- Wrap provider creation in try-catch
- Log detailed error information
- Continue with other providers

### Issue 2: Health Check Timeouts
**Problem**: Health checks might hang or take too long.
**Solution**:
- Implement timeout mechanism (5 seconds default)
- Use Promise.race() with timeout promise
- Allow configuration of timeout duration

### Issue 3: Cost Data Inaccuracy
**Problem**: Costs in models.dev might be outdated.
**Solution**:
- Log a warning if data is >30 days old
- Include last updated date in logs
- Manual update process via script

### Issue 4: Memory Usage with Many Models
**Problem**: Loading thousands of models into memory.
**Solution**:
- Filter models at load time based on supported providers
- Use allow/deny lists to reduce loaded models
- Consider lazy loading if needed

### Issue 5: Type Safety with AI SDK
**Problem**: AI SDK types might change between versions.
**Solution**:
- Pin AI SDK versions in package.json
- Add type tests to catch breaking changes
- Use branded types for extra safety

## Integration with Chroniclers

The chronicler will use the registry like this:

```typescript
// In Chronicler class
private async executeChroniclerCall(
  events: ServerEvent[],
  executionId: ExecutionId
): Promise<void> {
  const modelName = this.config.model ?? 'claude-3-5-sonnet-20241022';
  const model = this.providerRegistry.getProviderForModel(modelName);

  if (!model) {
    this.logger?.log(
      `Model ${modelName} not available for chronicler ${this.config.id}`,
      'warn'
    );
    return;
  }

  try {
    const result = await generateText({
      model,
      messages: /* prepared messages */,
      ...this.config.llmParams
    });

    // Log cost if available
    const cost = this.providerRegistry.calculateCost(
      modelName,
      result.usage.promptTokens,
      result.usage.completionTokens
    );

    if (cost !== null) {
      this.logger?.log(
        `Chronicler ${this.config.id}: ${this.providerRegistry.formatCost(cost)}`,
        'debug'
      );
    }
  } catch (error) {
    this.logger?.log(`Chronicler ${this.config.id} failed: ${error}`, 'error');
  }
}
```

## Validation Steps

After implementation:
```bash
# Type check
bun typecheck

# Lint
bun lint:fix

# Run unit tests
bun test tests/unit/llm-provider-registry.test.ts

# Test with real API keys (set in .env)
ANTHROPIC_API_KEY=sk-ant-... bun test tests/integration/llm-provider-health.test.ts
```

## Files Created/Modified

- `server/llm/provider-config.ts` - Provider definitions
- `server/llm/llm-provider-registry.ts` - Main registry class
- `tests/utils/mock-llm-provider-registry.ts` - Mock for testing
- `tests/unit/llm-provider-registry.test.ts` - Unit tests
- `package.json` - Add AI SDK dependencies

## Success Criteria

1. Registry initializes without errors
2. Providers load when API keys are present
3. Health checks complete within timeout (using cheapest model from data)
4. Cost calculations are accurate
5. Custom models can be added via extension file
6. All tests pass
7. TypeScript compilation succeeds

## Custom Models Extension

To add custom models not in models.dev, create `server/llm/models-custom-data.json` following the same schema:

```json
{
  "version": "1.0.0",
  "lastUpdated": "2025-01-21T00:00:00Z",
  "models": [
    {
      "providerId": "anthropic",
      "modelId": "custom-internal-model",
      "name": "Custom Internal Model",
      "cost": {
        "input": 1.00,
        "output": 5.00
      },
      "limits": {
        "context": 100000,
        "output": 4096
      }
    }
  ]
}
```

## Note for Implementation
This plan is designed to be implemented by an AI agent with human supervision. The human will check the results after implementation.
