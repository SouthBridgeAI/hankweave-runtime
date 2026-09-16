// -------------
// execution-thread.ts - Clean implementation with simplified algorithm
// -------------

import {
  type CodonExecution,
  type CodonId,
  type HankweaveState,
  isTerminalCodonStatus,
  type Run,
  type RunId,
  type SessionId,
} from "./types/state-types.js";
import type { Logger } from "./utils.js";

// -------------
// Types
// -------------

/**
 * Complete checkpoint information including git metadata
 */
export interface CheckpointInfo {
  type: "rig-setup" | "completed" | "error" | "skipped";
  sha: string;
  message: string;
  timestamp: string; // ISO 8601 timestamp
  branch: string;
}

/**
 * A codon with its complete context
 */
export interface ThreadCodon {
  // The codon data
  codon: CodonExecution;

  // Run context
  runId: RunId;
  runStatus: "running" | "completed" | "failed" | "crashed";
  runStartTime: string;
  runEndTime: string | null; // null for running runs, string for completed runs
  gitBranch: string;

  // Position in execution history
  globalIndex: number; // 0 = latest codon across all runs
  runIndex: number; // Which run this came from (0 = latest run)
  codonIndexInRun: number; // Position within that run

  // All checkpoints for this codon with validation
  validatedCheckpoints: CheckpointInfo[];

  // Derived information
  continuationSessionId: SessionId | null; // Session ID this codon continued from, null if none
}

/**
 * Complete execution thread
 */
export class ExecutionThread {
  constructor(
    public codons: ThreadCodon[] = [],
    public totalRuns: number = 0,
    public hasRunningCodon: boolean = false,
    public nextCodonId: CodonId | null = null,
  ) {}

  /**
   * Check if the execution thread is in a failed state.
   *
   * The thread is considered failed only if:
   * 1. The most recent codon explicitly has status "failed"
   * 2. OR the run crashed/failed while a codon was still running (non-terminal state)
   *
   * Historical runs being marked as "failed" (e.g., due to server shutdown after
   * successful codon completion) should NOT cause the thread to be considered failed.
   */
  get failed(): boolean {
    // If there are no codons, the thread is not failed
    if (this.codons.length === 0) {
      return false;
    }

    // Check only the most recent codon (index 0, since thread is in reverse order)
    const mostRecent = this.codons[0];

    // Thread is failed if the most recent codon explicitly failed
    if (mostRecent.codon.status === "failed") {
      return true;
    }

    // Thread is failed if the run crashed/failed while a codon was still running
    // (codon wasn't terminal when run ended)
    if (
      (mostRecent.runStatus === "failed" || mostRecent.runStatus === "crashed") &&
      !isTerminalCodonStatus(mostRecent.codon.status)
    ) {
      return true;
    }

    return false;
  }
}

// -------------
// Main Analysis Function - Simplified Algorithm
// -------------

/**
 * Analyze execution history to build a unified thread with all metadata.
 *
 * @param state - The complete Hankweave state (including executionPlan)
 * @param checkpointData - Map of SHA to git checkpoint data (optional)
 * @param targetRunId - Specific run to analyze (defaults to latest)
 * @param logger - Optional logger for debugging
 * @returns Complete execution thread with all metadata preserved
 */
