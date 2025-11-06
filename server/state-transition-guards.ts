import type { SessionId } from "./types/branded-types.js";
import type { PhaseStatus } from "./types/state-types.js";
import type { FailureReason } from "./types/types.js";

// Type guard functions to ensure metadata has required fields for specific transitions

// Metadata for transitioning to initializing
export interface InitializingMetadata {
  claudePid: number;
  claudeLogPath: string;
}

// Metadata for transitioning to running
export interface RunningMetadata {
  claudeSessionId: SessionId;
}

// Metadata for transitioning to completed
export interface CompletedMetadata {
  checkpointSha: string;
  resultMessageReceived?: boolean;
}

// Metadata for transitioning to failed
export interface FailedMetadata {
  exitCode: number;
  failureReason: FailureReason;
  failedDuring: PhaseStatus;
  checkpointSha?: string;
}

// Metadata for transitioning to skipped
export interface SkippedMetadata {
  skippedDuring: PhaseStatus;
  checkpointSha?: string;
}

// Type guards
export function hasInitializingMetadata(metadata: unknown): metadata is InitializingMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "claudePid" in metadata &&
    "claudeLogPath" in metadata &&
    typeof (metadata as Record<string, unknown>).claudePid === "number" &&
    typeof (metadata as Record<string, unknown>).claudeLogPath === "string"
  );
}

export function hasRunningMetadata(metadata: unknown): metadata is RunningMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "claudeSessionId" in metadata &&
    typeof (metadata as Record<string, unknown>).claudeSessionId === "string"
  );
}

export function hasCompletedMetadata(metadata: unknown): metadata is CompletedMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "checkpointSha" in metadata &&
    typeof (metadata as Record<string, unknown>).checkpointSha === "string"
  );
}

export function hasFailedMetadata(metadata: unknown): metadata is FailedMetadata {
  const meta = metadata as Record<string, unknown>;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "exitCode" in metadata &&
    typeof meta.exitCode === "number" &&
    "failureReason" in metadata &&
    typeof meta.failureReason === "object" &&
    "failedDuring" in metadata &&
    typeof meta.failedDuring === "string"
  );
}

export function hasSkippedMetadata(metadata: unknown): metadata is SkippedMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "skippedDuring" in metadata &&
    typeof (metadata as Record<string, unknown>).skippedDuring === "string"
  );
}

// Validation error class
export class MetadataValidationError extends Error {
  constructor(
    public readonly transitionTo: PhaseStatus,
    public readonly missingFields: string[],
  ) {
    super(
      `Missing required metadata fields for transition to ${transitionTo}: ${missingFields.join(
        ", ",
      )}`,
    );
    this.name = "MetadataValidationError";
  }
}

// Validation function that throws descriptive errors
export function validateTransitionMetadata(to: PhaseStatus, metadata: unknown): void {
  switch (to) {
    case "initializing":
      if (!hasInitializingMetadata(metadata)) {
        const missing: string[] = [];
        if (!metadata || typeof metadata !== "object") {
          missing.push("metadata object");
        } else {
          if (!("claudePid" in metadata)) missing.push("claudePid");
          if (!("claudeLogPath" in metadata)) missing.push("claudeLogPath");
        }
        throw new MetadataValidationError(to, missing);
      }
      break;

    case "running":
      if (!hasRunningMetadata(metadata)) {
        const missing: string[] = [];
        if (!metadata || typeof metadata !== "object") {
          missing.push("metadata object");
        } else {
          if (!("claudeSessionId" in metadata)) missing.push("claudeSessionId");
        }
        throw new MetadataValidationError(to, missing);
      }
      break;

    case "completed":
      if (!hasCompletedMetadata(metadata)) {
        const missing: string[] = [];
        if (!metadata || typeof metadata !== "object") {
          missing.push("metadata object");
        } else {
          if (!("checkpointSha" in metadata)) missing.push("checkpointSha");
        }
        throw new MetadataValidationError(to, missing);
      }
      break;

    case "failed":
      if (!hasFailedMetadata(metadata)) {
        const missing: string[] = [];
        if (!metadata || typeof metadata !== "object") {
          missing.push("metadata object");
        } else {
          if (!("exitCode" in metadata)) missing.push("exitCode");
          if (!("failureReason" in metadata)) missing.push("failureReason");
          if (!("failedDuring" in metadata)) missing.push("failedDuring");
        }
        throw new MetadataValidationError(to, missing);
      }
      break;

    case "skipped":
      if (!hasSkippedMetadata(metadata)) {
        const missing: string[] = [];
        if (!metadata || typeof metadata !== "object") {
          missing.push("metadata object");
        } else {
          if (!("skippedDuring" in metadata)) missing.push("skippedDuring");
        }
        throw new MetadataValidationError(to, missing);
      }
      break;

    // Other transitions don't require metadata
    case "preparing":
    case "starting":
    case "completing-chroniclers":
      break;
  }
}
