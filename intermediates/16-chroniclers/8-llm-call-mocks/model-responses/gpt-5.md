Below is a detailed, actionable plan to introduce LLM call types and deterministic, realistic mocks for generateText, streamText, and generateObject in this TypeScript/Bun repository.

The plan follows your priorities:
- Define Zod-first schemas and derived TypeScript types for:
  - Common model-call options (temperature, maxOutputTokens, etc.)
  - Inputs (already have TadpoleModelMessage)
  - Outputs for each function type (text, stream, object)
- Ensure our types are strict subsets of AI SDK expectations with compile-time checks (like you did for ModelMessage).
- Keep the schemas/types in the main code (server/types).
- Implement mocks under tests (tests/utils) that:
  - Produce deterministic, “reasonable” responses (often echoes, deterministic seed).
  - Simulate latency proportional to input size (plus jitter).
  - Stream results in chunks with realistic timing.
  - Generate objects conforming to the passed schema (simple, deterministic schema walker).
- Do not overcomplicate (no top_p/top_k for now), and don’t modify any existing code yet.

Part A: High-level design

1) Desired developer experience
- In server/types:
  - Zod schemas and types for call inputs and outputs for generateText, streamText, generateObject.
  - Compatibility checks against AI SDK function signatures (via Parameters<typeof fn>[0] and Awaited<ReturnType<typeof fn>>).
- In tests/utils:
  - A mock AI SDK module exporting mockGenerateText, mockStreamText, mockGenerateObject.
  - Helper functions for token estimation, latency calculation, streaming, and simple Zod-based object synthesis.

2) Keep to a minimal subset for call options
- Common options: system, prompt, messages (you already have TadpoleModelMessage), temperature, maxOutputTokens, maxRetries, seed, headers, providerOptions. That’s it.
- Don’t include topP/topK/topK/presencePenalty/frequencyPenalty, toolChoice, tools, telemetry, etc. now.
- Make prompt and messages optional (like AI SDK); at least one must be provided (refine in Zod).
- Stream and object calls reuse these basics.

3) Outputs subset
- generateText result subset: text, finishReason, usage { inputTokens, outputTokens, totalTokens }, and optional request/response metadata shapes.
- streamText result subset: textStream (async iterable for text), plus same fields (text, usage, finishReason) as resolved promises where relevant, so call sites can either await text or consume the stream; optionally include a minimal fullStream (a generalized async iterable of unioned “parts”) if useful—otherwise stick to textStream + helper promises.
- generateObject result subset: object (matches schema), finishReason, usage, and toJsonResponse convenience.

4) Streaming and latency realism
- Latency = base + proportional to estimated prompt tokens + small jitter. Deterministic jitter based on seed when provided.
- Streaming: yield chunks (words or characters) at small intervals. Interval and chunk size scale with output length to simulate realistic pacing.

5) “Inputs to models” gap check
- Your TadpoleModelMessage support looks good: system/user/assistant/tool roles, with tool-call and tool-result content. You excluded “reasoning” parts (which AI SDK allows in assistant content). That’s acceptable as a subset (narrower). Only flag: if in the future you rely on ReasoningPart in streaming or analysis, consider adding a minimal reasoning part. For now, no change required.

Part B: Concrete file and API plan

1) Add new schemas/types (server/types/llm-call-schemas.ts)
Intent: Zod-first schemas and inferred TS types for call options and results, matching a subset of AI SDK. Also, compile-time subset checks.

Proposed exports
- Common and shared:
  - tadpoleCommonCallSettingsSchema: includes temperature?: number (>=0), maxOutputTokens?: number (>=1), maxRetries?: number (>=0), seed?: number (integer), headers?: Record<string,string>, providerOptions?: Record<string, Record<string, JsonValue>>. This schema reuses your jsonValueSchema from server/types/input-ai-types.ts.
  - type TadpoleCommonCallSettings = z.infer<typeof tadpoleCommonCallSettingsSchema>.

