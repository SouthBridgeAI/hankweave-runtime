import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SentinelConfigLoader } from "../../server/sentinels/sentinel-config-loader.js";
import type { CodonSentinelEntry } from "../../server/types/types.js";

describe("SentinelConfigLoader", () => {
  let testDataDir: string;
  let loader: SentinelConfigLoader;

  beforeEach(() => {
    loader = new SentinelConfigLoader();
    // Per-run isolated directory — the test must never create or delete
    // anything inside the checked-in tests/test-data tree.
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-sentinel-configs-"));
  });

  afterEach(() => {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  describe("File-based loading", () => {
    test("loads sentinel config from a hank-relative file path", () => {
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
          // Strict hank refs: entry refs must be relative and in-dir
          sentinelConfig: "test.json",
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
          sentinelConfig: "test.json",
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

      const entries: CodonSentinelEntry[] = [{ sentinelConfig: "cached.json" }];

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

      const entries: CodonSentinelEntry[] = [{ sentinelConfig: "cached.json" }];

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

      const entries: CodonSentinelEntry[] = [{ sentinelConfig: "cached.json" }];

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
          sentinelConfig: "invalid.json",
        },
      ];

      const result = loader.loadConfigsForCodon(entries, "test-codon", testDataDir);

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toContain("JSON");
    });

    test.skipIf(process.platform === "win32")("a FIFO config file is rejected, not read", () => {
      // Loading runs at codon startup even when validation only warned, so
      // the loader itself must reject non-regular files before reading them.
      const { execSync, spawn } =
        require("node:child_process") as typeof import("node:child_process");
      const fifoPath = path.join(testDataDir, "pipe.json");
      execSync(`mkfifo ${JSON.stringify(fifoPath)}`);
      // Background writer: on regression the read connects to it and this
      // test fails on the message assertion instead of hanging in readFileSync.
      const writer = spawn("sh", ["-c", `printf %s '{}' > ${JSON.stringify(fifoPath)}`], {
        stdio: "ignore",
      });
      try {
        // Relative ref: an absolute spelling would be rejected by the
        // strict-ref gate (R1) before the regular-file guard ever runs.
        const result = loader.loadConfigsForCodon(
          [{ sentinelConfig: "pipe.json" }],
          "test-codon",
          testDataDir,
        );
        expect(result.configs.length).toBe(0);
        expect(result.errors.length).toBe(1);
        expect(result.errors[0].error).toContain("is not a regular file");
      } finally {
        writer.kill("SIGKILL");
      }
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
          sentinelConfig: "invalid-schema.json",
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
          sentinelConfig: "valid.json",
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

      const entries: CodonSentinelEntry[] = [{ sentinelConfig: "subdir/test.json" }];

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

  describe("Strict ref policy (spec 63)", () => {
    const baseSentinel = {
      id: "policy-sentinel",
      name: "Policy Sentinel",
      model: "anthropic/claude-3-5-haiku-20241022",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "Test",
    };

    test("an absolute entry ref lands in errors[] with the configured fatality", () => {
      const configPath = path.join(testDataDir, "abs.json");
      fs.writeFileSync(configPath, JSON.stringify(baseSentinel));

      const result = loader.loadConfigsForCodon(
        [{ sentinelConfig: configPath, settings: { failCodonIfNotLoaded: true } }],
        "test-codon",
        testDataDir,
      );

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].fatal).toBe(true);
      expect(result.errors[0].error).toContain("is an absolute or drive-qualified path");
    });

    test("an escaping entry ref is rejected, non-fatally by default", () => {
      const result = loader.loadConfigsForCodon(
        [{ sentinelConfig: "../outside/check.json" }],
        "test-codon",
        testDataDir,
      );

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].fatal).toBe(false);
      expect(result.errors[0].error).toContain("resolves outside the hank directory");
    });

    test("a file config's own escaping ref is rejected with its field name", () => {
      fs.mkdirSync(path.join(testDataDir, "sentinels"));
      fs.writeFileSync(
        path.join(testDataDir, "sentinels", "leaky.json"),
        JSON.stringify({ ...baseSentinel, systemPromptFile: "../../leak.md" }),
      );

      const result = loader.loadConfigsForCodon(
        [{ sentinelConfig: "sentinels/leaky.json" }],
        "test-codon",
        testDataDir,
      );

      expect(result.configs.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toContain(
        'systemPromptFile: "../../leak.md" resolves outside the hank directory',
      );
    });

    test("a file config's ../ ref that climbs back inside the hank stays legal", () => {
      // The legality guarantee: sentinels/check.json -> ../prompts/ok.md
      fs.mkdirSync(path.join(testDataDir, "sentinels"));
      fs.mkdirSync(path.join(testDataDir, "prompts"));
      fs.writeFileSync(path.join(testDataDir, "prompts", "ok.md"), "ok");
      fs.writeFileSync(
        path.join(testDataDir, "sentinels", "check.json"),
        JSON.stringify({ ...baseSentinel, systemPromptFile: "../prompts/ok.md" }),
      );

      const result = loader.loadConfigsForCodon(
        [{ sentinelConfig: "sentinels/check.json" }],
        "test-codon",
        testDataDir,
      );

      expect(result.errors).toEqual([]);
      expect(result.configs.length).toBe(1);
      expect(result.configs[0].configDirectory).toBe(path.join(testDataDir, "sentinels"));
    });

    test.skipIf(process.platform === "win32")(
      "own-ref policy re-runs on cache hits (disk changed between codons)",
      () => {
        fs.mkdirSync(path.join(testDataDir, "prompts"));
        fs.writeFileSync(path.join(testDataDir, "prompts", "p.md"), "ok");
        fs.writeFileSync(
          path.join(testDataDir, "check.json"),
          JSON.stringify({ ...baseSentinel, systemPromptFile: "prompts/p.md" }),
        );

        const entries: CodonSentinelEntry[] = [{ sentinelConfig: "check.json" }];
        const first = loader.loadConfigsForCodon(entries, "codon-1", testDataDir);
        expect(first.errors).toEqual([]);

        // Swap the prompt for a symlink between codons; the cached parsed
        // config must not skip policy.
        fs.unlinkSync(path.join(testDataDir, "prompts", "p.md"));
        fs.writeFileSync(path.join(testDataDir, "real.md"), "elsewhere");
        fs.symlinkSync(
          path.join(testDataDir, "real.md"),
          path.join(testDataDir, "prompts", "p.md"),
        );

        const second = loader.loadConfigsForCodon(entries, "codon-2", testDataDir);
        expect(second.configs.length).toBe(0);
        expect(second.errors.length).toBe(1);
        expect(second.errors[0].error).toContain("passes through a symlink");
      },
    );

    test.skipIf(process.platform === "win32")("a symlinked entry ref is rejected", () => {
      fs.writeFileSync(path.join(testDataDir, "real-config.json"), JSON.stringify(baseSentinel));
      fs.symlinkSync(
        path.join(testDataDir, "real-config.json"),
        path.join(testDataDir, "linked.json"),
      );

      const result = loader.loadConfigsForCodon(
        [{ sentinelConfig: "linked.json" }],
        "test-codon",
        testDataDir,
      );

      expect(result.configs.length).toBe(0);
      expect(result.errors[0].error).toContain("passes through a symlink");
    });
  });
});
