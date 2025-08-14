import { z } from "zod";
import {
  type ServerEvent,
  serverEventDataSchemas,
  serverEventTypes,
} from "../schemas/event-schemas.js";

// Helper function to check if a string is a valid event type
const isValidEventType = (type: string): boolean => {
  return serverEventTypes.includes(type as ServerEvent["type"]);
};

// Helper function to resolve nested paths in objects
function getValueByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current = obj as Record<string, unknown>;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[part] as Record<string, unknown>;
  }

  return current;
}

// Condition schemas with refinements
const equalsConditionSchema = z.object({
  operator: z.enum(["equals", "notEquals"]),
  path: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

const inConditionSchema = z.object({
  operator: z.enum(["in", "notIn"]),
  path: z.string().min(1),
  value: z.array(z.union([z.string(), z.number()])).min(1),
});

const containsConditionSchema = z.object({
  operator: z.literal("contains"),
  path: z.string().min(1),
  value: z.string(),
});

const matchesConditionSchema = z.object({
  operator: z.literal("matches"),
  path: z.string().min(1),
  value: z.string(),
});

const numericComparisonConditionSchema = z.object({
  operator: z.enum(["greaterThan", "lessThan"]),
  path: z.string().min(1),
  value: z.number(),
});

const conditionSchema = z.discriminatedUnion("operator", [
  equalsConditionSchema,
  inConditionSchema,
  containsConditionSchema,
  matchesConditionSchema,
  numericComparisonConditionSchema,
]);

// Pattern step schema with validation
const patternStepSchema = z
  .object({
    type: z.string().refine(isValidEventType, {
      message: "Invalid event type",
    }) as z.ZodType<ServerEvent["type"]>,
    conditions: z.array(conditionSchema).optional(),
  })
  .superRefine((data, ctx) => {
    // Validate that condition paths are valid for the event type
    if (data.conditions) {
      const eventSchema = serverEventDataSchemas[data.type];
      if (eventSchema && eventSchema instanceof z.ZodObject) {
        const shape = eventSchema.shape;

        for (const condition of data.conditions) {
          const pathParts = condition.path.split(".");
          let currentShape: Record<string, z.ZodTypeAny> | null = shape;
          let validPath = true;

          for (let i = 0; i < pathParts.length; i++) {
            const part = pathParts[i];
            if (!currentShape || !currentShape[part]) {
              validPath = false;
              break;
            }

            // Try to get the inner type for nested objects
            const fieldSchema = currentShape[part];
            if (fieldSchema instanceof z.ZodObject) {
              currentShape = fieldSchema.shape;
            } else if (
              fieldSchema instanceof z.ZodOptional &&
              fieldSchema._def.innerType instanceof z.ZodObject
            ) {
              currentShape = fieldSchema._def.innerType.shape;
            } else if (
              fieldSchema instanceof z.ZodUnion ||
              fieldSchema instanceof z.ZodDiscriminatedUnion
            ) {
              // For unions (including discriminated unions), check if any option is an object with the needed shape
              let unionOptions: z.ZodTypeAny[];
              if (fieldSchema instanceof z.ZodDiscriminatedUnion) {
                // For discriminated unions, get options from the optionsMap
                unionOptions = Array.from(fieldSchema._def.optionsMap.values());
              } else {
                // For regular unions
                unionOptions = fieldSchema._def.options;
              }

              let foundObjectShape: Record<string, z.ZodTypeAny> | null = null;
              for (const option of unionOptions) {
                if (option instanceof z.ZodObject) {
                  const optionShape = option.shape;
                  // Check if the next part of the path exists in this option
                  if (i < pathParts.length - 1 && optionShape[pathParts[i + 1]]) {
                    foundObjectShape = optionShape;
                    break;
                  }
                }
              }
              currentShape = foundObjectShape;
            } else {
              // We've reached a leaf node, no more nesting possible
              currentShape = null;
            }
          }

          if (!validPath) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Invalid path "${condition.path}" for event type "${data.type}"`,
              path: ["conditions"],
            });
          }
        }
      }
    }
  });

// Event trigger schema
const eventTriggerSchema = z.object({
  type: z.literal("event"),
  on: z
    .array(
      z.string().refine(isValidEventType, {
        message: "Invalid event type",
      }) as z.ZodType<ServerEvent["type"]>,
    )
    .min(1),
  conditions: z.array(conditionSchema).optional(),
});

// Sequence trigger schema
const sequenceTriggerSchema = z.object({
  type: z.literal("sequence"),
  interestFilter: z.object({
    on: z
      .array(
        z.string().refine(isValidEventType, {
          message: "Invalid event type",
        }) as z.ZodType<ServerEvent["type"]>,
      )
      .min(1),
  }),
  pattern: z.array(patternStepSchema).min(1),
  options: z
    .object({
      consecutive: z.boolean().optional(),
    })
    .optional(),
});

// Main trigger schema with path validation
export const chroniclerTriggerSchema = z
  .discriminatedUnion("type", [eventTriggerSchema, sequenceTriggerSchema])
  .superRefine((trigger, ctx) => {
    // Additional validation for EventTrigger conditions
    if (trigger.type === "event" && trigger.conditions) {
      // For event triggers, we need to validate paths against all possible event types
      for (const condition of trigger.conditions) {
        let validForAnyEvent = false;

        for (const eventType of trigger.on) {
          const eventSchema = serverEventDataSchemas[eventType];
          if (eventSchema && eventSchema instanceof z.ZodObject) {
            const shape = eventSchema.shape;

            // Check if path is valid for this event type
            const pathParts = condition.path.split(".");
            let currentShape: Record<string, z.ZodTypeAny> | null = shape;
            let validPath = true;

            for (let i = 0; i < pathParts.length; i++) {
              const part = pathParts[i];
              if (!currentShape || !currentShape[part]) {
                validPath = false;
                break;
              }

              const fieldSchema = currentShape[part];
              if (fieldSchema instanceof z.ZodObject) {
                currentShape = fieldSchema.shape;
              } else if (
                fieldSchema instanceof z.ZodOptional &&
                fieldSchema._def.innerType instanceof z.ZodObject
              ) {
                currentShape = fieldSchema._def.innerType.shape;
              } else if (
                fieldSchema instanceof z.ZodUnion ||
                fieldSchema instanceof z.ZodDiscriminatedUnion
              ) {
                // For unions (including discriminated unions), check if any option is an object with the needed shape
                let unionOptions: z.ZodTypeAny[];
                if (fieldSchema instanceof z.ZodDiscriminatedUnion) {
                  // For discriminated unions, get options from the optionsMap
                  unionOptions = Array.from(fieldSchema._def.optionsMap.values());
                } else {
                  // For regular unions
                  unionOptions = fieldSchema._def.options;
                }

                let foundObjectShape: Record<string, z.ZodTypeAny> | null = null;
                for (const option of unionOptions) {
                  if (option instanceof z.ZodObject) {
                    const optionShape = option.shape;
                    // Check if the next part of the path exists in this option
                    if (i < pathParts.length - 1 && optionShape[pathParts[i + 1]]) {
                      foundObjectShape = optionShape;
                      break;
                    }
                  }
                }
                currentShape = foundObjectShape;
              } else {
                currentShape = null;
              }
            }

            if (validPath) {
              validForAnyEvent = true;
              break;
            }
          }
        }

        if (!validForAnyEvent) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Path "${condition.path}" is not valid for any of the specified event types`,
            path: ["conditions"],
          });
        }
      }
    }
  });

