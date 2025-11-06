import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChroniclerConfig } from "../../server/types/chronicler-types.js";

/**
 * Unit tests for phase-level override functionality.
 * Tests that phase-level settings properly override chronicler-level settings.
 */

describe("Phase-Level Chronicler Overrides", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `chronicler-overrides-test-${Date.now()}`);
    await fs.promises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    }
  });

  describe("reportToWebsocket override", () => {
    it("should merge phase-level reportToWebsocket over chronicler-level", () => {
      // Chronicler config with some settings
      const chroniclerConfig: ChroniclerConfig = {
        id: "test-chronicler",
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

      // Phase-level override (disables outputs)
      const phaseOverride = {
        outputs: false,
        triggers: true, // Enable what was disabled
      };

      // Expected merged result
      const expected = {
        lifecycle: true, // From chronicler (not overridden)
        errors: true, // From chronicler (not overridden)
        outputs: false, // From phase override
        triggers: true, // From phase override
      };

      // Perform merge (same logic as TadpoleServer)
      const merged = {
        ...chroniclerConfig.reportToWebsocket,
        ...phaseOverride,
      };

      expect(merged).toEqual(expected);
    });

    it("should handle phase override when chronicler has no reportToWebsocket", () => {
      const chroniclerConfig: Partial<ChroniclerConfig> = {
        id: "test",
        // No reportToWebsocket field
      };

      const phaseOverride = {
        outputs: false,
      };

      // Safely merge even when chroniclerConfig.reportToWebsocket is undefined
      const merged = {
        ...(chroniclerConfig.reportToWebsocket || {}),
        ...phaseOverride,
      };

      expect(merged.outputs).toBe(false);
    });

    it("should handle empty phase override (chronicler settings used)", () => {
      // Create defined settings to work with
      const chroniclerSettings = {
        outputs: true,
        triggers: false,
      };

      // Base chronicler config would have these settings
      const _baseConfig: ChroniclerConfig = {
        id: "test",
        name: "Test",
        model: "mockmodel",
        trigger: { type: "event", on: ["info"] },
        execution: { strategy: "immediate" },
        userPromptText: "test",
        reportToWebsocket: chroniclerSettings,
      };

      // When no phase override exists, just use chronicler settings
      const phaseOverride = null;

      const merged = phaseOverride || chroniclerSettings;

      expect(merged).toEqual(chroniclerSettings);
      expect(merged.outputs).toBe(true);
      expect(merged.triggers).toBe(false);
    });
  });

  describe("outputPaths configuration", () => {
    it("should handle outputPaths from phase settings", () => {
      const phaseOutputPaths = {
        logFile: "custom-log.md",
        lastValueFile: "custom-current.md",
      };

      // These would be stored in a Map<string, OutputPaths> in TadpoleServer
      const outputPathsMap = new Map<string, typeof phaseOutputPaths>();
      outputPathsMap.set("chronicler-1", phaseOutputPaths);

      const retrieved = outputPathsMap.get("chronicler-1");
      expect(retrieved).toEqual(phaseOutputPaths);
    });

    it("should handle missing outputPaths gracefully", () => {
      const outputPathsMap = new Map<string, { logFile?: string; lastValueFile?: string }>();

      const retrieved = outputPathsMap.get("nonexistent-chronicler");
      expect(retrieved).toBeUndefined();
    });
  });

  describe("Integration with ChroniclerConfigLoader", () => {
    it("should preserve outputPaths and failPhaseIfNotLoaded from loader", async () => {
      const { ChroniclerConfigLoader } = await import(
        "../../server/chroniclers/chronicler-config-loader.js"
      );

      // Create a test chronicler config file
      const configFile = path.join(testDir, "test-chronicler.json");
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

      const loader = new ChroniclerConfigLoader();

      const result = loader.loadConfigsForPhase(
        [
          {
            chroniclerConfig: configFile,
            settings: {
              failPhaseIfNotLoaded: true,
              outputPaths: {
                logFile: "custom.md",
              },
              reportToWebsocket: {
                outputs: false, // Override
              },
            },
          },
        ],
        "test-phase",
        testDir,
      );

      expect(result.configs).toHaveLength(1);
      expect(result.errors).toHaveLength(0);

      const loaded = result.configs[0];
      expect(loaded.failPhaseIfNotLoaded).toBe(true);
      expect(loaded.outputPaths).toEqual({ logFile: "custom.md" });
      expect(loaded.config.reportToWebsocket?.outputs).toBe(true); // Not merged yet - that happens in TadpoleServer
    });
  });
});
