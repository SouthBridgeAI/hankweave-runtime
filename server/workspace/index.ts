import type { ExecutionLayout } from "../execution-layout.js";
import type { Logger } from "../utils.js";
import { WorkspaceArchive, type WorkspaceArchives } from "./archive.js";
import { CheckpointService, type WorkspaceCheckpoints } from "./checkpoints.js";
import { WorkspaceFiles } from "./files.js";
import { GitWorkspaceStorage } from "./git-storage.js";
import { WorkspaceOutput } from "./output.js";
import { RecoveryService, type WorkspaceRecovery } from "./recovery.js";
import { WorkspaceRigs } from "./rigs.js";
import type { WorkspaceStorage } from "./storage.js";

/** A workspace provides controlled access to an agent’s working files, records
 * their checkpoint history, preserves files during recovery, moves completed artifacts
 * into an archive, installs rigs, and exports outputs.
 *
 * Await open() once, then every capability is usable. Opening requires the
 * caller to have established exclusive ownership and prepared the work tree.
 */
export class Workspace {
  readonly files: WorkspaceFiles;
  readonly checkpoints: WorkspaceCheckpoints;
  readonly recovery: WorkspaceRecovery;
  readonly archives: WorkspaceArchives;
  readonly rigs: WorkspaceRigs;
  readonly outputs: WorkspaceOutput;

  private constructor(
    layout: ExecutionLayout,
    storage: WorkspaceStorage,
    checkpoints: WorkspaceCheckpoints,
    archives: WorkspaceArchives,
    logger?: Logger,
  ) {
    this.files = new WorkspaceFiles(storage);
    this.checkpoints = checkpoints;
    this.recovery = new RecoveryService(storage);
    this.archives = archives;
    this.rigs = new WorkspaceRigs(layout.agentRootPath, logger);
    this.outputs = new WorkspaceOutput(layout.agentRootPath, logger);
  }

  /** Initialize shared storage, verify history, then load archive metadata.
   * Failures reject without publishing a partially prepared workspace;
   * initialization writes already completed are not rolled back.
   */
  static async open(
    layout: ExecutionLayout,
    options: { logger?: Logger; storage?: WorkspaceStorage } = {},
  ): Promise<Workspace> {
    const { logger } = options;
    const storage =
      options.storage ??
      new GitWorkspaceStorage(
        {
          checkpointDir: layout.checkpointsPath,
          workTree: layout.agentRootPath,
          legacyBackupScanRoot: layout.executionPath,
        },
        logger,
      );
    const checkpoints = await CheckpointService.open(storage, logger);
    const archives = await WorkspaceArchive.open(layout, logger);
    return new Workspace(layout, storage, checkpoints, archives, logger);
  }
}
