/**
 * Remote Strand Resolver
 *
 * Handles fetching strands from remote Git repositories with caching.
 * Supports GitHub, GitLab, Bitbucket URLs and SSH git@ URLs.
 *
 * Caching Strategy:
 * - Strands are cached in system temp directory (cross-platform via os.tmpdir())
 * - Cache is organized by repository hash
 * - Tags/commits: Cached indefinitely (immutable refs)
 * - Branches: Cached with 1-hour TTL (refreshed on expiry)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadStrandFile } from "./config.js";

// Cache TTL for branch references (1 hour in milliseconds)
const BRANCH_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Parsed components of a remote strand URL
 */
export interface RemoteStrandRef {
  /** Full original URL */
  originalUrl: string;
  /** Clone URL (HTTPS or SSH) */
  cloneUrl: string;
  /** Git reference (branch, tag, or commit) */
  ref: string;
  /** Whether ref is a branch (vs tag/commit) */
  isBranch: boolean;
  /** Path to strand file within repo (default: "strand.json") */
  strandPath: string;
}

/**
 * Information about a cached remote strand
 */
export interface CachedStrand {
  /** Local path to the cached repository */
  repoPath: string;
  /** Local path to the strand.json file */
  strandPath: string;
  /** Whether the cache was fresh or had to be fetched */
  wasFresh: boolean;
  /** Timestamp of when the cache was last updated */
  cachedAt: Date;
}

/**
 * Strand summary information for display
 */
export interface StrandSummary {
  /** Name from strand meta */
  name?: string;
  /** Description from strand meta */
  description?: string;
  /** Number of codons in the strand */
  codonCount: number;
  /** List of codon names/IDs */
  codonNames: string[];
  /** Source repository URL */
  sourceUrl: string;
  /** Git reference used */
  ref: string;
}

/**
 * Check if a path looks like a remote repository URL.
 *
 * Supported formats:
 * - https://github.com/user/repo
 * - https://github.com/user/repo.git
 * - https://github.com/user/repo#branch
 * - https://github.com/user/repo/tree/branch
 * - https://github.com/user/repo/tree/branch/path/to/strand.json
 * - git@github.com:user/repo.git
 * - git@github.com:user/repo#branch
 *
 * @param strandPath - Path or URL to check
 * @returns true if it looks like a remote URL
 */
export function isRemoteStrandUrl(strandPath: string): boolean {
  // HTTPS URLs
  if (strandPath.startsWith("https://") || strandPath.startsWith("http://")) {
    const knownHosts = ["github.com", "gitlab.com", "bitbucket.org"];
    return knownHosts.some((host) => strandPath.includes(host));
  }

  // SSH URLs (git@host:user/repo)
  if (strandPath.startsWith("git@")) {
    return true;
  }

  return false;
}

/**
 * Parse a remote strand URL into its components.
 *
 * Handles various URL formats:
 * - https://github.com/user/repo → main branch, strand.json
 * - https://github.com/user/repo#v1.0.0 → tag v1.0.0, strand.json
 * - https://github.com/user/repo/tree/branch → specific branch
 * - https://github.com/user/repo/tree/branch/path/to/strand.json → specific file
 * - git@github.com:user/repo.git#branch → SSH with branch
 *
 * @param url - Remote strand URL
 * @returns Parsed components
 */
