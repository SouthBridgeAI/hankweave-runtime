/**
 * Sentinel Types
 *
 * This file re-exports types from the Zod schemas to maintain a single source of truth.
 * The schemas in server/config-validation/sentinel.schema.ts are the canonical definitions.
 *
 * All types are derived from the Zod schemas using z.infer<>, ensuring that:
 * 1. TypeScript types and runtime validation are always in sync
 * 2. We avoid dual source of truth issues
 * 3. Changes to validation logic automatically update the types
 */

import type { ServerEvent } from "../schemas/event-schemas.js";

// Re-export all types from the schema file
export type {
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
  // Main configuration types
  SentinelConfig,
  SentinelExecution,
  SentinelTrigger,
  SequenceTrigger,
  TimeWindowExecution,
} from "../config-validation/sentinel.schema.js";
// Re-export the helper function
export { getValueByPath } from "../config-validation/sentinel.schema.js";
// Re-export structured output context from llm-call-types
export type { StructuredOutputContext } from "../types/llm-call-types.js";

// -------------
// Output Path Types
// -------------

/**
 * Output paths configuration passed from codon to sentinel.
 * This will eventually live in codon configuration, but for now
 * we pass it as a parameter to SentinelManager for testing.
 */
export interface SentinelOutputPaths {
  /**
   * Path to append-only log file. Path convention:
   * - Filename only (e.g., "output.md") → .hankweave/sentinel-outputs/{id}/
   * - Path with slash (e.g., "data/output.md") → execution-dir relative
   * Auto-generated if omitted: .hankweave/sentinel-outputs/{id}/{id}-{codon}-{timestamp}.md
   */
  logFile?: string;

  /**
   * Path to last-value-only file. Same path convention as logFile.
   * Truly optional - no auto-generation.
   */
  lastValueFile?: string;
}

// -------------
// Trigger Queue Types
// -------------

/**
 * Execution strategy type extracted from SentinelExecution
 */
export type ExecutionStrategy = "immediate" | "debounce" | "count" | "timeWindow";

/**
 * Represents a queued trigger waiting for execution.
 *
 * When a trigger matches, it's queued with its events and metadata.
 * The queue ensures serial execution within each sentinel while
 * maintaining semantic correctness through the queuedAt timestamp.
 */
export interface QueuedTrigger {
  /** Unique identifier for this trigger execution */
  id: string;

  /** Events that caused this trigger to fire */
  events: ServerEvent[];

  /** Execution strategy that created this trigger */
  strategy: ExecutionStrategy;

  /**
   * When this trigger was queued (NOT when it executes).
   * This timestamp is used in template rendering to ensure semantic correctness.
   *
   * Examples:
   * - immediate: When the triggering event arrived
   * - debounce: When the quiet period ended
   * - count: When the threshold was reached
   * - timeWindow: When the window closed
   */
  queuedAt: Date;

  /** Optional priority for future queue sorting (not currently used) */
  priority?: number;
}
