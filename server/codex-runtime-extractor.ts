/**
 * Codex Runtime Extractor
 *
 * This module handles the detection and extraction of Codex binaries
 * for different execution contexts. The @openai/codex-sdk package ships
 * with platform-specific binaries in its vendor directory.
 *
 * Execution contexts:
 * 1. Source/NPM mode: Use binary from node_modules/@openai/codex-sdk/vendor/
 * 2. Compiled executable: Extract embedded binary to ~/.hankweave/codex-sdk/
 *
 * The extraction is done to a versioned directory to avoid re-extraction
 * on every run and to handle SDK updates cleanly.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractFiles,
  type FileToExtract,
  getComponentExtractionDir,
  needsExtraction,
} from "./runtime-extractor-base.js";
import { isCompiledExecutable } from "./utils.js";

// Codex SDK version for directory naming
export const CODEX_SDK_VERSION = "0.135.0";

/**
 * Resolve the codex binary within a `vendor/<platform-triple>` directory.
 *
 * The vendor layout changed in @openai/codex v0.135.0:
 * - v0.135.0+: <triple>/bin/<binary>   (alongside a codex-package.json marker)
 * - <v0.135.0: <triple>/codex/<binary> (legacy)
 *
 * @returns Path to the binary if present, or null.
 */
