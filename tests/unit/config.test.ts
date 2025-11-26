import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  calculateCost,
  DEFAULT_CONFIG,
  loadCodonSequence,
  validateStrand,
} from "../../server/config";
import { CodonId } from "../../server/types/branded-types";
import type { CodonConfig, ModelName } from "../../server/types/types";

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

// -------------
// Tests
// -------------

describe("calculateCost", () => {
  const costs = DEFAULT_CONFIG.costsPerMTok;

  test("calculates zero cost for zero tokens", () => {
    const result = calculateCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      costs,
    );
    expect(result).toBe(0);
  });

  test("calculates cost for only input tokens", () => {
    const result = calculateCost(
      {
        inputTokens: 1000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      costs,
    );
    expect(result).toBe(costs.input / 1000);
  });

  test("calculates cost for only output tokens", () => {
    const result = calculateCost(
      {
        inputTokens: 0,
        outputTokens: 1000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      costs,
    );
    expect(result).toBe(costs.output / 1000);
  });

  test("calculates cost for mixed token types", () => {
    const result = calculateCost(
      {
        inputTokens: 1000,
        outputTokens: 2000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      costs,
    );
    const expected = (costs.input + 2 * costs.output) / 1000;
    expect(result).toBe(expected);
  });

  test("handles very large token counts without overflow", () => {
    const largeTokens = Number.MAX_SAFE_INTEGER / 1000;
    expect(() =>
      calculateCost(
        {
          inputTokens: largeTokens,
          outputTokens: largeTokens,
          cacheCreationTokens: largeTokens,
          cacheReadTokens: largeTokens,
        },
        costs,
      ),
    ).not.toThrow();
  });

  test("maintains precision to 6 decimal places", () => {
    const result = calculateCost(
      {
        inputTokens: 1234,
        outputTokens: 5678,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      costs,
    );
    const expected = (1234 * costs.input + 5678 * costs.output) / 1_000_000;
    expect(result).toBeCloseTo(expected, 6);
  });

  test("calculates cache tokens correctly", () => {
    const result = calculateCost(
      {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheCreationTokens: 500,
        cacheReadTokens: 0,
      },
      costs,
    );
    const expected = (costs.input + costs.output + 0.5 * costs.inputCache) / 1000;
    expect(result).toBe(expected);
  });
});

describe("validateStrand", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-validation-test");
  const configPath = path.join(tempDir, "validate-config.json");
  const projectPath = path.join(tempDir, "project");

  // Set up before each test
  beforeEach(() => {
    cleanup(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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
        model: "sonnet",
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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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

    fs.writeFileSync(configPath, JSON.stringify(config));
    await expect(validateStrand(configPath, projectPath)).rejects.toThrow("Duplicate codon ID");
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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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

    fs.writeFileSync(configPath, JSON.stringify(config));
    await expect(validateStrand(configPath, projectPath)).rejects.toThrow("Invalid target path");
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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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
        model: "sonnet",
        continuationMode: "continue-previous",
        promptFile: "./prompt.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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
        model: "sonnet",
        continuationMode: "continue-previous",
        promptFile: "./prompt.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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

    fs.writeFileSync(configPath, JSON.stringify(config));
    await expect(validateStrand(configPath, projectPath)).rejects.toThrow(
      "Command cannot be empty",
    );
  });

  test("delegates to loadCodonSequence for basic validation", async () => {
    const invalidConfig = [
      {
        // Missing required fields
        promptText: "Test prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
    await expect(validateStrand(configPath, projectPath)).rejects.toThrow();
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
            model: "sonnet",
            continuationMode: "continue-previous",
            promptFile: "./prompt.md",
          },
        ],
      },
      {
        id: "final-codon",
        name: "Final Codon",
        model: "sonnet",
        continuationMode: "continue-previous",
        promptFile: "./prompt.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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

    fs.writeFileSync(configPath, JSON.stringify(config));
    await expect(validateStrand(configPath, projectPath)).rejects.toThrow("Duplicate codon ID");
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

    fs.writeFileSync(configPath, JSON.stringify(config));
    await expect(validateStrand(configPath, projectPath)).rejects.toThrow("Duplicate");
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

    fs.writeFileSync(configPath, JSON.stringify(config));
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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);

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

    fs.writeFileSync(configPath, JSON.stringify(config));
    await expect(validateStrand(configPath, projectPath)).rejects.toThrow(
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

    fs.writeFileSync(configPath, JSON.stringify(config));
    await expect(validateStrand(configPath, projectPath)).rejects.toThrow(
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
            model: "sonnet",
            continuationMode: "continue-previous",
            promptFile: "./prompt.md",
          },
        ],
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);
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

    fs.writeFileSync(configPath, JSON.stringify(config));
    await expect(validateStrand(configPath, projectPath)).rejects.toThrow(
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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);
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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validateStrand(configPath, projectPath);
    // Should not throw
    expect(result.codonCount).toBe(1);
  });
});

describe("loadCodonSequence", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-test-config");
  const configPath = path.join(tempDir, "test-config.json");

  // Set up before each test
  beforeEach(() => {
    cleanup(tempDir);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  test("loads valid configuration", () => {
    const validConfig: CodonConfig[] = [
      {
        id: CodonId("test-codon"),
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(validConfig));
    const result = loadCodonSequence(configPath);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject(validConfig[0]);
  });

  test("throws on missing required fields", () => {
    const invalidConfig = [
      {
        id: "test-codon",
        // Missing name and model
        promptText: "Test prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
    expect(() => loadCodonSequence(configPath)).toThrow();
  });

  test("throws on invalid model names", () => {
    const invalidConfig: CodonConfig[] = [
      {
        id: CodonId("test-codon"),
        name: "Test Codon",
        model: "invalid-model-name" as ModelName, // Intentionally invalid for testing
        continuationMode: "fresh",
        promptText: "Test prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
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

    fs.writeFileSync(configPath, JSON.stringify(neitherConfig));
    expect(() => loadCodonSequence(configPath)).toThrow();

    // Both provided - loadCodonSequence doesn't actually validate this case, it just uses promptFile if both are provided
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    const bothConfig: CodonConfig[] = [
      {
        id: CodonId("test-codon"),
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        promptText: "Test prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(bothConfig));
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
    const bothConfig: CodonConfig[] = [
      {
        id: CodonId("test-codon"),
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test prompt",
        appendSystemPromptFile: "./system.md",
        appendSystemPromptText: "System prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(bothConfig));
    expect(() => loadCodonSequence(configPath)).toThrow();
  });

  test("resolves relative paths correctly", () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    const config: CodonConfig[] = [
      {
        id: CodonId("test-codon"),
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = loadCodonSequence(configPath);

    const codon = result[0];
    if (codon.type !== "loop") {
      expect(codon.promptFile).toBe(path.resolve(tempDir, "prompt.md"));
    }
  });

  test("handles array of prompt files", () => {
    createTestFile(path.join(tempDir, "prompt1.md"), "Prompt 1");
    createTestFile(path.join(tempDir, "prompt2.md"), "Prompt 2");

    const config: CodonConfig[] = [
      {
        id: CodonId("test-codon"),
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: ["./prompt1.md", "./prompt2.md"],
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
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

    fs.writeFileSync(configPath, JSON.stringify(invalidRigConfig));
    expect(() => loadCodonSequence(configPath)).toThrow();
  });

  test("throws on non-existent prompt files", () => {
    const config: CodonConfig[] = [
      {
        id: CodonId("test-codon"),
        name: "Test Codon",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./non-existent.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    expect(() => loadCodonSequence(configPath)).toThrow();
  });

  test("throws on unreadable files", () => {
    const promptPath = path.join(tempDir, "unreadable.md");
    createTestFile(promptPath, "Test prompt");

    // Make file unreadable (skip on Windows)
    if (process.platform !== "win32") {
      fs.chmodSync(promptPath, 0o000);

      const config: CodonConfig[] = [
        {
          id: CodonId("test-codon"),
          name: "Test Codon",
          model: "opus",
          continuationMode: "fresh",
          promptFile: "./unreadable.md",
        },
      ];

      fs.writeFileSync(configPath, JSON.stringify(config));
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

    fs.writeFileSync(configPath, JSON.stringify(config));
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

    fs.writeFileSync(configPath, JSON.stringify(config));
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

    fs.writeFileSync(configPath, JSON.stringify(config));
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

    fs.writeFileSync(configPath, JSON.stringify(config));
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

    fs.writeFileSync(configPath, JSON.stringify(config));
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

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
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

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
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

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
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

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
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

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
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

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
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

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
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

    fs.writeFileSync(configPath, JSON.stringify(config));
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

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = loadCodonSequence(configPath);

    expect(result).toHaveLength(1);
    const codon = result[0];
    if (codon.type !== "loop") {
      expect(codon.rigSetup).toHaveLength(1);
    }
  });
});
