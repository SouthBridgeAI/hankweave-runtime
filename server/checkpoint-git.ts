import fs from "node:fs";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { fileResolver } from "./file-resolver.js";
import { type Logger, renameWithRetry } from "./utils.js";

/** Name of the checkpoint git directory. Using .hankweavecheckpoints instead of .git to prevent
 *  Git from treating execution environments as submodules when committed. */
const CHECKPOINT_GIT_DIR = ".hankweavecheckpoints";

/**
 * Git operations for the checkpoint system.
 * Handles the shadow git repository in .hankweave/checkpoints.
 */
export class CheckpointGit {
  private executionPath: string;
  private agentRootPath: string; // Work tree where agent files live
  private checkpointPath: string;
  private git: SimpleGit | null = null;
  private logger: Logger;
  private trackedPatterns: Set<string> = new Set();

  constructor(executionPath: string, agentRootPath: string, logger: Logger) {
    // Defensive check: agentRootPath must be a string
    if (typeof agentRootPath !== "string") {
      throw new Error(
        `CheckpointGit: agentRootPath must be a string, got ${typeof agentRootPath}: ${JSON.stringify(agentRootPath)}`,
      );
    }
    this.executionPath = executionPath;
    this.agentRootPath = agentRootPath;
    this.checkpointPath = path.join(executionPath, ".hankweave", "checkpoints");
    this.logger = logger;
  }

