// ============================================================================
// execution-thread.ts - Clean implementation with simplified algorithm
// ============================================================================

import {
  isTerminalPhaseStatus,
  type PhaseExecution,
  type PhaseId,
  type Run,
  type RunId,
  type SessionId,
  type TadpoleState,
} from "./types/state-types.js";
import type { PhaseConfig } from "./types/types.js";
import type { Logger } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Complete checkpoint information including git metadata
 */
export interface CheckpointInfo {
  type: "workspace-setup" | "completed" | "error" | "skipped";
  sha: string;
  message: string;
  timestamp: string; // ISO 8601 timestamp
  branch: string;
}

/**
 * A phase with its complete context
 */
export interface ThreadPhase {
  // The phase data
  phase: PhaseExecution;

  // Run context
  runId: RunId;
  runStatus: "running" | "completed" | "failed" | "crashed";
  runStartTime: string;
  runEndTime: string | null; // null for running runs, string for completed runs
  gitBranch: string;

  // Position in execution history
  globalIndex: number; // 0 = latest phase across all runs
  runIndex: number; // Which run this came from (0 = latest run)
  phaseIndexInRun: number; // Position within that run

  // All checkpoints for this phase with validation
  validatedCheckpoints: CheckpointInfo[];

  // Derived information
  continuationSessionId: SessionId | null; // Session ID this phase continued from, null if none
}

/**
 * Complete execution thread
 */
export interface ExecutionThread {
  phases: ThreadPhase[]; // Ordered latest first
  totalRuns: number; // How many runs we traversed
  hasRunningPhase: boolean; // Quick check if anything is running
  nextPhaseId: PhaseId | null; // What phase should execute next, null if none
}

// ============================================================================
// Main Analysis Function - Simplified Algorithm
// ============================================================================

/**
 * Analyze execution history to build a unified thread with all metadata.
 *
 * @param state - The complete Tadpole state
 * @param phaseConfigs - Phase configuration array
 * @param checkpointData - Map of SHA to git checkpoint data (optional)
 * @param targetRunId - Specific run to analyze (defaults to latest)
 * @param logger - Optional logger for debugging
 * @returns Complete execution thread with all metadata preserved
 */
