# Plan 3: End-to-End Testing Plan

## Global Intent
Validate that the LLM provider system works correctly end-to-end, from provider initialization through health checks to actual LLM calls. Tests should provide confidence that the system will work in production while being informative about what's available.

## Context & Why This Is Being Built
- **Current State**: We have data layer and provider manager but no validation
- **Goal**: Comprehensive testing that validates the entire system works
- **This Plan's Role**: Ensure quality and reliability before chronicler integration

## What's Done So Far
- Plan 1: Created models data schema and download script
- Plan 2: Built LLM Provider Registry with health checks and cost calculation

## Objective
Create comprehensive E2E tests that validate the entire LLM provider system works correctly with real and mock API calls, ensuring health checks, cost tracking, and chronicler integration all function as expected.

## Context
- Depends on Plan 1 (models data) and Plan 2 (provider registry) being implemented
- Tests should be informative - skip with messages when providers unavailable
- Should use provider configurations from Plan 2, not hardcode provider names

## Important Note
**The code examples below are suggestions**. Feel free to modify them as needed and add comments to explain your implementation decisions.

## Testing Strategy

### Three-Level Testing Approach
1. **Unit Tests** - Already covered in Plans 1 & 2
2. **Integration Tests** - Provider health checks with real APIs
3. **E2E Tests** - Full chronicler workflow with LLM calls

## Implementation Steps

### 1. Create E2E Tests for Health Checks (`tests/e2e/llm-provider-health.e2e.test.ts`)

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { LlmProviderRegistry } from '../../server/llm/llm-provider-registry.js';
import { PROVIDER_DEFINITIONS } from '../../server/llm/provider-config.js';
import type { Logger } from '../../server/types/types.js';