export function parseRemoteStrandUrl(url: string): RemoteStrandRef {
  let cloneUrl: string;
  let ref = "main"; // Default to main branch
  let isBranch = true;
  let strandPath = "strand.json";

  // Handle SSH URLs (git@host:user/repo)
  if (url.startsWith("git@")) {
    const hashIndex = url.indexOf("#");
    if (hashIndex !== -1) {
      cloneUrl = url.substring(0, hashIndex);
      const fragment = url.substring(hashIndex + 1);
      // Check if fragment contains a path
      if (fragment.includes("/")) {
        const parts = fragment.split("/");
        ref = parts[0];
        strandPath = parts.slice(1).join("/") || "strand.json";
      } else {
        ref = fragment;
      }
      // Heuristic: refs that look like tags or commits
      isBranch = !isTagOrCommitRef(ref);
    } else {
      cloneUrl = url;
    }
    // Ensure .git suffix
    if (!cloneUrl.endsWith(".git")) {
      cloneUrl += ".git";
    }
  }
  // Handle HTTPS URLs
  else if (url.startsWith("https://") || url.startsWith("http://")) {
    const parsed = new URL(url);

    // Extract clone URL base
    const pathParts = parsed.pathname.split("/").filter((p) => p);

    if (pathParts.length < 2) {
      throw new Error(`Invalid repository URL: ${url}`);
    }

    const user = pathParts[0];
    const repo = pathParts[1].replace(/\.git$/, "");

    cloneUrl = `https://${parsed.host}/${user}/${repo}.git`;

    // Parse ref from path: /tree/branch/... or /blob/branch/...
    if (pathParts.length > 3 && (pathParts[2] === "tree" || pathParts[2] === "blob")) {
      ref = pathParts[3];
      isBranch = !isTagOrCommitRef(ref);

      // Check for strand path in remaining parts
      if (pathParts.length > 4) {
        strandPath = pathParts.slice(4).join("/");
        if (!strandPath.endsWith(".json")) {
          strandPath = path.join(strandPath, "strand.json");
        }
      }
    }

    // Handle fragment (#branch or #tag)
    if (parsed.hash) {
      const fragment = parsed.hash.substring(1);
      if (fragment.includes("/")) {
        const parts = fragment.split("/");
        ref = parts[0];
        strandPath = parts.slice(1).join("/") || strandPath;
      } else {
        ref = fragment;
      }
      isBranch = !isTagOrCommitRef(ref);
    }
  } else {
    throw new Error(`Unsupported URL format: ${url}`);
  }

  return {
    originalUrl: url,
    cloneUrl,
    ref,
    isBranch,
    strandPath,
  };
}

/**
 * Heuristic to determine if a ref is a tag/commit vs a branch.
 * Tags often have semantic versioning patterns.
 * Commits are 40-char hex strings.
 */
function isTagOrCommitRef(ref: string): boolean {
  // Full SHA-1 commit hash
  if (/^[a-f0-9]{40}$/i.test(ref)) {
    return true;
  }
  // Short commit hash (at least 7 chars)
  if (/^[a-f0-9]{7,}$/i.test(ref) && ref.length <= 12) {
    return true;
  }
  // Semantic version tag (v1.0.0, 1.2.3, etc.)
  if (/^v?\d+\.\d+(\.\d+)?/.test(ref)) {
    return true;
  }
  return false;
}

/**
 * Get the cache directory path for a repository.
 *
 * Uses system temp directory for cross-platform compatibility.
 * Cache is organized by hash of clone URL.
 *
 * @param cloneUrl - Repository clone URL
 * @returns Path to cache directory
 */
function getCacheDir(cloneUrl: string): string {
  const hash = crypto.createHash("sha256").update(cloneUrl).digest("hex").substring(0, 16);
  return path.join(os.tmpdir(), "strandweave-strands", hash);
}

/**
 * Get the cache metadata file path.
 */
function getCacheMetaPath(cacheDir: string): string {
  return path.join(cacheDir, ".strandweave-cache-meta.json");
}

/**
 * Check if cache is valid (exists and not expired for branches).
 */
function isCacheValid(cacheDir: string, isBranch: boolean): boolean {
  const metaPath = getCacheMetaPath(cacheDir);

  if (!fs.existsSync(metaPath)) {
    return false;
  }

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));

    // Tags/commits never expire
    if (!isBranch) {
      return true;
    }

    // Branches expire after TTL
    const cachedAt = new Date(meta.cachedAt);
    const age = Date.now() - cachedAt.getTime();
    return age < BRANCH_CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Write cache metadata.
 */
function writeCacheMeta(cacheDir: string, ref: string, isBranch: boolean): void {
  const metaPath = getCacheMetaPath(cacheDir);
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        cachedAt: new Date().toISOString(),
        ref,
        isBranch,
      },
      null,
      2,
    ),
  );
}

/**
 * Resolve a remote strand URL to a local path.
 *
 * This is the main entry point for remote strand resolution:
 * 1. Parse the URL to extract repo, ref, and path
 * 2. Check cache validity
 * 3. Clone/fetch if needed
 * 4. Return local path to strand.json
 *
 * @param url - Remote strand URL
 * @returns Cached strand information including local path
 */
