## Current State Assessment

__What's Already Done Well:__

- You have excellent Zod-first type definitions for ModelMessage in `server/types/input-ai-types.ts`
- Your build-time validation pattern with `assertTadpoleIsSubsetOfSdk` ensures compatibility with AI SDK
- The chronicler system has a clean LLM call interface: `(id: string, eventsOrMessages: ServerEvent[] | TadpoleModelMessage[]) => Promise<unknown>`
- Basic mock infrastructure exists in `tests/utils/chronicler-test-harness.ts`

__What Needs Enhancement:__

- No schemas for AI SDK function parameters (temperature, maxTokens, etc.)
- No typed output schemas for generateText, streamText, generateObject responses
- Current mocks are too simplistic - just return static strings
- No realistic timing, streaming simulation, or schema-aware object generation

## Detailed Implementation Plan

### Phase 1: Core LLM Function Parameter Schemas (Main Code)

__Location:__ `server/types/llm-function-types.ts` (new file)

__Intent:__ Create type-safe, validated parameter interfaces for the three main AI SDK functions we'll mock, ensuring they remain compatible subsets of the actual AI SDK.

__Core Parameter Schema:__

```typescript
// Common parameters across all AI SDK functions
const tadpoleLlmCommonParamsSchema = z.object({
  // Model calling parameters - keep it simple as requested
  maxOutputTokens: z.number().min(1).max(200000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  seed: z.number().int().optional(),

  // Control parameters
  abortSignal: z.instanceof(AbortSignal).optional(),

  // Core content parameters
  system: z.string().optional(),
  prompt: z.string().optional(),
  messages: z.array(tadpoleModelMessageSchema).optional(),
}).strict();
```

__Function-Specific Schemas:__

- `TadpoleGenerateTextParams` - extends common + tool-specific fields
- `TadpoleStreamTextParams` - extends common + streaming-specific fields
- `TadpoleGenerateObjectParams` - extends common + schema/output fields

__Build-time Validation:__ Use the same pattern as input-ai-types.ts to ensure our parameter types remain compatible subsets of the actual AI SDK function signatures.

### Phase 2: LLM Function Response Schemas (Main Code)

__Location:__ Same file (`server/types/llm-function-types.ts`)

__Intent:__ Define return type schemas that match what the AI SDK functions actually return, enabling type-safe mocking.

__Response Schemas:__

```typescript
// Token usage (common across all responses)
const tadpoleLlmUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
}).strict();

// Response metadata (common)
const tadpoleLlmResponseMetadataSchema = z.object({
  id: z.string(),
  modelId: z.string(),
  timestamp: z.date(),
}).strict();

// GenerateText response
const tadpoleGenerateTextResponseSchema = z.object({
  text: z.string(),
  finishReason: z.enum(['stop', 'length', 'content-filter', 'error', 'other', 'unknown']),
  usage: tadpoleLlmUsageSchema,
  response: tadpoleLlmResponseMetadataSchema.optional(),
}).strict();

// StreamText response (simplified for key streaming properties)
const tadpoleStreamTextResponseSchema = z.object({
  textStream: z.any(), // AsyncIterable<string>
  text: z.promise(z.string()),
  usage: z.promise(tadpoleLlmUsageSchema),
  finishReason: z.promise(z.enum(['stop', 'length', 'content-filter', 'error', 'other', 'unknown'])),
}).strict();

// GenerateObject response (generic for any schema)
const tadpoleGenerateObjectResponseSchema = z.object({
  object: z.unknown(), // Will be typed based on provided schema
  finishReason: z.enum(['stop', 'length', 'content-filter', 'error', 'other', 'unknown']),
  usage: tadpoleLlmUsageSchema,
  response: tadpoleLlmResponseMetadataSchema.optional(),
}).strict();
```

### Phase 3: Mock Function Interface (Main Code)

__Location:__ Same file (`server/types/llm-function-types.ts`)

__Intent:__ Define the interface that mocks must implement, providing a clean contract between the main code and test mocks.

```typescript
// Generic LLM function interface
export interface TadpoleLlmFunction {
  generateText(params: TadpoleGenerateTextParams): Promise<TadpoleGenerateTextResponse>;
  streamText(params: TadpoleStreamTextParams): Promise<TadpoleStreamTextResponse>;
  generateObject<T>(params: TadpoleGenerateObjectParams & { schema: z.ZodSchema<T> }): Promise<TadpoleGenerateObjectResponse<T>>;
}

// Simple adapter for chroniclers (maintains existing interface)
export type ChroniclerLlmCall = (
  id: string,
  eventsOrMessages: ServerEvent[] | TadpoleModelMessage[]
) => Promise<unknown>;
```

### Phase 4: Mock Implementation (Test Code)

__Location:__ `tests/utils/llm-mocks.ts` (new file)

__Intent:__ Provide realistic, configurable mocks that simulate actual LLM behavior for testing, with proper response timing, streaming, and schema compliance.

__Key Features:__

1. __Deterministic Responses:__ Echo back prompts with structured format for predictability
2. __Realistic Timing:__ Response time proportional to input length (simulate API latency)
3. __Streaming Simulation:__ Proper async iteration with realistic chunk delays
4. __Schema-Aware Object Generation:__ Parse provided schemas and generate valid mock objects
5. __Token Usage Calculation:__ Approximate token counts based on text length
6. __Error Simulation:__ Configurable error injection for testing error handling

__Mock Implementation Structure:__

