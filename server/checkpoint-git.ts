import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { ExecutionLayout } from "./execution-layout.js";
import { fileResolver } from "./file-resolver.js";
import { type Logger, renameWithRetry } from "./utils.js";

/**
 * A fresh repository is built under this prefix (beside its final name) and
 * renamed into place only after its first commit exists, so a kill during the
 * build can never leave a folder that passes the "already set up" check.
 * The pid and timestamp in the name only keep it unique; exactly one
 * Hankweave owns an execution directory at a time (start() refuses to boot
 * beside a live sibling before checkpoint init), so any folder under this
 * prefix found at boot belongs to a builder that is gone.
 */
const CHECKPOINT_TMP_PREFIX = `${ExecutionLayout.CHECKPOINT_GIT}.tmp-`;

/** Thrown when a checkpoint reference names no commit in the repository. */
export class CheckpointNotFoundError extends Error {
  readonly sha: string;
  constructor(sha: string) {
    super(`Checkpoint ${sha} not found in repository`);
    this.name = "CheckpointNotFoundError";
    this.sha = sha;
  }
}

/** Thrown when git itself failed — the checkpoint storage could not be read or written. */
export class CheckpointStorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CheckpointStorageError";
  }
}

/** Thrown when the checkpoint repository on disk could not be brought to a usable state. */
export class CheckpointRepoError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CheckpointRepoError";
  }
}

/** Thrown when no working `git` can be run. Checkpoints are not optional, so neither is git. */
export class GitUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      "git is required (checkpoints, rollback, and crash recovery are built on it) but " +
        "`git --version` could not be run. Install git and make sure it is on PATH.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "GitUnavailableError";
  }
}

/**
 * Prove `git --version` runs before anything is built on it. The CLI runs
 * this before the execution directory is created, wiped, or copied into, and
 * the runtime runs it again first thing in boot, so a machine without git
 * fails loudly with nothing touched instead of running without save points.
 */
export async function assertGitAvailable(): Promise<void> {
  const result = await new Promise<{ ok: boolean; cause?: unknown }>((resolve) => {
    const proc = spawn("git", ["--version"], { stdio: "ignore" });
    proc.on("error", (error) => resolve({ ok: false, cause: error }));
    proc.on("exit", (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, cause: `git --version exited ${code}` }),
    );
  });
  if (!result.ok) throw new GitUnavailableError(result.cause);
}

/**
 * Git operations for the checkpoint system.
 * Handles the shadow git repository in .hankweave/checkpoints.
 */
/** Where the pre-recovery work tree was saved. */
export interface RecoverySnapshot {
  /** Branch holding the work tree as it was before recovery changed it: recovery/<timestamp>. */
  recoveryBranch: string;
  /** The commit that recoveryBranch points at. */
  recoveryCommit: string;
}

/** What a restore holds before it is allowed to change the work tree. */
export interface RestorePreconditions extends RecoverySnapshot {
  /** Full SHA of the checkpoint being restored to, confirmed to exist in git. */
  checkpoint: string;
}