export async function resolveRemoteStrand(url: string): Promise<CachedStrand> {
  const parsed = parseRemoteStrandUrl(url);
  const cacheDir = getCacheDir(parsed.cloneUrl);

  // Check if we have a valid cache
  if (isCacheValid(cacheDir, parsed.isBranch)) {
    const strandPath = path.join(cacheDir, parsed.strandPath);

    if (fs.existsSync(strandPath)) {
      const meta = JSON.parse(fs.readFileSync(getCacheMetaPath(cacheDir), "utf-8"));
      return {
        repoPath: cacheDir,
        strandPath,
        wasFresh: true,
        cachedAt: new Date(meta.cachedAt),
      };
    }
  }

  // Need to fetch/clone
  await fetchRemoteStrand(parsed, cacheDir);

  const strandPath = path.join(cacheDir, parsed.strandPath);

  if (!fs.existsSync(strandPath)) {
    throw new Error(
      `Strand file not found in repository: ${parsed.strandPath}\nRepository: ${parsed.cloneUrl}`,
    );
  }

  return {
    repoPath: cacheDir,
    strandPath,
    wasFresh: false,
    cachedAt: new Date(),
  };
}

/**
 * Fetch/clone a remote repository.
 *
 * Uses simple-git for git operations.
 */
async function fetchRemoteStrand(parsed: RemoteStrandRef, cacheDir: string): Promise<void> {
  // Dynamically import simple-git (it's a peer dependency)
  let simpleGit: typeof import("simple-git");
  try {
    simpleGit = await import("simple-git");
  } catch {
    throw new Error(
      "Remote strands require the 'simple-git' package. Install it with: npm install simple-git",
    );
  }

  const git = simpleGit.simpleGit();

  // Ensure cache directory exists
  fs.mkdirSync(cacheDir, { recursive: true });

  // Check if repo already exists
  const repoExists = fs.existsSync(path.join(cacheDir, ".git"));

  if (repoExists) {
    // Fetch and checkout the specific ref
    const repoGit = simpleGit.simpleGit(cacheDir);
    await repoGit.fetch(["--all", "--prune"]);
    await repoGit.checkout(parsed.ref, ["--force"]);

    if (parsed.isBranch) {
      // For branches, pull latest
      await repoGit.pull("origin", parsed.ref, ["--force"]);
    }
  } else {
    // Clone fresh
    await git.clone(parsed.cloneUrl, cacheDir, [
      "--branch",
      parsed.ref,
      "--single-branch",
      "--depth",
      "1",
    ]);
  }

  // Write cache metadata
  writeCacheMeta(cacheDir, parsed.ref, parsed.isBranch);
}

/**
 * Get a summary of a strand for display.
 *
 * @param strandPath - Local path to strand.json
 * @param sourceUrl - Original remote URL
 * @param ref - Git ref used
 * @returns Strand summary
 */
export function getStrandSummary(
  strandPath: string,
  sourceUrl: string,
  ref: string,
): StrandSummary {
  const strandFile = loadStrandFile(strandPath);

  // Flatten codons to get all codon names (handling loops)
  const codonNames: string[] = [];
  function extractCodonNames(configs: typeof strandFile.strand): void {
    for (const config of configs) {
      if (config.type === "loop") {
        extractCodonNames(config.codons);
      } else {
        codonNames.push(config.name);
      }
    }
  }
  extractCodonNames(strandFile.strand);

  return {
    name: strandFile.meta?.name,
    description: strandFile.meta?.description,
    codonCount: codonNames.length,
    codonNames,
    sourceUrl,
    ref,
  };
}

/**
 * Display strand summary in a formatted way.
 *
 * Called when loading a remote strand to show the user what they're running.
 * No confirmation needed - "power user" model assumes intent to run.
 */
export function displayStrandSummary(summary: StrandSummary): void {
  console.log("\n📦 Remote Strand");
  console.log("────────────────────────────────────────────");

  if (summary.name) {
    console.log(`  Name: ${summary.name}`);
  }
  if (summary.description) {
    console.log(`  Description: ${summary.description}`);
  }

  console.log(`  Source: ${summary.sourceUrl}`);
  console.log(`  Ref: ${summary.ref}`);
  console.log(`  Codons: ${summary.codonCount}`);

  if (summary.codonNames.length > 0) {
    const displayNames =
      summary.codonNames.length <= 5
        ? summary.codonNames.join(", ")
        : `${summary.codonNames.slice(0, 5).join(", ")}... (+${summary.codonNames.length - 5} more)`;
    console.log(`  Sequence: ${displayNames}`);
  }

  console.log("────────────────────────────────────────────\n");
}
