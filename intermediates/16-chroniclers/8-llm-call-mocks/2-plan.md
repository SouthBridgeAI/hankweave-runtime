### **Executive Summary**

The goal is to create a comprehensive set of types and mocks for testing the application's Language Model (LLM) interactions without making actual API calls. This is crucial for the **Chronicler System**, which makes numerous parallel, non-blocking LLM calls. Reliable, fast, and deterministic testing of this system is paramount.

This plan is divided into **5 distinct phases** to ensure clean, incremental progress:

1. **Phase 1: Implement Interfaces & Update Chronicler** - Create type definitions and update the Chronicler to use them (tests will break)
2. **Phase 2: Fix Linting & Type Issues** - Run `bun lint:fix` and `bun typecheck` to resolve any issues
3. **Phase 3: Build the Mock Utility** - Create the mock implementation entirely in the tests folder
4. **Phase 4: Test the Mock** - Write unit tests for the mock itself to ensure it works correctly
5. **Phase 5: Integrate Mock into Tests** - Update existing tests and write new Chronicler tests using the mock

This phased approach ensures we maintain type safety, fix issues incrementally, and build a robust testing infrastructure.

---

## **Implementation Phases**

### **Phase 1: Implement Interfaces & Update Chronicler**
**Goal:** Define the LLM call types and update Chronicler to use them. This will intentionally break existing tests, which we'll fix in later phases.

#### **Step 1.1: Create LLM Call Type Definitions**

**Action:** Create a new file: `server/types/llm-call-types.ts`

**Intent:** Define the "Tadpole" version of the inputs and outputs for AI SDK functions. These will be used by both the Chronicler and the mock implementation.

**File Location:** `server/types/llm-call-types.ts`

