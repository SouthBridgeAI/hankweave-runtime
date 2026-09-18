import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ExecutionLayout } from "../execution-layout.js";
import { type Logger, renameWithRetry } from "../utils.js";
import { containedPath, lstatIfPresent } from "./paths.js";

const manifestSchema = z.object({
  version: z.literal("1.0.0"),
  entries: z.array(
    z.object({
      sourcePath: z.string().min(1),
      archivePath: z.string().min(1),
      codonId: z.string(),
      loopContext: z
        .object({ loopId: z.string(), iteration: z.number().int().nonnegative() })
        .optional(),
      checkpointSha: z.string(),
      timestamp: z.string(),
    }),
  ),
});

/**
 * Represents a single archived file or directory entry.
 * Tracks where the file was archived from, where it now lives, and context about the archiving operation.
 */
export interface ArchiveEntry {
  /** Original path relative to agentRoot/ */
  sourcePath: string;

  /** Path in rigArchive/ relative to execution root */
  archivePath: string;

  /** Codon that archived this (includes iteration suffix for loops, e.g., "process#0") */
  codonId: string;

  /**
   * Present for iteration-level archives; undefined for non-loop and loop-level archives.
   * Helps distinguish between different types of archives:
   * - Non-loop codon archive: loopContext is undefined, codonId is "my-codon"
   * - Loop iteration codon archive: loopContext is present, codonId is "my-codon#0"
   * - Loop-level archive (loop ends): loopContext is undefined, codonId is the loop ID
   */
  loopContext?: {
    loopId: string;
    iteration: number;
  };

  /** Checkpoint SHA at time of archiving, or 'orphan' for reconciled entries */
  checkpointSha: string;

  /** ISO timestamp of the archive operation */
  timestamp: string;
}

/**
 * The archive manifest tracks all archived files for an execution.
 * Stored at .hankweave/archive-manifest.json (outside the git work tree).
 */
export interface ArchiveManifest {
  version: "1.0.0";
  entries: ArchiveEntry[];
}

/**
 * Manages the archive manifest for tracking archived files.
 * The manifest is stored at .hankweave/archive-manifest.json (outside the agentRoot/
 * work tree) and is NOT checkpointed by git. Instead, rollback selects which
 * archives to restore via selectEntriesToRestore() (driven by git reachability,
 * see WorkspaceStorage.snapshotsBetween) and afterwards removes exactly the entries
 * that were successfully restored via removeEntries().
 */
export class ArchiveManifestManager {
  private manifestPath: string;
  private logger?: Logger;
  private manifest: ArchiveManifest;
  private readonly executionPath: string;

  constructor(executionPath: string, logger?: Logger) {
    this.executionPath = executionPath;
    this.manifestPath = new ExecutionLayout(executionPath).archiveManifestPath;
    this.logger = logger;
    this.manifest = { version: "1.0.0", entries: [] };
  }

