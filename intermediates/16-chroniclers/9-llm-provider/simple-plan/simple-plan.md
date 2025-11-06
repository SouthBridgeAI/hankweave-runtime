# Simple LLM Provider Registry Implementation Plan

## 1. Executive Summary & Intent

### Purpose
The `LlmProviderRegistry` is a **minimal, pragmatic solution** for enabling chroniclers to use LLMs. Instead of building a complex centralized manager, we provide a simple registry that:
- **Discovers** available AI SDK providers based on API keys
- **Validates** provider availability with basic health checks
- **Provides** cost information from models.dev data
- **Enables** chroniclers to make their own LLM calls

### Design Philosophy
1. **YAGNI (You Aren't Gonna Need It)**: Build only what's needed now
2. **Simple Over Complex**: Direct provider access instead of abstraction layers
3. **Progressive Enhancement**: Can evolve into complex system if needed
4. **Testable**: Easy to mock and test
5. **Fail-Safe**: Gracefully handle missing providers

## 2. Architecture Components

### 2.1 Static Data Layer

#### `server/llm/models-dev-data.json`
**Intent**: Pre-downloaded models.dev data to avoid runtime network dependencies

**Data Structure**:
```json
{
  "version": "1.0.0",
  "lastUpdated": "2025-01-21T00:00:00Z",
  "models": [
    {
      "providerId": "anthropic",
      "modelId": "claude-3-5-sonnet-20241022",
      "name": "Claude 3.5 Sonnet",
      "cost": {
        "input": 3.00,   // per million tokens
        "output": 15.00
      },
      "limits": {
        "context": 200000,
        "output": 8192
      }
    }
  ]
}
```

**Update Process**:
- Manually run `scripts/fetch-models-dev.ts` periodically
- Commit the updated JSON to version control
- No runtime fetching required

### 2.2 Provider Configuration

#### `server/llm/provider-config.ts`
**Intent**: Centralized mapping of providers to their SDK factories and API keys

```typescript
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { Provider } from 'ai';

export interface ProviderDefinition {
  id: string;
  apiKeyEnvVar: string;
  createProvider: (apiKey: string) => Provider;
  testModel?: string; // Model to use for health check
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    createProvider: (apiKey) => createAnthropic({ apiKey }),
    testModel: 'claude-3-haiku-20240307' // Cheapest for testing
  },
  {
    id: 'openai',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    createProvider: (apiKey) => createOpenAI({ apiKey }),
    testModel: 'gpt-3.5-turbo'
  }
  // Easy to add more providers here
];
```

### 2.3 Core Registry Implementation

#### `server/llm/llm-provider-registry.ts`
**Intent**: Simple registry that loads providers and provides access

```typescript
import { generateText } from 'ai';
import type { Provider } from 'ai';
import type { Logger } from '../types/types.js';
import { PROVIDER_DEFINITIONS } from './provider-config.js';
import modelsData from './models-dev-data.json';

export interface ModelInfo {
  providerId: string;
  modelId: string;
  fullModelId: string; // "anthropic/claude-3-5-sonnet"
  costPerMillionInput: number;
  costPerMillionOutput: number;
  maxContext: number;
  maxOutput: number;
}

export class LlmProviderRegistry {
  private providers = new Map<string, Provider>();
  private models = new Map<string, ModelInfo>();
  private providerHealth = new Map<string, boolean>();
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
    this.loadModelsData();
    this.initializeProviders();
  }

  // === Initialization ===

  private loadModelsData(): void {
    for (const model of modelsData.models) {
      const fullModelId = `${model.providerId}/${model.modelId}`;
      const info: ModelInfo = {
        providerId: model.providerId,
        modelId: model.modelId,
        fullModelId,
        costPerMillionInput: model.cost.input,
        costPerMillionOutput: model.cost.output,
        maxContext: model.limits.context,
        maxOutput: model.limits.output,
      };

      // Register by both full and short names
      this.models.set(fullModelId, info);
      this.models.set(model.modelId, info);
    }

    this.logger?.log(`Loaded ${modelsData.models.length} models from static data`, 'info');
  }

  private initializeProviders(): void {
    for (const def of PROVIDER_DEFINITIONS) {
      const apiKey = process.env[def.apiKeyEnvVar];

      if (!apiKey) {
        this.logger?.log(`No API key for ${def.id}, skipping`, 'debug');
        continue;
      }

      try {
        const provider = def.createProvider(apiKey);
        this.providers.set(def.id, provider);
        this.logger?.log(`Initialized provider: ${def.id}`, 'info');
      } catch (error) {
        this.logger?.log(`Failed to initialize ${def.id}: ${error}`, 'error');
      }
    }
  }

  // === Health Checks ===

  public async performHealthChecks(): Promise<void> {
    this.logger?.log('Starting provider health checks', 'debug');

    const checks = Array.from(this.providers.entries()).map(async ([id, provider]) => {
      const def = PROVIDER_DEFINITIONS.find(d => d.id === id);
      if (!def?.testModel) {
        this.providerHealth.set(id, true); // Assume healthy if no test model
        return;
      }

      try {
        const model = provider(def.testModel);
        await generateText({
          model,
          messages: [{ role: 'user', content: 'Hi' }],
          maxOutputTokens: 1,
          temperature: 0,
        });

        this.providerHealth.set(id, true);
        this.logger?.log(`Health check passed: ${id}`, 'debug');
      } catch (error) {
        this.providerHealth.set(id, false);
        this.logger?.log(`Health check failed for ${id}: ${error}`, 'warn');
      }
    });

    await Promise.allSettled(checks);
    this.logger?.log('Health checks complete', 'debug');
  }

  // === Public API ===

  /**
   * Get a provider for a specific model.
   * Returns null if model not found or provider unavailable.
   */
  public getProviderForModel(modelName: string): Provider | null {
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
    const isHealthy = this.providerHealth.get(modelInfo.providerId) ?? false;
    if (!isHealthy) {
      this.logger?.log(`Provider unhealthy: ${modelInfo.providerId}`, 'warn');
      return null;
    }

    return provider;
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
    return this.getProviderForModel(modelName) !== null;
  }

  /**
   * Get all available models.
   */
  public getAvailableModels(): string[] {
    const available: string[] = [];

    for (const [modelId, info] of this.models) {
      if (this.isModelAvailable(modelId)) {
        available.push(info.fullModelId);
      }
    }

    return [...new Set(available)]; // Remove duplicates
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
}
```

### 2.4 Integration with Chroniclers

#### Updates to `Chronicler` class

```typescript
// In constructor
constructor(
  config: ChroniclerConfig,
  phaseId: PhaseId,
  providerRegistry: LlmProviderRegistry, // NEW
  logger?: Logger,
  // ... other params
)

// In executeChroniclerCall()
private async executeChroniclerCall(
  events: ServerEvent[],
  executionId: ExecutionId
): Promise<void> {
  try {
    // ... prepare messages ...

    // Get provider for configured model
    const modelName = this.config.model ?? 'claude-3-5-sonnet-20241022';
    const provider = this.providerRegistry.getProviderForModel(modelName);

    if (!provider) {
      this.logger?.log(
        `Model ${modelName} not available, skipping chronicler execution`,
        'warn'
      );
      return;
    }

    // Make the LLM call
    const model = provider(modelName);
    const result = await generateText({
      model,
      messages,
      ...this.config.llmParams, // temperature, maxOutputTokens, etc.
    });

    // Optional: Log cost
    const cost = this.providerRegistry.calculateCost(
      modelName,
      result.usage.inputTokens,
      result.usage.outputTokens
    );

    if (cost !== null) {
      this.logger?.log(
        `Chronicler ${this.config.id} call cost: $${cost.toFixed(6)}`,
        'debug'
      );
    }

    // Process result...
    await this.processLlmResult(result.text);

  } catch (error) {
    this.logger?.log(`Chronicler execution failed: ${error}`, 'error');
    // Decide whether to unload on error based on config
  }
}
```

## 3. Implementation Steps

### Phase 1: Setup (Day 1 Morning)
1. **Create static models data**
   - [ ] Copy relevant data from models.dev
   - [ ] Create `server/llm/models-dev-data.json`
   - [ ] Add essential models (Claude, GPT, Gemini)

2. **Create provider configuration**
   - [ ] Create `server/llm/provider-config.ts`
   - [ ] Add Anthropic and OpenAI providers
   - [ ] Define health check models

3. **Implement registry**
   - [ ] Create `server/llm/llm-provider-registry.ts`
   - [ ] Implement initialization logic
   - [ ] Add health check method
   - [ ] Implement public API methods

### Phase 2: Integration (Day 1 Afternoon)
1. **Update Chronicler**
   - [ ] Add registry parameter to constructor
   - [ ] Update `executeChroniclerCall` method
   - [ ] Add cost logging

2. **Update ChroniclerManager**
   - [ ] Pass registry to chroniclers
   - [ ] Update `loadChroniclersForPhase`

3. **Update TadpoleServer**
   - [ ] Create registry on startup
   - [ ] Run health checks
   - [ ] Pass to ChroniclerManager

### Phase 3: Testing (Day 2 Morning)
1. **Unit tests**
   - [ ] Test registry initialization
   - [ ] Test provider discovery
   - [ ] Test model lookup
   - [ ] Test cost calculation

2. **Integration tests**
   - [ ] Update chronicler tests with mock registry
   - [ ] Test missing provider handling
   - [ ] Test health check failures

### Phase 4: Documentation (Day 2 Afternoon)
1. **Update documentation**
   - [ ] Add to chronicler documentation
   - [ ] Document environment variables
   - [ ] Add usage examples

## 4. Error Handling Strategy

### Provider Unavailable
- **Behavior**: Skip chronicler execution
- **Logging**: Warn-level log message
- **Recovery**: Retry on next trigger

### Model Not Found
- **Behavior**: Skip execution
- **Logging**: Error-level log with suggestions
- **Recovery**: None, configuration issue

### LLM Call Failure
- **Behavior**: Log and continue
- **Logging**: Error with details
- **Recovery**: Natural retry on next trigger

### Health Check Failure
- **Behavior**: Mark provider unavailable
- **Logging**: Warn-level message
- **Recovery**: Can retry health checks periodically

## 5. Testing Approach

### Mock Registry for Tests
```typescript
export class MockLlmProviderRegistry {
  private mockProviders = new Map<string, boolean>();

  setProviderAvailable(providerId: string, available: boolean) {
    this.mockProviders.set(providerId, available);
  }

  getProviderForModel(modelName: string): Provider | null {
    // Return mock provider or null based on configuration
  }

  calculateCost(): number {
    return 0.001; // Fixed mock cost
  }
}
```

### Test Scenarios
1. **Happy path**: Provider available, call succeeds
2. **No provider**: API key missing
3. **Health check fail**: Provider errors during check
4. **Model not found**: Invalid model name
5. **Cost calculation**: Verify cost math

## 6. Migration Path

### Current State
- Chroniclers use mock LLM calls
- No real provider integration

### After Implementation
- Real providers discovered at startup
- Chroniclers make actual LLM calls
- Costs tracked (logged only for now)

### Future Enhancements (if needed)
1. **Add fallback logic** - If chroniclers often need it
2. **Centralized cost tracking** - Store in state/database
3. **Rate limiting** - If API limits become issue
4. **Caching** - For repeated identical calls
5. **WebSocket updates** - Stream costs to UI

## 7. Configuration Examples

### Environment Setup
```bash
# .env file
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
# GOOGLE_API_KEY=...  # Optional
```

### Chronicler Configuration
```json
{
  "id": "narrator",
  "name": "Development Narrator",
  "model": "claude-3-5-sonnet-20241022",
  "llmParams": {
    "temperature": 0.7,
    "maxOutputTokens": 2000
  },
  "trigger": {
    "type": "event",
    "on": ["assistant.action", "tool.result"]
  },
  "execution": {
    "strategy": "debounce",
    "milliseconds": 2500
  }
}
```

## 8. Key Differences from Complex Plan

| Aspect | Complex Plan | Simple Plan |
|--------|-------------|-------------|
| **Fallback Logic** | Centralized in manager | Chroniclers handle own |
| **Error Thresholds** | Sophisticated tracking | Simple health check |
| **Call History** | Full history tracking | No history (just logs) |
| **Cost Tracking** | Centralized state | Log-only for now |
| **Provider Management** | Dynamic enable/disable | Static after health check |
| **Implementation Time** | 1 week | 2 days |
| **Code Complexity** | ~1000 lines | ~300 lines |
| **Testing Complexity** | Complex mocks needed | Simple mock registry |

## 9. Success Criteria

1. **Providers Initialize**: Anthropic and OpenAI load with API keys
2. **Health Checks Pass**: Available providers validate
3. **Chroniclers Execute**: Can make real LLM calls
4. **Costs Logged**: Token usage converted to dollar amounts
5. **Tests Pass**: All existing tests still work
6. **Graceful Degradation**: Missing providers don't crash

## 10. Notes & Decisions

### Why Static Data?
- Avoids network dependency at startup
- Models don't change frequently
- Can always add dynamic fetching later

### Why No Fallback?
- Chroniclers are advisory, not critical
- Simpler to reason about
- Can add if patterns emerge

### Why Log-Only Costs?
- Don't need persistence yet
- Can analyze logs if needed
- Easy to add database later

### Why Simple Health Check?
- Just need binary available/not
- Complex tracking overengineering
- Can enhance if issues arise

## Conclusion

This simple plan achieves the core goal - letting chroniclers use real LLMs - without overengineering. It's pragmatic, testable, and can evolve as needs grow. The implementation should take 2 days instead of a week, and the codebase remains maintainable.