export async function analyzeExecutionThread(
  state: HankweaveState,
  checkpointData?: Map<string, { message: string; timestamp: string; branch: string }>,
  targetRunId?: RunId,
  logger?: Logger,
): Promise<ExecutionThread> {
  // Get execution plan from state
  const executionPlan = state.executionPlan;
  // Find starting run
  const startRun = targetRunId ? state.runs.find((r) => r.runId === targetRunId) : state.runs[0]; // Latest run is first

  if (!startRun) {
    logger?.log("No runs found for execution thread analysis", "debug");
    return new ExecutionThread([], 0, false, null);
  }

  // Initialize thread building
  const codons: ThreadCodon[] = [];
  const visited = new Set<RunId>();
  let currentRun: Run | null = startRun;
  let untilCodon = startRun.codons.length - 1; // Start by including all codons
  let runIndex = 0;
  let globalIndex = 0;
  let hasRunningCodon = false;

  // Process runs following the continuation chain
  while (currentRun && !visited.has(currentRun.runId)) {
    visited.add(currentRun.runId);

    logger?.log(
      `Processing run ${currentRun.runId} (status: ${currentRun.status}, ` +
        `codons: ${currentRun.codons.length}, including up to index ${untilCodon})`,
      "debug",
    );

    // Process codons in this run (backwards, from untilCodon to 0)
    for (let i = untilCodon; i >= 0; i--) {
      const codon = currentRun.codons[i];

      // Check if this is a running codon
      if (!isTerminalCodonStatus(codon.status)) {
        hasRunningCodon = true;
      }

      // Build checkpoint information with git metadata
      const validatedCheckpoints = buildCheckpointInfo(codon, checkpointData);

      // Extract continuation session ID if present
      const continuationSessionId: SessionId | null =
        "previousSessionId" in codon && codon.previousSessionId ? codon.previousSessionId : null;

      // Build the thread codon entry with all metadata
      const threadCodon: ThreadCodon = {
        codon,
        runId: currentRun.runId,
        runStatus: currentRun.status,
        runStartTime: currentRun.startTime,
        runEndTime: currentRun.endTime || null,
        gitBranch: currentRun.gitBranch,
        globalIndex,
        runIndex,
        codonIndexInRun: i,
        validatedCheckpoints,
        continuationSessionId,
      };

      codons.push(threadCodon);
      globalIndex++;
    }

    // Check if this run is a continuation and move to parent
    if (currentRun.startingConditions.type === "continuation") {
      const source = currentRun.startingConditions.source;
      const parentRunId: RunId = source.runId;
      const afterCodon = source.afterCodon;
      const checkpointSha = source.checkpointSha;

      // Find parent run
      const parentRun = state.runs.find((r: Run) => r.runId === parentRunId);
      if (!parentRun) {
        logger?.log(`Parent run ${parentRunId} not found, ending chain`, "info");
        break;
      }

      // Calculate untilCodon for the parent run
      if (!afterCodon) {
        // Continuation from beginning - exclude all codons from parent
        untilCodon = -1;
      } else {
        // Find the codon in parent run
        const afterCodonIndex = parentRun.codons.findIndex(
          (p: CodonExecution) => p.codonId === afterCodon,
        );

        if (afterCodonIndex === -1) {
          logger?.log(
            `Codon ${afterCodon} not found in parent run ${parentRunId}, including all codons`,
            "info",
          );
          untilCodon = parentRun.codons.length - 1;
        } else {
          const afterCodonData = parentRun.codons[afterCodonIndex];

          // Check if it's a rig-setup continuation
          if (
            "rigSetupCheckpoint" in afterCodonData &&
            afterCodonData.rigSetupCheckpoint === checkpointSha
          ) {
            // Rig setup continuation - exclude the codon that will be re-run
            untilCodon = afterCodonIndex - 1;
            logger?.log(
              `Rig setup continuation for ${afterCodon}, excluding it from parent`,
              "debug",
            );
          } else {
            // Normal continuation - include up to and including afterCodon
            untilCodon = afterCodonIndex;
            logger?.log(
              `Normal continuation after ${afterCodon}, including codons up to index ${afterCodonIndex}`,
              "debug",
            );
          }
        }
      }

      // Move to parent run
      currentRun = parentRun;
      runIndex++;
    } else {
      // Fresh start - we're done
      break;
    }
  }

  // Calculate next codon at the thread level
  let nextCodonId: CodonId | null = null;

  // Don't suggest next codon if the current run failed
  if (startRun.status === "failed") {
    // TODO
    nextCodonId = null;
  } else if (!hasRunningCodon && codons.length > 0) {
    const latestCodon = codons[0];

    // Check if we're continuing from a rig-setup checkpoint
    // This happens when the latest run is a continuation that will re-run a codon
    if (startRun.startingConditions.type === "continuation") {
      const { afterCodon, checkpointSha } = startRun.startingConditions.source;

      // Check if this continuation is from a rig-setup checkpoint
      if (afterCodon && codons.length === 0) {
        // TODO
        // No codons executed yet in continuation run
        // Check if the continuation is from rig-setup
        const sourceRun = state.runs.find(
          (r) =>
            r.runId ===
            (
              startRun.startingConditions as {
                type: "continuation";
                source: { runId: RunId };
              }
            ).source.runId,
        );
        if (sourceRun) {
          const sourceCodon = sourceRun.codons.find((p) => p.codonId === afterCodon);
          if (
            sourceCodon &&
            "rigSetupCheckpoint" in sourceCodon &&
            sourceCodon.rigSetupCheckpoint === checkpointSha
          ) {
            // Rig-setup continuation - next codon is the same codon
            nextCodonId = afterCodon;
          }
        }
      }
    }

    // If not rig-setup continuation, find next codon in execution plan
    if (!nextCodonId) {
      const codonIndex = executionPlan.findIndex((e) => e.codonId === latestCodon.codon.codonId);
      if (codonIndex >= 0 && codonIndex < executionPlan.length - 1) {
        nextCodonId = executionPlan[codonIndex + 1].codonId;
      }
    }
  } else if (!hasRunningCodon && codons.length === 0) {
    // No codons executed yet
    if (startRun.startingConditions.type === "continuation") {
      const { afterCodon, checkpointSha } = startRun.startingConditions.source;

      if (!afterCodon) {
        // Continuation from beginning
        nextCodonId = executionPlan[0]?.codonId ?? null;
      } else {
        // Check if it's a rig-setup continuation
        const sourceRun = state.runs.find(
          (r) =>
            r.runId ===
            (
              startRun.startingConditions as {
                type: "continuation";
                source: { runId: RunId };
              }
            ).source.runId,
        );
        if (sourceRun) {
          const sourceCodon = sourceRun.codons.find((p) => p.codonId === afterCodon);
          if (
            sourceCodon &&
            "rigSetupCheckpoint" in sourceCodon &&
            sourceCodon.rigSetupCheckpoint === checkpointSha
          ) {
            // Rig-setup continuation - re-run the same codon
            nextCodonId = afterCodon;
          } else {
            // Normal continuation - run next codon after afterCodon
            const codonIndex = executionPlan.findIndex((e) => e.codonId === afterCodon);
            if (codonIndex >= 0 && codonIndex < executionPlan.length - 1) {
              nextCodonId = executionPlan[codonIndex + 1].codonId;
            }
          }
        }
      }
    } else {
      // Fresh run - start with first codon
      nextCodonId = executionPlan[0]?.codonId ?? null;
    }
  }

  logger?.log(
    `Built execution thread: ${codons.length} codons across ${
      runIndex + 1
    } runs, next codon: ${nextCodonId || "none"}`,
    "debug",
  );

  return new ExecutionThread(codons, runIndex + 1, hasRunningCodon, nextCodonId);
}

