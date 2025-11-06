import { beforeEach, describe, expect, it } from "bun:test";
import { Chronicler } from "../../server/chroniclers/chronicler.js";
import { DEFAULT_CHRONICLER_LLM_PARAMS } from "../../server/chroniclers/chronicler-defaults.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { PhaseId } from "../../server/types/branded-types.js";
import type { ChroniclerConfig } from "../../server/types/chronicler-types.js";
import type { TadpoleGenerateTextOptions } from "../../server/types/llm-call-types.js";
import { createMockLlm } from "../utils/mock-llm.js";

describe("Chronicler LLM Parameters", () => {
  const mockLlm = createMockLlm();
  let capturedOptions: TadpoleGenerateTextOptions[] = [];

  const mockLlmCall = async (_id: string, options: TadpoleGenerateTextOptions) => {
    capturedOptions.push(options);
    const result = await mockLlm.generateText(options);
    return result;
  };

  const testEvent: ServerEvent = {
    id: "test-event-1",
    timestamp: "2025-01-19T10:00:00Z",
    type: "assistant.action",
    data: {
      content: "I'll read the test.ts file",
      phaseId: "test-phase",
      action: "tool_use",
      toolName: "Read",
      toolInput: { file_path: "test.ts" },
    },
  };

  beforeEach(() => {
    capturedOptions = [];
  });

  it("should use default LLM parameters when not specified in config", async () => {
    const config: ChroniclerConfig = {
      id: "test-chronicler",
      name: "Test",
      model: "anthropic/claude-3-5-sonnet-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test prompt: <%= it.events.length %> events",
      // No llmParams specified
    };

    const chronicler = new Chronicler(config, PhaseId("test"), mockLlmCall);

    await chronicler.handleEvent(testEvent);
    await chronicler.completeAllWork(); // Ensure queue is fully processed

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].temperature).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.temperature);
    expect(capturedOptions[0].maxOutputTokens).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.maxOutputTokens);
    expect(capturedOptions[0].maxRetries).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.maxRetries);
  });

  it("should override defaults with chronicler-specific parameters", async () => {
    const config: ChroniclerConfig = {
      id: "creative-chronicler",
      name: "Creative",
      model: "anthropic/claude-3-5-sonnet-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test prompt: <%= it.events.length %> events",
      llmParams: {
        temperature: 1.5,
        maxOutputTokens: 2000,
        maxRetries: 0,
      },
    };

    const chronicler = new Chronicler(config, PhaseId("test"), mockLlmCall);

    await chronicler.handleEvent(testEvent);
    await chronicler.completeAllWork();

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].temperature).toBe(1.5);
    expect(capturedOptions[0].maxOutputTokens).toBe(2000);
    expect(capturedOptions[0].maxRetries).toBe(0);
  });

  it("should partially override defaults", async () => {
    const config: ChroniclerConfig = {
      id: "partial-override",
      name: "Partial",
      model: "anthropic/claude-3-5-sonnet-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test prompt: <%= it.events.length %> events",
      llmParams: {
        temperature: 0.5, // Only override temperature
      },
    };

    const chronicler = new Chronicler(config, PhaseId("test"), mockLlmCall);

    await chronicler.handleEvent(testEvent);
    await chronicler.completeAllWork();

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].temperature).toBe(0.5);
    expect(capturedOptions[0].maxOutputTokens).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.maxOutputTokens);
    expect(capturedOptions[0].maxRetries).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.maxRetries);
  });

  it("should pass parameters for conversational chroniclers", async () => {
    const config: ChroniclerConfig = {
      id: "conversational-params",
      name: "Conversational with Params",
      model: "anthropic/claude-3-5-sonnet-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      systemPromptText: "You are a helpful assistant",
      userPromptText: "Test prompt: <%= it.events.length %> events",
      conversational: {
        trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
      },
      llmParams: {
        temperature: 0.8,
        maxOutputTokens: 1500,
      },
    };

    const chronicler = new Chronicler(config, PhaseId("test"), mockLlmCall);

    await chronicler.handleEvent(testEvent);
    await chronicler.completeAllWork();

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].temperature).toBe(0.8);
    expect(capturedOptions[0].maxOutputTokens).toBe(1500);
    expect(capturedOptions[0].maxRetries).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.maxRetries); // Should use default
  });

  it("should include LLM parameters in both conversational and non-conversational calls", async () => {
    const nonConversationalConfig: ChroniclerConfig = {
      id: "non-conv",
      name: "Non-Conversational",
      model: "anthropic/claude-3-5-sonnet-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test prompt",
      llmParams: { temperature: 0.3 },
    };

    const conversationalConfig: ChroniclerConfig = {
      id: "conv",
      name: "Conversational",
      model: "anthropic/claude-3-5-sonnet-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      systemPromptText: "You are a helper",
      userPromptText: "Test prompt",
      conversational: {
        trimmingStrategy: { type: "maxTurns", maxTurns: 3 },
      },
      llmParams: { temperature: 0.7 },
    };

    const nonConvChronicler = new Chronicler(nonConversationalConfig, PhaseId("test"), mockLlmCall);
    const convChronicler = new Chronicler(conversationalConfig, PhaseId("test"), mockLlmCall);

    await nonConvChronicler.handleEvent(testEvent);
    await convChronicler.handleEvent(testEvent);
    // Complete all work for both chroniclers
    await nonConvChronicler.completeAllWork();
    await convChronicler.completeAllWork();

    expect(capturedOptions).toHaveLength(2);

    // Both should have temperature set
    expect(capturedOptions[0].temperature).toBe(0.3); // Non-conversational
    expect(capturedOptions[1].temperature).toBe(0.7); // Conversational

    // Both should have default maxOutputTokens
    expect(capturedOptions[0].maxOutputTokens).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.maxOutputTokens);
    expect(capturedOptions[1].maxOutputTokens).toBe(DEFAULT_CHRONICLER_LLM_PARAMS.maxOutputTokens);
  });
});

describe("Mock LLM Parameter Handling", () => {
  it("should respect maxOutputTokens by truncating responses", async () => {
    const mockWithTruncation = createMockLlm({ respectMaxOutputTokens: true });

    const result = await mockWithTruncation.generateText({
      model: mockWithTruncation.mockModel,
      messages: [
        {
          role: "user",
          content: "A very long prompt that would normally generate a long response",
        },
      ],
      maxOutputTokens: 10, // Very small limit
    });

    // Response should be truncated (10 tokens ≈ 40 chars)
    expect(result.text.length).toBeLessThanOrEqual(40);
    expect(result.finishReason).toBe("length");
    expect(result.text).toMatch(/\.\.\.$/); // Should end with "..."
  });

  it("should vary response based on temperature", async () => {
    const mock = createMockLlm();

    const deterministicResult = await mock.generateText({
      model: mock.mockModel,
      messages: [{ role: "user", content: "test" }],
      temperature: 0,
    });

    const creativeResult = await mock.generateText({
      model: mock.mockModel,
      messages: [{ role: "user", content: "test" }],
      temperature: 1.5,
    });

    // Temperature 0 should not include temperature in response
    expect(deterministicResult.text).not.toContain("(temp=");

    // Temperature > 0 should include temperature in response for differentiation
    expect(creativeResult.text).toContain("(temp=1.5)");
  });

  it("should throw configured errors for testing", async () => {
    const testError = new Error("API Rate Limit Exceeded");
    const mockWithError = createMockLlm({ forceError: testError });

    await expect(
      mockWithError.generateText({
        model: mockWithError.mockModel,
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toThrow("API Rate Limit Exceeded");
  });
});
