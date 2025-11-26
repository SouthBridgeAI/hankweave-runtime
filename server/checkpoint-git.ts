import fs from "node:fs";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { fileResolver } from "./file-resolver.js";
import type { Logger } from "./utils.js";

/**
 * Git operations for the checkpoint system.
 * Handles the shadow git repository in .strandweave/checkpoints.
 */
export class CheckpointGit {
  private executionPath: string;
  private checkpointPath: string;
  private git: SimpleGit | null = null;
  private logger: Logger;
  private trackedPatterns: Set<string> = new Set();

  constructor(executionPath: string, logger: Logger) {
    this.executionPath = executionPath;
    this.checkpointPath = path.join(executionPath, ".strandweave", "checkpoints");
    this.logger = logger;
  }

  /**
   * Initialize the shadow git repository
   * @returns The initial commit SHA (either from new repo creation or existing repo HEAD)
   */
  async initialize(): Promise<string | undefined> {
    // Create checkpoint directory
    await fs.promises.mkdir(this.checkpointPath, { recursive: true });

    // Check if repository already exists
    const gitDir = path.join(this.checkpointPath, ".git");
    const repoExists = fs.existsSync(gitDir);

    if (repoExists) {
      // Repository exists - just set up git instance
      this.git = simpleGit(this.executionPath, {
        // Disable parallel processes to avoid lock contention
        maxConcurrentProcesses: 1,
        config: [
          `core.worktree=${this.executionPath}`,
          `core.gitdir=${path.join(this.checkpointPath, ".git")}`,
        ],
      }).env({
        GIT_DIR: path.join(this.checkpointPath, ".git"),
        GIT_WORK_TREE: this.executionPath,
        HOME: this.checkpointPath,
        XDG_CONFIG_HOME: this.checkpointPath,
      });

      try {
        // Get current HEAD as the initial checkpoint for this session
        const currentHead = await this.git.revparse(["HEAD"]);
        this.logger.log(`Using existing shadow git repository with HEAD: ${currentHead}`);
        return currentHead;
      } catch (error) {
        // Handle edge cases like empty repository
        this.logger.log(`Could not get HEAD from existing repository: ${error}`, "error");
        this.logger.log("Using existing shadow git repository");
        return undefined;
      }
    }

    // Create git config to isolate from user preferences
    const gitConfigPath = path.join(this.checkpointPath, ".gitconfig");
    const gitConfigContent = `[user]
  name = Strandweave Runtime
  email = froggie@southbridge.ai
[commit]
  gpgsign = false
`;
    await fs.promises.writeFile(gitConfigPath, gitConfigContent);

    // Initialize git with proper environment
    this.git = simpleGit(this.executionPath, {
      // Disable parallel processes to avoid lock contention
      maxConcurrentProcesses: 1,
      config: [
        `core.worktree=${this.executionPath}`,
        `core.gitdir=${path.join(this.checkpointPath, ".git")}`,
      ],
    }).env({
      GIT_DIR: path.join(this.checkpointPath, ".git"),
      GIT_WORK_TREE: this.executionPath,
      HOME: this.checkpointPath,
      XDG_CONFIG_HOME: this.checkpointPath,
    });

    // Initialize repository
    await this.git.init(false, { "--initial-branch": "main" });
    await this.git.addConfig("user.name", "Strandweave Runtime");
    await this.git.addConfig("user.email", "froggie@southbridge.ai");
    await this.git.addConfig("commit.gpgsign", "false");

    // Initial empty commit (don't add .gitignore to avoid conflicts with user's project)
    const result = await this.git.commit("Initial checkpoint setup", {
      "--allow-empty": null,
    });

    const initialSha = result.commit || undefined;
    this.logger.log(`Shadow git repository initialized with initial commit: ${initialSha}`);

    return initialSha;
  }

  /**
   * Check if repository is initialized
   */
  isInitialized(): boolean {
    return this.git !== null;
  }

  /**
   * Get the current branch name
   * @returns The current branch name or undefined if not initialized
   */
  public async getCurrentBranch(): Promise<string | undefined> {
    if (!this.git) {
      return undefined;
    }
    const b = await this.git.branch();
    return b.current;
  }

  /**
   * Add patterns to track
   */
  async addPatterns(patterns: string[]): Promise<void> {
    for (const pattern of patterns) {
      this.trackedPatterns.add(pattern);
    }
    // No need to update gitignore - we'll use explicit file adds
  }

  /**
   * Clear all tracked patterns
   */
  clearPatterns(): void {
    this.trackedPatterns.clear();
    this.logger.log("Cleared all tracked patterns");
  }

  /**
   * Get resolved files for all tracked patterns
   */
  private async getTrackedFiles(): Promise<string[]> {
    if (this.trackedPatterns.size === 0) {
      return [];
    }

    const patterns = Array.from(this.trackedPatterns);
    // Use the unified file resolver to get files respecting gitignore
    const files = await fileResolver.resolveFiles(this.executionPath, patterns);
    return files;
  }

