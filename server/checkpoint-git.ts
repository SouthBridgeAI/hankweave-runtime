import fs from "node:fs";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
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

    // Create initial .gitignore
    await this.updateGitignore();

    // Initial commit
    await this.git.add(".gitignore");
    await this.git.commit("Initial checkpoint setup", { "--allow-empty": null });

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
    await this.updateGitignore();
  }

  /**
   * Update .gitignore to track only specified patterns
   */
  private async updateGitignore(): Promise<void> {
    const gitignorePath = path.join(this.checkpointPath, ".gitignore");

    // Start with ignoring everything
    let gitignoreContent = "# Ignore everything by default\n*\n\n";

    // Add exceptions for tracked patterns
    if (this.trackedPatterns.size > 0) {
      gitignoreContent += "# Tracked patterns\n";
      for (const pattern of this.trackedPatterns) {
        gitignoreContent += `!${pattern}\n`;
      }
    }

    await fs.promises.writeFile(gitignorePath, gitignoreContent);
  }

  /**
   * Create a checkpoint commit
   */
  async commit(message: string, options?: { branch?: string }): Promise<string | null> {
    if (!this.git) return null;

    // Create branch if specified
    if (options?.branch) {
      await this.git.checkoutLocalBranch(options.branch);
      this.logger.log(`Created branch: ${options.branch}`);
    }

    // Stage all tracked files
    await this.git.add(".");

    // Commit
    const result = await this.git.commit(message);

    // Switch back to main if we branched
    if (options?.branch) {
      await this.git.checkout("main");
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
