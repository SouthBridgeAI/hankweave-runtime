import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadCodonSequence,
  loadRuntimeConfig,
  loadStrandFile,
  loadStrandweaveRuntimeEnvVars,
  validateStrand,
} from "../../server/config";
import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry";
import { CodonId } from "../../server/types/branded-types";
import type { ModelName } from "../../server/types/types";
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
 * Helper to write a strand config file in the correct object format.
 * Uses unknown type to allow test data with plain strings instead of branded types.
 */
const writeStrandConfig = (filePath: string, codons: unknown[]) => {
  const strandFile = { strand: codons };
  fs.writeFileSync(filePath, JSON.stringify(strandFile, null, 2));
};

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

        writeStrandConfig(configPath, config);
        const result = loadCodonSequence(configPath);

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

        writeStrandConfig(configPath, config);
        const result = loadCodonSequence(configPath);

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

      writeStrandConfig(configPath, config);
      expect(() => loadCodonSequence(configPath)).toThrow("Invalid model");
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

      writeStrandConfig(configPath, config);
      expect(() => loadCodonSequence(configPath)).toThrow();
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

      writeStrandConfig(configPath, config);
      expect(() => loadCodonSequence(configPath)).toThrow("Invalid model");
    });
  });

  describe("in strandRecommendationsSchema (keeps as string)", () => {
    const tempDir = path.resolve("tests", "test-area", "temp-recommendations-model-test");
    const strandPath = path.join(tempDir, "test-strand.json");

    beforeEach(() => {
      cleanup(tempDir);
      fs.mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    test("accepts valid model in recommendations", () => {
      const models = ["sonnet", "opus", "haiku"];

      for (const model of models) {
        const strandContent = {
          recommendations: {
            model,
          },
          strand: [
            {
              id: "test-codon",
              name: "Test Codon",
              model: "sonnet" as ModelName,
              continuationMode: "fresh" as const,
              promptText: "Test prompt",
            },
          ],
        };

        createTestFile(strandPath, JSON.stringify(strandContent, null, 2));
        const result = loadStrandFile(strandPath);

        // Model should stay as string in recommendations
        expect(result.recommendations?.model).toBe(model);
        expect(typeof result.recommendations?.model).toBe("string");
      }
    });

    test("throws error for invalid model in recommendations", () => {
      const strandContent = {
        recommendations: {
          model: "gpt-4-turbo",
        },
        strand: [
          {
            id: "test-codon",
            name: "Test Codon",
            model: "sonnet" as ModelName,
            continuationMode: "fresh" as const,
            promptText: "Test prompt",
          },
        ],
      };

      createTestFile(strandPath, JSON.stringify(strandContent, null, 2));
      expect(() => loadStrandFile(strandPath)).toThrow("Invalid");
    });

    test("allows undefined model in recommendations", () => {
      const strandContent = {
        recommendations: {
          dataHashTimeLimit: 5000,
          // No model field
        },
        strand: [
          {
            id: "test-codon",
            name: "Test Codon",
            model: "sonnet" as ModelName,
            continuationMode: "fresh" as const,
            promptText: "Test prompt",
          },
        ],
      };

      createTestFile(strandPath, JSON.stringify(strandContent, null, 2));
      const result = loadStrandFile(strandPath);

      expect(result.recommendations?.model).toBeUndefined();
    });
  });

  describe("in runtimeConfigSchema (keeps as string)", () => {
    const tempDir = path.resolve("tests", "test-area", "temp-runtime-model-test");
    const runtimeConfigPath = path.join(tempDir, "strandweave.json");

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

      writeStrandConfig(configPath, config);

      try {
        loadCodonSequence(configPath);
        throw new Error("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain("Invalid model");
        expect(message).toContain("nonexistent-model");
      }
    });
  });
});

