import path from "node:path";

/**
 * The fixed shape of an execution directory, defined once.
 *
 * ```
 * <executionPath>/
 *   .hankweave/                       execution-meta.json, state.json, runtime.lock,
 *                                     events/, runs/<id>/, archive-manifest.json,
 *                                     checkpoints/.hankweavecheckpoints   (shadow git repo)
 *   agentRoot/                        agent workspace (checkpoint work tree)
 *     read_only_data_source/          symlink or copy of the input data
 *   rigArchive/                       archiveOnSuccess destination
 * ```
 *
 * This module is pure: no filesystem access, nothing but string derivation.
 * `setupExecutionEnvironment` creates the directories; everything else that
 * needs one of these paths derives it from here so the on-disk names, the
 * checkpoint exclusion policy and the preflight (--validate) report cannot
 * drift apart.
 *
 * Instance fields are the absolute paths of one execution directory. Static
 * members are the bare on-disk names and the operations that need them:
 * matching directory entries, git pathspecs, .gitignore content, relative
 * config defaults. Nothing outside this module joins a layout segment onto a
 * path by hand.
 */
export class ExecutionLayout {
  // -------------
  // Directory and file names
  // -------------

  /** Execution state directory, a direct child of the execution directory. */
  static readonly STATE_DIR = ".hankweave";
  /** Agent workspace; also the checkpoint repository's work tree. */
  static readonly AGENT_ROOT = "agentRoot";
  /** Destination for archiveOnSuccess / archiveOnLoopComplete. */
  static readonly RIG_ARCHIVE = "rigArchive";
  /** Input data link (or copy), inside the agent workspace. */
  static readonly DATA_SOURCE = "read_only_data_source";
  /** Checkpoint repository container, inside the state directory. */
  static readonly CHECKPOINTS = "checkpoints";
  /**
   * The shadow git directory. Named .hankweavecheckpoints instead of .git so a
   * committed execution directory is never mistaken for a submodule.
   */
  static readonly CHECKPOINT_GIT = ".hankweavecheckpoints";
  /** Event journal directory, inside the state directory. */
  static readonly EVENTS = "events";
  /** Per-run folders, inside the state directory. */
  static readonly RUNS = "runs";

  static readonly EXECUTION_META_FILE = "execution-meta.json";
  static readonly STATE_FILE = "state.json";
  static readonly STATE_BACKUP_FILE = "state.json.bak";
  static readonly RUNTIME_LOCK_FILE = "runtime.lock";
  static readonly ARCHIVE_MANIFEST_FILE = "archive-manifest.json";

  /**
   * `--start-new --force` renames the whole state directory to
   * `<prefix><timestamp>` beside a fresh one, so backups sit at the execution
   * root next to `.hankweave/`.
   */
  static readonly STATE_BACKUP_PREFIX = `${ExecutionLayout.STATE_DIR}.backup-`;
  /**
   * When both a legacy `.git` and `.hankweavecheckpoints` exist in the
   * checkpoints directory, the legacy one is moved to `<prefix><timestamp>`.
   */
  static readonly QUARANTINE_PREFIX = `${ExecutionLayout.CHECKPOINT_GIT}-quarantine-`;

  /**
   * Directories the file resolver must always exclude from checkpointing and
   * file listing, regardless of any .gitignore. Paths are relative to the
   * resolver's project root with POSIX separators; a trailing `*` is a glob.
   *
   * The state-directory entries predate the agentRoot/ split (when the work
   * tree was the execution directory itself) and are kept as defense in depth.
   * The data-source entry is live: it lives inside the work tree and must
   * never be snapshotted.
   */
  static readonly MANDATORY_EXCLUDED_DIRS: readonly string[] = [
    `${ExecutionLayout.STATE_DIR}/${ExecutionLayout.CHECKPOINTS}/${ExecutionLayout.CHECKPOINT_GIT}`,
    `${ExecutionLayout.STATE_DIR}/${ExecutionLayout.CHECKPOINTS}/${ExecutionLayout.QUARANTINE_PREFIX}*`,
    `${ExecutionLayout.STATE_BACKUP_PREFIX}*/${ExecutionLayout.CHECKPOINTS}/${ExecutionLayout.CHECKPOINT_GIT}`,
    `${ExecutionLayout.STATE_BACKUP_PREFIX}*/${ExecutionLayout.CHECKPOINTS}/${ExecutionLayout.QUARANTINE_PREFIX}*`,
    ExecutionLayout.DATA_SOURCE,
  ];

  /**
   * The lock file relative to the execution directory. The config default
   * before any execution directory exists; the runtime resolves it against
   * `executionPath` at boot.
   */
  static readonly RELATIVE_LOCK_FILE = path.join(
    ExecutionLayout.STATE_DIR,
    ExecutionLayout.RUNTIME_LOCK_FILE,
  );

  /** The .gitignore line that keeps rigArchive/ out of checkpoints. */
  static readonly RIG_ARCHIVE_IGNORE_LINE = `${ExecutionLayout.RIG_ARCHIVE}/`;

