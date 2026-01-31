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

import path from "node:path";
import {
  needsExtraction as baseNeedsExtraction,
  extractFiles,
  type FileToExtract,
  getComponentExtractionDir,
} from "./runtime-extractor-base.js";
import { getMetadata } from "./utils.js";

// Version for directory naming (matches package version)
const SHIM_VERSION = getMetadata().version;

// Path prefix for embedded shim files (must match paths used during build)
const EMBEDDED_SHIM_PATH = "shims";

// Available shims
const SHIM_NAMES = ["gemini", "codex"] as const;
type ShimName = (typeof SHIM_NAMES)[number];

/**
 * Get the extraction directory path for shims.
 * Uses ~/.hankweave/shims/<version>/ by default.
 */
export function getShimExtractionDir(): string {
  return getComponentExtractionDir("shims", SHIM_VERSION);
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
  const extractionDir = getShimExtractionDir();
  const shimPath = `${shimName}/index.js`;
  return baseNeedsExtraction(extractionDir, SHIM_VERSION, ".version", [shimPath]);
}

/**
 * Extract embedded shim files to the cache directory.
 * This should be called when running from a compiled executable.
 *
 * @returns Path to the extracted gemini shim (for backward compatibility)
 */
export async function extractShimFiles(): Promise<string> {
  // Build file extraction configuration for all shims
  const filesToExtract: FileToExtract[] = SHIM_NAMES.map((shimName) => ({
    embeddedPath: `${shimName}/index.js`,
    outputPath: `${shimName}/index.js`,
    required: true,
  }));

  // Use base extraction engine
  // Note: Uses .version marker file instead of .extraction-complete
  await extractFiles({
    componentName: "shims",
    version: SHIM_VERSION,
    embeddedBasePath: EMBEDDED_SHIM_PATH,
    filesToExtract,
    markerFileName: ".version",
  });

  // Return gemini shim path for backward compatibility
  return getExtractedShimPath("gemini");
}