describe('LLM Provider Health Checks (E2E)', () => {
  let registry: LlmProviderRegistry;
  const logs: Array<{ message: string; level: string }> = [];

  const mockLogger: Logger = {
    log: (message: string, level = 'info') => {
      logs.push({ message, level });
      console.log(`[${level}] ${message}`); // Also log to console for debugging
    }
  };

  // No beforeAll - we want to see which specific tests are skipped

  describe('individual provider health checks', () => {
    // Test each provider from the config
    for (const [index, providerDef] of PROVIDER_DEFINITIONS.entries()) {
      it(`should health check provider ${index + 1} (${providerDef.id})`, async () => {
        const apiKey = process.env[providerDef.apiKeyEnvVar];

        if (!apiKey) {
          // Fail test with informative message
          throw new Error(`Missing API key for ${providerDef.id} - set ${providerDef.apiKeyEnvVar} to run this test`);
        }

        registry = new LlmProviderRegistry({
          logger: mockLogger,
          healthCheckTimeout: 10000, // 10s for real API calls
        });

        const statuses = await registry.performHealthChecks();
        const status = statuses.get(providerDef.id);

        expect(status).toBeDefined();
        expect(status?.available).toBe(true);

        // Log the result
        console.log(`Provider ${providerDef.id} health check:`, {
          available: status?.available,
          healthy: status?.healthy,
          error: status?.error
        });

        // We expect it to be healthy, but log if not (rate limits, etc.)
        if (!status?.healthy) {
          console.warn(`${providerDef.id} health check failed:`, status?.error);
        }
      }, 30000); // 30s timeout per provider
    }

    it('should handle health check timeouts gracefully', async () => {
      // Only run if at least one provider is available
      const hasAnyKey = PROVIDER_DEFINITIONS.some(
        def => process.env[def.apiKeyEnvVar]
      );

      if (!hasAnyKey) {
        console.log('⚠️ Skipping timeout test - no API keys available');
        return;
      }

      registry = new LlmProviderRegistry({
        logger: mockLogger,
        healthCheckTimeout: 1, // 1ms - guaranteed timeout
      });

      const statuses = await registry.performHealthChecks();

      // All available providers should fail with timeout
      for (const [id, status] of statuses) {
        if (status.available) {
          expect(status.healthy).toBe(false);
          expect(status.error).toContain('timeout');
        }
      }
    });

    it('should calculate costs accurately for real models', async () => {
      registry = new LlmProviderRegistry({ logger: mockLogger });

      // Test with actual models from the loaded data
      const availableModels = registry.getAvailableModels();

      for (const modelId of availableModels.slice(0, 3)) { // Test first 3 models
        const modelInfo = registry.getModelInfo(modelId);
        if (!modelInfo) continue;

        const inputTokens = 1000;
        const outputTokens = 500;

        // Calculate expected cost based on actual model data
        const expectedCost =
          (inputTokens / 1_000_000) * modelInfo.costPerMillionInput +
          (outputTokens / 1_000_000) * modelInfo.costPerMillionOutput;

        const actualCost = registry.calculateCost(modelId, inputTokens, outputTokens);

        if (actualCost !== null) {
          expect(actualCost).toBeCloseTo(expectedCost, 6);
          console.log(
            `Model ${modelId}: Input=$${modelInfo.costPerMillionInput}/M, ` +
            `Output=$${modelInfo.costPerMillionOutput}/M, ` +
            `Test cost=$${actualCost.toFixed(6)}`
          );
        }
      }
    });
  });

  describe('provider discovery', () => {
    it('should discover available providers dynamically', () => {
      const originalEnv = { ...process.env };

      // Test with first provider from list
      const provider1 = PROVIDER_DEFINITIONS[0];
      process.env = { [provider1.apiKeyEnvVar]: 'test-key' };

      let reg = new LlmProviderRegistry({ logger: mockLogger });
      let status = reg.getProviderStatus();
      expect(status.get(provider1.id)?.available).toBe(true);

      // Check that other providers are not available
      for (const def of PROVIDER_DEFINITIONS.slice(1)) {
        expect(status.get(def.id)?.available).toBe(false);
      }

      // Test with multiple providers
      if (PROVIDER_DEFINITIONS.length >= 2) {
        const provider2 = PROVIDER_DEFINITIONS[1];
        process.env = {
          [provider1.apiKeyEnvVar]: 'test-key',
          [provider2.apiKeyEnvVar]: 'test-key-2'
        };

        reg = new LlmProviderRegistry({ logger: mockLogger });
        status = reg.getProviderStatus();
        expect(status.get(provider1.id)?.available).toBe(true);
        expect(status.get(provider2.id)?.available).toBe(true);
      }

      // Restore environment
      process.env = originalEnv;
    });
  });
});
```

### 2. Create E2E Test with Mock Chronicler (`tests/e2e/chronicler-llm-e2e.test.ts`)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ChroniclerManager } from '../../server/chroniclers/chronicler-manager.js';
import { LlmProviderRegistry } from '../../server/llm/llm-provider-registry.js';
import { MockLlmProviderRegistry } from '../utils/mock-llm-provider-registry.js';
import type { ChroniclerConfig } from '../../server/types/chronicler-types.js';
import type { ServerEvent } from '../../server/schemas/event-schemas.js';
import { PhaseId } from '../../server/types/branded-types.js';
import type { Logger } from '../../server/types/types.js';
import { generateText } from 'ai';

describe('Chronicler LLM Integration (E2E)', () => {
  let manager: ChroniclerManager;
  let registry: LlmProviderRegistry | MockLlmProviderRegistry;
  let logs: string[] = [];
  let llmCalls: any[] = [];

  const mockLogger: Logger = {
    log: (message: string) => {
      logs.push(message);
    }
  };

  beforeEach(() => {
    logs = [];
    llmCalls = [];
  });

  describe('with mock provider', () => {
    beforeEach(() => {
      // Use mock registry for predictable testing
      registry = new MockLlmProviderRegistry();

      // Set up a mock Anthropic provider
      registry.setProviderAvailable('anthropic', true);
      registry.setProviderHealth('anthropic', true);
      registry.addMockModel({
        providerId: 'anthropic',
        modelId: 'claude-3-5-sonnet-20241022',
        fullModelId: 'anthropic/claude-3-5-sonnet-20241022',
        costPerMillionInput: 3.0,
        costPerMillionOutput: 15.0,
        maxContext: 200000,
        maxOutput: 8192,
      });
    });

    it('should skip chronicler when model is unavailable', async () => {
      const config: ChroniclerConfig = {
        id: 'test-chronicler',
        name: 'Test Chronicler',
        model: 'non-existent-model',
        trigger: { type: 'event', on: ['assistant.action'] },
        execution: { strategy: 'immediate' },
        userPromptText: 'Test prompt',
      };

      manager = new ChroniclerManager();
      await manager.loadChroniclersForPhase(
        [config],
        PhaseId('test-phase'),
        async (id, options) => {
          llmCalls.push({ id, options });
          return { text: 'Mock response' };
        },
        mockLogger,
        undefined,
        new Date(),
        registry as any // Type assertion for mock
      );

      const event: ServerEvent = {
        type: 'assistant.action',
        timestamp: new Date().toISOString(),
        data: { action: 'test' }
      };

      manager.processEvent(event);

      // Should log that model is unavailable
      const unavailableLogs = logs.filter(l =>
        l.includes('non-existent-model') && l.includes('not available')
      );
      expect(unavailableLogs.length).toBeGreaterThan(0);

      // Should not make LLM call
      expect(llmCalls.length).toBe(0);
    });

    it('should use available model and log costs', async () => {
      const config: ChroniclerConfig = {
        id: 'narrator',
        name: 'Test Narrator',
        model: 'claude-3-5-sonnet-20241022',
        trigger: { type: 'event', on: ['assistant.action'] },
        execution: { strategy: 'immediate' },
        userPromptText: 'Narrate this: {{events}}',
        llmParams: {
          temperature: 0.7,
          maxOutputTokens: 1000,
        }
      };

      let capturedOptions: any = null;

      manager = new ChroniclerManager();
      await manager.loadChroniclersForPhase(
        [config],
        PhaseId('test-phase'),
        async (id, options) => {
          capturedOptions = options;
          // Simulate AI SDK response
          return {
            text: 'This is a narration of the events',
            usage: {
              promptTokens: 500,
              completionTokens: 100,
            }
          };
        },
        mockLogger,
        undefined,
        new Date(),
        registry as any
      );

      const event: ServerEvent = {
        type: 'assistant.action',
        timestamp: new Date().toISOString(),
        data: { action: 'test', details: 'Testing LLM integration' }
      };

      manager.processEvent(event);

      // Wait for debounce/processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have made LLM call with correct parameters
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.temperature).toBe(0.7);
      expect(capturedOptions.maxOutputTokens).toBe(1000);

      // Calculate expected cost: (500/1M * 3) + (100/1M * 15) = 0.0015 + 0.0015 = 0.003
      const cost = registry.calculateCost('claude-3-5-sonnet-20241022', 500, 100);
      expect(cost).toBeCloseTo(0.003, 6);
    });
  });

  describe('with real provider (requires API key)', () => {
    it('should make real LLM call and track costs', async () => {
      // Find first available provider
      let availableProvider = null;
      let availableModel = null;

      for (const def of PROVIDER_DEFINITIONS) {
        if (process.env[def.apiKeyEnvVar]) {
          availableProvider = def;
          break;
        }
      }

      if (!availableProvider) {
        console.log('⚠️ Skipping real LLM test - no API keys available');
        return;
      }

      registry = new LlmProviderRegistry({
        logger: mockLogger,
        performHealthCheckOnInit: false,
      });

      // Find cheapest model for this provider
      const models = registry.getAvailableModels()
        .filter(m => m.startsWith(availableProvider.id + '/'));

      if (models.length === 0) {
        console.log(`⚠️ No models available for ${availableProvider.id}`);
        return;
      }

      // Use first available model (ideally cheapest based on registry logic)
      availableModel = models[0].split('/')[1];

      const config: ChroniclerConfig = {
        id: 'real-test',
        name: 'Real Test Chronicler',
        model: availableModel,
        trigger: { type: 'event', on: ['test.event'] },
        execution: { strategy: 'immediate' },
        userPromptText: 'Say "test successful" and nothing else',
        llmParams: {
          temperature: 0,
          maxOutputTokens: 10,
        }
      };

      console.log(`Testing with ${availableProvider.id}/${availableModel}`);

      let llmResponse: any = null;

      manager = new ChroniclerManager();
      await manager.loadChroniclersForPhase(
        [config],
        PhaseId('real-test-phase'),
        async (id, options) => {
          // Get actual model from registry
          const model = registry.getProviderForModel(config.model!);
          if (!model) {
            throw new Error('Model not available');
          }

          // Make real LLM call
          const result = await generateText({
            model,
            messages: options.messages,
            temperature: options.temperature,
            maxOutputTokens: options.maxOutputTokens,
          });

          llmResponse = result;
          return result;
        },
        mockLogger,
        undefined,
        new Date(),
        registry
      );

      const event: ServerEvent = {
        type: 'test.event',
        timestamp: new Date().toISOString(),
        data: {}
      };

      manager.processEvent(event);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Should have received response
      expect(llmResponse).toBeDefined();
      expect(llmResponse.text).toContain('test successful');

      // Should have usage data
      expect(llmResponse.usage).toBeDefined();
      expect(llmResponse.usage.promptTokens).toBeGreaterThan(0);

      // Calculate and log actual cost
      const cost = registry.calculateCost(
        availableModel,
        llmResponse.usage.promptTokens,
        llmResponse.usage.completionTokens
      );

      if (cost !== null) {
        console.log(`Real LLM call cost: ${registry.formatCost(cost)}`);
      }

    }, 15000); // 15s timeout for real API call
  });
});
```