  /**
   * Load manifest from disk. Creates empty manifest if file doesn't exist.
   * @returns The loaded manifest
   */
  async load(): Promise<ArchiveManifest> {
    this.validatePath();
    try {
      const content = await fs.promises.readFile(this.manifestPath, "utf-8");
      this.manifest = manifestSchema.parse(JSON.parse(content));
      this.logger?.log(`Loaded archive manifest with ${this.manifest.entries.length} entries`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.manifest = { version: "1.0.0", entries: [] };
      this.logger?.log("No archive manifest found, starting with empty manifest");
    }
    return this.manifest;
  }

  /** Publish a complete file before changing in-memory state. A failed save
   * must not leave phantom additions/removals in the running process. */
  private async persist(manifest: ArchiveManifest, shouldAbort?: () => boolean): Promise<void> {
    const assertActive = () => {
      if (shouldAbort?.()) throw new Error("Archive manifest update aborted: shutdown in progress");
    };
    assertActive();
    this.validatePath();
    await fs.promises.mkdir(path.dirname(this.manifestPath), { recursive: true });
    assertActive();
    this.validatePath();
    const temporary = `${this.manifestPath}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(manifest, null, 2), { flag: "wx" });
      assertActive();
      this.validatePath();
      await renameWithRetry(temporary, this.manifestPath);
    } finally {
      if (!shouldAbort?.()) {
        this.validatePath();
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
      }
    }
  }

  private validatePath(): void {
    containedPath(this.executionPath, path.relative(this.executionPath, this.manifestPath));
    const existing = lstatIfPresent(this.manifestPath);
    if (existing && !existing.isFile()) throw new Error("Archive manifest is not a regular file");
  }

  /**
   * Add a new entry and persist to disk.
   * @param entry The archive entry to add
   */
  async addEntry(entry: ArchiveEntry, shouldAbort?: () => boolean): Promise<void> {
    const next: ArchiveManifest = {
      ...this.manifest,
      // One physical archive location has one owner after an overwrite.
      entries: [...this.manifest.entries.filter((e) => e.archivePath !== entry.archivePath), entry],
    };
    await this.persist(next, shouldAbort);
    this.manifest = next;
    this.logger?.log(`Added archive entry: ${entry.sourcePath} -> ${entry.archivePath}`);
  }

  /**
   * Select the entries a rollback should restore, using git reachability
   * instead of the manifest's list order.
   *
   * An entry is restored only when it was archived strictly AFTER the
   * rollback target on the line being abandoned:
   * - `checkpointSha === 'orphan'`: always restored (origin unknown).
   * - `checkpointSha` in `reachableAfterTarget` (the `git rev-list
   *   target..originHead` set): restored.
   * - Entry at or before the target, or on an unrelated timeline: stays
   *   archived, silently — its files belong in rigArchive/.
   * - Entry whose SHA is unknown to the checkpoint repository entirely:
   *   stays archived, with a warning naming it. Restoring would overwrite
   *   the workspace and delete the archive copy — destructive is the wrong
   *   default for an entry we cannot place.
   *
   * @param reachableAfterTarget SHAs reachable from the pre-rollback HEAD but
   *        not from (or equal to) the target (WorkspaceStorage.snapshotsBetween)
   * @param knownShas All SHAs in the checkpoint repository, used only to
   *        distinguish "not selected by design" from "unknown SHA" warnings
   */
  selectEntriesToRestore(
    reachableAfterTarget: ReadonlySet<string>,
    knownShas: ReadonlySet<string>,
  ): ArchiveEntry[] {
    const result: ArchiveEntry[] = [];

    for (const entry of this.manifest.entries) {
      if (entry.checkpointSha === "orphan" || reachableAfterTarget.has(entry.checkpointSha)) {
        result.push(entry);
        continue;
      }

      if (!knownShas.has(entry.checkpointSha)) {
        this.logger?.log(
          `Archive entry ${entry.sourcePath} (${entry.archivePath}) references checkpoint ` +
            `${entry.checkpointSha}, which is unknown to the checkpoint repository. ` +
            `Leaving it archived in rigArchive/ — restore it by hand if needed.`,
          "error",
        );
      }
    }

    return result;
  }

  /**
   * Remove specific entries (by identity) from the manifest and persist.
   * Used after rollback restoration: only the entries that were actually
   * restored leave the manifest; failed or skipped entries stay recorded so
   * their archive copies remain discoverable.
   *
   * @param entries The exact entry objects to remove
   */
  async removeEntries(entries: ArchiveEntry[], shouldAbort?: () => boolean): Promise<void> {
    if (entries.length === 0) return;

    const toRemove = new Set(entries);
    const before = this.manifest.entries.length;
    const next = {
      ...this.manifest,
      entries: this.manifest.entries.filter((entry) => !toRemove.has(entry)),
    };
    const removed = before - next.entries.length;
    await this.persist(next, shouldAbort);
    this.manifest = next;
    this.logger?.log(`Removed ${removed} restored entries from archive manifest`);
  }

  /**
   * Get the current manifest (in-memory state).
   */
  getManifest(): ArchiveManifest {
    return this.manifest;
  }
}