  /**
   * Migrate backup directories from legacy .git to .hankweavecheckpoints.
   * Called conditionally when the main checkpoint needed migration.
   */
  private async migrateBackupDirectories(): Promise<void> {
    // Skip if we're somehow running inside a backup directory (shouldn't happen, but be defensive)
    if (this.executionPath.includes(".hankweave.backup-")) {
      return;
    }

    // When --start-new --force runs, it renames the ENTIRE .hankweave directory to
    // .hankweave.backup-{timestamp}. This means backups have the structure:
    //   {executionPath}/.hankweave.backup-{timestamp}/checkpoints/.git
    //
    // These backup directories live at the same level as .hankweave (both are direct
    // children of executionPath). We need to scan them and migrate any legacy .git.
    const executionRoot = this.executionPath;

    let successCount = 0;
    let failCount = 0;

    try {
      const entries = await fs.promises.readdir(executionRoot, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(".hankweave.backup-")) {
          // Backup checkpoints are at .hankweave.backup-{timestamp}/checkpoints/.git
          const backupCheckpointPath = path.join(executionRoot, entry.name, "checkpoints");
          const legacyGitDir = path.join(backupCheckpointPath, ".git");
          const newGitDir = path.join(backupCheckpointPath, CHECKPOINT_GIT_DIR);

          if (fs.existsSync(legacyGitDir) && !fs.existsSync(newGitDir)) {
            this.logger.log(`Migrating backup directory: ${entry.name}/checkpoints/.git`);
            try {
              await renameWithRetry(legacyGitDir, newGitDir, {
                logger: this.logger,
              });
              successCount++;
            } catch (error) {
              // Non-fatal for backups - just log and continue
              this.logger.log(
                `Warning: Could not migrate ${entry.name}/checkpoints/.git: ${error}`,
                "error", // Logger only supports "info" | "error" | "debug", using "error" for warnings
              );
              failCount++;
            }
          }
        }
      }

      // Log summary if any backups were processed
      if (successCount > 0 || failCount > 0) {
        this.logger.log(
          `Backup migration complete: ${successCount} succeeded, ${failCount} failed`,
          failCount > 0 ? "error" : "info", // Logger only supports "info" | "error" | "debug"
        );
      }
    } catch (error) {
      // If we can't read the execution directory, just skip backup migration
      this.logger.log(`Could not scan for backup directories: ${error}`, "debug");
    }
  }

  /**
   * Initialize the shadow git repository
   * @returns The initial commit SHA (either from new repo creation or existing repo HEAD)
   */
  async initialize(): Promise<string | undefined> {
    // Create checkpoint directory
    await fs.promises.mkdir(this.checkpointPath, { recursive: true });

    // Migration: rename legacy .git to .hankweavecheckpoints
    const legacyGitDir = path.join(this.checkpointPath, ".git");
    const newGitDir = path.join(this.checkpointPath, CHECKPOINT_GIT_DIR);
    let didMigration = false;

    if (fs.existsSync(legacyGitDir)) {
      if (!fs.existsSync(newGitDir)) {
        // Normal migration: legacy exists, new doesn't
        this.logger.log("Migrating legacy .git directory to .hankweavecheckpoints...");
        try {
          await renameWithRetry(legacyGitDir, newGitDir, {
            logger: this.logger,
          });
          this.logger.log("Successfully migrated checkpoint directory to .hankweavecheckpoints");
          didMigration = true;
        } catch (error) {
          this.logger.log(
            `Failed to migrate checkpoint directory: ${error}. ` +
              `To fix manually, rename '${legacyGitDir}' to '${newGitDir}'.`,
            "error",
          );
          throw new Error(`Critical error during checkpoint migration: ${error}`);
        }
      } else {
        // Edge case: both exist - quarantine the legacy .git
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const quarantinePath = path.join(
          this.checkpointPath,
          `.hankweavecheckpoints-quarantine-${timestamp}`,
        );
        this.logger.log(
          `Warning: Both .git and .hankweavecheckpoints exist in checkpoints directory. ` +
            `Quarantining .git to ${path.basename(quarantinePath)}`,
          "error", // Logger only supports "info" | "error" | "debug", using "error" for warnings
        );
        try {
          await renameWithRetry(legacyGitDir, quarantinePath, {
            logger: this.logger,
          });
          didMigration = true; // Also consider quarantine as migration for backup scanning
        } catch (error) {
          this.logger.log(
            `Could not quarantine legacy .git: ${error}. ` +
              `Git submodule detection may still occur. ` +
              `To fix manually, delete or rename '${legacyGitDir}'.`,
            "error", // Logger only supports "info" | "error" | "debug", using "error" for warnings
          );
        }
      }
    }

    // Conditionally migrate backup directories (only if main checkpoint needed migration)
    if (didMigration) {
      await this.migrateBackupDirectories();
    }

    // Check if repository already exists (using new name)
    const gitDir = path.join(this.checkpointPath, CHECKPOINT_GIT_DIR);
    const repoExists = fs.existsSync(gitDir);

    if (repoExists) {
      // Repository exists - just set up git instance
      // Work tree is agentRootPath where agent files live
      this.git = simpleGit(this.agentRootPath, {
        // Disable parallel processes to avoid lock contention
        maxConcurrentProcesses: 1,
        config: [
          `core.worktree=${this.agentRootPath}`,
          `core.gitdir=${path.join(this.checkpointPath, CHECKPOINT_GIT_DIR)}`,
        ],
      }).env({
        GIT_DIR: path.join(this.checkpointPath, CHECKPOINT_GIT_DIR),
        GIT_WORK_TREE: this.agentRootPath,
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
  name = Hankweave Runtime
  email = froggie@southbridge.ai
[commit]
  gpgsign = false
`;
    await fs.promises.writeFile(gitConfigPath, gitConfigContent);

    // Initialize git with proper environment
    // Work tree is agentRootPath where agent files live
    this.git = simpleGit(this.agentRootPath, {
      // Disable parallel processes to avoid lock contention
      maxConcurrentProcesses: 1,
      config: [
        `core.worktree=${this.agentRootPath}`,
        `core.gitdir=${path.join(this.checkpointPath, CHECKPOINT_GIT_DIR)}`,
      ],
    }).env({
      GIT_DIR: path.join(this.checkpointPath, CHECKPOINT_GIT_DIR),
      GIT_WORK_TREE: this.agentRootPath,
      HOME: this.checkpointPath,
      XDG_CONFIG_HOME: this.checkpointPath,
    });

    // Initialize repository
    await this.git.init(false, { "--initial-branch": "main" });
    await this.git.addConfig("user.name", "Hankweave Runtime");
    await this.git.addConfig("user.email", "froggie@southbridge.ai");
    await this.git.addConfig("commit.gpgsign", "false");

    // Add .gitignore to exclude rigArchive/ from checkpoints (archives are tracked via manifest, not git)
    const gitignorePath = path.join(this.executionPath, ".gitignore");
    const rigArchiveIgnore = "# Hankweave archive directory - not checkpointed\nrigArchive/\n";

    if (fs.existsSync(gitignorePath)) {
      // Append if not already present
      const existing = await fs.promises.readFile(gitignorePath, "utf-8");
      if (!existing.includes("rigArchive/")) {
        await fs.promises.appendFile(gitignorePath, `\n${rigArchiveIgnore}`);
      }
    } else {
      await fs.promises.writeFile(gitignorePath, rigArchiveIgnore);
    }

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
  private async getCheckpointedFiles(): Promise<string[]> {
    if (this.trackedPatterns.size === 0) {
      return [];
    }

    const patterns = Array.from(this.trackedPatterns);
    // Use the unified file resolver to get files respecting gitignore
    // Search in agentRootPath where agent files live (the git work tree)
    const files = await fileResolver.resolveFiles(this.agentRootPath, patterns);
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
      const files = await this.getCheckpointedFiles();
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
   * Create a new branch from a specific SHA and switch to it.
   * This preserves the old branch's history (unlike git reset --hard).
   * @param branchName Name for the new branch
   * @param sha The commit SHA to start the branch from
   */
  async createBranchFromSha(branchName: string, sha: string): Promise<void> {
    if (!this.git) {
      throw new Error("Git repository not initialized");
    }

    // Verify the SHA exists (search all branches)
    const allShas = await this.getAllCheckpointShas();
    const fullSha = [...allShas].find((s) => s.startsWith(sha));

    if (!fullSha) {
      throw new Error(`Checkpoint ${sha} not found in repository`);
    }

    try {
      const branches = await this.git.branch();

      // If branch already exists, delete it first (it will be recreated)
      if (branches.all.includes(branchName)) {
        // Switch to a safe branch first if we're on the branch we want to delete
        if (branches.current === branchName) {
          await this.git.checkout(fullSha); // Detached HEAD
        }
        await this.git.branch(["-D", branchName]);
      }

      // Create new branch from the target SHA and switch to it
      await this.git.checkout(["-b", branchName, fullSha]);
      this.logger.log(`Created branch ${branchName} from ${sha.substring(0, 7)}`);
    } catch (error) {
      this.logger.log(`Failed to create branch from SHA: ${error}`, "error");
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
   * Check if a specific commit SHA exists in the repository
   * @param sha Full or partial SHA to check
   * @returns true if the commit exists, false otherwise
   */
  async commitExists(sha: string): Promise<boolean> {
    if (!this.git) {
      return false;
    }

    try {
      // Use cat-file to check if the commit exists
      const result = await this.git.raw(["cat-file", "-t", sha]);
      return result.trim() === "commit";
    } catch {
      // If cat-file fails, the commit doesn't exist
      return false;
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
   * Reset to a specific checkpoint.
   *
   * IMPORTANT: This uses `git checkout` to a detached HEAD state instead of
   * `git reset --hard`. This preserves the old branch's history so you can
   * still access old checkpoints from previous timelines.
   */
  async resetToCheckpoint(sha: string): Promise<void> {
    if (!this.git) {
      throw new Error("Git repository not initialized");
    }

    // Verify SHA exists - search ALL branches, not just current
    try {
      const allShas = await this.getAllCheckpointShas();
      const fullSha = [...allShas].find((s) => s.startsWith(sha));

      if (!fullSha) {
        throw new Error(`Checkpoint ${sha} not found in repository`);
      }

      // Use checkout with --force to go to the target SHA in detached HEAD mode
      // This preserves the old branch's commits (unlike git reset --hard)
      await this.git.checkout(["--force", fullSha]);
      this.logger.log(`Checked out checkpoint ${sha.substring(0, 7)} (detached HEAD)`);
    } catch (error) {
      this.logger.log(`Checkout to checkpoint failed: ${error}`, "error");
      throw new Error(
        `Failed to reset to checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
