/** Git implementation of workspace file access and snapshot storage.
 * Owns file eligibility, pattern matching, ignore rules and snapshot contents.
 * WorkspaceFiles and CheckpointService use only the storage interface.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { ExecutionLayout } from "../execution-layout.js";
import {
  containsGitComponent,
  gitEnv as isolatedGitEnv,
  parseNulSeparated,
} from "../git-support.js";
import { type Logger, renameWithRetry } from "../utils.js";
import {
  CheckpointHistoryConflictError,
  CheckpointNotFoundError,
  CheckpointStorageError,
} from "./checkpoints.js";
import { lstatIfPresent, workspaceMutationPath } from "./paths.js";
import { createWorkspaceMatcher } from "./patterns.js";
import type {
  StoredFile,
  StoredFileEntry,
  StoredRecoverySnapshot,
  StoredSnapshot,
  WorkspaceStorage,
} from "./storage.js";

export { CheckpointNotFoundError, CheckpointStorageError } from "./checkpoints.js";

/** Where the mechanism lives and what it records. */
export interface GitWorkspaceStorageOptions {
  /** The directory that holds the shadow git dir (.hankweavecheckpoints)
   * and the isolated HOME/XDG config the mechanism gives git. */
  checkpointDir: string;
  /** The work tree the repository records. */
  workTree: string;
  /**
   * Legacy migration only: the directory whose `.hankweave.backup-*`
   * children may still carry a pre-rename `checkpoints/.git`, and whose
   * .gitignore may contain our obsolete generated stanza. Omit to skip
   * legacy cleanup.
   */
  legacyBackupScanRoot?: string;
}

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

/** Thrown when the checkpoint repository on disk could not be brought to a usable state. */
class CheckpointRepoError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CheckpointRepoError";
  }
}

/** One git run, fail-closed: only `code` and `stdout` come back, because
 * anything on stderr or an unexpected exit code has already rejected. */
interface GitResult {
  code: number;
  stdout: Buffer;
}

/** Internal Git candidate classes and staging instructions. */
type GitFileKind = "visible" | "recorded" | "unrecorded" | "missing";
interface SnapshotDelta {
  addPaths: string[];
  deletePaths: string[];
}

/**
 * Is `rel` an extant REGULAR file reached through REAL (non-symlink)
 * directories? The single visibility primitive behind both the listing
 * filter and the event-time check — it drops symlinks (git would list
 * them), embedded-repo `dir/` entries, and the load-bearing case: any path
 * whose ANCESTOR is now a symlink. A tracked `safe/data.csv` whose parent
 * was swapped for `safe -> read_only_data_source` still lstats as a regular
 * file at the final component, but resolves INSIDE a protected tree;
 * admitting it would let the archive move the protected target. `isRealDir`
 * may be a memo shared across a whole listing pass, or a fresh one for a
 * single check.
 */
async function reachableRegularFile(
  workTree: string,
  rel: string,
  isRealDir: (dirRel: string) => Promise<boolean>,
): Promise<StoredFileEntry | null> {
  if (rel === "" || rel.endsWith("/")) return null;
  const parts = rel.split("/");
  parts.pop();
  let cur = "";
  for (const part of parts) {
    cur = cur === "" ? part : `${cur}/${part}`;
    if (!(await isRealDir(cur))) return null;
  }
  try {
    const lst = await fs.promises.lstat(path.join(workTree, rel));
    return lst.isFile() ? { path: rel, lastModified: lst.mtime } : null;
  } catch {
    return null;
  }
}

/** A per-call directory-realness memo over `workTree`. */
function realDirMemo(workTree: string): (dirRel: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (dirRel: string): Promise<boolean> => {
    let cached = cache.get(dirRel);
    if (cached === undefined) {
      cached = fs.promises
        .lstat(path.join(workTree, dirRel))
        .then((lst) => lst.isDirectory())
        .catch(() => false);
      cache.set(dirRel, cached);
    }
    return cached;
  };
}

async function regularFiles(workTree: string, rels: string[]): Promise<StoredFileEntry[]> {
  const isRealDir = realDirMemo(workTree);
  const checked = await Promise.all(
    rels.map((rel) => reachableRegularFile(workTree, rel, isRealDir)),
  );
  return checked.filter((r): r is StoredFileEntry => r !== null);
}

export class GitWorkspaceStorage implements WorkspaceStorage {
  private readonly checkpointDir: string;
  private readonly workTree: string;
  private readonly legacyBackupScanRoot: string | undefined;
  private git: SimpleGit | null = null;
  private mutations: Promise<unknown> = Promise.resolve();

