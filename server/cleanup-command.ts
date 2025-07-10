import fs from "node:fs";
import path from "node:path";
import { formatSize, removeDirectory, removeFile } from "./cleanup/file-operations.js";
import { GitOperations } from "./cleanup/git-operations.js";
import { ManifestBuilder } from "./cleanup/manifest-builder.js";
import type { CleanupManifest, CleanupOptions, CleanupResult } from "./cleanup/types.js";

export class CleanupCommand {
  constructor(private options: CleanupOptions) {}

  async execute(): Promise<CleanupResult> {
    const result: CleanupResult = {
      success: false,
      filesRemoved: [],
      directoriesRemoved: [],
      gitFilesReset: [],
      warnings: [],
      errors: [],
    };

    try {
      // Check if server is running
      const lockFile = path.join(this.options.projectPath, ".langton/server.lock");
      if (fs.existsSync(lockFile)) {
        throw new Error("Server is currently running. Please stop it before cleanup.");
      }

      // Build manifest
      const manifestBuilder = new ManifestBuilder(
        this.options.configPath,
        this.options.projectPath,
      );
      const manifest = await manifestBuilder.build();

      // Display plan
      this.displayCleanupPlan(manifest);

      // Get confirmation
      if (!this.options.skipConfirmation) {
        const confirmed = await this.getConfirmation();
        if (!confirmed) {
          console.log("\n❌ Cleanup cancelled by user");
          return result;
        }
      }

      // Execute cleanup
      console.log("\n🧹 Executing cleanup...\n");

      // 1. Reset git if available
      if (manifest.checkpointRepoExists && !manifest.isAtInitialCommit) {
        await this.resetGit(manifest, result);
      }

      // 2. Remove copied directories
      await this.removeCopiedItems(manifest, result);

      // 3. Remove .langton directory
      await this.removeLangtonDir(manifest, result);

      result.success = result.errors.length === 0;

      // Display results
      this.displayResults(result);
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }

    return result;
  }

  private displayCleanupPlan(manifest: CleanupManifest): void {
    console.log("🧹 Langton Cleanup Tool\n");
    console.log(`📋 Analyzing configuration: ${this.options.configPath}\n`);

    console.log("The following will be removed:\n");

    // Show copied directories
    if (manifest.copiedItems.length > 0) {
      console.log("📁 Directories (from workspace setup):");
      for (const item of manifest.copiedItems) {
        if (item.exists) {
          const size = item.sizeBytes ? ` (${formatSize(item.sizeBytes)})` : "";
          console.log(`  ✗ ${item.destination}${size} (copied from ${item.source})`);
        }
      }
      console.log();
    }

    // Show git-tracked files
    if (manifest.gitTrackedFiles.length > 0) {
      console.log("📄 Files (tracked in git):");
      for (const file of manifest.gitTrackedFiles) {
        const status =
          file.status === "added"
            ? "(new)"
            : file.status === "modified"
              ? "(modified)"
              : file.status === "deleted"
                ? "(deleted)"
                : "";
        console.log(`  ✗ ${file.path} ${status}`);
      }
      console.log();
    }

    // Show .langton directory
    if (manifest.langtonDir.exists) {
      console.log("📁 Langton data:");
      console.log(
        `  ✗ ${manifest.langtonDir.path}/ (${formatSize(manifest.langtonDir.sizeBytes)})`,
      );

      if (manifest.langtonDir.contents.logs.length > 0) {
        for (const log of manifest.langtonDir.contents.logs.slice(0, 5)) {
          console.log(`    - logs/${log}`);
        }
        if (manifest.langtonDir.contents.logs.length > 5) {
          console.log(
            `    - ... and ${manifest.langtonDir.contents.logs.length - 5} more log files`,
          );
        }
      }

      if (manifest.langtonDir.contents.checkpoints) {
        console.log("    - checkpoints/.git/");
        console.log("    - checkpoints/.gitconfig");
      }
      console.log();
    }

    // Show warnings about commands
    if (manifest.executedCommands.length > 0) {
      console.log("⚠️  The following commands were run and CANNOT be undone:");
      for (const cmd of manifest.executedCommands) {
        const dir =
          cmd.workingDirectory === "." ? "" : `, workingDirectory: ${cmd.workingDirectory}`;
        console.log(`  - ${cmd.command} (in ${cmd.phaseId}${dir})`);
        for (const effect of cmd.possibleSideEffects) {
          console.log(`    → ${effect}`);
        }
      }
      console.log();
    }

    // Additional warnings
    console.log("⚠️  Additional warnings:");
    console.log("  - Claude may have created files outside tracked patterns");
    console.log("  - System changes from Claude's tool use cannot be undone");
    console.log("  - If any of these directories existed before, they will be lost");
    console.log();
  }

