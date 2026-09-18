import { CheckpointId, type RecoverySnapshot } from "./checkpoints.js";
import type { WorkspaceStorage } from "./storage.js";

export interface RecoveryRequest {
  readonly baseline: CheckpointId;
  readonly reason: string;
  readonly patterns: readonly string[];
}

/** Captured ownership can be reused throughout one rollback. No branch is selected. */
export interface PreparedRecovery {
  readonly target: CheckpointId;
  readonly snapshot: RecoverySnapshot;
  restore(): Promise<void>;
  restoreIntermediate(id: CheckpointId): Promise<void>;
}

export interface WorkspaceRecovery {
  preserve(request: RecoveryRequest): Promise<RecoverySnapshot>;
  prepare(request: RecoveryRequest & { readonly target: string }): Promise<PreparedRecovery>;
}

export class RecoveryService implements WorkspaceRecovery {
  constructor(private readonly storage: WorkspaceStorage) {}

  async preserve(request: RecoveryRequest): Promise<RecoverySnapshot> {
    const saved = await this.storage.preserveSnapshot(
      request.baseline,
      `Recovery snapshot before ${request.reason}`,
      [...request.patterns],
    );
    return Object.freeze({
      branch: saved.history,
      snapshotId: CheckpointId(saved.id),
      checkpointPaths: Object.freeze([...saved.checkpointPaths]),
    }) as RecoverySnapshot;
  }

  async prepare(request: RecoveryRequest & { readonly target: string }): Promise<PreparedRecovery> {
    const target = CheckpointId(await this.storage.resolveSnapshot(request.target));
    const snapshot = await this.preserve(request);
    const restore = (id: CheckpointId) =>
      this.storage.restoreSnapshot(id, snapshot.checkpointPaths);
    return Object.freeze({
      target,
      snapshot,
      restore: () => restore(target),
      restoreIntermediate: restore,
    });
  }
}
