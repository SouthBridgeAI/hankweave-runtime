# Plan 4: Chronicler Integration Plan (Final)

## Global Intent
Complete the integration of real LLM providers into the chronicler system, making it production-ready. This is the final step that connects all previous work to enable chroniclers to make actual LLM calls.

## Context & Why This Is Being Built
- **Current State**: We have the data layer, provider registry, and tests, but chroniclers still use mocks
- **Goal**: Enable chroniclers to make real LLM calls in production
- **This Plan's Role**: Wire everything together so chroniclers can use real providers

## What's Done So Far
- Plan 1: Created models data schema and download script
- Plan 2: Built LLM Provider Registry with health checks and cost calculation
- Plan 3: Created comprehensive E2E tests for validation

## Key Changes in This Version
1. **Removed TadpoleServer integration** - This will be done in a separate future step
2. **Centralized error handling** - Fatal errors from any operation (including flush) are handled consistently
3. **Updated model schema** - Accepts full model IDs (no legacy "sonnet"/"opus" support needed)
4. **Better health check logging** - Specific messages for different unavailability reasons
5. **Detailed LLM call error logging** - Full request and error details for debugging
6. **Option to await health checks** - ChroniclerManager can wait for provider readiness

## Objective
Integrate the LLM Provider Registry into the existing chronicler system, enabling chroniclers to make real LLM calls with proper cost tracking and error handling, while maintaining full backward compatibility with existing tests.

## Context
- Depends on Plans 1-3 being completed and tested
- Must maintain backward compatibility with existing chronicler tests
- ChroniclerManager will own the LLM Provider Registry
- Chroniclers should unload themselves if required providers are unavailable
- **TadpoleServer integration is deferred to a later phase**

## Important Note
**The code examples below are suggestions**. Feel free to modify them as needed and add comments to explain your implementation decisions. Look at the existing chronicler implementation to understand how test mode is currently handled (via mock llmCall functions) and maintain that pattern.

## Implementation Steps

### 1. Update Chronicler Configuration Schema (`server/config-validation/chronicler.schema.ts`)

**IMPORTANT**: Update this FIRST before any other changes.

```typescript
// Update the model field to accept full model IDs
export const chroniclerConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  description: z.string().optional(),

  // CHANGED: Now accepts full model IDs (e.g., "anthropic/claude-3-5-sonnet-20241022")
  model: z.string().optional().describe(
    'The full model ID to use (e.g., "anthropic/claude-3-5-sonnet-20241022", "openai/gpt-4-turbo"). ' +
    'If not provided, chronicler will use provider registry if available, otherwise will skip loading.'
  ),

  // ... rest of existing schema ...
  llmParams: z.object({
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().positive().optional(),
    maxRetries: z.number().min(0).max(5).optional(),
  }).optional(),

  // ... rest of schema unchanged ...
});
```

### 2. Update Chronicler Class (`server/chroniclers/chronicler.ts`)

**Note**: Look at the current implementation to understand how the llmCall function is used. The chronicler currently receives an llmCall function in its constructor and uses that for all LLM calls. In tests, this is a mock function. We'll extend this pattern to also support real provider calls.

