import fs from "node:fs";
import path from "node:path";
import glob from "fast-glob";
import { fileResolver } from "./file-resolver.js";
import type { ClientCommand, FileNode, ServerEvent } from "./types/types.js";
import type { WebSocketLogEntry } from "./types/websocket-log-types.js";

// -------------
// ID Generation
// -------------

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// -------------
// Logger
// -------------

export class Logger {
  constructor(private logFile: string) {}

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

    try {
      const logsDir = path.dirname(this.logFile);
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      fs.appendFileSync(this.logFile, logLine);
    } catch (error) {
      // If we can't write to file (e.g., during shutdown), just log to console
      console.error(`Failed to write to log file: ${error}`);
    }

    if (level === "error") {
      console.error(logLine.trim());
    }
  }

  /**
   * Log WebSocket traffic as JSONL (JSON Lines format).
   * Each line is a complete JSON object representing a WebSocket message.
   *
   * @param socketLogFile - Path to the websocket log file
   * @param direction - Whether this is an incoming or outgoing message
   * @param data - The actual WebSocket message (ClientCommand or ServerEvent)
   */
  logWebSocketMessage(
    socketLogFile: string,
    direction: "in" | "out",
    data: ClientCommand | ServerEvent,
  ): void {
    try {
      // Create the log entry with minimal wrapper
      const logEntry: WebSocketLogEntry = {
        loggedAt: new Date().toISOString(),
        direction,
        message: data,
        metadata: {
          // Calculate message size
          size: JSON.stringify(data).length,
        },
      };

      // Write as a single line of JSON (JSONL format)
      const logLine = `${JSON.stringify(logEntry)}\n`;

      const logsDir = path.dirname(socketLogFile);
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      fs.appendFileSync(socketLogFile, logLine);
    } catch (error) {
      // If we can't log to file, at least log the error
      console.error(`Failed to log WebSocket message: ${error}`);
    }
  }

  /**
   * @deprecated Use logWebSocketMessage instead
   */
  logSocketTraffic(socketLogFile: string, direction: "in" | "out", data: unknown): void {
    // For backward compatibility, convert to new format
    this.logWebSocketMessage(socketLogFile, direction, data as ClientCommand | ServerEvent);
  }
}

// -------------
// File System Utilities
// -------------

/**
 * Build a hierarchical file tree from files matching a pattern.
 *
 * Creates a tree structure suitable for UI display, with directories
 * as nodes containing their children. Used for filetree.updated events.
 * Includes last modified times for files.
 *
 * @param projectPath - Base directory
 * @param pattern - Glob pattern to match files
 * @returns Root nodes of the file tree
 */
export async function buildFileTree(projectPath: string, pattern: string): Promise<FileNode[]> {
  const tree: FileNode[] = [];

  try {
    // Use unified file resolver to respect gitignore
    const resolvedFiles = await fileResolver.resolveFiles(projectPath, [pattern]);

    // Get file metadata for each resolved file
    const files = await Promise.all(
      resolvedFiles.map(async (filePath) => {
        const fullPath = path.join(projectPath, filePath);
        const stats = await fs.promises.stat(fullPath);
        const content = await fs.promises.readFile(fullPath, "utf-8");
        return {
          path: filePath,
          content,
          lastModified: stats.mtime.toISOString(),
        };
      }),
    );

    const dirMap = new Map<string, FileNode>();

    // Sort files to ensure directories are created before their children
    files.sort((a, b) => a.path.localeCompare(b.path));

    for (const file of files) {
      // Normalize path to remove leading "./"
      const normalizedPath = file.path.startsWith("./") ? file.path.slice(2) : file.path;
      const parts = normalizedPath.split(path.sep);
      let currentPath = "";
      let parent: FileNode | null = null;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath = currentPath ? path.join(currentPath, part) : part;

        if (i === parts.length - 1) {
          // This is a file
          const fileNode: FileNode = {
            name: part,
            path: currentPath,
            isDirectory: false,
            lastModified: file.lastModified,
            children: [], // Empty array for files
          };

          if (parent) {
            if (!parent.children) parent.children = [];
            parent.children.push(fileNode);
          } else {
            tree.push(fileNode);
          }
        } else {
          // This is a directory
          if (!dirMap.has(currentPath)) {
            const dirNode: FileNode = {
              name: part,
              path: currentPath,
              isDirectory: true,
              children: [],
            };
            dirMap.set(currentPath, dirNode);

            if (parent) {
              if (!parent.children) parent.children = [];
              parent.children.push(dirNode);
            } else {
              tree.push(dirNode);
            }
          }
          parent = dirMap.get(currentPath) || null;
        }
      }
    }
  } catch (error) {
    // Error building file tree
    console.error("Error building file tree:", error);
  }

  return tree;
}