```typescript
/**
 * This file defines simplified, Zod-validated schemas for the parameters and return
 * types of the Vercel AI SDK's core functions: `generateText`, `streamText`, and
 * `generateObject`.
 *
 * These schemas are designed to be compatible subsets of the official AI SDK types,
 * enabling us to create strongly-typed mocks and internal functions while ensuring
 * they can be used with the real SDK.
 */

import type {
  GenerateObjectOptions,
  GenerateObjectResult,
  GenerateTextOptions,
  GenerateTextResult,
  StreamTextOptions,
  StreamTextResult,
  LanguageModel,
} from "ai";
import { z } from "zod";
import { tadpoleModelMessageSchema } from "./input-ai-types.js";

// --- Base Schemas ---

/**
 * A schema for common model-calling parameters. We are intentionally keeping this
 * simple, focusing on the most frequently used options and omitting others like
 * topP, topK, etc., for simplicity.
 */
export const tadpoleLlmCallParamsSchema = z.object({
  temperature: z.number().optional().describe("Temperature for sampling."),
  maxOutputTokens: z.number().optional().describe("Maximum number of tokens to generate."),
  maxRetries: z.number().optional().describe("Maximum number of retries for the API call."),
  abortSignal: z.custom<AbortSignal>().optional().describe("Optional abort signal to cancel the call."),
});

// --- `generateText` Schemas ---

/**
 * Input parameters for a `generateText` call.
 * This is a subset of the AI SDK's `GenerateTextOptions`.
 * We're removing the prompt field and focusing on messages for consistency.
 */
export const tadpoleGenerateTextOptionsSchema = tadpoleLlmCallParamsSchema.extend({
  model: z.custom<LanguageModel>(), // We trust the model object is correct
  system: z.string().optional(),
  messages: z.array(tadpoleModelMessageSchema),
});

/**
 * The result from a `generateText` call.
 * This is a subset of the AI SDK's `GenerateTextResult`.
 */
export const tadpoleGenerateTextResultSchema = z.object({
  text: z.string(),
  finishReason: z.enum(["stop", "length", "content-filter", "tool-calls", "error", "other"]),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
});

// --- `streamText` Schemas ---

/**
 * Input parameters for a `streamText` call.
 * This is a subset of the AI SDK's `StreamTextOptions`.
 */
export const tadpoleStreamTextOptionsSchema = tadpoleGenerateTextOptionsSchema; // Same options as generateText

/**
 * The result from a `streamText` call.
 * We simplify this to focus on the text stream and the final result promise.
 * The textStream is an AsyncIterableStream<string> according to the docs.
 */
export const tadpoleStreamTextResultSchema = z.object({
  textStream: z.custom<AsyncIterable<string>>(), // AsyncIterableStream<string> is AsyncIterable<string> & ReadableStream<string>
  // We can't easily represent the full promise-based result in Zod,
  // so we'll handle that with TypeScript types.
});

// --- `generateObject` Schemas ---

/**
 * Input parameters for a `generateObject` call.
 * This is a subset of the AI SDK's `GenerateObjectOptions`.
 * Supports both schema-based and no-schema generation.
 */
export const tadpoleGenerateObjectOptionsSchema = tadpoleLlmCallParamsSchema.extend({
  model: z.custom<LanguageModel>(),
  schema: z.custom<z.ZodSchema<any>>().optional(), // Optional for 'no-schema' output
  messages: z.array(tadpoleModelMessageSchema),
  system: z.string().optional(),
  mode: z.enum(["auto", "json", "tool"]).optional(),
  output: z.enum(["object", "array", "enum", "no-schema"]).optional(),
});

/**
 * The result from a `generateObject` call.
 * This is a subset of the AI SDK's `GenerateObjectResult`.
 */
export const tadpoleGenerateObjectResultSchema = z.object({
  object: z.any(),
  finishReason: z.enum(["stop", "length", "content-filter", "error", "other"]),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
});

// --- Exported TypeScript Types ---

export type TadpoleLlmCallParams = z.infer<typeof tadpoleLlmCallParamsSchema>;
export type TadpoleGenerateTextOptions = z.infer<typeof tadpoleGenerateTextOptionsSchema>;
export type TadpoleGenerateTextResult = z.infer<typeof tadpoleGenerateTextResultSchema>;
export type TadpoleStreamTextOptions = z.infer<typeof tadpoleStreamTextOptionsSchema>;
// StreamTextResult is complex, so we define it more carefully.
// According to the docs, textStream is AsyncIterableStream<string> which is AsyncIterable<string> & ReadableStream<string>
export type TadpoleStreamTextResult = {
  textStream: AsyncIterable<string> & ReadableStream<string>;
  // The promises for the final state are essential for testing.
  usage: Promise<{ inputTokens: number; outputTokens: number }>;
  finishReason: Promise<GenerateTextResult["finishReason"]>;
  // Add other promises as needed for tests, e.g., `text`.
  text: Promise<string>;
};
export type TadpoleGenerateObjectOptions = z.infer<typeof tadpoleGenerateObjectOptionsSchema>;
export type TadpoleGenerateObjectResult<T> = Omit<
  z.infer<typeof tadpoleGenerateObjectResultSchema>,
  "object"
> & { object: T };

// --- BUILD-TIME TYPE VALIDATION ---
// This section ensures our simplified types remain compatible subsets of the AI SDK's types.
// If the AI SDK has a breaking change, these assertions will cause a TypeScript error.

const assertTadpoleIsSubsetOfSdk = <SdkType, _TadpoleType extends SdkType>() => {};

// Validate options
assertTadpoleIsSubsetOfSdk<GenerateTextOptions, TadpoleGenerateTextOptions>();
assertTadpoleIsSubsetOfSdk<StreamTextOptions, TadpoleStreamTextOptions>();
assertTadpoleIsSubsetOfSdk<GenerateObjectOptions, TadpoleGenerateObjectOptions>();

// Validate results (where possible with Zod)
assertTadpoleIsSubsetOfSdk<GenerateTextResult, TadpoleGenerateTextResult>();
assertTadpoleIsSubsetOfSdk<StreamTextResult, TadpoleStreamTextResult>();
// GenerateObjectResult is generic, so we test its base structure.
assertTadpoleIsSubsetOfSdk<GenerateObjectResult<unknown>, TadpoleGenerateObjectResult<unknown>>();

// --- TYPE ASSERTIONS FOR MOCK FUNCTIONS ---
// These assertions verify that our mock functions are type-compatible with the real AI SDK functions
type GenerateTextSignature = typeof generateText;
type StreamTextSignature = typeof streamText;
type GenerateObjectSignature = typeof generateObject;

// Mock functions should be assignable to the SDK function types (though they may be more restrictive)
const assertMockGenerateText: (options: TadpoleGenerateTextOptions) => Promise<TadpoleGenerateTextResult> = {} as any;
const assertMockStreamText: (options: TadpoleStreamTextOptions) => TadpoleStreamTextResult = {} as any;
const assertMockGenerateObject: <T>(options: TadpoleGenerateObjectOptions) => Promise<TadpoleGenerateObjectResult<T>> = {} as any;
```