- GenerateText:
  - tadpoleGenerateTextArgsSchema:
    - model?: string (optional; our mock ignores it; present for subset compatibility)
    - system?: string
    - prompt?: string
    - messages?: TadpoleModelMessage[]
    - Merge with tadpoleCommonCallSettingsSchema
    - Refinement: at least one of prompt or messages must be provided
  - type TadpoleGenerateTextArgs = z.infer<typeof tadpoleGenerateTextArgsSchema>
  - tadpoleGenerateTextResultSchema (subset):
    - text: string
    - usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number }
    - finishReason: 'stop' | 'length' | 'error' | 'other' | 'unknown'
    - request?: { body?: string }
    - response?: { id: string; modelId: string; timestamp: Date; headers?: Record<string,string> }
    - warnings?: unknown[] (optional)
  - type TadpoleGenerateTextResult = z.infer<typeof tadpoleGenerateTextResultSchema>

- StreamText:
  Streaming returns are not cleanly represented in Zod (AsyncIterableStream). Approach:
  - Define TypeScript-only interfaces for the stream result:
    - interface TadpoleStreamTextResult {
        textStream: AsyncIterable<string>;
        // Convenience promises for test usage (AI SDK provides these):
        text: Promise<string>;
        usage: Promise<{ inputTokens: number; outputTokens: number; totalTokens: number }>;
        finishReason: Promise<'stop'|'length'|'error'|'other'|'unknown'>;
      }
  - For compatibility checks, use ReturnType<typeof streamText> inference and assert subset on the parts we model:
    - We can create a minimal compatibility assertion by extracting the type of textStream via an indexed lookup using ReturnType inference and ensure our textStream is assignable to an AsyncIterable<string>. Or use a broader assert with unknown.

- GenerateObject:
  - tadpoleGenerateObjectArgsSchema:
    - model?: string
    - output?: 'object' | 'array' | 'enum' | 'no-schema' (default 'object')
    - schema?: z.ZodTypeAny (required for object/array, forbidden for 'no-schema' and optional for 'enum')
    - enum?: string[] (required when output === 'enum')
    - system?: string
    - prompt?: string
    - messages?: TadpoleModelMessage[]
    - Merge with tadpoleCommonCallSettingsSchema
    - Refinements:
      - If output === 'enum', enum must be provided
      - If output === 'object' or 'array', schema must be provided
  - type TadpoleGenerateObjectArgs = z.infer<typeof tadpoleGenerateObjectArgsSchema>
  - tadpoleGenerateObjectResultSchema (subset):
    - object: unknown
    - usage?: same shape as in text
    - finishReason: same enum as in text
    - toJsonResponse?: (init?: ResponseInit) => Response (optional util)
  - type TadpoleGenerateObjectResult = z.infer<typeof tadpoleGenerateObjectResultSchema>

Compile-time subset checks
- Use the “subset” helper you already use:
  - type SdkGenerateTextOptions = Parameters<typeof import('ai').generateText>[0]
  - type SdkStreamTextOptions = Parameters<typeof import('ai').streamText>[0]
  - type SdkGenerateObjectOptions = Parameters<typeof import('ai').generateObject>[0]
  - type SdkGenerateTextResult = Awaited<ReturnType<typeof import('ai').generateText>>
  - type SdkStreamTextResult = ReturnType<typeof import('ai').streamText> // then pick the parts we emulate if needed
  - type SdkGenerateObjectResult = Awaited<ReturnType<typeof import('ai').generateObject>>
- Then:
  - assertTadpoleIsSubsetOfSdk<SdkGenerateTextOptions, TadpoleGenerateTextArgs>()
  - assertTadpoleIsSubsetOfSdk<SdkGenerateObjectOptions, TadpoleGenerateObjectArgs>()
  - For streamText: assert the options type as above; for the result, we can avoid asserting full result shape (due to streams) or assert only that our textStream is assignable to AsyncIterable<string> and our extra convenience properties are additive.

2) Add test-only mocks (tests/utils/mock-ai-sdk.ts)
Intent: Deterministic “mock SDK” that mirrors AI SDK’s three functions.

Exports
- mockGenerateText(args: TadpoleGenerateTextArgs): Promise<TadpoleGenerateTextResult>
- mockStreamText(args: TadpoleGenerateTextArgs): TadpoleStreamTextResult
- mockGenerateObject(args: TadpoleGenerateObjectArgs): Promise<TadpoleGenerateObjectResult>

