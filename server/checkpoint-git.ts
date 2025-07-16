import fs from "node:fs";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { fileResolver } from "./file-resolver.js";
import type { Logger } from "./utils.js";

/**
 * Git operations for the checkpoint system.
 * Handles the shadow git repository in .langton/checkpoints.
 */
export class CheckpointGit {
  private projectPath: string;
  private checkpointPath: string;
  private git: SimpleGit | null = null;
  private logger: Logger;
  private trackedPatterns: Set<string> = new Set();

  constructor(projectPath: string, logger: Logger) {
    this.projectPath = projectPath;
    this.checkpointPath = path.join(projectPath, ".langton", "checkpoints");
    this.logger = logger;
  }

  /**
   * Initialize the shadow git repository
   */
  async initialize(): Promise<void> {
    // Create checkpoint directory
    await fs.promises.mkdir(this.checkpointPath, { recursive: true });

    // Create git config to isolate from user preferences
    const gitConfigPath = path.join(this.checkpointPath, ".gitconfig");
    const gitConfigContent = `[user]
  name = Langton Runner
  email = froggie@southbridge.ai
[commit]
  gpgsign = false
`;
    await fs.promises.writeFile(gitConfigPath, gitConfigContent);

    // Initialize git with proper environment
    this.git = simpleGit(this.projectPath, {
      config: [
        `core.worktree=${this.projectPath}`,
        `core.gitdir=${path.join(this.checkpointPath, ".git")}`,
      ],
    }).env({
      GIT_DIR: path.join(this.checkpointPath, ".git"),
      GIT_WORK_TREE: this.projectPath,
      HOME: this.checkpointPath,
      XDG_CONFIG_HOME: this.checkpointPath,
    });

    // Initialize repository
    await this.git.init(false, { "--initial-branch": "main" });
    await this.git.addConfig("user.name", "Langton Runner");
    await this.git.addConfig("user.email", "froggie@southbridge.ai");
    await this.git.addConfig("commit.gpgsign", "false");

    // Initial empty commit (don't add .gitignore to avoid conflicts with user's project)
    await this.git.commit("Initial checkpoint setup", {
      "--allow-empty": null,
    });

    this.logger.log("Shadow git repository initialized");
  }

  /**
   * Check if repository is initialized
   */
  isInitialized(): boolean {
    return this.git !== null;
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

    // Use the unified file resolver to get files respecting gitignore
    const files = await fileResolver.resolveFiles(
      this.projectPath,
      Array.from(this.trackedPatterns),
    );

    return files;
  }

  /**
   * Create a checkpoint commit
   */
  async commit(
    message: string,
    options?: { branch?: string; allowEmpty?: boolean },
  ): Promise<string | null> {
    if (!this.git) return null;

    let originalBranch: string | undefined;

    // Always use the branch from options if provided
    if (options?.branch) {
      // Remember current branch to switch back later
      const currentBranchInfo = await this.git.branch();
      originalBranch = currentBranchInfo.current;

      // Check if branch exists
      const branches = await this.git.branch();
      if (!branches.all.includes(options.branch)) {
        // Create new branch from current HEAD
        await this.git.checkoutLocalBranch(options.branch);
        this.logger.log(`Created branch: ${options.branch}`);
      } else {
        // Switch to existing branch
        await this.git.checkout(options.branch);
        this.logger.log(`Switched to branch: ${options.branch}`);
      }
    }

    // Get resolved files to add
    const files = await this.getTrackedFiles();

    // First, reset the index to ensure we start clean
    await this.git.reset(["HEAD"]);

    // Explicitly add each resolved file
    if (files.length > 0) {
      // Add files in batches to avoid command line length limits
      const batchSize = 100;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        // Use force add to override any gitignore rules
        await this.git.raw(["add", "-f", ...batch]);
      }
      this.logger.log(`Added ${files.length} files to checkpoint`);
    }

    // Check if we have any staged changes
    const status = await this.git.status();
    if (status.staged.length === 0 && !options?.allowEmpty) {
      this.logger.log("No changes to commit for checkpoint");
      return null;
    }

    // Commit (with --allow-empty if needed)
    const result =
      status.staged.length === 0
        ? await this.git.commit(message, { "--allow-empty": null })
        : await this.git.commit(message);

    // Switch back to original branch if we switched
    if (originalBranch && options?.branch && originalBranch !== options.branch) {
      await this.git.checkout(originalBranch);
      this.logger.log(`Switched back to branch: ${originalBranch}`);
    }

    return result.commit || null;
  }

  /**
   * Get the checkpoint repository path
   */
  getPath(): string {
    return this.checkpointPath;
  }
}
