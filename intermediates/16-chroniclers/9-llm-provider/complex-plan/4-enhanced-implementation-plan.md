# Enhanced Implementation Plan: LlmProviderManager

## 1. Executive Summary & Intent

### Purpose
The `LlmProviderManager` is a centralized, resilient LLM interaction layer that abstracts away the complexity of:
- **Provider Management**: Discovering and managing multiple AI providers (OpenAI, Anthropic, etc.)
- **Cost Optimization**: Tracking and reporting token usage and costs in real-time
- **Resilience**: Automatic fallback through multiple models/providers on failure
- **Observability**: Comprehensive logging of all LLM interactions for debugging and auditing
- **Future-Proofing**: Preparing for websocket-based real-time cost/status updates

### Key Design Principles
1. **Fail-Safe Operation**: Never crash the server due to LLM issues
2. **Cost Awareness**: Every token counts and is tracked
3. **Provider Agnostic**: Easy to add new providers without changing consumer code
4. **Observable**: Every call, response, error, and cost is logged
5. **Testable**: All components can be mocked for testing

## 2. Detailed Architecture Components

### 2.1 Data Layer

#### `scripts/fetch-models-dev.ts`
**Intent**: Keep model metadata up-to-date without runtime network dependencies

**Implementation Details**:
```typescript
// Key functionality:
- Fetch from https://models.dev/api.json
- Validate against models-dev.schema.ts
- Transform provider names to match our config (e.g., "anthropic" → "anthropic")
- Write to server/llm/models-dev.data.json with timestamp
- Exit codes: 0 (success), 1 (network error), 2 (validation error)
- Can be run manually or via CI/CD
```

#### `server/llm/models-dev.schema.ts`
**Intent**: Ensure data integrity and type safety for model metadata

**Schema Structure**:
```typescript
const modelSchema = z.object({
  providerId: z.string(),      // e.g., "anthropic"
  modelId: z.string(),         // e.g., "claude-3-5-sonnet-20241022"
  name: z.string(),            // e.g., "Claude 3.5 Sonnet"
  cost: z.object({
    input: z.number(),         // Cost per 1M input tokens
    output: z.number(),        // Cost per 1M output tokens
    cachedInput: z.number().optional(),
    cachedOutput: z.number().optional(),
  }),
  limit: z.object({
    context: z.number(),       // Max context window
    output: z.number(),        // Max output tokens
  }),
  capabilities: z.object({
    vision: z.boolean(),
    functionCalling: z.boolean(),
    streaming: z.boolean(),
  }).partial(),
  releaseDate: z.string().optional(),
  deprecationDate: z.string().optional(),
});

const modelsDevDataSchema = z.object({
  models: z.array(modelSchema),
  lastUpdated: z.string().datetime(),
  version: z.string(),
});
```

### 2.2 Configuration Layer

#### `server/llm/provider.config.ts`
**Intent**: Centralize provider SDK initialization and API key management

**Extended Implementation**:
```typescript
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { Provider } from 'ai';

export interface ProviderConfig {
  apiKeyEnvVar: string;
  baseUrlEnvVar?: string;  // For custom endpoints
  createProvider: (apiKey: string, baseUrl?: string) => Provider;
  healthCheckModel?: string; // Model to use for health checks
  maxRetries?: number;       // Provider-specific retry limit
}

export const llmProviderConfig: Record<string, ProviderConfig> = {
  anthropic: {
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    createProvider: (apiKey, baseUrl) => createAnthropic({ apiKey, baseURL: baseUrl }),
    healthCheckModel: 'claude-3-haiku-20240307',  // Cheapest model for health checks
    maxRetries: 3,
  },
  openai: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    createProvider: (apiKey, baseUrl) => createOpenAI({ apiKey, baseURL: baseUrl }),
    healthCheckModel: 'gpt-3.5-turbo',
    maxRetries: 3,
  },
  google: {
    apiKeyEnvVar: 'GOOGLE_API_KEY',
    createProvider: (apiKey) => createGoogleGenerativeAI({ apiKey }),
    healthCheckModel: 'gemini-pro',
    maxRetries: 2,
  },
};
```

### 2.3 Core Manager Implementation

#### `server/llm/llm-provider.types.ts`
**Intent**: Define all types for the LLM system