```typescript
// Add to imports
import type { LanguageModel } from 'ai';
import { generateText } from 'ai';
import type { LlmProviderRegistry } from '../llm/llm-provider-registry.js';
import { ChroniclerFatalError } from './chronicler-fatal-error.js';
import { mergeWithDefaults } from './chronicler-defaults.js';

// Update constructor signature
constructor(
  config: ChroniclerConfig,
  phaseId: PhaseId,
  llmCall: (id: string, options: TadpoleGenerateTextOptions) => Promise<TadpoleGenerateTextResult>,
  logger?: Logger,
  chroniclerDir?: string,
  configDirectory?: string,
  runStartTime?: Date,
  model?: LanguageModel,  // DEPRECATED - for backward compat
  providerRegistry?: LlmProviderRegistry  // NEW
) {
  // ... existing constructor code ...

  this.config = config;
  this.providerRegistry = providerRegistry;
  this.totalCost = 0;  // NEW: Track cumulative costs for this chronicler
}

// Add property to track total costs
private totalCost: number = 0;

// Add getter for total cost
public getTotalCost(): number {
  return this.totalCost;
}

// Update executeChroniclerCall method
// IMPORTANT: Look at the current implementation to see how it uses the llmCall function
// The pattern is: if providerRegistry exists, use real providers; otherwise use the mock llmCall
private async executeChroniclerCall(
  events: ServerEvent[],
  executionId: ExecutionId
): Promise<void> {
  try {
    // ... existing template rendering code ...

    // Merge LLM params with defaults
    const llmParams = mergeWithDefaults(this.config.llmParams);

    // NEW: Check if we have a provider registry (production mode)
    if (this.providerRegistry) {
      // IMPORTANT: Model is required when using provider registry
      if (!this.config.model) {
        throw new ChroniclerFatalError(
          this.config.id,
          `Chronicler ${this.config.id} requires a model configuration when LLM provider is available`,
          'configuration',
          true,  // shouldUnload
          false  // not retryable
        );
      }

      const modelName = this.config.model;

      // Log attempt to get model
      this.logger?.log(
        `[Chronicler:${this.config.id}] Attempting to get provider for model ${modelName}`,
        'debug'
      );

      const model = this.providerRegistry.getProviderForModel(modelName);

      if (!model) {
        // Model not available - throw a fatal error to unload this chronicler
        this.logger?.log(
          `[Chronicler:${this.config.id}] Model ${modelName} not available - unloading chronicler`,
          'error'
        );

        throw new ChroniclerFatalError(
          this.config.id,
          `Required model ${modelName} is not available`,
          'configuration',
          true,  // shouldUnload
          false  // not retryable
        );
      }

      // Make real LLM call with detailed error handling
      this.logger?.log(
        `[Chronicler:${this.config.id}] Making real LLM call with model ${modelName}`,
        'debug'
      );

      try {
        const result = await generateText({
          model,
          messages,
          ...llmParams,
        });

        // Track and log cost if available
        if (result.usage) {
          const cost = this.providerRegistry.calculateCost(
            modelName,
            result.usage.promptTokens,
            result.usage.completionTokens
          );

          if (cost !== null) {
            // Track cumulative cost
            this.totalCost += cost;

            this.logger?.log(
              `[Chronicler:${this.config.id}] LLM call cost: ${this.providerRegistry.formatCost(cost)} ` +
              `(total: ${this.providerRegistry.formatCost(this.totalCost)})`,
              'info'
            );
          }
        }

        // Handle response (use existing pattern from current code)
        await this.handleLlmResponse(result.text, userMessage);

      } catch (llmError) {
        // Simpler error logging - just log the last user message, params, and model
        const lastUserMessage = ... // Get the last user message and log the ENTIRE object.

        this.logger?.log(
          `[Chronicler:${this.config.id}] LLM call failed. Request: ${JSON.stringify(requestSummary, null, 2)}`,
          'error'
        );
        this.logger?.log(
          `[Chronicler:${this.config.id}] Error: ${llmError}`,
          'error'
        );

        // Re-throw as ChroniclerFatalError if it's a configuration issue
        if (llmError instanceof Error && llmError.message.includes('API key')) {
          throw new ChroniclerFatalError(
            this.config.id,
            `Provider configuration error: ${llmError.message}`,
            'configuration',
            true,  // shouldUnload
            false  // not retryable
          );
        }

        // Otherwise, let the existing error handling deal with it
        throw llmError;
      }

    } else {
      // No provider registry - use the mock llmCall function passed in constructor
      // This is how tests work - they pass a mock llmCall function
      this.logger?.log(
        `[Chronicler:${this.config.id}] Using mock LLM call (test mode)`,
        'debug'
      );

      const options: TadpoleGenerateTextOptions = {
        model: this.model || ({} as LanguageModel),
        messages,
        ...llmParams,
      };

      const result = await this.llmCall(this.config.id, options);
      await this.handleLlmResponse(result.text, userMessage);
    }

  } catch (error) {
    // Check if it's a fatal error that should unload the chronicler
    if (error instanceof ChroniclerFatalError) {
      // Re-throw fatal errors to be handled by manager
      throw error;
    }

    // Handle other errors based on existing pattern
    this.handleLlmError(error as Error);
  }
}

// Look at existing handleLlmResponse and handleLlmError methods to maintain consistency
```

### 3. Update ChroniclerManager with Centralized Error Handling (`server/chroniclers/chronicler-manager.ts`)

ChroniclerManager will now own the LLM Provider Registry and handle chronicler validation with centralized error handling:

```typescript
// Add to imports
import { LlmProviderRegistry } from '../llm/llm-provider-registry.js';
import { ChroniclerFatalError } from './chronicler-fatal-error.js';
import type { LlmProviderRegistryConfig } from '../llm/llm-provider-registry.js';

export interface ChroniclerManagerOptions {
  logger?: Logger;
  waitForHealthChecks?: boolean;  // NEW: Option to wait for provider health checks
}

export class ChroniclerManager {
  // ... existing properties ...
  private providerRegistry?: LlmProviderRegistry;
  private healthCheckPromise?: Promise<void>;

  constructor(options: ChroniclerManagerOptions = {}) {
    // ... existing constructor ...
    this.logger = options.logger;
    this.initializeProviderRegistry(options.waitForHealthChecks);
  }

  private async initializeProviderRegistry(waitForHealthChecks = false): Promise<void> {
    try {
      // Only initialize in production (when not testing)
      // Check NODE_ENV or presence of mock indicators
      const isTestEnvironment =
        process.env.NODE_ENV === 'test' ||
        process.env.TADPOLE_TEST === 'true';

      if (!isTestEnvironment) {
        this.logger?.log(
          'Initializing LLM Provider Registry for production use',
          'info'
        );

        this.providerRegistry = new LlmProviderRegistry({
          logger: this.logger,
          performHealthCheckOnInit: false,
        });

        // Perform health checks
        this.healthCheckPromise = this.providerRegistry.performHealthChecks()
          .then(statuses => {
            const healthy = Array.from(statuses.values()).filter(s => s.healthy);
            const available = Array.from(statuses.values()).filter(s => s.available);
            this.logger?.log(
              `LLM providers initialized: ${healthy.length}/${available.length} healthy, ${statuses.size} total`,
              'info'
            );

            // Log each provider status for visibility
            for (const [id, status] of statuses) {
              this.logger?.log(
                `Provider ${id}: available=${status.available}, healthy=${status.healthy}`,
                'debug'
              );
            }
          })
          .catch(error => {
            this.logger?.log(`Provider health checks failed: ${error}`, 'error');
          });

        // If configured, wait for health checks to complete
        if (waitForHealthChecks && this.healthCheckPromise) {
          this.logger?.log('Waiting for provider health checks to complete...', 'info');
          await this.healthCheckPromise;
        }
      } else {
        this.logger?.log(
          'Test environment detected - skipping LLM Provider Registry initialization',
          'debug'
        );
      }
    } catch (error) {
      this.logger?.log(
        `Failed to initialize LLM providers: ${error}`,
        'error'
      );
      // Continue without providers - tests will use mocks
    }
  }

  // IMPROVED: Centralized error handling wrapper
  private async _safelyExecute(
    chroniclerId: string,
    action: () => Promise<void> | void
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (error instanceof ChroniclerFatalError && error.shouldUnload) {
        this.logger?.log(
          `Unloading chronicler ${error.chroniclerId} due to fatal error: ${error.message}`,
          'error'
        );
        this.unloadChronicler(chroniclerId);
      } else {
        this.logger?.log(
          `Error in chronicler ${chroniclerId}: ${error}`,
          'error'
        );
      }
    }
  }

  // NEW: Unload a specific chronicler
  private unloadChronicler(chroniclerId: string): void {
    const chronicler = this.chroniclers.get(chroniclerId);
    if (chronicler) {
      chronicler.destroy(); // Clean up timers, etc.
      this.chroniclers.delete(chroniclerId);
      this.logger?.log(`Unloaded chronicler ${chroniclerId}.`, 'info');
    }
  }

  // IMPROVED: Use centralized error handling for event processing
  public async processEvent(event: ServerEvent): Promise<void> {
    const promises = Array.from(this.chroniclers.values()).map(chronicler =>
      this._safelyExecute(chronicler.getId(), () => chronicler.handleEvent(event))
    );
    await Promise.allSettled(promises);
  }

  // IMPROVED: Use centralized error handling for flush operations
  public async flush(): Promise<void> {
    const promises = Array.from(this.chroniclers.values()).map(chronicler =>
      this._safelyExecute(chronicler.getId(), () => chronicler.flush())
    );
    await Promise.allSettled(promises);
  }

  // Update loadChroniclersForPhase signature
  public async loadChroniclersForPhase(
    configs: ChroniclerConfig[],
    phaseId: PhaseId,
    llmCall: (id: string, options: TadpoleGenerateTextOptions) => Promise<TadpoleGenerateTextResult>,
    logger?: Logger,
    chroniclerDir?: string,
    configDirectory?: string,
    runStartTime?: Date,
    model?: LanguageModel,  // DEPRECATED
    // Remove providerRegistry parameter - we use internal one now
  ): Promise<void> {
    // ... existing validation ...

    for (const config of validConfigs) {
      try {
        // IMPROVED: Better logging for availability checks
        if (this.providerRegistry && config.model) {
          this.logger?.log(
            `Checking availability of model ${config.model} for chronicler ${config.id}`,
            'debug'
          );

          const modelInfo = this.providerRegistry.getModelInfo(config.model);
          if (!modelInfo) {
            this.logger?.log(
              `Skipping chronicler ${config.id}: Model ${config.model} not found in registry`,
              'warn'
            );
            continue;
          }

          const providerId = modelInfo.providerId;
          const providerStatus = this.providerRegistry.getProviderStatus().get(providerId);

          if (!providerStatus?.available) {
            this.logger?.log(
              `Skipping chronicler ${config.id}: Provider '${providerId}' for model ${config.model} is not configured (missing API key?)`,
              'warn'
            );
            continue;
          }

          if (!providerStatus.healthy) {
            // Health check might still be running or failed
            const reason = providerStatus.lastChecked
              ? `health check failed: ${providerStatus.error}`
              : 'health check pending';
            this.logger?.log(
              `Skipping chronicler ${config.id}: Provider '${providerId}' for model ${config.model} is not healthy (${reason})`,
              'warn'
            );
            continue;
          }
        }

        const chronicler = new Chronicler(
          config,
          phaseId,
          llmCall,  // Pass the mock llmCall for backward compatibility
          logger || this.logger,
          chroniclerDir,
          configDirectory,
          runStartTime,
          model,  // Pass through for backward compat
          this.providerRegistry  // Pass registry if available
        );

        this.chroniclers.set(config.id, chronicler);
        this.logger?.log(`Loaded chronicler: ${config.id}`, 'info');

      } catch (error) {
        if (error instanceof ChroniclerFatalError) {
          this.logger?.log(
            `Fatal error loading chronicler ${config.id}: ${error.message}`,
            'error'
          );
          // Don't load this chronicler
          continue;
        }

        this.logger?.log(
          `Failed to load chronicler ${config.id}: ${error}`,
          'error'
        );
      }
    }

    this.logger?.log(
      `Loaded ${this.chroniclers.size} chroniclers for phase ${phaseId}`,
      'info'
    );
  }

  // Add methods for status reporting
  public getProviderStatus() {
    return this.providerRegistry?.getProviderStatus();
  }

  public getAvailableModels() {
    return this.providerRegistry?.getAvailableModels() || [];
  }
}
```