### 3. Create Provider Fallback Test (`tests/e2e/llm-provider-fallback.e2e.test.ts`)

```typescript
import { describe, it, expect } from 'bun:test';
import { LlmProviderRegistry } from '../../server/llm/llm-provider-registry.js';

describe('Provider Fallback Scenarios', () => {
  it('should handle provider failures gracefully', async () => {
    const registry = new LlmProviderRegistry({
      modelFilters: {
        allowList: ['claude-3-5-sonnet-20241022', 'gpt-3.5-turbo']
      }
    });

    // Simulate Anthropic being down
    const anthropicModel = registry.getProviderForModel('claude-3-5-sonnet-20241022');

    if (!anthropicModel) {
      // Try fallback to OpenAI
      const openaiModel = registry.getProviderForModel('gpt-3.5-turbo');

      // This demonstrates the pattern, though actual fallback
      // would be implemented in the chronicler
      console.log('Primary provider unavailable, would use fallback');
    }
  });

  it('should report all provider statuses', async () => {
    const registry = new LlmProviderRegistry();
    const statuses = await registry.performHealthChecks();

    // Create availability report
    const report = {
      total: statuses.size,
      available: 0,
      healthy: 0,
      failed: 0,
    };

    for (const [id, status] of statuses) {
      if (status.available) report.available++;
      if (status.healthy) report.healthy++;
      if (!status.healthy && status.available) report.failed++;
    }

    console.log('Provider Status Report:', report);

    // At least we should have status entries for all providers
    expect(statuses.size).toBeGreaterThan(0);
  });
});
```

