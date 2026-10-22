import fs from "node:fs";
import { findExecutionDirs, hashDataSource } from "./data-hasher.js";
import { removeEmptyExecutionDirectory, removeExecutionContents } from "./execution-cleanup.js";
import { ExecutionLayout } from "./execution-layout.js";
import { RuntimeLock, RuntimeLockHeldError } from "./runtime-lock.js";
import { formatSize, getDirectorySize } from "./utils.js";

export interface CleanupOptions {
  dataSourcePath?: string; // For listing other executions with the same data hash
  executionPath: string; // Resolved cleanup target
  skipConfirmation: boolean;
}

export interface CleanupResult {
  success: boolean;
  directoriesRemoved: string[];
  warnings: string[];
  errors: string[];
}

export class CleanupCommand {
  constructor(private options: CleanupOptions) {}

  async execute(): Promise<CleanupResult> {
    const result: CleanupResult = {
      success: false,
      directoriesRemoved: [],
      warnings: [],
      errors: [],
    };

    try {
      const dir = this.options.executionPath;
      if (!dir) {
        throw new Error("executionPath must be provided");
      }

      // Display what will be removed
      console.log("🧹 Hankweave Cleanup Tool\n");
      console.log("The following execution directory will be removed:\n");

      const metaPath = new ExecutionLayout(dir).metaPath;
      try {
        const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
        console.log(`📁 ${dir}`);
        console.log(`   Created: ${meta.createdAt}`);
        console.log(`   Last used: ${meta.lastUsed}`);
        console.log(`   Link type: ${meta.linkType}`);
        console.log(`   Original data: ${meta.readOnlySourceDataPath}`);

        const size = await getDirectorySize(dir);
        console.log(`   Size: ${formatSize(size)}`);
      } catch {
        console.log(`📁 ${dir} (metadata unavailable)`);
      }
      console.log();

      // If there are other directories, list them but note they won't be removed
      if (this.options.dataSourcePath) {
        const allDirs = await findExecutionDirs(await hashDataSource(this.options.dataSourcePath));
        const otherDirs = allDirs.filter((d) => d !== dir);

        if (otherDirs.length > 0) {
          console.log("Other execution directories (will NOT be removed):");
          for (const dir of otherDirs) {
            console.log(`  - ${dir}`);
          }
          console.log();
        }
      }

      // Get confirmation
      if (!this.options.skipConfirmation) {
        const confirmed = await this.getConfirmation();
        if (!confirmed) {
          console.log("\n❌ Cleanup cancelled by user");
          return result;
        }
      }

      // Remove directory
      console.log("\n🗑️  Removing execution directory...\n");

      if (!fs.existsSync(dir)) {
        console.log(`⚠️  Directory does not exist: ${dir}`);
      } else {
        try {
          const lock = await RuntimeLock.acquire(dir);
          try {
            await removeExecutionContents(dir, lock);
          } finally {
            await lock.release();
          }
          const warning = removeEmptyExecutionDirectory(dir);
          if (warning) {
            const message = `Execution artifacts removed. ${warning}`;
            result.warnings.push(message);
            console.log(`⚠️  ${message}`);
          } else {
            result.directoriesRemoved.push(dir);
            console.log(`✅ Removed: ${dir}`);
          }
        } catch (error) {
          const message =
            error instanceof RuntimeLockHeldError
              ? `Cannot remove ${dir}: ${error.message}`
              : `Failed to remove ${dir}: ${(error as Error).message}`;
          result.errors.push(message);
          console.log(`❌ ${message}`);
        }
      }

      result.success = result.errors.length === 0;

      // Display summary
      console.log(`\n${"=".repeat(50)}\n`);
      if (result.success) {
        console.log(`✅ Cleanup completed successfully!`);
        console.log(`   Removed ${result.directoriesRemoved.length} execution directory`);
      } else {
        console.log(`⚠️  Cleanup completed with errors`);
        console.log(`   Removed: ${result.directoriesRemoved.length} directories`);
        console.log(`   Failed: ${result.errors.length} directories`);
      }
    } catch (error) {
      result.errors.push((error as Error).message);
      console.error(`\n❌ Cleanup failed: ${(error as Error).message}`);
    }

    return result;
  }

  private async getConfirmation(): Promise<boolean> {
    console.log("❓ Proceed with cleanup? This cannot be undone! (y/N): ");

    return new Promise((resolve) => {
      process.stdin.once("data", (data) => {
        const input = data.toString().trim().toLowerCase();
        resolve(input === "y" || input === "yes");
      });
    });
  }
}
