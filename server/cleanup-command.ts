import fs from "node:fs";
import path from "node:path";
import { findExecutionDirs, hashDataSource } from "./data-hasher.js";
import { formatSize, getDirectorySize } from "./utils.js";

export interface CleanupOptions {
  dataSourcePath?: string; // For finding by hash
  executionPath?: string; // For direct cleanup
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
      let dirsToRemove: string[] = [];

      if (this.options.executionPath) {
        // Direct execution path cleanup - just clean this one
        dirsToRemove = [this.options.executionPath];
      } else if (this.options.dataSourcePath) {
        // Validate data source exists
        if (!fs.existsSync(this.options.dataSourcePath)) {
          result.errors.push(`Data source not found: ${this.options.dataSourcePath}`);
          return result;
        }

        // Find by data hash - ONLY clean up the latest
        console.log("Calculating data signature for cleanup...");
        const dataHash = await hashDataSource(this.options.dataSourcePath);
        console.log(`Data signature: ${dataHash}`);

        const allDirs = await findExecutionDirs(dataHash);

        if (allDirs.length === 0) {
          console.log("No execution directories found for this data source.");
          result.success = true;
          return result;
        }

        // UPDATED: Only clean up the latest (first in sorted list)
        dirsToRemove = [allDirs[0]];

        // Show all directories found but note we're only cleaning the latest
        if (allDirs.length > 1) {
          console.log(`Found ${allDirs.length} execution directories.`);
          console.log("Only the latest will be cleaned up.\n");
        }
      } else {
        throw new Error("Either dataSourcePath or executionPath must be provided");
      }

      // Display what will be removed
      console.log("🧹 Strandweave Cleanup Tool\n");
      console.log("The following execution directory will be removed:\n");

      for (const dir of dirsToRemove) {
        const metaPath = path.join(dir, ".strandweave", "execution-meta.json");
        try {
          const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
          console.log(`📁 ${dir}`);
          console.log(`   Created: ${meta.createdAt}`);
          console.log(`   Last used: ${meta.lastUsed}`);
          console.log(`   Link type: ${meta.linkType}`);
          console.log(`   Original data: ${meta.readOnlySourceDataPath}`);

          // Calculate size
          const size = await getDirectorySize(dir);
          console.log(`   Size: ${formatSize(size)}`);
        } catch {
          console.log(`📁 ${dir} (metadata unavailable)`);
        }
        console.log();
      }

      // If there are other directories, list them but note they won't be removed
      if (this.options.dataSourcePath) {
        const allDirs = await findExecutionDirs(await hashDataSource(this.options.dataSourcePath));
        const otherDirs = allDirs.filter((d) => !dirsToRemove.includes(d));

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

      for (const dir of dirsToRemove) {
        try {
          // Check if directory exists
          if (!fs.existsSync(dir)) {
            console.log(`⚠️  Directory does not exist: ${dir}`);
            continue;
          }

          // Check for lock file
          const lockFile = path.join(dir, ".strandweave", "runtime.lock");
          if (fs.existsSync(lockFile)) {
            result.errors.push(`Cannot remove ${dir}: Server is running`);
            console.log(`❌ Skipped (server running): ${dir}`);
            continue;
          }

          await fs.promises.rm(dir, { recursive: true, force: true });
          result.directoriesRemoved.push(dir);
          console.log(`✅ Removed: ${dir}`);
        } catch (error) {
          result.errors.push(`Failed to remove ${dir}: ${(error as Error).message}`);
          console.log(`❌ Failed: ${dir} - ${(error as Error).message}`);
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