// -------------
// Shell Utilities
// -------------

/**
 * Escape a string for safe use in shell commands.
 * Replaces single quotes with '\'' and wraps in single quotes.
 */
export function escapeShellArg(arg: string): string {
  // Replace all single quotes with '\''
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// -------------
// Error Utilities
// -------------

/**
 * Type guard to check if a value is an Error instance.
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

/**
 * Convert any value to an Error instance.
 * If already an Error, returns it unchanged.
 * Otherwise creates a new Error with string representation.
 */
export function toError(error: unknown): Error {
  if (isError(error)) return error;
  if (typeof error === "string") return new Error(error);
  return new Error(String(error));
}

// -------------
// Type Utilities
// -------------

/**
 * Helper type to check if two types are exactly equal at compile time.
 * Returns `true` if the types match, `never` if they don't.
 *
 * Use this to enforce type constraints that must be validated at compile time.
 *
 * @example
 * // Ensure all event types are categorized
 * const _check: AssertEqual<EventType, CategoryA | CategoryB> = true;
 */
export type AssertEqual<T, U> = (<G>() => G extends T ? 1 : 2) extends <G>() => G extends U ? 1 : 2
  ? true
  : never;

// -------------
// Exhaustive Checking
// -------------

/**
 * Exhaustive checking helper for switch statements.
 * Use this in the default case to ensure all union cases are handled.
 * TypeScript will error if a case is missing.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

// -------------
// Directory Utilities
// -------------

/**
 * Calculate the total size of a directory recursively.
 * Includes a timeout to prevent hanging on large directories.
 */
export async function getDirectorySize(
  dirPath: string,
  timeoutMs = 30000, // Preserve timeout feature from cleanup folder
): Promise<number> {
  let totalSize = 0;
  const startTime = Date.now();

  async function walkDir(currentPath: string): Promise<void> {
    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Directory size calculation timed out after ${timeoutMs}ms`);
    }

    const entries = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else {
        try {
          const stats = await fs.promises.stat(fullPath);
          totalSize += stats.size;
        } catch {
          // Ignore files we can't stat
        }
      }
    }
  }

  await walkDir(dirPath);
  return totalSize;
}

/**
 * Format a byte size into a human-readable string.
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / k ** i).toFixed(1)} ${units[i]}`;
}

/**
 * Copy files from a source directory to a destination directory using glob patterns.
 *
 * This function uses fast-glob directly to resolve file patterns without respecting
 * .gitignore rules (unlike UnifiedFileResolver), ensuring all matching files are copied regardless of git ignore status.
 *
 * @param sourceDirectory - The source directory path from which to copy files
 * @param filesToCopy - Array of glob patterns to match files for copying (e.g., `["*.txt"]`)
 * @param destinationDirectory - The destination directory path where files will be copied
 * @param logger - Logger instance for debug and info messages
 * @returns Promise that resolves when all files have been copied
 *
 */
export async function copyFiles(
  sourceDirectory: string,
  filesToCopy: string[],
  destinationDirectory: string,
  logger: Logger,
): Promise<void> {
  // Log the copy operation with source, destination, and glob patterns
  logger.log(
    `Copying files from ${sourceDirectory} to ${destinationDirectory} using globs ${filesToCopy.join(
      ", ",
    )}`,
    "debug",
  );

  // Ensure destination directory exists before starting copy operations
  await fs.promises.mkdir(destinationDirectory, { recursive: true });

  // Use fast-glob directly to resolve patterns without gitignore filtering
  // This ensures all matching files are found, regardless of .gitignore rules
  const files = await glob(filesToCopy, {
    cwd: sourceDirectory, // Set working directory for glob patterns
    dot: true, // Include hidden files (files starting with .)
    onlyFiles: false, // Include directories in results for recursive copying
  });

  // Early return if no files match the provided glob patterns
  if (files.length === 0) {
    logger.log("No files matched the copy globs.", "debug");
    return;
  }

  // Log all resolved files for debugging purposes
  logger.log(`Resolved files: ${files.join(", ")}`, "debug");

  // Process each matched file/directory
  for (const file of files) {
    // Build absolute paths for source and destination
    const sourcePath = path.join(sourceDirectory, file);
    const destPath = path.join(destinationDirectory, file);

    logger.log(`Copying ${sourcePath} to ${destPath}`, "debug");

    // Skip files that don't exist (edge case handling)
    if (!fs.existsSync(sourcePath)) {
      logger.log(`Source file ${sourcePath} does not exist`, "info");
      continue;
    }

    // Create parent directories in destination if they don't exist
    // This preserves the directory structure from source
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

    // Copy the file or directory recursively using Node.js built-in fs.cp
    // The recursive option handles both files and directories uniformly
    await fs.promises.cp(sourcePath, destPath, { recursive: true });
  }
}

// -------------
// Object Utilities
// -------------

/**
 * Deep merge multiple objects with proper handling of nested structures.
 *
 * Merging rules:
 * - Plain objects are merged recursively
 * - Arrays are replaced (not merged) - later values overwrite earlier ones
 * - Primitives (string, number, boolean, null) are replaced
 * - undefined values are skipped (don't overwrite existing values)
 * - Later sources take precedence over earlier ones
 *
 * @param sources - Objects to merge, in priority order (later = higher priority)
 * @returns Merged object with all properties from all sources
 *
 * @example
 * const defaults = { port: 8080, sentinel: { enabled: true, timeout: 1000 } };
 * const userConfig = { port: 3000, sentinel: { timeout: 5000 } };
 * const merged = deepMerge(defaults, userConfig);
 * // Result: { port: 3000, sentinel: { enabled: true, timeout: 5000 } }
 */
export function deepMerge<T extends Record<string, unknown>>(...sources: Array<T | undefined>): T {
  const result = {} as T;

  for (const source of sources) {
    // Skip undefined sources
    if (source === undefined) {
      continue;
    }

    // Iterate over all keys in the source object
    for (const key in source) {
      // Skip if the key is not an own property
      if (!Object.hasOwn(source, key)) {
        continue;
      }

      const sourceValue = source[key];

      // Skip undefined values - they don't overwrite existing values
      if (sourceValue === undefined) {
        continue;
      }

      const currentValue = result[key];

      // If both values are plain objects, merge them recursively
      if (isPlainObject(currentValue) && isPlainObject(sourceValue)) {
        result[key] = deepMerge(
          currentValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>,
        ) as T[Extract<keyof T, string>];
      } else {
        // For all other cases (arrays, primitives, null), replace the value
        result[key] = sourceValue;
      }
    }
  }

  return result;
}

/**
 * Check if a value is a plain object (not an array, not null, not a class instance).
 * Plain objects are created with {} or new Object().
 *
 * @param value - Value to check
 * @returns true if the value is a plain object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  // Check if it's an array
  if (Array.isArray(value)) {
    return false;
  }

  // Check if it's a plain object (created with {} or new Object())
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