Shared helpers
- estimateTokens(text: string): number — approximate 4 chars per token, same as your simpleTokenCounter used elsewhere.
- stringifyMessages(messages: TadpoleModelMessage[]): string — join messages into a deterministic string representation:
  - Format: `${role}: ${stringifiedContent}\n`
  - Content: if string, use it; if array of parts, include text parts; for images/files use placeholders `[image]`, `[file]` with minimal metadata to prevent exploding the content length.
- buildInputString(args):
  - If args.prompt, use that; else if args.messages, use stringifyMessages(messages) + prepend system if provided.
- seededRng(seed?: number): () => number in [0,1)
  - Implement a tiny xorshift or mulberry32; if no seed provided, derive one from a hash of the input string for determinism across runs.
- sleep(ms): Promise<void>
- clamp, chunkByWords or chunkByChars:
  - For streaming, prefer word chunks of moderate size (e.g., 5–10 words per chunk). If there are no spaces, fallback to 10–20 chars per chunk.

Latency model
- Base latency: 100ms
- Proportional component: tokensIn * 2ms + tokensOutEstimate * 1ms
- Jitter: +/- ~10% from seeded RNG
- For generateText:
  - tokensIn = estimateTokens(input)
  - tokensOutEstimate = min(est. from maxOutputTokens if present, else min(tokensIn, 256))
  - latency = base + proportional + jitter; await sleep(latency)
- For streamText:
  - Break the output into N chunks; delay between chunks = max(10ms, totalLatency / N), with slight jitter.

mockGenerateText
- Input resolution:
  - Combine system+prompt/messages via buildInputString
- Output determination:
  - Return text as deterministic echo:
    - “Echo: ” + (input truncated to max chars) or a simple deterministic transform such as reversing every nth word based on seed to make it non-trivial but stable. Keep it simple to aid assertions: “Echo: ” + first X chars of input (e.g., X = maxOutputTokens * 4 chars or a minimum of 400 chars).
  - usage:
    - inputTokens = estimateTokens(input)
    - outputTokens = estimateTokens(outputText)
    - totalTokens = sum
  - finishReason: 'stop'
  - request.body: JSON.stringify({ system, prompt, messagesCount, temperature, maxOutputTokens })
  - response: a stable id like `mock-${hash(input)}`, modelId: args.model ?? 'mock-model', timestamp: new Date()
- Timing: sleep(latency) before returning.

mockStreamText
- Build the same outputText as mockGenerateText
- Create an async generator that yields chunks (words or characters) with delays per chunk to simulate streaming.
- Provide:
  - textStream: AsyncIterable<string>
  - text: Promise that consumes the stream and concatenates
  - usage: Promise calculating tokens after streaming finishes (or precompute and just resolve)
  - finishReason: Promise<'stop'> resolving at end
- Ensure .text/.usage/.finishReason consume the stream exactly once or duplicate the stream internally (e.g., buffer text as you stream for tests). Simplest approach: buffer as you stream and resolve Promises off the buffer.

mockGenerateObject
- Determine inputString via buildInputString
- If output === 'enum', pick deterministically based on seed/hash (e.g., enum[(hash % enum.length)]).
- If output === 'no-schema', return something simple like:
  {
    object: { echo: inputString.slice(0, 128), length: inputString.length, tokens: estimateTokens(inputString) }
  }
- If schema provided (object or array), synthesize an object that validates:
  - Implement a minimal schema walker:
    - z.string(): use a stable, short string derived from input, e.g., inputString.slice(0, 24) || 'string'
    - z.number(): use tokens or input length
    - z.boolean(): true if seed hash is even, else false
    - z.array(itemSchema): produce a small array (length 1–3) with values from itemSchema
    - z.object(shape): recursively synthesize for each key
    - z.union([a,b,...]): pick one deterministically (hash % options)
    - z.literal(value): return value
    - z.enum([...]): pick deterministically
    - z.optional(x): either skip or include deterministically (include by default to simplify)
    - z.nullable(x): return null or value (return value by default)
    - z.record(valueSchema): return a single key-value (“key”: synth(valueSchema))
    - For any schema not explicitly handled, use a fallback (throw or return a string stating unsupported) then validate with schema.parse; if parse fails, attempt a safer fallback like undefined or a minimal object {} for object-like schemas.
  - Run schema.parse to ensure validity before returning.
