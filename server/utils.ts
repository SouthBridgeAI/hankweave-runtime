import fs from "node:fs";
import path from "node:path";
import type { Message, Peer } from "crossws";
import { serve as crosswsServe } from "crossws/server";
// Import cross-platform WebSocket client from crossws
// This works in Node.js (18+), Bun, Deno, and browsers
import WebSocket from "crossws/websocket";
import glob from "fast-glob";
import merge from "lodash.merge";
import { fileResolver } from "./file-resolver.js";
import type { ClientCommand, FileNode, ServerEvent } from "./types/types.js";
import type { WebSocketLogEntry } from "./types/websocket-log-types.js";

// Re-export WebSocket for use throughout the codebase
// This hides the crossws dependency as an implementation detail
export { WebSocket };

// -------------
// ID Generation
// -------------

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
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
// Runtime Detection
// -------------

/**
 * Supported JavaScript runtimes.
 */
export type Runtime = "bun" | "node" | "deno";

/**
 * Detect the current JavaScript runtime.
 * Uses global object inspection following the crossws pattern.
 *
 * @returns The detected runtime ('bun', 'deno', or 'node')
 */
export function detectRuntime(): Runtime {
  if ("Bun" in globalThis) return "bun";
  if ("Deno" in globalThis) return "deno";
  return "node";
}

/**
 * Detects if we're running from a compiled Bun executable.
 *
 * When compiled, Bun puts files in a virtual filesystem at:
 * - On Unix: /$bunfs/root/...
 * - On Windows: X:/~BUN/root/... (drive letter varies)
 *
 * @returns true if running from a compiled executable, false otherwise
 */
export function isCompiledExecutable(): boolean {
  console.log("\n🔍 isCompiledExecutable() detection:");

  // Allow override for testing (avoids Bun's module mock persistence bug)
  // https://github.com/oven-sh/bun/issues/7823
  if (process.env.STRANDWEAVE_TEST_IS_COMPILED !== undefined) {
    const result = process.env.STRANDWEAVE_TEST_IS_COMPILED === "true";
    console.log(`  ✓ Using test override: ${result}`);
    return result;
  }

  // We only support Bun compiled executables
  const isBun = typeof Bun !== "undefined";
  console.log(`  Runtime: ${isBun ? "Bun" : "Other (Node.js/Deno)"}`);

  if (!isBun) {
    console.log("  ✗ Not running in Bun, cannot be compiled executable");
    return false;
  }

  // Simple check: if we're running from Bun's virtual filesystem, we're compiled
  // On Unix: /$bunfs/root/...
  // On Windows: X:\~BUN\ or X:/~BUN/ (drive letter varies, slashes can be either direction)
  const path = import.meta.path;
  const isCompiled =
    path.startsWith("/$bunfs/") || // Unix
    /^[A-Z]:[/\\]~BUN[/\\]/i.test(path); // Windows (both forward and backslashes)
  return isCompiled;
}

/**
 * Get the appropriate command array to run a script in the current runtime.
 * This ensures shims and other scripts are executed with the correct runtime.
 *
 * @param scriptPath - Path to the script to execute
 * @returns Command array suitable for spawn/exec (e.g., ['bun', scriptPath])
 *
 * @example
 * ```ts
 * // In Bun: ['bun', '/path/to/shim.mjs']
 * // In Node: ['node', '/path/to/shim.mjs']
 * // In Deno: ['deno', 'run', '--allow-all', '/path/to/shim.mjs']
 * const cmd = getRuntimeCommand('/path/to/shim.mjs');
 * spawn(cmd[0], cmd.slice(1), options);
 * ```
 */
export function getRuntimeCommand(scriptPath: string): string[] {
  const runtime = detectRuntime();
  switch (runtime) {
    case "bun":
      return ["bun", scriptPath];
    case "deno":
      return ["deno", "run", "--allow-all", scriptPath];
    case "node":
      return ["node", scriptPath];
  }
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
 * Uses lodash.merge for deep merging. Note that arrays are merged by index
 * (not replaced entirely).
 *
 * Merging rules:
 * - Plain objects are merged recursively
 * - Arrays are merged by index (e.g., [1,2,3] + [4,5] = [4,5,3])
 * - Primitives (string, number, boolean, null) are replaced
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
  return merge({}, ...sources) as T;
}

// -------------
// File System Reliability Utilities
// -------------