```typescript
import type { LanguageModel } from 'ai';
import type { TadpoleGenerateTextOptions, TadpoleStreamTextOptions, TadpoleGenerateObjectOptions } from '../types/llm-call-types.js';

export type ProviderStatus = 'unknown' | 'checking' | 'available' | 'unavailable' | 'disabled';

export interface ProviderHealth {
  status: ProviderStatus;
  lastCheck: Date;
  nextCheck: Date;
  consecutiveFailures: number;
  lastError?: string;
  isHealthy: boolean;
}

export interface ModelMetadata {
  providerId: string;
  modelId: string;
  fullModelId: string;  // provider/model format
  name: string;
  costPerMillionInputTokens: number;
  costPerMillionOutputTokens: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  capabilities: {
    vision?: boolean;
    functionCalling?: boolean;
    streaming?: boolean;
  };
}

export interface RegisteredProvider {
  id: string;
  provider: Provider;
  models: Map<string, ModelMetadata>;
  health: ProviderHealth;
  errorThreshold: ErrorThreshold;
}

export interface ErrorThreshold {
  maxConsecutiveErrors: number;
  currentErrors: number;
  errorWindow: Date[];  // Timestamps of recent errors
  windowSizeMs: number; // Time window for error tracking (e.g., 5 minutes)
}

export interface LlmCall {
  id: string;
  timestamp: Date;
  providerId: string;
  modelId: string;
  method: 'generateText' | 'streamText' | 'generateObject';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cost: number;
  success: boolean;
  error?: string;
  // For future websocket streaming
  metadata?: Record<string, unknown>;
}

export interface LlmProviderStats {
  totalCalls: number;
  totalTokens: { input: number; output: number };
  totalCost: number;
  callsByProvider: Map<string, number>;
  callsByModel: Map<string, number>;
  errorRate: number;
  averageLatencyMs: number;
}
```

#### `server/llm/errors.ts`
**Intent**: Provide specific error types for different failure scenarios

```typescript
export class LlmProviderError extends Error {
  constructor(message: string, public code: string, public details?: unknown) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

export class NoAvailableProvidersError extends LlmProviderError {
  constructor(public attemptedModels: string[], public errors: Map<string, string>) {
    super(`No available providers for models: ${attemptedModels.join(', ')}`);
    this.code = 'NO_AVAILABLE_PROVIDERS';
  }
}

export class ModelNotFoundError extends LlmProviderError {
  constructor(modelId: string, public suggestions: string[] = []) {
    super(`Model "${modelId}" not found. ${suggestions.length > 0 ? `Did you mean: ${suggestions.join(', ')}?` : ''}`);
    this.code = 'MODEL_NOT_FOUND';
  }
}

export class ProviderHealthCheckError extends LlmProviderError {
  constructor(providerId: string, reason: string) {
    super(`Health check failed for provider ${providerId}: ${reason}`);
    this.code = 'HEALTH_CHECK_FAILED';
  }
}
```

#### `server/llm/llm-provider.manager.ts`
**Intent**: Central orchestrator for all LLM interactions

**Detailed Implementation**:

```typescript
import { generateText, streamText, generateObject } from 'ai';
import type { Logger } from '../types/types.js';

export class LlmProviderManager {
  private providers = new Map<string, RegisteredProvider>();
  private modelRegistry = new Map<string, ModelMetadata>();
  private callHistory: LlmCall[] = [];
  private stats: LlmProviderStats;
  private healthCheckInterval?: NodeJS.Timeout;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
    this.stats = this.initializeStats();
    this.loadModelData();
    this.initializeProviders();
  }

  // === Initialization Methods ===

  private loadModelData(): void {
    try {
      const data = JSON.parse(fs.readFileSync('server/llm/models-dev.data.json', 'utf-8'));
      const validated = modelsDevDataSchema.parse(data);

      for (const model of validated.models) {
        const fullModelId = `${model.providerId}/${model.modelId}`;
        const metadata: ModelMetadata = {
          ...model,
          fullModelId,
          costPerMillionInputTokens: model.cost.input,
          costPerMillionOutputTokens: model.cost.output,
          maxContextTokens: model.limit.context,
          maxOutputTokens: model.limit.output,
        };
        this.modelRegistry.set(fullModelId, metadata);
        this.modelRegistry.set(model.modelId, metadata); // Also register by short name
      }

      this.logger?.log(`Loaded ${validated.models.length} models from models.dev data`, 'info');
    } catch (error) {
      this.logger?.log(`Failed to load models.dev data: ${error}`, 'error');
      throw new LlmProviderError('Failed to initialize model registry', 'INIT_FAILED', error);
    }
  }

  private initializeProviders(): void {
    for (const [providerId, config] of Object.entries(llmProviderConfig)) {
      const apiKey = process.env[config.apiKeyEnvVar];
      if (!apiKey) {
        this.logger?.log(`No API key found for ${providerId}, skipping`, 'debug');
        continue;
      }

      const baseUrl = config.baseUrlEnvVar ? process.env[config.baseUrlEnvVar] : undefined;
      const provider = config.createProvider(apiKey, baseUrl);

      const providerModels = new Map<string, ModelMetadata>();
      for (const [modelId, metadata] of this.modelRegistry) {
        if (metadata.providerId === providerId) {
          providerModels.set(metadata.modelId, metadata);
        }
      }

      this.providers.set(providerId, {
        id: providerId,
        provider,
        models: providerModels,
        health: {
          status: 'unknown',
          lastCheck: new Date(0),
          nextCheck: new Date(),
          consecutiveFailures: 0,
          isHealthy: false,
        },
        errorThreshold: {
          maxConsecutiveErrors: 5,
          currentErrors: 0,
          errorWindow: [],
          windowSizeMs: 5 * 60 * 1000, // 5 minutes
        },
      });

      this.logger?.log(`Initialized provider ${providerId} with ${providerModels.size} models`, 'info');
    }
  }

  // === Health Check Implementation ===

  public async initialize(): Promise<void> {
    this.logger?.log('Starting LlmProviderManager initialization', 'info');

    // Start health checks for all providers
    const healthCheckPromises = Array.from(this.providers.keys()).map(id =>
      this.performHealthCheck(id).catch(err => {
        this.logger?.log(`Initial health check failed for ${id}: ${err}`, 'warn');
      })
    );

    // Don't await - let health checks run in background
    Promise.all(healthCheckPromises).then(() => {
      this.logger?.log('Initial health checks complete', 'info');
    });

    // Start periodic health checks
    this.healthCheckInterval = setInterval(() => {
      this.performScheduledHealthChecks();
    }, 30_000); // Check every 30 seconds

    this.logger?.log('LlmProviderManager initialization complete', 'info');
  }

  private async performHealthCheck(providerId: string): Promise<void> {
    const registered = this.providers.get(providerId);
    if (!registered) return;

    const config = llmProviderConfig[providerId];
    if (!config.healthCheckModel) {
      registered.health.status = 'available';
      registered.health.isHealthy = true;
      return;
    }

    registered.health.status = 'checking';

    try {
      const model = registered.provider(config.healthCheckModel);
      const result = await generateText({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        maxOutputTokens: 5,
        temperature: 0,
      });

      if (result.text) {
        registered.health.status = 'available';
        registered.health.isHealthy = true;
        registered.health.consecutiveFailures = 0;
        registered.health.lastCheck = new Date();
        registered.health.nextCheck = new Date(Date.now() + 60_000); // Check again in 1 minute
        this.logger?.log(`Health check passed for ${providerId}`, 'debug');
      }
    } catch (error) {
      registered.health.consecutiveFailures++;
      registered.health.lastError = String(error);
      registered.health.lastCheck = new Date();

      if (registered.health.consecutiveFailures >= 3) {
        registered.health.status = 'unavailable';
        registered.health.isHealthy = false;
        registered.health.nextCheck = new Date(Date.now() + 300_000); // Retry in 5 minutes
        this.logger?.log(`Provider ${providerId} marked unavailable after ${registered.health.consecutiveFailures} failures`, 'warn');
      } else {
        registered.health.status = 'available'; // Still available but degraded
        registered.health.isHealthy = true;
        registered.health.nextCheck = new Date(Date.now() + 30_000); // Retry in 30 seconds
      }
    }
  }

  private async performScheduledHealthChecks(): Promise<void> {
    const now = new Date();
    for (const [providerId, registered] of this.providers) {
      if (registered.health.nextCheck <= now) {
        this.performHealthCheck(providerId).catch(err => {
          this.logger?.log(`Scheduled health check failed for ${providerId}: ${err}`, 'warn');
        });
      }
    }
  }

  // === Provider Validation ===

  public canCallProvider(providerId: string): boolean {
    const provider = this.providers.get(providerId);
    if (!provider) return false;

    // Check health status
    if (provider.health.status === 'unavailable' || provider.health.status === 'disabled') {
      return false;
    }

    // Check error threshold
    const { errorThreshold } = provider;
    const recentErrors = errorThreshold.errorWindow.filter(
      timestamp => timestamp.getTime() > Date.now() - errorThreshold.windowSizeMs
    );

    if (recentErrors.length >= errorThreshold.maxConsecutiveErrors) {
      // Disable provider temporarily
      provider.health.status = 'disabled';
      provider.health.nextCheck = new Date(Date.now() + 600_000); // Re-enable check in 10 minutes
      this.logger?.log(`Provider ${providerId} disabled due to error threshold`, 'error');
      return false;
    }

    return true;
  }

  // === Model Name Resolution ===

  public resolveModelName(partialName: string): string | null {
    // First try exact match
    if (this.modelRegistry.has(partialName)) {
      return this.modelRegistry.get(partialName)!.fullModelId;
    }

    // Try with common provider prefixes
    const commonPrefixes = ['anthropic/', 'openai/', 'google/'];
    for (const prefix of commonPrefixes) {
      const fullName = prefix + partialName;
      if (this.modelRegistry.has(fullName)) {
        return fullName;
      }
    }

    // Fuzzy match
    const candidates = Array.from(this.modelRegistry.keys()).filter(key =>
      key.toLowerCase().includes(partialName.toLowerCase())
    );

    if (candidates.length === 1) {
      return candidates[0];
    }

    if (candidates.length > 1) {
      this.logger?.log(`Ambiguous model name "${partialName}". Candidates: ${candidates.join(', ')}`, 'warn');
    }

    return null;
  }

  // === Core LLM Call Methods ===

  public async generateText(options: Omit<TadpoleGenerateTextOptions, 'model'> & {
    models: string[]
  }): Promise<TadpoleGenerateTextResult> {
    const callId = crypto.randomUUID();
    const startTime = Date.now();
    const errors = new Map<string, string>();

    for (const modelInput of options.models) {
      const modelId = this.resolveModelName(modelInput);
      if (!modelId) {
        errors.set(modelInput, 'Model not found');
        continue;
      }

      const metadata = this.modelRegistry.get(modelId);
      if (!metadata) {
        errors.set(modelInput, 'Model metadata not found');
        continue;
      }

      const provider = this.providers.get(metadata.providerId);
      if (!provider || !this.canCallProvider(metadata.providerId)) {
        errors.set(modelInput, `Provider ${metadata.providerId} not available`);
        continue;
      }

      try {
        this.logger?.log(`Attempting generateText with ${modelId}`, 'debug');

        const model = provider.provider(metadata.modelId);
        const result = await generateText({
          ...options,
          model,
          maxOutputTokens: options.maxOutputTokens ?? metadata.maxOutputTokens,
        });

        // Record successful call
        const cost = this.calculateCost(
          result.usage.inputTokens,
          result.usage.outputTokens,
          metadata
        );

        this.recordCall({
          id: callId,
          timestamp: new Date(),
          providerId: metadata.providerId,
          modelId: metadata.modelId,
          method: 'generateText',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs: Date.now() - startTime,
          cost,
          success: true,
        });

        // Reset error count on success
        provider.errorThreshold.currentErrors = 0;

        this.logger?.log(
          `generateText successful with ${modelId}. Cost: $${cost.toFixed(6)}, Tokens: ${result.usage.inputTokens}/${result.usage.outputTokens}`,
          'info'
        );

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.set(modelInput, errorMessage);

        // Track error
        provider.errorThreshold.currentErrors++;
        provider.errorThreshold.errorWindow.push(new Date());

        this.logger?.log(`generateText failed with ${modelId}: ${errorMessage}`, 'error');

        // Record failed call
        this.recordCall({
          id: callId,
          timestamp: new Date(),
          providerId: metadata.providerId,
          modelId: metadata.modelId,
          method: 'generateText',
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - startTime,
          cost: 0,
          success: false,
          error: errorMessage,
        });
      }
    }

    // All models failed
    throw new NoAvailableProvidersError(options.models, errors);
  }

  public async streamText(options: Omit<TadpoleStreamTextOptions, 'model'> & {
    models: string[]
  }): Promise<TadpoleStreamTextResult> {
    const callId = crypto.randomUUID();
    const startTime = Date.now();
    const errors = new Map<string, string>();

    for (const modelInput of options.models) {
      const modelId = this.resolveModelName(modelInput);
      if (!modelId) {
        errors.set(modelInput, 'Model not found');
        continue;
      }

      const metadata = this.modelRegistry.get(modelId);
      if (!metadata || !metadata.capabilities?.streaming) {
        errors.set(modelInput, 'Model does not support streaming');
        continue;
      }

      const provider = this.providers.get(metadata.providerId);
      if (!provider || !this.canCallProvider(metadata.providerId)) {
        errors.set(modelInput, `Provider ${metadata.providerId} not available`);
        continue;
      }

      try {
        this.logger?.log(`Attempting streamText with ${modelId}`, 'debug');

        const model = provider.provider(metadata.modelId);
        const result = await streamText({
          ...options,
          model,
          maxOutputTokens: options.maxOutputTokens ?? metadata.maxOutputTokens,
        });

        // Set up usage tracking for when stream completes
        result.usage.then(usage => {
          const cost = this.calculateCost(usage.inputTokens, usage.outputTokens, metadata);

          this.recordCall({
            id: callId,
            timestamp: new Date(),
            providerId: metadata.providerId,
            modelId: metadata.modelId,
            method: 'streamText',
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            latencyMs: Date.now() - startTime,
            cost,
            success: true,
          });

          this.logger?.log(
            `streamText completed with ${modelId}. Cost: $${cost.toFixed(6)}`,
            'info'
          );
        }).catch(error => {
          this.logger?.log(`streamText usage tracking failed: ${error}`, 'error');
        });

        // Reset error count on success
        provider.errorThreshold.currentErrors = 0;

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.set(modelInput, errorMessage);

        // Track error
        provider.errorThreshold.currentErrors++;
        provider.errorThreshold.errorWindow.push(new Date());

        this.logger?.log(`streamText failed with ${modelId}: ${errorMessage}`, 'error');
      }
    }

    // All models failed
    throw new NoAvailableProvidersError(options.models, errors);
  }

  public async generateObject<T = unknown>(
    options: Omit<TadpoleGenerateObjectOptions, 'model'> & {
      models: string[]
    }
  ): Promise<TadpoleGenerateObjectResult<T>> {
    // Similar implementation to generateText but using generateObject
    // Implementation follows same pattern: iterate through models, track costs, handle errors
    // Omitted for brevity but follows exact same pattern
  }

  // === Cost Calculation ===

  private calculateCost(inputTokens: number, outputTokens: number, metadata: ModelMetadata): number {
    const inputCost = (inputTokens / 1_000_000) * metadata.costPerMillionInputTokens;
    const outputCost = (outputTokens / 1_000_000) * metadata.costPerMillionOutputTokens;
    return inputCost + outputCost;
  }

  // === State Tracking ===

  private recordCall(call: LlmCall): void {
    this.callHistory.push(call);

    // Update stats
    this.stats.totalCalls++;
    this.stats.totalTokens.input += call.inputTokens;
    this.stats.totalTokens.output += call.outputTokens;
    this.stats.totalCost += call.cost;

    // Update provider/model counts
    const providerCount = this.stats.callsByProvider.get(call.providerId) ?? 0;
    this.stats.callsByProvider.set(call.providerId, providerCount + 1);

    const modelCount = this.stats.callsByModel.get(call.modelId) ?? 0;
    this.stats.callsByModel.set(call.modelId, modelCount + 1);

    // Update error rate
    const recentCalls = this.callHistory.slice(-100);
    const failures = recentCalls.filter(c => !c.success).length;
    this.stats.errorRate = failures / recentCalls.length;

    // Update average latency
    const totalLatency = recentCalls.reduce((sum, c) => sum + c.latencyMs, 0);
    this.stats.averageLatencyMs = totalLatency / recentCalls.length;

    // Log to file for persistence (future enhancement)
    this.logCallToFile(call);
  }

  private logCallToFile(call: LlmCall): void {
    // Future: Write to .tadpole/llm-calls.jsonl for persistence
    // This enables recovery and auditing
  }

  // === Public API for Stats ===

  public getStats(): LlmProviderStats {
    return { ...this.stats };
  }

  public getProviderStatus(providerId: string): ProviderHealth | null {
    return this.providers.get(providerId)?.health ?? null;
  }

  public getCallHistory(limit = 100): LlmCall[] {
    return this.callHistory.slice(-limit);
  }

  // === Cleanup ===

  public async shutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Future: Flush any pending logs
    this.logger?.log('LlmProviderManager shutdown complete', 'info');
  }

  // === Future WebSocket Integration ===

  /**
   * Future method to stream real-time updates through websocket
   * Will be called by TadpoleServer when websocket is connected
   */
  public subscribeToUpdates(callback: (update: LlmProviderUpdate) => void): () => void {
    // Implementation for Phase 4
    // Will emit events for:
    // - Cost updates
    // - Provider status changes
    // - Error rate warnings
    // - Model availability changes
    return () => {}; // Unsubscribe function
  }
}
```

