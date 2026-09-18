import type { Logger } from "../utils.js";
import type { StoredSnapshot, WorkspaceStorage } from "./storage.js";

declare const checkpointIdBrand: unique symbol;
declare const recoverySnapshotBrand: unique symbol;

/** An opaque checkpoint identifier, distinct from branch names and other ids. */
export type CheckpointId = string & { readonly [checkpointIdBrand]: true };

/** Decode an identifier from storage or persisted state. This labels its
 * domain; it does not prove existence. Restore resolves it before mutation. */
export const CheckpointId = (id: string): CheckpointId => id as CheckpointId;

/** Proof that the work tree was saved before recovery. Only the recovery service
 * creates this proof; identifier decoding cannot. */
export interface RecoverySnapshot {
  readonly snapshotId: CheckpointId;
  readonly branch: string;
  /** Saved regular files owned by checkpointing at the abandoned position.
   * Frozen before any restore changes the index, ignore rules, or plan. */
  readonly checkpointPaths: readonly string[];
  readonly [recoverySnapshotBrand]: true;
}

/** One checkpoint as listed by the checkpoint service. */
export interface CheckpointRecord {
  id: CheckpointId;
  message: string;
  timestamp: string;
  parents: readonly CheckpointId[];
}

/** Thrown when a checkpoint reference names no commit in the repository. */
export class CheckpointNotFoundError extends Error {
  /** The unresolved reference supplied by the caller. */
  readonly reference: string;
  constructor(reference: string) {
    super(`Checkpoint ${reference} not found in repository`);
    this.name = "CheckpointNotFoundError";
    this.reference = reference;
  }
}

/** Thrown when git itself failed — the checkpoint storage could not be read or written. */
export class CheckpointStorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CheckpointStorageError";
  }
}

/** The destination changed or is on a different timeline. No files were changed. */
export class CheckpointHistoryConflictError extends Error {
  constructor(
    readonly history: string,
    readonly expected: string | null,
    readonly actual: string | null,
  ) {
    super(
      `Checkpoint history ${history} expected ${expected ?? "no tip"}, found ${actual ?? "no tip"}`,
    );
    this.name = "CheckpointHistoryConflictError";
  }
}

export interface CheckpointRequest {
  readonly parent: CheckpointId;
  readonly message: string;
  readonly patterns: readonly string[];
}

/** A fixed destination. Obtaining a handle does not select or create a branch. */
export interface CheckpointHistory {
  readonly name: string;
  tip(): Promise<CheckpointId | null>;
  list(): Promise<CheckpointRecord[]>;
  /** Record from the explicit parent without changing working files. An existing
   * history must still point at parent; otherwise the write rejects. */
  checkpoint(request: CheckpointRequest): Promise<CheckpointId>;
}

/** Repository-wide queries, with no selected branch or current checkpoint. */
export interface WorkspaceCheckpoints {
  history(name: string): CheckpointHistory;
  histories(): Promise<CheckpointHistory[]>;
  get(id: CheckpointId): Promise<CheckpointRecord>;
  allReachableIds(): Promise<Set<CheckpointId>>;
  reachableDifference(from: CheckpointId, excluding: CheckpointId): Promise<Set<CheckpointId>>;
}

function record(snapshot: StoredSnapshot): CheckpointRecord {
  return {
    id: CheckpointId(snapshot.id),
    parents: snapshot.parents.map(CheckpointId),
    message: snapshot.message,
    timestamp: snapshot.timestamp,
  };
}

/** Stateless history facade over the workspace's shared storage. */
export class CheckpointService implements WorkspaceCheckpoints {
  private constructor(private readonly storage: WorkspaceStorage) {}

  static async open(storage: WorkspaceStorage, logger?: Logger): Promise<CheckpointService> {
    await storage.initialize();
    try {
      await storage.listSnapshots();
    } catch (error) {
      const message =
        `Recovery stopped: checkpoint storage could not be read (${error}). ` +
        "Execution state recovery has not started; see .hankweave/logs/server.log.";
      logger?.log(message, "error");
      throw new CheckpointStorageError(message, error);
    }
    return new CheckpointService(storage);
  }

  history(name: string): CheckpointHistory {
    const storage = this.storage;
    return Object.freeze({
      name,
      async tip() {
        const id = await storage.historyTip(name);
        return id === null ? null : CheckpointId(id);
      },
      async list() {
        return (await storage.listSnapshots(name)).map(record);
      },
      async checkpoint(request: CheckpointRequest) {
        return CheckpointId(
          await storage.saveSnapshot({
            history: name,
            parent: request.parent,
            message: request.message,
            patterns: [...request.patterns],
          }),
        );
      },
    });
  }

  async histories(): Promise<CheckpointHistory[]> {
    return (await this.storage.historyNames()).map((name) => this.history(name));
  }

  async get(id: CheckpointId): Promise<CheckpointRecord> {
    return record(await this.storage.getSnapshot(id));
  }

  async allReachableIds(): Promise<Set<CheckpointId>> {
    return new Set([...(await this.storage.allSnapshotIds())].map(CheckpointId));
  }

  async reachableDifference(
    from: CheckpointId,
    excluding: CheckpointId,
  ): Promise<Set<CheckpointId>> {
    return new Set([...(await this.storage.snapshotsBetween(excluding, from))].map(CheckpointId));
  }
}