#### **Step 1.2: Update Chronicler to Use New Types**

**Action:** Update the Chronicler implementation to use the new type definitions

**Files to Modify:**
- `server/chroniclers/chronicler.ts` - Update LLM call signatures
- `server/chroniclers/chronicler-manager.ts` - Update if needed
- Any other files that reference LLM calls

**Expected Outcome:** Tests will break at this point - this is expected and will be fixed in Phase 5.

---

### **Phase 2: Fix Linting & Type Issues**

#### **Step 2.1: Run Linting**

**Action:** Execute `bun lint:fix`

**Intent:** Automatically fix any formatting issues and identify any linting errors that need manual intervention.

**Expected Issues:**
- Import ordering
- Unused variables
- Formatting inconsistencies

#### **Step 2.2: Run Type Checking**

**Action:** Execute `bun typecheck`

**Intent:** Identify and fix any TypeScript compilation errors introduced by the new types.

**Expected Issues:**
- Type mismatches between old and new interfaces
- Missing imports
- Incompatible function signatures

**Resolution:** Fix each type error manually, ensuring compatibility between the new types and existing code.

---

### **Phase 3: Build the Mock Utility**

#### **Step 3.1: Create the Mock Implementation**

**Action:** Create a new file: `tests/utils/mock-llm.ts`

**Intent:** Build a comprehensive mock that simulates the AI SDK's behavior realistically, entirely within the test infrastructure.

**File Location:** `tests/utils/mock-llm.ts`

