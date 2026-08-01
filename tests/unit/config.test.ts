import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as codonRunnerModule from "../../server/codon-runner.js";
import {
  buildSelfTestGuidance,
  classifyInBandSelfTest,
  formatFailedSelfTest,
  loadCodonSequence,
  loadHankFile,
  loadHankweaveRuntimeEnvVars,
  loadRuntimeConfig,
  validateHank,
} from "../../server/config";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry";
import { CodonId } from "../../server/types/branded-types";
import type { ModelName, ShimSelfTestResult } from "../../server/types/types";
import { Logger } from "../../server/utils";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers";

// -------------
// Shared Test Helpers
// -------------

/**
 * Helper to create test files with their parent directories.
 */
const createTestFile = (filePath: string, content: string) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content);
};

/**
 * Helper to clean up a directory recursively.
 */
const cleanup = (dir: string) => {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
};

/**
 * Helper to write a hank config file in the correct object format.
 * Uses unknown type to allow test data with plain strings instead of branded types.
 */
const writeHankConfig = (filePath: string, codons: unknown[]) => {
  const hankFile = { hank: codons };
  fs.writeFileSync(filePath, JSON.stringify(hankFile, null, 2));
};

const createSelfTestResult = (
  passed = true,
  message = passed ? "Synthetic self-test passed" : "Synthetic self-test failed",
): ShimSelfTestResult => ({
  shim: {
    name: "synthetic-shim",
    version: "1.0.0-test",
  },
  agent: {
    name: "synthetic-agent",
    version: "1.0.0-test",
    found: true,
  },
  checks: [
    {
      name: "synthetic-check",
      passed,
      message,
    },
  ],
  overall: {
    passed,
    message,
  },
});

// -------------
// Tests
// -------------

// -------------
// Model Validation Tests
// -------------