- usage & finishReason: same as text call; toJsonResponse: optional convenience.

Part C: Where exactly everything goes

1) Main code (schemas/types only)
- Add file: server/types/llm-call-schemas.ts
  - Imports:
    - zod, jsonValueSchema from server/types/input-ai-types.ts (reuse that type)
    - tadpoleModelMessageSchema for messages
    - AI SDK functions for type inference only (import type generateText/streamText/generateObject or use import and only use types)
  - Exports:
    - Common call settings schema/type
    - GenerateText args/result schemas/types
    - StreamText args type (alias to generate text args) and result interface (TypeScript only)
    - GenerateObject args/result schemas/types
    - assertTadpoleIsSubsetOfSdk checks (see above)
  - Notes:
    - Keep Zod-first
    - Keep compile-time subset asserts best-effort (the options are inferable via Parameters<typeof fn>[0])

2) Test utilities (mocks)
- Add file: tests/utils/mock-ai-sdk.ts
  - Export the three mocks and shared helpers
  - No runtime dependency on AI SDK (only our types from server/types/llm-call-schemas and input-ai-types)
  - Deterministic RNG and hash functions included locally
  - Document how to use these mocks in unit/integration tests

3) Optional: Chronicler helper adapter (test-only convenience)
- Add file: tests/utils/mock-chronicler-llm-bridge.ts (optional)
  - export function makeChroniclerLlmFromMock(opts?: { mode: 'text' | 'object'; schema?: z.ZodType; output?: 'object'|'array'|'enum'|'no-schema' }): (id: string, eventsOrMessages: ServerEvent[] | TadpoleModelMessage[]) => Promise<string>
    - If events array: convert to a single prompt string via JSON.stringify or a compact summarizer; then call mockGenerateText or mockGenerateObject accordingly; return the stringified response to match Chronicler’s expectation of a string
  - This keeps Chronicler tests trivial when you want to simulate LLM calls at a higher fidelity without changing Chronicler code.

Part D: Testing plan

Add unit tests to verify the mocks and schemas
- New test file: tests/unit/mock-ai-sdk.test.ts
  - generateText:
    - Validates Zod schema for args and result
    - Deterministic output given same inputs/seed
    - Usage values proportional to input and output
    - Latency roughly proportional to input length (we can test by bounding the time window and ensuring longer input takes longer than shorter input with a margin)
  - streamText:
    - Consumes textStream with for-await and ensures the concatenated text matches the resolved text
    - Streaming pace: time between first and last chunk scales with output length (bound within a tolerance)
  - generateObject:
    - Given simple Zod object schema, output parses successfully (schema.parse)
    - Arrays and enums handled deterministically
    - 'no-schema' output returns a stable object
- Add a small test for subset type checks compilation (already enforced by the assert helper in the types file; unit test doesn't need to run this explicitly).
- Add optional tests bridging to Chronicler (if desired), similar to how tests/integration/chronicler-templating.test.ts created a mockLLMCall, verifying that makeChroniclerLlmFromMock can be used as a drop-in for Chronicler instances.

Part E: API and behavior details you can rely on

1) Subset guarantees
- We will enforce subset assignability of our args to AI SDK functions using Parameters<typeof fn>[0]. This provides build-time validation without requiring the SDK to export dedicated option types.
- For results, we’ll only assert subset for generateText and generateObject where it’s easy (Awaited<ReturnType<typeof fn>>). For streamText, we’ll assert options compatibility and keep result as an internal type with the expected shape (we won’t pretend to be fully equivalent to AI SDK’s stream object).

2) Deterministic outputs with reasonable variety
- Echo-based outputs with a “Echo: <input slice>” prefix are easy to assert, and you get test-friendly determinism while still simulating complexities.
- Provide a seed field; when set, delays and enum choices should be reproducible across runs.
- When seed is not provided, we derive seed from a quick hash of the input to keep determinism per input (ideal for tests).

3) Proportional latencies and streaming pacing
- Latency increases with token count (input and projected output).
- For streaming, create chunk sizes that scale with total output length (more chunks for longer outputs).
- Small jitter per chunk (seeded) keeps the stream natural-looking.