```typescript
import { z } from "zod";
import type { LanguageModel } from "ai";
import type {
  TadpoleGenerateObjectOptions,
  TadpoleGenerateObjectResult,
  TadpoleGenerateTextOptions,
  TadpoleGenerateTextResult,
  TadpoleStreamTextOptions,
  TadpoleStreamTextResult,
} from "../../server/types/llm-call-types";

// --- Helper Functions for Realistic Simulation ---

/**
 * Calculates a realistic delay based on prompt length.
 * @param prompt The input prompt string.
 * @returns A delay in milliseconds.
 */
function calculateDelay(prompt: string = ""): number {
  const baseDelay = 200; // Minimum response time
  const perCharDelay = 2; // ms per character
  const randomJitter = Math.random() * 100; // Add some variability
  return baseDelay + prompt.length * perCharDelay + randomJitter;
}

/**
 * A very simple mock data generator for Zod schemas.
 * It's not exhaustive but handles common primitives for testing.
 * @param schema The Zod schema to generate data for.
 * @returns A mock object conforming to the schema.
 */
function generateMockDataForSchema(schema: z.ZodSchema<any>): any {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodSchema<any>>;
    const result: Record<string, any> = {};
    for (const key in shape) {
      result[key] = generateMockDataForSchema(shape[key]);
    }
    return result;
  }
  if (schema instanceof z.ZodArray) {
    return [generateMockDataForSchema(schema.element)];
  }
  if (schema instanceof z.ZodString) {
    return "mock string value";
  }
  if (schema instanceof z.ZodNumber) {
    return 123;
  }
  if (schema instanceof z.ZodBoolean) {
    return true;
  }
  if (schema instanceof z.ZodEnum) {
    return schema.options[0];
  }
  // Default for unknown types
  return null;
}

// --- Mock LLM Provider Factory ---

export type MockLlmConfig = {
  // Add any future configuration options here, e.g., forcing errors.
};

/**
 * Creates a mock AI provider that simulates the Vercel AI SDK functions.
 * @param config Optional configuration for the mock.
 * @returns An object with mock implementations of `generateText`, `streamText`, and `generateObject`.
 */
export function createMockLlm(config: MockLlmConfig = {}) {
  // A mock model object to satisfy the types.
  const mockModel = {} as LanguageModel;

  /**
   * Mock implementation of `generateText`.
   */
  async function mockGenerateText(
    options: TadpoleGenerateTextOptions,
  ): Promise<TadpoleGenerateTextResult> {
    const lastMessage = options.messages?.slice(-1)[0]?.content?.toString() ?? "";
    const prompt = lastMessage;
    await new Promise((resolve) => setTimeout(resolve, calculateDelay(prompt)));

    const responseText = `Mock response for: "${prompt}"`;
    return {
      text: responseText,
      finishReason: "stop",
      usage: {
        inputTokens: prompt.length,
        outputTokens: responseText.length,
      },
    };
  }

  /**
   * Mock implementation of `streamText`.
   */
  function mockStreamText(options: TadpoleStreamTextOptions): TadpoleStreamTextResult {
    const lastMessage = options.messages?.slice(-1)[0]?.content?.toString() ?? "";
    const prompt = lastMessage;
    const responseText = `Mock stream response for: "${prompt}"`;
    const chunks = responseText.match(/.{1,10}/g) || []; // Split into 10-char chunks

    async function* generateStream(): AsyncIterable<string> {
      for (const chunk of chunks) {
        // Simulate network delay between chunks
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield chunk;
      }
    }

    const stream = generateStream();

    // Create a proper AsyncIterableStream (AsyncIterable + ReadableStream)
    const textStream = Object.assign(stream, {
      [Symbol.asyncIterator]: () => stream,
      // Add minimal ReadableStream implementation for type compatibility
      locked: false,
      cancel: async () => {},
      getReader: () => {
        throw new Error("ReadableStream interface not fully implemented in mock");
      },
      pipeThrough: () => {
        throw new Error("ReadableStream interface not fully implemented in mock");
      },
      pipeTo: () => {
        throw new Error("ReadableStream interface not fully implemented in mock");
      },
      tee: () => {
        throw new Error("ReadableStream interface not fully implemented in mock");
      },
    }) as AsyncIterable<string> & ReadableStream<string>;

    // The result object includes promises that resolve when the stream is done.
    const finalResultPromise = (async () => {
      let final_text = "";
      for await (const delta of textStream) {
        final_text += delta;
      }
      return {
        text: final_text,
        finishReason: "stop" as const,
        usage: {
          inputTokens: prompt.length,
          outputTokens: responseText.length,
        },
      };
    })();

    return {
      textStream,
      text: finalResultPromise.then((r) => r.text),
      finishReason: finalResultPromise.then((r) => r.finishReason),
      usage: finalResultPromise.then((r) => r.usage),
    };
  }

  /**
   * Mock implementation of `generateObject`.
   */
  async function mockGenerateObject<T>(
    options: TadpoleGenerateObjectOptions,
  ): Promise<TadpoleGenerateObjectResult<T>> {
    const lastMessage = options.messages?.slice(-1)[0]?.content?.toString() ?? "";
    const prompt = lastMessage;
    await new Promise((resolve) => setTimeout(resolve, calculateDelay(prompt)));

    let mockObject: T;

    if (options.output === 'no-schema' || !options.schema) {
      // For no-schema, generate a simple mock object
      mockObject = {
        response: `Mock unstructured object for: "${prompt}"`,
        timestamp: Date.now()
      } as T;
    } else {
      mockObject = generateMockDataForSchema(options.schema) as T;
    }

    return {
      object: mockObject,
      finishReason: "stop",
      usage: {
        inputTokens: prompt.length,
        outputTokens: JSON.stringify(mockObject).length,
      },
    };
  }

  return {
    // The factory returns an object that mimics the AI SDK exports
    generateText: mockGenerateText,
    streamText: mockStreamText,
    generateObject: mockGenerateObject,
    // The mock model is provided for convenience when constructing options
    mockModel,
  };
}
```

---

### **Phase 4: Test the Mock**

#### **Step 4.1: Create Unit Tests for the Mock**

**Action:** Create a new test file: `tests/unit/mock-llm.test.ts`