### 4. Update Test Harness (`tests/utils/chronicler-test-harness.ts`)

```typescript
// The test harness should continue to work as before
// Tests pass mock llmCall functions, so no registry is needed

export async function createChroniclerTestHarness(
  configs: ChroniclerConfig[],
  options: TestHarnessOptions = {}
): Promise<ChroniclerTestHarness> {
  // ... existing setup ...

  // Set test environment flag
  process.env.NODE_ENV = 'test';

  // Create manager - it will detect test mode and not initialize registry
  const manager = new ChroniclerManager(logger);

  // Load chroniclers with mock llmCall
  await manager.loadChroniclersForPhase(
    configs,
    PhaseId('test-phase'),
    mockLlmCall,  // This is the mock function that tests use
    logger,
    chroniclerDir,
    undefined,
    new Date(),
    undefined
  );

  // ... rest of harness setup ...
}

// For integration tests that want to test with real providers
export async function createChroniclerTestHarnessWithProviders(
  configs: ChroniclerConfig[],
  options: TestHarnessOptions = {}
): Promise<ChroniclerTestHarness> {
  // Clear test flag to enable real providers
  delete process.env.NODE_ENV;
  delete process.env.TADPOLE_TEST;

  const manager = new ChroniclerManager(logger);

  // Wait for provider initialization
  await new Promise(resolve => setTimeout(resolve, 1000));

  // ... rest of setup ...
}
```

## Deferred: TadpoleServer Integration

**NOTE**: TadpoleServer integration is intentionally deferred to a later phase. The ChroniclerManager is now self-contained and can be integrated into TadpoleServer in a future update without any changes to the core chronicler/provider logic.

When ready to integrate, the changes will be minimal:
1. Create ChroniclerManager in TadpoleServer
2. Pass events to ChroniclerManager.processEvent()
3. Call ChroniclerManager.flush() at phase end
4. Optionally expose provider status in server events

## Potential Issues & Solutions

### Issue 1: Breaking Existing Tests
**Problem**: Adding new parameters might break existing tests.
**Solution**:
- Keep the existing mock llmCall pattern
- Only use provider registry when explicitly enabled
- Use environment flags to detect test mode

