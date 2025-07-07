import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { FileNode } from "./types.js";

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

    const logsDir = path.dirname(this.logFile);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    fs.appendFileSync(this.logFile, logLine);
    if (level === "error") {
      console.error(logLine.trim());
    }
  }

  logSocketTraffic(socketLogFile: string, direction: "in" | "out", data: unknown): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${direction.toUpperCase()}] ${JSON.stringify(data)}\n`;

    const logsDir = path.dirname(socketLogFile);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    fs.appendFileSync(socketLogFile, logLine);
  }
}

// ============================================================================
// Session ID Extraction
// ============================================================================

export function extractSessionIdFromLog(logPath: string): string | null {
  try {
    if (!fs.existsSync(logPath)) return null;

    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed?.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === "system" && parsed.subtype === "init" && parsed.session_id) {
            return parsed.session_id;
          }
        } catch {
          // Continue to next line
        }
      }
    }
  } catch {
    // Error reading file
  }
  return null;
}

// ============================================================================
// File System Utilities
// ============================================================================

/**
 * Scan for files matching a glob pattern and read their contents.
 *
 * Used to get initial state of watched files when a phase starts.
 * Ignores common directories like node_modules and .git.
 *
 * @param projectPath - Base directory to search from
 * @param pattern - Glob pattern
 * @returns Array of files with paths, contents, and last modified times
 */
export async function scanWatchedFiles(
  projectPath: string,
  pattern: string,
): Promise<{ path: string; content: string; lastModified: string }[]> {
  const files: { path: string; content: string; lastModified: string }[] = [];

  try {
    const matches = await fg(pattern, {
      cwd: projectPath,
      ignore: ["node_modules/**", ".logs/**", ".git/**"],
      absolute: false,
    });

    for (const match of matches) {
      const fullPath = path.join(projectPath, match);
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const stats = fs.statSync(fullPath);
        files.push({
          path: match,
          content,
          lastModified: stats.mtime.toISOString(),
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Error scanning files
  }

  return files;
}

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
    const files = await scanWatchedFiles(projectPath, pattern);
    const dirMap = new Map<string, FileNode>();

    // Sort files to ensure directories are created before their children
    files.sort((a, b) => a.path.localeCompare(b.path));

    for (const file of files) {
      const parts = file.path.split(path.sep);
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
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