describe("Model Validation", () => {
  beforeAll(() => {
    // Initialize LLM Provider Registry for model validation
    const mockLogger = new Logger("/dev/null");
    LlmProviderRegistry.getInstance({
      logger: mockLogger,
      performHealthCheckOnInit: false,
    });
  });

  describe("in codonSchema (transforms to ModelInfo)", () => {
    const tempDir = path.resolve("tests", "test-area", "temp-codon-model-test");
    const configPath = path.join(tempDir, "test-config.json");

    beforeEach(() => {
      cleanup(tempDir);
      fs.mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    test("accepts valid Claude model shortcuts (sonnet, opus, haiku)", () => {
      const models = ["sonnet", "opus", "haiku"];

      for (const model of models) {
        const config = [
          {
            id: "test-codon",
            name: "Test Codon",
            model,
            continuationMode: "fresh" as const,
            promptText: "Test prompt",
          },
        ];

        writeHankConfig(configPath, config);
        const { codons: result } = loadCodonSequence({ configPath });

        expect(result).toHaveLength(1);
        const codon = result[0];
        if (codon.type !== "loop") {
          expect(codon.model).toBeDefined();
          expect(codon.model.modelId).toContain(model);
        }
      }
    });

    test("accepts valid Gemini models", () => {
      const models = ["gemini-2.5-flash"];

      for (const model of models) {
        const config = [
          {
            id: "test-codon",
            name: "Test Codon",
            model,
            continuationMode: "fresh" as const,
            promptText: "Test prompt",
          },
        ];

        writeHankConfig(configPath, config);
        const { codons: result } = loadCodonSequence({ configPath });

        expect(result).toHaveLength(1);
        const codon = result[0];
        if (codon.type !== "loop") {
          expect(codon.model).toBeDefined();
          expect(typeof codon.model.modelId).toBe("string");
        }
      }
    });

    test("throws error for invalid model", () => {
      const config = [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "invalid-model-xyz",
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ];

      writeHankConfig(configPath, config);
      expect(() => loadCodonSequence({ configPath })).toThrow("Invalid model");
    });

    test("throws error for empty model string", () => {
      const config = [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "",
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ];

      writeHankConfig(configPath, config);
      expect(() => loadCodonSequence({ configPath })).toThrow();
    });

    test("validates model in loop codons", () => {
      const config = [
        {
          type: "loop",
          id: "test-loop",
          name: "Test Loop",
          terminateOn: {
            type: "iterationLimit" as const,
            limit: 2,
          },
          codons: [
            {
              id: "loop-codon",
              name: "Loop Codon",
              model: "invalid-loop-model",
              continuationMode: "fresh" as const,
              promptText: "Test prompt",
            },
          ],
        },
      ];

      writeHankConfig(configPath, config);
      expect(() => loadCodonSequence({ configPath })).toThrow("Invalid model");
    });
  });

  describe("in hankOverridesSchema (keeps as string)", () => {
    const tempDir = path.resolve("tests", "test-area", "temp-overrides-model-test");
    const hankPath = path.join(tempDir, "test-hank.json");

    beforeEach(() => {
      cleanup(tempDir);
      fs.mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    test("accepts valid model in overrides", () => {
      const models = ["sonnet", "opus", "haiku"];

      for (const model of models) {
        const hankContent = {
          overrides: {
            model,
          },
          hank: [
            {
              id: "test-codon",
              name: "Test Codon",
              model: "sonnet" as ModelName,
              continuationMode: "fresh" as const,
              promptText: "Test prompt",
            },
          ],
        };

        createTestFile(hankPath, JSON.stringify(hankContent, null, 2));
        const result = loadHankFile({ hankPath: hankPath });

        // Model should stay as string in overrides
        expect(result.overrides?.model).toBe(model);
        expect(typeof result.overrides?.model).toBe("string");
      }
    });

    test("throws error for invalid model in overrides", () => {
      const hankContent = {
        overrides: {
          model: "invalid-model-xyz",
        },
        hank: [
          {
            id: "test-codon",
            name: "Test Codon",
            model: "sonnet" as ModelName,
            continuationMode: "fresh" as const,
            promptText: "Test prompt",
          },
        ],
      };

      createTestFile(hankPath, JSON.stringify(hankContent, null, 2));
      expect(() => loadHankFile({ hankPath: hankPath })).toThrow("Invalid");
    });

    test("allows undefined model in overrides", () => {
      const hankContent = {
        overrides: {
          dataHashTimeLimit: 5000,
          // No model field
        },
        hank: [
          {
            id: "test-codon",
            name: "Test Codon",
            model: "sonnet" as ModelName,
            continuationMode: "fresh" as const,
            promptText: "Test prompt",
          },
        ],
      };

      createTestFile(hankPath, JSON.stringify(hankContent, null, 2));
      const result = loadHankFile({ hankPath: hankPath });

      expect(result.overrides?.model).toBeUndefined();
    });
  });

  describe("in runtimeConfigSchema (keeps as string)", () => {
    const tempDir = path.resolve("tests", "test-area", "temp-runtime-model-test");
    const runtimeConfigPath = path.join(tempDir, "hankweave.json");

    beforeEach(() => {
      cleanup(tempDir);
      fs.mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    test("accepts valid model in runtime config", () => {
      const models = ["sonnet", "opus", "haiku", "gemini-2.5-flash"];

      for (const model of models) {
        const runtimeContent = {
          model,
          port: 8080,
        };

        createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
        const result = loadRuntimeConfig(runtimeConfigPath);

        // Model should stay as string in runtime config
        expect(result.model).toBe(model);
        expect(typeof result.model).toBe("string");
      }
    });

    test("throws error for invalid model in runtime config", () => {
      const runtimeContent = {
        model: "this is not a model", // Invalid - not in registry
        port: 8080,
      };

      createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
      expect(() => loadRuntimeConfig(runtimeConfigPath)).toThrow("Invalid");
    });

    test("allows undefined model in runtime config", () => {
      const runtimeContent = {
        port: 8080,
        // No model field
      };

      createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
      const result = loadRuntimeConfig(runtimeConfigPath);

      expect(result.model).toBeUndefined();
    });

    test("throws error for empty model string in runtime config", () => {
      const runtimeContent = {
        model: "",
        port: 8080,
      };

      createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
      expect(() => loadRuntimeConfig(runtimeConfigPath)).toThrow();
    });
  });

  describe("model validation error messages", () => {
    const tempDir = path.resolve("tests", "test-area", "temp-model-error-test");
    const configPath = path.join(tempDir, "test-config.json");

    beforeEach(() => {
      cleanup(tempDir);
      fs.mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    test("provides helpful error message for invalid model", () => {
      const config = [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "nonexistent-model",
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ];

      writeHankConfig(configPath, config);

      try {
        loadCodonSequence({ configPath });
        throw new Error("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain("Invalid model");
        expect(message).toContain("nonexistent-model");
      }
    });
  });

  describe("codon field validation error messages", () => {
    const tempDir = path.resolve("tests", "test-area", "temp-codon-field-error-test");
    const configPath = path.join(tempDir, "test-config.json");

    beforeEach(() => {
      cleanup(tempDir);
      fs.mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    test("provides helpful error for typo: systemPromptFile → appendSystemPromptFile", () => {
      const config = [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "opus",
          continuationMode: "fresh",
          promptText: "Test prompt",
          systemPromptFile: "./system.md", // Wrong field name!
        },
      ];

      writeHankConfig(configPath, config);

      try {
        loadCodonSequence({ configPath });
        throw new Error("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        // Should suggest correct field name
        expect(message).toContain("systemPromptFile");
        expect(message).toContain("appendSystemPromptFile");
        expect(message.toLowerCase()).toContain("did you mean");
      }
    });

    test("provides helpful error for typo: trackedFiles → checkpointedFiles", () => {
      const config = [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "opus",
          continuationMode: "fresh",
          promptText: "Test prompt",
          trackedFiles: ["*.md"], // Wrong field name!
        },
      ];

      writeHankConfig(configPath, config);

      try {
        loadCodonSequence({ configPath });
        throw new Error("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("trackedFiles");
        expect(message).toContain("checkpointedFiles");
        expect(message.toLowerCase()).toContain("did you mean");
      }
    });

    test("provides helpful error for unknown codon field", () => {
      const config = [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "opus",
          continuationMode: "fresh",
          promptText: "Test prompt",
          unknownField: "value", // Completely unknown
        },
      ];

      writeHankConfig(configPath, config);

      try {
        loadCodonSequence({ configPath });
        throw new Error("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        // Should mention the field name and valid fields
        expect(message).toContain("unknownField");
        expect(message.toLowerCase()).toMatch(/unrecognized|unknown/);
      }
    });

    test("catches unrecognized fields in loop codons", () => {
      createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

      const config = [
        {
          type: "loop",
          id: "test-loop",
          name: "Test Loop",
          terminateOn: { type: "iterationLimit", limit: 2 },
          codons: [
            {
              id: "loop-codon",
              name: "Loop Codon",
              model: "opus",
              continuationMode: "fresh",
              promptFile: "./prompt.md",
              trackedFiles: ["*.md"], // Wrong! Should be checkpointedFiles
            },
          ],
        },
      ];

      writeHankConfig(configPath, config);

      try {
        loadCodonSequence({ configPath });
        throw new Error("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        // Should at least identify the problematic field
        expect(message).toContain("trackedFiles");
        // Note: typo suggestions for deeply nested codons within loops
        // go through loopSchema's inner codonSchema which doesn't have
        // our detailed error handler, so we don't always get suggestions
      }
    });

    test("nested loop codon typo preserves context and suggestion", () => {
      createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

      const config = [
        {
          type: "loop",
          id: "loop-ctx",
          name: "Loop Context",
          terminateOn: { type: "iterationLimit", limit: 1 },
          codons: [
            {
              id: "nested-codon",
              name: "Nested Codon",
              model: "opus",
              continuationMode: "fresh",
              promptFile: "./prompt.md",
              trackedFiles: ["*.md"], // Wrong field name!
            },
          ],
        },
      ];

      writeHankConfig(configPath, config);

      try {
        loadCodonSequence({ configPath });
        throw new Error("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        // Expect loop context and a typo suggestion for nested codon fields
        expect(message).toMatch(/loop-ctx|Loop Context/i);
        expect(message).toContain("trackedFiles");
        expect(message).toContain("checkpointedFiles");
        expect(message.toLowerCase()).toContain("did you mean");
      }
    });

    test("reports all unrecognized fields in a single codon", () => {
      const config = [
        {
          id: "multi-unknown",
          name: "Multi Unknown",
          model: "opus",
          continuationMode: "fresh",
          promptText: "Test prompt",
          unknownFieldOne: "value",
          unknownFieldTwo: "value",
        },
      ];

      writeHankConfig(configPath, config);

      try {
        loadCodonSequence({ configPath });
        throw new Error("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("unknownFieldOne");
        expect(message).toContain("unknownFieldTwo");
      }
    });

    test("error message includes codon ID and name for context", () => {
      const config = [
        {
          id: "my-codon-id",
          name: "My Codon Name",
          model: "opus",
          continuationMode: "fresh",
          promptText: "Test",
          systemPromptFile: "./system.md", // Wrong field
        },
      ];

      writeHankConfig(configPath, config);

      try {
        loadCodonSequence({ configPath });
        throw new Error("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        // Error should include codon context
        expect(message).toMatch(/my-codon-id|My Codon Name/i);
      }
    });

    test("error message includes loop ID and name for context", () => {
      const config = [
        {
          type: "loop",
          id: "my-loop-id",
          name: "My Loop Name",
          terminateOn: { type: "iterationLimit", limit: 2 },
          unknownLoopField: "value", // Unknown field in loop
          codons: [
            {
              id: "loop-codon",
              name: "Loop Codon",
              model: "opus",
              continuationMode: "fresh",
              promptText: "Test",
            },
          ],
        },
      ];

      writeHankConfig(configPath, config);

      try {
        loadCodonSequence({ configPath });
        throw new Error("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        // Error should include loop context
        expect(message).toMatch(/my-loop-id|My Loop Name/i);
      }
    });

    test("provides better error than 'Invalid input' for unrecognized fields", () => {
      // This test verifies the fix for the original issue where
      // z.union() gave generic "Invalid input" errors
      const config = [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "opus",
          continuationMode: "fresh",
          promptText: "Test prompt",
          systemPromptFile: "./system.md", // Wrong field
        },
      ];

      writeHankConfig(configPath, config);

      try {
        loadCodonSequence({ configPath });
        throw new Error("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        // Should NOT contain the generic "Invalid input" error
        // Instead should have helpful context
        expect(message).not.toMatch(/^.*hank\.0: Invalid input$/m);
        expect(message).toContain("systemPromptFile");
      }
    });
  });
});

describe("validateHank", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-validation-test");
  const configPath = path.join(tempDir, "validate-config.json");
  const projectPath = path.join(tempDir, "project");
  let testLogger: Logger;
  let originalEnv: Record<string, string | undefined>;
  let runSelfTestSpy: ReturnType<typeof spyOn>;

  // Set up before each test
  beforeEach(() => {
    // Capture and set environment variables for self-tests
    originalEnv = captureEnv();
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.GEMINI_API_KEY = "test-google-key";

    cleanup(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });

    // Initialize LLM Provider Registry for model validation
    const mockLogger = new Logger("/dev/null");
    testLogger = mockLogger;
    LlmProviderRegistry.getInstance({
      logger: mockLogger,
      performHealthCheckOnInit: false,
    });

    runSelfTestSpy = spyOn(codonRunnerModule.CodonRunner, "runSelfTestForModel");
    runSelfTestSpy.mockImplementation(async () => createSelfTestResult());
  });

  afterEach(() => {
    cleanup(tempDir);
    LlmProviderRegistry.resetInstance();
    runSelfTestSpy.mockRestore();
    // Restore original environment
    restoreEnv(originalEnv);
  });

  test("validates basic configuration successfully", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt content");

    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.codonCount).toBe(1);
    expect(result.promptFileCount).toBe(1);
    expect(result.systemPromptFileCount).toBe(0);
    expect(result.rigSetupCount).toBe(0);
    expect(result.trackingCodonCount).toBe(0);
    expect(result.checkpointCodonCount).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("counts multiple codons correctly", async () => {
    createTestFile(path.join(tempDir, "prompt1.md"), "Prompt 1");
    createTestFile(path.join(tempDir, "prompt2.md"), "Prompt 2");
    createTestFile(path.join(tempDir, "system.md"), "System prompt");

    const config = [
      {
        id: "codon-1",
        name: "First Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt1.md",
        checkpointedFiles: ["*.md"],
      },
      {
        id: "codon-2",
        name: "Second Codon",
        model: "opus", // Same model for continue-previous
        continuationMode: "continue-previous",
        promptFile: "./prompt2.md",
        appendSystemPromptFile: "./system.md",
        checkpointedFiles: ["*.js"],
        rigSetup: [
          {
            type: "copy",
            copy: {
              from: "./prompt1.md",
              to: "copied-file.md",
            },
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.codonCount).toBe(2);
    expect(result.promptFileCount).toBe(2);
    expect(result.systemPromptFileCount).toBe(1);
    expect(result.rigSetupCount).toBe(1);
    expect(result.trackingCodonCount).toBe(2);
    expect(result.checkpointCodonCount).toBe(2);
  });

  test("detects duplicate codon IDs", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "duplicate-id",
        name: "First Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
      {
        id: "duplicate-id",
        name: "Second Codon",
        model: "sonnet",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow("Duplicate codon ID");
  });

  test("warns about duplicate codon names", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "codon-1",
        name: "Duplicate Name",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
      {
        id: "codon-2",
        name: "Duplicate Name",
        model: "sonnet",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Duplicate codon name "Duplicate Name"');
  });

  test("warns about empty prompt files", async () => {
    createTestFile(path.join(tempDir, "empty.md"), ""); // Empty file

    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./empty.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("is empty");
  });

  test("warns about large prompt files", async () => {
    const largeContent = "x".repeat(2 * 1024 * 1024); // 2MB file
    createTestFile(path.join(tempDir, "large.md"), largeContent);

    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./large.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("is large");
  });

  test("validates rig setup copy operations", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    createTestFile(path.join(tempDir, "source.txt"), "Source content");

    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        rigSetup: [
          {
            type: "copy",
            copy: {
              from: "./source.txt",
              to: "target.txt",
            },
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.rigSetupCount).toBe(1);
    expect(result.warnings).toHaveLength(0);
  });

  test("warns when copy target already exists", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    createTestFile(path.join(tempDir, "source.txt"), "Source content");
    // Create the target file that already exists in the project
    createTestFile(path.join(projectPath, "existing-target.txt"), "Existing content");

    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        rigSetup: [
          {
            type: "copy",
            copy: {
              from: "./source.txt",
              to: "existing-target.txt", // Target already exists
            },
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.rigSetupCount).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("already exists and will be overwritten");
  });

  test("throws on invalid target paths", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    createTestFile(path.join(tempDir, "source.txt"), "Source content");

    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        rigSetup: [
          {
            type: "copy",
            copy: {
              from: "./source.txt",
              to: "../outside-project.txt", // Would write outside project
            },
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow("Invalid target path");
  });

  test("warns about potentially dangerous commands", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        rigSetup: [
          {
            type: "command",
            command: {
              run: "rm -rf /", // Dangerous command
            },
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Potentially dangerous command detected");
  });

  test("validates continuation mode dependencies", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    // First codon with continue-previous mode
    const config = [
      {
        id: "first-codon",
        name: "First Codon",
        model: "opus",
        continuationMode: "continue-previous", // Invalid for first codon
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("but there's no previous codon");
  });

  test("warns when continuing from codon without output", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "codon-1",
        name: "First Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        // No checkpointedFiles
      },
      {
        id: "codon-2",
        name: "Second Codon",
        model: "opus", // Same model for continue-previous
        continuationMode: "continue-previous",
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("doesn't checkpoint any files");
  });

  test("warns when continuing from loop whose last codon has no output", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "test-loop",
        name: "Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "loop-codon",
            name: "Loop Codon",
            model: "opus",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
            // No checkpointedFiles - this is the last codon in the loop
          },
        ],
      },
      {
        id: "codon-after-loop",
        name: "Codon After Loop",
        model: "opus", // Same model for continue-previous
        continuationMode: "continue-previous",
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    const continuationWarning = result.warnings.find((w: string) =>
      w.includes("Continues from previous loop"),
    );
    expect(continuationWarning).toBeDefined();
    expect(continuationWarning).toContain("whose last codon");
    expect(continuationWarning).toContain("doesn't checkpoint any files");
  });

  test("throws on empty command", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        rigSetup: [
          {
            type: "command",
            command: {
              run: "", // Empty command
            },
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    // loadHankFile now validates schema first and throws "Invalid hank file" with detailed errors
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow("Invalid hank file");
  });

  test("delegates to loadCodonSequence for basic validation", async () => {
    const invalidConfig = [
      {
        // Missing required fields
        promptText: "Test prompt",
      },
    ];

    writeHankConfig(configPath, invalidConfig);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow();
  });

  test("counts codons inside loops correctly", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "standalone-codon",
        name: "Standalone Codon",
        model: "sonnet",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
      {
        type: "loop",
        id: "test-loop",
        name: "Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 3,
        },
        codons: [
          {
            id: "loop-codon-1",
            name: "Loop Codon 1",
            model: "opus",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
          {
            id: "loop-codon-2",
            name: "Loop Codon 2",
            model: "opus", // Same model for continue-previous
            continuationMode: "continue-previous",
            promptFile: "./prompt.md",
          },
        ],
      },
      {
        id: "final-codon",
        name: "Final Codon",
        model: "opus", // Match last codon in loop
        continuationMode: "continue-previous",
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    // Should count: 1 standalone + 2 in loop + 1 final = 4 total codons
    expect(result.codonCount).toBe(4);
  });

  test("throws on duplicate codon ID within loop", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "test-loop",
        name: "Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "duplicate-id", // Same ID
            name: "Codon 1",
            model: "opus",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
          {
            id: "duplicate-id", // Same ID - should fail
            name: "Codon 2",
            model: "sonnet",
            continuationMode: "continue-previous",
            promptFile: "./prompt.md",
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow("Duplicate codon ID");
  });

  test("throws when codon ID conflicts with loop ID", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "shared-id", // Loop has this ID
        name: "Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "loop-codon",
            name: "Loop Codon",
            model: "opus",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
        ],
      },
      {
        id: "shared-id", // Codon has same ID as loop - should fail
        name: "Conflicting Codon",
        model: "sonnet",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow("Duplicate");
  });

  test("validates codons inside loops with proper context in error messages", async () => {
    // Test that error messages include loop context
    // Use a non-existent prompt file to trigger an error
    const config = [
      {
        type: "loop",
        id: "my-loop",
        name: "My Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "loop-codon",
            name: "Loop Codon",
            model: "opus",
            continuationMode: "fresh",
            promptFile: "./non-existent.md", // File doesn't exist
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    expect(() => loadCodonSequence({ configPath })).toThrow(
      /Loop.*my-loop.*promptFile.*does not exist/,
    );
  });

  test("allows rigSetup in loop codons and warns without allowFailure", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "rig-setup-loop",
        name: "Rig Setup Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "loop-codon",
            name: "Loop Codon",
            model: "opus",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
            rigSetup: [
              {
                type: "copy",
                copy: {
                  from: "./prompt.md",
                  to: "target.md",
                },
                // No allowFailure flag - should generate warning
              },
            ],
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    // Should not throw, but should have warnings
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w: string) => w.includes("allowFailure"))).toBe(true);
  });

  test("warns when a loop codon defaults to onFailure: abort", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "abort-default-loop",
        name: "Abort Default Loop",
        terminateOn: { type: "iterationLimit", limit: 24 },
        codons: [
          {
            id: "loop-body",
            name: "Loop Body",
            model: "opus",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
            // No onFailure - defaults to "abort"
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    const abortWarning = result.warnings.find((w: string) => w.includes("onFailure: abort"));
    expect(abortWarning).toBeDefined();
    expect(abortWarning).toContain("defaults to");
  });

  test("does not warn about abort when loop codon sets onFailure: retry", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "retry-loop",
        name: "Retry Loop",
        terminateOn: { type: "iterationLimit", limit: 24 },
        codons: [
          {
            id: "loop-body",
            name: "Loop Body",
            model: "opus",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
            onFailure: "retry",
            retryConfig: { maxAttempts: 3 },
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.warnings.some((w: string) => w.includes("onFailure: abort"))).toBe(false);
  });

  test("does not warn about abort for a top-level codon", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "top-level",
        name: "Top Level Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        // No onFailure - defaults to "abort", but top-level codons should not warn
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    expect(result.warnings.some((w: string) => w.includes("onFailure: abort"))).toBe(false);
  });

  test("throws when contextExceeded loop has codons with fresh continuationMode", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "context-loop",
        name: "Context Loop",
        terminateOn: {
          type: "contextExceeded",
        },
        codons: [
          {
            id: "fresh-codon",
            name: "Fresh Codon",
            model: "opus",
            continuationMode: "fresh", // This should fail
            promptFile: "./prompt.md",
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow(/contextExceeded.*fresh.*infinite/i);
  });

  test("throws when contextExceeded loop with multiple codons has any fresh codon", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "context-loop",
        name: "Context Loop",
        terminateOn: {
          type: "contextExceeded",
        },
        codons: [
          {
            id: "continue-codon",
            name: "Continue Codon",
            model: "opus",
            continuationMode: "continue-previous", // This is OK for first codon
            promptFile: "./prompt.md",
          },
          {
            id: "fresh-codon",
            name: "Fresh Codon",
            model: "sonnet",
            continuationMode: "fresh", // This should fail
            promptFile: "./prompt.md",
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow(/contextExceeded.*fresh.*infinite/i);
  });

  test("allows contextExceeded loop with all continue-previous codons", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "context-loop",
        name: "Context Loop",
        terminateOn: {
          type: "contextExceeded",
        },
        codons: [
          {
            id: "codon-1",
            name: "Codon 1",
            model: "opus",
            continuationMode: "continue-previous",
            promptFile: "./prompt.md",
          },
          {
            id: "codon-2",
            name: "Codon 2",
            model: "opus", // Same model for continue-previous
            continuationMode: "continue-previous",
            promptFile: "./prompt.md",
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });
    // Should not throw
    expect(result.codonCount).toBe(2);
  });

  test("throws when codon after contextExceeded loop has continue-previous", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "context-loop",
        name: "Context Loop",
        terminateOn: {
          type: "contextExceeded",
        },
        codons: [
          {
            id: "loop-codon",
            name: "Loop Codon",
            model: "opus",
            continuationMode: "continue-previous",
            promptFile: "./prompt.md",
          },
        ],
      },
      {
        id: "after-loop",
        name: "After Loop",
        model: "sonnet",
        continuationMode: "continue-previous", // This should fail
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow(/continue-previous.*contextExceeded.*context.*exhausted/i);
  });

  test("allows codon after contextExceeded loop with fresh continuationMode", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "context-loop",
        name: "Context Loop",
        terminateOn: {
          type: "contextExceeded",
        },
        codons: [
          {
            id: "loop-codon",
            name: "Loop Codon",
            model: "opus",
            continuationMode: "continue-previous",
            promptFile: "./prompt.md",
          },
        ],
      },
      {
        id: "after-loop",
        name: "After Loop",
        model: "sonnet",
        continuationMode: "fresh", // This is OK
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });
    // Should not throw
    expect(result.codonCount).toBe(2);
  });

  test("allows iterationLimit loop with fresh codons", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "iteration-loop",
        name: "Iteration Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 3,
        },
        codons: [
          {
            id: "fresh-codon",
            name: "Fresh Codon",
            model: "opus",
            continuationMode: "fresh", // This is OK for iterationLimit
            promptFile: "./prompt.md",
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });
    // Should not throw
    expect(result.codonCount).toBe(1);
  });

  test("allows two codons with different models and fresh continuationMode", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "codon-1",
        name: "First Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
      {
        id: "codon-2",
        name: "Second Codon",
        model: "sonnet", // Different model
        continuationMode: "fresh", // Fresh mode is OK
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });
    // Should not throw
    expect(result.codonCount).toBe(2);
  });

  test("throws when codon with continue-previous has different model from previous codon", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "codon-1",
        name: "First Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
      {
        id: "codon-2",
        name: "Second Codon",
        model: "sonnet", // Different model
        continuationMode: "continue-previous", // This should fail
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow(/continue-previous.*model differs.*session ID/i);
  });

  test("throws when codon after loop has different model with continue-previous", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "test-loop",
        name: "Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "loop-codon",
            name: "Loop Codon",
            model: "opus", // Loop uses opus
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
        ],
      },
      {
        id: "after-loop",
        name: "After Loop",
        model: "sonnet", // Different model
        continuationMode: "continue-previous", // This should fail
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow(/continue-previous.*model differs.*session ID/i);
  });

  test("throws when codon after loop with multiple codons has different model", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "test-loop",
        name: "Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "loop-codon-1",
            name: "Loop Codon 1",
            model: "haiku",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
          {
            id: "loop-codon-2",
            name: "Loop Codon 2",
            model: "opus", // Last codon in loop uses opus
            continuationMode: "continue-previous",
            promptFile: "./prompt.md",
          },
        ],
      },
      {
        id: "after-loop",
        name: "After Loop",
        model: "sonnet", // Different from last codon in loop
        continuationMode: "continue-previous", // This should fail
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow(/continue-previous.*model differs.*session ID/i);
  });

  test("throws when codons inside loop have different models with continue-previous", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "test-loop",
        name: "Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "loop-codon-1",
            name: "Loop Codon 1",
            model: "haiku",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
          {
            id: "loop-codon-2",
            name: "Loop Codon 2",
            model: "opus", // Different model
            continuationMode: "continue-previous", // This should fail
            promptFile: "./prompt.md",
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow(/continue-previous.*model differs.*previous codon in loop.*session ID/i);
  });

  test("allows codons inside loop with different models when using fresh", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "test-loop",
        name: "Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "loop-codon-1",
            name: "Loop Codon 1",
            model: "haiku",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
          {
            id: "loop-codon-2",
            name: "Loop Codon 2",
            model: "opus", // Different model
            continuationMode: "fresh", // Fresh mode is OK
            promptFile: "./prompt.md",
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });
    // Should not throw
    expect(result.codonCount).toBe(2);
  });

  test("runs self-tests for all unique models", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "anthropic-codon",
        name: "Anthropic Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
      {
        id: "gemini-codon",
        name: "Gemini Codon",
        model: "gemini-2.5-flash",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
      {
        id: "anthropic-codon-2",
        name: "Another Anthropic Codon",
        model: "sonnet", // Different Anthropic model
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    // Should have run self-tests
    expect(result.shimSelfTests).toBeDefined();
    expect(Array.isArray(result.shimSelfTests)).toBe(true);

    // Type guard to ensure shimSelfTests exists
    if (!result.shimSelfTests) {
      throw new Error("shimSelfTests should be defined");
    }

    expect(result.shimSelfTests.length).toBeGreaterThan(0);

    // Should have self-tests for unique models
    const modelIds = result.shimSelfTests.map((test) => test.modelId);
    expect(modelIds.length).toBeGreaterThan(0);

    // Each self-test should have required fields
    for (const test of result.shimSelfTests) {
      expect(test.modelId).toBeDefined();
      expect(test.provider).toBeDefined();
      expect(typeof test.passed).toBe("boolean");
      expect(test.result).toBeDefined();
      expect(test.result.shim).toBeDefined();
      expect(test.result.agent).toBeDefined();
      expect(Array.isArray(test.result.checks)).toBe(true);
      expect(test.result.overall).toBeDefined();
      expect(typeof test.result.overall.passed).toBe("boolean");
    }
  }, 90_000); // Must exceed SELF_TEST_TIMEOUT_MS (60s on Windows) + overhead

  test("collects unique models from loops", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "test-loop",
        name: "Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "loop-codon-1",
            name: "Loop Codon 1",
            model: "opus",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
          {
            id: "loop-codon-2",
            name: "Loop Codon 2",
            model: "gemini-2.5-flash",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
        ],
      },
      {
        id: "regular-codon",
        name: "Regular Codon",
        model: "opus", // Same as loop-codon-1, should not duplicate
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    const result = await validateHank({
      configPath,
      executionPath: projectPath,
      logger: testLogger,
    });

    // Should have run self-tests
    expect(result.shimSelfTests).toBeDefined();
    expect(Array.isArray(result.shimSelfTests)).toBe(true);

    // Type guard to ensure shimSelfTests exists
    if (!result.shimSelfTests) {
      throw new Error("shimSelfTests should be defined");
    }

    // Should have unique models only (opus should appear once, gemini once)
    const modelIds = result.shimSelfTests.map((test) => test.modelId);
    const uniqueModelIds = new Set(modelIds);
    expect(modelIds.length).toBe(uniqueModelIds.size);
  }, 90_000); // Must exceed SELF_TEST_TIMEOUT_MS (60s on Windows) + overhead

  test("throws when self-tests fail", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    runSelfTestSpy.mockImplementationOnce(async () =>
      createSelfTestResult(false, "Synthetic self-test failure"),
    );

    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    await expect(
      validateHank({
        configPath,
        executionPath: projectPath,
        logger: testLogger,
      }),
    ).rejects.toThrow("Synthetic self-test failure");
  }, 90_000); // Must exceed SELF_TEST_TIMEOUT_MS (60s on Windows) + overhead
});