### Issue 2: Fatal Error Handling
**Problem**: Need to handle fatal errors from any operation (not just event processing).
**Solution**:
- Centralized `_safelyExecute` wrapper handles all chronicler operations
- Covers both `processEvent` and `flush` operations
- Automatic chronicler unloading on fatal errors

### Issue 3: Provider Initialization Timing
**Problem**: Providers might not be ready when chroniclers start.
**Solution**:
- Initialize providers early in ChroniclerManager constructor
- Health checks run in background (or await if configured)
- Skip chroniclers if their required provider isn't ready
- Provide detailed logging about why models are unavailable

### Issue 4: Detailed Error Logging
**Problem**: Hard to debug LLM call failures.
**Solution**:
- Log full request object on failures
- Log detailed error messages
- Truncate message content for readability
- Re-throw as fatal errors for configuration issues

## Validation Steps

After each file update:
```bash
# Check types
bun typecheck

# Fix linting
bun lint:fix

# Run existing chronicler tests (should still pass)
bun test tests/unit/chronicler-*.test.ts
bun test tests/integration/chronicler-*.test.ts

# Run new E2E tests with real providers
ANTHROPIC_API_KEY=sk-ant-... bun test tests/e2e/chronicler-llm-e2e.test.ts

# Manual testing with real API
ANTHROPIC_API_KEY=sk-ant-... bun run server --config=test-chroniclers.json
```

## Migration Guide

### For Existing Users

No changes required. Chroniclers will continue to work with mock LLM calls if no providers are configured.

### To Enable Real LLM Calls

1. **Set API Keys**:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   export OPENAI_API_KEY=sk-...
   ```

2. **Configure Chronicler Model**:
   ```json
   {
     "id": "narrator",
     "model": "anthropic/claude-3-5-sonnet-20241022",
     "llmParams": {
       "temperature": 0.7,
       "maxOutputTokens": 2000
     }
   }
   ```

3. **Start Server**:
   ```bash
   bun run server
   ```

The server will automatically:
- Detect available providers
- Run health checks
- Enable chroniclers that have available models
- Log costs for each LLM call
- Provide detailed reasons when models are unavailable

### Creating ChroniclerManager with Options

```typescript
// Wait for health checks before loading chroniclers
const manager = new ChroniclerManager({
  logger: myLogger,
  waitForHealthChecks: true  // Ensures providers are ready
});
```

## Files Modified

### Core Files
- `server/config-validation/chronicler.schema.ts` - Update model field to accept full model IDs
- `server/chroniclers/chronicler.ts` - Add provider registry support with detailed error handling
- `server/chroniclers/chronicler-manager.ts` - Own and manage registry, centralized error handling

### Test Files
- `tests/utils/chronicler-test-harness.ts` - Maintain backward compatibility
- Various test files - Should continue to work unchanged

### NOT Modified (Deferred)
- `server/tadpole-server.ts` - Integration deferred to later phase

## Success Criteria

1. **Backward Compatibility**: All existing tests pass without changes
2. **Provider Integration**: Chroniclers can use real LLM providers when available
3. **Cost Tracking**: Costs are logged for each LLM call
4. **Graceful Degradation**: System works without API keys (tests use mocks)
5. **Fatal Error Handling**: Chroniclers unload properly on fatal errors from any operation
6. **Health Monitoring**: Provider health is checked and reported with detailed reasons
7. **Type Safety**: TypeScript compilation succeeds
8. **Logging**: Comprehensive logs for debugging and monitoring with full request details on failure

## Integration Testing Checklist

- [ ] Start server without API keys - tests still work with mocks
- [ ] Start server with Anthropic key - chroniclers use Claude
- [ ] Start server with multiple keys - can use different models
- [ ] Chronicler with unavailable model - skips gracefully with clear reason
- [ ] Chronicler without model when registry available - fatal error and unloads
- [ ] Fatal error in chronicler - unloads properly
- [ ] Fatal error during flush - unloads properly
- [ ] Health check failures - logged with details but don't crash
- [ ] Cost logging - accurate costs appear in logs
- [ ] Conversational mode - works with real providers
- [ ] Template rendering - works with provider responses
- [ ] Performance - no noticeable slowdown
- [ ] Wait for health checks option - delays loading until providers ready

## Note for Implementation
This plan is designed to be implemented by an AI agent with human supervision. The implementer should:
1. Start with the schema update (Step 1) - this is critical
2. Look at the existing code to understand current patterns
3. Maintain backward compatibility with tests
4. Add comprehensive logging for debugging
5. Test thoroughly with both mocks and real providers
6. Handle errors gracefully without breaking existing functionality
7. Use the centralized error handling pattern consistently

The human will check the results after implementation.