describe("validateStrand", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-validation-test");
  const configPath = path.join(tempDir, "validate-config.json");
  const projectPath = path.join(tempDir, "project");
  let testLogger: Logger;

  // Set up before each test
  beforeEach(() => {
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
  });

  afterEach(() => {
    cleanup(tempDir);
    LlmProviderRegistry.resetInstance();
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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
        trackedFiles: ["*.md"],
      },
      {
        id: "codon-2",
        name: "Second Codon",
        model: "opus", // Same model for continue-previous
        continuationMode: "continue-previous",
        promptFile: "./prompt2.md",
        appendSystemPromptFile: "./system.md",
        trackedFiles: ["*.js"],
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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

    writeStrandConfig(configPath, config);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow(
      "Duplicate codon ID",
    );
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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

    writeStrandConfig(configPath, config);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow(
      "Invalid target path",
    );
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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
        // No trackedFiles
      },
      {
        id: "codon-2",
        name: "Second Codon",
        model: "opus", // Same model for continue-previous
        continuationMode: "continue-previous",
        promptFile: "./prompt.md",
      },
    ];

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("doesn't track any files");
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
            // No trackedFiles - this is the last codon in the loop
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Continues from previous loop");
    expect(result.warnings[0]).toContain("whose last codon");
    expect(result.warnings[0]).toContain("doesn't track any files");
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

    writeStrandConfig(configPath, config);
    // Union schema reports "Invalid input" at top level, nested errors contain "Command cannot be empty"
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow(
      "Failed to load codon config",
    );
  });

  test("delegates to loadCodonSequence for basic validation", async () => {
    const invalidConfig = [
      {
        // Missing required fields
        promptText: "Test prompt",
      },
    ];

    writeStrandConfig(configPath, invalidConfig);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow();
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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

    writeStrandConfig(configPath, config);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow(
      "Duplicate codon ID",
    );
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

    writeStrandConfig(configPath, config);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow("Duplicate");
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

    writeStrandConfig(configPath, config);
    expect(() => loadCodonSequence(configPath)).toThrow(
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

    // Should not throw, but should have warnings
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w: string) => w.includes("allowFailure"))).toBe(true);
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

    writeStrandConfig(configPath, config);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow(
      /contextExceeded.*fresh.*infinite/i,
    );
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

    writeStrandConfig(configPath, config);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow(
      /contextExceeded.*fresh.*infinite/i,
    );
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);
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

    writeStrandConfig(configPath, config);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow(
      /continue-previous.*contextExceeded.*context.*exhausted/i,
    );
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);
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

    writeStrandConfig(configPath, config);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow(
      /continue-previous.*model differs.*session ID/i,
    );
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

    writeStrandConfig(configPath, config);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow(
      /continue-previous.*model differs.*session ID/i,
    );
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

    writeStrandConfig(configPath, config);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow(
      /continue-previous.*model differs.*session ID/i,
    );
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

    writeStrandConfig(configPath, config);
    await expect(validateStrand(configPath, projectPath, testLogger)).rejects.toThrow(
      /continue-previous.*model differs.*previous codon in loop.*session ID/i,
    );
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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
  }, 10_000); // 10 second timeout for self-tests

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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

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
  }, 10_000); // 10 second timeout for self-tests

  test("adds warnings when self-tests fail", async () => {
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

    writeStrandConfig(configPath, config);
    const result = await validateStrand(configPath, projectPath, testLogger);

    // Check shimSelfTests structure
    expect(result.shimSelfTests).toBeDefined();

    // Type guard to ensure shimSelfTests exists
    if (!result.shimSelfTests) {
      throw new Error("shimSelfTests should be defined");
    }

    // If any self-test failed, there should be a warning
    const failedTests = result.shimSelfTests.filter((test) => !test.passed);
    if (failedTests.length > 0) {
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes("Self-test failed"))).toBe(true);
    }
  }, 10_000); // 10 second timeout for self-tests
});