describe("loadHankFile", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-test-hank");
  const hankPath = path.join(tempDir, "test-hank.json");

  beforeEach(() => {
    cleanup(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });

    // Initialize LLM Provider Registry for model validation
    const mockLogger = new Logger("/dev/null");
    LlmProviderRegistry.getInstance({
      logger: mockLogger,
      performHealthCheckOnInit: false,
    });
  });

  afterEach(() => {
    cleanup(tempDir);
    LlmProviderRegistry.resetInstance();
  });

  test("loads valid hank file with all fields", () => {
    const hankContent = {
      meta: {
        name: "Test Hank",
        version: "1.0.0",
        description: "A test hank",
        author: "Test Author",
      },
      overrides: {
        model: "sonnet" as ModelName,
        dataHashTimeLimit: 10000,
        sentinel: {
          enablePersistence: false,
          healthCheckGracePeriodMs: 1000,
          waitForAllHealthChecks: true,
        },
      },
      hank: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(hankPath, JSON.stringify(hankContent, null, 2));

    const result = loadHankFile({ hankPath: hankPath });

    expect(result.meta).toEqual(hankContent.meta);
    // Check overrides fields (model stays as string)
    expect(result.overrides?.model).toBe("sonnet");
    expect(result.overrides?.dataHashTimeLimit).toBe(10000);
    expect(result.overrides?.sentinel).toEqual(hankContent.overrides.sentinel);
    expect(result.hank).toHaveLength(1);
    expect(result.hank[0].id).toBe("test-codon");
  });

  test("loads hank file with only hank array (minimal)", () => {
    const hankContent = {
      hank: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(hankPath, JSON.stringify(hankContent, null, 2));

    const result = loadHankFile({ hankPath: hankPath });

    expect(result.meta).toBeUndefined();
    expect(result.overrides).toBeUndefined();
    expect(result.hank).toHaveLength(1);
  });

  test("throws error for missing file", () => {
    expect(() => loadHankFile({ hankPath: "/nonexistent/hank.json" })).toThrow(
      "Hank file not found",
    );
  });

  test("throws error for invalid JSON", () => {
    createTestFile(hankPath, "{ invalid json }");
    expect(() => loadHankFile({ hankPath: hankPath })).toThrow();
  });

  test("throws error for missing hank array", () => {
    const hankContent = {
      meta: {
        name: "Test Hank",
        version: "1.0.0",
      },
      // Missing hank array
    };

    createTestFile(hankPath, JSON.stringify(hankContent, null, 2));
    expect(() => loadHankFile({ hankPath: hankPath })).toThrow("Invalid hank file");
  });

  test("throws error for empty meta name", () => {
    const hankContent = {
      meta: {
        name: "",
        version: "1.0.0",
      },
      hank: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(hankPath, JSON.stringify(hankContent, null, 2));
    expect(() => loadHankFile({ hankPath: hankPath })).toThrow();
  });

  test("validates overrides model enum", () => {
    const hankContent = {
      overrides: {
        model: "invalid-model", // Invalid model
      },
      hank: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(hankPath, JSON.stringify(hankContent, null, 2));
    expect(() => loadHankFile({ hankPath: hankPath })).toThrow("Invalid hank file");
  });

  test("throws error on typos in overrides", () => {
    // With .strict() mode enabled, typos in overrides are caught
    // and users get immediate feedback instead of silent failures.
    const hankContent = {
      overrides: {
        modle: "opus", // Typo! Should be "model"
        dataHashTimeLimit: 10000, // Valid field
      },
      hank: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(hankPath, JSON.stringify(hankContent, null, 2));

    // Should throw with helpful error message about unrecognized keys
    expect(() => loadHankFile({ hankPath: hankPath })).toThrow("Invalid hank file");
  });

  test("throws error on multiple typos in overrides", () => {
    const hankContent = {
      overrides: {
        modle: "opus", // Typo! Should be "model"
        dataHashTimeLimittt: 10000, // Typo! Should be "dataHashTimeLimit"
      },
      hank: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(hankPath, JSON.stringify(hankContent, null, 2));

    expect(() => loadHankFile({ hankPath: hankPath })).toThrow("Invalid hank file");
  });

  test("throws error on typos in overrides.sentinel", () => {
    const hankContent = {
      overrides: {
        model: "opus",
        sentinel: {
          enablePersistence: true,
          healthCheckGracePeriodMsss: 5000, // Typo! Should be "healthCheckGracePeriodMs"
        },
      },
      hank: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(hankPath, JSON.stringify(hankContent, null, 2));

    expect(() => loadHankFile({ hankPath: hankPath })).toThrow("Invalid hank file");
  });
});

describe("loadRuntimeConfig", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-test-runtime");
  const runtimeConfigPath = path.join(tempDir, "hankweave.json");

  beforeEach(() => {
    cleanup(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });

    // Initialize LLM Provider Registry for model validation
    const mockLogger = new Logger("/dev/null");
    LlmProviderRegistry.getInstance({
      logger: mockLogger,
      performHealthCheckOnInit: false,
    });
  });

  afterEach(() => {
    cleanup(tempDir);
    LlmProviderRegistry.resetInstance();
  });

  test("returns empty object when file doesn't exist", () => {
    const result = loadRuntimeConfig(path.join(tempDir, "nonexistent.json"));
    expect(result).toEqual({});
  });

  test("loads valid runtime config with all fields", () => {
    const runtimeContent = {
      port: 8080,
      autostart: true,
      withoutProxy: false,
      model: "opus",
      anthropicBaseUrl: "https://api.example.com",
      outputDirectory: "/tmp/output",
      executionBaseDir: "/tmp/executions",
      logParsingInterval: 2000,
      dataHashTimeLimit: 10000,
      sentinel: {
        enablePersistence: true,
        healthCheckGracePeriodMs: 5000,
        waitForAllHealthChecks: false,
      },
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));

    const result = loadRuntimeConfig(runtimeConfigPath);

    expect(result.port).toBe(8080);
    expect(result.autostart).toBe(true);
    expect(result.withoutProxy).toBe(false);
    expect(result.model).toBe("opus");
    expect(result.anthropicBaseUrl).toBe("https://api.example.com");
    expect(result.outputDirectory).toBe("/tmp/output");
    expect(result.executionBaseDir).toBe("/tmp/executions");
    expect(result.logParsingInterval).toBe(2000);
    expect(result.dataHashTimeLimit).toBe(10000);
    expect(result.sentinel).toEqual({
      enablePersistence: true,
      healthCheckGracePeriodMs: 5000,
      waitForAllHealthChecks: false,
    });
  });

  test("loads minimal runtime config with only one field", () => {
    const runtimeContent = {
      port: 9000,
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));

    const result = loadRuntimeConfig(runtimeConfigPath);

    expect(result.port).toBe(9000);
    expect(result.autostart).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  test("loads empty runtime config object", () => {
    const runtimeContent = {};

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));

    const result = loadRuntimeConfig(runtimeConfigPath);

    expect(result).toEqual({});
  });

  test("throws error for invalid JSON", () => {
    createTestFile(runtimeConfigPath, "{ invalid json }");
    expect(() => loadRuntimeConfig(runtimeConfigPath)).toThrow("Failed to load runtime config");
  });

  test("throws error for invalid port type", () => {
    const runtimeContent = {
      port: "8080", // Should be number
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
    expect(() => loadRuntimeConfig(runtimeConfigPath)).toThrow("Invalid runtime config file");
  });

  test("throws error for negative port", () => {
    const runtimeContent = {
      port: -100,
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
    expect(() => loadRuntimeConfig(runtimeConfigPath)).toThrow("Invalid runtime config file");
  });

  test("throws error for invalid model enum", () => {
    const runtimeContent = {
      model: "invalid-model-xyz",
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
    expect(() => loadRuntimeConfig(runtimeConfigPath)).toThrow("Invalid runtime config file");
  });

  test("throws error for invalid URL format", () => {
    const runtimeContent = {
      anthropicBaseUrl: "not-a-valid-url",
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
    expect(() => loadRuntimeConfig(runtimeConfigPath)).toThrow("Invalid runtime config file");
  });

  test("validates sentinel nested object", () => {
    const runtimeContent = {
      sentinel: {
        enablePersistence: true,
        healthCheckGracePeriodMs: 1000,
        waitForAllHealthChecks: true,
      },
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));

    const result = loadRuntimeConfig(runtimeConfigPath);

    expect(result.sentinel).toEqual({
      enablePersistence: true,
      healthCheckGracePeriodMs: 1000,
      waitForAllHealthChecks: true,
    });
  });

  test("throws error for invalid sentinel field type", () => {
    const runtimeContent = {
      sentinel: {
        enablePersistence: "true", // Should be boolean
      },
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
    expect(() => loadRuntimeConfig(runtimeConfigPath)).toThrow("Invalid runtime config file");
  });

  test("throws error for negative healthCheckGracePeriodMs", () => {
    const runtimeContent = {
      sentinel: {
        healthCheckGracePeriodMs: -500,
      },
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
    expect(() => loadRuntimeConfig(runtimeConfigPath)).toThrow("Invalid runtime config file");
  });

  test("allows partial sentinel config", () => {
    const runtimeContent = {
      sentinel: {
        enablePersistence: false,
        // Other fields optional
      },
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));

    const result = loadRuntimeConfig(runtimeConfigPath);

    expect(result.sentinel).toEqual({
      enablePersistence: false,
    });
  });

  test("throws error on typos in runtime config", () => {
    const runtimeContent = {
      port: 8080,
      modell: "opus", // Typo! Should be "model"
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
    expect(() => loadRuntimeConfig(runtimeConfigPath)).toThrow("Invalid runtime config file");
  });

  test("throws error on typos in runtime config sentinel", () => {
    const runtimeContent = {
      sentinel: {
        enablePersistence: true,
        healthCheckGracePeriodMss: 1000, // Typo! Should be "healthCheckGracePeriodMs"
      },
    };

    createTestFile(runtimeConfigPath, JSON.stringify(runtimeContent, null, 2));
    expect(() => loadRuntimeConfig(runtimeConfigPath)).toThrow("Invalid runtime config file");
  });
});

describe("loadHankweaveRuntimeEnvVars", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Capture current env state
    originalEnv = captureEnv();
    // Clear any HANKWEAVE_RUNTIME_ vars before each test
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("HANKWEAVE_RUNTIME_")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original env vars after each test
    restoreEnv(originalEnv);
  });

  test("returns empty object when no HANKWEAVE_RUNTIME_ env vars are set", () => {
    const result = loadHankweaveRuntimeEnvVars();
    expect(result).toEqual({});
  });

  test("parses single top-level port env var", () => {
    process.env.HANKWEAVE_RUNTIME_PORT = "8080";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.port).toBe(8080);
  });

  test("parses single top-level model env var", () => {
    process.env.HANKWEAVE_RUNTIME_MODEL = "opus";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.model).toBe("opus");
  });

  test("parses boolean autostart env var (true)", () => {
    process.env.HANKWEAVE_RUNTIME_AUTOSTART = "true";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.autostart).toBe(true);
  });

  test("parses boolean autostart env var (false)", () => {
    process.env.HANKWEAVE_RUNTIME_AUTOSTART = "false";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.autostart).toBe(false);
  });

  test("parses boolean using numeric 1", () => {
    process.env.HANKWEAVE_RUNTIME_AUTOSTART = "1";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.autostart).toBe(true);
  });

  test("parses boolean using numeric 0", () => {
    process.env.HANKWEAVE_RUNTIME_WITHOUT_PROXY = "0";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.withoutProxy).toBe(false);
  });

  test("parses multiple top-level env vars", () => {
    process.env.HANKWEAVE_RUNTIME_PORT = "9000";
    process.env.HANKWEAVE_RUNTIME_MODEL = "sonnet";
    process.env.HANKWEAVE_RUNTIME_AUTOSTART = "true";
    process.env.HANKWEAVE_RUNTIME_WITHOUT_PROXY = "false";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.port).toBe(9000);
    expect(result.model).toBe("sonnet");
    expect(result.autostart).toBe(true);
    expect(result.withoutProxy).toBe(false);
  });

  test("parses URL env var", () => {
    process.env.HANKWEAVE_RUNTIME_ANTHROPIC_BASE_URL = "https://api.example.com";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.anthropicBaseUrl).toBe("https://api.example.com");
  });

  test("parses string paths", () => {
    process.env.HANKWEAVE_RUNTIME_OUTPUT_DIRECTORY = "/tmp/output";
    process.env.HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR = "/tmp/executions";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.outputDirectory).toBe("/tmp/output");
    expect(result.executionBaseDir).toBe("/tmp/executions");
  });

  test("parses nested sentinel env vars", () => {
    process.env.HANKWEAVE_RUNTIME_SENTINEL_ENABLE_PERSISTENCE = "true";
    process.env.HANKWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS = "5000";
    process.env.HANKWEAVE_RUNTIME_SENTINEL_WAIT_FOR_ALL_HEALTH_CHECKS = "false";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.sentinel).toEqual({
      enablePersistence: true,
      healthCheckGracePeriodMs: 5000,
      waitForAllHealthChecks: false,
    });
  });

  test("parses mix of top-level and nested env vars", () => {
    process.env.HANKWEAVE_RUNTIME_PORT = "8080";
    process.env.HANKWEAVE_RUNTIME_MODEL = "opus";
    process.env.HANKWEAVE_RUNTIME_SENTINEL_ENABLE_PERSISTENCE = "true";
    process.env.HANKWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS = "3000";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.port).toBe(8080);
    expect(result.model).toBe("opus");
    expect(result.sentinel).toEqual({
      enablePersistence: true,
      healthCheckGracePeriodMs: 3000,
    });
  });

  test("converts snake_case to camelCase", () => {
    process.env.HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL = "2000";
    process.env.HANKWEAVE_RUNTIME_DATA_HASH_TIME_LIMIT = "10000";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.logParsingInterval).toBe(2000);
    expect(result.dataHashTimeLimit).toBe(10000);
  });

  test("ignores non-HANKWEAVE_RUNTIME_ prefixed env vars", () => {
    process.env.PORT = "3000";
    process.env.NODE_ENV = "test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY = "sk-ant-sentinel";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result).toEqual({});
  });

  test("ignores empty HANKWEAVE_RUNTIME_ env vars", () => {
    process.env.HANKWEAVE_RUNTIME_PORT = "";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result).toEqual({});
  });

  test("throws error for invalid number value", () => {
    process.env.HANKWEAVE_RUNTIME_PORT = "not-a-number";

    expect(() => loadHankweaveRuntimeEnvVars()).toThrow(
      'Invalid number value for port: "not-a-number"',
    );
  });

  test("throws error for invalid model enum", () => {
    process.env.HANKWEAVE_RUNTIME_MODEL = "invalid-model-xyz";

    expect(() => loadHankweaveRuntimeEnvVars()).toThrow(
      "Invalid environment variable configuration",
    );
  });

  test("throws error for invalid URL format", () => {
    process.env.HANKWEAVE_RUNTIME_ANTHROPIC_BASE_URL = "not-a-url";

    expect(() => loadHankweaveRuntimeEnvVars()).toThrow(
      "Invalid environment variable configuration",
    );
  });

  test("throws error for negative port", () => {
    process.env.HANKWEAVE_RUNTIME_PORT = "-100";

    expect(() => loadHankweaveRuntimeEnvVars()).toThrow(
      "Invalid environment variable configuration",
    );
  });

  test("throws error for negative sentinel grace period", () => {
    process.env.HANKWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS = "-500";

    expect(() => loadHankweaveRuntimeEnvVars()).toThrow(
      "Invalid environment variable configuration",
    );
  });

  test("parses boolean ignoreRigFailures env var (true)", () => {
    process.env.HANKWEAVE_RUNTIME_IGNORE_RIG_FAILURES = "true";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.ignoreRigFailures).toBe(true);
  });

  test("parses boolean ignoreRigFailures env var (false)", () => {
    process.env.HANKWEAVE_RUNTIME_IGNORE_RIG_FAILURES = "false";

    const result = loadHankweaveRuntimeEnvVars();
    expect(result.ignoreRigFailures).toBe(false);
  });

  test("handles all supported fields", () => {
    process.env.HANKWEAVE_RUNTIME_PORT = "8080";
    process.env.HANKWEAVE_RUNTIME_AUTOSTART = "true";
    process.env.HANKWEAVE_RUNTIME_WITHOUT_PROXY = "false";
    process.env.HANKWEAVE_RUNTIME_MODEL = "opus";
    process.env.HANKWEAVE_RUNTIME_ANTHROPIC_BASE_URL = "https://api.example.com";
    process.env.HANKWEAVE_RUNTIME_OUTPUT_DIRECTORY = "/tmp/output";
    process.env.HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR = "/tmp/executions";
    process.env.HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL = "2000";
    process.env.HANKWEAVE_RUNTIME_DATA_HASH_TIME_LIMIT = "10000";
    process.env.HANKWEAVE_RUNTIME_SENTINEL_ENABLE_PERSISTENCE = "true";
    process.env.HANKWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS = "5000";
    process.env.HANKWEAVE_RUNTIME_SENTINEL_WAIT_FOR_ALL_HEALTH_CHECKS = "false";

    const result = loadHankweaveRuntimeEnvVars();

    expect(result.port).toBe(8080);
    expect(result.autostart).toBe(true);
    expect(result.withoutProxy).toBe(false);
    expect(result.model).toBe("opus");
    expect(result.anthropicBaseUrl).toBe("https://api.example.com");
    expect(result.outputDirectory).toBe("/tmp/output");
    expect(result.executionBaseDir).toBe("/tmp/executions");
    expect(result.logParsingInterval).toBe(2000);
    expect(result.dataHashTimeLimit).toBe(10000);
    expect(result.sentinel).toEqual({
      enablePersistence: true,
      healthCheckGracePeriodMs: 5000,
      waitForAllHealthChecks: false,
    });
  });
});

