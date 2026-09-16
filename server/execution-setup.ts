import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DEFAULT_CONFIG, normalizeHankContent } from "./config.js";
import { findExecutionDirs, hashDataSource } from "./data-hasher.js";
import { ExecutionLayout } from "./execution-layout.js";
import { checkRegularFile } from "./fs-guards.js";
import { ensureJournalRestored } from "./storage/journal-diet.js";
import {
  detectRuntime,
  getManagedExecutionsRoot,
  getMetadata,
  getRuntimeVersion,
  isCompiledExecutable,
} from "./utils.js";

/**
 * Check if we're in a non-interactive environment (CI, tests, pipes, etc.)
 * or an explicitly headless run (--headless must never prompt).
 *
 * Inputs are injectable for testing; they default to the real process state.
 */
export function isNonInteractive(
  options: {
    headless?: boolean;
    env?: NodeJS.ProcessEnv;
    stdin?: { isTTY?: boolean };
    stdout?: { isTTY?: boolean };
  } = {},
): boolean {
  const {
    headless = false,
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
  } = options;

  // --headless runs unattended even from a real terminal
  if (headless) {
    return true;
  }

  // Check for common CI environment variables
  if (env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || env.JENKINS || env.CIRCLECI || env.TRAVIS) {
    return true;
  }

  // Check for test environment (Bun sets NODE_ENV=test)
  if (env.NODE_ENV === "test") {
    return true;
  }

  // Both stdin and stdout must be TTY for interactive mode
  if (!stdin.isTTY || !stdout.isTTY) {
    return true;
  }

  return false;
}

/**
 * Prompt user for confirmation.
 * Returns true if user confirms, false otherwise.
 * In non-interactive environments, returns false immediately.
 */
