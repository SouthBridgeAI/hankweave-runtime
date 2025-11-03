import { execSync } from "node:child_process";

/**
 * Git utilities for test snapshot analysis.
 * These functions inspect git repositories without modifying them.
 */

/**
 * Gets all commit SHAs from a git repository, including orphaned commits.
 *
 * Uses rev-list --all to capture all commits in the repository, plus reflog
 * to catch any commits that might be orphaned but still referenced.
 * This is essential for rollback tests where commits can become unreachable
 * from branch heads but are still valid and referenced in state.json.
 *
 * @param gitDir - Path to .git directory
 * @returns Set of all commit SHAs in the repository
 */
export function getGitShas(gitDir: string): Set<string> {
  try {
    // Use rev-list --all to get ALL commits in the repository, including orphaned ones
    const output = execSync(`git --git-dir=${gitDir} rev-list --all`, {
      encoding: "utf-8",
    });
    const shas = new Set(
      output
        .trim()
        .split("\n")
        .filter((sha) => sha),
    );

    // Also get any commits that might be referenced by refs but not reachable from branches
    try {
      const reflogOutput = execSync(`git --git-dir=${gitDir} reflog --format=%H`, {
        encoding: "utf-8",
      });
      reflogOutput
        .trim()
        .split("\n")
        .filter((sha) => sha)
        .forEach((sha) => {
          shas.add(sha);
        });
    } catch (_) {
      // reflog might not exist, that's ok
    }

    return shas;
  } catch (_e) {
    return new Set();
  }
}

/**
 * Gets detailed commit information from a git repository.
 *
 * @param gitDir - Path to .git directory
 * @returns Array of commit info objects with SHA, message, and timestamp
 */
export function getGitCommits(gitDir: string): Array<{
  sha: string;
  message: string;
  timestamp: string;
}> {
  try {
    const output = execSync(`git --git-dir=${gitDir} log --format="%H|%s|%ai"`, {
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .map((line) => {
        const [sha, message, timestamp] = line.split("|");
        return { sha, message, timestamp };
      });
  } catch (_e) {
    return [];
  }
}

/**
 * Gets all branch names from a git repository.
 *
 * @param gitDir - Path to .git directory
 * @returns Array of branch names
 */
export function getGitBranches(gitDir: string): string[] {
  try {
    const output = execSync(`git --git-dir=${gitDir} branch -a --format='%(refname:short)'`, {
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter((branch) => branch);
  } catch (_e) {
    return [];
  }
}

/**
 * Checks if a commit exists in a git repository.
 *
 * @param gitDir - Path to .git directory
 * @param sha - Commit SHA (full or partial)
 * @returns true if commit exists, false otherwise
 */
export function gitCommitExists(gitDir: string, sha: string): boolean {
  try {
    execSync(`git --git-dir=${gitDir} cat-file -e ${sha}`, {
      stdio: "ignore",
    });
    return true;
  } catch (_) {
    return false;
  }
}