describe("loadCodonSequence", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-test-config");
  const configPath = path.join(tempDir, "test-config.json");

  // Set up before each test
  beforeEach(() => {
    cleanup(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });

    // Initialize LLM Provider Registry for model validation
    const mockLogger = new Logger("/dev/null");
    LlmProviderRegistry.getInstance({
      logger: mockLogger,
      performHealthCheckOnInit: false,
    });
  });

  afterEach(() => {
    cleanup(tempDir);
    LlmProviderRegistry.resetInstance();
  });

  test("loads valid configuration", () => {
    // Input data (before Zod parsing) - don't type as CodonConfig since that's the output type
    const validConfig = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test prompt",
      },
    ];

    writeHankConfig(configPath, validConfig);
    const { codons: result } = loadCodonSequence({ configPath });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("codon");

    // Model is transformed to ModelInfo, so check other fields
    const codon = result[0] as import("../../server/types/types.js").Codon;
    expect(codon.id).toBe("test-codon");
    expect(codon.name).toBe("Test Codon");
    expect(codon.promptText).toBe("Test prompt");
    expect(codon.continuationMode).toBe("fresh");
    // Check that model was transformed and validated
    expect(codon.model).toBeDefined();
    expect(codon.model.modelId).toContain("opus");
  });

  test("throws on missing required fields", () => {
    const invalidConfig = [
      {
        id: "test-codon",
        // Missing name and model
        promptText: "Test prompt",
      },
    ];

    writeHankConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow();
  });

  test("throws on invalid model names", () => {
    const invalidConfig = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "invalid-model-name", // Intentionally invalid for testing
        continuationMode: "fresh",
        promptText: "Test prompt",
      },
    ];

    writeHankConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow();
  });

  test("allows model override even when codon model is invalid", () => {
    const invalidConfig = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "invalid-model-name", // Placeholder in hank file
        continuationMode: "fresh",
        promptText: "Test prompt",
      },
    ];

    writeHankConfig(configPath, invalidConfig);

    expect(() => loadCodonSequence({ configPath, modelOverride: "sonnet" })).not.toThrow();

    const { codons: result } = loadCodonSequence({ configPath, modelOverride: "sonnet" });
    expect(result).toHaveLength(1);
    const codon = result[0] as import("../../server/types/types.js").Codon;
    expect(codon.model.modelId).toContain("sonnet");
  });

  test("applies model override to codons inside loops", () => {
    const promptPath = path.join(tempDir, "prompt.md");
    createTestFile(promptPath, "Test prompt");

    const loopConfig = [
      {
        type: "loop",
        id: "test-loop",
        name: "Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "codon-1",
            name: "Codon 1",
            model: "opus",
            continuationMode: "fresh",
            promptFile: promptPath,
          },
          {
            id: "codon-2",
            name: "Codon 2",
            model: "sonnet",
            continuationMode: "fresh",
            promptFile: promptPath,
          },
        ],
      },
    ];

    writeHankConfig(configPath, loopConfig);

    const { codons: result } = loadCodonSequence({ configPath, modelOverride: "haiku" });
    expect(result).toHaveLength(1);
    const loop = result[0] as import("../../server/types/types.js").Loop;
    expect(loop.type).toBe("loop");
    for (const codon of loop.codons) {
      expect(codon.model.modelId).toContain("haiku");
    }
  });

  test("throws when model override is invalid", () => {
    const validConfig = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "sonnet",
        continuationMode: "fresh",
        promptText: "Test prompt",
      },
    ];

    writeHankConfig(configPath, validConfig);
    expect(() => loadCodonSequence({ configPath, modelOverride: "invalid-model-name" })).toThrow(
      "Invalid model",
    );
  });

  test("validates promptFile XOR promptText", () => {
    // Neither provided
    const neitherConfig = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
      },
    ];

    writeHankConfig(configPath, neitherConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow();

    // Both provided - loadCodonSequence doesn't actually validate this case, it just uses promptFile if both are provided
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    const bothConfig = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        promptText: "Test prompt",
      },
    ];

    writeHankConfig(configPath, bothConfig);
    // This actually doesn't throw - it just uses promptFile
    const { codons: result } = loadCodonSequence({ configPath });
    const codon = result[0];
    expect(codon.type).not.toBe("loop");
    if (codon.type !== "loop") {
      expect(codon.promptFile).toBeDefined();
      expect(codon.promptText).toBe("Test prompt"); // It keeps both
    }
  });

  test("validates appendSystemPromptFile XOR appendSystemPromptText", () => {
    // Both provided
    createTestFile(path.join(tempDir, "system.md"), "System prompt");
    const bothConfig = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test prompt",
        appendSystemPromptFile: "./system.md",
        appendSystemPromptText: "System prompt",
      },
    ];

    writeHankConfig(configPath, bothConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow();
  });

  test("resolves relative paths correctly", () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    writeHankConfig(configPath, config);
    const { codons: result } = loadCodonSequence({ configPath });

    const codon = result[0];
    if (codon.type !== "loop") {
      expect(codon.promptFile).toBe(path.resolve(tempDir, "prompt.md"));
    }
  });

  test("handles array of prompt files", () => {
    createTestFile(path.join(tempDir, "prompt1.md"), "Prompt 1");
    createTestFile(path.join(tempDir, "prompt2.md"), "Prompt 2");

    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: ["./prompt1.md", "./prompt2.md"],
      },
    ];

    writeHankConfig(configPath, config);
    const { codons: result } = loadCodonSequence({ configPath });

    const codon = result[0];
    if (codon.type !== "loop") {
      expect(codon.promptFile).toEqual([
        path.resolve(tempDir, "prompt1.md"),
        path.resolve(tempDir, "prompt2.md"),
      ]);
    }
  });

  test("validates rig setup items", () => {
    const invalidRigConfig = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test prompt",
        rigSetup: [
          {
            type: "invalid", // Invalid type - not "copy" or "command"
          },
        ],
      },
    ];

    writeHankConfig(configPath, invalidRigConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow();
  });

  test("throws on non-existent prompt files", () => {
    const config = [
      {
        id: "test-codon",
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./non-existent.md",
      },
    ];

    writeHankConfig(configPath, config);
    expect(() => loadCodonSequence({ configPath })).toThrow();
  });

  test("throws on unreadable files", () => {
    // Windows has no meaningful chmod, and even on POSIX `chmod 000` does not
    // reliably deny the owner: running as root ignores the mode bits, and some
    // filesystems (network shares, synced folders, containers with relaxed
    // permission emulation) do too. This test used to assume it always works
    // and flaked roughly one run in four here as a result.
    //
    // So: apply the mode, then *verify* the file is genuinely unreadable before
    // asserting. Where the OS honours it we get the real coverage; where it
    // does not we skip rather than fail on something the code never controlled.
    if (process.platform === "win32") return;

    const promptPath = path.join(tempDir, "unreadable.md");
    createTestFile(promptPath, "Test prompt");
    fs.chmodSync(promptPath, 0o000);

    let actuallyUnreadable = false;
    try {
      fs.readFileSync(promptPath, "utf-8");
    } catch {
      actuallyUnreadable = true;
    }

    try {
      if (!actuallyUnreadable) return;

      writeHankConfig(configPath, [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "opus",
          continuationMode: "fresh",
          promptFile: "./unreadable.md",
        },
      ]);

      let threw = false;
      try {
        loadCodonSequence({ configPath });
      } catch {
        threw = true;
      }
      if (!threw) {
        // TOCTOU with sync daemons (this repo lives in Dropbox): the guard
        // above saw EACCES, but the daemon can restore permissions before
        // loadCodonSequence re-reads. Only fail if the file is STILL
        // unreadable — that would mean the loader genuinely swallowed it.
        let stillUnreadable = false;
        try {
          fs.readFileSync(promptPath, "utf-8");
        } catch {
          stillUnreadable = true;
        }
        expect(stillUnreadable).toBe(false);
      }
    } finally {
      // Restore permissions so the temp dir can be cleaned up.
      fs.chmodSync(promptPath, 0o644);
    }
  });

  // -------------
  // Loop Configuration Tests
  // -------------

  test("loads loop with iterationLimit termination", () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "test-loop",
        name: "Test Loop",
        description: "A test loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 3,
        },
        codons: [
          {
            id: "loop-codon-1",
            name: "Loop Codon 1",
            model: "sonnet",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const { codons: result } = loadCodonSequence({ configPath });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "loop",
      id: "test-loop",
      name: "Test Loop",
    });

    // Check that it's a Loop type
    if (result[0].type === "loop") {
      expect(result[0].terminateOn).toEqual({
        type: "iterationLimit",
        limit: 3,
      });
      expect(result[0].codons).toHaveLength(1);
      expect(result[0].codons[0].id).toBe(CodonId("loop-codon-1"));
    } else {
      throw new Error("Expected loop type");
    }
  });

  test("loads loop with contextExceeded termination", () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        type: "loop",
        id: "context-loop",
        name: "Context Aware Loop",
        terminateOn: {
          type: "contextExceeded",
        },
        codons: [
          {
            id: "codon-1",
            name: "Codon 1",
            model: "opus",
            continuationMode: "fresh",
            promptText: "Do something",
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const { codons: result } = loadCodonSequence({ configPath });

    expect(result).toHaveLength(1);
    if (result[0].type === "loop") {
      expect(result[0].terminateOn).toEqual({
        type: "contextExceeded",
      });
    } else {
      throw new Error("Expected loop type");
    }
  });

  test("loads mixed codons and loops", () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "regular-codon",
        name: "Regular Codon",
        model: "sonnet",
        continuationMode: "fresh",
        promptText: "Regular codon",
      },
      {
        type: "loop",
        id: "test-loop",
        name: "Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "loop-codon",
            name: "Loop Codon",
            model: "sonnet",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
          },
        ],
      },
      {
        id: "another-codon",
        name: "Another Codon",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Another codon",
      },
    ];

    writeHankConfig(configPath, config);
    const { codons: result } = loadCodonSequence({ configPath });

    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("codon"); // Regular codon (defaults to "codon")
    expect(result[1].type).toBe("loop");
    expect(result[2].type).toBe("codon"); // Regular codon (defaults to "codon")
  });

  test("resolves paths in nested loop codons", () => {
    createTestFile(path.join(tempDir, "loop-prompt.md"), "Loop prompt");
    createTestFile(path.join(tempDir, "system.md"), "System prompt");

    const config = [
      {
        type: "loop",
        id: "path-test-loop",
        name: "Path Test Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 1,
        },
        codons: [
          {
            id: "nested-codon",
            name: "Nested Codon",
            model: "sonnet",
            continuationMode: "fresh",
            promptFile: "./loop-prompt.md",
            appendSystemPromptFile: "./system.md",
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const { codons: result } = loadCodonSequence({ configPath });

    expect(result).toHaveLength(1);
    if (result[0].type === "loop") {
      expect(result[0].codons[0].promptFile).toBe(path.resolve(tempDir, "loop-prompt.md"));
      expect(result[0].codons[0].appendSystemPromptFile).toBe(path.resolve(tempDir, "system.md"));
    } else {
      throw new Error("Expected loop type");
    }
  });

  test("handles multiple codons in loop", () => {
    createTestFile(path.join(tempDir, "prompt1.md"), "Prompt 1");
    createTestFile(path.join(tempDir, "prompt2.md"), "Prompt 2");

    const config = [
      {
        type: "loop",
        id: "multi-codon-loop",
        name: "Multi-Codon Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 5,
        },
        codons: [
          {
            id: "write-code",
            name: "Write Code",
            model: "sonnet",
            continuationMode: "fresh",
            promptFile: "./prompt1.md",
          },
          {
            id: "write-tests",
            name: "Write Tests",
            model: "sonnet",
            continuationMode: "continue-previous",
            promptFile: "./prompt2.md",
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const { codons: result } = loadCodonSequence({ configPath });

    expect(result).toHaveLength(1);
    if (result[0].type === "loop") {
      expect(result[0].codons).toHaveLength(2);
      expect(result[0].codons[0].id).toBe(CodonId("write-code"));
      expect(result[0].codons[1].id).toBe(CodonId("write-tests"));
      expect(result[0].codons[1].continuationMode).toBe("continue-previous");
    } else {
      throw new Error("Expected loop type");
    }
  });

  test("throws on loop missing required fields", () => {
    const invalidConfig = [
      {
        type: "loop",
        id: "incomplete-loop",
        // Missing name, terminateOn, and codons
      },
    ];

    writeHankConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow();
  });

  test("throws on loop with empty codons array", () => {
    const invalidConfig = [
      {
        type: "loop",
        id: "empty-loop",
        name: "Empty Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 1,
        },
        codons: [], // Empty array not allowed
      },
    ];

    writeHankConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow("at least one codon");
  });

  test("throws on loop with invalid termination type", () => {
    const invalidConfig = [
      {
        type: "loop",
        id: "invalid-termination",
        name: "Invalid Termination",
        terminateOn: {
          type: "invalidType", // Not a valid termination type
        },
        codons: [
          {
            id: "codon-1",
            name: "Codon 1",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "Test",
          },
        ],
      },
    ];

    writeHankConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow();
  });

  test("throws on iterationLimit with invalid limit", () => {
    const invalidConfig = [
      {
        type: "loop",
        id: "invalid-limit",
        name: "Invalid Limit",
        terminateOn: {
          type: "iterationLimit",
          limit: 0, // Must be at least 1
        },
        codons: [
          {
            id: "codon-1",
            name: "Codon 1",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "Test",
          },
        ],
      },
    ];

    writeHankConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow("at least 1");
  });

  test("throws on nested loops", () => {
    const invalidConfig = [
      {
        type: "loop",
        id: "outer-loop",
        name: "Outer Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            type: "loop", // Nested loop - not allowed
            id: "inner-loop",
            name: "Inner Loop",
            terminateOn: {
              type: "iterationLimit",
              limit: 1,
            },
            codons: [
              {
                id: "nested-codon",
                name: "Nested Codon",
                model: "sonnet",
                continuationMode: "fresh",
                promptText: "Test",
              },
            ],
          },
        ],
      },
    ];

    writeHankConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow();
  });

  test("throws on loop codon missing promptFile or promptText", () => {
    const invalidConfig = [
      {
        type: "loop",
        id: "incomplete-codon-loop",
        name: "Incomplete Codon Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 1,
        },
        codons: [
          {
            id: "incomplete-codon",
            name: "Incomplete Codon",
            model: "sonnet",
            continuationMode: "fresh",
            // Missing promptFile or promptText
          },
        ],
      },
    ];

    writeHankConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow();
  });

  test("throws on non-existent prompt file in loop codon", () => {
    const invalidConfig = [
      {
        type: "loop",
        id: "missing-file-loop",
        name: "Missing File Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 1,
        },
        codons: [
          {
            id: "codon-1",
            name: "Codon 1",
            model: "sonnet",
            continuationMode: "fresh",
            promptFile: "./non-existent.md", // File doesn't exist
          },
        ],
      },
    ];

    writeHankConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence({ configPath })).toThrow();
  });

  test("allows rigSetup in loop codons", () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    createTestFile(path.join(tempDir, "source.txt"), "Source");

    const config = [
      {
        type: "loop",
        id: "rig-setup-loop",
        name: "Rig Setup Loop",
        terminateOn: {
          type: "iterationLimit",
          limit: 2,
        },
        codons: [
          {
            id: "setup-codon",
            name: "Setup Codon",
            model: "sonnet",
            continuationMode: "fresh",
            promptFile: "./prompt.md",
            rigSetup: [
              {
                type: "copy",
                copy: {
                  from: "./source.txt",
                  to: "target.txt",
                },
                allowFailure: true,
              },
            ],
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const { codons: result } = loadCodonSequence({ configPath });

    // Should load successfully
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("loop");
    if (result[0].type === "loop") {
      expect(result[0].codons[0].rigSetup).toHaveLength(1);
      expect(result[0].codons[0].rigSetup?.[0].allowFailure).toBe(true);
    }
  });

  test("allows rigSetup in top-level codons", () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    createTestFile(path.join(tempDir, "source.txt"), "Source");

    const config = [
      {
        id: "setup-codon",
        name: "Setup Codon",
        model: "sonnet",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        rigSetup: [
          {
            type: "copy",
            copy: {
              from: "./source.txt",
              to: "target.txt",
            },
          },
        ],
      },
    ];

    writeHankConfig(configPath, config);
    const { codons: result } = loadCodonSequence({ configPath });

    expect(result).toHaveLength(1);
    const codon = result[0];
    if (codon.type !== "loop") {
      expect(codon.rigSetup).toHaveLength(1);
    }
  });
});

