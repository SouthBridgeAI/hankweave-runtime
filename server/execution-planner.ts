// ============================================================================
// Execution Planner - Pure planning logic for codon and loop execution
// ============================================================================

import { CodonId, CodonId as CodonIdConstructor } from "./types/branded-types.js";
import type { AllocationMode } from "./types/budget-types.js";
import type { Codon, CodonConfig, Loop } from "./types/types.js";

/**
 * Represents a flattened codon in the execution plan.
 * Each entry is a concrete codon that will be executed.
 */
export interface ExecutionCodonEntry {
  // The actual codon config to execute (always Codon, never Loop)
  codon: Codon;

  // Runtime-generated ID (e.g., "review#0", "review#1" for loop iterations)
  codonId: CodonId;

  // If from a loop, track context for resume/rollback
  loopContext?: {
    loopId: CodonId; // ID of the loop this codon belongs to
    iteration: number; // Which iteration (0-indexed: 0 = first, 1 = second, etc.)
    codonIndexInLoop: number; // Position within loop.codons array
    // Loop's own budget config (if declared), carried for Budget class to use
    loopBudget?: {
      maxDollars?: number;
      maxTimeSeconds?: number;
      allocation?: AllocationMode;
      shares?: Record<string, number>;
      onExceeded?: "complete" | "fail";
    };
  };
}

/**
 * Handles all execution planning logic.
 * Pure functions - no side effects, just config → plan transformations.
 */
export class ExecutionPlanner {
  constructor(private codonConfigs: CodonConfig[]) {}

  /**
   * Build initial execution plan for fresh start.
   * Expands only the first iteration of each loop.
   */
  buildInitialPlan(): ExecutionCodonEntry[] {
    const plan: ExecutionCodonEntry[] = [];

    for (let i = 0; i < this.codonConfigs.length; i++) {
      const config = this.codonConfigs[i];

      if (config.type === "loop") {
        // Lazy expansion - only first iteration
        plan.push(...this.createIterationPlan(config, 0));
      } else {
        // Regular codon - no loop context
        plan.push({
          codon: config,
          codonId: CodonId(config.id),
        });
      }
    }

    return plan;
  }

  /**
   * Expand next iteration after codon completion.
   * Returns new plan with next iteration injected (if termination not met).
   * Pure function - doesn't mutate input plan.
   */
  expandNextIteration(params: {
    currentPlan: ExecutionCodonEntry[];
    completedCodonId: CodonId;
    contextExceeded?: boolean;
    budgetExceeded?: boolean;
  }): ExecutionCodonEntry[] {
    const {
      currentPlan,
      completedCodonId,
      contextExceeded = false,
      budgetExceeded = false,
    } = params;

    // Find the completed codon in the plan
    const completedIndex = currentPlan.findIndex((e) => e.codonId === completedCodonId);
    if (completedIndex < 0) {
      throw new Error(`Codon not found in plan: ${completedCodonId}`);
    }

    const entry = currentPlan[completedIndex];
    const loopContext = entry.loopContext;
    const loopId = loopContext?.loopId;
    const loopConfig = this.codonConfigs.find((c) => c.type === "loop" && c.id === loopId) as
      | Loop
      | undefined;

    if (!loopConfig || !loopContext) {
      throw new Error(`Not in a loop: ${entry.codonId}`);
    }

    const { iteration, codonIndexInLoop } = loopContext;

    // ============================================================
    // Termination Logic - Check in priority order
    // ============================================================

    // PRIORITY 1: Early termination — context exceeded or budget exceeded (can happen at any codon)
    const shouldTerminateEarly =
      (contextExceeded && loopConfig.terminateOn.type === "contextExceeded") || budgetExceeded;

    if (shouldTerminateEarly) {
      // Terminate this loop immediately: remove remaining codons in this iteration
      const endOfIterationIndex = currentPlan.findIndex((e, idx) => {
        if (idx <= completedIndex) return false;
        if (!e.loopContext) return true; // Found a non-loop codon
        if (e.loopContext.loopId !== loopId) return true; // Different loop
        if (e.loopContext.iteration !== iteration) return true; // Different iteration
        return false;
      });

      if (endOfIterationIndex === -1) {
        return currentPlan.slice(0, completedIndex + 1);
      }
      return [
        ...currentPlan.slice(0, completedIndex + 1),
        ...currentPlan.slice(endOfIterationIndex),
      ];
    }

    // Only check other termination conditions at the last codon of an iteration
    const isLastCodonInIteration = codonIndexInLoop === loopConfig.codons.length - 1;

    if (!isLastCodonInIteration) {
      return currentPlan; // Not time to decide on next iteration yet
    }

    // PRIORITY 2: Iteration limit termination
    if (loopConfig.terminateOn.type === "iterationLimit") {
      const { limit } = loopConfig.terminateOn;

      // iteration is 0-indexed: 0 = first, 1 = second, 2 = third, etc.
      // If limit is 3, we should stop after iteration 2 (the 3rd iteration)
      if (iteration >= limit - 1) {
        // Reached iteration limit - don't expand
        return currentPlan;
      }
    }

    // PRIORITY 3: Context exceeded loops continue until context is actually exceeded
    if (loopConfig.terminateOn.type === "contextExceeded") {
      // Context not exceeded yet - keep going
      // (This will continue indefinitely until contextExceeded=true is passed)
    }

    // ============================================================
    // Create next iteration
    // ============================================================
    const nextIteration = this.createIterationPlan(loopConfig, iteration + 1);

    return [
      ...currentPlan.slice(0, completedIndex + 1),
      ...nextIteration,
      ...currentPlan.slice(completedIndex + 1),
    ];
  }

