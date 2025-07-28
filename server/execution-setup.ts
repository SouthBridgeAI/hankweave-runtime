import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "./config.js";
import { findExecutionDirs, hashDataSource } from "./data-hasher.js";

export interface ExecutionSetup {
  readOnlySourceDataPath: string; // Absolute path to original data
  executionPath: string; // Absolute path where we run
  dataPathInExecutionDir: string; // Always executionPath + '/read_only_data_source'
  dataHash: string;
  isNewExecution: boolean;
  isResuming: boolean;
  linkType: "symlink" | "copy";
  meta: {
    createdAt: string;
    lastUsed: string;
    readOnlySourceResolvedDataPath: string;
    version: string;
  };
}

export async function setupExecutionEnvironment(options: {
  readOnlySourceDataPath: string; // Already resolved to absolute
  executionPath?: string; // Already resolved to absolute, or undefined
  useSymlink?: boolean; // Default true, --copy flag sets to false
  dataHashTimeLimit?: number; // Time limit for hashing
  startNew?: boolean; // Force new execution
}): Promise<ExecutionSetup> {
  const {
    readOnlySourceDataPath,
    executionPath,
    useSymlink = true,
    dataHashTimeLimit = DEFAULT_CONFIG.dataHashTimeLimit,
    startNew = false,
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

  if (executionPath) {
    // Explicit execution path provided

    if (startNew) {
      // With --start-new, directory must not exist OR be empty
      if (fs.existsSync(executionPath)) {
        const entries = await fs.promises.readdir(executionPath);
        if (entries.length > 0) {
          throw new Error(
            `Cannot use --start-new with non-empty execution directory: ${executionPath}\n` +
              `Directory contains ${entries.length} items. Please use an empty directory or omit --execution.`,
          );
        }
        // Directory exists but is empty - OK to use
        console.log(`Using empty directory for new execution: ${executionPath}`);
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
      if (executionPath.includes("/.tadpole-executions/") && executionPath.includes("/data")) {
        throw new Error("Cannot create execution inside another execution directory");
      }

      // Prevent using data source as execution
      if (path.resolve(executionPath) === path.resolve(readOnlySourceDataPath)) {
        throw new Error("Execution directory cannot be the same as data source");
      }

      // Check if it has execution metadata
      const metaPath = path.join(executionPath, ".tadpole", "execution-meta.json");
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
    const executionRoot = path.join(os.homedir(), ".tadpole-executions");
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
  const metaDir = path.join(finalExecutionPath, ".tadpole");
  await fs.promises.mkdir(metaDir, { recursive: true });

  const meta = {
    version: "1.0.0",
    readOnlySourceDataPath,
    readOnlySourceResolvedDataPath: await fs.promises.realpath(readOnlySourceDataPath),
    dataHash,
    linkType,
    createdAt: isNewExecution
      ? new Date().toISOString()
      : fs.existsSync(path.join(metaDir, "execution-meta.json"))
        ? JSON.parse(await fs.promises.readFile(path.join(metaDir, "execution-meta.json"), "utf-8"))
            .createdAt
        : new Date().toISOString(),
    lastUsed: new Date().toISOString(),
  };

  await fs.promises.writeFile(
    path.join(metaDir, "execution-meta.json"),
    JSON.stringify(meta, null, 2),
  );

  return {
    readOnlySourceDataPath,
    executionPath: finalExecutionPath,
    dataPathInExecutionDir,
    dataHash,
    isNewExecution,
    isResuming,
    linkType,
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
