import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DEFAULT_CONFIG } from "./config.js";
import { findExecutionDirs, hashDataSource } from "./data-hasher.js";

/**
 * Check if we're in a non-interactive environment (CI, tests, pipes, etc.)
 */
function isNonInteractive(): boolean {
  // Check for common CI environment variables
  if (
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.JENKINS ||
    process.env.CIRCLECI ||
    process.env.TRAVIS
  ) {
    return true;
  }

  // Check for Bun test environment
  if (process.env.BUN_TEST || process.argv.some((arg) => arg.includes("bun test"))) {
    return true;
  }

  // Both stdin and stdout must be TTY for interactive mode
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return true;
  }

  return false;
}

/**
 * Prompt user for confirmation.
 * Returns true if user confirms, false otherwise.
 * In non-interactive environments, returns false immediately.
 */
async function promptConfirmation(message: string): Promise<boolean> {
  // In non-interactive mode (CI, tests, pipes), default to false (don't continue)
  if (isNonInteractive()) {
    console.warn("⚠️  Non-interactive mode, skipping confirmation prompt.");
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    // Add a timeout in case stdin hangs (defensive measure)
    const timeout = setTimeout(() => {
      rl.close();
      console.warn("\n⚠️  Prompt timed out, defaulting to no.");
      resolve(false);
    }, 30000); // 30 second timeout

    rl.question(`${message} [y/N] `, (answer) => {
      clearTimeout(timeout);
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Count files and directories in a path.
 */
async function countDirectoryContents(
  dirPath: string,
): Promise<{ files: number; directories: number }> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  let files = 0;
  let directories = 0;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      directories++;
    } else {
      files++;
    }
  }

  return { files, directories };
}

export interface ExecutionSetup {
  readOnlySourceDataPath: string; // Absolute path to original data
  executionPath: string; // Absolute path where we run
  dataPathInExecutionDir: string; // Always executionPath + '/read_only_data_source'
  dataHash: string;
  strandHash?: string; // Hash of strand.json content (for resume detection)
  isNewExecution: boolean;
  isResuming: boolean;
  linkType: "symlink" | "copy";
  configChanged?: boolean; // True if strand.json changed since last run
  meta: {
    createdAt: string;
    lastUsed: string;
    readOnlySourceResolvedDataPath: string;
    version: string;
    strandHash?: string;
    strandPath?: string;
  };
}

export async function setupExecutionEnvironment(options: {
  readOnlySourceDataPath: string; // Already resolved to absolute
  executionPath?: string; // Already resolved to absolute, or undefined
  useSymlink?: boolean; // Default true, --copy flag sets to false
  dataHashTimeLimit?: number; // Time limit for hashing
  startNew?: boolean; // Force new execution
  forceMode?: boolean; // Force operation in existing directories with .strandweave
  skipConfirmation?: boolean; // Skip confirmation prompts (-y flag)
  strandPath?: string; // Path to strand.json for hash tracking
}): Promise<ExecutionSetup> {
  const {
    readOnlySourceDataPath,
    executionPath,
    useSymlink = true,
    dataHashTimeLimit = DEFAULT_CONFIG.dataHashTimeLimit,
    startNew = false,
    forceMode = false,
    skipConfirmation = false,
    strandPath,
  } = options;

  // Verify data source exists
  if (!fs.existsSync(readOnlySourceDataPath)) {
    throw new Error(`Data source not found: ${readOnlySourceDataPath}`);
  }

  const stats = await fs.promises.stat(readOnlySourceDataPath);
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new Error(`Data source is not a file or directory: ${readOnlySourceDataPath}`);
  }

  // Calculate data hash
  console.log("Calculating data signature...");
  const dataHash = await hashDataSource(readOnlySourceDataPath, dataHashTimeLimit);
  console.log(`Data signature: ${dataHash}`);

  let finalExecutionPath: string;
  let isNewExecution = false;
  let isResuming = false;
  let configChanged = false;

  // Calculate strand hash if path provided
  let strandHash: string | undefined;
  if (strandPath && fs.existsSync(strandPath)) {
    const strandContent = await fs.promises.readFile(strandPath, "utf-8");
    strandHash = crypto.createHash("sha256").update(strandContent).digest("hex");
  }

  if (executionPath) {
    // Explicit execution path provided

    // Tier 1: Hard error for managed execution directory
    const managedExecBase = path.join(os.homedir(), ".strandweave-executions");
    if (executionPath.startsWith(managedExecBase)) {
      throw new Error(
        `Cannot use ${managedExecBase}/ as explicit execution directory.\n` +
          `This location is reserved for auto-managed executions.\n` +
          `Use a different path for --execution.`,
      );
    }

    if (startNew) {
      // With --start-new, implement tiered safety
      if (fs.existsSync(executionPath)) {
        const entries = await fs.promises.readdir(executionPath);

        if (entries.length > 0) {
          const hasStrandweave = entries.includes(".strandweave");

          // Tier 2: Directory already has Strandweave execution
          if (hasStrandweave) {
            if (forceMode) {
              // Backup existing .strandweave
              const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
              const backupPath = path.join(executionPath, `.strandweave.backup-${timestamp}`);
              await fs.promises.rename(path.join(executionPath, ".strandweave"), backupPath);
              console.log(`📦 Backed up existing execution to: ${backupPath}`);
            } else {
              throw new Error(
                `Directory already contains Strandweave execution: ${executionPath}\n` +
                  `Options:\n` +
                  `  1. Remove .strandweave/ directory and try again\n` +
                  `  2. Use --force to backup existing state and start fresh\n` +
                  `  3. Use a different directory`,
              );
            }
          } else {
            // Tier 3: Non-empty directory without Strandweave
            const { files, directories } = await countDirectoryContents(executionPath);

            if (!skipConfirmation && !forceMode) {
              console.log(
                `\n⚠️  WARNING: Running in existing non-empty directory: ${executionPath}`,
              );
              console.log(
                `\n  This directory contains ${files} files and ${directories} directories.`,
              );
              console.log(
                `  Strandweave agents will have access to READ and MODIFY files in this directory.`,
              );
              console.log(`\n  Strandweave will create:`);
              console.log(`    ./.strandweave/           (execution metadata)`);
              console.log(`    ./read_only_data_source/  (symlink to data)`);
              console.log(
                `\n  IMPORTANT: Always use version control. Test strands on non-critical directories first.\n`,
              );

              const confirmed = await promptConfirmation("Continue?");
              if (!confirmed) {
                throw new Error("Operation cancelled by user.");
              }
            } else if (skipConfirmation) {
              console.warn(
                `⚠️  Running in non-empty directory with -y flag: ${executionPath} (${files} files, ${directories} directories)`,
              );
            }
          }
        }

        // Directory exists and safety checks passed - use it
        console.log(`Using directory for new execution: ${executionPath}`);
      } else {
        // Directory doesn't exist - create it
        await fs.promises.mkdir(executionPath, { recursive: true });
        console.log(`Created directory for new execution: ${executionPath}`);
      }

      isNewExecution = true;
      isResuming = false;
      finalExecutionPath = executionPath;
    } else {
      // Without --start-new, existing logic applies
      if (!fs.existsSync(executionPath)) {
        throw new Error(`Execution directory not found: ${executionPath}`);
      }

      // Verify it's a directory
      const stats = await fs.promises.stat(executionPath);
      if (!stats.isDirectory()) {
        throw new Error(`Execution path is not a directory: ${executionPath}`);
      }

      // Prevent nested execution
      if (executionPath.includes("/.strandweave-executions/") && executionPath.includes("/data")) {
        throw new Error("Cannot create execution inside another execution directory");
      }

      // Prevent using data source as execution
      if (path.resolve(executionPath) === path.resolve(readOnlySourceDataPath)) {
        throw new Error("Execution directory cannot be the same as data source");
      }

      // Check if it has execution metadata
      const metaPath = path.join(executionPath, ".strandweave", "execution-meta.json");
      if (fs.existsSync(metaPath)) {
        // Verify data hash matches
        const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
        if (meta.dataHash !== dataHash) {
          throw new Error(
            `Data source mismatch. Execution directory was created for different data.\n` +
              `Expected hash: ${meta.dataHash}\n` +
              `Current hash: ${dataHash}`,
          );
        }

        // Check for strand config changes
        if (strandHash && meta.strandHash && meta.strandHash !== strandHash) {
          configChanged = true;
          console.log(`\n⚠️  WARNING: strand.json has changed since last execution.`);
          console.log(`  Previous hash: ${meta.strandHash.substring(0, 12)}...`);
          console.log(`  Current hash:  ${strandHash.substring(0, 12)}...`);
          console.log(`  Changes may affect execution behavior.\n`);

          if (!skipConfirmation && !forceMode) {
            const confirmed = await promptConfirmation("Continue with modified config?");
            if (!confirmed) {
              throw new Error("Operation cancelled by user.");
            }
          }
        }

        isResuming = true;
      } else {
        // Directory exists but no metadata - treat as fresh execution
        isNewExecution = true;
        console.log(`Using existing directory as execution directory: ${executionPath}`);
      }

      finalExecutionPath = executionPath;
    }
  } else {
    // Auto-detect or create execution directory
    const executionRoot = path.join(os.homedir(), ".strandweave-executions");
    await fs.promises.mkdir(executionRoot, { recursive: true });

    if (startNew) {
      // With --start-new, always create new directory
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 6);
      const dirName = `${timestamp}-${random}-${dataHash.substring(0, 6)}`;
      finalExecutionPath = path.join(executionRoot, dirName);
      await fs.promises.mkdir(finalExecutionPath, { recursive: true });
      isNewExecution = true;
      isResuming = false;
      console.log(`Created new execution directory: ${finalExecutionPath}`);
    } else {
      // Without --start-new, use existing logic
      const existingDirs = await findExecutionDirs(dataHash);

      if (existingDirs.length > 0) {
        // Use most recent
        finalExecutionPath = existingDirs[0];
        isResuming = true;
        console.log(`Resuming execution in: ${finalExecutionPath}`);
      } else {
        // Create new execution directory
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 6);
        const dirName = `${timestamp}-${random}-${dataHash.substring(0, 6)}`;
        finalExecutionPath = path.join(executionRoot, dirName);
        await fs.promises.mkdir(finalExecutionPath, { recursive: true });
        isNewExecution = true;
        console.log(`Created execution directory: ${finalExecutionPath}`);
      }
    }
  }

  const dataPathInExecutionDir = path.join(finalExecutionPath, "read_only_data_source");

  // Set up data access (symlink or copy)
  let linkType: "symlink" | "copy" = useSymlink ? "symlink" : "copy";
  if (isNewExecution || !fs.existsSync(dataPathInExecutionDir)) {
    if (stats.isDirectory()) {
      // --- Directory Logic (Existing, but with new destination) ---
      if (useSymlink) {
        try {
          await fs.promises.symlink(readOnlySourceDataPath, dataPathInExecutionDir, "dir");
        } catch (error) {
          console.warn(`Failed to create symlink for directory: ${error}. Falling back to copy.`);
          await copyDirectory(readOnlySourceDataPath, dataPathInExecutionDir);
          linkType = "copy";
        }
      } else {
        await copyDirectory(readOnlySourceDataPath, dataPathInExecutionDir);
      }
    } else if (stats.isFile()) {
      // --- File Logic (New) ---
      // 1. Create the 'read_only_data_source' directory
      await fs.promises.mkdir(dataPathInExecutionDir, { recursive: true });
      const destFilePath = path.join(dataPathInExecutionDir, path.basename(readOnlySourceDataPath));

      // 2. Link or copy the file into it
      if (useSymlink) {
        try {
          await fs.promises.symlink(readOnlySourceDataPath, destFilePath);
        } catch (error) {
          console.warn(`Failed to create symlink for file: ${error}. Falling back to copy.`);
          await fs.promises.copyFile(readOnlySourceDataPath, destFilePath);
          linkType = "copy";
        }
      } else {
        await fs.promises.copyFile(readOnlySourceDataPath, destFilePath);
      }
    }
  }

  // Create/update metadata
  const metaDir = path.join(finalExecutionPath, ".strandweave");
  await fs.promises.mkdir(metaDir, { recursive: true });

  const existingMetaPath = path.join(metaDir, "execution-meta.json");
  const existingMeta = fs.existsSync(existingMetaPath)
    ? JSON.parse(await fs.promises.readFile(existingMetaPath, "utf-8"))
    : null;

  const meta = {
    version: "1.0.0",
    readOnlySourceDataPath,
    readOnlySourceResolvedDataPath: await fs.promises.realpath(readOnlySourceDataPath),
    dataHash,
    strandHash,
    strandPath,
    linkType,
    createdAt: isNewExecution
      ? new Date().toISOString()
      : (existingMeta?.createdAt ?? new Date().toISOString()),
    lastUsed: new Date().toISOString(),
  };

  await fs.promises.writeFile(existingMetaPath, JSON.stringify(meta, null, 2));

  return {
    readOnlySourceDataPath,
    executionPath: finalExecutionPath,
    dataPathInExecutionDir,
    dataHash,
    strandHash,
    isNewExecution,
    isResuming,
    linkType,
    configChanged,
    meta,
  };
}

async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Handle symlinks
      const target = await fs.promises.readlink(srcPath);
      await fs.promises.symlink(target, destPath);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
    }
    // Skip other types (FIFO, socket, etc.)
  }
}