  private async getConfirmation(): Promise<boolean> {
    console.log("❓ Proceed with cleanup? This cannot be undone! (y/N): ");

    // Read user input
    return new Promise((resolve) => {
      process.stdin.once("data", (data) => {
        const input = data.toString().trim().toLowerCase();
        resolve(input === "y" || input === "yes");
      });
    });
  }

  private async resetGit(manifest: CleanupManifest, result: CleanupResult): Promise<void> {
    if (!manifest.checkpointRepoExists || !manifest.initialCommitHash) {
      result.warnings.push("No checkpoint repository found, skipping git reset");
      return;
    }

    const checkpointPath = path.join(this.options.projectPath, ".langton", "checkpoints");
    const gitOps = new GitOperations(this.options.projectPath, checkpointPath);

    try {
      console.log("📝 Resetting git to initial commit...");
      await gitOps.resetToInitial();
      result.gitFilesReset = manifest.gitTrackedFiles.map((f) => f.path);
      console.log(`  ✓ Reset ${result.gitFilesReset.length} tracked files`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Git reset failed: ${message}`);
      console.log(`  ✗ Git reset failed: ${message}`);
    }
  }

  private async removeCopiedItems(manifest: CleanupManifest, result: CleanupResult): Promise<void> {
    for (const item of manifest.copiedItems) {
      if (!item.exists) continue;

      const fullPath = path.join(this.options.projectPath, item.destination);

      try {
        if (item.type === "directory") {
          console.log(`🗑️  Removing directory: ${item.destination}`);
          await removeDirectory(fullPath, this.options.projectPath);
          result.directoriesRemoved.push(item.destination);
        } else {
          console.log(`🗑️  Removing file: ${item.destination}`);
          await removeFile(fullPath, this.options.projectPath);
          result.filesRemoved.push(item.destination);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to remove ${item.destination}: ${message}`);
        console.log(`  ✗ Failed: ${message}`);
      }
    }
  }

  private async removeLangtonDir(manifest: CleanupManifest, result: CleanupResult): Promise<void> {
    if (!manifest.langtonDir.exists) return;

    const langtonPath = path.join(this.options.projectPath, manifest.langtonDir.path);

    try {
      console.log(`🗑️  Removing .langton directory...`);
      await fs.promises.rm(langtonPath, { recursive: true, force: true });
      result.directoriesRemoved.push(".langton");
      console.log("  ✓ Removed .langton directory");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to remove .langton: ${message}`);
      console.log(`  ✗ Failed: ${message}`);
    }
  }

  private displayResults(result: CleanupResult): void {
    console.log(`\n${"=".repeat(50)}\n`);

    if (result.success) {
      console.log("✅ Cleanup completed successfully!\n");

      if (result.filesRemoved.length > 0) {
        console.log(`📄 Files removed: ${result.filesRemoved.length}`);
      }
      if (result.directoriesRemoved.length > 0) {
        console.log(`📁 Directories removed: ${result.directoriesRemoved.length}`);
      }
      if (result.gitFilesReset.length > 0) {
        console.log(`📝 Git files reset: ${result.gitFilesReset.length}`);
      }
    } else {
      console.log("❌ Cleanup completed with errors\n");

      for (const error of result.errors) {
        console.log(`  Error: ${error}`);
      }
    }

    if (result.warnings.length > 0) {
      console.log("\n⚠️  Warnings:");
      for (const warning of result.warnings) {
        console.log(`  - ${warning}`);
      }
    }
  }
}
