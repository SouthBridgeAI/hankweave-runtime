/**
 * Chronicler Types
 *
 * This file re-exports types from the Zod schemas to maintain a single source of truth.
 * The schemas in server/config-validation/chronicler.schema.ts are the canonical definitions.
 *
 * All types are derived from the Zod schemas using z.infer<>, ensuring that:
 * 1. TypeScript types and runtime validation are always in sync
 * 2. We avoid dual source of truth issues
 * 3. Changes to validation logic automatically update the types
 */

// Re-export all types from the schema file
export type {
  // Main configuration types
  ChroniclerConfig,
  ChroniclerExecution,
  ChroniclerTrigger,
  // Condition types
  Condition,
  ContainsCondition,
  CountExecution,
  DebounceExecution,
  EqualsCondition,
  EventTrigger,
  // Execution strategy types
  ImmediateExecution,
  InCondition,
  MatchesCondition,
  NumericComparisonCondition,
  // Trigger types
  PatternStep,
  SequenceTrigger,
  TimeWindowExecution,
} from "../config-validation/chronicler.schema.js";

// Re-export the helper function
export { getValueByPath } from "../config-validation/chronicler.schema.js";
