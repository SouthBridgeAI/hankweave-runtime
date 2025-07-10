import fs from "node:fs";
import path from "node:path";
import { loadPhaseConfig } from "../config.js";
import type { PhaseConfig } from "../types.js";
import { analyzeCommand } from "./command-analyzer.js";
import { getDirectorySize } from "./file-operations.js";
import { GitOperations } from "./git-operations.js";
import type {
  CleanupManifest,
  CopiedItem,
  ExecutedCommand,
  GitTrackedFile,
  LangtonDirInfo,
} from "./types.js";

export class ManifestBuilder {
  constructor(
    private configPath: string,
    private projectPath: string,
  ) {}

  async build(): Promise<CleanupManifest> {
    const phases = loadPhaseConfig(this.configPath);

    const [copiedItems, executedCommands, langtonDir, gitInfo] = await Promise.all([
      this.findCopiedItems(phases),
      this.findExecutedCommands(phases),
      this.analyzeLangtonDir(),
      this.analyzeGitState(),
    ]);

    return {
      gitTrackedFiles: gitInfo.trackedFiles,
      copiedItems,
      langtonDir,
      executedCommands,
      checkpointRepoExists: gitInfo.repoExists,
      currentCommitHash: gitInfo.currentCommit,
      initialCommitHash: gitInfo.initialCommit,
      isAtInitialCommit: gitInfo.isAtInitial,
    };
  }

  private async findCopiedItems(phases: PhaseConfig[]): Promise<CopiedItem[]> {
    const items: CopiedItem[] = [];

    for (const phase of phases) {
      if (!phase.workspaceSetup) continue;

      for (const setup of phase.workspaceSetup) {
        if (setup.type === "copy" && setup.copy) {
          const destPath = path.join(this.projectPath, setup.copy.to);
          const exists = fs.existsSync(destPath);

          let type: "file" | "directory" = "file";
          let sizeBytes: number | undefined;

          if (exists) {
            const stats = await fs.promises.stat(destPath);
            type = stats.isDirectory() ? "directory" : "file";

            if (type === "directory") {
              try {
                sizeBytes = await getDirectorySize(destPath);
              } catch (error) {
                // Size calculation timed out or failed
                console.warn(`Failed to calculate size for ${destPath}: ${error}`);
              }
            } else {
              sizeBytes = stats.size;
            }
          }

          items.push({
            type,
            source: setup.copy.from,
            destination: setup.copy.to,
            exists,
            sizeBytes,
            phaseId: phase.id,
          });
        }
      }
    }

    return items;
  }

  private async findExecutedCommands(phases: PhaseConfig[]): Promise<ExecutedCommand[]> {
    const commands: ExecutedCommand[] = [];

    for (const phase of phases) {
      if (!phase.workspaceSetup) continue;

      let lastCopiedDir: string | null = null;

      for (const setup of phase.workspaceSetup) {
        if (setup.type === "copy" && setup.copy) {
          // Track last copied directory for workingDirectory resolution
          const destPath = path.join(this.projectPath, setup.copy.to);
          if (fs.existsSync(destPath) && fs.statSync(destPath).isDirectory()) {
            lastCopiedDir = destPath;
          }
        } else if (setup.type === "command" && setup.command) {
          const workingDir =
            setup.command.workingDirectory === "lastCopied" && lastCopiedDir
              ? lastCopiedDir
              : this.projectPath;

          commands.push({
            command: setup.command.run,
            workingDirectory: path.relative(this.projectPath, workingDir) || ".",
            phaseId: phase.id,
            possibleSideEffects: analyzeCommand(setup.command.run),
          });
        }
      }
    }

    return commands;
  }

  private async analyzeLangtonDir(): Promise<LangtonDirInfo> {
    const langtonPath = path.join(this.projectPath, ".langton");

    if (!fs.existsSync(langtonPath)) {
      return {
        path: ".langton",
        exists: false,
        sizeBytes: 0,
        contents: { logs: [], checkpoints: false, other: [] },
      };
    }

    const contents = {
      logs: [] as string[],
      checkpoints: false,
      other: [] as string[],
    };

    // Scan .langton contents
    const entries = await fs.promises.readdir(langtonPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (entry.name === "logs" && entry.isDirectory()) {
        const logFiles = await fs.promises.readdir(path.join(langtonPath, "logs"));
        contents.logs = logFiles;
      } else if (entry.name === "checkpoints" && entry.isDirectory()) {
        contents.checkpoints = true;
      } else {
        contents.other.push(entry.name);
      }
    }

    let sizeBytes = 0;
    try {
      sizeBytes = await getDirectorySize(langtonPath);
    } catch (error) {
      console.warn(`Failed to calculate .langton size: ${error}`);
    }

    return {
      path: ".langton",
      exists: true,
      sizeBytes,
      contents,
    };
  }

  private async analyzeGitState(): Promise<{
    repoExists: boolean;
    trackedFiles: GitTrackedFile[];
    currentCommit?: string;
    initialCommit?: string;
    isAtInitial: boolean;
  }> {
    const checkpointPath = path.join(this.projectPath, ".langton", "checkpoints");

    if (!fs.existsSync(checkpointPath)) {
      return {
        repoExists: false,
        trackedFiles: [],
        isAtInitial: true,
      };
    }

    const gitOps = new GitOperations(this.projectPath, checkpointPath);

    try {
      const [isRepo, currentCommit, initialCommit, trackedFiles] = await Promise.all([
        gitOps.isGitRepository(),
        gitOps.getCurrentCommit(),
        gitOps.getInitialCommit(),
        gitOps.getTrackedFiles(),
      ]);

      return {
        repoExists: isRepo,
        trackedFiles,
        currentCommit,
        initialCommit,
        isAtInitial: currentCommit === initialCommit,
      };
    } catch (error) {
      console.warn(`Failed to analyze git state: ${error}`);
      return {
        repoExists: false,
        trackedFiles: [],
        isAtInitial: true,
      };
    }
  }
}
