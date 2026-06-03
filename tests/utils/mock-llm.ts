import type { LanguageModel } from "ai";
import { z } from "zod";
import type {
  HankweaveGenerateObjectOptions,
  HankweaveGenerateObjectResult,
  HankweaveGenerateTextOptions,
  HankweaveGenerateTextResult,
  HankweaveStreamTextOptions,
  HankweaveStreamTextResult,
} from "../../server/types/llm-call-types";

// --- Helper Functions for Realistic Simulation ---

/**
 * Calculates a realistic delay based on prompt length.
 * @param prompt The input prompt string.
 * @returns A delay in milliseconds.
 */
function calculateDelay(prompt: string = ""): number {
  const baseDelay = 10; // Keep tests fast while preserving ordering differences
  const perCharDelay = Math.min(0.2, 50 / Math.max(1, prompt.length));
  const randomJitter = Math.floor(Math.random() * 10);
  const maxDelay = 80;
  return Math.min(maxDelay, baseDelay + prompt.length * perCharDelay + randomJitter);
}

/**
 * A very simple mock data generator for Zod schemas.
 * It's not exhaustive but handles common primitives for testing.
 * @param schema The Zod schema to generate data for.
 * @returns A mock object conforming to the schema.
 */
function generateMockDataForSchema(schema: z.ZodSchema<unknown>): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodSchema<unknown>>;
    const result: Record<string, unknown> = {};
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
  forceError?: Error;
  errorProvider?: (
    options:
      | HankweaveGenerateTextOptions
      | HankweaveStreamTextOptions
      | HankweaveGenerateObjectOptions,
  ) => Error | undefined;
  // Custom implementations for testing
  generateObject?: <T>(
    options: HankweaveGenerateObjectOptions,
  ) => Promise<HankweaveGenerateObjectResult<T>>;
  // Add parameter overrides for testing
  respectMaxOutputTokens?: boolean; // Default: true
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
    options: HankweaveGenerateTextOptions,
  ): Promise<HankweaveGenerateTextResult> {
    // Handle forced errors for testing
    if (config.forceError) {
      throw config.forceError;
    }
    if (config.errorProvider) {
      const error = config.errorProvider(options);
      if (error) throw error;
    }

    const lastMessage = options.messages?.slice(-1)[0]?.content?.toString() ?? "";
    const prompt = lastMessage;

    // Respect temperature for response variation (simplified for mock)
    const tempModifier = options.temperature ?? 1;
    const baseResponse = `Mock response for: "${prompt}"`;
    const responseText =
      tempModifier === 0 ? baseResponse : `${baseResponse} (temp=${tempModifier})`;

    // Respect maxOutputTokens if specified
    let finalResponse = responseText;
    if (options.maxOutputTokens && config.respectMaxOutputTokens !== false) {
      // Simple truncation for mock (1 token ≈ 4 chars)
      const maxChars = options.maxOutputTokens * 4;
      if (finalResponse.length > maxChars) {
        finalResponse = `${finalResponse.substring(0, maxChars - 3)}...`;
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

  /**
   * Mock implementation of `streamText`.
   */
  function mockStreamText(options: HankweaveStreamTextOptions): HankweaveStreamTextResult {
    // Handle forced errors for testing
    if (config.forceError) {
      throw config.forceError;
    }
    if (config.errorProvider) {
      const error = config.errorProvider(options);
      if (error) throw error;
    }

    const lastMessage = options.messages?.slice(-1)[0]?.content?.toString() ?? "";
    const prompt = lastMessage;
    const responseText = `Mock stream response for: "${prompt}"`;
    const chunks = responseText.match(/.{1,10}/g) || []; // Split into 10-char chunks

    let chunkIndex = 0;
    let streamClosed = false;

    // Create a proper ReadableStream implementation
    const readableStream = new ReadableStream<string>({
      async pull(controller) {
        if (streamClosed) {
          return;
        }

        if (chunkIndex < chunks.length) {
          // Simulate network delay between chunks
          await new Promise((resolve) => setTimeout(resolve, 2));
          controller.enqueue(chunks[chunkIndex]);
          chunkIndex++;
        } else {
          controller.close();
          streamClosed = true;
        }
      },
      cancel() {
        streamClosed = true;
      },
    });

    // Create an async iterable that uses the same chunks
    async function* generateStream(): AsyncIterable<string> {
      for (const chunk of chunks) {
        // Simulate network delay between chunks
        await new Promise((resolve) => setTimeout(resolve, 2));
        yield chunk;
      }
    }

    // Combine both interfaces using Object.assign to create a proper union type
    const textStream = Object.assign(generateStream(), {
      // ReadableStream properties and methods
      locked: false,
      cancel: () => readableStream.cancel(),
      getReader: () => readableStream.getReader(),
      pipeThrough: <_T>(transform: ReadableWritablePair<_T, string>) =>
        readableStream.pipeThrough(transform),
      pipeTo: (destination: WritableStream<string>, options?: StreamPipeOptions) =>
        readableStream.pipeTo(destination, options),
      tee: () => readableStream.tee(),
    }) as AsyncIterable<string> & ReadableStream<string>;

    // Pre-calculate the final result since we know the response text
    const finalResult = {
      text: responseText,
      finishReason: "stop" as const,
      usage: {
        inputTokens: prompt.length,
        outputTokens: responseText.length,
      },
    };

    return {
      textStream,
      text: Promise.resolve(finalResult.text),
      finishReason: Promise.resolve(finalResult.finishReason),
      usage: Promise.resolve(finalResult.usage),
    };
  }

  /**
   * Mock implementation of `generateObject`.
   */
  async function mockGenerateObject<T>(
    options: HankweaveGenerateObjectOptions,
  ): Promise<HankweaveGenerateObjectResult<T>> {
    // Handle forced errors for testing
    if (config.forceError) {
      throw config.forceError;
    }
    if (config.errorProvider) {
      const error = config.errorProvider(options);
      if (error) throw error;
    }

    const lastMessage = options.messages?.slice(-1)[0]?.content?.toString() ?? "";
    const prompt = lastMessage;
    await new Promise((resolve) => setTimeout(resolve, calculateDelay(prompt)));

    let mockObject: T;

    if (options.output === "no-schema" || !options.schema) {
      // For no-schema, generate a simple mock object
      mockObject = {
        response: `Mock unstructured object for: "${prompt}"`,
        timestamp: Date.now(),
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

/**
 * Helper function to create an LLM adapter that maintains compatibility with existing tests
 * while using the new typed interface internally.
 */
export function createTypedMockLlmAdapter(
  customResponse?: string | (() => Promise<string>) | (() => Promise<never>),
): (id: string, options: HankweaveGenerateTextOptions) => Promise<HankweaveGenerateTextResult> {
  const mockLlm = createMockLlm();

  return async (_id: string, options: HankweaveGenerateTextOptions) => {
    // If a custom response function is provided, use it for the text
    if (customResponse) {
      if (typeof customResponse === "string") {
        return {
          text: customResponse,
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: customResponse.length },
        };
      } else {
        const responseText = await customResponse();
        return {
          text: responseText,
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: responseText.length },
        };
      }
    }

    // Otherwise use the standard mock
    return await mockLlm.generateText(options);
  };
}