/**
 * Build checkpoint information for a codon with git metadata
 * Only includes checkpoints that exist in git
 */
function buildCheckpointInfo(
  codon: CodonExecution,
  checkpointData?: Map<string, { message: string; timestamp: string; branch: string }>,
): CheckpointInfo[] {
  const checkpoints: CheckpointInfo[] = [];

  // Helper to add checkpoint only if it exists in git
  const addCheckpoint = (type: CheckpointInfo["type"], sha: string) => {
    // Only add if we have git data for this SHA
    const gitData = checkpointData?.get(sha);
    if (gitData) {
      checkpoints.push({
        type,
        sha,
        message: gitData.message,
        timestamp: gitData.timestamp,
        branch: gitData.branch,
      });
    }
  };

  // Check all checkpoint types
  if ("rigSetupCheckpoint" in codon && codon.rigSetupCheckpoint) {
    addCheckpoint("rig-setup", codon.rigSetupCheckpoint);
  }

  // Truthiness is enough here: addCheckpoint keeps only SHAs present in the
  // git data map, which is the real validation.
  if (codon.status === "completed" && codon.completionCheckpoint) {
    addCheckpoint("completed", codon.completionCheckpoint);
  }

  if (codon.status === "failed" && "errorCheckpoint" in codon && codon.errorCheckpoint) {
    addCheckpoint("error", codon.errorCheckpoint);
  }

  if (codon.status === "skipped" && "skipCheckpoint" in codon && codon.skipCheckpoint) {
    addCheckpoint("skipped", codon.skipCheckpoint);
  }

  return checkpoints;
}

