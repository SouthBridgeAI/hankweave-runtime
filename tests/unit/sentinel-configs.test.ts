import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Condition, PatternStep } from "../../server/config-validation/sentinel.schema.js";
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

  describe("Trigger Coverage", () => {
    it("should cover various event types", () => {
      const eventTypes = new Set<string>();

      for (const config of configFiles) {
        if (config.content.trigger.type === "event") {
          config.content.trigger.on.forEach((event: string) => eventTypes.add(event));
        } else if (config.content.trigger.type === "sequence") {
          config.content.trigger.interestFilter.on.forEach((event: string) =>
            eventTypes.add(event),
          );
        }
      }

      // Check we're monitoring a good variety of events
      expect(eventTypes.size).toBeGreaterThanOrEqual(5);

      // Check we have some key events covered
      expect(eventTypes.has("assistant.action")).toBe(true);
      expect(eventTypes.has("tool.result")).toBe(true);
      expect(eventTypes.has("codon.completed")).toBe(true);
    });

    it("should have both event and sequence triggers", () => {
      const triggerTypes = configFiles.map((c) => c.content.trigger.type);
      expect(triggerTypes).toContain("event");
      expect(triggerTypes).toContain("sequence");
    });

    it("should use various condition operators", () => {
      const operators = new Set<string>();

      for (const config of configFiles) {
        const trigger = config.content.trigger;

        // Check event trigger conditions
        if (trigger.conditions) {
          trigger.conditions.forEach((cond: Condition) => operators.add(cond.operator));
        }

        // Check sequence pattern conditions
        if (trigger.pattern) {
          trigger.pattern.forEach((step: PatternStep) => {
            if (step.conditions) {
              step.conditions.forEach((cond: Condition) => operators.add(cond.operator));
            }
          });
        }
      }

      // We should be using at least a few different operators
      expect(operators.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Execution Strategy Distribution", () => {
    it("should use all execution strategies", () => {
      const strategies = configFiles.map((c) => c.content.execution.strategy);

      expect(strategies).toContain("immediate");
      expect(strategies).toContain("debounce");
      expect(strategies).toContain("count");
      expect(strategies).toContain("timeWindow");
    });

    it("should have reasonable timing values", () => {
      for (const config of configFiles) {
        const exec = config.content.execution;

        if (exec.strategy === "debounce" || exec.strategy === "timeWindow") {
          expect(exec.milliseconds).toBeDefined();
          expect(exec.milliseconds).toBeGreaterThan(0);
          expect(exec.milliseconds).toBeLessThanOrEqual(300000); // Max 5 minutes
        }

        if (exec.strategy === "count") {
          expect(exec.threshold).toBeDefined();
          expect(exec.threshold).toBeGreaterThan(0);
          expect(exec.threshold).toBeLessThanOrEqual(1000);
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
            expect(["text", "json", "jsonl"]).toContain(config.content.output.format);
          }
        }
      }
    });
  });
});