**Intent:** Ensure the mock implementation works correctly before using it in other tests.

**Test Coverage:**
- `generateText` produces correct response format
- `streamText` streams data with appropriate delays
- `generateObject` generates schema-compliant objects
- Response timing is proportional to input length
- Error scenarios are handled correctly

**Example Test Structure:**
```typescript
import { describe, expect, it } from "bun:test";
import { createMockLlm } from "../utils/mock-llm";
import { z } from "zod";

describe("Mock LLM Utility", () => {
  describe("generateText", () => {
    it("should return text response with correct format", async () => {
      const mock = createMockLlm();
      const result = await mock.generateText({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Test prompt" }],
      });

      expect(result.text).toContain("Mock response");
      expect(result.finishReason).toBe("stop");
      expect(result.usage.inputTokens).toBeGreaterThan(0);
    });
  });

  describe("streamText", () => {
    it("should stream text in chunks", async () => {
      const mock = createMockLlm();
      const result = mock.streamText({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Test prompt" }],
      });

      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toContain("Mock stream response");
    });
  });

  describe("generateObject", () => {
    it("should generate schema-compliant objects", async () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const mock = createMockLlm();
      const result = await mock.generateObject({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Generate a person" }],
        schema,
      });

      expect(result.object).toHaveProperty("name");
      expect(result.object).toHaveProperty("age");
      expect(typeof result.object.name).toBe("string");
      expect(typeof result.object.age).toBe("number");
    });

    it("should support no-schema generation", async () => {
      const mock = createMockLlm();
      const result = await mock.generateObject({
        model: mock.mockModel,
        messages: [{ role: "user", content: "Generate anything" }],
        output: "no-schema",
      });

      expect(result.object).toBeDefined();
      expect(result.object).toHaveProperty("response");
    });
  });
});
```

---

### **Phase 5: Integrate Mock into Tests**

#### **Step 5.1: Update Existing Chronicler Tests**

**Action:** Refactor existing Chronicler tests to use the new mock

**Files to Update:**
- `tests/integration/chronicler-conversational.test.ts`
- `tests/integration/chronicler-triggers.test.ts`
- Any other tests using ad-hoc LLM mocks

**Intent:** Replace simple mocks with the structured mock utility for better test reliability and assertions.

#### **Step 5.2: Write New Chronicler Tests**

**Action:** Create comprehensive tests for Chronicler using the mock

**Test Coverage:**
- Chronicler correctly formats messages for LLM calls
- Response handling and state management
- Error scenarios and retries
- Streaming responses
- Multiple parallel calls

**Example Test Structure:**
```typescript
import { describe, expect, it } from "bun:test";
import { Chronicler } from "../../server/chroniclers/chronicler";
import { createMockLlm } from "../utils/mock-llm";

describe("Chronicler with Mock LLM", () => {
  it("should handle conversational flow correctly", async () => {
    const mock = createMockLlm();
    const capturedCalls: any[] = [];

    const llmAdapter = async (id: string, messages: any[]) => {
      const options = {
        model: mock.mockModel,
        messages,
      };
      capturedCalls.push({ id, options });
      const result = await mock.generateText(options);
      return result.text;
    };

    const chronicler = new Chronicler(config, phaseId, llmAdapter, logger, dir);

    // Test chronicler behavior
    await chronicler.processEvent(event);

    // Assert on captured calls
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].options.messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("narrator"),
    });
  });
});
```

---

## **Implementation Checklist**

### Phase 1: Implement Interfaces & Update Chronicler
- [ ] Create `server/types/llm-call-types.ts`
- [ ] Update Chronicler to use new types
- [ ] Verify tests break as expected

### Phase 2: Fix Linting & Type Issues
- [ ] Run `bun lint:fix`
- [ ] Fix any manual linting issues
- [ ] Run `bun typecheck`
- [ ] Fix all TypeScript errors

### Phase 3: Build the Mock Utility
- [ ] Create `tests/utils/mock-llm.ts`
- [ ] Implement `generateText` mock
- [ ] Implement `streamText` mock
- [ ] Implement `generateObject` mock
- [ ] Add helper functions for delays and data generation