// -------------
// Simple Query Functions
// -------------

/**
 * Which of a codon's confirmed checkpoints recovery prefers, best first.
 * The completion is the codon's finished state; error and skipped record where
 * it stopped; rig-setup is the folder before the codon ran at all.
 */
const CHECKPOINT_PRIORITY: ReadonlyArray<CheckpointInfo["type"]> = [
  "completed",
  "error",
  "skipped",
  "rig-setup",
];

/**
 * The completion checkpoint a continuation may seed from, or null when the
 * codon is not completed or git does not hold its completion checkpoint.
 * Reads only validatedCheckpoints: the raw reference on the codon is history,
 * never a target.
 */
export function confirmedCompletion(tc: ThreadCodon): string | null {
  if (tc.codon.status !== "completed") return null;
  return tc.validatedCheckpoints.find((cp) => cp.type === "completed")?.sha ?? null;
}

/** The best checkpoint git confirms for this codon, by CHECKPOINT_PRIORITY, or null. */
export function bestConfirmedCheckpoint(tc: ThreadCodon): CheckpointInfo | null {
  for (const type of CHECKPOINT_PRIORITY) {
    const cp = tc.validatedCheckpoints.find((c) => c.type === type);
    if (cp) return cp;
  }
  return null;
}

/**
 * What rung 1 rolls back TO for a codon. A failed codon is retried from its
 * rig-setup checkpoint (recorded as afterCodon: null, so it runs again with
 * the rig skipped); its error checkpoint only records where it stopped, and
 * continuing from it skips the codon.
 */
function rungOneTarget(tc: ThreadCodon): CheckpointInfo | null {
  if (tc.codon.status === "failed") {
    const rig = tc.validatedCheckpoints.find((c) => c.type === "rig-setup");
    if (rig) return rig;
  }
  return bestConfirmedCheckpoint(tc);
}

export interface RollbackTarget {
  /** Position in thread.codons (0 = newest). */
  index: number;
  /** Confirmed by git — never the raw state-file value. */
  sha: string;
  type: CheckpointInfo["type"];
}

/**
 * Where recovery should roll back to, or null when git confirms nothing.
 * Rung 0: the newest completed codon's completion checkpoint. Rung 1: the
 * newest codon with any confirmed checkpoint, best type first, except that a
 * failed codon is retried from its rig-setup checkpoint when git holds one.
 * Rung 2 (nothing restorable) is the caller's: snapshot the work tree,
 * degrade, start over.
 */
export function findRollbackTarget(thread: ExecutionThread): RollbackTarget | null {
  const newestCompleted = thread.codons.findIndex((tc) => tc.codon.status === "completed");
  if (newestCompleted >= 0) {
    const sha = confirmedCompletion(thread.codons[newestCompleted]);
    if (sha) return { index: newestCompleted, sha, type: "completed" };
  }
  for (const [index, tc] of thread.codons.entries()) {
    const cp = rungOneTarget(tc);
    if (cp) return { index, sha: cp.sha, type: cp.type };
  }
  return null;
}