async function promptConfirmation(message: string, headless = false): Promise<boolean> {
  // In non-interactive mode (CI, tests, pipes, --headless), default to false (don't continue)
  if (isNonInteractive({ headless })) {
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
  executionPath: string; // Absolute path where we run (outer directory)
  agentRootPath: string; // Absolute path to agent workspace (executionPath + '/agentRoot')
  rigArchivePath: string; // Absolute path to archive storage (executionPath + '/rigArchive')
  dataPathInExecutionDir: string; // Always agentRootPath + '/read_only_data_source'
  dataHash: string;
  hankHash?: string; // Hash of hank.json content (for resume detection)
  isNewExecution: boolean;
  isResuming: boolean;
  linkType: "symlink" | "copy";
  configChanged?: boolean; // True if hank.json changed since last run
  meta: {
    createdAt: string;
    lastUsed: string;
    readOnlySourceResolvedDataPath: string;
    version: string;
    hankHash?: string;
    hankPath?: string;
    hankweaveVersion: string;
    environment: {
      invocationMethod: string;
      platform: string;
      arch: string;
      osRelease: string;
      runtime: string;
    };
  };
}

export async function setupExecutionEnvironment(options: {
  readOnlySourceDataPath: string; // Already resolved to absolute
  executionPath?: string; // Already resolved to absolute, or undefined
  useSymlink?: boolean; // Default true, --copy flag sets to false
  dataHashTimeLimit?: number; // Time limit for hashing
  startNew?: boolean; // Force new execution
  forceMode?: boolean; // Force operation in existing directories with .hankweave
  skipConfirmation?: boolean; // Skip confirmation prompts (-y/--yes)
  hankPath?: string; // Path to hank.json for hash tracking
  ignoreDataMismatch?: boolean; // Skip data hash verification on resume
  noWipe?: boolean; // Preserve existing agentRoot/ on --start-new --force
  headless?: boolean; // --headless: never prompt, fail closed like CI
  /**
   * Skip the dieted-journal auto-restore on resume. For flows that only
   * DELETE the execution (--cleanup): restoring first is wasted work, and a
   * damaged diet pair would abort setup and make the cleanup of exactly
   * that broken execution impossible.
   */
  skipJournalRestore?: boolean;
}): Promise<ExecutionSetup> {
  const {
    readOnlySourceDataPath,
    executionPath,
    useSymlink = true,
    dataHashTimeLimit = DEFAULT_CONFIG.dataHashTimeLimit,
    startNew = false,
    forceMode = false,
    skipConfirmation = false,
    hankPath,
    ignoreDataMismatch = false,
    noWipe = false,
    headless = false,
  } = options;

  // Verify data source exists
  if (!fs.existsSync(readOnlySourceDataPath)) {
    throw new Error(`Data source not found: ${readOnlySourceDataPath}`);
  }

  const stats = await fs.promises.stat(readOnlySourceDataPath);
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new Error(`Data source is not a file or directory: ${readOnlySourceDataPath}`);
  }

  // Calculate data hash (silent - the hash is displayed elsewhere)
  const dataHash = await hashDataSource(readOnlySourceDataPath, dataHashTimeLimit);

  let finalExecutionPath: string;
  let isNewExecution = false;
  let isResuming = false;
  let configChanged = false;
  let relinkDataSource = false;

  // Calculate hank hash if path provided. This read happens before hank
  // validation (resolveSettings swallows loader errors), so it must reject
  // non-regular files itself — reading a FIFO here would block forever.
  let hankHash: string | undefined;
  if (hankPath) {
    const problem = checkRegularFile(hankPath, { read: false });
    if (problem?.kind === "irregular") {
      throw new Error(`Hank file ${problem.phrase}: ${hankPath}`);
    }
    if (!problem) {
      const hankContent = await fs.promises.readFile(hankPath, "utf-8");
      // Hash the content as ensureSchemaUrl will leave it on disk: it rewrites
      // a schema-less hank.json AFTER this hash is recorded, so hashing the raw
      // content would make the very next resume report a phantom config change.
      hankHash = crypto
        .createHash("sha256")
        .update(normalizeHankContent(hankContent))
        .digest("hex");
    }
  }

  if (executionPath) {
    // Explicit execution path provided

    // Tier 1: Managed execution directory safety
    const managedExecBase = getManagedExecutionsRoot();
    if (executionPath.startsWith(managedExecBase)) {
      // Allow resuming existing executions (they have .hankweave/execution-meta.json)
      if (!fs.existsSync(new ExecutionLayout(executionPath).metaPath)) {
        throw new Error(
          `❌ Cannot create new execution in ~/.hankweave-executions/.\n` +
            `This location is reserved for auto-managed executions.\n` +
            `Use a different path for --execution, or omit --execution to auto-create here.`,
        );
      }
      // Existing execution found — allow resume
    }

    if (startNew) {
      // With --start-new, implement tiered safety
      if (fs.existsSync(executionPath)) {
        const entries = await fs.promises.readdir(executionPath);

        if (entries.length > 0) {
          const hasHankweave = ExecutionLayout.hasExecutionState(entries);

          // Tier 2: Directory already has Hankweave execution
          if (hasHankweave) {
            if (forceMode) {
              // Backup existing .hankweave (metadata + checkpoint history) so
              // the prior run stays recoverable.
              const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
              const existing = new ExecutionLayout(executionPath);
              const backupPath = existing.stateBackupDir(timestamp);
              await fs.promises.rename(existing.stateDir, backupPath);
              console.log(`📦 Backed up existing execution to: ${backupPath}`);

              // Wipe the prior agentRoot/ so stale outputs from the previous
              // run can't leak into this fresh start (--start-new promises a
              // clean workspace). rigArchive/ and the data link are rebuilt
              // downstream. The .hankweave.backup-* we just created lives at the
              // execution root, not inside agentRoot/, so it is preserved.
              //
              // --no-wipe opts out: the agentRoot/ workspace is kept intact so
              // files placed there out-of-band (without going through data/)
              // survive a forced fresh start. The fresh checkpoint store starts
              // from an empty initial commit and captures the preserved files on
              // the first codon checkpoint.
              const staleAgentRoot = existing.agentRootPath;
              if (noWipe) {
                if (fs.existsSync(staleAgentRoot)) {
                  console.log(
                    `🧷 Preserving existing agent workspace (--no-wipe): ${staleAgentRoot}`,
                  );
                }
              } else if (fs.existsSync(staleAgentRoot)) {
                console.log(`🗑️  Wiping stale agent workspace: ${staleAgentRoot}`);
                await fs.promises.rm(staleAgentRoot, {
                  recursive: true,
                  force: true,
                  maxRetries: 3,
                  retryDelay: 100,
                });
              }
            } else {
              throw new Error(
                `❌ Directory already contains execution state: ${executionPath}/${ExecutionLayout.STATE_DIR}\n` +
                  `This directory has an existing Hankweave execution.\n` +
                  `Options:\n` +
                  `  • Resume this execution (default):\n` +
                  `      hankweave --execution ${executionPath}\n` +
                  `  • Start fresh, backup existing state:\n` +
                  `      hankweave --execution ${executionPath} --start-new --force\n` +
                  `      (state backed up to ${ExecutionLayout.STATE_BACKUP_PREFIX}{timestamp})\n` +
                  `  • Use a different directory:\n` +
                  `      hankweave --execution ./other-dir`,
              );
            }
          } else {
            // Tier 3: Non-empty directory without Hankweave
            const { files, directories } = await countDirectoryContents(executionPath);

            if (!skipConfirmation && !forceMode) {
              console.log(
                `\n⚠️  WARNING: Running in existing non-empty directory: ${executionPath}`,
              );
              console.log(
                `\n  This directory contains ${files} files and ${directories} directories.`,
              );
              console.log(
                `  Hankweave agents will have access to READ and MODIFY files in this directory.`,
              );
              console.log(`\n  Hankweave will create:`);
              console.log(`    ./${ExecutionLayout.STATE_DIR}/           (execution metadata)`);
              console.log(`    ./${ExecutionLayout.AGENT_ROOT}/            (agent workspace)`);
              console.log(
                `    ./${ExecutionLayout.AGENT_ROOT}/${ExecutionLayout.DATA_SOURCE}/  (symlink to data)`,
              );
              console.log(`    ./${ExecutionLayout.RIG_ARCHIVE}/           (archived outputs)`);
              console.log(
                `\n  IMPORTANT: Always use version control. Test hanks on non-critical directories first.\n`,
              );

              const confirmed = await promptConfirmation("Continue?", headless);
              if (!confirmed) {
                throw new Error("Operation cancelled by user.");
              }
            } else if (skipConfirmation) {
              console.warn(
                `⚠️  Running in non-empty directory with confirmation prompts skipped: ${executionPath} (${files} files, ${directories} directories)`,
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
      // Without --start-new flag
      // Behavior: create dir if missing, use if no .hankweave, resume if has .hankweave

      if (!fs.existsSync(executionPath)) {
        // Directory doesn't exist - create it for new execution
        await fs.promises.mkdir(executionPath, { recursive: true });
        console.log(`Created execution directory: ${executionPath}`);
        isNewExecution = true;
      } else {
        // Directory exists - verify it's a directory
        const stats = await fs.promises.stat(executionPath);
        if (!stats.isDirectory()) {
          throw new Error(`Execution path is not a directory: ${executionPath}`);
        }

        // Prevent nested execution
        if (executionPath.includes("/.hankweave-executions/") && executionPath.includes("/data")) {
          throw new Error("Cannot create execution inside another execution directory");
        }

        // Prevent using data source as execution
        if (path.resolve(executionPath) === path.resolve(readOnlySourceDataPath)) {
          throw new Error("Execution directory cannot be the same as data source");
        }

        // Check if it has execution metadata
        const metaPath = new ExecutionLayout(executionPath).metaPath;
        if (fs.existsSync(metaPath)) {
          // Has .hankweave - verify hash and resume
          const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
          if (meta.dataHash !== dataHash) {
            if (ignoreDataMismatch || forceMode) {
              console.warn(
                `⚠️  Data source mismatch (ignored via --force):\n` +
                  `   Expected hash: ${meta.dataHash}\n` +
                  `   Current hash: ${dataHash}`,
              );
              relinkDataSource = true;
            } else {
              throw new Error(
                `❌ Data source has changed since this execution was created.\n` +
                  `  Execution:     ${executionPath}\n` +
                  `  Expected hash: ${meta.dataHash}\n` +
                  `  Current hash:  ${dataHash}\n` +
                  `Options:\n` +
                  `  • Use anyway (keep execution state, use new data):\n` +
                  `      hankweave --execution ${executionPath} --force\n` +
                  `  • Start fresh in this directory:\n` +
                  `      hankweave --execution ${executionPath} --start-new --force\n` +
                  `  • Let Hankweave find/create appropriate execution:\n` +
                  `      hankweave`,
              );
            }
          }

          // Check for hank config changes
          if (hankHash && meta.hankHash && meta.hankHash !== hankHash) {
            configChanged = true;

            // Fail closed with a self-contained error when we can't ask —
            // "Operation cancelled by user." below is reserved for an actual
            // interactive decline.
            if (!skipConfirmation && !forceMode && isNonInteractive({ headless })) {
              throw new Error(
                `hank.json does not match the configuration recorded for this execution ` +
                  `(recorded ${meta.hankHash.substring(0, 12)}..., current ${hankHash.substring(0, 12)}...); ` +
                  `refusing to resume in non-interactive mode.\n` +
                  `Options:\n` +
                  `  • Accept the changed config and resume: add -y\n` +
                  `  • Start a fresh managed execution: omit --execution and add --start-new\n` +
                  `  • Start fresh in this directory: --start-new --force (backs up state; wipes the workspace unless --no-wipe)`,
              );
            }

            console.log(`\n⚠️  WARNING: hank.json has changed since last execution.`);
            console.log(`  Previous hash: ${meta.hankHash.substring(0, 12)}...`);
            console.log(`  Current hash:  ${hankHash.substring(0, 12)}...`);
            console.log(`  Changes may affect execution behavior.\n`);

            if (!skipConfirmation && !forceMode) {
              const confirmed = await promptConfirmation(
                "Continue with modified config?",
                headless,
              );
              if (!confirmed) {
                throw new Error("Operation cancelled by user.");
              }
            }
          }

          isResuming = true;
        } else {
          // Directory exists but no .hankweave - treat as fresh execution
          isNewExecution = true;
          console.log(`Using existing directory as execution directory: ${executionPath}`);
        }
      }

      finalExecutionPath = executionPath;
    }
  } else {
    // Auto-detect or create execution directory
    const executionRoot = getManagedExecutionsRoot();
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

  // Diet P4 resume path (single choke point for every resume path —
  // explicit --execution, managed root, resume-by-dataHash): a dieted
  // journal is auto-restored in place (verified byte-identical) so resume
  // just works; only damaged diet artifacts still abort the setup.
  if (isResuming && !options.skipJournalRestore) {
    await ensureJournalRestored(finalExecutionPath, (message) => console.log(message));
  }

  // Create the new directory structure: agentRoot/ and rigArchive/
  const layout = new ExecutionLayout(finalExecutionPath);
  const { agentRootPath, rigArchivePath, dataPathInExecutionDir } = layout;

  // Ensure agentRoot/ and rigArchive/ directories exist
  await fs.promises.mkdir(agentRootPath, { recursive: true });
  await fs.promises.mkdir(rigArchivePath, { recursive: true });

  // Set up data access (symlink or copy)
  let linkType: "symlink" | "copy" = useSymlink ? "symlink" : "copy";
  if (isNewExecution || relinkDataSource || !fs.existsSync(dataPathInExecutionDir)) {
    // Remove existing read_only_data_source if it exists
    // (handles --start-new --force case where directory was reused)
    if (fs.existsSync(dataPathInExecutionDir)) {
      console.log(`🗑️  Removing existing data link: ${dataPathInExecutionDir}`);
      await fs.promises.rm(dataPathInExecutionDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }

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
  await fs.promises.mkdir(layout.stateDir, { recursive: true });

  // Create empty archive manifest if it doesn't exist (for archiveOnSuccess feature)
  const archiveManifestPath = layout.archiveManifestPath;
  if (!fs.existsSync(archiveManifestPath)) {
    await fs.promises.writeFile(
      archiveManifestPath,
      JSON.stringify({ version: "1.0.0", entries: [] }, null, 2),
    );
  }

  const existingMetaPath = layout.metaPath;
  const existingMeta = fs.existsSync(existingMetaPath)
    ? JSON.parse(await fs.promises.readFile(existingMetaPath, "utf-8"))
    : null;

  const invocationMethod = isCompiledExecutable() ? "binary" : detectRuntime();

  const meta = {
    version: "1.1.0",
    readOnlySourceDataPath,
    readOnlySourceResolvedDataPath: await fs.promises.realpath(readOnlySourceDataPath),
    dataHash,
    hankHash,
    hankPath,
    linkType,
    createdAt: isNewExecution
      ? new Date().toISOString()
      : (existingMeta?.createdAt ?? new Date().toISOString()),
    lastUsed: new Date().toISOString(),
    hankweaveVersion: getMetadata().version,
    environment: {
      invocationMethod,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      runtime: getRuntimeVersion(),
    },
  };

  await fs.promises.writeFile(existingMetaPath, JSON.stringify(meta, null, 2));

  return {
    readOnlySourceDataPath,
    executionPath: finalExecutionPath,
    agentRootPath,
    rigArchivePath,
    dataPathInExecutionDir,
    dataHash,
    hankHash,
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