## 3. Enhanced Phased Implementation

### Phase 1: Foundation (2 days)
**Goal**: Establish data layer and configuration

1. **Day 1**:
   - Create models-dev schema with full validation
   - Implement fetch script with proper error handling
   - Set up provider configuration with all providers
   - Run initial data fetch

2. **Day 2**:
   - Create type definitions
   - Define error classes
   - Write unit tests for schema and fetch script
   - Quality gates: lint, typecheck, 100% test coverage

### Phase 2: Core Manager (3 days)
**Goal**: Build the complete LlmProviderManager

1. **Day 3**:
   - Implement constructor and initialization
   - Add model registry and provider discovery
   - Implement health check system with retries

2. **Day 4**:
   - Implement generateText with full fallback logic
   - Add streamText support
   - Implement generateObject support
   - Add model name resolution

3. **Day 5**:
   - Implement cost tracking and statistics
   - Add error threshold management
   - Create comprehensive logging
   - Write extensive unit tests
   - Quality gates: All tests pass, <5ms response time for provider checks

### Phase 3: Integration (2 days)
**Goal**: Integrate with Chronicler system

1. **Day 6**:
   - Update chronicler schemas
   - Modify ChroniclerManager
   - Update Chronicler class
   - Integrate with TadpoleServer

2. **Day 7**:
   - Update all integration tests
   - Add fallback behavior tests
   - Performance testing with multiple providers
   - Documentation update

