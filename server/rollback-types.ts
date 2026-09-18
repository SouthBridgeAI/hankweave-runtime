import type { CodonId, RunId } from "./types/branded-types.js";
import type { StartingConditions } from "./types/state-types.js";
import { toError } from "./utils.js";
import type { ArchiveRestoreOutcome } from "./workspace/archive.js";
import type { RecoverySnapshot } from "./workspace/checkpoints.js";

export type RollbackCheckpointType = "rig-setup" | "completed" | "error" | "skipped";
export type RollbackTarget =
  | { type: "checkpoint"; id: string }
  | { type: "codon"; codonId: CodonId; checkpointType: RollbackCheckpointType | "start" | "end" }
  | { type: "last-success" };

interface RollbackCheckpoint {
  codonId: CodonId;
  codonName: string;
  checkpoint: string;
  checkpointType: RollbackCheckpointType;
}

/** Recovery facts; the runtime supplies event envelopes and presentation. */
export type RollbackProgress =
  | { type: "snapshot"; snapshot: RecoverySnapshot; reason: string }
  | { type: "diagnostic"; message: string }
  | {
      type: "started";
      fromRun: RunId;
      fromCodon: CodonId;
      toCodon: CodonId;
      toCheckpoint: string;
      checkpointType: RollbackCheckpointType;
      codonsToProcess: CodonId[];
    }
  | { type: "step"; currentStep: number; totalSteps: number; codonId?: CodonId }
  | ({ type: "checkpoint"; final: boolean } & RollbackCheckpoint)
  | {
      type: "rig-cleanup";
      codonId: CodonId;
      codonName: string;
      directories: string[];
      status: "started" | "completed" | "partial" | "failed";
      successfulCleanups?: string[];
      failedCleanups?: { directory: string; error: string }[];
    }
  | { type: "archives"; checkpoint: string; outcomes: ArchiveRestoreOutcome[] };

export interface RollbackOptions {
  shouldAbort?: () => boolean;
  onProgress?: (progress: RollbackProgress) => void;
}

export interface RollbackResult extends RollbackCheckpoint {
  fromRun: RunId;
  continuation: StartingConditions;
}

/** An invalid request rejected before any files were changed. */
export class RollbackRejectedError extends Error {}

/** Recovery may have changed files; callers must not start another run. */
export class RollbackMutatedWorkspaceError extends Error {
  constructor(cause: unknown) {
    super(`Rollback failed after the work tree was changed: ${toError(cause).message}`, { cause });
    this.name = "RollbackMutatedWorkspaceError";
  }
}