### 4. Create Load Test (`tests/e2e/llm-provider-load.e2e.test.ts`)

```typescript
import { describe, it, expect } from 'bun:test';
import { LlmProviderRegistry } from '../../server/llm/llm-provider-registry.js';

describe('Provider Registry Performance', () => {
  it('should handle concurrent model lookups efficiently', () => {
    const registry = new LlmProviderRegistry();

    const start = performance.now();

    // Simulate 1000 concurrent lookups
    const lookups = [];
    for (let i = 0; i < 1000; i++) {
      lookups.push(
        registry.getModelInfo('claude-3-5-sonnet-20241022'),
        registry.calculateCost('claude-3-5-sonnet-20241022', 1000, 500),
        registry.isModelAvailable('gpt-3.5-turbo')
      );
    }

    const end = performance.now();
    const duration = end - start;

    console.log(`1000 lookups took ${duration.toFixed(2)}ms`);

    // Should be very fast (< 100ms for 1000 lookups)
    expect(duration).toBeLessThan(100);
  });

  it('should handle large model lists efficiently', () => {
    // Test with large allow list
    const largeAllowList = Array.from({ length: 1000 }, (_, i) => `model-${i}`);

    const start = performance.now();
    const registry = new LlmProviderRegistry({
      modelFilters: { allowList: largeAllowList }
    });
    const end = performance.now();

    console.log(`Loading with 1000-item filter took ${(end - start).toFixed(2)}ms`);

    // Should initialize quickly even with large filters
    expect(end - start).toBeLessThan(1000);
  });
});
```

