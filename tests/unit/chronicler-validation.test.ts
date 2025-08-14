import { describe, expect, it } from "bun:test";
import {
  chroniclerConfigSchema,
  chroniclerExecutionSchema,
  chroniclerTriggerSchema,
} from "../../server/config-validation/chronicler.schema.js";
import type { ChroniclerConfig } from "../../server/types/chronicler-types.js";

describe("Chronicler Configuration Validation", () => {
  describe("Valid Configurations", () => {
    it("should accept a valid event trigger configuration", () => {
      const config: ChroniclerConfig = {
        id: "narrator",
        name: "Narrator Chronicler",
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
        promptTemplate: "Summarize the following events: {{events}}",
        model: "sonnet",
        output: {
          format: "text",
          file: "narrator.log",
        },
      };

      const result = chroniclerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept a valid sequence trigger configuration", () => {
      const config: ChroniclerConfig = {
        id: "error-detector",
        name: "Error Pattern Detector",
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
        promptTemplate: "Three consecutive errors detected: {{events}}",
      };

      const result = chroniclerConfigSchema.safeParse(config);
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
        const result = chroniclerExecutionSchema.safeParse(strategy);
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
        const result = chroniclerTriggerSchema.safeParse(trigger);
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

      const result = chroniclerTriggerSchema.safeParse(config);
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

      const result = chroniclerTriggerSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain(
          "not valid for any of the specified event types",
        );
      }
    });

    it("should reject invalid chronicler IDs", () => {
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
          promptTemplate: "test",
        };

        const result = chroniclerConfigSchema.safeParse(config);
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
        const result = chroniclerExecutionSchema.safeParse(strategy);
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

      const result = chroniclerTriggerSchema.safeParse(config);
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
        const result = chroniclerTriggerSchema.safeParse(trigger);
        expect(result.success).toBe(false);
      }
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
            path: "phaseId",
            value: "test-phase",
          },
        ],
      };

      const validResult = chroniclerTriggerSchema.safeParse(validConfig);
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

      const invalidResult = chroniclerTriggerSchema.safeParse(invalidConfig);
      expect(invalidResult.success).toBe(false);
    });

    it("should validate nested paths", () => {
      const config = {
        type: "event",
        on: ["phase.completed"],
        conditions: [
          {
            operator: "equals",
            path: "exitStatus.type",
            value: "success",
          },
        ],
      };

      const result = chroniclerTriggerSchema.safeParse(config);
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

      const result = chroniclerTriggerSchema.safeParse(config);
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

      const invalidResult = chroniclerTriggerSchema.safeParse(invalidConfig);
      expect(invalidResult.success).toBe(false);
    });
  });
});
