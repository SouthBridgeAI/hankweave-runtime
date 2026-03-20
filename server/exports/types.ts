/**
 * Public type exports for external consumers (e.g., hw-tracing).
 *
 * Exports TypeScript types for:
 * - State management (state.json)
 * - Codon execution states
 * - Hank configuration
 * - Execution planning
 * - Branded types
 */

// Execution planner types — for reading executionPlan in state.json
export type { ExecutionCodonEntry } from "../execution-planner.js";

// Branded types for type safety
export { CodonId, EventId, RunId, SessionId } from "../types/branded-types.js";
// State types — for reading state.json
export type {
  CodonExecution,
  CodonStatus,
  CompletedCodon,
  CompletingSentinelsCodon,
  FailedCodon,
  FailureReason,
  HankweaveState,
  InitializingCodon,
  PreparingCodon,
  Run,
  RunningCodon,
  SentinelState,
  SkippedCodon,
  StartingCodon,
  StartingConditions,
  TokenUsage,
} from "../types/state-types.js";
// Utility re-exports used in state shape
export {
  getCodonCost,
  getCodonTokens,
  isTerminalCodonStatus,
} from "../types/state-types.js";
// Config types — for reading hank.json
export type {
  Codon,
  CodonConfig,
  HankFile,
  HankMeta,
  HankweaveConfig,
  Loop,
  RigSetupItem,
  RigShellCommand,
} from "../types/types.js";
