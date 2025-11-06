# Plan: Implementing LLM Parameters for Chroniclers

## Executive Summary

After investigating the current implementation, we've identified that the Chronicler system is not passing critical LLM parameters (temperature, maxOutputTokens, maxRetries) to the LLM calls. These parameters are defined in `TadpoleGenerateTextOptions` but are not being set by the Chronicler, meaning all chroniclers use model defaults.

This plan outlines a comprehensive solution to:
1. Add LLM parameter configuration to chroniclers
2. Establish sensible system-wide defaults
3. Ensure parameters are properly passed through the call chain
4. Update tests to verify the implementation

## Current State Analysis

### What's Missing

Looking at `server/chroniclers/chronicler.ts` lines 590-616, the current LLM call options only include:
```typescript
const options: TadpoleGenerateTextOptions = {
  model: this.model || ({} as LanguageModel),
  messages,
  system: renderedSystemPrompt, // or undefined for conversational
};
```

**Missing parameters from `TadpoleLlmCallParams`:**
- `temperature` - Controls response randomness (0-2)
- `maxOutputTokens` - Limits response length
- `maxRetries` - Number of retry attempts on failure
- `abortSignal` - For cancellation support

### Impact
- All chroniclers currently use model defaults (likely temperature=1, varied output limits)
- No retry logic for transient failures
- Cannot control response determinism or length per chronicler
- Test mocks don't validate these parameters are being passed

## Proposed Solution

### Design Principles
1. **Backwards Compatibility**: Existing chroniclers without `llmParams` should continue to work
2. **Sensible Defaults**: Provide good defaults that work for most chroniclers
3. **Override Capability**: Allow per-chronicler customization
4. **Type Safety**: Leverage TypeScript and Zod for validation

### Recommended Defaults
```typescript
{
  temperature: 0,        // Deterministic responses for consistency
  maxOutputTokens: 8192, // Reasonable for most chronicler use cases
  maxRetries: 2         // Retry transient failures twice
}
```

## Implementation Plan

### Phase 1: Create Default Parameters

**File:** `server/chroniclers/chronicler-defaults.ts` (NEW)

```typescript
/**
 * Default LLM parameters for chroniclers.
 * These provide sensible defaults that can be overridden per-chronicler.
 */
export const DEFAULT_CHRONICLER_LLM_PARAMS = {
  temperature: 0,        // Deterministic by default for consistent chronicler output
  maxOutputTokens: 8192, // Reasonable default for most chronicler responses
  maxRetries: 2,        // Retry failed calls twice before giving up
} as const;

/**
 * Merges chronicler-specific LLM params with defaults.
 * Chronicler params take precedence over defaults.
 */
export function mergeWithDefaults(
  chroniclerParams?: Partial<{
    temperature?: number;
    maxOutputTokens?: number;
    maxRetries?: number;
  }>
) {
  return {
    ...DEFAULT_CHRONICLER_LLM_PARAMS,
    ...chroniclerParams,
  };
}
```

### Phase 2: Update Configuration Schema

**File:** `server/config-validation/chronicler.schema.ts`

Add the following schema after line 279 (before the main chronicler config schema):

```typescript
// --- LLM Parameters Schema ---
const llmParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional()
    .describe("Temperature for response generation (0=deterministic, 2=creative)"),
  maxOutputTokens: z.number().int().positive().max(100000).optional()
    .describe("Maximum tokens in the response"),
  maxRetries: z.number().int().min(0).max(5).optional()
    .describe("Number of retry attempts for failed LLM calls"),
}).optional();
```

Update the main `chroniclerConfigSchema` to include:

```typescript
export const chroniclerConfigSchema = z
  .object({
    // ... existing fields ...

    // NEW: Optional LLM parameters
    llmParams: llmParamsSchema,

    // ... rest of existing fields ...
  })
  // ... existing refinements ...
```

Export the new type:
```typescript
export type ChroniclerLlmParams = z.infer<typeof llmParamsSchema>;
```

### Phase 3: Update Chronicler Class

**File:** `server/chroniclers/chronicler.ts`

1. **Add imports** (at the top):
```typescript
import { DEFAULT_CHRONICLER_LLM_PARAMS, mergeWithDefaults } from "./chronicler-defaults.js";
```

2. **Add property** (around line 30):
```typescript
export class Chronicler {
  // ... existing properties ...
  private readonly llmParams: {
    temperature: number;
    maxOutputTokens: number;
    maxRetries: number;
  };
```