  /**
   * Create a checkpoint commit. If branch is specified, switch to that branch for the commit and then switch back to the original branch.
   * @param message Commit message for the checkpoint
   * @param options Optional parameters, including branch name
   * @returns The commit SHA of the new checkpoint or null if commit failed
   */
  async commit(message: string, options?: { branch?: string }): Promise<string | null> {
    if (!this.git) return null;

    this.logger.log(`[CHECKPOINT-COMMIT] Starting commit with message: ${message.split("\n")[0]}`);
    this.logger.log(
      `[CHECKPOINT-COMMIT] Tracked patterns: ${Array.from(this.trackedPatterns).join(", ")}`,
    );

    let originalBranch: string | undefined;

    // Always use the branch from options if provided
    if (options?.branch) {
      // Remember current branch to switch back later
      originalBranch = await this.getCurrentBranch();
      this.logger.log(
        `[CHECKPOINT-COMMIT] Current branch: ${originalBranch}, switching to: ${options.branch}`,
      );

      // Check if branch exists
      const branches = await this.git.branch();
      if (!branches.all.includes(options.branch)) {
        // Create new branch from current HEAD
        this.logger.log(`[CHECKPOINT-COMMIT] Creating new branch: ${options.branch}`);
        await this.git.checkoutLocalBranch(options.branch);
      } else {
        // Switch to existing branch
        this.logger.log(`[CHECKPOINT-COMMIT] Switching to existing branch: ${options.branch}`);
        await this.git.checkout(options.branch);
      }
    }

    let commitSha: string | null = null;
    try {
      // Get resolved files to add
      const files = await this.getTrackedFiles();
      this.logger.log(`[CHECKPOINT-COMMIT] Resolved ${files.length} files to track`);
      if (files.length > 0) {
        this.logger.log(
          `[CHECKPOINT-COMMIT] First few files: ${files
            .slice(0, 5)
            .join(", ")}${files.length > 5 ? "..." : ""}`,
        );
      }

      // Check working directory status before reset
      const statusBefore = await this.git.status();
      this.logger.log(
        `[CHECKPOINT-COMMIT] Status before reset - modified: ${statusBefore.modified.length}, not_added: ${statusBefore.not_added.length}`,
      );

      // IMPORTANT: Only reset the INDEX, not the working directory
      // Using 'mixed' reset (default) to only affect the index
      this.logger.log(
        `[CHECKPOINT-COMMIT] Resetting index (mixed mode - working directory unchanged)`,
      );
      await this.git.reset(["--mixed", "HEAD"]);

      // Check status after reset to confirm working directory unchanged
      const statusAfter = await this.git.status();
      this.logger.log(
        `[CHECKPOINT-COMMIT] Status after reset - modified: ${statusAfter.modified.length}, not_added: ${statusAfter.not_added.length}`,
      );

      // Explicitly add each resolved file
      if (files.length > 0) {
        // Add files in batches to avoid command line length limits
        const batchSize = 100;
        for (let i = 0; i < files.length; i += batchSize) {
          const batch = files.slice(i, i + batchSize);
          try {
            // Use force add to override any gitignore rules
            this.logger.log(
              `[CHECKPOINT-COMMIT] Adding batch ${
                Math.floor(i / batchSize) + 1
              }/${Math.ceil(files.length / batchSize)} (${batch.length} files)`,
            );
            await this.git.raw(["add", "-f", ...batch]);
          } catch (error) {
            this.logger.log(
              `[CHECKPOINT-COMMIT] Error adding files to checkpoint: ${error}`,
              "error",
            );
          }
        }
      }

      // Always create commit, even if empty (for semantic consistency)
      this.logger.log(`[CHECKPOINT-COMMIT] Creating commit`);
      const result = await this.git.commit(message, { "--allow-empty": null });

      commitSha = result.commit || null;
      this.logger.log(`[CHECKPOINT-COMMIT] Commit complete: ${commitSha}`);
    } finally {
      // If we switched branches for the commit, switch back
      if (options?.branch && originalBranch && originalBranch !== options.branch) {
        try {
          await this.git.checkout(originalBranch);
          this.logger.log(`[CHECKPOINT-COMMIT] Restored original branch: ${originalBranch}`);
        } catch (err) {
          this.logger.log(
            `[CHECKPOINT-COMMIT] Failed to restore original branch (${originalBranch}): ${err}`,
            "error",
          );
        }
      }
    }

    return commitSha;
  }

  /**
   * Get the checkpoint repository path
   */
  getPath(): string {
    return this.checkpointPath;
  }

