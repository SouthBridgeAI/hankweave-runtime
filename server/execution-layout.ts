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
   * The lock file relative to the execution directory. The config default
   * before any execution directory exists; the runtime resolves it against
   * `executionPath` at boot.
   */
  static readonly RELATIVE_LOCK_FILE = path.join(
    ExecutionLayout.STATE_DIR,
    ExecutionLayout.RUNTIME_LOCK_FILE,
  );

  // -------------
  // Mandatory exclusions
  // -------------

  /** The protected names, folded the way isMandatoryExcluded folds the path
   * it judges (NFC + lower-case), computed once. */
  private static readonly FOLDED = {
    dataSource: ExecutionLayout.fold(ExecutionLayout.DATA_SOURCE),
    rigArchive: ExecutionLayout.fold(ExecutionLayout.RIG_ARCHIVE),
    stateDir: ExecutionLayout.fold(ExecutionLayout.STATE_DIR),
    stateBackupPrefix: ExecutionLayout.fold(ExecutionLayout.STATE_BACKUP_PREFIX),
    checkpointGit: ExecutionLayout.fold(ExecutionLayout.CHECKPOINT_GIT),
    quarantinePrefix: ExecutionLayout.fold(ExecutionLayout.QUARANTINE_PREFIX),
  };

  private static fold(name: string): string {
    return name.normalize("NFC").toLowerCase();
  }

  /**
   * Is this work-tree-relative POSIX path one of hankweave's own? The
   * mandatory checkpoint/visibility exclusion, which the Workspace applies
   * at listing, in every checkpoint delta, and at event time. Component-aware
   * and case/Unicode-FOLDED: on a case-insensitive filesystem a case-renamed
   * READ_ONLY_DATA_SOURCE is the same protected directory and git reports
   * the new spelling — the guard must still hold. On case-sensitive systems
   * this over-excludes a look-alike name; for a safety exclusion that is the
   * right direction to err.
   *
   * read_only_data_source/ and rigArchive/ are protected at the work-tree
   * root (the archive only appears there when the work tree IS the execution
   * directory); hankweave's own state dirs at ANY depth — defense in depth
   * for a nested execution directory that ends up inside a work tree.
   */
  static isMandatoryExcluded(relPosix: string): boolean {
    const components = relPosix.split("/").map(ExecutionLayout.fold);
    const first = components[0] as string;
    const F = ExecutionLayout.FOLDED;
    if (first === F.dataSource || first === F.rigArchive) return true;
    return components.some(
      (c) =>
        c === F.stateDir ||
        c.startsWith(F.stateBackupPrefix) ||
        c === F.checkpointGit ||
        c.startsWith(F.quarantinePrefix),
    );
  }

  /** The belt-and-braces mirror of isMandatoryExcluded for the shadow
   * checkpoint repo's info/exclude (keeps `git status` output sane for
   * humans; NOT the enforcement). Written by GitWorkspaceStorage at repo setup. */
  static readonly CHECKPOINT_INFO_EXCLUDE =
    `# Managed by hankweave. Mandatory exclusions are enforced in-process
# (execution-layout.ts :: isMandatoryExcluded); these entries just keep git output tidy.
/${ExecutionLayout.DATA_SOURCE}/
/${ExecutionLayout.RIG_ARCHIVE}/
/${ExecutionLayout.STATE_DIR}/
/${ExecutionLayout.STATE_BACKUP_PREFIX}*/
`;

  /**
   * The exact stanza older versions appended to `<executionPath>/.gitignore`
   * (a dead file: outside the work tree, so git never read it). Kept only so
   * the Workspace can recognise and remove it.
   */
  static readonly LEGACY_EXECUTION_GITIGNORE_STANZA =
    `# Hankweave archive directory - not checkpointed
${ExecutionLayout.RIG_ARCHIVE}/
`;

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
  /** The agent's working directory: `<executionPath>/agentRoot` unless the
   * caller overrides it (tests that run the work tree at the execution
   * directory itself — the flat layout the mandatory exclusions defend). */
  readonly agentRootPath: string;
  /** `<executionPath>/rigArchive` */
  readonly rigArchivePath: string;
  /** `<agentRootPath>/read_only_data_source` */
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
   * decides whether anything exists or gets created. `agentRootPath` is the
   * one input the runtime config carries independently; it defaults to the
   * standard `agentRoot/` child.
   */
  constructor(executionPath: string, options: { agentRootPath?: string } = {}) {
    this.executionPath = executionPath;
    this.stateDir = path.join(executionPath, ExecutionLayout.STATE_DIR);
    this.agentRootPath =
      options.agentRootPath ?? path.join(executionPath, ExecutionLayout.AGENT_ROOT);
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
