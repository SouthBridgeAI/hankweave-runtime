import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Chronicler } from "../../server/chroniclers/chronicler.js";
import { ChroniclerFatalError } from "../../server/chroniclers/chronicler-fatal-error.js";
import { PhaseId } from "../../server/types/branded-types.js";
import type { ChroniclerConfig } from "../../server/types/chronicler-types.js";
import type {
  TadpoleGenerateObjectOptions,
  TadpoleGenerateObjectResult,
  TadpoleGenerateTextOptions,
  TadpoleGenerateTextResult,
} from "../../server/types/llm-call-types.js";

// Mock LLM functions
const mockLlmCall = async (
  _id: string,
  _options: TadpoleGenerateTextOptions,
): Promise<TadpoleGenerateTextResult> => {
  return {
    text: "mock response",
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 20 },
  };
};

const mockLlmObjectCall = async (
  _id: string,
  _options: TadpoleGenerateObjectOptions,
): Promise<TadpoleGenerateObjectResult<unknown>> => {
  return {
    object: { name: "test" },
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 20 },
  };
};

describe("Structured Output - Schema Loading", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `test-structured-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("loads inline Zod schema correctly", () => {
    const config: ChroniclerConfig = {
      id: "test-inline-schema",
      name: "Test Inline Schema",
      model: "anthropic/claude",
      trigger: { type: "event", on: ["file.updated"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test",
      structuredOutput: {
        schemaStr: "z.object({ name: z.string(), age: z.number() })",
        output: "object",
      },
    };

    const chronicler = new Chronicler(
      config,
      PhaseId("test-phase"),
      mockLlmCall,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mockLlmObjectCall,
    );

    expect(chronicler.getId()).toBe("test-inline-schema");
  });

  test("loads Zod schema from file", async () => {
    // Create temp schema file
    const schemaPath = path.join(testDir, "test-schema.ts");
    await fs.writeFile(schemaPath, "z.object({ result: z.string() })");

    const config: ChroniclerConfig = {
      id: "test-file-schema",
      name: "Test File Schema",
      model: "anthropic/claude",
      trigger: { type: "event", on: ["file.updated"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test",
      structuredOutput: {
        schemaFile: schemaPath,
        output: "object",
      },
    };

    const chronicler = new Chronicler(
      config,
      PhaseId("test-phase"),
      mockLlmCall,
      undefined,
      undefined,
      testDir,
      undefined,
      undefined,
      undefined,
      mockLlmObjectCall,
    );

    expect(chronicler.getId()).toBe("test-file-schema");
  });

  test("handles relative schema file paths", async () => {
    const schemaPath = path.join(testDir, "relative-schema.ts");
    await fs.writeFile(schemaPath, "z.object({ data: z.boolean() })");

    const config: ChroniclerConfig = {
      id: "test-relative",
      name: "Test Relative",
      model: "anthropic/claude",
      trigger: { type: "event", on: ["file.updated"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test",
      structuredOutput: {
        schemaFile: "./relative-schema.ts",
        output: "array",
      },
    };

    // Should resolve relative to configDirectory
    const chronicler = new Chronicler(
      config,
      PhaseId("test-phase"),
      mockLlmCall,
      undefined,
      undefined,
      testDir, // configDirectory
      undefined,
      undefined,
      undefined,
      mockLlmObjectCall,
    );

    expect(chronicler.getId()).toBe("test-relative");
  });

  test("throws ChroniclerFatalError for invalid Zod code", () => {
    const config: ChroniclerConfig = {
      id: "test-invalid-schema",
      name: "Test Invalid Schema",
      model: "anthropic/claude",
      trigger: { type: "event", on: ["file.updated"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test",
      structuredOutput: {
        schemaStr: "invalid javascript syntax {{}",
        output: "object",
      },
    };

    expect(() => {
      new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockLlmObjectCall,
      );
    }).toThrow(ChroniclerFatalError);
  });

  test("throws ChroniclerFatalError for non-Zod object", () => {
    const config: ChroniclerConfig = {
      id: "test-non-zod",
      name: "Test Non Zod",
      model: "anthropic/claude",
      trigger: { type: "event", on: ["file.updated"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test",
      structuredOutput: {
        schemaStr: '{ plain: "object" }', // Returns plain object, not Zod schema
        output: "object",
      },
    };

    expect(() => {
      new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockLlmObjectCall,
      );
    }).toThrow(ChroniclerFatalError);
  });

  test("handles enum mode (no schema needed)", () => {
    const config: ChroniclerConfig = {
      id: "test-enum",
      name: "Test Enum",
      model: "anthropic/claude",
      trigger: { type: "event", on: ["file.updated"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test",
      structuredOutput: {
        output: "enum",
        enumValues: ["low", "medium", "high"],
      },
    };

    const chronicler = new Chronicler(
      config,
      PhaseId("test-phase"),
      mockLlmCall,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mockLlmObjectCall,
    );

    expect(chronicler.getId()).toBe("test-enum");
  });

  test("throws when schema file doesn't exist", () => {
    const config: ChroniclerConfig = {
      id: "test-missing-file",
      name: "Test Missing File",
      model: "anthropic/claude",
      trigger: { type: "event", on: ["file.updated"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test",
      structuredOutput: {
        schemaFile: "/nonexistent/schema.ts",
        output: "object",
      },
    };

    expect(() => {
      new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockLlmObjectCall,
      );
    }).toThrow(ChroniclerFatalError);
  });

  test("throws when llmObjectCall not provided for structured output", () => {
    const config: ChroniclerConfig = {
      id: "test-no-object-call",
      name: "Test No Object Call",
      model: "anthropic/claude",
      trigger: { type: "event", on: ["file.updated"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test",
      structuredOutput: {
        schemaStr: "z.object({ x: z.string() })",
        output: "object",
      },
    };

    expect(() => {
      new Chronicler(
        config,
        PhaseId("test-phase"),
        mockLlmCall,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined, // No llmObjectCall provided
      );
    }).toThrow(ChroniclerFatalError);
  });
});