3. **Initialize in constructor** (around line 50):
```typescript
constructor(
  // ... existing params ...
) {
  // ... existing initialization ...

  // Merge config params with defaults
  this.llmParams = mergeWithDefaults(this.config.llmParams);

  // ... rest of constructor ...
}
```

4. **Update executeChroniclerCall** (lines 590-616):

For conversational mode (around line 596):
```typescript
const options: TadpoleGenerateTextOptions = {
  model: this.model || ({} as LanguageModel),
  messages,
  // Add LLM parameters
  temperature: this.llmParams.temperature,
  maxOutputTokens: this.llmParams.maxOutputTokens,
  maxRetries: this.llmParams.maxRetries,
};
```

For non-conversational mode (around line 613):
```typescript
const options: TadpoleGenerateTextOptions = {
  model: this.model || ({} as LanguageModel),
  messages: [{ role: "user", content: userMessage }],
  system: renderedSystemPrompt,
  // Add LLM parameters
  temperature: this.llmParams.temperature,
  maxOutputTokens: this.llmParams.maxOutputTokens,
  maxRetries: this.llmParams.maxRetries,
};
```

### Phase 4: Update Mock Implementation

**File:** `tests/utils/mock-llm.ts`

Update the mock to respect these parameters:

1. **Update MockLlmConfig**:
```typescript
export type MockLlmConfig = {
  forceError?: Error;
  // Add parameter overrides for testing
  respectMaxOutputTokens?: boolean; // Default: true
};
```

2. **Update mockGenerateText** to respect maxOutputTokens:
```typescript
async function mockGenerateText(
  options: TadpoleGenerateTextOptions,
): Promise<TadpoleGenerateTextResult> {
  // ... existing error handling ...

  const lastMessage = options.messages?.slice(-1)[0]?.content?.toString() ?? "";
  const prompt = lastMessage;

  // Respect temperature for response variation (simplified for mock)
  const tempModifier = options.temperature ?? 1;
  const baseResponse = `Mock response for: "${prompt}"`;
  const responseText = tempModifier === 0
    ? baseResponse
    : `${baseResponse} (temp=${tempModifier})`;

  // Respect maxOutputTokens if specified
  let finalResponse = responseText;
  if (options.maxOutputTokens && config.respectMaxOutputTokens !== false) {
    // Simple truncation for mock (1 token ≈ 4 chars)
    const maxChars = options.maxOutputTokens * 4;
    if (finalResponse.length > maxChars) {
      finalResponse = finalResponse.substring(0, maxChars - 3) + "...";
    }
  }

  await new Promise((resolve) => setTimeout(resolve, calculateDelay(prompt)));

  return {
    text: finalResponse,
    finishReason: finalResponse.endsWith("...") ? "length" : "stop",
    usage: {
      inputTokens: prompt.length,
      outputTokens: finalResponse.length,
    },
  };
}
```

### Phase 5: Add Tests

**File:** `tests/unit/chronicler-llm-params.test.ts` (NEW)

```typescript
import { describe, expect, it } from "bun:test";
import { Chronicler } from "../../server/chroniclers/chronicler.js";
import { DEFAULT_CHRONICLER_LLM_PARAMS } from "../../server/chroniclers/chronicler-defaults.js";
import { createMockLlm } from "../utils/mock-llm.js";
import type { TadpoleGenerateTextOptions } from "../../server/types/llm-call-types.js";

describe("Chronicler LLM Parameters", () => {
  const mockLlm = createMockLlm();
  let capturedOptions: TadpoleGenerateTextOptions[] = [];

  const mockLlmCall = async (id: string, options: TadpoleGenerateTextOptions) => {
    capturedOptions.push(options);
    const result = await mockLlm.generateText(options);
    return result;
  };

  beforeEach(() => {
    capturedOptions = [];
  });

  it("should use default LLM parameters when not specified in config", async () => {
    const config = {
      id: "test-chronicler",
      name: "Test",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test prompt",
      // No llmParams specified
    };

    const chronicler = new Chronicler(
      config,
      PhaseId("test"),
      mockLlmCall,
      logger
    );

    await chronicler.handleEvent(testEvent);

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].temperature).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.temperature);
    expect(capturedOptions[0].maxOutputTokens).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.maxOutputTokens);
    expect(capturedOptions[0].maxRetries).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.maxRetries);
  });

  it("should override defaults with chronicler-specific parameters", async () => {
    const config = {
      id: "creative-chronicler",
      name: "Creative",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test prompt",
      llmParams: {
        temperature: 1.5,
        maxOutputTokens: 2000,
        maxRetries: 0,
      },
    };

    const chronicler = new Chronicler(
      config,
      PhaseId("test"),
      mockLlmCall,
      logger
    );

    await chronicler.handleEvent(testEvent);

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].temperature).toBe(1.5);
    expect(capturedOptions[0].maxOutputTokens).toBe(2000);
    expect(capturedOptions[0].maxRetries).toBe(0);
  });

  it("should partially override defaults", async () => {
    const config = {
      id: "partial-override",
      name: "Partial",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test prompt",
      llmParams: {
        temperature: 0.5, // Only override temperature
      },
    };

    const chronicler = new Chronicler(
      config,
      PhaseId("test"),
      mockLlmCall,
      logger
    );

    await chronicler.handleEvent(testEvent);

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].temperature).toBe(0.5);
    expect(capturedOptions[0].maxOutputTokens).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.maxOutputTokens);
    expect(capturedOptions[0].maxRetries).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.maxRetries);
  });
});
```

