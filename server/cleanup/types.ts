import type { PhaseId } from "../branded-types.js";

export interface CleanupManifest {
  // What will be cleaned
  gitTrackedFiles: GitTrackedFile[];
  copiedItems: CopiedItem[];
  langtonDir: LangtonDirInfo;

  // What we can't clean
  executedCommands: ExecutedCommand[];

  // Metadata
  checkpointRepoExists: boolean;
  currentCommitHash?: string;
  initialCommitHash?: string;
  isAtInitialCommit: boolean;
}

export interface GitTrackedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  sizeBytes?: number;
}

export interface CopiedItem {
  type: "file" | "directory";
  source: string; // Original source path from config
  destination: string; // Where it was copied to
  exists: boolean; // Whether it currently exists
  sizeBytes?: number;
  phaseId: PhaseId; // Which phase created it
}

export interface LangtonDirInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
  contents: {
    logs: string[];
    checkpoints: boolean;
    other: string[];
  };
}

export interface ExecutedCommand {
  command: string;
  workingDirectory: string;
  phaseId: PhaseId;
  possibleSideEffects: string[]; // Inferred from command analysis
}

export interface CleanupOptions {
  configPath: string;
  projectPath: string;
  skipConfirmation: boolean;
}

export interface CleanupResult {
  success: boolean;
  filesRemoved: string[];
  directoriesRemoved: string[];
  gitFilesReset: string[];
  warnings: string[];
  errors: string[];
}