describe("loadStrandFile", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-test-strand");
  const strandPath = path.join(tempDir, "test-strand.json");

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

  test("loads valid strand file with all fields", () => {
    const strandContent = {
      meta: {
        name: "Test Strand",
        version: "1.0.0",
        description: "A test strand",
        author: "Test Author",
      },
      recommendations: {
        model: "sonnet" as ModelName,
        dataHashTimeLimit: 10000,
        sentinel: {
          enablePersistence: false,
          healthCheckGracePeriodMs: 1000,
          waitForAllHealthChecks: true,
        },
      },
      strand: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(strandPath, JSON.stringify(strandContent, null, 2));

    const result = loadStrandFile(strandPath);

    expect(result.meta).toEqual(strandContent.meta);
    // Check recommendations fields (model stays as string)
    expect(result.recommendations?.model).toBe("sonnet");
    expect(result.recommendations?.dataHashTimeLimit).toBe(10000);
    expect(result.recommendations?.sentinel).toEqual(strandContent.recommendations.sentinel);
    expect(result.strand).toHaveLength(1);
    expect(result.strand[0].id).toBe("test-codon");
  });

  test("loads strand file with only strand array (minimal)", () => {
    const strandContent = {
      strand: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(strandPath, JSON.stringify(strandContent, null, 2));

    const result = loadStrandFile(strandPath);

    expect(result.meta).toBeUndefined();
    expect(result.recommendations).toBeUndefined();
    expect(result.strand).toHaveLength(1);
  });

  test("throws error for missing file", () => {
    expect(() => loadStrandFile("/nonexistent/strand.json")).toThrow("Strand file not found");
  });

  test("throws error for invalid JSON", () => {
    createTestFile(strandPath, "{ invalid json }");
    expect(() => loadStrandFile(strandPath)).toThrow();
  });

  test("throws error for missing strand array", () => {
    const strandContent = {
      meta: {
        name: "Test Strand",
        version: "1.0.0",
      },
      // Missing strand array
    };

    createTestFile(strandPath, JSON.stringify(strandContent, null, 2));
    expect(() => loadStrandFile(strandPath)).toThrow("Invalid strand file");
  });

  test("throws error for empty meta name", () => {
    const strandContent = {
      meta: {
        name: "",
        version: "1.0.0",
      },
      strand: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(strandPath, JSON.stringify(strandContent, null, 2));
    expect(() => loadStrandFile(strandPath)).toThrow();
  });

  test("validates recommendations model enum", () => {
    const strandContent = {
      recommendations: {
        model: "invalid-model", // Invalid model
      },
      strand: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(strandPath, JSON.stringify(strandContent, null, 2));
    expect(() => loadStrandFile(strandPath)).toThrow("Invalid strand file");
  });

  test("throws error on typos in recommendations", () => {
    // With .strict() mode enabled, typos in recommendations are caught
    // and users get immediate feedback instead of silent failures.
    const strandContent = {
      recommendations: {
        modle: "opus", // Typo! Should be "model"
        dataHashTimeLimit: 10000, // Valid field
      },
      strand: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(strandPath, JSON.stringify(strandContent, null, 2));

    // Should throw with helpful error message about unrecognized keys
    expect(() => loadStrandFile(strandPath)).toThrow("Invalid strand file");
  });

  test("throws error on multiple typos in recommendations", () => {
    const strandContent = {
      recommendations: {
        modle: "opus", // Typo! Should be "model"
        dataHashTimeLimittt: 10000, // Typo! Should be "dataHashTimeLimit"
      },
      strand: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(strandPath, JSON.stringify(strandContent, null, 2));

    expect(() => loadStrandFile(strandPath)).toThrow("Invalid strand file");
  });

  test("throws error on typos in recommendations.sentinel", () => {
    const strandContent = {
      recommendations: {
        model: "opus",
        sentinel: {
          enablePersistence: true,
          healthCheckGracePeriodMsss: 5000, // Typo! Should be "healthCheckGracePeriodMs"
        },
      },
      strand: [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "sonnet" as ModelName,
          continuationMode: "fresh" as const,
          promptText: "Test prompt",
        },
      ],
    };

    createTestFile(strandPath, JSON.stringify(strandContent, null, 2));

    expect(() => loadStrandFile(strandPath)).toThrow("Invalid strand file");
  });
});

describe("loadRuntimeConfig", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-test-runtime");
  const runtimeConfigPath = path.join(tempDir, "strandweave.json");

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
      model: "gpt-4", // Only "sonnet" and "opus" are valid
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

describe("loadStrandweaveRuntimeEnvVars", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Capture current env state
    originalEnv = captureEnv();
    // Clear any STRANDWEAVE_RUNTIME_ vars before each test
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("STRANDWEAVE_RUNTIME_")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original env vars after each test
    restoreEnv(originalEnv);
  });

  test("returns empty object when no STRANDWEAVE_RUNTIME_ env vars are set", () => {
    const result = loadStrandweaveRuntimeEnvVars();
    expect(result).toEqual({});
  });

  test("parses single top-level port env var", () => {
    process.env.STRANDWEAVE_RUNTIME_PORT = "8080";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.port).toBe(8080);
  });

  test("parses single top-level model env var", () => {
    process.env.STRANDWEAVE_RUNTIME_MODEL = "opus";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.model).toBe("opus");
  });

  test("parses boolean autostart env var (true)", () => {
    process.env.STRANDWEAVE_RUNTIME_AUTOSTART = "true";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.autostart).toBe(true);
  });

  test("parses boolean autostart env var (false)", () => {
    process.env.STRANDWEAVE_RUNTIME_AUTOSTART = "false";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.autostart).toBe(false);
  });

  test("parses boolean using numeric 1", () => {
    process.env.STRANDWEAVE_RUNTIME_AUTOSTART = "1";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.autostart).toBe(true);
  });

  test("parses boolean using numeric 0", () => {
    process.env.STRANDWEAVE_RUNTIME_WITHOUT_PROXY = "0";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.withoutProxy).toBe(false);
  });

  test("parses multiple top-level env vars", () => {
    process.env.STRANDWEAVE_RUNTIME_PORT = "9000";
    process.env.STRANDWEAVE_RUNTIME_MODEL = "sonnet";
    process.env.STRANDWEAVE_RUNTIME_AUTOSTART = "true";
    process.env.STRANDWEAVE_RUNTIME_WITHOUT_PROXY = "false";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.port).toBe(9000);
    expect(result.model).toBe("sonnet");
    expect(result.autostart).toBe(true);
    expect(result.withoutProxy).toBe(false);
  });

  test("parses URL env var", () => {
    process.env.STRANDWEAVE_RUNTIME_ANTHROPIC_BASE_URL = "https://api.example.com";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.anthropicBaseUrl).toBe("https://api.example.com");
  });

  test("parses string paths", () => {
    process.env.STRANDWEAVE_RUNTIME_OUTPUT_DIRECTORY = "/tmp/output";
    process.env.STRANDWEAVE_RUNTIME_EXECUTION_BASE_DIR = "/tmp/executions";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.outputDirectory).toBe("/tmp/output");
    expect(result.executionBaseDir).toBe("/tmp/executions");
  });

  test("parses nested sentinel env vars", () => {
    process.env.STRANDWEAVE_RUNTIME_SENTINEL_ENABLE_PERSISTENCE = "true";
    process.env.STRANDWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS = "5000";
    process.env.STRANDWEAVE_RUNTIME_SENTINEL_WAIT_FOR_ALL_HEALTH_CHECKS = "false";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.sentinel).toEqual({
      enablePersistence: true,
      healthCheckGracePeriodMs: 5000,
      waitForAllHealthChecks: false,
    });
  });

  test("parses mix of top-level and nested env vars", () => {
    process.env.STRANDWEAVE_RUNTIME_PORT = "8080";
    process.env.STRANDWEAVE_RUNTIME_MODEL = "opus";
    process.env.STRANDWEAVE_RUNTIME_SENTINEL_ENABLE_PERSISTENCE = "true";
    process.env.STRANDWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS = "3000";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.port).toBe(8080);
    expect(result.model).toBe("opus");
    expect(result.sentinel).toEqual({
      enablePersistence: true,
      healthCheckGracePeriodMs: 3000,
    });
  });

  test("converts snake_case to camelCase", () => {
    process.env.STRANDWEAVE_RUNTIME_LOG_PARSING_INTERVAL = "2000";
    process.env.STRANDWEAVE_RUNTIME_DATA_HASH_TIME_LIMIT = "10000";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result.logParsingInterval).toBe(2000);
    expect(result.dataHashTimeLimit).toBe(10000);
  });

  test("ignores non-STRANDWEAVE_RUNTIME_ prefixed env vars", () => {
    process.env.PORT = "3000";
    process.env.NODE_ENV = "test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY = "sk-ant-sentinel";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result).toEqual({});
  });

  test("ignores empty STRANDWEAVE_RUNTIME_ env vars", () => {
    process.env.STRANDWEAVE_RUNTIME_PORT = "";

    const result = loadStrandweaveRuntimeEnvVars();
    expect(result).toEqual({});
  });

  test("throws error for invalid number value", () => {
    process.env.STRANDWEAVE_RUNTIME_PORT = "not-a-number";

    expect(() => loadStrandweaveRuntimeEnvVars()).toThrow(
      'Invalid number value for port: "not-a-number"',
    );
  });

  test("throws error for invalid model enum", () => {
    process.env.STRANDWEAVE_RUNTIME_MODEL = "gpt-4";

    expect(() => loadStrandweaveRuntimeEnvVars()).toThrow(
      "Invalid environment variable configuration",
    );
  });

  test("throws error for invalid URL format", () => {
    process.env.STRANDWEAVE_RUNTIME_ANTHROPIC_BASE_URL = "not-a-url";

    expect(() => loadStrandweaveRuntimeEnvVars()).toThrow(
      "Invalid environment variable configuration",
    );
  });

  test("throws error for negative port", () => {
    process.env.STRANDWEAVE_RUNTIME_PORT = "-100";

    expect(() => loadStrandweaveRuntimeEnvVars()).toThrow(
      "Invalid environment variable configuration",
    );
  });

  test("throws error for negative sentinel grace period", () => {
    process.env.STRANDWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS = "-500";

    expect(() => loadStrandweaveRuntimeEnvVars()).toThrow(
      "Invalid environment variable configuration",
    );
  });

  test("handles all supported fields", () => {
    process.env.STRANDWEAVE_RUNTIME_PORT = "8080";
    process.env.STRANDWEAVE_RUNTIME_AUTOSTART = "true";
    process.env.STRANDWEAVE_RUNTIME_WITHOUT_PROXY = "false";
    process.env.STRANDWEAVE_RUNTIME_MODEL = "opus";
    process.env.STRANDWEAVE_RUNTIME_ANTHROPIC_BASE_URL = "https://api.example.com";
    process.env.STRANDWEAVE_RUNTIME_OUTPUT_DIRECTORY = "/tmp/output";
    process.env.STRANDWEAVE_RUNTIME_EXECUTION_BASE_DIR = "/tmp/executions";
    process.env.STRANDWEAVE_RUNTIME_LOG_PARSING_INTERVAL = "2000";
    process.env.STRANDWEAVE_RUNTIME_DATA_HASH_TIME_LIMIT = "10000";
    process.env.STRANDWEAVE_RUNTIME_SENTINEL_ENABLE_PERSISTENCE = "true";
    process.env.STRANDWEAVE_RUNTIME_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS = "5000";
    process.env.STRANDWEAVE_RUNTIME_SENTINEL_WAIT_FOR_ALL_HEALTH_CHECKS = "false";

    const result = loadStrandweaveRuntimeEnvVars();

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

    writeStrandConfig(configPath, validConfig);
    const result = loadCodonSequence(configPath);

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

    writeStrandConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence(configPath)).toThrow();
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

    writeStrandConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence(configPath)).toThrow();
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

    writeStrandConfig(configPath, neitherConfig);
    expect(() => loadCodonSequence(configPath)).toThrow();

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

    writeStrandConfig(configPath, bothConfig);
    // This actually doesn't throw - it just uses promptFile
    const result = loadCodonSequence(configPath);
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

    writeStrandConfig(configPath, bothConfig);
    expect(() => loadCodonSequence(configPath)).toThrow();
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

    writeStrandConfig(configPath, config);
    const result = loadCodonSequence(configPath);

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

    writeStrandConfig(configPath, config);
    const result = loadCodonSequence(configPath);

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

    writeStrandConfig(configPath, invalidRigConfig);
    expect(() => loadCodonSequence(configPath)).toThrow();
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

    writeStrandConfig(configPath, config);
    expect(() => loadCodonSequence(configPath)).toThrow();
  });

  test("throws on unreadable files", () => {
    const promptPath = path.join(tempDir, "unreadable.md");
    createTestFile(promptPath, "Test prompt");

    // Make file unreadable (skip on Windows)
    if (process.platform !== "win32") {
      fs.chmodSync(promptPath, 0o000);

      const config = [
        {
          id: "test-codon",
          name: "Test Codon",
          model: "opus",
          continuationMode: "fresh",
          promptFile: "./unreadable.md",
        },
      ];

      writeStrandConfig(configPath, config);
      expect(() => loadCodonSequence(configPath)).toThrow();

      // Restore permissions for cleanup
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

    writeStrandConfig(configPath, config);
    const result = loadCodonSequence(configPath);

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

    writeStrandConfig(configPath, config);
    const result = loadCodonSequence(configPath);

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

    writeStrandConfig(configPath, config);
    const result = loadCodonSequence(configPath);

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

    writeStrandConfig(configPath, config);
    const result = loadCodonSequence(configPath);

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

    writeStrandConfig(configPath, config);
    const result = loadCodonSequence(configPath);

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

    writeStrandConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence(configPath)).toThrow();
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

    writeStrandConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence(configPath)).toThrow("at least one codon");
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

    writeStrandConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence(configPath)).toThrow();
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

    writeStrandConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence(configPath)).toThrow("at least 1");
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

    writeStrandConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence(configPath)).toThrow();
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

    writeStrandConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence(configPath)).toThrow();
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

    writeStrandConfig(configPath, invalidConfig);
    expect(() => loadCodonSequence(configPath)).toThrow();
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

    writeStrandConfig(configPath, config);
    const result = loadCodonSequence(configPath);

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

    writeStrandConfig(configPath, config);
    const result = loadCodonSequence(configPath);

    expect(result).toHaveLength(1);
    const codon = result[0];
    if (codon.type !== "loop") {
      expect(codon.rigSetup).toHaveLength(1);
    }
  });
});