// -------------
// ENG-121: Required Environment Variables Tests
// -------------

import { hankFileSchema, validateRequiredEnv } from "../../server/config";

describe("validateRequiredEnv (ENG-121)", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = captureEnv();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  test("should pass when all required keys are present", () => {
    process.env.TEST_KEY_1 = "value1";
    process.env.TEST_KEY_2 = "value2";

    const result = validateRequiredEnv(["TEST_KEY_1", "TEST_KEY_2"]);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  test("should fail with missing keys", () => {
    process.env.TEST_KEY_1 = "value1";
    delete process.env.TEST_KEY_2;

    const result = validateRequiredEnv(["TEST_KEY_1", "TEST_KEY_2"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("TEST_KEY_2");
  });

  test("should treat empty string as missing", () => {
    process.env.EMPTY_KEY = "";

    const result = validateRequiredEnv(["EMPTY_KEY"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("EMPTY_KEY");
  });

  test("should pass with empty array", () => {
    const result = validateRequiredEnv([]);
    expect(result.valid).toBe(true);
  });

  test("should pass with undefined", () => {
    const result = validateRequiredEnv(undefined);
    expect(result.valid).toBe(true);
  });

  test("should accept HANKWEAVE_ prefixed env vars", () => {
    // Required key is "API_KEY", but user sets HANKWEAVE_API_KEY
    delete process.env.API_KEY;
    process.env.HANKWEAVE_API_KEY = "prefixed-value";

    const result = validateRequiredEnv(["API_KEY"]);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  test("should prefer direct env var over prefixed version", () => {
    // Both set - direct value should be used (doesn't matter for validation, but documents behavior)
    process.env.API_KEY = "direct-value";
    process.env.HANKWEAVE_API_KEY = "prefixed-value";

    const result = validateRequiredEnv(["API_KEY"]);
    expect(result.valid).toBe(true);
  });

  test("should fail when neither direct nor prefixed var is set", () => {
    delete process.env.MISSING_KEY;
    delete process.env.HANKWEAVE_MISSING_KEY;

    const result = validateRequiredEnv(["MISSING_KEY"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("MISSING_KEY");
  });

  test("should treat empty prefixed var as missing", () => {
    delete process.env.EMPTY_PREFIXED;
    process.env.HANKWEAVE_EMPTY_PREFIXED = "";

    const result = validateRequiredEnv(["EMPTY_PREFIXED"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("EMPTY_PREFIXED");
  });
});

// Minimal valid codon for schema tests (schema requires at least one codon)
const MINIMAL_CODON = {
  id: "test",
  name: "Test",
  model: "sonnet",
  continuationMode: "fresh" as const,
  promptText: "Test",
};

describe("hankFileSchema with requirements (ENG-121)", () => {
  test("should accept valid requirements.env", () => {
    const config = {
      requirements: {
        env: ["ANTHROPIC_API_KEY", "CUSTOM_KEY"],
      },
      hank: [MINIMAL_CODON],
    };

    expect(() => hankFileSchema.parse(config)).not.toThrow();
  });

  test("should reject non-string values in env array", () => {
    const config = {
      requirements: {
        env: ["VALID_KEY", 123],
      },
      hank: [MINIMAL_CODON],
    };

    expect(() => hankFileSchema.parse(config)).toThrow();
  });

  test("should reject empty string env names after trim", () => {
    const config = {
      requirements: {
        env: ["VALID_KEY", "   "],
      },
      hank: [MINIMAL_CODON],
    };

    expect(() => hankFileSchema.parse(config)).toThrow(/empty/i);
  });

  test("should trim whitespace from env variable names", () => {
    // Schema should transform "  API_KEY  " to "API_KEY"
    const config = {
      requirements: {
        env: ["  ANTHROPIC_API_KEY  ", "SOME_KEY"],
      },
      hank: [MINIMAL_CODON],
    };

    const result = hankFileSchema.parse(config);
    expect(result.requirements?.env?.[0]).toBe("ANTHROPIC_API_KEY");
  });
});

describe("autoCompact codon field (intermediates/55)", () => {
  test("accepts autoCompact: true and preserves it through parsing", () => {
    const config = { hank: [{ ...MINIMAL_CODON, autoCompact: true }] };
    const parsed = hankFileSchema.parse(config);
    const codon = parsed.hank[0];
    expect(codon.type).toBe("codon");
    if (codon.type === "codon") expect(codon.autoCompact).toBe(true);
  });

  test("defaults to undefined when omitted (compaction off)", () => {
    const parsed = hankFileSchema.parse({ hank: [MINIMAL_CODON] });
    const codon = parsed.hank[0];
    if (codon.type === "codon") expect(codon.autoCompact).toBeUndefined();
  });

  test("rejects non-boolean autoCompact", () => {
    const config = { hank: [{ ...MINIMAL_CODON, autoCompact: "yes" }] };
    expect(() => hankFileSchema.parse(config)).toThrow();
  });

  test("accepts autoCompact on codons inside loops", () => {
    const config = {
      hank: [
        MINIMAL_CODON,
        {
          type: "loop",
          id: "loop-1",
          name: "Loop",
          terminateOn: { type: "iterationLimit", limit: 2 },
          codons: [{ ...MINIMAL_CODON, id: "inner", autoCompact: true }],
        },
      ],
    };
    expect(() => hankFileSchema.parse(config)).not.toThrow();
  });
});

// -------------
// ENG-122: Global System Prompts Tests
// -------------

import { loadGlobalSystemPrompt } from "../../server/config";

describe("global system prompt schema (ENG-122)", () => {
  test("should accept globalSystemPromptFile", () => {
    const config = {
      globalSystemPromptFile: "./system-prompt.md",
      hank: [MINIMAL_CODON],
    };
    expect(() => hankFileSchema.parse(config)).not.toThrow();
  });

  test("should accept globalSystemPromptText", () => {
    const config = {
      globalSystemPromptText: "You are a helpful assistant.",
      hank: [MINIMAL_CODON],
    };
    expect(() => hankFileSchema.parse(config)).not.toThrow();
  });

  test("should reject both file and text", () => {
    const config = {
      globalSystemPromptFile: "./system-prompt.md",
      globalSystemPromptText: "Conflicting prompt",
      hank: [MINIMAL_CODON],
    };
    expect(() => hankFileSchema.parse(config)).toThrow(/both/i);
  });

  test("should accept array of files", () => {
    const config = {
      globalSystemPromptFile: ["./part1.md", "./part2.md"],
      hank: [MINIMAL_CODON],
    };
    expect(() => hankFileSchema.parse(config)).not.toThrow();
  });
});

describe("loadGlobalSystemPrompt (ENG-122)", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-global-prompt-test");

  beforeEach(() => {
    cleanup(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  test("should load from file path", () => {
    const promptFile = path.join(tempDir, "prompt.md");
    fs.writeFileSync(promptFile, "Global instructions here.");

    const result = loadGlobalSystemPrompt(
      { globalSystemPromptFile: "prompt.md", hank: [] },
      tempDir,
    );

    expect(result).toBe("Global instructions here.");
  });

  test("should return text directly", () => {
    const result = loadGlobalSystemPrompt(
      { globalSystemPromptText: "Inline prompt", hank: [] },
      tempDir,
    );

    expect(result).toBe("Inline prompt");
  });

  test("should concatenate multiple files", () => {
    fs.writeFileSync(path.join(tempDir, "p1.md"), "Part 1");
    fs.writeFileSync(path.join(tempDir, "p2.md"), "Part 2");

    const result = loadGlobalSystemPrompt(
      { globalSystemPromptFile: ["p1.md", "p2.md"], hank: [] },
      tempDir,
    );

    expect(result).toBe("Part 1\n\nPart 2");
  });

  test("should return null when no global prompt configured", () => {
    const result = loadGlobalSystemPrompt({ hank: [] }, tempDir);
    expect(result).toBeNull();
  });

  test("should throw error when file does not exist", () => {
    expect(() =>
      loadGlobalSystemPrompt({ globalSystemPromptFile: "nonexistent.md", hank: [] }, tempDir),
    ).toThrow(/not found/i);
  });

  test("should preserve template variables in loaded content", () => {
    // Template variables like <%EXECUTION_DIR%> should NOT be replaced at load time
    const promptFile = path.join(tempDir, "templated.md");
    fs.writeFileSync(promptFile, "Working in <%EXECUTION_DIR%> with data from <%DATA_DIR%>");

    const result = loadGlobalSystemPrompt(
      { globalSystemPromptFile: "templated.md", hank: [] },
      tempDir,
    );

    // Template variables should be intact (replacement happens at runtime)
    expect(result).toContain("<%EXECUTION_DIR%>");
    expect(result).toContain("<%DATA_DIR%>");
  });
});

// -------------
// Loop-level budget shares: unknown ID validation
// -------------

describe("loop-level budget shares validation", () => {
  test("should reject loop budget shares referencing unknown codon IDs", () => {
    const config = {
      hank: [
        {
          type: "loop" as const,
          id: "my-loop",
          name: "My Loop",
          terminateOn: { type: "iterationLimit" as const, limit: 2 },
          codons: [MINIMAL_CODON],
          budget: {
            maxDollars: 10,
            allocation: "proportional",
            shares: { "nonexistent-id": 1 },
          },
        },
      ],
    };

    expect(() => hankFileSchema.parse(config)).toThrow(/unknown child IDs.*nonexistent-id/i);
  });
});

describe("self-test failure classification & guidance", () => {
  function makeResult(overrides: Partial<ShimSelfTestResult>): ShimSelfTestResult {
    return {
      shim: { name: "pi", version: "1.0.0" },
      agent: { name: "pi", version: "1.0.0", found: true },
      checks: [],
      overall: { passed: false, message: "fail" },
      ...overrides,
    };
  }

  test("classifies a missing agent binary as binary-missing", () => {
    const result = makeResult({ agent: { name: "pi", version: "unknown", found: false } });
    expect(classifyInBandSelfTest(result)).toBe("binary-missing");
  });

  test("classifies a failed api_key check as auth", () => {
    const result = makeResult({
      checks: [{ name: "api_key", passed: false, message: "no key" }],
    });
    expect(classifyInBandSelfTest(result)).toBe("auth");
  });

  test("classifies other check failures as check", () => {
    const result = makeResult({
      checks: [{ name: "model_registry", passed: false, message: "no models" }],
    });
    expect(classifyInBandSelfTest(result)).toBe("check");
  });

  test("launch guidance points at the captured output, never at API keys", () => {
    const guidance = buildSelfTestGuidance(new Set(["launch"]));
    expect(guidance).toContain("failed to start");
    expect(guidance).not.toMatch(/API key/i);
  });

  test("auth guidance mentions credentials", () => {
    const guidance = buildSelfTestGuidance(new Set(["auth"]));
    expect(guidance).toMatch(/API keys|credentials/i);
  });

  test("binary-missing guidance defers to the per-model message, not a false PATH claim", () => {
    const guidance = buildSelfTestGuidance(new Set(["binary-missing"]));
    expect(guidance).toMatch(/could not be located/i);
    expect(guidance).toMatch(/see the message above/i);
    // Must NOT prescribe PATH — most shims don't resolve their agent from PATH.
    expect(guidance).not.toMatch(/on your PATH/i);
  });

  test("plain check/unknown failures add no extra guidance", () => {
    expect(buildSelfTestGuidance(new Set(["check"]))).toBe("");
    expect(buildSelfTestGuidance(new Set(["unknown"]))).toBe("");
  });
});

describe("formatFailedSelfTest", () => {
  const base = {
    modelName: "Gemini 3.5 Flash",
    provider: "google",
    modelId: "gemini-3.5-flash",
  };

  test("surfaces each failed check's message under the header", () => {
    const out = formatFailedSelfTest({
      ...base,
      result: {
        shim: { name: "gemini-shim", version: "1.0.0" },
        agent: { name: "gemini", version: "unknown", found: false },
        checks: [
          {
            name: "agent_found",
            passed: false,
            message: "Gemini CLI ('gemini') not found on PATH (searched via which)",
          },
          { name: "auth_configured", passed: true, message: "ok" },
        ],
        overall: { passed: false, message: "One or more checks failed" },
      },
    });
    expect(out).toContain("Gemini 3.5 Flash (google/gemini-3.5-flash): One or more checks failed");
    // The specific, actionable check message is surfaced...
    expect(out).toContain(
      "• agent_found: Gemini CLI ('gemini') not found on PATH (searched via which)",
    );
    // ...and passing checks are not listed.
    expect(out).not.toContain("auth_configured");
  });

  test("launch failures (no checks) show only the header with the actionable overall message", () => {
    const out = formatFailedSelfTest({
      ...base,
      provider: "pi",
      modelId: "pi/google/gemini-3.5-flash",
      result: {
        shim: { name: "unknown", version: "unknown" },
        agent: { name: "unknown", version: "unknown", found: false },
        checks: [],
        overall: { passed: false, message: "`pi` requires Node ≥ 22.19.0; found v20.12.2" },
      },
    });
    expect(out).toBe(
      "  - Gemini 3.5 Flash (pi/pi/google/gemini-3.5-flash): `pi` requires Node ≥ 22.19.0; found v20.12.2",
    );
    expect(out).not.toContain("•");
  });
});
