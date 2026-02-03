import fs from "node:fs";
import path from "node:path";
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
 * work tree) and is NOT checkpointed by git. Instead, rollback identifies which
 * archives to restore by querying entries after the target checkpoint SHA, then
 * programmatically updates the manifest via removeEntriesAfterCheckpoint().
 */
export class ArchiveManifestManager {
  private manifestPath: string;
  private logger: Logger;
  private manifest: ArchiveManifest;

  constructor(executionPath: string, logger: Logger) {
    this.manifestPath = path.join(executionPath, ".hankweave", "archive-manifest.json");
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
   * Get all entries created AFTER a target checkpoint.
   *
   * Key insight: entries with checkpointSha === targetSha were created
   * DURING that checkpoint's codon completion, so they should REMAIN
   * (not be restored). Only entries AFTER are restored.
   *
   * Special case: entries with checkpointSha === 'orphan' are always
   * included in restoration since we don't know their origin checkpoint.
   *
   * @param targetSha The checkpoint SHA to compare against
   * @returns Array of entries created after the target checkpoint
   */
  getEntriesAfterCheckpoint(targetSha: string): ArchiveEntry[] {
    const result: ArchiveEntry[] = [];
    let foundTarget = false;

    for (const entry of this.manifest.entries) {
      // Always include orphan entries in restoration
      if (entry.checkpointSha === "orphan") {
        result.push(entry);
        continue;
      }

      if (entry.checkpointSha === targetSha) {
        foundTarget = true;
        // Entry AT target stays (not restored)
        continue;
      }

      if (foundTarget) {
        // Entry AFTER target gets restored
        result.push(entry);
      }
    }

    // If target not found, return all entries (conservative: restore everything)
    if (!foundTarget) {
      this.logger.log(
        `Target checkpoint ${targetSha} not found in manifest, returning all entries`,
        "error",
      );
      return [...this.manifest.entries];
    }

    return result;
  }

  /**
   * Remove entries created after a target checkpoint.
   * Used after rollback to truncate the manifest to match restored state.
   *
   * @param targetSha The checkpoint SHA to truncate after
   */
  removeEntriesAfterCheckpoint(targetSha: string): void {
    const targetIndex = this.manifest.entries.findIndex((e) => e.checkpointSha === targetSha);
    if (targetIndex !== -1) {
      const removedCount = this.manifest.entries.length - targetIndex - 1;
      this.manifest.entries = this.manifest.entries.slice(0, targetIndex + 1);
      this.logger.log(`Removed ${removedCount} entries after checkpoint ${targetSha}`);
    }
  }

  /**
   * Reload manifest from disk. Used after git checkout to sync with restored state.
   */
  async reload(): Promise<void> {
    await this.load();
    this.logger.log("Reloaded archive manifest from disk");
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
