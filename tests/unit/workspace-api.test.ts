import type { RunId } from "../../server/types/branded-types.js";
import type { WorkspaceArchive, WorkspaceArchives } from "../../server/workspace/archive.js";
import type {
  CheckpointId,
  CheckpointRecord,
  CheckpointService,
  RecoverySnapshot,
  WorkspaceCheckpoints,
} from "../../server/workspace/checkpoints.js";
import type { Workspace } from "../../server/workspace/index.js";
import type { PreparedRecovery, WorkspaceRecovery } from "../../server/workspace/recovery.js";
import type { WorkspaceStorage } from "../../server/workspace/storage.js";

type Assert<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;
type Not<T extends boolean> = T extends false ? true : false;

// Checked by `bun run typecheck`: keep identifiers and the recovery proof
// distinct while allowing their string values to cross serialization boundaries.
export type WorkspaceApiTypeChecks = [
  Assert<Not<Assignable<typeof Workspace, new (...args: never[]) => Workspace>>>,
  Assert<Not<Assignable<typeof WorkspaceArchive, new (...args: never[]) => WorkspaceArchive>>>,
  Assert<Not<Assignable<typeof CheckpointService, new (...args: never[]) => CheckpointService>>>,
  Assert<Assignable<ReturnType<typeof Workspace.open>, Promise<Workspace>>>,
  Assert<Assignable<Workspace["archives"], WorkspaceArchives>>,
  Assert<Assignable<Extract<keyof WorkspaceCheckpoints, "initialize" | "isReady">, never>>,
  Assert<Assignable<Extract<keyof WorkspaceArchives, "initialize" | "isReady">, never>>,
  Assert<
    Assignable<
      keyof Workspace,
      "files" | "checkpoints" | "recovery" | "archives" | "rigs" | "outputs"
    >
  >,
  Assert<Assignable<Workspace["checkpoints"], WorkspaceCheckpoints>>,
  Assert<Not<Assignable<Workspace, WorkspaceCheckpoints>>>,
  Assert<Not<Assignable<string, Parameters<WorkspaceArchive["archive"]>[2]>>>,
  Assert<Not<Assignable<Set<string>, Parameters<WorkspaceArchive["planRestore"]>[0]["known"]>>>,
  Assert<Assignable<CheckpointId, string>>,
  Assert<Assignable<CheckpointId, Parameters<PreparedRecovery["restoreIntermediate"]>[0]>>,
  Assert<Not<Assignable<string, Parameters<PreparedRecovery["restoreIntermediate"]>[0]>>>,
  Assert<Not<Assignable<RunId, CheckpointId>>>,
  Assert<Assignable<RecoverySnapshot["snapshotId"], CheckpointId>>,
  Assert<Assignable<Workspace["recovery"], WorkspaceRecovery>>,
  Assert<Assignable<PreparedRecovery["snapshot"], RecoverySnapshot>>,
  Assert<Assignable<PreparedRecovery["target"], CheckpointId>>,
  Assert<
    Not<
      Assignable<
        { snapshotId: CheckpointId; branch: string; checkpointPaths: string[] },
        RecoverySnapshot
      >
    >
  >,
  Assert<
    Assignable<
      Extract<
        keyof WorkspaceCheckpoints,
        "checkpoint" | "restore" | "useBranch" | "currentCheckpoint"
      >,
      never
    >
  >,
  Assert<Not<Assignable<CheckpointId, RecoverySnapshot>>>,
  Assert<Assignable<CheckpointRecord["id"], CheckpointId>>,
  Assert<Not<Assignable<"sha", keyof CheckpointRecord>>>,
  Assert<Not<Assignable<"run", keyof WorkspaceStorage>>>,
  Assert<Not<Assignable<"runSync", keyof WorkspaceStorage>>>,
  Assert<Not<Assignable<"resetIndex", keyof WorkspaceStorage>>>,
];
