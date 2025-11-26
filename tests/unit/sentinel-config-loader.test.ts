import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { SentinelConfigLoader } from "../../server/sentinels/sentinel-config-loader.js";
import type { CodonSentinelEntry } from "../../server/types/types.js";

describe("SentinelConfigLoader", () => {
  const testDataDir = path.join(process.cwd(), "tests/test-data/sentinel-configs");
  let loader: SentinelConfigLoader;

  beforeEach(() => {
    loader = new SentinelConfigLoader();
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
    test("loads sentinel config from absolute file path", () => {
      // Create test config file
      const testConfig = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };
      const configPath = path.join(testDataDir, "test.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: configPath,
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs.length).toBe(1);
      expect(result.errors.length).toBe(0);
      expect(result.configs[0].config.id).toBe("test-sentinel");
      expect(result.configs[0].source).toBe("file");
      expect(result.configs[0].sourcePath).toBe(configPath);
    });

    test("loads sentinel config from relative file path", () => {
      const testConfig = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };
      const configPath = path.join(testDataDir, "test.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: "./test.json",
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs.length).toBe(1);
      expect(result.errors.length).toBe(0);
      expect(result.configs[0].config.id).toBe("test-sentinel");
    });
  });

  describe("Inline loading", () => {
    test("loads sentinel config from inline object", () => {
      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: {
            id: "inline-sentinel",
            name: "Inline Sentinel",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Inline prompt",
          },
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs.length).toBe(1);
      expect(result.errors.length).toBe(0);
      expect(result.configs[0].config.id).toBe("inline-sentinel");
      expect(result.configs[0].source).toBe("inline");
      expect(result.configs[0].sourcePath).toBeUndefined();
    });
  });

  describe("Mixed loading", () => {
    test("loads mixed file and inline configs", () => {
      const testConfig = {
        id: "file-sentinel",
        name: "File Sentinel",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "File prompt",
      };
      const configPath = path.join(testDataDir, "test.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: configPath,
        },
        {
          sentinelConfig: {
            id: "inline-sentinel",
            name: "Inline Sentinel",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["tool.result"] },
            execution: { strategy: "immediate" },
            userPromptText: "Inline prompt",
          },
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs.length).toBe(2);
      expect(result.errors.length).toBe(0);
      expect(result.configs[0].source).toBe("file");
      expect(result.configs[1].source).toBe("inline");
    });
  });

  describe("Caching behavior", () => {
    test("first load reads from disk", () => {
      const testConfig = {
        id: "cached-sentinel",
        name: "Cached Sentinel",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };
      const configPath = path.join(testDataDir, "cached.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: CodonSentinelEntry[] = [{ sentinelConfig: configPath }];

      const result1 = loader.loadConfigsForCodon(entries, "codon-1", testDataDir);

      expect(result1.configs.length).toBe(1);
      expect(result1.configs[0].config.id).toBe("cached-sentinel");
    });

    test("second load of same file uses cache", () => {
      const testConfig = {
        id: "cached-sentinel",
        name: "Cached Sentinel",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };
      const configPath = path.join(testDataDir, "cached.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: CodonSentinelEntry[] = [{ sentinelConfig: configPath }];

      // First load
      loader.loadConfigsForCodon(entries, "codon-1", testDataDir);

      // Delete the file to prove cache is being used
      fs.unlinkSync(configPath);

      // Second load should still work (from cache)
      const result2 = loader.loadConfigsForCodon(entries, "codon-2", testDataDir);

      expect(result2.configs.length).toBe(1);
      expect(result2.configs[0].config.id).toBe("cached-sentinel");
    });

    test("clearCache() clears cache", () => {
      const testConfig = {
        id: "cached-sentinel",
        name: "Cached Sentinel",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test prompt",
      };
      const configPath = path.join(testDataDir, "cached.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: CodonSentinelEntry[] = [{ sentinelConfig: configPath }];

      // First load
      loader.loadConfigsForCodon(entries, "codon-1", testDataDir);

      // Clear cache
      loader.clearCache();

      // Delete file
      fs.unlinkSync(configPath);

      // Should fail now (cache cleared, file gone)
      const result = loader.loadConfigsForCodon(entries, "codon-2", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toContain("not found");
    });
  });

  describe("Wrapper pattern parsing", () => {
    test("extracts failCodonIfNotLoaded (defaults to false)", () => {
      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: {
            id: "test-sentinel",
            name: "Test",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs[0].failCodonIfNotLoaded).toBe(false);
    });

    test("extracts failCodonIfNotLoaded=true", () => {
      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: {
            id: "test-sentinel",
            name: "Test",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
          settings: {
            failCodonIfNotLoaded: true,
          },
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs[0].failCodonIfNotLoaded).toBe(true);
    });

    test("extracts outputPaths", () => {
      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: {
            id: "test-sentinel",
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

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs[0].outputPaths).toEqual({
        logFile: "test.md",
        lastValueFile: "last.md",
      });
    });

    test("handles missing settings (undefined)", () => {
      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: {
            id: "test-sentinel",
            name: "Test",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs[0].failCodonIfNotLoaded).toBe(false);
      expect(result.configs[0].outputPaths).toBeUndefined();
    });
  });

  describe("Error handling", () => {
    test("file not found returns error with fatal=false by default", () => {
      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: "./nonexistent.json",
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].fatal).toBe(false);
      expect(result.errors[0].ref).toBe("./nonexistent.json");
    });

    test("file not found with failCodonIfNotLoaded=true returns fatal=true", () => {
      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: "./nonexistent.json",
          settings: {
            failCodonIfNotLoaded: true,
          },
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.errors.length).toBe(1);
      expect(result.errors[0].fatal).toBe(true);
    });

    test("invalid JSON returns error", () => {
      const configPath = path.join(testDataDir, "invalid.json");
      fs.writeFileSync(configPath, "{ invalid json }");

      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: configPath,
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toContain("JSON");
    });

    test("Zod validation error returns clear message", () => {
      const testConfig = {
        id: "test-sentinel",
        name: "Test",
        // Missing required fields: model, trigger, execution, userPrompt
      };
      const configPath = path.join(testDataDir, "invalid-schema.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: configPath,
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toBeTruthy();
    });

    test("duplicate sentinel ID returns error", () => {
      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: {
            id: "duplicate",
            name: "First",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
        },
        {
          sentinelConfig: {
            id: "duplicate",
            name: "Second",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["tool.result"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs.length).toBe(1); // First one loads
      expect(result.errors.length).toBe(1); // Second fails
      expect(result.errors[0].error).toContain("Duplicate");
    });

    test("first sentinel succeeds, second fails - both tracked correctly", () => {
      const testConfig = {
        id: "valid-sentinel",
        name: "Valid",
        model: "anthropic/claude-3-5-haiku-20241022",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "Test",
      };
      const configPath = path.join(testDataDir, "valid.json");
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: configPath,
        },
        {
          sentinelConfig: "./nonexistent.json",
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs.length).toBe(1);
      expect(result.configs[0].config.id).toBe("valid-sentinel");
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].ref).toBe("./nonexistent.json");
    });

    test("multiple errors accumulated correctly", () => {
      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: "./nonexistent1.json",
        },
        {
          sentinelConfig: "./nonexistent2.json",
          settings: { failCodonIfNotLoaded: true },
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(2);
      expect(result.errors[0].fatal).toBe(false);
      expect(result.errors[1].fatal).toBe(true);
    });
  });

  describe("Config directory resolution", () => {
    test("file reference sets configDirectory to dirname of file", () => {
      const testConfig = {
        id: "test-sentinel",
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

      const entries: CodonSentinelEntry[] = [{ sentinelConfig: configPath }];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs[0].configDirectory).toBe(subdir);
    });

    test("inline reference sets configDirectory to codonConfigDir", () => {
      const entries: CodonSentinelEntry[] = [
        {
          sentinelConfig: {
            id: "test-sentinel",
            name: "Test",
            model: "anthropic/claude-3-5-haiku-20241022",
            trigger: { type: "event", on: ["assistant.action"] },
            execution: { strategy: "immediate" },
            userPromptText: "Test",
          },
        },
      ];

      const codonConfigDir = "/some/codon/dir";
      const result = loader.loadConfigsForCodon(entries, "test-codon", codonConfigDir);

      expect(result.configs[0].configDirectory).toBe(codonConfigDir);
    });
  });

  describe("Empty inputs", () => {
    test("empty array returns empty result", () => {
      const result = loader.loadConfigsForCodon([], "test-codon", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(0);
    });
  });
});
