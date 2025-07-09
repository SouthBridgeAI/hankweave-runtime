import fs from "node:fs";
import path from "node:path";

export class FileOperations {
  static async getDirectorySize(dirPath: string, timeoutMs = 30000): Promise<number> {
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

  static formatSize(bytes: number): string {
    if (bytes === 0) return "0 B";

    const units = ["B", "KB", "MB", "GB"];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${(bytes / k ** i).toFixed(1)} ${units[i]}`;
  }

  static async removeDirectory(dirPath: string, projectPath: string): Promise<void> {
    // Safety check: ensure we're within project directory
    const absolutePath = path.resolve(dirPath);
    const absoluteProjectPath = path.resolve(projectPath);
    const relative = path.relative(absoluteProjectPath, absolutePath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to delete directory outside project: ${dirPath}`);
    }

    // Additional safety: don't delete critical directories
    const basename = path.basename(dirPath);
    const dangerousDirs = [".git", "node_modules", "/", "~", "."];
    if (dangerousDirs.includes(basename) || dangerousDirs.includes(dirPath)) {
      throw new Error(`Refusing to delete potentially dangerous directory: ${dirPath}`);
    }

    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }

  static async removeFile(filePath: string, projectPath: string): Promise<void> {
    // Safety check: ensure we're within project directory
    const absolutePath = path.resolve(filePath);
    const absoluteProjectPath = path.resolve(projectPath);
    const relative = path.relative(absoluteProjectPath, absolutePath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to delete file outside project: ${filePath}`);
    }

    await fs.promises.unlink(filePath);
  }
}