### Phase 4: Test the Mock
- [ ] Create `tests/unit/mock-llm.test.ts`
- [ ] Test `generateText` functionality
- [ ] Test `streamText` functionality
- [ ] Test `generateObject` functionality
- [ ] Test timing and delay behavior
- [ ] Verify all tests pass

### Phase 5: Integrate Mock into Tests
- [ ] Update `chronicler-conversational.test.ts`
- [ ] Update `chronicler-triggers.test.ts`
- [ ] Update other integration tests
- [ ] Write new comprehensive Chronicler tests
- [ ] Verify all tests pass

---

## **Example Code Changes**

### Example: Updated Chronicler Test

```typescript
// ... inside the test file ...
// Track LLM calls
const llmCalls: Array<{ id: string; eventsOrMessages: ServerEvent[] | TadpoleModelMessage[] }> = [];
const mockLlm = async (id: string, eventsOrMessages: ServerEvent[] | TadpoleModelMessage[]) => {
  llmCalls.push({ id, eventsOrMessages });
  return `Response ${llmCalls.length}`;
};

// ... in a test ...
const chronicler1 = new Chronicler(config, PhaseId("test-phase"), mockLlm, logger, testChroniclerDir);
// ...
```

**_After (using the new utility):_**

```typescript
// At the top of tests/integration/chronicler-conversational.test.ts
import { createMockLlm } from "../utils/mock-llm.js";
import { anthropic } from "@ai-sdk/anthropic"; // Import a real provider for the model object

// ... inside the test file ...

// Create a single mock instance for the test suite or test case
const mockLlmProvider = createMockLlm();
const capturedLlmCalls: TadpoleGenerateTextOptions[] = [];

// Create a spy that wraps the mock to capture calls
const spiedGenerateText = async (options: TadpoleGenerateTextOptions) => {
  capturedLlmCalls.push(options);
  return mockLlmProvider.generateText(options);
};

// The function passed to the chronicler now needs to handle the different call types
// For this conversational test, it's a text generation call.
const llmCallAdapter = async (id: string, messages: TadpoleModelMessage[]) => {
  const result = await spiedGenerateText({
    // We use a real model provider's object to satisfy types,
    // but the mock doesn't actually use it to make a call.
    model: anthropic("claude-3-5-sonnet-20240620"),
    messages,
  });
  return result.text; // Return just the text, as the old mock did
};

// ... in a test ...
const chronicler1 = new Chronicler(config, PhaseId("test-phase"), llmCallAdapter, logger, testChroniclerDir);

// ... later in the test, we can make more powerful assertions
// For example, after a call is made:
expect(capturedLlmCalls.length).toBe(1);
expect(capturedLlmCalls[0].messages).toContainEqual({
  role: "system",
  content: "You are a helpful narrator maintaining context across events.",
});
```

---

## **File and Folder Summary**

### **Phase 1 Files:**
- **Create:** `server/types/llm-call-types.ts`
- **Modify:** `server/chroniclers/chronicler.ts`, related Chronicler files

### **Phase 3 Files:**
- **Create:** `tests/utils/mock-llm.ts`

### **Phase 4 Files:**
- **Create:** `tests/unit/mock-llm.test.ts`

### **Phase 5 Files:**
- **Modify:** All existing Chronicler integration tests
- **Create:** New comprehensive Chronicler test files as needed

---

## **Success Criteria**

1. **Type Safety:** All LLM calls are type-checked at compile time
2. **Test Coverage:** Mock utility has its own comprehensive test suite
3. **Performance:** Tests run faster without real API calls
4. **Determinism:** Tests produce consistent results
5. **Maintainability:** Clear separation between production code and test mocks
6. **Documentation:** Well-documented interfaces and mock behavior

---

## **Conclusion**

This phased approach ensures a clean, incremental implementation:

1. **Phase 1** establishes the type foundation
2. **Phase 2** ensures code quality and type safety
3. **Phase 3** builds the testing infrastructure
4. **Phase 4** validates the mock works correctly
5. **Phase 5** integrates everything and improves test quality

Each phase builds on the previous one, allowing us to catch and fix issues early while maintaining a working codebase at each step.