  /** Serialize whole file mutations, not individual Git commands. A failed
   * operation does not poison the queue. Cross-process ownership is external. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutations.then(operation);
    this.mutations = pending.catch(() => {});
    return pending;
  }
  private readonly logger?: Logger;

  constructor(options: GitWorkspaceStorageOptions, logger?: Logger) {
    this.checkpointDir = options.checkpointDir;
    this.workTree = options.workTree;
    this.legacyBackupScanRoot = options.legacyBackupScanRoot;
    this.logger = logger;
  }

  async initialize(): Promise<string> {
    const id = await this.initializeRepository({
      infoExclude: ExecutionLayout.CHECKPOINT_INFO_EXCLUDE,
    });
    await this.removeLegacyExecutionGitignore();
    // HEAD is only Git's restore position. Detach legacy symbolic HEAD so
    // publishing a named history never selects it or advances that position.
    await this.run(["update-ref", "--no-deref", "HEAD", id], [0]);
    return id;
  }

  /**
   * Normalize a tool-supplied path (absolute, or relative to the work tree,
   * possibly "./"-prefixed or with platform separators) to the POSIX
   * work-tree-relative form the lister and matcher speak. Returns null for
   * the empty path, the work tree itself, and any path that escapes the
   * work tree ("../x", an absolute path elsewhere); a leading-dot-dot
   * FILENAME such as "..notes.md" is not an escape.
   */
  private relativePath(candidate: string): string | null {
    if (!candidate) return null;
    const rel = path.relative(this.workTree, path.resolve(this.workTree, candidate));
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return null;
    }
    return rel.split(path.sep).join("/");
  }

  /** Absolute path of a workspace-relative POSIX path. */
  private absolute(relPosix: string): string {
    return path.join(this.workTree, ...relPosix.split("/"));
  }

  /**
   * The workspace's VISIBLE SURFACE (file-tree UI, watched events, archive):
   * storage-visible files minus mandatory exclusions, regular-files-only,
   * sorted. Tracked-then-ignored files do NOT appear (they still checkpoint
   * — see checkpointDelta).
   */
  async listFiles(patterns: readonly string[]): Promise<StoredFileEntry[]> {
    const matcher = createWorkspaceMatcher(patterns);
    if (!matcher.hasPositive) return [];
    const visible = await this.listCandidates("visible");
    const kept = visible.filter(
      (rel) => !ExecutionLayout.isMandatoryExcluded(rel) && matcher.matches(rel),
    );
    return regularFiles(this.workTree, kept.sort());
  }

  /** What one snapshot must stage for `patterns`. */
  private async checkpointDelta(
    patterns: readonly string[],
    env: Record<string, string>,
  ): Promise<SnapshotDelta> {
    const [tracked, untracked, deleted] = await Promise.all([
      this.listCandidates("recorded", env),
      this.listCandidates("unrecorded", env),
      this.listCandidates("missing", env),
    ]);
    const deletePaths = new Set<string>(deleted);
    await Promise.all(
      tracked.map(async (rel) => {
        if (ExecutionLayout.isMandatoryExcluded(rel)) {
          deletePaths.add(rel);
          return;
        }
        if (deletePaths.has(rel)) return;
        try {
          const lst = await fs.promises.lstat(this.absolute(rel));
          if (!lst.isFile()) deletePaths.add(rel);
        } catch {
          // vanished since enumeration; the next delta records it
        }
      }),
    );
    const matcher = createWorkspaceMatcher(patterns);
    const seen = new Set<string>();
    const addCandidates: string[] = [];
    for (const rel of [...tracked, ...untracked]) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (deletePaths.has(rel) || ExecutionLayout.isMandatoryExcluded(rel)) continue;
      if (!matcher.matches(rel)) continue;
      addCandidates.push(rel);
    }
    return {
      addPaths: (await regularFiles(this.workTree, addCandidates)).map((file) => file.path).sort(),
      deletePaths: [...deletePaths].sort(),
    };
  }

  private hasDirectoryAncestors(relPosix: string): boolean {
    const parts = relPosix.split("/");
    parts.pop();
    let cur = "";
    for (const part of parts) {
      cur = cur === "" ? part : `${cur}/${part}`;
      let lst: fs.Stats;
      try {
        lst = fs.lstatSync(this.absolute(cur));
      } catch {
        break; // missing from here down — a prospective path
      }
      if (!lst.isDirectory()) return false;
    }
    return true;
  }

  /**
   * The in-process half of `admits`: mandatory exclusions, the hard `.git`
   * rule, every existing ancestor a real directory (a symlink ancestor
   * resolves the path elsewhere, and git would refuse the check as "beyond
   * a symbolic link"), and an existing final node a regular file. A path
   * that does not exist is judged by the rules alone. Never spawns git, so
   * `readFile` can re-run it per file without paying for a verdict the
   * caller already holds.
   */
  private admitsOnDisk(relPosix: string): boolean {
    if (relPosix === "" || relPosix.endsWith("/")) return false;
    if (ExecutionLayout.isMandatoryExcluded(relPosix) || containsGitComponent(relPosix)) {
      return false;
    }
    if (!this.hasDirectoryAncestors(relPosix)) return false;
    try {
      if (!fs.lstatSync(this.absolute(relPosix)).isFile()) return false;
    } catch {
      // does not exist yet — judged by rules alone
    }
    return true;
  }

  /**
   * Would a regular file at `relPosix` belong to the visible surface? The
   * eligibility checks from listFiles applied to ONE path that need not exist
   * yet: `admitsOnDisk` plus storage's live ignore verdict (one synchronous
   * `git check-ignore`). A path that does not exist is judged by the rules
   * alone — the one difference from the listing, which can only show what
   * is there. Synchronous, so a caller can decide where it cannot yield.
   * Reached through a selection's `admitFile()`, which normalizes the path
   * and applies the patterns first.
   */
  private admits(relPosix: string): boolean {
    return this.admitsOnDisk(relPosix) && !this.isIgnored(relPosix);
  }

  admitFile(candidate: string, patterns: readonly string[]): string | null {
    const rel = this.relativePath(candidate);
    if (rel === null || !createWorkspaceMatcher(patterns).matches(rel) || !this.admits(rel)) {
      return null;
    }
    return rel;
  }

  /**
   * Read a path the caller already listed or admitted. Re-applies the
   * in-process guards (workspace confinement, patterns, `admitsOnDisk`) so
   * a path that vanished or became a symlink since the verdict reads as
   * null, but does NOT re-run the ignore verdict: that would be one git
   * spawn per file at codon start, for a question the listing answered
   * milliseconds earlier with the same rules.
   */
  readFile(candidate: string, patterns: readonly string[]): StoredFile | null {
    const rel = this.relativePath(candidate);
    if (rel === null || !createWorkspaceMatcher(patterns).matches(rel) || !this.admitsOnDisk(rel)) {
      return null;
    }
    const absolute = path.join(this.workTree, rel);
    try {
      const stats = fs.statSync(absolute);
      return { content: fs.readFileSync(absolute, "utf-8"), lastModified: stats.mtime };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async snapshotPaths(id: string): Promise<string[]> {
    const target = await this.resolveSnapshot(id);
    return parseNulSeparated(
      (await this.run(["ls-tree", "-r", "--name-only", "-z", target], [0])).stdout,
    );
  }

  saveSnapshot(request: {
    history: string;
    parent: string;
    message: string;
    patterns: readonly string[];
  }): Promise<string> {
    const policy = [...request.patterns];
    const { history, parent, message } = request;
    return this.mutate(async () => {
      const baseline = await this.resolveSnapshot(parent);
      const previous = await this.historyTip(history);
      if (previous !== null && previous !== baseline) {
        throw new CheckpointHistoryConflictError(history, baseline, previous);
      }
      const saved = await this.recordSnapshot(history, baseline, message, policy, previous);
      return saved.id;
    });
  }

  preserveSnapshot(
    parent: string,
    message: string,
    patterns: readonly string[],
  ): Promise<StoredRecoverySnapshot> {
    const policy = [...patterns];
    return this.mutate(async () => {
      const baseline = await this.resolveSnapshot(parent);
      const history = `recovery/${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      return this.recordSnapshot(history, baseline, message, ["**"], null, policy);
    });
  }

  restoreSnapshot(id: string, checkpointPaths: readonly string[]): Promise<void> {
    const paths = [...checkpointPaths];
    return this.mutate(() => this.restoreSavedSnapshot(id, paths));
  }

  private async restoreSavedSnapshot(
    id: string,
    checkpointPaths: readonly string[],
  ): Promise<void> {
    const target = await this.resolveSnapshot(id);
    const targetPaths = new Set(await this.snapshotPaths(target));
    const removePaths = checkpointPaths.filter((rel) => !targetPaths.has(rel));
    try {
      // Validate the complete removal set before the first mutation. Keep
      // validation and unlink synchronous so our own work cannot interleave.
      const paths = removePaths.map((rel) => {
        const absolute = workspaceMutationPath(this.workTree, rel);
        const stats = lstatIfPresent(absolute);
        if (stats && !stats.isFile()) {
          throw new Error(`Saved checkpoint file is no longer a regular file: ${rel}`);
        }
        return { absolute, present: stats !== null };
      });
      for (const { absolute, present } of paths) {
        if (present) fs.unlinkSync(absolute);
      }
      await this.resetToCheckpoint(target);
    } catch (error) {
      throw new CheckpointStorageError(`Could not restore checkpoint ${target}: ${error}`, error);
    }
  }

  /** List the workspace's files of one git class (POSIX-relative paths,
   * git's own order — callers sort). */
  private async listCandidates(kind: GitFileKind, env?: Record<string, string>): Promise<string[]> {
    switch (kind) {
      case "recorded":
        return this.lsFiles(["--cached"], env);
      case "unrecorded":
        return this.lsFiles(["--others", "--exclude-standard"], env);
      case "missing":
        return this.lsFiles(["--deleted"], env);
      case "visible": {
        const [candidates, trackedIgnored, deleted] = await Promise.all([
          this.lsFiles(["--cached", "--others", "--exclude-standard"]),
          this.lsFiles(["--cached", "-i", "--exclude-standard"]),
          this.lsFiles(["--deleted"]),
        ]);
        const drop = new Set([...trackedIgnored, ...deleted]);
        const seen = new Set<string>();
        const out: string[] = [];
        for (const rel of candidates) {
          if (seen.has(rel) || drop.has(rel)) continue;
          seen.add(rel);
          out.push(rel);
        }
        return out;
      }
    }
  }

  /** Pure-rules verdict for one path (final verdict, negations resolved;
   * index NOT consulted, so a tracked path is judged by rules alone).
   * Synchronous: `admits` decides inside pipelines that cannot yield. The
   * "./" prefix keeps a leading ":" in the path from being parsed as
   * (unsupported) pathspec magic and aborting the check — a legal filename
   * like ":(glob)x" must get a verdict, not a fatal error. Same fail-closed
   * rules as every other git question here. */
  private isIgnored(relPosix: string): boolean {
    const r = this.runSync(
      ["check-ignore", "-z", "--no-index", "--stdin"],
      [0, 1],
      `./${relPosix}\0`,
    );
    return r.code === 0;
  }

  private async lsFiles(flags: string[], env?: Record<string, string>): Promise<string[]> {
    if (!env) return parseNulSeparated((await this.run(["ls-files", "-z", ...flags], [0])).stdout);
    const result = await this.runGitWithEnv(
      ["ls-files", "-z", ...flags],
      this.currentGitDir(),
      env,
    );
    if (result.code !== 0)
      throw new CheckpointStorageError(`Could not enumerate checkpoint files: ${result.stderr}`);
    return parseNulSeparated(Buffer.from(result.stdout));
  }

  /**
   * Legacy cleanup: older versions wrote a rigArchive/ stanza into
   * executionPath/.gitignore — a dead file (outside the work tree, so git
   * never read it), but possibly APPENDED to user content. Remove exactly
   * our stanza; delete the file only when nothing else remains.
   */
  private async removeLegacyExecutionGitignore(): Promise<void> {
    if (!this.legacyBackupScanRoot) return;
    const legacyGitignore = path.join(this.legacyBackupScanRoot, ".gitignore");
    const stanza = ExecutionLayout.LEGACY_EXECUTION_GITIGNORE_STANZA;
    try {
      const existing = await fs.promises.readFile(legacyGitignore, "utf-8");
      if (existing.includes(stanza)) {
        const remainder = existing
          .replace(
            `
${stanza}`,
            "",
          )
          .replace(stanza, "");
        if (remainder.trim() === "") {
          await fs.promises.rm(legacyGitignore);
          this.logger?.log("Removed legacy hankweave-generated .gitignore at execution root");
        } else if (remainder !== existing) {
          await fs.promises.writeFile(legacyGitignore, remainder);
          this.logger?.log("Removed legacy hankweave stanza from execution-root .gitignore");
        }
      }
    } catch {
      // absent or unreadable — nothing to clean up
    }
  }

  // -------------
  // Boot: build or reopen the repository
  // -------------

  /**
   * Migrate backup directories from legacy .git to .hankweavecheckpoints.
   * Called conditionally when the main checkpoint needed migration.
   */
  private async migrateBackupDirectories(): Promise<void> {
    const executionRoot = this.legacyBackupScanRoot;
    if (executionRoot === undefined) return;
    // Skip if we're somehow running inside a backup directory (shouldn't happen, but be defensive)
    if (ExecutionLayout.isInsideStateBackup(executionRoot)) {
      return;
    }

    // When --start-new --force runs, it renames the ENTIRE .hankweave directory to
    // .hankweave.backup-{timestamp}. This means backups have the structure:
    //   {executionPath}/.hankweave.backup-{timestamp}/checkpoints/.git
    //
    // These backup directories live at the same level as .hankweave (both are direct
    // children of executionPath). We need to scan them and migrate any legacy .git.
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
            this.logger?.log(`Migrating backup directory: ${entry.name}/checkpoints/.git`);
            try {
              await renameWithRetry(legacyGitDir, newGitDir, {
                logger: this.logger,
              });
              successCount++;
            } catch (error) {
              // Non-fatal for backups - just log and continue
              this.logger?.log(
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
        this.logger?.log(
          `Backup migration complete: ${successCount} succeeded, ${failCount} failed`,
          failCount > 0 ? "error" : "info", // Logger only supports "info" | "error" | "debug"
        );
      }
    } catch (error) {
      // If we can't read the execution directory, just skip backup migration
      this.logger?.log(`Could not scan for backup directories: ${error}`, "debug");
    }
  }

  private async migrateLegacyRepository(): Promise<void> {
    // Migration: rename legacy .git to .hankweavecheckpoints
    const legacyGitDir = path.join(this.checkpointDir, ".git");
    const newGitDir = this.currentGitDir();
    let didMigration = false;

    if (fs.existsSync(legacyGitDir)) {
      if (!fs.existsSync(newGitDir)) {
        // Normal migration: legacy exists, new doesn't
        this.logger?.log("Migrating legacy .git directory to .hankweavecheckpoints...");
        try {
          await renameWithRetry(legacyGitDir, newGitDir, {
            logger: this.logger,
          });
          this.logger?.log("Successfully migrated checkpoint directory to .hankweavecheckpoints");
          didMigration = true;
        } catch (error) {
          this.logger?.log(
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
          this.checkpointDir,
          `${ExecutionLayout.QUARANTINE_PREFIX}${timestamp}`,
        );
        this.logger?.log(
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
          this.logger?.log(
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
   * `infoExclude` is the owner's cosmetic info/exclude text, written into
   * fresh and reopened repositories alike (an older repo predates it).
   *
   * @returns HEAD of the repository in use, a real commit SHA — or throws
   */
  private async initializeRepository(options: { infoExclude: string }): Promise<string> {
    // Create checkpoint directory
    await fs.promises.mkdir(this.checkpointDir, { recursive: true });

    await this.migrateLegacyRepository();

    const gitDir = this.currentGitDir();

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
        await this.writeInfoExclude(gitDir, options.infoExclude);
        this.logger?.log(`Using existing shadow git repository with HEAD: ${sha}`);
        return sha;
      }

      if (head.code !== 1) {
        // git could not READ the repository. That is storage trouble, not an
        // unborn repo: stop with nothing changed (the contract resolveSnapshot
        // and listSnapshots already use), and let a person look.
        throw new CheckpointStorageError(
          `Checkpoint repository at ${gitDir} could not be read ` +
            `(rev-parse exited ${head.code}: ${head.stderr.trim()}); nothing has been changed`,
        );
      }

      // exit 1: HEAD names no commit — a build killed before its first commit,
      // or refs that went missing. Nothing to preserve, so start over. Every
      // checkpoint SHA in state.json now fails to resolve, which is the truth,
      // and recovery handles that.
      this.logger?.log(
        `Checkpoint repository at ${gitDir} has no resolvable HEAD; removing it and building a fresh one`,
        "error",
      );
      await fs.promises.rm(gitDir, { recursive: true, force: true });
    }

    const initialSha = await this.buildFreshRepo(gitDir);
    await this.writeInfoExclude(gitDir, options.infoExclude);
    return initialSha;
  }

  /** A simple-git instance bound to the given git dir, with the work tree at workTree. */
  private buildGit(gitDir: string): SimpleGit {
    return simpleGit(this.workTree, {
      // Disable parallel processes to avoid lock contention
      maxConcurrentProcesses: 1,
      config: [`core.worktree=${this.workTree}`, `core.gitdir=${gitDir}`],
    }).env(this.gitEnv(gitDir));
  }

  private gitEnv(gitDir: string): Record<string, string> {
    return {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: this.workTree,
      HOME: this.checkpointDir,
      XDG_CONFIG_HOME: this.checkpointDir,
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
        cwd: this.workTree,
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
    return path.join(this.checkpointDir, ExecutionLayout.CHECKPOINT_GIT);
  }

  /**
   * Build a brand-new repository atomically: everything happens in a sibling
   * temp folder, which is renamed to its final name only after the first
   * commit exists. A kill at any point before the rename leaves a temp folder
   * that the next boot sweeps, never a half-built repo at the final path.
   */
  private async buildFreshRepo(gitDir: string): Promise<string> {
    // Create git config to isolate from user preferences
    const gitConfigPath = path.join(this.checkpointDir, ".gitconfig");
    const gitConfigContent = `[user]
  name = Hankweave Runtime
  email = froggie@southbridge.ai
[commit]
  gpgsign = false
`;
    await fs.promises.writeFile(gitConfigPath, gitConfigContent);

    const tmpDir = `${path.join(this.checkpointDir, CHECKPOINT_TMP_PREFIX)}${process.pid}-${Date.now()}`;
    const tmpGit = this.buildGit(tmpDir);

    let initialSha: string | undefined;
    try {
      // Initialize repository (git creates GIT_DIR)
      await tmpGit.init(false, { "--initial-branch": "main" });
      await tmpGit.addConfig("user.name", "Hankweave Runtime");
      await tmpGit.addConfig("user.email", "froggie@southbridge.ai");
      await tmpGit.addConfig("commit.gpgsign", "false");

      // Initial empty commit
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
    this.logger?.log(`Shadow git repository initialized with initial commit: ${initialSha}`);
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
   * (index reset, `add` batches, commit, checkout) holds `index.lock` for
   * its whole duration and locks HEAD and a ref under refs/heads/ around the
   * commit and checkouts.
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
      this.logger?.log(`Removing stale git lock ${path.relative(gitDir, lock)} (dead owner)`);
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
      entries = await fs.promises.readdir(this.checkpointDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(CHECKPOINT_TMP_PREFIX)) continue;
      this.logger?.log(`Removing stale checkpoint build folder ${name}`);
      await fs.promises.rm(path.join(this.checkpointDir, name), { recursive: true, force: true });
    }
  }

  /** The owner's cosmetic info/exclude (keeps `git status` tidy for a human
   * looking at the shadow repo; the owner enforces its exclusions
   * in-process). */
  private async writeInfoExclude(gitDir: string, text: string): Promise<void> {
    const infoDir = path.join(gitDir, "info");
    await fs.promises.mkdir(infoDir, { recursive: true });
    await fs.promises.writeFile(path.join(infoDir, "exclude"), text);
  }

  private requireGit(): SimpleGit {
    if (!this.git) throw new Error("Git repository not initialized");
    return this.git;
  }

  // -------------
  // The git primitive the owner asks its file questions through
  // -------------

  /**
   * Run one git command against the shadow repository (cwd = work tree,
   * isolated environment: GIT_DIR, GIT_WORK_TREE, HOME/XDG at the checkpoint
   * dir, no system config). FAIL-CLOSED: a spawn error, an exit code outside
   * `okCodes`, or ANY stderr output rejects — a verdict producer must never
   * guess. Resolves `{ code, stdout }`.
   */
  private async run(args: string[], okCodes: number[], input?: string): Promise<GitResult> {
    const env = this.ownerEnv();
    return new Promise((resolve, reject) => {
      const proc = spawn("git", args, { cwd: this.workTree, env });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      proc.stdout.on("data", (d: Buffer) => out.push(d));
      proc.stderr.on("data", (d: Buffer) => err.push(d));
      proc.on("error", (e) => reject(new Error(`git ${args[0]} failed to run: ${e.message}`)));
      proc.on("close", (code) => {
        const stderr = Buffer.concat(err).toString("utf8");
        if (code === null || !okCodes.includes(code) || stderr.length > 0) {
          reject(
            new Error(
              `git ${args.join(" ")} failed (exit ${code}): ${stderr || "(no stderr)"} — refusing to guess`,
            ),
          );
          return;
        }
        resolve({ code, stdout: Buffer.concat(out) });
      });
      if (input !== undefined) proc.stdin.write(input);
      proc.stdin.end();
    });
  }

  /** Synchronous twin of {@link run}, for the one caller that must decide
   * inside a synchronous pipeline. Same fail-closed rules. */
  private runSync(args: string[], okCodes: number[], input?: string): GitResult {
    const env = this.ownerEnv();
    const r = spawnSync("git", args, { cwd: this.workTree, env, input });
    if (r.error) throw new Error(`git ${args[0]} failed to run: ${r.error.message}`);
    const stderr = r.stderr.toString("utf8");
    if (r.status === null || !okCodes.includes(r.status) || stderr.length > 0) {
      throw new Error(
        `git ${args.join(" ")} failed (exit ${r.status}): ${stderr || "(no stderr)"} — refusing to guess`,
      );
    }
    return { code: r.status, stdout: r.stdout };
  }

  /** The isolated environment for the owner's questions (git-support.ts ::
   * gitEnv: no user/system config, no prompts) over the CURRENT git dir —
   * a rebuild is invisible to callers. */
  private ownerEnv(): NodeJS.ProcessEnv {
    this.requireGit();
    return isolatedGitEnv(this.gitEnv(this.currentGitDir()));
  }

  // -------------
  // History references and literal file selection
  // -------------

  /** `:(literal)` pathspec magic: the path is taken verbatim — a file named
   * "--all" cannot become an option (we also pass "--") and glob characters
   * in filenames stay characters. */
  private static literalPathspecs(paths: string[]): string[] {
    return paths.map((p) => `:(literal)${p}`);
  }

  async historyNames(): Promise<string[]> {
    const result = await this.runGit(
      ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"],
      this.currentGitDir(),
    );
    if (result.code !== 0)
      throw new CheckpointStorageError(`Could not enumerate histories: ${result.stderr}`);
    return result.stdout.trim().split("\n").filter(Boolean);
  }

  /** Exact local history lookup; names cannot be interpreted as revision syntax. */
  async historyTip(name: string): Promise<string | null> {
    const ref = `refs/heads/${name}`;
    const checked = await this.runGit(["check-ref-format", ref], this.currentGitDir());
    if (checked.code !== 0) throw new CheckpointStorageError(`Invalid checkpoint history: ${name}`);
    try {
      return await this.resolveSnapshot(ref);
    } catch (error) {
      if (error instanceof CheckpointNotFoundError) return null;
      throw error;
    }
  }

  // -------------
  // Resolving and listing
  // -------------

  /**
   * Resolve a checkpoint reference to the full SHA of a commit git holds, via
   * `rev-parse --verify`. Throws CheckpointNotFoundError when git has no such
   * commit (the reference names nothing — a state bug that recovery may
   * degrade around) or CheckpointStorageError when git itself could not
   * answer (recovery must stop).
   */
  async resolveSnapshot(id: string): Promise<string> {
    if (!this.git) {
      throw new CheckpointStorageError("Git repository not initialized");
    }
    let verify: { code: number; stdout: string; stderr: string };
    try {
      verify = await this.runGit(
        ["rev-parse", "--verify", "--quiet", `${id}^{commit}`],
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
    if (verify.code === 1) throw new CheckpointNotFoundError(id);
    throw new CheckpointStorageError(
      `Checkpoint storage could not be read: rev-parse exited ${verify.code}: ${verify.stderr.trim()}`,
    );
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
  async snapshotsBetween(targetSha: string, fromSha: string): Promise<Set<string>> {
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
   * Get all checkpoint SHAs from the repository
   * @returns Set of all commit SHAs in the repository
   */
  async allSnapshotIds(): Promise<Set<string>> {
    const git = this.requireGit();
    try {
      // Include commits from all branches and use parsed output
      const log = await git.log(["--all"]);
      return new Set(log.all.map((commit) => commit.hash));
    } catch (error) {
      // Same contract as listSnapshots(): "could not read" is never
      // reported as "no checkpoints".
      this.logger?.log(`Failed to get checkpoint SHAs: ${error}`, "error");
      throw new CheckpointStorageError(
        `Could not enumerate checkpoint SHAs: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  async getSnapshot(id: string): Promise<StoredSnapshot> {
    const resolved = await this.resolveSnapshot(id);
    const records = await this.readSnapshotLog(["-1", resolved]);
    if (!records[0]) throw new CheckpointNotFoundError(id);
    return records[0];
  }

  /** Named histories list their ancestry; no history means all reachable refs. */
  async listSnapshots(history?: string): Promise<StoredSnapshot[]> {
    if (history === undefined) return this.readSnapshotLog(["--all"]);
    const tip = await this.historyTip(history);
    return tip === null ? [] : this.readSnapshotLog([tip]);
  }

  private async readSnapshotLog(revisions: string[]): Promise<StoredSnapshot[]> {
    this.requireGit();
    const result = await this.runGit(
      ["log", "--format=%H%x00%P%x00%cI%x00%s%x00", ...revisions, "--"],
      this.currentGitDir(),
    );
    if (result.code !== 0)
      throw new CheckpointStorageError(`Could not enumerate checkpoints: ${result.stderr}`);
    const fields = result.stdout.split("\0");
    const records: StoredSnapshot[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
      records.push({
        id: fields[i].trim(),
        parents: fields[i + 1].split(" ").filter(Boolean),
        timestamp: fields[i + 2],
        message: fields[i + 3],
      });
    }
    return records.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }

  // -------------
  // Restore and snapshot
  // -------------

  /**
   * Reset to a specific checkpoint.
   *
   * IMPORTANT: This uses `git checkout` to a detached HEAD state instead of
   * `git reset --hard`. This preserves the old branch's history so you can
   * still access old checkpoints from previous timelines.
   */
  private async resetToCheckpoint(sha: string): Promise<void> {
    const git = this.requireGit();

    // Resolve to a full SHA first so the checkout only ever sees a commit git
    // confirmed. The typed errors let recovery tell "no such checkpoint" from
    // "git is broken".
    const fullSha = await this.resolveSnapshot(sha);
    try {
      // Use checkout with --force to go to the target SHA in detached HEAD mode
      // This preserves the old branch's commits (unlike git reset --hard)
      await git.checkout(["--force", fullSha]);
      this.logger?.log(`Checked out checkpoint ${fullSha.substring(0, 7)} (detached HEAD)`);
    } catch (error) {
      this.logger?.log(`Checkout to checkpoint failed: ${error}`, "error");
      throw new CheckpointStorageError(
        `Failed to reset to checkpoint ${fullSha.substring(0, 7)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
    }
  }

  /** Build ownership, tree and ancestry entirely from the supplied parent.
   * The private index never changes HEAD, the shared index, or working files.
   * Publishing checks the expected destination tip, including branch creation. */
  private async recordSnapshot(
    history: string,
    parent: string,
    message: string,
    patterns: readonly string[],
    previous: string | null,
    ownershipPatterns: readonly string[] = patterns,
  ): Promise<StoredRecoverySnapshot> {
    this.requireGit();
    const gitDir = this.currentGitDir();
    const indexFile = path.join(gitDir, `snapshot-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    const run = async (args: string[]) => {
      const result = await this.runGitWithEnv(args, gitDir, env);
      if (result.code !== 0) {
        throw new CheckpointStorageError(
          `git ${args[0]} failed while recording checkpoint: ${result.stderr.trim()}`,
        );
      }
      return result.stdout.trim();
    };
    try {
      await run(["read-tree", parent]);
      const recorded = new Set(await this.listCandidates("recorded", env));
      const delta = await this.checkpointDelta(patterns, env);
      const batchSize = 100;
      for (let i = 0; i < delta.deletePaths.length; i += batchSize) {
        await run([
          "rm",
          "-r",
          "-q",
          "--cached",
          "--ignore-unmatch",
          "--",
          ...GitWorkspaceStorage.literalPathspecs(delta.deletePaths.slice(i, i + batchSize)),
        ]);
      }
      for (let i = 0; i < delta.addPaths.length; i += batchSize) {
        await run([
          "add",
          "-f",
          "--",
          ...GitWorkspaceStorage.literalPathspecs(delta.addPaths.slice(i, i + batchSize)),
        ]);
      }
      const tree = await run(["write-tree"]);
      const id = await run(["commit-tree", tree, "-p", parent, "-m", message]);
      // A zero old value requires that the branch does not yet exist.
      const published = await this.runGitWithEnv(
        ["update-ref", `refs/heads/${history}`, id, previous ?? "0".repeat(parent.length)],
        gitDir,
        env,
      );
      if (published.code !== 0) {
        const actual = await this.historyTip(history);
        if (actual !== previous)
          throw new CheckpointHistoryConflictError(history, previous, actual);
        throw new CheckpointStorageError(
          `Could not publish checkpoint: ${published.stderr.trim()}`,
        );
      }
      const matcher = createWorkspaceMatcher(ownershipPatterns);
      return {
        id,
        history,
        checkpointPaths: Object.freeze(
          delta.addPaths.filter((rel) => recorded.has(rel) || matcher.matches(rel)),
        ),
      };
    } catch (error) {
      if (
        error instanceof CheckpointStorageError ||
        error instanceof CheckpointHistoryConflictError
      )
        throw error;
      throw new CheckpointStorageError(`Could not record checkpoint: ${error}`, error);
    } finally {
      await fs.promises.rm(indexFile, { force: true }).catch(() => {});
    }
  }
}
