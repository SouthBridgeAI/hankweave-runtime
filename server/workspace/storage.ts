/** Storage for workspace files and snapshots. Implementations own file rules:
 * current ignore rules, mandatory exclusions, regular-file and path checks,
 * and pattern matching. Returned paths are workspace-relative; snapshot IDs
 * are opaque. Files and checkpoints share one adapter instance.
 */
export interface WorkspaceStorage {
  initialize(): Promise<string>;

  /** Sorted, present regular files matching the patterns and visibility rules.
   * Excludes ignored files, protected paths, symlinks and unrecorded nested
   * repository contents. Empty or negative-only patterns match nothing.
   */
  listFiles(patterns: readonly string[]): Promise<StoredFileEntry[]>;
  /** Normalize an absolute or relative candidate and apply the same rules as
   * listing. Returns null when excluded; a prospective file may be admitted.
   */
  admitFile(candidate: string, patterns: readonly string[]): string | null;
  /** Read a path already listed or admitted: the in-process path, pattern
   * and regular-file guards are re-applied, the ignore verdict is not. Null
   * when excluded by those guards or absent. */
  readFile(candidate: string, patterns: readonly string[]): StoredFile | null;

  historyNames(): Promise<string[]>;
  historyTip(name: string): Promise<string | null>;
  getSnapshot(id: string): Promise<StoredSnapshot>;
  resolveSnapshot(id: string): Promise<string>;

  /** Save matching regular files, including previously recorded files now
   * ignored. Record deletions and mandatory-exclusion purges even with empty
   * patterns. Failed earlier saves must not grant recorded-file status to
   * unsaved files. Always creates a snapshot, even when nothing changed.
   * An existing history must point at parent, which supplies both ancestry
   * and recorded-file ownership. Publish conditionally without changing files,
   * HEAD, or the shared index; reject a conflicting destination.
   */
  saveSnapshot(request: {
    history: string;
    parent: string;
    message: string;
    patterns: readonly string[];
  }): Promise<string>;
  /** Preserve all eligible files against the explicit parent without changing
   * existing histories or working files. Patterns select which newly saved files recovery may remove,
   * not what gets backed up; previously recorded files remain owned too.
   */
  preserveSnapshot(
    parent: string,
    message: string,
    patterns: readonly string[],
  ): Promise<StoredRecoverySnapshot>;
  /** Restore the target and remove saved checkpoint-owned files absent from
   * it. Reject a missing target before mutation and validate all removals
   * first; only regular files within the workspace may be removed.
   */
  restoreSnapshot(id: string, checkpointPaths: readonly string[]): Promise<void>;

  /** Snapshots reachable from `from`, excluding `target` and its ancestors. */
  snapshotsBetween(target: string, from: string): Promise<Set<string>>;
  allSnapshotIds(): Promise<Set<string>>;
  listSnapshots(history?: string): Promise<StoredSnapshot[]>;
}

export interface StoredFileEntry {
  path: string;
  lastModified: Date;
}

export interface StoredFile {
  content: string;
  lastModified: Date;
}

export interface StoredSnapshotLocation {
  id: string;
  /** A containing history, not necessarily the snapshot's origin. */
  history: string;
}

export interface StoredRecoverySnapshot extends StoredSnapshotLocation {
  /** Saved paths owned by checkpointing, captured before any restore. */
  checkpointPaths: readonly string[];
}

export interface StoredSnapshot {
  id: string;
  parents: string[];
  message: string;
  timestamp: string;
}
