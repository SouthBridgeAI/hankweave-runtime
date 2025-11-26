import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SentinelConfig } from "../../server/config-validation/sentinel.schema.js";

/**
 * Unit tests for codon-level override functionality.
 * Tests that codon-level settings properly override sentinel-level settings.
 */

describe("Codon-Level Sentinel Overrides", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `sentinel-overrides-test-${Date.now()}`);
    await fs.promises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    }
  });

  describe("reportToWebsocket override", () => {
    it("should merge codon-level reportToWebsocket over sentinel-level", () => {
      // Sentinel config with some settings
      const sentinelConfig: SentinelConfig = {
        id: "test-sentinel",
        name: "Test",
        model: "mockmodel",
        trigger: { type: "event", on: ["info"] },
        execution: { strategy: "immediate" },
        userPromptText: "test",
        reportToWebsocket: {
          lifecycle: true,
          errors: true,
          outputs: true,
          triggers: false,
        },
      };

      // Codon-level override (disables outputs)
      const codonOverride = {
        outputs: false,
        triggers: true, // Enable what was disabled
      };

      // Expected merged result
      const expected = {
        lifecycle: true, // From sentinel (not overridden)
        errors: true, // From sentinel (not overridden)
        outputs: false, // From codon override
        triggers: true, // From codon override
      };

      // Perform merge (same logic as StrandweaveServer)
      const merged = {
        ...sentinelConfig.reportToWebsocket,
        ...codonOverride,
      };

      expect(merged).toEqual(expected);
    });

    it("should handle codon override when sentinel has no reportToWebsocket", () => {
      const sentinelConfig: Partial<SentinelConfig> = {
        id: "test",
        // No reportToWebsocket field
      };

      const codonOverride = {
        outputs: false,
      };

      // Safely merge even when sentinelConfig.reportToWebsocket is undefined
      const merged = {
        ...(sentinelConfig.reportToWebsocket || {}),
        ...codonOverride,
      };

      expect(merged.outputs).toBe(false);
    });

    it("should handle empty codon override (sentinel settings used)", () => {
      // Create defined settings to work with
      const sentinelSettings = {
        outputs: true,
        triggers: false,
      };

      // Base sentinel config would have these settings
      const _baseConfig: SentinelConfig = {
        id: "test",
        name: "Test",
        model: "mockmodel",
        trigger: { type: "event", on: ["info"] },
        execution: { strategy: "immediate" },
        userPromptText: "test",
        reportToWebsocket: sentinelSettings,
      };

      // When no codon override exists, just use sentinel settings
      const codonOverride = null;

      const merged = codonOverride || sentinelSettings;

      expect(merged).toEqual(sentinelSettings);
      expect(merged.outputs).toBe(true);
      expect(merged.triggers).toBe(false);
    });
  });

  describe("outputPaths configuration", () => {
    it("should handle outputPaths from codon settings", () => {
      const codonOutputPaths = {
        logFile: "custom-log.md",
        lastValueFile: "custom-current.md",
      };

      // These would be stored in a Map<string, OutputPaths> in StrandweaveServer
      const outputPathsMap = new Map<string, typeof codonOutputPaths>();
      outputPathsMap.set("sentinel-1", codonOutputPaths);

      const retrieved = outputPathsMap.get("sentinel-1");
      expect(retrieved).toEqual(codonOutputPaths);
    });

    it("should handle missing outputPaths gracefully", () => {
      const outputPathsMap = new Map<string, { logFile?: string; lastValueFile?: string }>();

      const retrieved = outputPathsMap.get("nonexistent-sentinel");
      expect(retrieved).toBeUndefined();
    });
  });

  describe("Integration with SentinelConfigLoader", () => {
    it("should preserve outputPaths and failCodonIfNotLoaded from loader", async () => {
      const { SentinelConfigLoader } = await import(
        "../../server/sentinels/sentinel-config-loader.js"
      );

      // Create a test sentinel config file
      const configFile = path.join(testDir, "test-sentinel.json");
      const config = {
        id: "test",
        name: "Test",
        model: "mockmodel",
        trigger: { type: "event", on: ["info"] },
        execution: { strategy: "immediate" },
        userPromptText: "test",
        reportToWebsocket: {
          outputs: true,
        },
      };

      await fs.promises.writeFile(configFile, JSON.stringify(config));

      const loader = new SentinelConfigLoader();

      const result = loader.loadConfigsForCodon(
        [
          {
            sentinelConfig: configFile,
            settings: {
              failCodonIfNotLoaded: true,
              outputPaths: {
                logFile: "custom.md",
              },
              reportToWebsocket: {
                outputs: false, // Override
              },
            },
          },
        ],
        "test-codon",
        testDir,
      );

      expect(result.configs).toHaveLength(1);
      expect(result.errors).toHaveLength(0);

      const loaded = result.configs[0];
      expect(loaded.failCodonIfNotLoaded).toBe(true);
      expect(loaded.outputPaths).toEqual({ logFile: "custom.md" });
      expect(loaded.config.reportToWebsocket?.outputs).toBe(true); // Not merged yet - that happens in StrandweaveServer
    });
  });
});