4) JSON schema support
- We’ll initially support only Zod schemas for generateObject (as that aligns with your Zod-first design).
- If you need JSON Schema later, we can add a thin “jsonSchema” conversion or accept a discriminated union (not needed now per your simplification request).

Part F: Potential “what’s missing” from inputs (flagging)
- Reasoning parts: AI SDK allows ReasoningPart in assistant content. Your TadpoleAssistantModelMessage currently includes only text and tool-call parts; this is fine as a subset. If later you want to test reasoning streaming or reasoningText in results, we can extend TadpoleAssistantModelMessage with a “reasoning” part. For now, not required.
- We won’t support actual tool calls in the mocks yet (to keep scope sane). If a test needs it later, the mock could simulate a tool-call part when toolChoice === 'required' or a specific toolName is set. Currently not needed.
- Stop sequences and advanced sampling controls are intentionally omitted per your directive.

Part G: Example usage snippets (for implementers)

1) Validating and calling a mock text generation
- In tests you can do:
  - const args = tadpoleGenerateTextArgsSchema.parse({ system: 'You are helpful', prompt: 'Say hi', temperature: 0 });
  - const res = await mockGenerateText(args);
  - expect(res.text).toContain('Echo:');

2) Streaming in tests
- const { textStream, text } = mockStreamText({ prompt: 'Hello world!' });
- let chunks = '';
- for await (const delta of textStream) { chunks += delta; }
- expect(chunks).toEqual(await text);

3) Object generation in tests
- const personSchema = z.object({ name: z.string(), age: z.number(), tags: z.array(z.string()).min(1) });
- const args = tadpoleGenerateObjectArgsSchema.parse({ output: 'object', schema: personSchema, prompt: 'Synthesize person' });
- const { object } = await mockGenerateObject(args);
- expect(() => personSchema.parse(object)).not.toThrow();

Part H: Implementation steps (recommended order)

1) Create server/types/llm-call-schemas.ts with:
- Zod schemas for common settings, generateText args/result, generateObject args/result.
- Type-only interface for streamText result, alias stream args to generate text args.
- assertTadpoleIsSubsetOfSdk checks using AI SDK functions’ parameter/return types via Parameters and ReturnType.

2) Create tests/utils/mock-ai-sdk.ts with:
- Helpers (token estimator, RNG, sleep, chunking).
- mockGenerateText, mockStreamText, mockGenerateObject implementations.

3) Add unit tests for the mocks (tests/unit/mock-ai-sdk.test.ts). Ensure CI passes with Bun.

4) Optional: Add tests/utils/mock-chronicler-llm-bridge.ts if you want a one-liner adapter to feed Chronicler.

Part I: Notes about the repo and future extension

- Alignment with existing Zod-first approach:
  - Your TadpoleModelMessage types already synchronize with AI SDK’s ModelMessage; we follow the same pattern for call options/results.
- LLM Proxy and Chronicler are unaffected:
  - The mocks live in tests and do not alter server runtime behavior.
- Performance and stability:
  - Since this is test-only, lightweight seeded RNG and simple schema walking suffice (no extra dependencies).

Part J: Summary of what we’re adding

- server/types/llm-call-schemas.ts
  - Zod-first schemas and inferred types for:
    - TadpoleCommonCallSettings
    - TadpoleGenerateTextArgs, TadpoleGenerateTextResult
    - TadpoleStreamTextArgs (alias), TadpoleStreamTextResult (TS-only)
    - TadpoleGenerateObjectArgs, TadpoleGenerateObjectResult
  - Compile-time subset asserts against AI SDK using typeof generateText/streamText/generateObject.

- tests/utils/mock-ai-sdk.ts
  - mockGenerateText
  - mockStreamText
  - mockGenerateObject
  - Utilities: estimateTokens, stringifyMessages, seededRng, sleep, chunking.

- tests/unit/mock-ai-sdk.test.ts
  - Covers determinism, proportional latency/stream pacing, schema conformance for objects.

This plan errs on the side of clarity and aims to be a drop-in foundation for realistic, deterministic test doubles of key AI SDK calls while preserving your project’s Zod-first, subset-compatibility philosophy.