  /** git pathspec that keeps the data source out of `git add` in the work tree. */
  static readonly DATA_SOURCE_PATHSPEC_EXCLUDE = `:(exclude)${ExecutionLayout.DATA_SOURCE}`;

  // -------------
  // Name-level predicates
  // -------------

  /** Does a directory listing of an execution directory contain execution state? */
  static hasExecutionState(dirEntries: readonly string[]): boolean {
    return dirEntries.includes(ExecutionLayout.STATE_DIR);
  }

  /** Is this directory-entry name a `--start-new --force` state backup? */
  static isStateBackupDir(entryName: string): boolean {
    return entryName.startsWith(ExecutionLayout.STATE_BACKUP_PREFIX);
  }

  /** Does this absolute path pass through a state backup directory? */
  static isInsideStateBackup(absPath: string): boolean {
    return absPath.includes(ExecutionLayout.STATE_BACKUP_PREFIX);
  }

  /**
   * The checkpoint paths of a backed-up state directory
   * (`<executionPath>/.hankweave.backup-<timestamp>`), which keeps the same
   * inner shape as a live one.
   */
  static forBackedUpStateDir(
    backupDir: string,
  ): Pick<ExecutionLayout, "checkpointsPath" | "checkpointGitDir"> {
    const checkpointsPath = path.join(backupDir, ExecutionLayout.CHECKPOINTS);
    return {
      checkpointsPath,
      checkpointGitDir: path.join(checkpointsPath, ExecutionLayout.CHECKPOINT_GIT),
    };
  }

  // -------------
  // Derived absolute paths
  // -------------

  /** The execution directory itself (outer directory). */
  readonly executionPath: string;
  /** `<executionPath>/.hankweave` */
  readonly stateDir: string;
  /** `<executionPath>/agentRoot` */
  readonly agentRootPath: string;
  /** `<executionPath>/rigArchive` */
  readonly rigArchivePath: string;
  /** `<executionPath>/agentRoot/read_only_data_source` */
  readonly dataPathInExecutionDir: string;
  /** `<executionPath>/.hankweave/checkpoints` */
  readonly checkpointsPath: string;
  /** `<executionPath>/.hankweave/checkpoints/.hankweavecheckpoints` */
  readonly checkpointGitDir: string;
  /** `<executionPath>/.hankweave/execution-meta.json` */
  readonly metaPath: string;
  /** `<executionPath>/.hankweave/state.json` */
  readonly statePath: string;
  /** `<executionPath>/.hankweave/state.json.bak` */
  readonly stateBackupPath: string;
  /** `<executionPath>/.hankweave/runtime.lock` */
  readonly lockPath: string;
  /** `<executionPath>/.hankweave/events` */
  readonly eventsDir: string;
  /** `<executionPath>/.hankweave/runs` */
  readonly runsDir: string;
  /** `<executionPath>/.hankweave/archive-manifest.json` */
  readonly archiveManifestPath: string;

  /**
   * Derive every well-known path of an execution directory. Pure; the caller
   * decides whether anything exists or gets created.
   */
  constructor(executionPath: string) {
    this.executionPath = executionPath;
    this.stateDir = path.join(executionPath, ExecutionLayout.STATE_DIR);
    this.agentRootPath = path.join(executionPath, ExecutionLayout.AGENT_ROOT);
    this.rigArchivePath = path.join(executionPath, ExecutionLayout.RIG_ARCHIVE);
    this.dataPathInExecutionDir = path.join(this.agentRootPath, ExecutionLayout.DATA_SOURCE);
    this.checkpointsPath = path.join(this.stateDir, ExecutionLayout.CHECKPOINTS);
    this.checkpointGitDir = path.join(this.checkpointsPath, ExecutionLayout.CHECKPOINT_GIT);
    this.metaPath = path.join(this.stateDir, ExecutionLayout.EXECUTION_META_FILE);
    this.statePath = path.join(this.stateDir, ExecutionLayout.STATE_FILE);
    this.stateBackupPath = path.join(this.stateDir, ExecutionLayout.STATE_BACKUP_FILE);
    this.lockPath = path.join(this.stateDir, ExecutionLayout.RUNTIME_LOCK_FILE);
    this.eventsDir = path.join(this.stateDir, ExecutionLayout.EVENTS);
    this.runsDir = path.join(this.stateDir, ExecutionLayout.RUNS);
    this.archiveManifestPath = path.join(this.stateDir, ExecutionLayout.ARCHIVE_MANIFEST_FILE);
  }

  // -------------
  // Timestamped siblings
  // -------------

  /** `<executionPath>/.hankweave.backup-<timestamp>` (`--start-new --force`). */
  stateBackupDir(timestamp: string): string {
    return path.join(this.executionPath, `${ExecutionLayout.STATE_BACKUP_PREFIX}${timestamp}`);
  }

  /** `<checkpointsPath>/.hankweavecheckpoints-quarantine-<timestamp>`. */
  quarantineGitDir(timestamp: string): string {
    return path.join(this.checkpointsPath, `${ExecutionLayout.QUARANTINE_PREFIX}${timestamp}`);
  }
}
