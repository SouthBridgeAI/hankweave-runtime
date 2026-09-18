import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExecutionLayout } from "../execution-layout.js";
import type { Logger } from "../utils.js";
import { type ArchiveEntry, ArchiveManifestManager } from "./archive-manifest.js";
import type { CheckpointId } from "./checkpoints.js";
import type { WorkspaceSelection } from "./files.js";
import { containedPath, lstatIfPresent, workspaceMutationPath } from "./paths.js";

export type ArchiveOwner =
  | { kind: "codon"; codonId: string }
  | { kind: "iteration"; codonId: string; loopId: string; iteration: number }
  | { kind: "loop"; loopId: string };

/** Storage locations and manifest records stay inside the owning workspace. */
export interface ArchiveRestorePlan {
  readonly count: number;
}

export interface ArchiveOperationOptions {
  shouldAbort?: () => boolean;
}

export type ArchiveOutcome =
  | { path: string; status: "archived" | "source-missing" }
  | { path: string; status: "failed"; error: string };

export type ArchiveRestoreOutcome =
  | { path: string; status: "restored" }
  | { path: string; status: "archive-missing" | "destination-protected" | "failed"; error: string };

/** Ready archive operations; storage locations and lifecycle remain private. */
export interface WorkspaceArchives {
  planRestore(history: {
    abandoned: ReadonlySet<CheckpointId>;
    known: ReadonlySet<CheckpointId>;
  }): Promise<ArchiveRestorePlan>;
  archive(
    selection: WorkspaceSelection,
    owner: ArchiveOwner,
    checkpoint: CheckpointId,
    options?: ArchiveOperationOptions,
  ): Promise<ArchiveOutcome[]>;
  restore(
    plan: ArchiveRestorePlan,
    options?: ArchiveOperationOptions,
  ): Promise<ArchiveRestoreOutcome[]>;
}

/** Archive storage, manifest, and restore protocol. Open independently when
 * checkpoint storage is not needed; selection uses the supplied live view. */
