import type { RigSetupItem } from "./config.js";
import type { HankDir, IgnoredEntry } from "./hank-dir.js";
import type { SentinelState } from "./types/state-types.js";
import type { FailureReason } from "./types/types.js";
import type { RigOperationFailure } from "./workspace/rigs.js";

export interface SentinelLoadResult {
  loaded: string[];
  errors: { ref: string; error: string; fatal: boolean }[];
  sentinelStates?: SentinelState[];
}

/** Preparation owns state and filesystem effects; the runtime reports progress. */
export type PreparationProgress =
  | { type: "rig-started"; operationCount: number }
  | { type: "rig-operation"; index: number; operationCount: number; item: RigSetupItem }
  /** A copy step planted its tree minus what the hank's ignore rules excluded. */
  | { type: "rig-copy-excluded"; index: number; from: string; ignored: IgnoredEntry[] }
  | { type: "rig-output"; index: number; stream: "stdout" | "stderr"; line: string }
  | ({
      type: "rig-operation-failed";
      index: number;
      item: RigSetupItem;
      ignored: boolean;
    } & RigOperationFailure)
  | { type: "rig-operations-completed"; durationMs: number; succeeded: number; failed: number }
  | {
      type: "rig-completed";
      operationCount: number;
      durationMs: number;
      createdCheckpoint: boolean;
    }
  | { type: "sentinel-warning"; ref: string; error: string };

export interface PrepareCodonOptions {
  hankDir: HankDir | null;
  replay?: boolean;
  /** Explicit client override; retries and rollback derive reuse from state. */
  skipRequested?: boolean;
  ignoreRigFailures?: boolean;
  shouldAbort?: () => boolean;
  onProgress?: (progress: PreparationProgress) => void;
  loadSentinels: () => Promise<SentinelLoadResult>;
}

export type PreparationFailure = {
  status: "failed";
  error: Error;
  failureReason: FailureReason;
  exitCode: number;
} & (
  | { phase: "rig"; index: number; item: RigSetupItem }
  | { phase: "sentinels"; refs: string[] }
  | { phase: "checkpoint" }
);

export type PreparationResult =
  | { status: "ready"; checkpointSha?: string }
  | { status: "aborted" }
  | PreparationFailure;
