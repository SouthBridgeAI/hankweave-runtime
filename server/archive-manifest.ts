import fs from "node:fs";
import { ExecutionLayout } from "./execution-layout.js";
import type { Logger } from "./utils.js";

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
 * see CheckpointGit.shasBetween) and afterwards removes exactly the entries
 * that were successfully restored via removeEntries().
 */
export class ArchiveManifestManager {
  private manifestPath: string;
  private logger: Logger;
  private manifest: ArchiveManifest;

  constructor(executionPath: string, logger: Logger) {
    this.manifestPath = new ExecutionLayout(executionPath).archiveManifestPath;
    this.logger = logger;
    this.manifest = { version: "1.0.0", entries: [] };
  }

  /**
   * Load manifest from disk. Creates empty manifest if file doesn't exist.
   * @returns The loaded manifest
   */
  async load(): Promise<ArchiveManifest> {
    if (fs.existsSync(this.manifestPath)) {
      try {
        const content = await fs.promises.readFile(this.manifestPath, "utf-8");
        this.manifest = JSON.parse(content);
        this.logger.log(`Loaded archive manifest with ${this.manifest.entries.length} entries`);
      } catch (error) {
        this.logger.log(`Error loading archive manifest, starting fresh: ${error}`, "error");
        this.manifest = { version: "1.0.0", entries: [] };
      }
    } else {
      this.manifest = { version: "1.0.0", entries: [] };
      this.logger.log("No archive manifest found, starting with empty manifest");
    }
    return this.manifest;
  }

  /**
   * Save manifest to disk.
   */
  async save(): Promise<void> {
    await fs.promises.writeFile(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }

  /**
   * Add a new entry and persist to disk.
   * @param entry The archive entry to add
   */
  async addEntry(entry: ArchiveEntry): Promise<void> {
    this.manifest.entries.push(entry);
    await this.save();
    this.logger.log(`Added archive entry: ${entry.sourcePath} -> ${entry.archivePath}`);
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
   *        not from (or equal to) the target (CheckpointGit.shasBetween)
   * @param knownShas All SHAs in the checkpoint repository, used only to
   *        distinguish "not selected by design" from "unknown SHA" warnings
   */
  selectEntriesToRestore(
    reachableAfterTarget: Set<string>,
    knownShas: Set<string>,
  ): ArchiveEntry[] {
    const result: ArchiveEntry[] = [];

    for (const entry of this.manifest.entries) {
      if (entry.checkpointSha === "orphan" || reachableAfterTarget.has(entry.checkpointSha)) {
        result.push(entry);
        continue;
      }

      if (!knownShas.has(entry.checkpointSha)) {
        this.logger.log(
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
  async removeEntries(entries: ArchiveEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const toRemove = new Set(entries);
    const before = this.manifest.entries.length;
    this.manifest.entries = this.manifest.entries.filter((entry) => !toRemove.has(entry));
    const removed = before - this.manifest.entries.length;
    await this.save();
    this.logger.log(`Removed ${removed} restored entries from archive manifest`);
  }

  /**
   * Get the current manifest (in-memory state).
   */
  getManifest(): ArchiveManifest {
    return this.manifest;
  }

  /**
   * Get the manifest file path.
   */
  getManifestPath(): string {
    return this.manifestPath;
  }
}