export async function analyzeExecutionThread(
  state: TadpoleState,
  phaseConfigs: PhaseConfig[],
  checkpointData?: Map<string, { message: string; timestamp: string; branch: string }>,
  targetRunId?: RunId,
  logger?: Logger,
): Promise<ExecutionThread> {
  // Find starting run
  const startRun = targetRunId ? state.runs.find((r) => r.runId === targetRunId) : state.runs[0]; // Latest run is first

  if (!startRun) {
    logger?.log("No runs found for execution thread analysis", "debug");
    return {
      phases: [],
      totalRuns: 0,
      hasRunningPhase: false,
      nextPhaseId: null,
    };
  }

  // Initialize thread building
  const phases: ThreadPhase[] = [];
  const visited = new Set<RunId>();
  let currentRun: Run | null = startRun;
  let untilPhase = startRun.phases.length - 1; // Start by including all phases
  let runIndex = 0;
  let globalIndex = 0;
  let hasRunningPhase = false;

  // Process runs following the continuation chain
  while (currentRun && !visited.has(currentRun.runId)) {
    visited.add(currentRun.runId);

    logger?.log(
      `Processing run ${currentRun.runId} (status: ${currentRun.status}, ` +
        `phases: ${currentRun.phases.length}, including up to index ${untilPhase})`,
      "debug",
    );

    // Process phases in this run (backwards, from untilPhase to 0)
    for (let i = untilPhase; i >= 0; i--) {
      const phase = currentRun.phases[i];

      // Check if this is a running phase
      if (!isTerminalPhaseStatus(phase.status)) {
        hasRunningPhase = true;
      }

      // Build checkpoint information with git metadata
      const validatedCheckpoints = buildCheckpointInfo(phase, checkpointData);

      // Extract continuation session ID if present
      const continuationSessionId: SessionId | null =
        "previousSessionId" in phase && phase.previousSessionId ? phase.previousSessionId : null;

      // Build the thread phase entry with all metadata
      const threadPhase: ThreadPhase = {
        phase,
        runId: currentRun.runId,
        runStatus: currentRun.status,
        runStartTime: currentRun.startTime,
        runEndTime: currentRun.endTime || null,
        gitBranch: currentRun.gitBranch,
        globalIndex,
        runIndex,
        phaseIndexInRun: i,
        validatedCheckpoints,
        continuationSessionId,
      };

      phases.push(threadPhase);
      globalIndex++;
    }

    // Check if this run is a continuation and move to parent
    if (currentRun.startingConditions.type === "continuation") {
      const source = currentRun.startingConditions.source;
      const parentRunId: RunId = source.runId;
      const afterPhase = source.afterPhase;
      const checkpointSha = source.checkpointSha;

      // Find parent run
      const parentRun = state.runs.find((r: Run) => r.runId === parentRunId);
      if (!parentRun) {
        logger?.log(`Parent run ${parentRunId} not found, ending chain`, "info");
        break;
      }

      // Calculate untilPhase for the parent run
      if (!afterPhase) {
        // Continuation from beginning - exclude all phases from parent
        untilPhase = -1;
      } else {
        // Find the phase in parent run
        const afterPhaseIndex = parentRun.phases.findIndex(
          (p: PhaseExecution) => p.phaseId === afterPhase,
        );

        if (afterPhaseIndex === -1) {
          logger?.log(
            `Phase ${afterPhase} not found in parent run ${parentRunId}, including all phases`,
            "info",
          );
          untilPhase = parentRun.phases.length - 1;
        } else {
          const afterPhaseData = parentRun.phases[afterPhaseIndex];

          // Check if it's a workspace-setup continuation
          if (
            "workspaceSetupCheckpoint" in afterPhaseData &&
            afterPhaseData.workspaceSetupCheckpoint === checkpointSha
          ) {
            // Workspace setup continuation - exclude the phase that will be re-run
            untilPhase = afterPhaseIndex - 1;
            logger?.log(
              `Workspace setup continuation for ${afterPhase}, excluding it from parent`,
              "debug",
            );
          } else {
            // Normal continuation - include up to and including afterPhase
            untilPhase = afterPhaseIndex;
            logger?.log(
              `Normal continuation after ${afterPhase}, including phases up to index ${afterPhaseIndex}`,
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

  // Calculate next phase at the thread level
  let nextPhaseId: PhaseId | null = null;

  // Don't suggest next phase if the current run failed
  if (startRun.status === "failed") {
    nextPhaseId = null;
  } else if (!hasRunningPhase && phases.length > 0) {
    const latestPhase = phases[0];

    // Check if we're continuing from a workspace-setup checkpoint
    // This happens when the latest run is a continuation that will re-run a phase
    if (startRun.startingConditions.type === "continuation") {
      const { afterPhase, checkpointSha } = startRun.startingConditions.source;

      // Check if this continuation is from a workspace-setup checkpoint
      if (afterPhase && phases.length === 0) {
        // No phases executed yet in continuation run
        // Check if the continuation is from workspace-setup
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
          const sourcePhase = sourceRun.phases.find((p) => p.phaseId === afterPhase);
          if (
            sourcePhase &&
            "workspaceSetupCheckpoint" in sourcePhase &&
            sourcePhase.workspaceSetupCheckpoint === checkpointSha
          ) {
            // Workspace-setup continuation - next phase is the same phase
            nextPhaseId = afterPhase;
          }
        }
      }
    }

    // If not workspace-setup continuation, find next phase in config
    if (!nextPhaseId) {
      const phaseConfigIndex = phaseConfigs.findIndex((c) => c.id === latestPhase.phase.phaseId);
      if (phaseConfigIndex >= 0 && phaseConfigIndex < phaseConfigs.length - 1) {
        nextPhaseId = phaseConfigs[phaseConfigIndex + 1].id as PhaseId;
      }
    }
  } else if (!hasRunningPhase && phases.length === 0) {
    // No phases executed yet
    if (startRun.startingConditions.type === "continuation") {
      const { afterPhase, checkpointSha } = startRun.startingConditions.source;

      if (!afterPhase) {
        // Continuation from beginning
        nextPhaseId = phaseConfigs[0]?.id ? (phaseConfigs[0].id as PhaseId) : null;
      } else {
        // Check if it's a workspace-setup continuation
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
          const sourcePhase = sourceRun.phases.find((p) => p.phaseId === afterPhase);
          if (
            sourcePhase &&
            "workspaceSetupCheckpoint" in sourcePhase &&
            sourcePhase.workspaceSetupCheckpoint === checkpointSha
          ) {
            // Workspace-setup continuation - re-run the same phase
            nextPhaseId = afterPhase;
          } else {
            // Normal continuation - run next phase after afterPhase
            const phaseIndex = phaseConfigs.findIndex((c) => c.id === afterPhase);
            if (phaseIndex >= 0 && phaseIndex < phaseConfigs.length - 1) {
              nextPhaseId = phaseConfigs[phaseIndex + 1].id as PhaseId;
            }
          }
        }
      }
    } else {
      // Fresh run - start with first phase
      nextPhaseId = phaseConfigs[0]?.id ? (phaseConfigs[0].id as PhaseId) : null;
    }
  }

  logger?.log(
    `Built execution thread: ${phases.length} phases across ${
      runIndex + 1
    } runs, next phase: ${nextPhaseId || "none"}`,
    "debug",
  );

  return {
    phases,
    totalRuns: runIndex + 1,
    hasRunningPhase,
    nextPhaseId,
  };
}

/**
 * Build checkpoint information for a phase with git metadata
 * Only includes checkpoints that exist in git
 */
function buildCheckpointInfo(
  phase: PhaseExecution,
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
  if ("workspaceSetupCheckpoint" in phase && phase.workspaceSetupCheckpoint) {
    addCheckpoint("workspace-setup", phase.workspaceSetupCheckpoint);
  }

  if (phase.status === "completed" && phase.completionCheckpoint) {
    addCheckpoint("completed", phase.completionCheckpoint);
  }

  if (phase.status === "failed" && "errorCheckpoint" in phase && phase.errorCheckpoint) {
    addCheckpoint("error", phase.errorCheckpoint);
  }

  if (phase.status === "skipped" && "skipCheckpoint" in phase && phase.skipCheckpoint) {
    addCheckpoint("skipped", phase.skipCheckpoint);
  }

  return checkpoints;
}

// ============================================================================
// Simple Query Functions
// ============================================================================

/**
 * Get the next phase to execute from a thread
 */
export function getNextPhaseId(thread: ExecutionThread): PhaseId | null {
  // Simply return what was already calculated at the thread level
  return thread.nextPhaseId || null;
}

/**
 * Find session ID for continuing a specific phase
 */
export function findContinuationSessionId(
  thread: ExecutionThread,
  phaseId: PhaseId,
  phaseConfigs: PhaseConfig[],
): SessionId | null {
  const phaseConfig = phaseConfigs.find((c) => c.id === phaseId);

  // Only continue-previous phases need a session
  if (!phaseConfig || phaseConfig.continuationMode !== "continue-previous") {
    return null;
  }

  // Find the phase before this one in the config
  const configIndex = phaseConfigs.findIndex((c) => c.id === phaseId);
  if (configIndex <= 0) return null;

  const previousPhaseId = phaseConfigs[configIndex - 1].id as PhaseId;

  // Find the most recent execution of the previous phase
  for (const threadPhase of thread.phases) {
    if (threadPhase.phase.phaseId !== previousPhaseId) continue;

    const phase = threadPhase.phase;

    // Must have a session ID
    if (!("claudeSessionId" in phase) || !phase.claudeSessionId) continue;

    // Check if it's valid for continuation
    if (phase.status === "completed") {
      return phase.claudeSessionId;
    }

    if (
      phase.status === "skipped" &&
      "assistantMessageCount" in phase &&
      phase.assistantMessageCount &&
      phase.assistantMessageCount > 0
    ) {
      return phase.claudeSessionId;
    }
  }

  return null;
}
