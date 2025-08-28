import fs from "node:fs";
import path from "node:path";
import { fileResolver } from "./file-resolver.js";
import type { ClientCommand, FileNode, ServerEvent } from "./types/types.js";
import type { WebSocketLogEntry } from "./types/websocket-log-types.js";

// ============================================================================
// ID Generation
// ============================================================================

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// Logger
// ============================================================================

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

// ============================================================================
// File System Utilities
// ============================================================================

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

// ============================================================================
// Shell Utilities
// ============================================================================

/**
 * Escape a string for safe use in shell commands.
 * Replaces single quotes with '\'' and wraps in single quotes.
 */
export function escapeShellArg(arg: string): string {
  // Replace all single quotes with '\''
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ============================================================================
// Error Utilities
// ============================================================================

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

// ============================================================================
// Exhaustive Checking
// ============================================================================

/**
 * Exhaustive checking helper for switch statements.
 * Use this in the default case to ensure all union cases are handled.
 * TypeScript will error if a case is missing.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

// ============================================================================
// Directory Utilities
// ============================================================================

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

export async function copyFiles(
  sourceDirectory: string,
  filesToCopy: string[],
  destinationDirectory: string,
  logger: Logger,
): Promise<void> {
  logger.log(`Copying files from ${sourceDirectory} to ${destinationDirectory}`, "debug");

  await fs.promises.mkdir(destinationDirectory, { recursive: true });

  // Resolve glob patterns from within the execution directory
  const files = await fileResolver.resolveFiles(sourceDirectory, filesToCopy);

  if (files.length === 0) {
    logger.log("No files matched the copy globs.", "debug");
    return;
  }

  logger.log(`Resolved files: ${files.join(", ")}`, "debug");

  for (const file of files) {
    const sourcePath = path.join(sourceDirectory, file);
    const destPath = path.join(destinationDirectory, file);

    logger.log(`Copying ${sourcePath} to ${destPath}`, "debug");

    // Ensure the destination subdirectory exists
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

    // Using fs.cp for robust recursive copying
    await fs.promises.cp(sourcePath, destPath, { recursive: true });
  }
}
