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
const SHIM_NAMES = ["gemini", "codex", "pi", "opencode"] as const;
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
 * Shims are embedded as .bundle (not .js) because Bun's --embed flag
 * rebundles .js files instead of preserving raw bytes, which truncates
 * large bundles like the Pi shim (10 MB → 28 KB). The .bundle extension
 * bypasses this behaviour. We write them back out as .js on extraction.
 *
 * @returns Path to the extracted gemini shim (for backward compatibility)
 */
export async function extractShimFiles(): Promise<string> {
  // Build file extraction configuration for all shims.
  // Embedded as <name>.bundle (unique basenames to prevent Bun dedup),
  // extracted as <name>/index.js — see doc comment above.
  const filesToExtract: FileToExtract[] = SHIM_NAMES.map((shimName) => ({
    embeddedPath: `${shimName}.bundle`,
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

  // The Pi shim bundles the @mariozechner/pi-coding-agent SDK which reads
  // package.json at module load time (for version, app name, config dir).
  // Without it, the extracted shim crashes with ENOENT before any code runs.
  writePiPackageJson();

  // Return gemini shim path for backward compatibility
  return getExtractedShimPath("gemini");
}

/**
 * Write a minimal package.json next to the extracted pi shim.
 *
 * The bundled pi-coding-agent SDK does `readFileSync(getPackageJsonPath())`
 * at module-load time, walking up from __dirname until it finds package.json.
 * It reads `version`, `piConfig.name`, and `piConfig.configDir` — all of
 * which have safe defaults in the SDK code, but the file must exist or the
 * module crashes with ENOENT.
 */
function writePiPackageJson(): void {
  const piDir = path.join(getShimExtractionDir(), "pi");
  const pkgPath = path.join(piDir, "package.json");
  if (fs.existsSync(pkgPath)) return;

  try {
    const minimal = {
      name: "pi-shim-extracted",
      version: SHIM_VERSION,
      piConfig: { name: "pi", configDir: ".pi" },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(minimal, null, 2));
  } catch {
    // Best-effort — the SDK has fallback defaults for all three fields.
  }
}
