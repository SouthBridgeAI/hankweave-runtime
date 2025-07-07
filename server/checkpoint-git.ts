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

    // Initial empty commit (don't add .gitignore to avoid conflicts with user's project)
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
   * Update git exclude file to track only specified patterns
   * Using info/exclude instead of .gitignore to avoid interfering with user's project
   */
  private async updateGitignore(): Promise<void> {
    const excludePath = path.join(this.checkpointPath, ".git", "info", "exclude");

    // Ensure the info directory exists
    const infoDir = path.join(this.checkpointPath, ".git", "info");
    await fs.promises.mkdir(infoDir, { recursive: true });

    if (this.trackedPatterns.size === 0) {
      // If no patterns, just ignore everything
      const excludeContent = "# Langton checkpoint exclude rules\n# Ignore everything\n*\n";
      await fs.promises.writeFile(excludePath, excludeContent);
      return;
    }

    // Build exclude content properly for git
    let excludeContent = "# Langton checkpoint exclude rules\n";
    excludeContent += "# Ignore everything by default\n*\n\n";

    // For each pattern, we need to unignore the path and parent directories
    const allPaths = new Set<string>();

    for (const pattern of this.trackedPatterns) {
      // Remove leading ./ if present
      const cleanPattern = pattern.replace(/^\.\//, "");

      // Add the pattern itself
      allPaths.add(`!${cleanPattern}`);

      // For patterns with directories, also unignore parent directories
      if (cleanPattern.includes("/")) {
        const parts = cleanPattern.split("/");
        let currentPath = "";

        // Unignore each parent directory
        for (let i = 0; i < parts.length - 1; i++) {
          currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
          allPaths.add(`!${currentPath}/`);
        }
      }
    }

    // Add all the unignore rules
    excludeContent += "# Unignore tracked patterns and their parent directories\n";
    for (const path of Array.from(allPaths).sort()) {
      excludeContent += `${path}\n`;
    }

    await fs.promises.writeFile(excludePath, excludeContent);
  }

  /**
   * Create a checkpoint commit
   */
  async commit(
    message: string,
    options?: { branch?: string; allowEmpty?: boolean },
  ): Promise<string | null> {
    if (!this.git) return null;

    // Create branch if specified
    if (options?.branch) {
      await this.git.checkoutLocalBranch(options.branch);
      this.logger.log(`Created branch: ${options.branch}`);
    }

    // Stage all files (exclude file will filter what gets included)
    await this.git.add(".");

    // Check if we have any staged changes
    const status = await this.git.status();
    if (status.staged.length === 0 && !options?.allowEmpty) {
      this.logger.log("No changes to commit for checkpoint");
      // Switch back to main if we branched
      if (options?.branch) {
        await this.git.checkout("main");
      }
      return null;
    }

    // Commit (with --allow-empty if needed)
    const result = status.staged.length === 0 
      ? await this.git.commit(message, { "--allow-empty": null })
      : await this.git.commit(message);

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
