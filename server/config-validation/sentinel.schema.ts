import { z } from "zod";
import {
  type ServerEvent,
  sentinelVirtualFields,
  serverEventDataSchemas,
  serverEventTypes,
} from "../schemas/event-schemas.js";
import { hankweaveLlmCallParamsSchema } from "../types/llm-call-types.js";
import {
  inlineSentinelRefsEscapeIssues,
  portableRefFieldSchema,
  portableRefStringSchema,
  refStringSchema,
} from "../utils.js";

// Helper function to check if a string is a valid event type or wildcard
const isValidEventType = (type: string): boolean => {
  return type === "*" || serverEventTypes.includes(type as ServerEvent["type"]);
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

/**
 * Why this exists, in plain terms: this file checks sentinel configs when a
 * hank loads. Each condition names a field on an event ("path": "content"),
 * and we verify that field really exists on that event's schema — otherwise
 * a typo ("contnet") would make the sentinel silently never fire, with no
 * error, ever. Better to fail loudly at load time.
 *
 * Since the fingerprint-events change, `file.updated` events no longer carry
 * a `content` field on the wire — sentinels still get one, but it is
 * attached to their view of the event at trigger time and filled in on
 * demand. The schema check can't see that trick, so without help it would
 * reject every working content-condition. This allow-list (declared next to
 * the event schemas as `sentinelVirtualFields`) tells the checker which
 * filled-in-later fields are legal. It is an exact match, not a wildcard:
 * `content` on `file.updated` passes; `contnet`, `content.length`, or
 * `content` on any other event type still fail like any typo.
 */
const isVirtualConditionPath = (eventType: string, conditionPath: string): boolean =>
  sentinelVirtualFields[eventType]?.includes(conditionPath) ?? false;

/**
 * Top-level object shapes of an event data schema: one for a plain object,
 * one per object arm should a union event schema ever exist. Refinements
 * (ZodEffects, e.g. assistant.action's tool_use join-key requirement) are
 * unwrapped to the object they refine. A condition path is valid if any arm
 * accepts it.
 */
function topLevelObjectShapes(schema: z.ZodTypeAny): Array<Record<string, z.ZodTypeAny>> {
  if (schema instanceof z.ZodEffects) {
    return topLevelObjectShapes(schema._def.schema);
  }
  if (schema instanceof z.ZodObject) {
    return [schema.shape];
  }
  if (schema instanceof z.ZodUnion) {
    return (schema._def.options as z.ZodTypeAny[])
      .filter((option): option is z.ZodObject<z.ZodRawShape> => option instanceof z.ZodObject)
      .map((option) => option.shape);
  }
  return [];
}

/** Walk a dotted condition path through a schema shape, descending into nested objects, optionals and unions. */
function isValidConditionPath(
  topShape: Record<string, z.ZodTypeAny>,
  pathParts: string[],
): boolean {
  let currentShape: Record<string, z.ZodTypeAny> | null = topShape;

  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];
    if (!currentShape || !currentShape[part]) {
      return false;
    }

    // Try to get the inner type for nested objects
    const fieldSchema: z.ZodTypeAny = currentShape[part];
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

  return true;
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

// Type for event types including wildcard
type EventTypeOrWildcard = ServerEvent["type"] | "*";

// Pattern step schema with validation
const patternStepSchema = z
  .object({
    type: z.string().refine(isValidEventType, {
      message: "Invalid event type",
    }) as z.ZodType<EventTypeOrWildcard>,
    conditions: z.array(conditionSchema).optional(),
  })
  .superRefine((data, ctx) => {
    // Skip path validation for wildcard events
    if (data.type === "*") {
      return;
    }

    // Validate that condition paths are valid for the event type
    if (data.conditions) {
      const eventSchema = serverEventDataSchemas[data.type as ServerEvent["type"]];
      const shapes = eventSchema ? topLevelObjectShapes(eventSchema) : [];
      if (shapes.length > 0) {
        for (const condition of data.conditions) {
          const pathParts = condition.path.split(".");
          const validPath =
            shapes.some((shape) => isValidConditionPath(shape, pathParts)) ||
            isVirtualConditionPath(data.type, condition.path);

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
      }) as z.ZodType<EventTypeOrWildcard>,
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
        }) as z.ZodType<EventTypeOrWildcard>,
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
export const sentinelTriggerSchema = z
  .discriminatedUnion("type", [eventTriggerSchema, sequenceTriggerSchema])
  .superRefine((trigger, ctx) => {
    // Additional validation for EventTrigger conditions
    if (trigger.type === "event" && trigger.conditions) {
      // Skip validation if wildcard is present (any event type is allowed)
      if (trigger.on.includes("*")) {
        return; // Wildcard allows any path, skip validation
      }

      // For event triggers, we need to validate paths against all possible event types
      for (const condition of trigger.conditions) {
        let validForAnyEvent = false;

        for (const eventType of trigger.on) {
          // Skip wildcard in validation (already handled above)
          if (eventType === "*") {
            continue;
          }

          const eventSchema = serverEventDataSchemas[eventType as ServerEvent["type"]];
          const shapes = eventSchema ? topLevelObjectShapes(eventSchema) : [];
          const pathParts = condition.path.split(".");
          if (
            shapes.some((shape) => isValidConditionPath(shape, pathParts)) ||
            isVirtualConditionPath(eventType, condition.path)
          ) {
            validForAnyEvent = true;
            break;
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
export const sentinelExecutionSchema = z.discriminatedUnion("strategy", [
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

// --- Trimming Strategy Schema (for Conversational mode) ---
// Intent: Define how the conversation history is pruned to stay within LLM context limits
const trimmingStrategySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("maxTurns"),
    maxTurns: z.number().int().positive().max(100),
  }),
  z.object({
    type: z.literal("maxTokens"),
    maxTokens: z.number().int().positive().max(100000),
  }),
]);

// --- Error Handling Schema ---
// Intent: Configure sentinel error handling behavior
const errorHandlingSchema = z
  .object({
    maxConsecutiveFailures: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum consecutive failures before unloading sentinel. Default: 3"),
    unloadOnFatalError: z
      .boolean()
      .optional()
      .describe("Whether to unload on fatal errors. Default: true"),
  })
  .optional();

// --- Structured Output Schema ---
// Intent: Configure structured object generation with Zod schemas
// Uses union with refinement to enforce mutually exclusive configurations
const structuredOutputSchema = z
  .object({
    output: z.enum(["object", "array", "enum"]),
    schemaStr: z.string().optional().describe("Inline Zod schema code"),
    schemaFile: portableRefStringSchema("structuredOutput.schemaFile")
      .optional()
      .describe(
        "Path to a Zod schema file, relative to this config file's directory (or the hank directory for inline configs), using '/' separators. Must stay inside the hank directory; absolute paths and symlinks are rejected.",
      ),
    enumValues: z.array(z.string()).min(1).optional(), // For enum mode
    schemaName: z.string().optional(),
    schemaDescription: z.string().optional(),
  })
  .refine(
    (data) => {
      // Enum mode requires enumValues (and no schema)
      if (data.output === "enum") {
        return data.enumValues && data.enumValues.length > 0 && !data.schemaStr && !data.schemaFile;
      }
      // Object/array modes require exactly one of schemaStr or schemaFile
      const hasSchemaStr = !!data.schemaStr;
      const hasSchemaFile = !!data.schemaFile;
      return (
        (hasSchemaStr || hasSchemaFile) && !(hasSchemaStr && hasSchemaFile) && !data.enumValues
      );
    },
    {
      message:
        "Must provide exactly one of: schemaStr, schemaFile (for object/array), or enumValues (for enum)",
    },
  );

// Report to WebSocket configuration schema
const reportToWebsocketSchema = z
  .object({
    lifecycle: z.boolean().optional(),
    errors: z.boolean().optional(),
    outputs: z.boolean().optional(),
    triggers: z.boolean().optional(),
  })
  .optional();

// Main sentinel configuration schema
export const sentinelConfigSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, {
        message: "ID must contain only lowercase letters, numbers, and hyphens",
      }),
    name: z.string().min(1),
    description: z.string().optional(),
    trigger: sentinelTriggerSchema,
    execution: sentinelExecutionSchema,

    // Existing prompt fields remain. Ref fields get the portable-spelling
    // rule (R1) only: a FILE-based config's base is its own directory, whose
    // position inside the hank this schema cannot know, so a leading "../"
    // may be legal here. Escape/symlink checks (R2/R3) run in the loaders;
    // the inline branch of codonSentinelEntrySchema adds R2 at the wrapper.
    systemPromptFile: portableRefFieldSchema("systemPromptFile")
      .optional()
      .describe(
        "System prompt file(s), relative to this config file's directory (or the hank directory for inline configs), using '/' separators. Must stay inside the hank directory; absolute paths and symlinks are rejected.",
      ),
    systemPromptText: z.string().optional(),
    userPromptFile: portableRefFieldSchema("userPromptFile")
      .optional()
      .describe(
        "User prompt file(s), relative to this config file's directory (or the hank directory for inline configs), using '/' separators. Must stay inside the hank directory; absolute paths and symlinks are rejected.",
      ),
    userPromptText: z.string().optional(),

    // Optional conversational configuration
    // When present, enables stateful conversation tracking across triggers
    conversational: z
      .object({
        trimmingStrategy: trimmingStrategySchema,
        continueOnError: z.boolean().optional(),
      })
      .optional(),

    // Optional error handling configuration
    errorHandling: errorHandlingSchema,

    // Optional LLM parameters
    llmParams: hankweaveLlmCallParamsSchema.optional(),

    // Required model field - accepts full model IDs (e.g., "anthropic/claude-3-5-sonnet-20241022")
    model: z
      .string()
      .describe(
        'The full model ID to use (e.g., "anthropic/claude-3-5-sonnet-20241022", "openai/gpt-4-turbo").',
      ),

    // Optional structured output configuration
    structuredOutput: structuredOutputSchema.optional(),

    // Optional joinString for text output formatting
    // Supports escape sequences: \n, \t, \r, \\
    joinString: z
      .string()
      .optional()
      .describe(
        "String to join entries in text-based log file. Only valid for text output. " +
          "Supports escape sequences: \\n (newline), \\t (tab), \\r (carriage return), \\\\ (backslash). " +
          "Defaults to '\\n---\\n' for visual separation.",
      ),

    // Optional reportToWebsocket configuration
    reportToWebsocket: reportToWebsocketSchema,

    output: z
      .object({
        format: z.enum(["text", "jsonl"]).optional(),
        file: z.string().optional(),
        lastValueFile: z.string().optional(),
      })
      .optional(),
  })
  .strict() // Enforce no unknown keys
  .refine((data) => data.userPromptFile || data.userPromptText, {
    message:
      "Each sentinel must have at least one of `userPromptFile` or `userPromptText` defined.",
    path: [],
  })
  .refine(
    (data) => {
      // Conversational sentinels require a system prompt to establish context
      if (data.conversational) {
        return data.systemPromptFile || data.systemPromptText;
      }
      return true;
    },
    {
      message:
        "Conversational sentinels require a system prompt (systemPromptFile or systemPromptText).",
      path: ["conversational"],
    },
  )
  .refine(
    (data) => {
      // joinString is only valid for text output, not structured output
      if (data.joinString && data.structuredOutput) {
        return false;
      }
      return true;
    },
    {
      message: "joinString is only valid for text output, not structured output",
      path: ["joinString"],
    },
  )
  .refine(
    (data) => {
      if (data.structuredOutput && data.output?.format) {
        return false;
      }
      return true;
    },
    {
      message:
        "output.format is ignored when structuredOutput is configured. " +
        "Structured output format is determined by the schema.",
      path: ["output", "format"],
    },
  );

// Array of sentinel configs
export const sentinelsArraySchema = z.array(sentinelConfigSchema);

// Export types derived from schemas (single source of truth)
export type SentinelConfig = z.infer<typeof sentinelConfigSchema>;
export type TrimmingStrategy = z.infer<typeof trimmingStrategySchema>;
export type SentinelLlmParams = z.infer<typeof hankweaveLlmCallParamsSchema>;
export type ConversationalConfig = z.infer<typeof sentinelConfigSchema>["conversational"];
export type SentinelTrigger = z.infer<typeof sentinelTriggerSchema>;
export type SentinelExecution = z.infer<typeof sentinelExecutionSchema>;

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
export type TimeWindowExecution = {
  strategy: "timeWindow";
  milliseconds: number;
};

// Codon-specific settings schema
export const codonSentinelSettingsSchema = z
  .object({
    failCodonIfNotLoaded: z.boolean().optional(),
    outputPaths: z
      .object({
        logFile: z.string().optional(),
        lastValueFile: z.string().optional(),
      })
      .optional(),
    reportToWebsocket: reportToWebsocketSchema,
  })
  .optional();

// Codon sentinel entry schema (wrapper pattern)
export const codonSentinelEntrySchema = z.object({
  sentinelConfig: z.union([
    // File path — hank-dir anchored, so the full textual rules (R1+R2) apply.
    refStringSchema("sentinelConfig").describe(
      "Path to a sentinel config file, relative to the hank directory and inside it, using '/' separators; absolute paths, '..' escapes, and symlinks are rejected.",
    ),
    // Inline config — its base is knowably the hank dir, so this wrapper
    // adds the escape rule (R2) the standalone schema can't apply.
    sentinelConfigSchema.superRefine((config, ctx) => {
      for (const message of inlineSentinelRefsEscapeIssues(config)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      }
    }),
  ]),
  settings: codonSentinelSettingsSchema,
});

// Export type
export type CodonSentinelSettings = z.infer<typeof codonSentinelSettingsSchema>;

// Export helper function for use in other modules
export { getValueByPath };
