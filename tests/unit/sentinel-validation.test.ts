import { describe, expect, it } from "bun:test";
import type { SentinelConfig } from "../../server/config-validation/sentinel.schema.js";
import {
  sentinelConfigSchema,
  sentinelExecutionSchema,
  sentinelTriggerSchema,
} from "../../server/config-validation/sentinel.schema.js";

describe("Sentinel Configuration Validation", () => {
  describe("Valid Configurations", () => {
    it("should accept a valid event trigger configuration", () => {
      const config: SentinelConfig = {
        id: "narrator",
        name: "Narrator Sentinel",
        description: "Provides human-readable summaries",
        trigger: {
          type: "event",
          on: ["assistant.action", "tool.result"],
          conditions: [
            {
              operator: "equals",
              path: "action",
              value: "tool_use",
            },
          ],
        },
        execution: {
          strategy: "debounce",
          milliseconds: 2500,
        },
        userPromptText: "Summarize the following events: {{events}}",
        model: "sonnet",
        output: {
          format: "text",
          file: "narrator.log",
        },
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept a valid sequence trigger configuration", () => {
      const config: SentinelConfig = {
        id: "error-detector",
        name: "Error Pattern Detector",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "sequence",
          interestFilter: {
            on: ["tool.result"],
          },
          pattern: [
            {
              type: "tool.result",
              conditions: [
                {
                  operator: "equals",
                  path: "isError",
                  value: true,
                },
              ],
            },
            {
              type: "tool.result",
              conditions: [
                {
                  operator: "equals",
                  path: "isError",
                  value: true,
                },
              ],
            },
            {
              type: "tool.result",
              conditions: [
                {
                  operator: "equals",
                  path: "isError",
                  value: true,
                },
              ],
            },
          ],
          options: {
            consecutive: true,
          },
        },
        execution: {
          strategy: "immediate",
        },
        userPromptText: "Three consecutive errors detected: {{events}}",
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept all execution strategies", () => {
      const strategies = [
        { strategy: "immediate" },
        { strategy: "debounce", milliseconds: 1000 },
        { strategy: "count", threshold: 5 },
        { strategy: "timeWindow", milliseconds: 60000 },
      ];

      for (const strategy of strategies) {
        const result = sentinelExecutionSchema.safeParse(strategy);
        expect(result.success).toBe(true);
      }
    });

    it("should accept all condition operators", () => {
      const conditions = [
        { operator: "equals", path: "message", value: "test" },
        { operator: "notEquals", path: "message", value: "test" },
        { operator: "in", path: "message", value: ["a", "b"] },
        { operator: "notIn", path: "message", value: ["a", "b"] },
        { operator: "contains", path: "message", value: "substring" },
        { operator: "matches", path: "message", value: "^test.*" },
        { operator: "greaterThan", path: "totalCost", value: 10 },
        { operator: "lessThan", path: "totalCost", value: 100 },
      ];

      for (const condition of conditions) {
        // Use appropriate event types for different conditions
        let eventType = "info";
        if (condition.operator === "greaterThan" || condition.operator === "lessThan") {
          eventType = "token.usage"; // Has numeric totalCost field
        }

        const trigger = {
          type: "event",
          on: [eventType],
          conditions: [condition],
        };
        const result = sentinelTriggerSchema.safeParse(trigger);
        if (!result.success) {
          console.log(`Failed for condition:`, condition);
          console.log(`Error:`, result.error.errors);
        }
        expect(result.success).toBe(true);
      }
    });
  });

  describe("Invalid Configurations", () => {
    it("should reject invalid event types", () => {
      const config = {
        type: "event",
        on: ["invalid.event.type"],
        conditions: [],
      };

      const result = sentinelTriggerSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain("Invalid event type");
      }
    });

    it("should reject invalid paths for event types", () => {
      const config = {
        type: "event",
        on: ["assistant.action"],
        conditions: [
          {
            operator: "equals",
            path: "nonexistent.field",
            value: "test",
          },
        ],
      };

      const result = sentinelTriggerSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain(
          "not valid for any of the specified event types",
        );
      }
    });

    it("should reject invalid sentinel IDs", () => {
      const invalidIds = [
        "Invalid ID", // spaces
        "UPPERCASE", // uppercase
        "special@char", // special characters
        "", // empty
      ];

      for (const id of invalidIds) {
        const config = {
          id,
          name: "Test",
          trigger: { type: "event", on: ["info"] },
          execution: { strategy: "immediate" },
          userPromptText: "test",
        };

        const result = sentinelConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
      }
    });

    it("should reject execution strategies with invalid parameters", () => {
      const invalidStrategies = [
        { strategy: "debounce", milliseconds: -1 }, // negative
        { strategy: "debounce", milliseconds: 400000 }, // too large
        { strategy: "count", threshold: 0 }, // zero
        { strategy: "count", threshold: 1001 }, // too large
        { strategy: "timeWindow", milliseconds: 3700000 }, // too large
      ];

      for (const strategy of invalidStrategies) {
        const result = sentinelExecutionSchema.safeParse(strategy);
        expect(result.success).toBe(false);
      }
    });

    it("should reject sequence triggers without patterns", () => {
      const config = {
        type: "sequence",
        interestFilter: {
          on: ["tool.result"],
        },
        pattern: [], // Empty pattern
      };

      const result = sentinelTriggerSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should reject conditions with mismatched value types", () => {
      const invalidConditions = [
        { operator: "greaterThan", path: "field", value: "string" }, // string for numeric
        { operator: "contains", path: "field", value: 123 }, // number for string
        { operator: "in", path: "field", value: "not-array" }, // non-array for in
      ];

      for (const condition of invalidConditions) {
        const trigger = {
          type: "event",
          on: ["info"],
          conditions: [condition],
        };
        const result = sentinelTriggerSchema.safeParse(trigger);
        expect(result.success).toBe(false);
      }
    });
  });

  describe("Prompt Configuration", () => {
    it("should accept configuration with only userPromptFile", () => {
      const config: SentinelConfig = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["info"],
        },
        execution: {
          strategy: "immediate",
        },
        userPromptFile: "path/to/prompt.md",
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept configuration with userPromptFile array", () => {
      const config: SentinelConfig = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["info"],
        },
        execution: {
          strategy: "immediate",
        },
        userPromptFile: ["path/1.md", "path/2.md"],
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept configuration with only userPromptText", () => {
      const config: SentinelConfig = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["info"],
        },
        execution: {
          strategy: "immediate",
        },
        userPromptText: "This is a prompt.",
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept configuration with both userPromptFile and userPromptText", () => {
      const config: SentinelConfig = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["info"],
        },
        execution: {
          strategy: "immediate",
        },
        userPromptFile: "path/to/prompt.md",
        userPromptText: "Additional prompt text",
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept configuration with systemPromptFile and userPromptText", () => {
      const config: SentinelConfig = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["info"],
        },
        execution: {
          strategy: "immediate",
        },
        systemPromptFile: "path/to/system.md",
        userPromptText: "User prompt text",
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept configuration with systemPromptText and userPromptFile", () => {
      const config: SentinelConfig = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["info"],
        },
        execution: {
          strategy: "immediate",
        },
        systemPromptText: "System prompt text",
        userPromptFile: "path/to/user.md",
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept configuration with all four prompt fields", () => {
      const config: SentinelConfig = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["info"],
        },
        execution: {
          strategy: "immediate",
        },
        systemPromptFile: ["system1.md", "system2.md"],
        systemPromptText: "System prompt text",
        userPromptFile: ["user1.md", "user2.md"],
        userPromptText: "User prompt text",
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should fail validation if no user prompt is provided", () => {
      const config = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["info"],
        },
        execution: {
          strategy: "immediate",
        },
        // No userPromptFile or userPromptText
        systemPromptFile: "path/to/system.md",
        systemPromptText: "System prompt only",
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain(
          "Each sentinel must have at least one of `userPromptFile` or `userPromptText` defined.",
        );
      }
    });

    it("should fail validation if the old promptTemplate field is used", () => {
      const config = {
        id: "test-sentinel",
        name: "Test Sentinel",
        model: "anthropic/claude-3-5-sonnet-20241022",
        trigger: {
          type: "event",
          on: ["info"],
        },
        execution: {
          strategy: "immediate",
        },
        promptTemplate: "Old style prompt", // This should fail due to .strict()
        userPromptText: "New style prompt",
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        // The error message for unrecognized keys varies by Zod version
        const errorMessage = result.error.errors[0].message.toLowerCase();
        expect(errorMessage).toMatch(/unrecognized|unknown/);
      }
    });
  });

  describe("Structured Output Configuration", () => {
    it("should accept valid structured output with inline schema", () => {
      const config = {
        id: "test-structured",
        name: "Test Structured",
        model: "anthropic/claude",
        trigger: { type: "event" as const, on: ["file.updated" as const] },
        execution: { strategy: "immediate" as const },
        userPromptText: "Test",
        structuredOutput: {
          schemaStr: "z.object({ name: z.string() })",
          output: "object" as const,
        },
      };
      expect(() => sentinelConfigSchema.parse(config)).not.toThrow();
    });

    it("should accept structured output with schemaFile", () => {
      const config = {
        id: "test-file-schema",
        name: "Test File Schema",
        model: "openai/gpt-4o",
        trigger: { type: "event" as const, on: ["tool.result" as const] },
        execution: { strategy: "immediate" as const },
        userPromptText: "Test",
        structuredOutput: {
          schemaFile: "./schemas/test.ts",
          output: "array" as const,
        },
      };
      expect(() => sentinelConfigSchema.parse(config)).not.toThrow();
    });

    it("should accept enum output with enumValues", () => {
      const config = {
        id: "test-enum",
        name: "Test Enum",
        model: "anthropic/claude",
        trigger: { type: "event" as const, on: ["codon.completed" as const] },
        execution: { strategy: "immediate" as const },
        userPromptText: "Test",
        structuredOutput: {
          output: "enum" as const,
          enumValues: ["low", "medium", "high"],
        },
      };
      expect(() => sentinelConfigSchema.parse(config)).not.toThrow();
    });

    it("should reject object output without schema or schemaFile", () => {
      const config = {
        id: "test-no-schema",
        name: "Test No Schema",
        model: "anthropic/claude",
        trigger: { type: "event" as const, on: ["file.updated" as const] },
        execution: { strategy: "immediate" as const },
        userPromptText: "Test",
        structuredOutput: {
          output: "object" as const,
        },
      };
      expect(() => sentinelConfigSchema.parse(config)).toThrow();
    });

    it("should reject enum output without enumValues", () => {
      const config = {
        id: "test-enum-no-values",
        name: "Test Enum No Values",
        model: "anthropic/claude",
        trigger: { type: "event" as const, on: ["file.updated" as const] },
        execution: { strategy: "immediate" as const },
        userPromptText: "Test",
        structuredOutput: {
          output: "enum" as const,
        },
      };
      expect(() => sentinelConfigSchema.parse(config)).toThrow();
    });
  });

  describe("Path Validation", () => {
    it("should validate paths for specific event types", () => {
      // Valid path for assistant.action
      const validConfig = {
        type: "event",
        on: ["assistant.action"],
        conditions: [
          {
            operator: "equals",
            path: "codonId",
            value: "test-codon",
          },
        ],
      };

      const validResult = sentinelTriggerSchema.safeParse(validConfig);
      expect(validResult.success).toBe(true);

      // Invalid path for assistant.action
      const invalidConfig = {
        type: "event",
        on: ["assistant.action"],
        conditions: [
          {
            operator: "equals",
            path: "invalidPath",
            value: "test",
          },
        ],
      };

      const invalidResult = sentinelTriggerSchema.safeParse(invalidConfig);
      expect(invalidResult.success).toBe(false);
    });

    it("should validate nested paths", () => {
      const config = {
        type: "event",
        on: ["codon.completed"],
        conditions: [
          {
            operator: "equals",
            path: "exitStatus.type",
            value: "success",
          },
        ],
      };

      const result = sentinelTriggerSchema.safeParse(config);
      if (!result.success) {
        console.log(`Failed for nested path test:`, result.error.errors);
      }
      expect(result.success).toBe(true);
    });

    it("should validate paths in sequence patterns", () => {
      const config = {
        type: "sequence",
        interestFilter: {
          on: ["tool.result"],
        },
        pattern: [
          {
            type: "tool.result",
            conditions: [
              {
                operator: "equals",
                path: "isError",
                value: true,
              },
            ],
          },
        ],
      };

      const result = sentinelTriggerSchema.safeParse(config);
      expect(result.success).toBe(true);

      // Invalid path in pattern
      const invalidConfig = {
        type: "sequence",
        interestFilter: {
          on: ["tool.result"],
        },
        pattern: [
          {
            type: "tool.result",
            conditions: [
              {
                operator: "equals",
                path: "nonExistentField",
                value: true,
              },
            ],
          },
        ],
      };

      const invalidResult = sentinelTriggerSchema.safeParse(invalidConfig);
      expect(invalidResult.success).toBe(false);
    });
  });

  describe("structuredOutput + output.format conflict", () => {
    it("should reject config with both structuredOutput and output.format", () => {
      const config = {
        id: "conflict-test",
        name: "Conflict Test",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "test",
        model: "test-model",
        structuredOutput: {
          output: "enum",
          enumValues: ["a", "b"],
        },
        output: {
          format: "jsonl",
        },
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(
          messages.some((m) => m.includes("output.format is ignored when structuredOutput")),
        ).toBe(true);
      }
    });

    it("should accept config with structuredOutput and output.file (no format)", () => {
      const config = {
        id: "no-conflict",
        name: "No Conflict",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "test",
        model: "test-model",
        structuredOutput: {
          output: "enum",
          enumValues: ["a", "b"],
        },
        output: {
          file: "output.ndjson",
        },
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept config with output.format and no structuredOutput", () => {
      const config = {
        id: "format-only",
        name: "Format Only",
        trigger: { type: "event", on: ["assistant.action"] },
        execution: { strategy: "immediate" },
        userPromptText: "test",
        model: "test-model",
        output: {
          format: "jsonl",
          file: "output.jsonl",
        },
      };

      const result = sentinelConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  });
});