### Phase 6: Update Example Configurations

**File:** `tests/config/chronicler-triggers/narrator.json`

Add example llmParams:
```json
{
  "id": "narrator",
  "name": "Development Narrator",
  "trigger": {
    "type": "event",
    "on": ["assistant.action", "tool.result", "file.updated"]
  },
  "execution": {
    "strategy": "debounce",
    "milliseconds": 2500
  },
  "llmParams": {
    "temperature": 0.3,
    "maxOutputTokens": 4096
  },
  "systemPromptText": "You are a helpful development narrator...",
  "userPromptText": "Summarize these events: <%= JSON.stringify(it.events.map(e => e.type)) %>"
}
```

### Phase 7: Update Documentation

**File:** `documentation/chronicler-system.md`

Add a new section after "Prompt Configuration":

```markdown
## LLM Parameters Configuration

Chroniclers can optionally specify LLM parameters to control response generation:

### Available Parameters

- `temperature` (0-2): Controls response randomness. 0 = deterministic, 2 = creative. Default: 0
- `maxOutputTokens` (1-100000): Maximum tokens in the response. Default: 8192
- `maxRetries` (0-5): Number of retry attempts for failed calls. Default: 2

### Default Values

If not specified, chroniclers use these defaults optimized for consistent, reliable output:
- Temperature: 0 (deterministic)
- Max Output Tokens: 8192
- Max Retries: 2

### Configuration Example

```json
{
  "id": "creative-narrator",
  "name": "Creative Development Narrator",
  "llmParams": {
    "temperature": 1.2,        // More creative responses
    "maxOutputTokens": 10000,  // Longer responses allowed
    "maxRetries": 3            // More retry attempts
  },
  // ... rest of config
}
```

### Use Cases

- **Deterministic Chroniclers** (default): Use temperature=0 for consistent outputs
- **Creative Chroniclers**: Use temperature=0.7-1.5 for varied, creative responses
- **Brief Chroniclers**: Set low maxOutputTokens (e.g., 500) for concise summaries
- **Critical Chroniclers**: Set maxRetries=0 to fail fast on errors
```

## Testing Strategy

### Unit Tests
1. ✅ Verify defaults are applied when llmParams not specified
2. ✅ Verify config params override defaults correctly
3. ✅ Verify partial overrides work (some params from config, others from defaults)
4. ✅ Verify params are passed to LLM call for both conversational and non-conversational modes

### Integration Tests
1. ✅ Verify mock respects maxOutputTokens by truncating responses
2. ✅ Verify different temperature values produce different mock responses
3. ✅ Verify retry logic works with maxRetries parameter


## Migration & Rollout

### Backwards Compatibility
- ✅ Existing chroniclers without llmParams will use defaults
- ✅ No breaking changes to existing configurations
- ✅ Tests continue to pass without modification

### Rollout Steps
1. Implement defaults file
2. Update schema (non-breaking addition)
3. Update Chronicler class
4. Run existing tests to verify no regression
5. Add new tests for LLM params
6. Update documentation
7. Update example configurations

## Risks & Mitigations

### Risk 1: Unexpected Behavior Change
**Risk**: Existing chroniclers might behave differently with temperature=0 default
**Mitigation**: The default of temperature=0 makes responses more predictable, which is generally desirable for chroniclers

### Risk 2: Output Truncation
**Risk**: maxOutputTokens=8192 might truncate some existing chronicler responses
**Mitigation**: 8192 tokens is quite generous (~32KB of text). Monitor for truncation in testing

### Risk 3: Test Complexity
**Risk**: More parameters to test increases test complexity
**Mitigation**: Focus tests on the most important parameters (temperature, maxOutputTokens)