```typescript
export class MockLlmFunction implements TadpoleLlmFunction {
  constructor(private config: MockLlmConfig = {}) {}

  async generateText(params: TadpoleGenerateTextParams): Promise<TadpoleGenerateTextResponse> {
    // Simulate API delay proportional to input size
    await this.simulateDelay(params);

    // Generate deterministic response
    const responseText = this.generateDeterministicText(params);
    const usage = this.calculateTokenUsage(params, responseText);

    return {
      text: responseText,
      finishReason: 'stop',
      usage,
      response: {
        id: `mock-${Date.now()}`,
        modelId: 'mock-model',
        timestamp: new Date()
      }
    };
  }

  async streamText(params: TadpoleStreamTextParams): Promise<TadpoleStreamTextResponse> {
    // Create async iterable that yields text chunks with delays
    const textStream = this.createMockTextStream(params);

    return {
      textStream,
      text: this.consumeStreamToText(textStream),
      usage: this.calculateUsagePromise(params),
      finishReason: Promise.resolve('stop' as const)
    };
  }

  async generateObject<T>(params: TadpoleGenerateObjectParams & { schema: z.ZodSchema<T> }): Promise<TadpoleGenerateObjectResponse<T>> {
    await this.simulateDelay(params);

    // Generate mock object that conforms to schema
    const mockObject = this.generateSchemaCompliantObject(params.schema);
    const usage = this.calculateTokenUsage(params, JSON.stringify(mockObject));

    return {
      object: mockObject,
      finishReason: 'stop',
      usage,
      response: {
        id: `mock-${Date.now()}`,
        modelId: 'mock-model',
        timestamp: new Date()
      }
    };
  }
}
```

### Phase 5: Chronicler Mock Adapter (Test Code)

__Location:__ Same file (`tests/utils/llm-mocks.ts`)

__Intent:__ Bridge between the new typed mock functions and the existing chronicler interface.

```typescript
export function createChroniclerMockLlm(mockLlm: MockLlmFunction): ChroniclerLlmCall {
  return async (id: string, eventsOrMessages: ServerEvent[] | TadpoleModelMessage[]) => {
    // Determine if this is conversational (messages) or event-based call
    if (Array.isArray(eventsOrMessages) && eventsOrMessages.length > 0 && 'role' in eventsOrMessages[0]) {
      // Conversational mode - convert to generateText call
      const messages = eventsOrMessages as TadpoleModelMessage[];
      const result = await mockLlm.generateText({ messages });
      return result.text;
    } else {
      // Event-based mode - convert events to prompt
      const events = eventsOrMessages as ServerEvent[];
      const prompt = `Analyze these ${events.length} events: ${events.map(e => e.type).join(', ')}`;
      const result = await mockLlm.generateText({ prompt });
      return result.text;
    }
  };
}
```

### Phase 6: Test Infrastructure Integration

__Location:__ `tests/utils/chronicler-test-harness.ts` (modify existing)

__Intent:__ Replace the simple MockLlmCall with the new comprehensive mock system while maintaining backwards compatibility.

__Changes:__

- Replace `MockLlmCall` class with new `createChroniclerMockLlm` adapter
- Add configuration options for different mock behaviors
- Maintain the same assertion interface for existing tests

### Phase 7: Advanced Mock Features

__Location:__ `tests/utils/llm-mocks.ts` (extend existing)

__Intent:__ Add sophisticated mock behaviors for comprehensive testing scenarios.

__Features:__

1. __Response Time Simulation:__

   ```typescript
   // Base delay: 100ms + 2ms per input token
   const delay = 100 + (estimatedInputTokens * 2);
   ```

2. __Streaming Chunk Generation:__

   ```typescript
   // Split text into realistic chunks (5-15 chars) with 10-50ms delays
   async function* generateTextChunks(text: string) {
     for (const chunk of splitIntoChunks(text)) {
       yield chunk;
       await delay(randomBetween(10, 50));
     }
   }
   ```

3. __Schema-Aware Object Generation:__

   ```typescript
   function generateSchemaCompliantObject<T>(schema: z.ZodSchema<T>): T {
     // Analyze schema structure and generate realistic mock data
     // Handle nested objects, arrays, unions, etc.
   }
   ```

4. __Error Injection:__

   ```typescript
   // Configurable error simulation
   if (config.shouldFailNext || Math.random() < config.failureRate) {
     throw new Error('Simulated LLM API error');
   }
   ```

## File Organization

```javascript
server/types/
├── input-ai-types.ts (existing - no changes)
└── llm-function-types.ts (new - schemas & interfaces)

tests/utils/
├── chronicler-test-harness.ts (modify - integrate new mocks)
└── llm-mocks.ts (new - mock implementations)
```

## Priority Implementation Order

1. __High Priority:__ Core parameter and response schemas with build-time validation
2. __High Priority:__ Basic mock implementations for generateText (most commonly used)
3. __Medium Priority:__ Chronicler adapter and test harness integration
4. __Medium Priority:__ StreamText mock with proper async iteration
5. __Lower Priority:__ GenerateObject mock with schema parsing
6. __Lower Priority:__ Advanced features (error injection, sophisticated timing)

## Benefits of This Approach

1. __Type Safety:__ Full TypeScript support with Zod validation
2. __AI SDK Compatibility:__ Build-time checks ensure we stay compatible with upstream changes
3. __Realistic Testing:__ Mocks behave like real LLM calls with proper timing and responses
4. __Backwards Compatibility:__ Existing chronicler tests continue to work
5. __Extensibility:__ Easy to add new mock behaviors and configurations
6. __Performance:__ No actual API calls in tests, but realistic simulation for timing-dependent code

## Questions for Clarification

1. Should the mock system support tool calling simulation (since AI SDK functions support tools)?
2. Do you want the mocks to be configurable per-test (different response behaviors) or globally configured?
3. Should we implement cost calculation mocking (since your system tracks costs)?
4. Are there any specific test scenarios you want the mocks to handle especially well?

This plan maintains your excellent existing patterns while adding comprehensive LLM mocking that will make testing much more robust and realistic.