function resolveCodexBinaryInTripleDir(tripleDir: string, binaryName: string): string | null {
  const candidates = [
    path.join(tripleDir, "bin", binaryName), // v0.135.0+
    path.join(tripleDir, "codex", binaryName), // legacy
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Path prefix for embedded codex files (must match paths used during build)
// In codex-sdk v0.101.0+, binaries are in platform-specific packages (@openai/codex-<platform>-<arch>)
function getEmbeddedCodexBasePath(): string {
  const platform = os.platform() === "win32" ? "win32" : os.platform();
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  return `node_modules/@openai/codex-${platform}-${arch}/vendor`;
}

/**
 * Platform identifier matching @openai/codex-sdk vendor directory structure
 */
type CodexPlatform =
  | "aarch64-apple-darwin"
  | "x86_64-apple-darwin"
  | "aarch64-unknown-linux-musl"
  | "x86_64-unknown-linux-musl"
  | "aarch64-pc-windows-msvc"
  | "x86_64-pc-windows-msvc";

/**
 * Determine platform identifier matching codex-sdk structure.
 *
 * @param target - Optional build target string (e.g., "linux-x64", "darwin-arm64").
 *                 If not provided, uses current platform.
 * @throws Error if platform is unsupported
 */
export function getCodexPlatform(target?: string): CodexPlatform {
  let platform: string;
  let arch: string;

  if (target) {
    // Parse target like "linux-x64", "darwin-arm64" for cross-compilation
    [platform, arch] = target.split("-");
  } else {
    // Use current platform
    platform = os.platform();
    arch = os.arch();
    // Normalize win32 to windows for consistency
    if (platform === "win32") {
      platform = "windows";
    }
  }

  // Map platform + arch to CodexPlatform
  switch (platform) {
    case "darwin":
      return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    case "linux":
      return arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
    case "windows":
      return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    default:
      throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
}

/**
 * Get the codex binary filename for the current platform.
 */
export function getCodexBinaryName(): string {
  return os.platform() === "win32" ? "codex.exe" : "codex";
}

/**
 * Get the extraction directory path for codex binaries.
 * Uses ~/.hankweave/codex-sdk/<version>/ by default.
 */
export function getCodexExtractionDir(): string {
  return getComponentExtractionDir("codex-sdk", CODEX_SDK_VERSION);
}

/**
 * Get the path to the extracted codex binary.
 */
export function getExtractedCodexPath(): string {
  const extractDir = getCodexExtractionDir();
  const binaryName = getCodexBinaryName();
  return path.join(extractDir, binaryName);
}

/**
 * Ensure a binary file has execute permissions on Unix.
 * No-op on Windows. Deno's npm cache may not preserve +x bits.
 */
export function ensureExecutable(binaryPath: string): void {
  if (os.platform() === "win32") return;
  try {
    const stat = fs.statSync(binaryPath);
    if ((stat.mode & 0o100) === 0) {
      fs.chmodSync(binaryPath, stat.mode | 0o755);
    }
  } catch {
    // Ignore — permission errors will surface later when spawning
  }
}

/**
 * Get the platform-specific package name for @openai/codex (v0.101.0+).
 * Maps os.platform()/os.arch() to the npm optional dependency package name.
 */
function getCodexPlatformPackageName(): string {
  const platform = os.platform() === "win32" ? "win32" : os.platform();
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  return `codex-${platform}-${arch}`;
}

/**
 * Locate codex binary using import.meta.resolve.
 *
 * This is a universal fallback that works across all runtimes (Deno, Node.js 20.6+, Bun).
 * It asks the runtime's own module resolver where @openai/codex-sdk (or the platform-specific
 * package) lives, then navigates from the resolved entry point to the vendor binary.
 *
 * This is critical for Deno, which stores npm packages in a global cache rather than
 * in a project-local node_modules/ directory.
 *
 * @returns Path to codex binary, or null if not found
 */
export function locateCodexViaImportResolve(): string | null {
  const codexPlatform = getCodexPlatform();
  const binaryName = getCodexBinaryName();
  const platformPkgName = getCodexPlatformPackageName();

  // Strategy 1: Resolve platform-specific package directly via package.json subpath.
  // Works under Bun and Node.js where subpath resolution is lenient.
  const resolveTargets = [
    `@openai/${platformPkgName}/package.json`,
    "@openai/codex-sdk/package.json",
  ];

  for (const target of resolveTargets) {
    try {
      const resolved = import.meta.resolve(target);
      if (!resolved.startsWith("file://")) continue;

      const packageDir = path.dirname(fileURLToPath(resolved));
      const tripleDir = path.join(packageDir, "vendor", codexPlatform);
      const candidate = resolveCodexBinaryInTripleDir(tripleDir, binaryName);

      if (candidate) {
        ensureExecutable(candidate);
        return candidate;
      }
    } catch {
      // Subpath not exported or package not resolvable — try next target
    }
  }

  // Strategy 2: Resolve @openai/codex-sdk (main entry) and navigate to
  // the @openai scope directory to find sibling platform packages.
  // This handles Deno's global npm cache where packages are stored as
  // siblings under registry.npmjs.org/@openai/.
  try {
    const sdkUrl = import.meta.resolve("@openai/codex-sdk");
    if (sdkUrl.startsWith("file://")) {
      const sdkPath = fileURLToPath(sdkUrl);
      const sep = path.sep;
      const openaiSegment = `${sep}@openai${sep}`;
      const idx = sdkPath.lastIndexOf(openaiSegment);

      if (idx !== -1) {
        const scopeDir = sdkPath.substring(0, idx + openaiSegment.length);
        const result = searchForBinaryInScopeDir(
          scopeDir,
          platformPkgName,
          codexPlatform,
          binaryName,
        );
        if (result) return result;

        // Under Deno --node-modules-dir, the resolved path goes through
        // .deno/ internal directory where sibling packages aren't present.
        // Fall back to the top-level node_modules/@openai/ directory.
        const nmSegment = `${sep}node_modules${sep}`;
        const nmIdx = sdkPath.indexOf(nmSegment);
        if (nmIdx !== -1) {
          const topScopeDir = `${sdkPath.substring(0, nmIdx)}${nmSegment}@openai${sep}`;
          if (topScopeDir !== scopeDir && fs.existsSync(topScopeDir)) {
            const fallback = searchForBinaryInScopeDir(
              topScopeDir,
              platformPkgName,
              codexPlatform,
              binaryName,
            );
            if (fallback) return fallback;
          }
        }
      }
    }
  } catch {
    // import.meta.resolve not available or failed
  }

  return null;
}

/**
 * Search for the codex binary within an @openai scope directory.
 * Handles both flat layouts (node_modules) and versioned layouts (Deno global cache).
 */
function searchForBinaryInScopeDir(
  scopeDir: string,
  platformPkgName: string,
  codexPlatform: string,
  binaryName: string,
): string | null {
  // Check platform-specific package (v0.101.0+) and legacy codex-sdk
  const packageNames = [platformPkgName, "codex-sdk"];

  for (const pkgName of packageNames) {
    const pkgDir = path.join(scopeDir, pkgName);
    if (!fs.existsSync(pkgDir)) continue;

    // Direct layout: vendor/ at the package root (node_modules)
    const directCandidate = resolveCodexBinaryInTripleDir(
      path.join(pkgDir, "vendor", codexPlatform),
      binaryName,
    );
    if (directCandidate) {
      ensureExecutable(directCandidate);
      return directCandidate;
    }

    // Versioned layout: version subdirectories (Deno global cache)
    // e.g., codex-darwin-arm64/0.135.0-darwin-arm64/vendor/...
    try {
      for (const entry of fs.readdirSync(pkgDir)) {
        const candidate = resolveCodexBinaryInTripleDir(
          path.join(pkgDir, entry, "vendor", codexPlatform),
          binaryName,
        );
        if (candidate) {
          ensureExecutable(candidate);
          return candidate;
        }
      }
    } catch {
      // Directory not readable
    }
  }

  return null;
}

/**
 * Search for codex binary starting from a given directory and walking up.
 *
 * Searches for both:
 * - New structure (v0.101.0+): node_modules/@openai/codex-<platform>-<arch>/vendor/<platform>/codex/<binary>
 * - Legacy structure (<v0.101.0): node_modules/@openai/codex-sdk/vendor/<platform>/codex/<binary>
 *
 * @param startDir - Directory to start searching from
 * @returns Path to codex binary, or null if not found
 */
function searchForCodexFromDirectory(startDir: string): string | null {
  const codexPlatform = getCodexPlatform();
  const binaryName = getCodexBinaryName();
  const platformPkgName = getCodexPlatformPackageName();

  let currentDir = startDir;

  // Search up to 10 levels (should be more than enough)
  for (let i = 0; i < 10; i++) {
    // New structure (v0.101.0+): @openai/codex-<platform>-<arch>/vendor/<platform>/{bin,codex}/<binary>
    const newPath = resolveCodexBinaryInTripleDir(
      path.join(currentDir, "node_modules", "@openai", platformPkgName, "vendor", codexPlatform),
      binaryName,
    );

    if (newPath) {
      return newPath;
    }

    // Legacy structure: @openai/codex-sdk/vendor/<platform>/{bin,codex}/<binary>
    const legacyPath = resolveCodexBinaryInTripleDir(
      path.join(currentDir, "node_modules", "@openai", "codex-sdk", "vendor", codexPlatform),
      binaryName,
    );

    if (legacyPath) {
      return legacyPath;
    }

    // Move up one directory
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached root directory
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

/**
 * Locate codex binary in node_modules (npm/npx mode).
 * Searches up the directory tree from the module's location to find node_modules/@openai/codex-sdk.
 *
 * This works in both normal installs and npx scenarios:
 * - Normal install: module is in project/node_modules/@southbridgeai/hankweave
 * - NPX: module is in ~/.npm/_npx/.../node_modules/@southbridgeai/hankweave
 * In both cases, @openai/codex-sdk will be found by walking up from the module location.
 *
 * @returns Path to codex binary, or null if not found
 */
export function locateCodexInNodeModules(): string | null {
  // Search from this module's location
  // This handles both normal installs and npx scenarios where the package
  // is installed in npx cache but user runs from their project directory
  const modulePath = path.dirname(fileURLToPath(import.meta.url));

  return searchForCodexFromDirectory(modulePath);
}

/**
 * Check if extraction is needed.
 * Returns true if the binary doesn't exist or is outdated.
 */
export function needsCodexExtraction(): boolean {
  const extractionDir = getCodexExtractionDir();
  const binaryName = getCodexBinaryName();
  return needsExtraction(extractionDir, CODEX_SDK_VERSION, ".extraction-complete", [binaryName]);
}

/**
 * Extract embedded codex binary to disk.
 *
 * This function reads the binary that was embedded during compilation using Bun's
 * --embed flag, then extracts it to a versioned directory on first run.
 *
 * @returns Path to extracted codex binary
 * @throws Error if extraction fails
 */
export async function extractCodexBinary(): Promise<string> {
  const platform = getCodexPlatform();
  const binaryName = getCodexBinaryName();

  // Build file extraction configuration
  const filesToExtract: FileToExtract[] = [
    {
      // v0.135.0+ ships the binary under <triple>/bin/; older versions used <triple>/codex/
      embeddedPath: `${platform}/bin/${binaryName}`,
      outputPath: binaryName,
      required: true,
      makeExecutable: true,
    },
  ];

  // Use base extraction engine
  await extractFiles({
    componentName: "codex-sdk",
    version: CODEX_SDK_VERSION,
    embeddedBasePath: getEmbeddedCodexBasePath(),
    filesToExtract,
    markerFileName: ".extraction-complete",
  });

  return getExtractedCodexPath();
}

/**
 * Ensure codex binary is available, extracting if necessary.
 *
 * This is the main entry point for getting a codex binary path.
 * Handles both npm/npx mode (use node_modules) and binary mode (extract embedded).
 *
 * @returns Path to codex binary
 * @throws Error if binary cannot be found or extracted
 */
export async function ensureCodexAvailable(): Promise<{
  path: string;
  version: string;
  cached: boolean;
}> {
  // If running from source or npm/npx, try to find in node_modules first
  if (!isCompiledExecutable()) {
    const nodeModulesPath = locateCodexInNodeModules();
    if (nodeModulesPath) {
      return { path: nodeModulesPath, version: "node_modules", cached: true };
    }

    // Fallback: use import.meta.resolve (works for Deno and as universal fallback)
    const resolvedPath = locateCodexViaImportResolve();
    if (resolvedPath) {
      return { path: resolvedPath, version: "resolved", cached: true };
    }

    // Not found by any locator - this is an error in source/npm mode
    throw new Error(
      "Codex binary not found in node_modules. Ensure @openai/codex-sdk is installed.",
    );
  }

  // Running from compiled executable - extract if needed
  if (!needsCodexExtraction()) {
    const cachedPath = getExtractedCodexPath();
    return { path: cachedPath, version: CODEX_SDK_VERSION, cached: true };
  }

  // Need to extract
  const extractedPath = await extractCodexBinary();
  return { path: extractedPath, version: CODEX_SDK_VERSION, cached: false };
}

/**
 * Validate that the codex binary exists and is executable.
 *
 * @param codexPath - Path to codex binary to validate
 * @returns true if valid, false otherwise
 */
export function validateCodexBinary(codexPath: string): boolean {
  try {
    // Check if file exists
    if (!fs.existsSync(codexPath)) {
      return false;
    }

    // Check if it's a file (not a directory)
    const stat = fs.statSync(codexPath);
    if (!stat.isFile()) {
      return false;
    }

    // On Unix, check if it's executable
    if (os.platform() !== "win32") {
      // Check if owner has execute permission (0o100)
      if ((stat.mode & 0o100) === 0) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}
