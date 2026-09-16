import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Ignore } from "ignore";
import ignore from "ignore";
import micromatch from "micromatch";
import { ExecutionLayout } from "./execution-layout.js";

/**
 * Single-candidate matcher sharing `resolveFiles` semantics.
 *
 * `match` is deliberately synchronous so callers inside synchronous event
 * pipelines (e.g. CodonFileTracker's tool-use path) can decide without
 * yielding. Matching is string-only: it accepts prospective paths that do not
 * exist yet (a new Write target) and does not enforce the resolver's
 * ordinary-file/symlink policy. The captured ignore rules come from the
 * resolver's per-project cache, so an in-run .gitignore edit is invisible
 * here exactly as it is to `resolveFiles`.
 */
export interface PathMatcher {
  /**
   * @param candidatePath - Absolute path, or path relative to the project root
   * @returns The normalized project-relative path when the candidate would be
   *          included by `resolveFiles` for the same patterns, else null
   *          (no pattern match, ignored, or outside the project root).
   */
  match(candidatePath: string): string | null;
}

/**
 * Unified file resolver that applies gitignore rules consistently
 * across watching, checkpointing, and cleanup systems.
 */
export class UnifiedFileResolver {
  private ignoreCache = new Map<string, Ignore>();

  /**
   * Build a {@link PathMatcher} answering "would `resolveFiles` include this
   * path?" for a fixed pattern list, without scanning the filesystem per call.
   *
   * fast-glob compiles patterns with micromatch internally, so matching with
   * micromatch here (dot enabled, basename matching off, negative patterns
   * subtracting like fast-glob's) keeps both sites on the same glob dialect.
   */
  async createPathMatcher(projectPath: string, patterns: string[]): Promise<PathMatcher> {
    const ig = await this.getIgnoreRules(projectPath);
    const rootPath = path.resolve(projectPath);

    // fast-glob's negation rule: a leading "!" negates unless it opens an
    // extglob ("!(...)"). Negatives apply globally regardless of list order
    // (fast-glob extracts them into its ignore option), and a list with no
    // positive pattern matches nothing. micromatch's ordered list semantics
    // differ on both points, so split the list and use `ignore` instead.
    const isNegative = (pattern: string) => pattern.startsWith("!") && !pattern.startsWith("!(");
    const stripDotSlash = (pattern: string) =>
      pattern.startsWith("./") ? pattern.slice(2) : pattern;
    // fast-glob collapses repeated slashes in every pattern before compiling
    // (managers/tasks.js), keeping only a leading "//"; mirror that here.
    const removeDuplicateSlashes = (pattern: string) => pattern.replace(/(?!^)\/{2,}/g, "/");
    const normalizedPatterns = patterns.map(removeDuplicateSlashes);
    const positivePatterns = normalizedPatterns.filter((p) => !isNegative(p)).map(stripDotSlash);
    const negativePatterns = normalizedPatterns
      .filter(isNegative)
      .map((p) => stripDotSlash(p.slice(1)));

    return {
      match: (candidatePath: string): string | null => {
        if (positivePatterns.length === 0) return null;

        const relativePath = path.relative(rootPath, path.resolve(rootPath, candidatePath));
        if (relativePath === "" || path.isAbsolute(relativePath)) {
          return null;
        }
        // Escapes climb via a ".." *segment*; a legitimate in-root name like
        // "..notes.md" must not be mistaken for one.
        if (relativePath.split(path.sep)[0] === "..") {
          return null;
        }

        const normalizedPath = relativePath.split(path.sep).join("/");
        if (
          !micromatch.isMatch(normalizedPath, positivePatterns, {
            dot: true,
            // fast-glob hardcodes posix: true (providers/provider.js), which
            // flips negated-class patterns like "[!a]*.txt".
            posix: true,
            ignore: negativePatterns,
          })
        ) {
          return null;
        }
        if (ig.ignores(normalizedPath)) {
          return null;
        }
        return normalizedPath;
      },
    };
  }

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
      // Don't use gitignore - we'll handle it ourselves. Only the shadow git
      // directories are pruned at traversal time; the rest of the mandatory
      // exclusions are applied by the ignore filter below.
      ignore: [
        ".git/**",
        ...ExecutionLayout.MANDATORY_EXCLUDED_DIRS.filter((dir) =>
          dir.endsWith(ExecutionLayout.CHECKPOINT_GIT),
        ).map((dir) => `${dir}/**`),
      ],
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

    // Always ignore .git directory (user's git)
    ig.add(".git");

    // Always ignore the checkpoint shadow git directory, its quarantine
    // siblings, the same under --start-new --force backups, and the
    // read_only_data_source link. This is enforced here, not via gitignore;
    // the list is owned by execution-layout.ts so it cannot drift from the
    // on-disk names. Leading slash anchors the pattern to the root, trailing
    // slash matches directories only.
    for (const dir of ExecutionLayout.MANDATORY_EXCLUDED_DIRS) {
      ig.add(`/${dir}/`);
      ig.add(`/${dir}/**`);
    }

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
