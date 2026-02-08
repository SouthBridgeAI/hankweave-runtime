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
export const CODEX_SDK_VERSION = "0.87.0";

// Path prefix for embedded codex files (must match paths used during build)
const EMBEDDED_CODEX_PATH = "node_modules/@openai/codex-sdk/vendor";

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
 * Search for codex binary starting from a given directory and walking up.
 *
 * @param startDir - Directory to start searching from
 * @returns Path to codex binary, or null if not found
 */
function searchForCodexFromDirectory(startDir: string): string | null {
  const platform = getCodexPlatform();
  const binaryName = getCodexBinaryName();

  let currentDir = startDir;

  // Search up to 10 levels (should be more than enough)
  for (let i = 0; i < 10; i++) {
    const codexPath = path.join(
      currentDir,
      "node_modules",
      "@openai",
      "codex-sdk",
      "vendor",
      platform,
      "codex",
      binaryName,
    );

    if (fs.existsSync(codexPath)) {
      return codexPath;
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
      embeddedPath: `${platform}/codex/${binaryName}`,
      outputPath: binaryName,
      required: true,
      makeExecutable: true,
    },
  ];

  // Use base extraction engine
  await extractFiles({
    componentName: "codex-sdk",
    version: CODEX_SDK_VERSION,
    embeddedBasePath: EMBEDDED_CODEX_PATH,
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

    // Not found in node_modules - this is an error in source/npm mode
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