// Execution strategy schemas
export const chroniclerExecutionSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("immediate") }),
  z.object({
    strategy: z.literal("debounce"),
    milliseconds: z.number().int().positive().max(300000), // Max 5 minutes
  }),
  z.object({
    strategy: z.literal("count"),
    threshold: z.number().int().positive().max(1000),
  }),
  z.object({
    strategy: z.literal("timeWindow"),
    milliseconds: z.number().int().positive().max(3600000), // Max 1 hour
  }),
]);

// Main chronicler configuration schema
export const chroniclerConfigSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, {
      message: "ID must contain only lowercase letters, numbers, and hyphens",
    }),
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: chroniclerTriggerSchema,
  execution: chroniclerExecutionSchema,
  promptTemplate: z.string().min(1),
  model: z.enum(["sonnet", "opus"]).optional(),
  output: z
    .object({
      format: z.enum(["text", "json", "jsonl"]).optional(),
      file: z.string().optional(),
    })
    .optional(),
});

// Array of chronicler configs
export const chroniclersArraySchema = z.array(chroniclerConfigSchema);

// Export types derived from schemas
export type ChroniclerConfig = z.infer<typeof chroniclerConfigSchema>;
export type ChroniclerTrigger = z.infer<typeof chroniclerTriggerSchema>;
export type ChroniclerExecution = z.infer<typeof chroniclerExecutionSchema>;

// Derive individual condition types
export type EqualsCondition = z.infer<typeof equalsConditionSchema>;
export type InCondition = z.infer<typeof inConditionSchema>;
export type ContainsCondition = z.infer<typeof containsConditionSchema>;
export type MatchesCondition = z.infer<typeof matchesConditionSchema>;
export type NumericComparisonCondition = z.infer<typeof numericComparisonConditionSchema>;
export type Condition = z.infer<typeof conditionSchema>;

// Derive trigger types
export type PatternStep = z.infer<typeof patternStepSchema>;
export type EventTrigger = z.infer<typeof eventTriggerSchema>;
export type SequenceTrigger = z.infer<typeof sequenceTriggerSchema>;

// Derive execution types
export type ImmediateExecution = { strategy: "immediate" };
export type DebounceExecution = { strategy: "debounce"; milliseconds: number };
export type CountExecution = { strategy: "count"; threshold: number };
export type TimeWindowExecution = { strategy: "timeWindow"; milliseconds: number };

// Export helper function for use in other modules
export { getValueByPath };