  /**
   * Validate the execution plan for consistency.
   * Catches configuration errors before execution.
   */
  validatePlan(plan: ExecutionCodonEntry[]): void {
    // Check for duplicate codon IDs
    const ids = plan.map((e) => e.codonId);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (duplicates.length > 0) {
      throw new Error(`Duplicate codon IDs after loop expansion: ${duplicates.join(", ")}`);
    }

    // Validate loop contexts
    for (const entry of plan) {
      if (entry.loopContext) {
        const { loopId, codonIndexInLoop } = entry.loopContext;
        const config = this.codonConfigs.find((c) => c.type === "loop" && c.id === loopId) as
          | Loop
          | undefined;

        if (!config) {
          throw new Error(`Loop not found for codon ${entry.codonId}: ${loopId}`);
        }

        if (codonIndexInLoop >= config.codons.length) {
          throw new Error(`Codon index ${codonIndexInLoop} out of bounds for loop ${config.id}`);
        }
      }
    }
  }

  // ============================================================================
  // Private helper methods
  // ============================================================================

  /**
   * Create execution plan for a specific iteration of a loop.
   */
  private createIterationPlan(config: Loop, iteration: number): ExecutionCodonEntry[] {
    const loopBudget = config.budget
      ? {
          maxDollars: config.budget.maxDollars,
          maxTimeSeconds: config.budget.maxTimeSeconds,
          allocation: config.budget.allocation as AllocationMode | undefined,
          shares: config.budget.shares,
          onExceeded: config.budget.onExceeded as "complete" | "fail" | undefined,
        }
      : undefined;

    return config.codons.map((codon, codonIndexInLoop) => ({
      codon,
      codonId: this.generateIterationCodonId(CodonId(codon.id), iteration),
      loopContext: {
        loopId: CodonId(config.id),
        iteration,
        codonIndexInLoop,
        ...(loopBudget ? { loopBudget } : {}),
      },
    }));
  }

  /**
   * Generate a unique codon ID for a loop iteration.
   * Format: "originalId#iteration" where iteration is 0-indexed
   * Examples: "review#0", "review#1", "review#2"
   */
  private generateIterationCodonId(originalId: CodonId, iteration: number): CodonId {
    return CodonIdConstructor(`${originalId}#${iteration}`);
  }
}