## Testing Checklist

### Before Running Tests
- [ ] Ensure Plan 1 (models data) is implemented
- [ ] Ensure Plan 2 (provider registry) is implemented
- [ ] Create `.env.test` file with test API keys (optional)
- [ ] Run `bun typecheck` to ensure type safety
- [ ] Run `bun lint:fix` to fix any linting issues

### Test Execution Order
1. **Unit Tests First**
   ```bash
   bun test tests/unit/models-dev-schema.test.ts
   bun test tests/unit/llm-provider-registry.test.ts
   ```

2. **E2E Tests (requires API keys for full coverage)**
   ```bash
   # Tests will skip individual providers if keys not set
   bun test tests/e2e/llm-provider-health.e2e.test.ts
   ```

3. **E2E Tests**
   ```bash
   # With mocks (always works)
   bun test tests/e2e/chronicler-llm-e2e.test.ts

   # With real APIs (use any available provider)
   bun test tests/e2e/chronicler-llm-e2e.test.ts
   ```

4. **Performance Tests**
   ```bash
   bun test tests/e2e/llm-provider-load.e2e.test.ts
   ```

## Potential Issues & Solutions

### Issue 1: Flaky Health Checks
**Problem**: Health checks might fail due to network issues or rate limits.
**Solution**:
- Implement retry logic in tests
- Use longer timeouts for CI environments
- Consider mocking health checks in unit tests

### Issue 2: API Key Management
**Problem**: Tests need API keys but shouldn't expose them.
**Solution**:
- Use `.env.test` file (gitignored)
- Skip tests when keys aren't available
- Use GitHub secrets for CI

### Issue 3: Cost Concerns
**Problem**: Real API tests cost money.
**Solution**:
- Use cheapest models (Haiku, GPT-3.5)
- Limit output tokens to minimum
- Run real API tests only in CI on main branch

### Issue 4: Test Isolation
**Problem**: Tests might interfere with each other.
**Solution**:
- Reset environment variables between tests
- Use separate test phases/chronicler IDs
- Clear any shared state


## Test Coverage Goals

### Minimum Coverage (Required)
- [ ] Schema validation works
- [ ] Registry initializes without errors
- [ ] Mock provider works in tests
- [ ] Cost calculations are accurate
- [ ] Model filtering works

### Full Coverage (Ideal)
- [ ] All providers tested with real APIs
- [ ] Health checks validated
- [ ] Fallback scenarios tested
- [ ] Performance benchmarks pass
- [ ] E2E chronicler flow works

## Success Criteria

1. **All unit tests pass** without API keys
2. **Integration tests pass** when API keys are provided
3. **E2E tests demonstrate** full chronicler → LLM flow
4. **Performance tests show** <100ms for 1000 operations
5. **No memory leaks** in long-running tests
6. **Cost tracking** is accurate to 6 decimal places
7. **TypeScript compilation** succeeds for all test files

## Files Created/Modified

- `tests/e2e/llm-provider-health.e2e.test.ts` - Health check tests
- `tests/e2e/chronicler-llm-e2e.test.ts` - End-to-end tests
- `tests/e2e/llm-provider-fallback.e2e.test.ts` - Fallback scenarios
- `tests/e2e/llm-provider-load.e2e.test.ts` - Performance tests
- `.env.test.example` - Example test environment file

## Note for Implementation
This plan is designed to be implemented by an AI agent with human supervision. The human will check the results after implementation.
