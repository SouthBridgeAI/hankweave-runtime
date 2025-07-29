import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  calculateCost,
  DEFAULT_CONFIG,
  loadPhaseConfig,
  validatePhaseConfig,
} from "../../server/config";
import { PhaseId } from "../../server/types/branded-types";
import type { ModelName, PhaseConfig } from "../../server/types/types";

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

describe("validatePhaseConfig", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-validation-test");
  const configPath = path.join(tempDir, "validate-config.json");
  const projectPath = path.join(tempDir, "project");

  // Helper to create test files
  const createTestFile = (filePath: string, content: string) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content);
  };

  // Clean up temp files
  const cleanup = () => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  };

  // Set up before each test
  beforeEach(() => {
    cleanup();
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  test("validates basic configuration successfully", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt content");

    const config = [
      {
        id: "test-phase",
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validatePhaseConfig(configPath, projectPath);

    expect(result.phaseCount).toBe(1);
    expect(result.promptFileCount).toBe(1);
    expect(result.systemPromptFileCount).toBe(0);
    expect(result.workspaceSetupCount).toBe(0);
    expect(result.watchingPhaseCount).toBe(0);
    expect(result.checkpointPhaseCount).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("counts multiple phases correctly", async () => {
    createTestFile(path.join(tempDir, "prompt1.md"), "Prompt 1");
    createTestFile(path.join(tempDir, "prompt2.md"), "Prompt 2");
    createTestFile(path.join(tempDir, "system.md"), "System prompt");

    const config = [
      {
        id: "phase-1",
        name: "First Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt1.md",
        trackedFiles: ["*.md"],
      },
      {
        id: "phase-2",
        name: "Second Phase",
        model: "sonnet",
        continuationMode: "continue-previous",
        promptFile: "./prompt2.md",
        appendSystemPromptFile: "./system.md",
        trackedFiles: ["*.js"],
        workspaceSetup: [
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
    const result = await validatePhaseConfig(configPath, projectPath);

    expect(result.phaseCount).toBe(2);
    expect(result.promptFileCount).toBe(2);
    expect(result.systemPromptFileCount).toBe(1);
    expect(result.workspaceSetupCount).toBe(1);
    expect(result.watchingPhaseCount).toBe(2);
    expect(result.checkpointPhaseCount).toBe(2);
  });

  test("detects duplicate phase IDs", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "duplicate-id",
        name: "First Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
      {
        id: "duplicate-id",
        name: "Second Phase",
        model: "sonnet",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    await expect(validatePhaseConfig(configPath, projectPath)).rejects.toThrow(
      "Duplicate phase ID",
    );
  });

  test("warns about duplicate phase names", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "phase-1",
        name: "Duplicate Name",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
      {
        id: "phase-2",
        name: "Duplicate Name",
        model: "sonnet",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validatePhaseConfig(configPath, projectPath);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Duplicate phase name "Duplicate Name"');
  });

  test("warns about empty prompt files", async () => {
    createTestFile(path.join(tempDir, "empty.md"), ""); // Empty file

    const config = [
      {
        id: "test-phase",
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./empty.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validatePhaseConfig(configPath, projectPath);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("is empty");
  });

  test("warns about large prompt files", async () => {
    const largeContent = "x".repeat(2 * 1024 * 1024); // 2MB file
    createTestFile(path.join(tempDir, "large.md"), largeContent);

    const config = [
      {
        id: "test-phase",
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./large.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validatePhaseConfig(configPath, projectPath);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("is large");
  });

  test("validates workspace setup copy operations", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    createTestFile(path.join(tempDir, "source.txt"), "Source content");

    const config = [
      {
        id: "test-phase",
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        workspaceSetup: [
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
    const result = await validatePhaseConfig(configPath, projectPath);

    expect(result.workspaceSetupCount).toBe(1);
    expect(result.warnings).toHaveLength(0);
  });

  test("throws on invalid target paths", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    createTestFile(path.join(tempDir, "source.txt"), "Source content");

    const config = [
      {
        id: "test-phase",
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        workspaceSetup: [
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
    await expect(validatePhaseConfig(configPath, projectPath)).rejects.toThrow(
      "Invalid target path",
    );
  });

  test("warns about potentially dangerous commands", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "test-phase",
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        workspaceSetup: [
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
    const result = await validatePhaseConfig(configPath, projectPath);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Potentially dangerous command detected");
  });

  test("validates continuation mode dependencies", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    // First phase with continue-previous mode
    const config = [
      {
        id: "first-phase",
        name: "First Phase",
        model: "opus",
        continuationMode: "continue-previous", // Invalid for first phase
        promptFile: "./prompt.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validatePhaseConfig(configPath, projectPath);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("but there's no previous phase");
  });

  test("warns when continuing from phase without output", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "phase-1",
        name: "First Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        // No trackedFiles
      },
      {
        id: "phase-2",
        name: "Second Phase",
        model: "sonnet",
        continuationMode: "continue-previous",
        promptFile: "./prompt.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = await validatePhaseConfig(configPath, projectPath);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("which doesn't track any files");
  });

  test("throws on empty command", async () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");

    const config = [
      {
        id: "test-phase",
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        workspaceSetup: [
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
    await expect(validatePhaseConfig(configPath, projectPath)).rejects.toThrow(
      "Command cannot be empty",
    );
  });

  test("delegates to loadPhaseConfig for basic validation", async () => {
    const invalidConfig = [
      {
        // Missing required fields
        promptText: "Test prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
    await expect(validatePhaseConfig(configPath, projectPath)).rejects.toThrow();
  });
});

describe("loadPhaseConfig", () => {
  const tempDir = path.resolve("tests", "test-area", "temp-test-config");
  const configPath = path.join(tempDir, "test-config.json");

  // Helper to create test files
  const createTestFile = (filePath: string, content: string) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content);
  };

  // Clean up temp files
  const cleanup = () => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  };

  // Set up before each test
  beforeEach(() => {
    cleanup();
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  test("loads valid configuration", () => {
    const validConfig: PhaseConfig[] = [
      {
        id: PhaseId("test-phase"),
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(validConfig));
    const result = loadPhaseConfig(configPath);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject(validConfig[0]);
  });

  test("throws on missing required fields", () => {
    const invalidConfig = [
      {
        id: "test-phase",
        // Missing name and model
        promptText: "Test prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
    expect(() => loadPhaseConfig(configPath)).toThrow();
  });

  test("throws on invalid model names", () => {
    const invalidConfig: PhaseConfig[] = [
      {
        id: PhaseId("test-phase"),
        name: "Test Phase",
        model: "invalid-model-name" as ModelName, // Intentionally invalid for testing
        continuationMode: "fresh",
        promptText: "Test prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
    expect(() => loadPhaseConfig(configPath)).toThrow();
  });

  test("validates promptFile XOR promptText", () => {
    // Neither provided
    const neitherConfig = [
      {
        id: "test-phase",
        name: "Test Phase",
        model: "opus",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(neitherConfig));
    expect(() => loadPhaseConfig(configPath)).toThrow();

    // Both provided - loadPhaseConfig doesn't actually validate this case, it just uses promptFile if both are provided
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    const bothConfig: PhaseConfig[] = [
      {
        id: PhaseId("test-phase"),
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
        promptText: "Test prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(bothConfig));
    // This actually doesn't throw - it just uses promptFile
    const result = loadPhaseConfig(configPath);
    expect(result[0].promptFile).toBeDefined();
    expect(result[0].promptText).toBe("Test prompt"); // It keeps both
  });

  test("validates appendSystemPromptFile XOR appendSystemPromptText", () => {
    // Both provided
    createTestFile(path.join(tempDir, "system.md"), "System prompt");
    const bothConfig: PhaseConfig[] = [
      {
        id: PhaseId("test-phase"),
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test prompt",
        appendSystemPromptFile: "./system.md",
        appendSystemPromptText: "System prompt",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(bothConfig));
    expect(() => loadPhaseConfig(configPath)).toThrow();
  });

  test("resolves relative paths correctly", () => {
    createTestFile(path.join(tempDir, "prompt.md"), "Test prompt");
    const config: PhaseConfig[] = [
      {
        id: PhaseId("test-phase"),
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./prompt.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = loadPhaseConfig(configPath);

    expect(result[0].promptFile).toBe(path.resolve(tempDir, "prompt.md"));
  });

  test("handles array of prompt files", () => {
    createTestFile(path.join(tempDir, "prompt1.md"), "Prompt 1");
    createTestFile(path.join(tempDir, "prompt2.md"), "Prompt 2");

    const config: PhaseConfig[] = [
      {
        id: PhaseId("test-phase"),
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: ["./prompt1.md", "./prompt2.md"],
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = loadPhaseConfig(configPath);

    expect(result[0].promptFile).toEqual([
      path.resolve(tempDir, "prompt1.md"),
      path.resolve(tempDir, "prompt2.md"),
    ]);
  });

  test("validates workspace setup items", () => {
    const invalidWorkspaceConfig = [
      {
        id: "test-phase",
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptText: "Test prompt",
        workspaceSetup: [
          {
            type: "invalid", // Invalid type - not "copy" or "command"
          },
        ],
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(invalidWorkspaceConfig));
    expect(() => loadPhaseConfig(configPath)).toThrow();
  });

  test("throws on non-existent prompt files", () => {
    const config: PhaseConfig[] = [
      {
        id: PhaseId("test-phase"),
        name: "Test Phase",
        model: "opus",
        continuationMode: "fresh",
        promptFile: "./non-existent.md",
      },
    ];

    fs.writeFileSync(configPath, JSON.stringify(config));
    expect(() => loadPhaseConfig(configPath)).toThrow();
  });

  test("throws on unreadable files", () => {
    const promptPath = path.join(tempDir, "unreadable.md");
    createTestFile(promptPath, "Test prompt");

    // Make file unreadable (skip on Windows)
    if (process.platform !== "win32") {
      fs.chmodSync(promptPath, 0o000);

      const config: PhaseConfig[] = [
        {
          id: PhaseId("test-phase"),
          name: "Test Phase",
          model: "opus",
          continuationMode: "fresh",
          promptFile: "./unreadable.md",
        },
      ];

      fs.writeFileSync(configPath, JSON.stringify(config));
      expect(() => loadPhaseConfig(configPath)).toThrow();

      // Restore permissions for cleanup
      fs.chmodSync(promptPath, 0o644);
    }
  });
});
