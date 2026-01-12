/**
 * Shim Runtime Extractor
 *
 * This module handles the extraction of bundled shim files at runtime for
 * standalone executables. When compiled with Bun, shim files are embedded
 * in the executable and need to be extracted to disk before they can be
 * spawned as subprocesses.
 *
 * The extraction is done to a versioned directory to avoid re-extraction
 * on every run and to handle version updates cleanly.
 *
 * Build Process:
 * The build script (scripts/build-executable.ts) embeds shim files using:
 *   bun build --compile --embed shims/gemini/index.js ...
 *
 * Note: We use .js extension instead of .mjs for better embedding compatibility.
 *
 * At runtime, these embedded files are accessible via Bun.file() using their
 * original paths.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMetadata } from "./utils.js";

/**
 * Get the Bun virtual filesystem prefix for the current platform.
 * - Unix: /$bunfs/root
 * - Windows: X:/~BUN/root (where X is the drive letter from process.argv[1])
 */
function getBunVfsPrefix(): string {
  const mainPath = process.argv[1] || "";

  // Windows: extract drive letter from path like "B:/~BUN/root/..."
  const windowsMatch = mainPath.match(/^([A-Z]):\/~BUN\/root/i);
  if (windowsMatch) {
    return `${windowsMatch[1]}:/~BUN/root`;
  }

  // Unix: standard prefix
  return "/$bunfs/root";
}

/**
 * Read an embedded file.
 *
 * First tries to find the file in Bun.embeddedFiles (the recommended way),
 * then falls back to Bun.file() with various path formats.
 *
 * Throws if the file doesn't exist or can't be read.
 */
async function readEmbeddedFile(embeddedPath: string): Promise<ArrayBuffer> {
  // Normalize to forward slashes
  const normalizedPath = embeddedPath.replace(/\\/g, "/");
  const basename = path.basename(normalizedPath);
  // Also check for basename with trailing dot (Bun adds this for extensionless files)
  const basenameWithDot = `${basename}.`;

  // FIRST: Try to find in Bun.embeddedFiles (most reliable method)
  const embeddedFiles = (
    globalThis as {
      Bun?: { embeddedFiles?: Iterable<Blob & { name: string }> };
    }
  ).Bun?.embeddedFiles;
  if (embeddedFiles) {
    for (const file of embeddedFiles) {
      // The file.name might be the full path or just the basename
      // Bun sometimes strips paths when embedding
      // Bun also adds a trailing dot for extensionless files with --asset-naming [name].[ext]
      const fileBasename = path.basename(file.name);
      if (
        file.name === normalizedPath ||
        file.name === embeddedPath ||
        file.name === basename ||
        file.name === basenameWithDot ||
        fileBasename === basename ||
        fileBasename === basenameWithDot
      ) {
        const buffer = await file.arrayBuffer();
        if (buffer.byteLength > 0) {
          return buffer;
        }
      }
    }
  }

  // SECOND: Try Bun.file() with various path formats
  const vfsPrefix = getBunVfsPrefix();

  const pathsToTry = [
    `${vfsPrefix}/${normalizedPath}`, // Platform-specific Bun virtual filesystem
    normalizedPath, // Relative path
    `/$bunfs/root/${normalizedPath}`, // Unix-style (fallback)
    embeddedPath, // Original path
  ];

  const errors: string[] = [];

  for (const tryPath of pathsToTry) {
    try {
      const file = Bun.file(tryPath);
      const exists = await file.exists();
      if (exists) {
        const buffer = await file.arrayBuffer();
        if (buffer.byteLength > 0) {
          return buffer;
        }
        errors.push(`${tryPath}: file exists but is empty`);
      } else {
        errors.push(`${tryPath}: does not exist`);
      }
    } catch (error) {
      errors.push(`${tryPath}: ${(error as Error).message}`);
    }
  }

  throw new Error(
    `Embedded file not found: ${embeddedPath}\nTried paths:\n  ${errors.join("\n  ")}`,
  );
}

// Version for directory naming (matches package version)
const SHIM_VERSION = getMetadata().version;

// Path prefix for embedded shim files (must match paths used during build)
const EMBEDDED_SHIM_PATH = "shims";

// Available shims
const SHIM_NAMES = ["gemini"] as const;
type ShimName = (typeof SHIM_NAMES)[number];

/**
 * Get the extraction directory path for shims.
 * Uses ~/.strandweave/shims/<version>/ by default.
 */
export function getShimExtractionDir(): string {
  const cacheDir = process.env.STRANDWEAVE_CACHE_DIR || path.join(os.homedir(), ".strandweave");
  return path.join(cacheDir, "shims", SHIM_VERSION);
}

/**
 * Get the path to an extracted shim file.
 * Note: We use .js extension for embedding compatibility, even though the
 * source file is .mjs. The file works the same regardless of extension.
 */
export function getExtractedShimPath(shimName: ShimName): string {
  return path.join(getShimExtractionDir(), shimName, "index.js");
}

/**
 * Check if extraction is needed for a specific shim.
 * Returns true if the file doesn't exist or is outdated.
 */
export function needsShimExtraction(shimName: ShimName): boolean {
  const extractedPath = getExtractedShimPath(shimName);

  // If file doesn't exist, we need extraction
  if (!fs.existsSync(extractedPath)) {
    return true;
  }

  // File exists - check if it's the current version
  // We use a simple .version file to track this
  const versionFile = path.join(getShimExtractionDir(), ".version");
  if (!fs.existsSync(versionFile)) {
    return true;
  }

  const extractedVersion = fs.readFileSync(versionFile, "utf-8").trim();
  return extractedVersion !== SHIM_VERSION;
}

/**
 * Extract embedded shim files to the cache directory.
 * This should be called when running from a compiled executable.
 *
 * @returns Path to the extracted gemini shim (for backward compatibility)
 */
export async function extractShimFiles(): Promise<string> {
  const extractionDir = getShimExtractionDir();

  console.log(`📦 Extracting embedded shims to: ${extractionDir}`);

  // Create extraction directory
  fs.mkdirSync(extractionDir, { recursive: true });

  // Extract each available shim
  for (const shimName of SHIM_NAMES) {
    const embeddedPath = `${EMBEDDED_SHIM_PATH}/${shimName}/index.js`;
    const extractedPath = getExtractedShimPath(shimName);

    console.log(`  Extracting ${shimName} shim...`);

    try {
      // Use the same robust extraction method as Claude SDK
      const content = await readEmbeddedFile(embeddedPath);

      // Create destination directory
      const destDir = path.dirname(extractedPath);
      fs.mkdirSync(destDir, { recursive: true });

      // Write to extraction directory
      fs.writeFileSync(extractedPath, Buffer.from(content));

      // Verify extraction
      if (!fs.existsSync(extractedPath)) {
        throw new Error(`Failed to extract shim to: ${extractedPath}`);
      }

      console.log(`  ✓ Extracted ${shimName} shim (${(content.byteLength / 1024).toFixed(2)} KB)`);
    } catch (error) {
      console.error(`  ✗ Failed to extract ${shimName} shim:`, error);
      throw error;
    }
  }

  // Write version file
  const versionFile = path.join(extractionDir, ".version");
  fs.writeFileSync(versionFile, SHIM_VERSION);

  console.log(`✓ Shim extraction complete`);

  // Return gemini shim path for backward compatibility
  return getExtractedShimPath("gemini");
}