### Phase 4: Future Enhancements (Post-MVP)
- WebSocket streaming for real-time updates
- Persistent call history in `.tadpole/llm/`
- Cost alerts and budgeting
- Model recommendation based on task type
- A/B testing framework for model comparison

## 4. Testing Strategy

### Unit Tests
```typescript
// tests/unit/llm-provider-manager.test.ts
describe('LlmProviderManager', () => {
  describe('Initialization', () => {
    test('loads models.dev data correctly');
    test('discovers providers with API keys');
    test('handles missing API keys gracefully');
    test('performs initial health checks');
  });

  describe('Health Checks', () => {
    test('marks provider available on success');
    test('retries on transient failures');
    test('disables provider after threshold');
    test('re-enables provider after cooldown');
  });

  describe('Model Resolution', () => {
    test('resolves exact matches');
    test('resolves partial names');
    test('handles ambiguous names');
    test('suggests alternatives for typos');
  });

  describe('Fallback Logic', () => {
    test('tries models in order');
    test('skips unavailable providers');
    test('throws NoAvailableProvidersError when all fail');
    test('resets error count on success');
  });

  describe('Cost Tracking', () => {
    test('calculates costs correctly');
    test('maintains running totals');
    test('tracks per-provider usage');
    test('exports stats accurately');
  });
});
```

### Integration Tests
```typescript
// tests/integration/llm-provider-integration.test
