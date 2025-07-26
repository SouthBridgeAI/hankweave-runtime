import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Generate a hash based on directory structure with depth and time limits
 * Uses file names, types, sizes, and modification times
 */
export async function hashDataDirectory(
  dataPath: string,
  timeLimit: number = 5000,
): Promise<string> {
  const maxDepth = 3;
  const startTime = Date.now();
  const entries: string[] = [];

  async function scan(currentDir: string, depth: number) {
    // Check time limit
    if (Date.now() - startTime > timeLimit) {
      entries.push("TIMEOUT:scan_truncated");
      return;
    }

    if (depth > maxDepth) return;

    try {
      const items = await fs.promises.readdir(currentDir, { withFileTypes: true });

      // Sort for deterministic hashing
      items.sort((a, b) => a.name.localeCompare(b.name));

      // Limit entries per directory to prevent explosion
      const limitedItems = items.slice(0, 100);
      if (items.length > 100) {
        entries.push(`TRUNCATED:${currentDir}:${items.length - 100}_more_items`);
      }

      for (const item of limitedItems) {
        // Skip hidden files and common large directories
        if (
          item.name.startsWith(".") ||
          item.name === "node_modules" ||
          item.name === "__pycache__" ||
          item.name === "dist" ||
          item.name === "build"
        ) {
          continue;
        }

        const fullPath = path.join(currentDir, item.name);
        const relativePath = path.relative(dataPath, fullPath);

        try {
          const stats = await fs.promises.stat(fullPath);

          // Include type, name, size, and mtime for better discrimination
          const mtime = Math.floor(stats.mtimeMs / 1000); // Round to seconds
          const entry = item.isDirectory()
            ? `d:${relativePath}:${mtime}`
            : `f:${relativePath}:${stats.size}:${mtime}`;

          entries.push(entry);

          // Recurse into directories
          if (item.isDirectory() && depth < maxDepth) {
            await scan(fullPath, depth + 1);
          }
        } catch (error) {
          // Skip files we can't stat (permissions, symlinks, etc)
          const errorMsg = error instanceof Error ? error.message : "unknown";
          entries.push(`e:${relativePath}:${errorMsg}`);
        }
      }
    } catch (error) {
      // Skip directories we can't read
      const errorMsg = error instanceof Error ? error.message : "unknown";
      entries.push(`e:${currentDir}:read_error:${errorMsg}`);
    }
  }

  await scan(dataPath, 0);

  // If we got very few entries, add the data path itself for uniqueness
  if (entries.length < 5) {
    entries.push(`path:${dataPath}`);
  }

  // Create hash from sorted entries
  const hash = crypto.createHash("sha256");
  hash.update(entries.join("\n"));
  return hash.digest("hex").substring(0, 12);
}

/**
 * Find existing execution directories for a data hash
 */
export async function findExecutionDirs(dataHash: string): Promise<string[]> {
  const executionRoot = path.join(os.homedir(), ".langton-executions");
  if (!fs.existsSync(executionRoot)) return [];

  const dirs: string[] = [];
  const entries = await fs.promises.readdir(executionRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metaPath = path.join(executionRoot, entry.name, ".langton", "execution-meta.json");
    try {
      const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
      if (meta.dataHash === dataHash) {
        dirs.push(path.join(executionRoot, entry.name));
      }
    } catch {
      // Ignore directories without valid metadata
    }
  }

  return dirs.sort((a, b) => b.localeCompare(a)); // Newest first
}