export class CheckpointGit {
  private layout: ExecutionLayout;
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
    this.layout = new ExecutionLayout(executionPath);
    this.executionPath = executionPath;
    this.agentRootPath = agentRootPath;
    this.checkpointPath = this.layout.checkpointsPath;
    this.logger = logger;
  }

  /**
   * Migrate backup directories from legacy .git to .hankweavecheckpoints.
   * Called conditionally when the main checkpoint needed migration.
   */
  private async migrateBackupDirectories(): Promise<void> {
    // Skip if we're somehow running inside a backup directory (shouldn't happen, but be defensive)
    if (ExecutionLayout.isInsideStateBackup(this.executionPath)) {
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
        if (entry.isDirectory() && ExecutionLayout.isStateBackupDir(entry.name)) {
          // Backup checkpoints are at .hankweave.backup-{timestamp}/checkpoints/.git
          const backup = ExecutionLayout.forBackedUpStateDir(path.join(executionRoot, entry.name));
          const legacyGitDir = path.join(backup.checkpointsPath, ".git");
          const newGitDir = backup.checkpointGitDir;

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
   * Initialize the shadow git repository.
   *
   * The rule is binary: a folder whose HEAD resolves to a commit is reused;
   * anything else on disk (a build killed before its first commit, lost refs,
   * a truncated HEAD) is removed and rebuilt from scratch. Rebuilding is
   * always safe because a fresh repository is built atomically beside its
   * final name and renamed in only once its first commit exists.
   *
   * @returns HEAD of the repository in use, a real commit SHA — or throws
   */
  async initialize(): Promise<string> {
    // Create checkpoint directory
    await fs.promises.mkdir(this.checkpointPath, { recursive: true });

    // Migration: rename legacy .git to .hankweavecheckpoints
    const legacyGitDir = path.join(this.checkpointPath, ".git");
    const newGitDir = this.layout.checkpointGitDir;
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
        const quarantinePath = this.layout.quarantineGitDir(timestamp);
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

    const gitDir = this.layout.checkpointGitDir;

    // Leftovers of a builder that died mid-build (see CHECKPOINT_TMP_PREFIX).
    await this.sweepStaleTempDirs();

    if (fs.existsSync(gitDir)) {
      const head = await this.runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], gitDir);
      const sha = head.code === 0 ? head.stdout.trim() : "";
      if (sha) {
        this.git = this.buildGit(gitDir);
        // A kill during any ordinary checkpoint (index reset, add, commit,
        // checkout, branch update) can leave a git lock behind. HEAD still
        // resolves, so the repo is fine — but the first recovery checkout
        // would fail on the lock, every boot. We own this folder now (the
        // live-sibling check ran first), so dead locks are safe to remove.
        await this.removeStaleGitLocks(gitDir);
        this.logger.log(`Using existing shadow git repository with HEAD: ${sha}`);
        return sha;
      }

      if (head.code !== 1) {
        // git could not READ the repository. That is storage trouble, not an
        // unborn repo: stop with nothing changed (the contract requireCheckpoint
        // and getAllCheckpoints already use), and let a person look.
        throw new CheckpointStorageError(
          `Checkpoint repository at ${gitDir} could not be read ` +
            `(rev-parse exited ${head.code}: ${head.stderr.trim()}); nothing has been changed`,
        );
      }

      // exit 1: HEAD names no commit — a build killed before its first commit,
      // or refs that went missing. Nothing to preserve, so start over. Every
      // checkpoint SHA in state.json now fails to resolve, which is the truth,
      // and recovery handles that.
      this.logger.log(
        `Checkpoint repository at ${gitDir} has no resolvable HEAD; removing it and building a fresh one`,
        "error",
      );
      await fs.promises.rm(gitDir, { recursive: true, force: true });
    }

    return this.buildFreshRepo(gitDir);
  }

  /** A simple-git instance bound to the given git dir, with the work tree at agentRootPath. */
  private buildGit(gitDir: string): SimpleGit {
    return simpleGit(this.agentRootPath, {
      // Disable parallel processes to avoid lock contention
      maxConcurrentProcesses: 1,
      config: [`core.worktree=${this.agentRootPath}`, `core.gitdir=${gitDir}`],
    }).env(this.gitEnv(gitDir));
  }

  private gitEnv(gitDir: string): Record<string, string> {
    return {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: this.agentRootPath,
      HOME: this.checkpointPath,
      XDG_CONFIG_HOME: this.checkpointPath,
    };
  }

  /**
   * Run git directly and report the exit code. simple-git folds every failure
   * into one error type; the resolver and the repo classifier need to tell
   * "git said no" (exit 1) apart from "git could not run" (128 and friends).
   */
  private runGit(
    args: string[],
    gitDir: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.runGitWithEnv(args, gitDir, {});
  }

  private runGitWithEnv(
    args: string[],
    gitDir: string,
    extraEnv: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", args, {
        cwd: this.agentRootPath,
        env: { ...process.env, ...this.gitEnv(gitDir), ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      proc.on("error", reject);
      proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  private currentGitDir(): string {
    return this.layout.checkpointGitDir;
  }

  /**
   * Build a brand-new repository atomically: everything happens in a sibling
   * temp folder, which is renamed to its final name only after the first
   * commit exists. A kill at any point before the rename leaves a temp folder
   * that the next boot sweeps, never a half-built repo at the final path.
   */
  private async buildFreshRepo(gitDir: string): Promise<string> {
    // Create git config to isolate from user preferences
    const gitConfigPath = path.join(this.checkpointPath, ".gitconfig");
    const gitConfigContent = `[user]
  name = Hankweave Runtime
  email = froggie@southbridge.ai
[commit]
  gpgsign = false
`;
    await fs.promises.writeFile(gitConfigPath, gitConfigContent);

    const tmpDir = `${path.join(this.checkpointPath, CHECKPOINT_TMP_PREFIX)}${process.pid}-${Date.now()}`;
    const tmpGit = this.buildGit(tmpDir);

    let initialSha: string | undefined;
    try {
      // Initialize repository (git creates GIT_DIR)
      await tmpGit.init(false, { "--initial-branch": "main" });
      await tmpGit.addConfig("user.name", "Hankweave Runtime");
      await tmpGit.addConfig("user.email", "froggie@southbridge.ai");
      await tmpGit.addConfig("commit.gpgsign", "false");

      // Add .gitignore to exclude rigArchive/ from checkpoints (archives are tracked via manifest, not git)
      const gitignorePath = path.join(this.executionPath, ".gitignore");
      const rigArchiveIgnore = `# Hankweave archive directory - not checkpointed\n${ExecutionLayout.RIG_ARCHIVE_IGNORE_LINE}\n`;

      if (fs.existsSync(gitignorePath)) {
        // Append if not already present
        const existing = await fs.promises.readFile(gitignorePath, "utf-8");
        if (!existing.includes(ExecutionLayout.RIG_ARCHIVE_IGNORE_LINE)) {
          await fs.promises.appendFile(gitignorePath, `\n${rigArchiveIgnore}`);
        }
      } else {
        await fs.promises.writeFile(gitignorePath, rigArchiveIgnore);
      }

      // Initial empty commit (don't add .gitignore to avoid conflicts with user's project)
      const result = await tmpGit.commit("Initial checkpoint setup", {
        "--allow-empty": null,
      });
      initialSha = result.commit || undefined;
      if (!initialSha) {
        throw new CheckpointRepoError("Initial checkpoint commit produced no SHA");
      }

      await renameWithRetry(tmpDir, gitDir, { logger: this.logger });
    } catch (error) {
      // Never leave a half-built folder behind for the next boot to trust.
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      this.git = null;
      if (error instanceof CheckpointRepoError) throw error;
      throw new CheckpointRepoError(
        `Failed to build checkpoint repository at ${gitDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
    }

    this.git = this.buildGit(gitDir);
    this.logger.log(`Shadow git repository initialized with initial commit: ${initialSha}`);
    return initialSha;
  }

  /**
   * Remove git lock files left by a process that died mid-operation.
   *
   * Why this exists
   * ---------------
   * Git writes any file it cares about by creating `<file>.lock` beside it,
   * filling that, and renaming it over the original. The `.lock` doubles as
   * a mutual-exclusion flag: if it already exists, git assumes another git
   * process is mid-write and refuses ("Another git process seems to be
   * running in this repository"). Git records no pid in the lock and never
   * removes a lock it did not create. A normal exit, a caught signal, even
   * Ctrl-C all let git delete its lock on the way out; SIGKILL skips every
   * handler, so the file stays. The crash supervisor in superbench's crash
   * mode kills with SIGKILL at random moments, and every ordinary checkpoint
   * (`commit()`: branch checkout, index reset, `add` batches, commit,
   * checkout back) holds `index.lock` for its whole duration and locks HEAD
   * and a ref under refs/heads/ around the commit and checkouts.
   *
   * Without this cleanup one kill anywhere inside a checkpoint is permanent:
   * the next boot reuses the folder (HEAD resolves, so the repo is healthy),
   * recovery runs `checkout --force <sha>`, git refuses on the stale lock,
   * that is a CheckpointStorageError, so start() stops — and every later
   * relaunch does exactly the same thing. Found in codex review round 5 by
   * a kill-point walk; see intermediates/66-crash-safe-checkpoints/design.md.
   *
   * Why deleting is safe here
   * -------------------------
   * Deleting a lock is only wrong if a live process holds it. Exactly one
   * Hankweave owns an execution directory at a time: start() runs
   * assertNoLiveSiblingLock() before checkpoint init, so any lock found on
   * the reuse path was left by a process that is dead, or that is alive but
   * whose heartbeat lapsed more than two minutes ago. The lock protocol
   * treats the second case as crashed (the full lock check unlinks the
   * runtime lock and the predecessor fences itself on its next heartbeat
   * tick), so this matches the rest of the system; the residual window is a
   * predecessor stalled mid-git-command for two minutes, which the protocol
   * already accepts. That is why this is called only from initialize(),
   * after that check, and never during a run.
   *
   * What other systems do (for the record)
   * --------------------------------------
   * - git itself: core lock files have no stale detection at all. Only
   *   `gc.pid` gets one (builtin/gc.c): pid + hostname in the file, treated
   *   as live only if under 12 hours old and `kill(pid, 0)` succeeds on the
   *   same host. gc is the one command git runs unattended.
   * - GitLab's Gitaly (server, owns its repos): housekeeping deletes a fixed
   *   allowlist of locks by age — config.lock, HEAD.lock, info/attributes.lock,
   *   alternates.lock, commit-graph and multi-pack-index locks after 15 min;
   *   packed-refs.lock and every ref lock under refs/ after 1 hour. Its comment:
   *   "we certainly don't just scan the repo for `*.lock` files. Instead, we
   *   only remove a known set of lockfiles which have caused problems in the
   *   past." (internal/git/housekeeping/clean_stale_data.go). Bare repos, so
   *   no index.lock there.
   * - VS Code's git extension and GitHub Desktop (share the repo with a
   *   human): never delete. VS Code retries up to 10 times with quadratic
   *   backoff on RepositoryIsLocked; Desktop shows the error, and for a
   *   stale config.lock offers a dialog to delete it.
   * - JGit, libgit2, gitoxide (libraries): refuse and leave it to the caller.
   *   gix-lock's docs call leaked locks "permanently locked unless there is
   *   user-intervention."
   *
   * The pattern: tools that share a repo with people refuse or retry; daemons
   * that own the repo delete, gated by age, an allowlist, or pid liveness. We
   * are the second kind, and the sibling check gives a stronger guarantee than
   * a timestamp, so no grace period is needed. Our list is Gitaly's allowlist
   * plus index.lock and the HEAD reflog lock, which a work tree adds.
   *
   * Covers the index, HEAD, config, packed-refs, the HEAD reflog, and any
   * ref lock under refs/ (a kill inside `update-ref` or a branch switch).
   */
  private async removeStaleGitLocks(gitDir: string): Promise<void> {
    const fixed = [
      "index.lock",
      "HEAD.lock",
      "config.lock",
      "packed-refs.lock",
      path.join("logs", "HEAD.lock"),
    ].map((rel) => path.join(gitDir, rel));
    const refLocks: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".lock")) refLocks.push(full);
      }
    };
    await walk(path.join(gitDir, "refs"));
    for (const lock of [...fixed, ...refLocks]) {
      if (!fs.existsSync(lock)) continue;
      this.logger.log(`Removing stale git lock ${path.relative(gitDir, lock)} (dead owner)`);
      await fs.promises.rm(lock, { force: true });
    }
  }

  /**
   * Remove temp build folders left by a builder that died before its rename.
   * Unconditional: this process is the only Hankweave in the execution
   * directory (see CHECKPOINT_TMP_PREFIX), so nothing under the prefix is
   * live.
   */
  private async sweepStaleTempDirs(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.checkpointPath);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(CHECKPOINT_TMP_PREFIX)) continue;
      this.logger.log(`Removing stale checkpoint build folder ${name}`);
      await fs.promises.rm(path.join(this.checkpointPath, name), { recursive: true, force: true });
    }
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

      // simple-git runs commit with core.abbrev=40, which truncates the id of
      // a SHA-256 repository. The stored reference must match what `log`
      // enumerates (%H, full length), so expand the id git printed. Expanding
      // the printed id — not reading HEAD — cannot pick up a concurrent
      // checkout's commit by mistake.
      commitSha = result.commit ? await this.expandCommitId(result.commit) : null;
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

    const fullSha = await this.requireCheckpoint(sha);

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
   * Resolve a checkpoint reference to the full SHA of a commit git holds, via
   * `rev-parse --verify`. Throws CheckpointNotFoundError when git has no such
   * commit (the reference names nothing — a state bug that recovery may
   * degrade around) or CheckpointStorageError when git itself could not
   * answer (recovery must stop).
   */
  async requireCheckpoint(sha: string): Promise<string> {
    if (!this.git) {
      throw new CheckpointStorageError("Git repository not initialized");
    }
    let verify: { code: number; stdout: string; stderr: string };
    try {
      verify = await this.runGit(
        ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
        this.currentGitDir(),
      );
    } catch (error) {
      throw new CheckpointStorageError(
        `Checkpoint storage could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
    }
    const fullSha = verify.stdout.trim();
    if (verify.code === 0 && fullSha) return fullSha;
    if (verify.code === 1) throw new CheckpointNotFoundError(sha);
    throw new CheckpointStorageError(
      `Checkpoint storage could not be read: rev-parse exited ${verify.code}: ${verify.stderr.trim()}`,
    );
  }

  /**
   * Record the whole work tree on a fresh `recovery/<timestamp>` branch. HEAD
   * and the current branch are untouched. Throws CheckpointStorageError when
   * git cannot record it.
   */
  async snapshotForRecovery(reason: string): Promise<RecoverySnapshot> {
    const recoveryBranch = `recovery/${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const recoveryCommit = await this.snapshotWorkTree(
      recoveryBranch,
      `Recovery snapshot before ${reason}`,
    );
    return { recoveryBranch, recoveryCommit };
  }

  /**
   * Everything a restore must do before it touches the work tree, in the
   * only safe order: confirm the target exists (CheckpointNotFoundError
   * otherwise — nothing has changed, callers may degrade), then record the
   * current work tree on a recovery branch (CheckpointStorageError if that
   * fails — nothing has changed, callers must stop). Holding the result is
   * the caller's proof that both happened.
   */
  async confirmAndSnapshot(sha: string, reason: string): Promise<RestorePreconditions> {
    const checkpoint = await this.requireCheckpoint(sha);
    const snapshot = await this.snapshotForRecovery(reason);
    return { checkpoint, ...snapshot };
  }

  /**
   * Expand an id git printed (simple-git runs commit with core.abbrev=40,
   * which truncates SHA-256 ids) to the repository's full object id. A commit
   * that was just written but cannot be expanded is storage trouble:
   * persisting the abbreviation would make the checkpoint invisible to
   * recovery, which matches full ids exactly.
   */
  private async expandCommitId(id: string): Promise<string> {
    const r = await this.runGit(
      ["rev-parse", "--verify", "--quiet", `${id}^{commit}`],
      this.currentGitDir(),
    );
    const full = r.stdout.trim();
    if (r.code === 0 && full) return full;
    throw new CheckpointStorageError(
      `Checkpoint ${id} was written but could not be resolved to a full id: ${
        r.stderr.trim() || `rev-parse exited ${r.code}`
      }`,
    );
  }

  /** The full SHA HEAD points at, or null if it cannot be resolved. */
  async getHeadSha(): Promise<string | null> {
    if (!this.git) return null;
    const r = await this.runGit(
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      this.currentGitDir(),
    );
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  /**
   * The set of commit SHAs reachable from `fromSha` but not from (or equal to)
   * `targetSha` — i.e. `git rev-list <target>..<from>`.
   *
   * Rollback uses this to decide which archive-manifest entries were created
   * strictly after the rollback target on the abandoned line: entries at or
   * before the target, and entries from unrelated timelines, are not in the
   * set and stay archived.
   *
   * @throws CheckpointStorageError when git cannot answer or the repository
   *         is not initialized (callers preflight both endpoints first)
   */
  async shasBetween(targetSha: string, fromSha: string): Promise<Set<string>> {
    if (!this.git) {
      throw new CheckpointStorageError("Git repository not initialized");
    }
    const r = await this.runGit(["rev-list", `${targetSha}..${fromSha}`], this.currentGitDir());
    if (r.code !== 0) {
      throw new CheckpointStorageError(
        `Could not list checkpoints between ${targetSha.substring(0, 7)} and ` +
          `${fromSha.substring(0, 7)}: ${r.stderr.trim() || `rev-list exited ${r.code}`}`,
      );
    }
    return new Set(
      r.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  }

  /**
   * Record the whole work tree (tracked and untracked, honoring .gitignore) as
   * one commit on `branchName`, WITHOUT touching HEAD, the index, or a single
   * file in the work tree. Recovery calls this before any step that could
   * change or discard files, so nothing is ever lost irrecoverably.
   *
   * Implemented with plumbing (a private index, write-tree, commit-tree,
   * update-ref) precisely because a checkout-based snapshot would move the
   * work tree.
   *
   * The private index is seeded from HEAD before staging. Starting it empty
   * would make `git add -A` treat a file that HEAD tracks but `.gitignore`
   * now matches as ignored-and-untracked, so its current contents would be
   * left out of the snapshot — the one thing a safety net must not do.
   * `read_only_data_source` is excluded the way every normal checkpoint
   * excludes it (file-resolver): in copy mode it is the whole input dataset.
   *
   * @returns the snapshot commit SHA
   * @throws CheckpointStorageError when git cannot record the snapshot
   */
  async snapshotWorkTree(branchName: string, message: string): Promise<string> {
    if (!this.git) {
      throw new CheckpointStorageError("Git repository not initialized");
    }
    const gitDir = this.currentGitDir();
    const indexFile = path.join(gitDir, `snapshot-index-${process.pid}-${Date.now()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    const run = async (args: string[]) => {
      const r = await this.runGitWithEnv(args, gitDir, env);
      if (r.code !== 0) {
        throw new CheckpointStorageError(
          `git ${args[0]} exited ${r.code} while snapshotting the work tree: ${r.stderr.trim()}`,
        );
      }
      return r.stdout.trim();
    };
    try {
      const parent = await this.getHeadSha();
      if (parent) {
        await run(["read-tree", parent]);
        // A pathspec exclusion only stops new entries; drop any the parent
        // already tracks (e.g. HEAD is itself an older snapshot).
        await run([
          "rm",
          "-r",
          "-q",
          "--cached",
          "--ignore-unmatch",
          "--",
          ExecutionLayout.DATA_SOURCE,
        ]);
      }
      await run(["add", "-A", "--", ".", ExecutionLayout.DATA_SOURCE_PATHSPEC_EXCLUDE]);
      const tree = await run(["write-tree"]);
      const commitArgs = ["commit-tree", tree, "-m", message];
      if (parent) commitArgs.push("-p", parent);
      const sha = await run(commitArgs);
      await run(["update-ref", `refs/heads/${branchName}`, sha]);
      this.logger.log(`Snapshotted work tree to ${branchName} (${sha.substring(0, 7)})`);
      return sha;
    } finally {
      await fs.promises.rm(indexFile, { force: true }).catch(() => {});
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
      // Same contract as getAllCheckpoints(): "could not read" is never
      // reported as "no checkpoints".
      this.logger.log(`Failed to get checkpoint SHAs: ${error}`, "error");
      throw new CheckpointStorageError(
        `Could not enumerate checkpoint SHAs: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
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
          // A listed branch whose log cannot be read is storage trouble, not
          // an empty branch (git does not list unborn branches). A partial
          // answer would make recovery treat real checkpoints as missing.
          throw new CheckpointStorageError(
            `Could not read checkpoint log for branch ${branch}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error,
          );
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
      // Never answer "no checkpoints" when the truth is "could not read":
      // recovery would silently fall through to a fresh run.
      this.logger.log(`Failed to get checkpoints: ${error}`, "error");
      if (error instanceof CheckpointStorageError) throw error;
      throw new CheckpointStorageError(
        `Could not enumerate checkpoints: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
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

    // Resolve to a full SHA first so the checkout only ever sees a commit git
    // confirmed. The typed errors let recovery tell "no such checkpoint" from
    // "git is broken".
    const fullSha = await this.requireCheckpoint(sha);
    try {
      // Use checkout with --force to go to the target SHA in detached HEAD mode
      // This preserves the old branch's commits (unlike git reset --hard)
      await this.git.checkout(["--force", fullSha]);
      this.logger.log(`Checked out checkpoint ${fullSha.substring(0, 7)} (detached HEAD)`);
    } catch (error) {
      this.logger.log(`Checkout to checkpoint failed: ${error}`, "error");
      throw new CheckpointStorageError(
        `Failed to reset to checkpoint ${fullSha.substring(0, 7)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
    }
  }
}
