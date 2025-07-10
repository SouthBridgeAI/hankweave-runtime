import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { GitTrackedFile } from "./types.js";

export class GitOperations {
  private git: SimpleGit;

  constructor(
    private projectPath: string,
    private checkpointPath: string,
  ) {
    this.git = simpleGit(projectPath, {
      config: [`core.worktree=${projectPath}`, `core.gitdir=${path.join(checkpointPath, ".git")}`],
    }).env({
      GIT_DIR: path.join(checkpointPath, ".git"),
      GIT_WORK_TREE: projectPath,
    });
  }

  async isGitRepository(): Promise<boolean> {
    try {
      await this.git.revparse(["--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentCommit(): Promise<string | undefined> {
    try {
      const fullHash = await this.git.revparse(["HEAD"]);
      // Return just the short hash (first 7 characters) for consistency
      return fullHash?.substring(0, 7);
    } catch {
      return undefined;
    }
  }

  async getInitialCommit(): Promise<string | undefined> {
    try {
      // IMPORTANT: We use git.raw() instead of git.log() because simple-git's
      // log() method doesn't properly handle our complex git setup with separate
      // GIT_DIR and GIT_WORK_TREE paths. This was causing it to return the
      // entire log output as a single string instead of parsed commits.
      const logOutput = await this.git.raw(["log", "--reverse", "--oneline"]);

      if (!logOutput || !logOutput.trim()) {
        return undefined;
      }

      // Extract just the hash from the first line (which is the oldest commit)
      // Note: --oneline already gives us short hashes (7 chars) which matches
      // what getCurrentCommit() returns for consistency
      const firstLine = logOutput.trim().split("\n")[0];
      const hash = firstLine.split(" ")[0];

      return hash;
    } catch {
      return undefined;
    }
  }

  async getTrackedFiles(): Promise<GitTrackedFile[]> {
    try {
      const initialCommit = await this.getInitialCommit();
      if (!initialCommit) return [];

      // Get diff between initial commit and current state
      const diff = await this.git.diff(["--name-status", initialCommit, "HEAD"]);

      const files: GitTrackedFile[] = [];
      const lines = diff.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        const [status, ...pathParts] = line.split("\t");
        const filePath = pathParts.join("\t");

        if (!filePath) continue;

        files.push({
          path: filePath,
          status:
            status === "A"
              ? "added"
              : status === "M"
                ? "modified"
                : status === "D"
                  ? "deleted"
                  : "modified",
        });
      }

      // Also check working directory changes
      const workingChanges = await this.git.status();
      for (const file of workingChanges.files) {
        if (!files.find((f) => f.path === file.path)) {
          files.push({
            path: file.path,
            status:
              file.working_dir === "A"
                ? "added"
                : file.working_dir === "M"
                  ? "modified"
                  : file.working_dir === "D"
                    ? "deleted"
                    : "modified",
          });
        }
      }

      return files;
    } catch {
      return [];
    }
  }

  async resetToInitial(): Promise<void> {
    const initialCommit = await this.getInitialCommit();
    if (!initialCommit) {
      throw new Error("No initial commit found");
    }

    // Reset to initial commit without paths
    await this.git.reset(["--hard", initialCommit]);
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.git.status();
    return !status.isClean();
  }
}