/**
 * Rename file with retry logic for Windows file locking issues.
 *
 * On Windows, EPERM/EBUSY errors can occur transiently due to:
 * - Antivirus scanning (Windows Defender in CI environments)
 * - File handles not fully released after previous operations
 * - Windows filesystem timing differences vs Unix
 *
 * This implements exponential backoff retry to handle these transient locks.
 *
 * @param source - Source file path
 * @param target - Target file path
 * @param options - Retry configuration options
 * @param options.maxRetries - Maximum number of retry attempts (default: 5)
 * @param options.initialDelay - Initial delay in milliseconds (default: 10ms)
 * @param options.logger - Optional logger for debugging retry attempts
 * @returns Promise that resolves when rename succeeds
 * @throws Error if rename fails after all retries or encounters non-retryable error
 *
 * @example
 * ```ts
 * // Basic usage
 * await renameWithRetry('temp.json', 'state.json');
 *
 * // With custom retry settings and logging
 * await renameWithRetry('temp.json', 'state.json', {
 *   maxRetries: 10,
 *   initialDelay: 20,
 *   logger: myLogger
 * });
 * ```
 */
export async function renameWithRetry(
  source: string,
  target: string,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    logger?: Logger;
  } = {},
): Promise<void> {
  const { maxRetries = 5, initialDelay = 10, logger } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fs.promises.rename(source, target);
      return; // Success!
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      lastError = err;

      // Only retry on file locking errors
      if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
        if (attempt < maxRetries - 1) {
          const delay = initialDelay * 2 ** attempt;
          logger?.log(
            `File locked, retrying rename in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
            "debug",
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      // Non-retryable error or max retries exceeded
      throw error;
    }
  }

  // Should never reach here, but TypeScript doesn't know that
  throw lastError || new Error("Rename failed after retries");
}

/**
 * Synchronous version of renameWithRetry for use in synchronous contexts.
 *
 * Same behavior as renameWithRetry but uses synchronous fs operations.
 * Useful for scenarios where async/await cannot be used.
 *
 * @param source - Source file path
 * @param target - Target file path
 * @param options - Retry configuration options
 * @param options.maxRetries - Maximum number of retry attempts (default: 5)
 * @param options.initialDelay - Initial delay in milliseconds (default: 10ms)
 * @param options.logger - Optional logger for debugging retry attempts
 * @throws Error if rename fails after all retries or encounters non-retryable error
 *
 * @example
 * ```ts
 * renameWithRetrySync('temp.json', 'state.json');
 * ```
 */
export function renameWithRetrySync(
  source: string,
  target: string,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    logger?: Logger;
  } = {},
): void {
  const { maxRetries = 5, initialDelay = 10, logger } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.renameSync(source, target);
      return; // Success!
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      lastError = err;

      // Only retry on file locking errors
      if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
        if (attempt < maxRetries - 1) {
          const delay = initialDelay * 2 ** attempt;
          logger?.log(
            `File locked, retrying rename in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
            "debug",
          );
          // Synchronous sleep using busy-wait (not ideal but necessary for sync context)
          const start = Date.now();
          while (Date.now() - start < delay) {
            // Busy wait
          }
          continue;
        }
      }

      // Non-retryable error or max retries exceeded
      throw error;
    }
  }

  // Should never reach here, but TypeScript doesn't know that
  throw lastError || new Error("Rename failed after retries");
}

// -------------
// Server Utilities
// -------------

/**
 * Abstraction over server instances providing a common interface.
 * This allows the codebase to be runtime-agnostic.
 */
export interface StrandweaveServer {
  /** Stop the server and clean up resources */
  stop(): void;
}

/**
 * Runtime-agnostic WebSocket interface.
 * Provides a common interface that works across Bun, Node.js, and other runtimes.
 */
export interface StrandweaveWebSocket<T = unknown> {
  /** Custom data attached to this WebSocket connection */
  data: T;
  /** Send a message to the client */
  send(message: string | Buffer): void;
  /** Close the WebSocket connection */
  close(code?: number, reason?: string): void;
}

/**
 * Configuration options for creating an HTTP or WebSocket server.
 * Provides a runtime-agnostic interface for both HTTP and WebSocket servers.
 *
 * The generic type T represents the WebSocket connection data type.
 */