/** Everything recovery needs to act on a rollback, decided in one place. */
export interface RollbackDecision {
  /** The thread the decision was made on; executeRollback walks it. */
  thread: ExecutionThread;
  /** Where to go, or null when git confirms nothing (caller snapshots and degrades). */
  target: RollbackTarget | null;
  /**
   * The newest completed codon when the target is not its completion: git
   * does not hold that checkpoint. Null when there is no such codon. Callers
   * log it — it is the footprint of a torn checkpoint repository.
   */
  passedOverCompletion: ThreadCodon | null;
}

export function decideRollback(thread: ExecutionThread): RollbackDecision {
  const target = findRollbackTarget(thread);
  const newestCompleted = thread.codons.find((tc) => tc.codon.status === "completed") ?? null;
  const passedOverCompletion = target?.type === "completed" ? null : newestCompleted;
  return { thread, target, passedOverCompletion };
}

/** The completed codon a continuation may seed from. */
export interface ContinuationSeed {
  codonId: CodonId;
  runId: RunId;
  /** The completion reference from state; `confirmed` says whether git holds it. */
  sha: string;
  confirmed: boolean;
}

/** Newest completed codon in the thread, or null when the thread holds none. */
export function seedFromThread(thread: ExecutionThread): ContinuationSeed | null {
  const tc = thread.codons.find((c) => c.codon.status === "completed");
  if (!tc || tc.codon.status !== "completed") return null;
  const confirmedSha = confirmedCompletion(tc);
  return {
    codonId: tc.codon.codonId,
    runId: tc.runId,
    sha: confirmedSha ?? tc.codon.completionCheckpoint,
    confirmed: confirmedSha !== null,
  };
}

/**
 * Newest completed codon anywhere in state, for the case where the thread is
 * empty because the latest run is an empty fresh run. Confirmation comes from
 * the same checkpoint map the thread was validated against, so both seed
 * sources apply one rule. Runs are scanned in state order (newest first) and
 * each run's codons from the end.
 */
export function seedFromState(
  state: HankweaveState,
  checkpointData: ReadonlyMap<string, unknown> | undefined,
): ContinuationSeed | null {
  for (const run of state.runs) {
    for (let i = run.codons.length - 1; i >= 0; i--) {
      const codon = run.codons[i];
      if (codon.status !== "completed") continue;
      return {
        codonId: codon.codonId,
        runId: run.runId,
        sha: codon.completionCheckpoint,
        confirmed: checkpointData?.has(codon.completionCheckpoint) ?? false,
      };
    }
  }
  return null;
}

/**
 * Get the next codon to execute from a thread
 */
export function getNextCodonId(thread: ExecutionThread): CodonId | null {
  // Simply return what was already calculated at the thread level
  return thread.nextCodonId || null;
}

/**
 * Find session ID for continuing a specific codon
 */
export function findContinuationSessionId(
  thread: ExecutionThread,
  codonId: CodonId,
  state: HankweaveState,
): SessionId | null {
  const executionPlan = state.executionPlan || [];
  const entry = executionPlan.find((e) => e.codonId === codonId);

  // Only continue-previous codons need a session
  if (!entry || entry.codon.continuationMode !== "continue-previous") {
    return null;
  }

  // Find the codon before this one in the execution plan
  const entryIndex = executionPlan.findIndex((e) => e.codonId === codonId);
  if (entryIndex <= 0) return null;

  const previousCodonId = executionPlan[entryIndex - 1].codonId;

  // Find the most recent execution of the previous codon
  for (const threadCodon of thread.codons) {
    if (threadCodon.codon.codonId !== previousCodonId) continue;

    const codon = threadCodon.codon;

    // Must have a session ID
    if (!("claudeSessionId" in codon) || !codon.claudeSessionId) continue;

    // Check if it's valid for continuation
    if (codon.status === "completed") {
      return codon.claudeSessionId;
    }

    if (
      codon.status === "skipped" &&
      "assistantMessageCount" in codon &&
      codon.assistantMessageCount &&
      codon.assistantMessageCount > 0
    ) {
      return codon.claudeSessionId;
    }
  }

  return null;
}