  /**
   * Switch to a specific branch, creating it if it doesn't exist
   */
  async switchToBranch(branchName: string): Promise<void> {
    if (!this.git) {
      throw new Error("Git repository not initialized");
    }

    try {
      const branches = await this.git.branch();
      if (branches.all.includes(branchName)) {
        await this.git.checkout(branchName);
        this.logger.log(`Switched to existing branch: ${branchName}`);
      } else {
        // Create new branch from current HEAD
        this.logger.log(`Creating new branch: ${branchName}`);
        await this.git.checkoutLocalBranch(branchName);
        this.logger.log(`Created and switched to new branch: ${branchName}`);
      }
    } catch (error) {
      this.logger.log(`Failed to switch branch: ${error}`, "error");
      throw error;
    }
  }

  /**
   * Get all checkpoint SHAs from the repository
   * @returns Set of all commit SHAs in the repository
   */
  async getAllCheckpointShas(): Promise<Set<string>> {
    if (!this.git) {
      throw new Error("Git repository not initialized");
    }

    try {
      // Include commits from all branches and use parsed output
      const log = await this.git.log(["--all"]);
      return new Set(log.all.map((commit) => commit.hash));
    } catch (error) {
      this.logger.log(`Failed to get checkpoint SHAs: ${error}`, "error");
      return new Set();
    }
  }

  /**
   * Get all checkpoints with detailed information, ordered by time (newest first)
   * @returns Array of checkpoint information ordered by timestamp
   */
  async getAllCheckpoints(): Promise<
    Array<{
      sha: string;
      message: string;
      timestamp: string;
      branch: string;
    }>
  > {
    if (!this.git) {
      throw new Error("Git repository not initialized");
    }

    try {
      const branches = await this.git.branch();

      // Gather commits from all branches, de-duplicated by SHA.
      const seen = new Set<string>();
      const allCheckpoints: Array<{
        sha: string;
        message: string;
        timestamp: string;
        branch: string;
      }> = [];

      for (const branch of branches.all) {
        try {
          const log = await this.git.log([branch]);
          for (const commit of log.all) {
            if (seen.has(commit.hash)) continue;
            seen.add(commit.hash);
            allCheckpoints.push({
              sha: commit.hash,
              message: commit.message,
              timestamp: commit.date,
              branch,
            });
          }
        } catch (error) {
          // Branch might not have any commits yet
          this.logger.log(`Could not get log for branch ${branch}: ${error}`, "debug");
        }
      }

      // Sort by timestamp descending (newest first)
      allCheckpoints.sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return timeB - timeA;
      });

      return allCheckpoints;
    } catch (error) {
      this.logger.log(`Failed to get checkpoints: ${error}`, "error");
      return [];
    }
  }

  /**
   * Reset to a specific checkpoint
   */
  async resetToCheckpoint(sha: string): Promise<void> {
    if (!this.git) {
      throw new Error("Git repository not initialized");
    }

    this.logger.log(`[CHECKPOINT-DEBUG] Starting reset to checkpoint ${sha}`);

    // Verify SHA exists
    try {
      const log = await this.git.log();
      this.logger.log(`[CHECKPOINT-DEBUG] Found ${log.all.length} commits in log`);

      const commit = log.all.find((c) => c.hash.startsWith(sha));

      if (!commit) {
        this.logger.log(`[CHECKPOINT-DEBUG] Available commits:`);
        log.all.forEach((c, i) => {
          this.logger.log(
            `[CHECKPOINT-DEBUG]   ${i + 1}. ${c.hash.substring(0, 7)} - ${c.message}`,
          );
        });
        throw new Error(`Checkpoint ${sha} not found in repository`);
      }

      this.logger.log(`[CHECKPOINT-DEBUG] Found target commit: ${commit.hash} - ${commit.message}`);

      // Check current status before reset
      const statusBefore = await this.git.status();
      this.logger.log(
        `[CHECKPOINT-DEBUG] Status before reset - staged: ${statusBefore.staged.length}, modified: ${statusBefore.modified.length}, not_added: ${statusBefore.not_added.length}`,
      );

      // Hard reset to preserve exact file state
      const resetResult = await this.git.reset(["--hard", sha]);
      this.logger.log(`[CHECKPOINT-DEBUG] Git reset result: ${resetResult}`);

      // Check status after reset
      const statusAfter = await this.git.status();
      this.logger.log(
        `[CHECKPOINT-DEBUG] Status after reset - staged: ${statusAfter.staged.length}, modified: ${statusAfter.modified.length}, not_added: ${statusAfter.not_added.length}`,
      );

      // Show what files are in the working directory after reset
      const currentHead = await this.git.revparse(["HEAD"]);
      this.logger.log(`[CHECKPOINT-DEBUG] Current HEAD after reset: ${currentHead}`);

      this.logger.log(`[CHECKPOINT-DEBUG] Reset to checkpoint ${sha}: ${commit.message}`);
    } catch (error) {
      this.logger.log(`[CHECKPOINT-DEBUG] Reset failed: ${error}`);
      throw new Error(
        `Failed to reset to checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