export interface ServeOptions<T = unknown> {
  /** Port number to listen on */
  port: number;
  /** Idle timeout in seconds (optional, only for HTTP servers) */
  idleTimeout?: number;
  /** HTTP request handler (required for HTTP servers) */
  fetch?: (request: Request, server?: unknown) => Response | Promise<Response> | undefined;
  /** WebSocket handlers (required for WebSocket servers) */
  websocket?: {
    /**
     * Called before upgrading to WebSocket.
     * Return context data to attach to the connection.
     */
    upgrade?: (request: Request) => T | Promise<T>;
    /** Called when a WebSocket connection is opened */
    open?: (ws: StrandweaveWebSocket<T>) => void;
    /** Called when a message is received on the WebSocket */
    message?: (ws: StrandweaveWebSocket<T>, message: string | Buffer) => void;
    /** Called when a WebSocket connection is closed */
    close?: (ws: StrandweaveWebSocket<T>) => void;
  };
}

/**
 * Adapter that wraps a crossws Peer to provide the Strand weave WebSocket interface.
 * Maps Peer.context to .data and adapts method signatures.
 */
class PeerAdapter<T> implements StrandweaveWebSocket<T> {
  constructor(private peer: Peer) {
    // Initialize context if it doesn't exist
    if (!this.peer.context) {
      // biome-ignore lint/suspicious/noExplicitAny: crossws Peer type doesn't expose context setter
      (this.peer as any).context = {};
    }
  }

  get data(): T {
    return this.peer.context as T;
  }

  set data(value: T) {
    // Cannot replace context object (readonly), so update its properties
    const context = this.peer.context as Record<string, unknown>;
    // Clear existing properties
    for (const key in context) {
      delete context[key];
    }
    // Copy new properties
    Object.assign(context, value);
  }

  send(message: string | Buffer): void {
    this.peer.send(message);
  }

  close(code?: number, reason?: string): void {
    this.peer.close(code, reason);
  }
}

/**
 * Create an HTTP or WebSocket server using crossws.
 *
 * This provides a runtime-agnostic interface that works with Bun, Node.js, Deno,
 * and other runtimes via the crossws library.
 *
 * @param options - Server configuration options
 * @returns Server instance with stop() method
 *
 * @example
 * // HTTP server
 * const server = serve({
 *   port: 3000,
 *   fetch: async (req) => new Response("Hello"),
 * });
 *
 * @example
 * // WebSocket server
 * const server = serve({
 *   port: 8080,
 *   websocket: {
 *     open: (ws) => console.log("connected"),
 *     message: (ws, msg) => console.log(msg),
 *   },
 *   fetch: (req, server) => server.upgrade(req),
 * });
 */
export function serve<T = unknown>(options: ServeOptions<T>): StrandweaveServer {
  // Convert our options to crossws format
  // biome-ignore lint/suspicious/noExplicitAny: crossws options type is complex and runtime-specific
  const crosswsOptions: any = {
    port: options.port,
    fetch: options.fetch,
  };

  // If WebSocket handlers are provided, wrap them with adapters
  if (options.websocket) {
    const { upgrade, open, message, close } = options.websocket;

    // Map to maintain consistent adapter instances per peer
    const peerAdapters = new WeakMap<Peer, PeerAdapter<T>>();

    const getAdapter = (peer: Peer): PeerAdapter<T> => {
      let adapter = peerAdapters.get(peer);
      if (!adapter) {
        adapter = new PeerAdapter<T>(peer);
        peerAdapters.set(peer, adapter);
      }
      return adapter;
    };

    crosswsOptions.websocket = {
      upgrade: upgrade
        ? async (req: Request) => {
            const context = await upgrade(req);
            return { context };
          }
        : undefined,

      open: open
        ? (peer: Peer) => {
            open(getAdapter(peer));
          }
        : undefined,

      message: message
        ? (peer: Peer, msg: Message) => {
            // Convert Message to string or Buffer
            const data = msg.rawData;
            const messageData =
              typeof data === "string" || Buffer.isBuffer(data) ? data : msg.text();
            message(getAdapter(peer), messageData);
          }
        : undefined,

      close: close
        ? (peer: Peer) => {
            close(getAdapter(peer));
          }
        : undefined,
    };
  }

  const server = crosswsServe(crosswsOptions);

  return {
    stop: () => {
      // crossws servers have a close() method
      if (server && typeof server.close === "function") {
        server.close();
      }
    },
  };
}
