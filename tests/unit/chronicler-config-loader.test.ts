import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ChroniclerConfigLoader } from "../../server/chroniclers/chronicler-config-loader.js";
import type { PhaseChroniclerEntry } from "../../server/types/types.js";

describe("ChroniclerConfigLoader", () => {
  const testDataDir = path.join(process.cwd(), "tests/test-data/chronicler-configs");
  let loader: ChroniclerConfigLoader;

  beforeEach(() => {
    loader = new ChroniclerConfigLoader();
    // Ensure test data directory exists
    if (!fs.existsSync(testDataDir)) {
      fs.mkdirSync(testDataDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  describe("File-based loading", () => {
    test("loads chronicler config from absolute file path", () => {
      // Create test config file
      const testConfig = {
        id: "test-chronicler",
        name: "Test Chronicler",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };
      const configPath = path.join(testDataDir, "test.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: configPath,
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs.length).toBe(1);
      expect(result.errors.length).toBe(0);
      expect(result.configs[0].config.id).toBe("test-chronicler");
      expect(result.configs[0].source).toBe("file");
      expect(result.configs[0].sourcePath).toBe(configPath);
    });

    test("loads chronicler config from relative file path", () => {
      const testConfig = {
        id: "test-chronicler",
        name: "Test Chronicler",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };
      const configPath = path.join(testDataDir, "test.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: "./test.json",
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs.length).toBe(1);
      expect(result.errors.length).toBe(0);
      expect(result.configs[0].config.id).toBe("test-chronicler");
    });
  });

  describe("Inline loading", () => {
    test("loads chronicler config from inline object", () => {
      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: {
            id: "inline-chronicler",
            name: "Inline Chronicler",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Inline prompt",
          },
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs.length).toBe(1);
      expect(result.errors.length).toBe(0);
      expect(result.configs[0].config.id).toBe("inline-chronicler");
      expect(result.configs[0].source).toBe("inline");
      expect(result.configs[0].sourcePath).toBeUndefined();
    });
  });

  describe("Mixed loading", () => {
    test("loads mixed file and inline configs", () => {
      const testConfig = {
        id: "file-chronicler",
        name: "File Chronicler",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "File prompt",
      };
      const configPath = path.join(testDataDir, "test.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: configPath,
        },
        {
          chroniclerConfig: {
            id: "inline-chronicler",
            name: "Inline Chronicler",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["tool.result"] },
            execution: { strategy: "immediate" },
            userPromptText: "Inline prompt",
          },
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs.length).toBe(2);
      expect(result.errors.length).toBe(0);
      expect(result.configs[0].source).toBe("file");
      expect(result.configs[1].source).toBe("inline");
    });
  });

  describe("Caching behavior", () => {
    test("first load reads from disk", () => {
      const testConfig = {
        id: "cached-chronicler",
        name: "Cached Chronicler",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };
      const configPath = path.join(testDataDir, "cached.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: PhaseChroniclerEntry[] = [{ chroniclerConfig: configPath }];

      const result1 = loader.loadConfigsForPhase(entries, "phase-1", testDataDir);

      expect(result1.configs.length).toBe(1);
      expect(result1.configs[0].config.id).toBe("cached-chronicler");
    });

    test("second load of same file uses cache", () => {
      const testConfig = {
        id: "cached-chronicler",
        name: "Cached Chronicler",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };
      const configPath = path.join(testDataDir, "cached.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: PhaseChroniclerEntry[] = [{ chroniclerConfig: configPath }];

      // First load
      loader.loadConfigsForPhase(entries, "phase-1", testDataDir);

      // Delete the file to prove cache is being used
      fs.unlinkSync(configPath);

      // Second load should still work (from cache)
      const result2 = loader.loadConfigsForPhase(entries, "phase-2", testDataDir);

      expect(result2.configs.length).toBe(1);
      expect(result2.configs[0].config.id).toBe("cached-chronicler");
    });

    test("clearCache() clears cache", () => {
      const testConfig = {
        id: "cached-chronicler",
        name: "Cached Chronicler",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };
      const configPath = path.join(testDataDir, "cached.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: PhaseChroniclerEntry[] = [{ chroniclerConfig: configPath }];

      // First load
      loader.loadConfigsForPhase(entries, "phase-1", testDataDir);

      // Clear cache
      loader.clearCache();

      // Delete file
      fs.unlinkSync(configPath);

      // Should fail now (cache cleared, file gone)
      const result = loader.loadConfigsForPhase(entries, "phase-2", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toContain("not found");
    });
  });

  describe("Wrapper pattern parsing", () => {
    test("extracts failPhaseIfNotLoaded (defaults to false)", () => {
      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: {
            id: "test-chronicler",
            name: "Test",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs[0].failPhaseIfNotLoaded).toBe(false);
    });

    test("extracts failPhaseIfNotLoaded=true", () => {
      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: {
            id: "test-chronicler",
            name: "Test",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
          settings: {
            failPhaseIfNotLoaded: true,
          },
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs[0].failPhaseIfNotLoaded).toBe(true);
    });

    test("extracts outputPaths", () => {
      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: {
            id: "test-chronicler",
            name: "Test",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
          settings: {
            outputPaths: {
              logFile: "test.md",
              lastValueFile: "last.md",
            },
          },
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs[0].outputPaths).toEqual({
        logFile: "test.md",
        lastValueFile: "last.md",
      });
    });

    test("handles missing settings (undefined)", () => {
      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: {
            id: "test-chronicler",
            name: "Test",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs[0].failPhaseIfNotLoaded).toBe(false);
      expect(result.configs[0].outputPaths).toBeUndefined();
    });
  });

  describe("Error handling", () => {
    test("file not found returns error with fatal=false by default", () => {
      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: "./nonexistent.json",
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].fatal).toBe(false);
      expect(result.errors[0].ref).toBe("./nonexistent.json");
    });

    test("file not found with failPhaseIfNotLoaded=true returns fatal=true", () => {
      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: "./nonexistent.json",
          settings: {
            failPhaseIfNotLoaded: true,
          },
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.errors.length).toBe(1);
      expect(result.errors[0].fatal).toBe(true);
    });

    test("invalid JSON returns error", () => {
      const configPath = path.join(testDataDir, "invalid.json");
      fs.writeFileSync(configPath, "{ invalid json }");

      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: configPath,
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toContain("JSON");
    });

    test("Zod validation error returns clear message", () => {
      const testConfig = {
        id: "test-chronicler",
        name: "Test",
        // Missing required fields: model, trigger, execution, userPrompt
      };
      const configPath = path.join(testDataDir, "invalid-schema.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: configPath,
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toBeTruthy();
    });

    test("duplicate chronicler ID returns error", () => {
      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: {
            id: "duplicate",
            name: "First",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
        },
        {
          chroniclerConfig: {
            id: "duplicate",
            name: "Second",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["tool.result"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs.length).toBe(1); // First one loads
      expect(result.errors.length).toBe(1); // Second fails
      expect(result.errors[0].error).toContain("Duplicate");
    });

    test("first chronicler succeeds, second fails - both tracked correctly", () => {
      const testConfig = {
        id: "valid-chronicler",
        name: "Valid",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test",
      };
      const configPath = path.join(testDataDir, "valid.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: configPath,
        },
        {
          chroniclerConfig: "./nonexistent.json",
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs.length).toBe(1);
      expect(result.configs[0].config.id).toBe("valid-chronicler");
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].ref).toBe("./nonexistent.json");
    });

    test("multiple errors accumulated correctly", () => {
      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: "./nonexistent1.json",
        },
        {
          chroniclerConfig: "./nonexistent2.json",
          settings: { failPhaseIfNotLoaded: true },
        },
      ];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(2);
      expect(result.errors[0].fatal).toBe(false);
      expect(result.errors[1].fatal).toBe(true);
    });
  });

  describe("Config directory resolution", () => {
    test("file reference sets configDirectory to dirname of file", () => {
      const testConfig = {
        id: "test-chronicler",
        name: "Test",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test",
      };
      const subdir = path.join(testDataDir, "subdir");
      fs.mkdirSync(subdir, { recursive: true });
      const configPath = path.join(subdir, "test.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: PhaseChroniclerEntry[] = [{ chroniclerConfig: configPath }];

      const result = loader.loadConfigsForPhase(entries, "test-phase", testDataDir);

      expect(result.configs[0].configDirectory).toBe(subdir);
    });

    test("inline reference sets configDirectory to phaseConfigDir", () => {
      const entries: PhaseChroniclerEntry[] = [
        {
          chroniclerConfig: {
            id: "test-chronicler",
            name: "Test",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
        },
      ];

      const phaseConfigDir = "/some/phase/dir";
      const result = loader.loadConfigsForPhase(entries, "test-phase", phaseConfigDir);

      expect(result.configs[0].configDirectory).toBe(phaseConfigDir);
    });
  });

  describe("Empty inputs", () => {
    test("empty array returns empty result", () => {
      const result = loader.loadConfigsForPhase([], "test-phase", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(0);
    });
  });
});
