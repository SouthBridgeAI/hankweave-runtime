import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Ignore } from "ignore";
import ignore from "ignore";

/**
 * Unified file resolver that applies gitignore rules consistently
 * across watching, checkpointing, and cleanup systems.
 */
export class UnifiedFileResolver {
  private ignoreCache = new Map<string, Ignore>();

  /**
   * Resolve files matching the given patterns while respecting gitignore rules.
   *
   * @param projectPath - The root directory to search from
   * @param patterns - Array of glob patterns to match
   * @returns Array of resolved file paths relative to projectPath
   */
  async resolveFiles(projectPath: string, patterns: string[]): Promise<string[]> {
    if (patterns.length === 0) {
      return [];
    }

    // Get ignore rules for this project
    const ig = await this.getIgnoreRules(projectPath);

    // Expand glob patterns
    // Note: We need to get all files first, including those in ignored directories,
    // because gitignore negation patterns might un-ignore specific files
    const allFiles = await fg(patterns, {
      cwd: projectPath,
      absolute: false,
      dot: true,
      onlyFiles: true,
      // Don't follow symlinks
      followSymbolicLinks: false,
      // Don't use gitignore - we'll handle it ourselves
      ignore: [".git/**"],
    });

    // Filter through ignore rules
    // The ignore library expects paths without leading "./"
    return allFiles.filter((file) => {
      const normalizedPath = file.startsWith("./") ? file.slice(2) : file;
      return !ig.ignores(normalizedPath);
    });
  }

  /**
   * Get combined ignore rules for a project by parsing all .gitignore files.
   * Results are cached per project path.
   */
  private async getIgnoreRules(projectPath: string): Promise<Ignore> {
    // Check cache first
    const cached = this.ignoreCache.get(projectPath);
    if (cached) {
      return cached;
    }

    // Create new ignore instance
    const ig = ignore();

    // Always ignore .git directory
    ig.add(".git");

    // IMPORTANT: Always ignore the data directory for checkpoints
    // This is enforced here, not via gitignore
    ig.add("/data/");
    ig.add("/data/**");

    // Find all .gitignore files in the project
    const gitignoreFiles = await this.findGitignoreFiles(projectPath);

    // Parse and add rules from each .gitignore file
    for (const gitignorePath of gitignoreFiles) {
      const rules = await this.parseGitignoreFile(projectPath, gitignorePath);
      if (rules.length > 0) {
        // Calculate the relative directory of this .gitignore
        const gitignoreDir = path.dirname(gitignorePath);
        const relativeDir = path.relative(projectPath, gitignoreDir);

        // Apply rules relative to the .gitignore location
        if (relativeDir === "") {
          // Root .gitignore
          ig.add(rules);
        } else {
          // For subdirectory .gitignore files, we need to be more careful
          // The ignore library expects patterns relative to the base directory
          for (const rule of rules) {
            if (rule.startsWith("!")) {
              // For negation rules in subdirectories, we need to handle them specially
              // Convert !file.txt in src/ to !src/file.txt
              const negatedPath = rule.substring(1);
              // Use forward slashes for ignore patterns
              const prefixedRule = `!${relativeDir}/${negatedPath}`.replace(/\\/g, "/");
              ig.add(prefixedRule);
            } else {
              // For other patterns, check if it's a wildcard that should apply recursively
              if (rule.includes("*") && !rule.includes("/")) {
                // Pattern like *.test.js in src/ should match src/**/*.test.js
                const prefixedRule = `${relativeDir}/**/${rule}`.replace(/\\/g, "/");
                ig.add(prefixedRule);
              } else {
                // For other patterns, just prefix with the directory
                const prefixedRule = `${relativeDir}/${rule}`.replace(/\\/g, "/");
                ig.add(prefixedRule);
              }
            }
          }
        }
      }
    }

    // Cache the result
    this.ignoreCache.set(projectPath, ig);
    return ig;
  }

  /**
   * Find all .gitignore files in the project directory tree.
   */
  private async findGitignoreFiles(projectPath: string): Promise<string[]> {
    try {
      const files = await fg("**/.gitignore", {
        cwd: projectPath,
        absolute: true,
        dot: true,
        // Don't search in .git directory
        ignore: [".git/**"],
      });

      // Always check for root .gitignore first
      const rootGitignore = path.join(projectPath, ".gitignore");
      if (fs.existsSync(rootGitignore) && !files.includes(rootGitignore)) {
        files.unshift(rootGitignore);
      }

      return files;
    } catch (error) {
      console.warn(`Failed to find .gitignore files: ${error}`);
      return [];
    }
  }

  /**
   * Parse a .gitignore file and return its rules.
   */
  private async parseGitignoreFile(_projectPath: string, gitignorePath: string): Promise<string[]> {
    try {
      const content = await fs.promises.readFile(gitignorePath, "utf-8");
      const lines = content.split("\n");

      // Filter out comments and empty lines
      const rules = lines
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .map((rule) => {
          // Handle directory patterns - if it ends with /, convert to wildcard pattern
          // This is needed because the ignore library treats them differently
          if (rule.endsWith("/") && !rule.startsWith("!")) {
            // Convert "build/" to "build/**" for consistency
            return rule.slice(0, -1); // Remove trailing slash, ignore library handles it
          }
          return rule;
        });

      return rules;
    } catch (error) {
      console.warn(`Failed to parse .gitignore at ${gitignorePath}: ${error}`);
      return [];
    }
  }

  /**
   * Clear the ignore cache for a specific project or all projects.
   */
  clearCache(projectPath?: string): void {
    if (projectPath) {
      this.ignoreCache.delete(projectPath);
    } else {
      this.ignoreCache.clear();
    }
  }
}

// Export a singleton instance for convenience
export const fileResolver = new UnifiedFileResolver();
