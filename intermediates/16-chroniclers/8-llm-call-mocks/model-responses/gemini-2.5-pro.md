### **Executive Summary**

The goal is to create a comprehensive set of types and mocks for testing the application's Language Model (LLM) interactions without making actual API calls. This is crucial for the **Chronicler System**, which makes numerous parallel, non-blocking LLM calls. Reliable, fast, and deterministic testing of this system is paramount.

This plan outlines a three-step process:

1. **Define New Schemas & Types:** We will create a new file, `server/types/llm-call-types.ts`, to define Zod schemas and TypeScript types for the parameters and return values of the core AI SDK functions we use: `generateText`, `streamText`, and `generateObject`. Following the existing pattern in `server/types/input-ai-types.ts`, these types will be a simplified subset of the official AI SDK types, with build-time checks to ensure ongoing compatibility.
2. **Implement a Sophisticated Mock Utility:** We will create a new test utility file, `tests/utils/mock-llm.ts`. This file will export a factory function, `createMockLlm()`, that generates a mock AI provider. This mock will simulate realistic behavior, including proportional response delays, chunked streaming, and basic schema-aware object generation.
3. **Integrate and Refactor Existing Tests:** We will demonstrate how to replace the simple, ad-hoc mocks in existing integration tests (like those for the Chronicler system) with our new, structured mocking utility, leading to more robust and readable tests.

This approach will provide a powerful, centralized mocking solution that improves test reliability, speeds up the test suite, and eliminates the cost and non-determinism of hitting real LLM APIs during development and CI/CD.

---

### **Detailed Plan**

#### **Step 1: Define Schemas and Types for LLM Calls and Responses**

We need a centralized place to define the shapes of our LLM calls. This ensures consistency and leverages TypeScript's static analysis to prevent errors.

**Action:** Create a new file: `server/types/llm-call-types.ts`.

**Intent:** This file will define the "Tadpole" version of the inputs and outputs for AI SDK functions. By keeping these separate from the `input-ai-types.ts` (which defines message structures), we maintain a clear separation of concerns.

**File Content for `server/types/llm-call-types.ts`:**

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
  maxTokens: z.number().optional().describe("Maximum number of tokens to generate."),
  maxRetries: z.number().optional().describe("Maximum number of retries for the API call."),
});

// --- `generateText` Schemas ---

/**
 * Input parameters for a `generateText` call.
 * This is a subset of the AI SDK's `GenerateTextOptions`.
 */
export const tadpoleGenerateTextOptionsSchema = tadpoleLlmCallParamsSchema.extend({
  model: z.custom<LanguageModel>(), // We trust the model object is correct
  system: z.string().optional(),
  prompt: z.string().optional(),
  messages: z.array(tadpoleModelMessageSchema).optional(),
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
 */
export const tadpoleStreamTextResultSchema = z.object({
  textStream: z.custom<AsyncIterable<string>>(),
  // We can't easily represent the full promise-based result in Zod,
  // so we'll handle that with TypeScript types.
});

// --- `generateObject` Schemas ---

/**
 * Input parameters for a `generateObject` call.
 * This is a subset of the AI SDK's `GenerateObjectOptions`.
 */
export const tadpoleGenerateObjectOptionsSchema = tadpoleLlmCallParamsSchema.extend({
  model: z.custom<LanguageModel>(),
  schema: z.custom<z.ZodSchema<any>>(),
  prompt: z.string().optional(),
  messages: z.array(tadpoleModelMessageSchema).optional(),
  mode: z.enum(["auto", "json", "tool"]).optional(),
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
export type TadpoleStreamTextResult = {
  textStream: AsyncIterable<string>;
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
```

---

#### **Step 2: Create the LLM Mocking Utility**

This utility will provide a configurable mock that simulates the AI SDK's behavior realistically, satisfying the requirements for response values, timing, streaming, and object generation.

**Action:** Create a new file: `tests/utils/mock-llm.ts`.

**Intent:** To centralize all LLM mocking logic. This avoids code duplication in tests and provides a standard, high-fidelity simulation of the LLM provider. Tests will become cleaner and more focused on business logic rather than on the mechanics of mocking.

**File Content for `tests/utils/mock-llm.ts`:**

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
    const prompt = options.prompt ?? options.messages?.slice(-1)[0]?.content?.toString() ?? "";
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
    const prompt = options.prompt ?? options.messages?.slice(-1)[0]?.content?.toString() ?? "";
    const responseText = `Mock stream response for: "${prompt}"`;
    const chunks = responseText.match(/.{1,10}/g) || []; // Split into 10-char chunks

    async function* generateStream(): AsyncIterable<string> {
      for (const chunk of chunks) {
        // Simulate network delay between chunks
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield chunk;
      }
    }

    const textStream = generateStream();

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
    const prompt = options.prompt ?? options.messages?.slice(-1)[0]?.content?.toString() ?? "";
    await new Promise((resolve) => setTimeout(resolve, calculateDelay(prompt)));

    const mockObject = generateMockDataForSchema(options.schema) as T;

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

#### **Step 3: Integrate the Mock into Existing Tests**

Now we will refactor an existing test to use our new, more powerful mock. This will make the test more realistic and easier to maintain.

**Action:** Modify `tests/integration/chronicler-conversational.test.ts`.

**Intent:** To showcase the practical benefits of the new mocking system. By replacing the simple mock with the structured one, we can improve test assertions and better simulate real-world behavior.

**Example Refactor in `tests/integration/chronicler-conversational.test.ts`:**

**_Before (the current simple mock):_**

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

### **File and Folder Summary**

**New Files to Create:**

1. `server/types/llm-call-types.ts`: Contains the Zod schemas, TypeScript types, and build-time compatibility checks for LLM function parameters and results.
2. `tests/utils/mock-llm.ts`: Contains the `createMockLlm` factory and all helper functions for simulating realistic LLM behavior.

**Files to Modify:**

1. `tests/integration/chronicler-conversational.test.ts`: Update to use the new `createMockLlm` utility.
2. `tests/integration/chronicler-triggers.test.ts` (and others): Update any tests that use an ad-hoc LLM mock to use the new standardized utility.

### **Conclusion**

By executing this plan, we will establish a first-class testing infrastructure for all LLM-related functionality in the Tadpole Runner. This system provides three key benefits:

1. **Type Safety and Compatibility:** Zod schemas and build-time assertions guarantee that our mocks and internal code remain aligned with the AI SDK, preventing integration surprises.
2. **Realistic Simulation:** Proportional delays and simulated streaming make our tests a better reflection of real-world performance and behavior.
3. **Improved Test Quality:** A centralized, powerful mock allows tests to be more focused, readable, and capable of asserting on the specific parameters sent to the LLM, not just that a call was made.

This investment will significantly enhance the reliability and maintainability of the Chronicler system and any future features that interact with LLMs.