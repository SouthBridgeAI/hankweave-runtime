import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { sentinelConfigSchema } from "../../server/config-validation/sentinel.schema.js";

describe("Sentinel Configuration Files", () => {
  const configDir = path.join(process.cwd(), "tests/config/sentinel-triggers");

  // Get all JSON files in the directory
  const configFiles = fs
    .readdirSync(configDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      name: file,
      path: path.join(configDir, file),
      content: JSON.parse(fs.readFileSync(path.join(configDir, file), "utf-8")),
    }));

  describe("Configuration Validation", () => {
    for (const config of configFiles) {
      it(`should validate ${config.name}`, () => {
        const result = sentinelConfigSchema.safeParse(config.content);
        if (!result.success) {
          console.error(`Validation errors for ${config.name}:`, result.error.errors);
        }
        expect(result.success).toBe(true);
      });
    }
  });

  describe("Configuration Properties", () => {
    it("should have unique IDs across all configs", () => {
      const ids = configFiles.map((c) => c.content.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("should have valid execution strategies", () => {
      const validStrategies = ["immediate", "debounce", "count", "timeWindow"];
      for (const config of configFiles) {
        expect(validStrategies).toContain(config.content.execution.strategy);
      }
    });

    it("should have user prompts", () => {
      for (const config of configFiles) {
        // Check that at least one user prompt field is defined
        const hasUserPromptText = config.content.userPromptText !== undefined;
        const hasUserPromptFile = config.content.userPromptFile !== undefined;
        expect(hasUserPromptText || hasUserPromptFile).toBe(true);

        // If userPromptText is defined, it should not be empty
        if (hasUserPromptText) {
          expect(config.content.userPromptText.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("Output Configuration", () => {
    it("should have output configurations where appropriate", () => {
      for (const config of configFiles) {
        if (config.content.output) {
          // If output is defined, it should have at least format or file
          const hasFormat = config.content.output.format !== undefined;
          const hasFile = config.content.output.file !== undefined;
          expect(hasFormat || hasFile).toBe(true);

          // Check valid formats
          if (hasFormat) {
            expect(["text", "jsonl"]).toContain(config.content.output.format);
          }
        }
      }
    });
  });
});
