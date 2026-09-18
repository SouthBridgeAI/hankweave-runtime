import type { FileNode } from "../schemas/event-schemas.js";
import type { StoredFile, WorkspaceStorage } from "./storage.js";
import { buildFileTree } from "./tree.js";

/** One workspace file as read by a selection. */
export type WorkspaceFile = StoredFile;

/**
 * A pattern-scoped view of the workspace — what a consumer that watches a
 * pattern set (one codon's watched files) holds instead of the patterns.
 * Storage applies the patterns and file rules to every operation, read live.
 */
export interface WorkspaceSelection {
  /** Immutable copy of the patterns defining this selection. */
  readonly patterns: readonly string[];
  /** List current files matching this selection, sorted by workspace-relative path. */
  files(): Promise<string[]>;
  /** The `filetree.updated` payload for this selection. */
  tree(): Promise<FileNode[]>;
  /**
   * The workspace-relative name of `candidate` if a regular file there
   * belongs to this selection, else null. Accepts whatever a caller holds
   * (absolute, work-tree-relative, "./"-prefixed, platform separators); null
   * when the path escapes the workspace, falls outside the patterns, or the
   * policy would not admit it. The path need not exist yet. Synchronous.
   */
  admit(candidate: string): string | null;
  /**
   * Read a file in this selection: its body and last-modified time, or null
   * when absent or excluded. For a path already returned by `files()` or
   * `admit()`: the path, pattern and regular-file guards are re-applied,
   * the ignore verdict is not (no git spawn per read). Unexpected failures
   * throw. Synchronous.
   */
  read(candidate: string): WorkspaceFile | null;
}

/** Pattern-scoped access to the live visible workspace. */
export class WorkspaceFiles {
  constructor(private readonly storage: WorkspaceStorage) {}

  /**
   * The `filetree.updated` payload for the given patterns: one listing pass
   * covers every pattern. Enumeration failures PROPAGATE — the caller must
   * not publish an empty tree as if the workspace were empty. A single file
   * vanishing between enumeration and stat is skipped, not fatal. Reached
   * through a selection's `tree()`.
   */
  private async fileTree(patterns: readonly string[]): Promise<FileNode[]> {
    const files = await this.storage.listFiles(patterns);
    return buildFileTree(
      files.map(({ path, lastModified }) => ({ path, lastModified: lastModified.toISOString() })),
    );
  }

  /** The pattern-scoped view (see WorkspaceSelection): the only public
   * door to the visible surface. */
  select(patterns: readonly string[]): WorkspaceSelection {
    const frozenPatterns = Object.freeze([...patterns]);
    return {
      patterns: frozenPatterns,
      files: async () => (await this.storage.listFiles(frozenPatterns)).map((file) => file.path),
      tree: () => this.fileTree(frozenPatterns),
      admit: (candidate) => this.storage.admitFile(candidate, frozenPatterns),
      read: (candidate) => this.storage.readFile(candidate, frozenPatterns),
    };
  }
}