export class WorkspaceArchive implements WorkspaceArchives {
  private readonly manifest: ArchiveManifestManager;
  private readonly plans = new WeakMap<ArchiveRestorePlan, ArchiveEntry[]>();
  private operation: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly layout: ExecutionLayout,
    private readonly logger?: Logger,
  ) {
    this.manifest = new ArchiveManifestManager(layout.executionPath, logger);
  }

  /** Load and validate the ledger before publishing any archive capability. */
  static async open(layout: ExecutionLayout, logger?: Logger): Promise<WorkspaceArchive> {
    const archive = new WorkspaceArchive(layout, logger);
    await archive.manifest.load();
    return archive;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation);
    this.operation = result.catch(() => {});
    return result;
  }

  planRestore(history: {
    abandoned: ReadonlySet<CheckpointId>;
    known: ReadonlySet<CheckpointId>;
  }): Promise<ArchiveRestorePlan> {
    return this.exclusive(async () => {
      const entries = this.manifest.selectEntriesToRestore(history.abandoned, history.known);
      const plan = Object.freeze({ count: entries.length });
      this.plans.set(plan, entries);
      return plan;
    });
  }

  private assertActive(options: ArchiveOperationOptions): void {
    if (options.shouldAbort?.()) throw new Error("Archive operation aborted: shutdown in progress");
  }

  private ownerDirectory(owner: ArchiveOwner): string {
    const component = (value: string): string => {
      if (!value || value === "." || value === ".." || /[/\\\0:]/.test(value)) {
        throw new Error(`Invalid archive identity: ${value}`);
      }
      return value.replace(/#/g, "-");
    };
    if (owner.kind === "loop") return `${component(owner.loopId)}-loop`;
    if (owner.kind === "codon") return component(owner.codonId);
    if (!Number.isSafeInteger(owner.iteration) || owner.iteration < 0) {
      throw new Error(`Invalid archive iteration: ${owner.iteration}`);
    }
    return path.join(`${component(owner.loopId)}-${owner.iteration}`, component(owner.codonId));
  }

  /** Persisted paths are execution-relative, but must resolve strictly
   * inside rigArchive. Never trust a path merely because it came from JSON. */
  private archivePath(reference: string): string {
    const absolute = containedPath(this.layout.executionPath, reference);
    return containedPath(
      this.layout.rigArchivePath,
      path.relative(this.layout.rigArchivePath, absolute),
    );
  }

  async archive(
    selection: WorkspaceSelection,
    owner: ArchiveOwner,
    checkpoint: CheckpointId,
    options: ArchiveOperationOptions = {},
  ): Promise<ArchiveOutcome[]> {
    const files = await selection.files();
    return this.exclusive(() => this.archiveFilesNow(files, owner, checkpoint, options));
  }

  private async archiveFilesNow(
    files: string[],
    owner: ArchiveOwner,
    checkpoint: CheckpointId,
    options: ArchiveOperationOptions,
  ): Promise<ArchiveOutcome[]> {
    const directory = this.ownerDirectory(owner);
    const outcomes: ArchiveOutcome[] = [];
    for (const file of files) {
      this.assertActive(options);
      try {
        const source = workspaceMutationPath(this.layout.agentRootPath, file);
        const stats = lstatIfPresent(source);
        if (!stats) {
          outcomes.push({ path: file, status: "source-missing" });
          continue;
        }
        if (!stats.isFile()) throw new Error(`Archive source is not a regular file: ${file}`);
        const destination = containedPath(this.layout.rigArchivePath, path.join(directory, file));
        const reference = path.relative(this.layout.executionPath, destination);
        const entry: ArchiveEntry = {
          sourcePath: file,
          archivePath: reference,
          codonId: owner.kind === "loop" ? owner.loopId : owner.codonId,
          ...(owner.kind === "iteration"
            ? { loopContext: { loopId: owner.loopId, iteration: owner.iteration } }
            : {}),
          checkpointSha: checkpoint,
          timestamp: new Date().toISOString(),
        };
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        this.assertActive(options);
        this.archivePath(reference);
        workspaceMutationPath(this.layout.agentRootPath, file);
        if (!lstatIfPresent(source)?.isFile()) throw new Error(`Archive source changed: ${file}`);
        await this.replaceAndRecord(source, destination, {
          options,
          validateTarget: () => {
            this.archivePath(reference);
          },
          validateCopy: (copy) => {
            if (!fs.lstatSync(copy).isFile()) throw new Error(`Archive source changed: ${file}`);
          },
          record: () => this.manifest.addEntry(entry, options.shouldAbort),
        });
        // The ledger and archive copy exist before we remove the original.
        this.assertActive(options);
        workspaceMutationPath(this.layout.agentRootPath, file);
        await fs.promises.rm(source);
        outcomes.push({ path: file, status: "archived" });
      } catch (error) {
        this.assertActive(options);
        outcomes.push({ path: file, status: "failed", error: String(error) });
      }
    }
    return outcomes;
  }

  /** Prepare a complete replacement before touching the destination. Keep
   * the previous version until its manifest change commits. Compensation
   * handles ordinary failures; this is not a transaction across process
   * death. Interrupted operations can leave .tmp/.bak recovery copies. */
  private async replaceAndRecord(
    source: string,
    destination: string,
    operation: {
      options: ArchiveOperationOptions;
      validateTarget: () => void;
      validateCopy: (copy: string) => void;
      record: () => Promise<void>;
    },
  ): Promise<void> {
    const { options, validateTarget, validateCopy, record } = operation;
    const staged = `${destination}.${randomUUID()}.tmp`;
    const backup = `${destination}.${randomUUID()}.bak`;
    let backedUp = false;
    let installed = false;
    let committed = false;
    let rolledBack = false;
    const compensate = async (): Promise<void> => {
      if (!options.shouldAbort?.()) {
        validateTarget();
        if (installed) await fs.promises.rm(destination, { recursive: true, force: true });
        if (backedUp) await fs.promises.rename(backup, destination);
        rolledBack = true;
      }
    };
    const cleanupCopies = async (): Promise<void> => {
      if (!options.shouldAbort?.()) {
        validateTarget();
        await fs.promises.rm(staged, { recursive: true, force: true }).catch(() => {});
        // If compensation itself fails, retain the previous version for recovery.
        if (committed || rolledBack || !backedUp) {
          await fs.promises.rm(backup, { recursive: true, force: true }).catch(() => {});
        }
      }
    };
    try {
      this.assertActive(options);
      validateTarget();
      await fs.promises.cp(source, staged, {
        recursive: true,
        verbatimSymlinks: true,
        force: false,
        errorOnExist: true,
      });
      this.assertActive(options);
      validateTarget();
      validateCopy(staged);
      if (lstatIfPresent(destination)) {
        await fs.promises.rename(destination, backup);
        backedUp = true;
      }
      this.assertActive(options);
      validateTarget();
      await fs.promises.rename(staged, destination);
      installed = true;
      this.assertActive(options);
      await record();
      committed = true;
    } catch (error) {
      await compensate();
      throw error;
    } finally {
      await cleanupCopies();
    }
  }

  /** Validate legacy directory archives too, including their descendants.
   * Current archives contain regular files; older manifests may name trees. */
  private validateRestoreTree(source: string, relative: string): void {
    workspaceMutationPath(this.layout.agentRootPath, relative);
    const stats = fs.lstatSync(source);
    if (stats.isFile()) return;
    if (!stats.isDirectory()) throw new Error(`Archive contains a non-regular node: ${source}`);
    for (const child of fs.readdirSync(source)) {
      this.validateRestoreTree(path.join(source, child), path.join(relative, child));
    }
  }

  restore(
    plan: ArchiveRestorePlan,
    options: ArchiveOperationOptions = {},
  ): Promise<ArchiveRestoreOutcome[]> {
    return this.exclusive(() => this.restoreNow(plan, options));
  }

  private async restoreNow(
    plan: ArchiveRestorePlan,
    options: ArchiveOperationOptions,
  ): Promise<ArchiveRestoreOutcome[]> {
    const entries = this.plans.get(plan);
    if (!entries)
      throw new Error("Archive restore plan does not belong to this workspace or was already used");
    this.plans.delete(plan);
    this.assertActive(options);
    const protectedPaths = new Set<string>();
    const invalid = new Map<ArchiveEntry, string>();
    // Capture before the first copy: later entries may replace files created
    // by this batch, but never destinations present after checkpoint checkout.
    for (const entry of entries) {
      try {
        const destination = workspaceMutationPath(this.layout.agentRootPath, entry.sourcePath);
        this.archivePath(entry.archivePath);
        if (lstatIfPresent(destination)) protectedPaths.add(destination);
      } catch (error) {
        invalid.set(entry, String(error));
      }
    }
    const outcomes: ArchiveRestoreOutcome[] = [];
    const cleanupRestoredArchive = async (entry: ArchiveEntry, source: string): Promise<void> => {
      if (!options.shouldAbort?.()) {
        try {
          this.archivePath(entry.archivePath);
          await fs.promises.rm(source, { recursive: true, force: true });
        } catch (error) {
          this.logger?.log(
            `Restored ${entry.sourcePath}; archive cleanup failed: ${error}`,
            "error",
          );
        }
      }
    };
    const restoreEntry = async (entry: ArchiveEntry): Promise<void> => {
      this.assertActive(options);
      try {
        const error = invalid.get(entry);
        if (error) throw new Error(error);
        if (!this.manifest.getManifest().entries.includes(entry))
          throw new Error("Archive entry changed since restore was planned");
        const source = this.archivePath(entry.archivePath);
        const destination = workspaceMutationPath(this.layout.agentRootPath, entry.sourcePath);
        if (!lstatIfPresent(source)) {
          outcomes.push({
            path: entry.sourcePath,
            status: "archive-missing",
            error: "Archive not found",
          });
          return;
        }
        if (protectedPaths.has(destination)) {
          outcomes.push({
            path: entry.sourcePath,
            status: "destination-protected",
            error: "Destination existed before archive restoration; archive kept",
          });
          return;
        }
        this.validateRestoreTree(source, entry.sourcePath);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        this.assertActive(options);
        this.archivePath(entry.archivePath);
        this.validateRestoreTree(source, entry.sourcePath);
        await this.replaceAndRecord(source, destination, {
          options,
          validateTarget: () => {
            workspaceMutationPath(this.layout.agentRootPath, entry.sourcePath);
          },
          validateCopy: (copy) => this.validateRestoreTree(copy, entry.sourcePath),
          record: () => this.manifest.removeEntries([entry], options.shouldAbort),
        });
        outcomes.push({ path: entry.sourcePath, status: "restored" });
        await cleanupRestoredArchive(entry, source);
      } catch (error) {
        this.assertActive(options);
        outcomes.push({ path: entry.sourcePath, status: "failed", error: String(error) });
      }
    };
    for (const entry of entries) {
      await restoreEntry(entry);
    }
    await this.prune(
      entries.map((entry) => entry.archivePath),
      options,
    );
    return outcomes;
  }

  private async prune(references: string[], options: ArchiveOperationOptions): Promise<void> {
    const directories = new Set<string>();
    for (const reference of references) {
      try {
        let directory = path.dirname(this.archivePath(reference));
        while (directory !== path.resolve(this.layout.rigArchivePath)) {
          directories.add(directory);
          directory = path.dirname(directory);
        }
      } catch {
        /* Invalid entries cannot authorize cleanup. */
      }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      if (options.shouldAbort?.()) return;
      try {
        containedPath(
          this.layout.rigArchivePath,
          path.relative(this.layout.rigArchivePath, directory),
        );
        await fs.promises.rmdir(directory);
      } catch {
        /* Missing/nonempty directories are harmless; retry on a later pass. */
      }
    }
  }
}
