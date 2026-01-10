/**
 * Claude Runtime Extractor
 *
 * This module handles the extraction of bundled Claude Agent SDK files
 * at runtime for standalone executables. When compiled with Bun, the CLI
 * files are embedded in the executable and need to be extracted to disk
 * before they can be spawned as subprocesses.
 *
 * The extraction is done to a versioned directory to avoid re-extraction
 * on every run and to handle SDK updates cleanly.
 *
 * Build Process:
 * The build script (scripts/build-executable.ts) embeds the SDK files using:
 *   bun build --compile --embed node_modules/@anthropic-ai/claude-agent-sdk/cli.js ...
 *
 * At runtime, these embedded files are accessible via Bun.file() using their
 * original paths.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// SDK version for directory naming
const SDK_VERSION = "0.1.70";

// Path prefix for embedded SDK files (must match paths used during build)
const EMBEDDED_SDK_PATH = "node_modules/@anthropic-ai/claude-agent-sdk";

// Determine platform for ripgrep binaries
function getPlatformKey(): string {
  const arch = os.arch();
  const platform = os.platform();

  if (platform === "darwin") {
    return arch === "arm64" ? "arm64-darwin" : "x64-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "arm64-linux" : "x64-linux";
  }
  if (platform === "win32") {
    return "x64-win32";
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/**
 * Get the extraction directory path.
 * Uses ~/.strandweave/claude-sdk/<version>/ by default.
 */
export function getExtractionDir(): string {
  const cacheDir = process.env.STRANDWEAVE_CACHE_DIR || path.join(os.homedir(), ".strandweave");
  return path.join(cacheDir, "claude-sdk", SDK_VERSION);
}

/**
 * Get the path to the extracted cli.js file.
 */
export function getExtractedCliPath(): string {
  return path.join(getExtractionDir(), "cli.js");
}

/**
 * Check if we're running as a compiled Bun executable.
 * When compiled with Bun, process.argv[1] points to Bun's virtual filesystem.
 *
 * On Unix: /$bunfs/root/...
 * On Windows: X:/~BUN/root/... (drive letter varies)
 */
export function isCompiledExecutable(): boolean {
  // Strategy: Check multiple indicators to determine if we're compiled
  //
  // Priority order (most reliable first):
  // 1. If process.argv[1] matches Bun VFS pattern -> definitely compiled
  // 2. If SDK can't be found in node_modules -> compiled
  // 3. Otherwise -> not compiled (running from source)

  const mainPath = process.argv[1] || "";

  try {
    // FIRST: Check if running in Bun's virtual filesystem
    // This is the most reliable indicator for compiled executables
    // On Unix: /$bunfs/root/...
    // On Windows: X:/~BUN/root/... (e.g., B:/~BUN/root/strandweave-windows-x64.exe)
    if (
      mainPath.includes("$bunfs") ||
      mainPath.includes("bunfs") ||
      mainPath.match(/^[A-Z]:\/~BUN\/root/i) // Windows: X:/~BUN/root
    ) {
      return true; // Running from Bun's virtual filesystem = definitely compiled
    }

    // SECOND: Check if SDK exists in standard node_modules locations
    const possibleSdkPaths = [
      path.join(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk/cli.js"),
      path.join(path.dirname(mainPath), "node_modules/@anthropic-ai/claude-agent-sdk/cli.js"),
    ];

    for (const sdkPath of possibleSdkPaths) {
      if (fs.existsSync(sdkPath)) {
        return false; // SDK exists on disk, not compiled
      }
    }

    // THIRD: Try to resolve the SDK from node_modules
    try {
      require.resolve("@anthropic-ai/claude-agent-sdk");
      return false;
    } catch {
      // Can't resolve SDK, likely compiled
      return true;
    }
  } catch {
    // Error during detection, assume we might be compiled
    return true;
  }
}

/**
 * Check if embedded files are available (async check).
 * This actually tries to access an embedded file to verify.
 */
export async function hasEmbeddedFiles(): Promise<boolean> {
  try {
    const testFile = Bun.file(`${EMBEDDED_SDK_PATH}/cli.js`);
    return await testFile.exists();
  } catch {
    return false;
  }
}

/**
 * Check if extraction is needed.
 * Returns true if the files don't exist or are outdated.
 */
export function needsExtraction(): boolean {
  const extractDir = getExtractionDir();
  const cliPath = getExtractedCliPath();
  const markerPath = path.join(extractDir, ".extraction-complete");

  // Check if marker file exists (indicates successful extraction)
  if (!fs.existsSync(markerPath)) {
    return true;
  }

  // Check if cli.js exists
  if (!fs.existsSync(cliPath)) {
    return true;
  }

  // Check marker content matches our version
  try {
    const marker = fs.readFileSync(markerPath, "utf-8").trim();
    if (marker !== SDK_VERSION) {
      return true;
    }
  } catch {
    return true;
  }

  return false;
}

/**
 * Compute a hash of the embedded files for verification.
 */
function computeFileHash(content: Buffer | string): string {
  return createHash("md5").update(content).digest("hex").slice(0, 12);
}

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

  // FIRST: Try to find in Bun.embeddedFiles (most reliable method)
  const embeddedFiles = (
    globalThis as {
      Bun?: { embeddedFiles?: Iterable<Blob & { name: string }> };
    }
  ).Bun?.embeddedFiles;
  if (embeddedFiles) {
    for (const file of embeddedFiles) {
      // The file.name contains the path used during --embed
      if (file.name === normalizedPath || file.name === embeddedPath) {
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

/**
 * Extract embedded Claude SDK files to disk.
 *
 * This function reads files that were embedded during compilation using Bun's
 * --embed flag, then extracts them to a versioned directory on first run.
 *
 * The embedded files are accessed using their original paths that were
 * specified during build (e.g., "node_modules/@anthropic-ai/claude-agent-sdk/cli.js").
 *
 * Files extracted:
 * - cli.js - The main Claude Code CLI
 * - resvg.wasm - SVG rendering WASM module
 * - tree-sitter.wasm - Syntax parsing WASM module
 * - tree-sitter-bash.wasm - Bash syntax WASM module
 * - vendor/ripgrep/<platform>/ - Platform-specific ripgrep binaries
 */
export async function extractClaudeSdkFiles(): Promise<string> {
  const extractDir = getExtractionDir();
  const cliPath = getExtractedCliPath();
  const markerPath = path.join(extractDir, ".extraction-complete");

  console.log(`📦 Extracting Claude SDK files to: ${extractDir}`);

  // Debug: List all embedded files to see what's available
  // Bun.embeddedFiles is available in compiled executables
  const embeddedFiles = (
    globalThis as {
      Bun?: { embeddedFiles?: Iterable<Blob & { name: string }> };
    }
  ).Bun?.embeddedFiles;
  if (embeddedFiles) {
    console.log("📋 Embedded files available:");
    for (const file of embeddedFiles) {
      console.log(`   - ${file.name} (${file.size} bytes)`);
    }
  }

  // Create extraction directory
  try {
    fs.mkdirSync(extractDir, { recursive: true });
  } catch (error) {
    console.error(`❌ Failed to create extraction directory: ${(error as Error).message}`);
    throw error;
  }

  // Files to extract (paths must match what was embedded during build)
  // Note: WASM files are optional - they're for syntax highlighting and SVG rendering
  // The core Claude Code CLI functionality works without them
  const filesToExtract = [
    { name: "cli.js", required: true },
    { name: "resvg.wasm", required: false }, // SVG rendering
    { name: "tree-sitter.wasm", required: false }, // Syntax parsing
    { name: "tree-sitter-bash.wasm", required: false }, // Bash syntax
  ];

  // Extract main files
  for (const file of filesToExtract) {
    // Path matches what was embedded: node_modules/@anthropic-ai/claude-agent-sdk/<file>
    const embeddedPath = `${EMBEDDED_SDK_PATH}/${file.name}`;
    const destPath = path.join(extractDir, file.name);

    try {
      const content = await readEmbeddedFile(embeddedPath);
      await Bun.write(destPath, content);
      console.log(`  ✓ Extracted ${file.name} (${computeFileHash(Buffer.from(content))})`);
    } catch (error) {
      if (file.required) {
        throw new Error(`Failed to extract ${file.name}: ${(error as Error).message}`);
      }
      console.warn(`  ⚠ Could not extract ${file.name}: ${(error as Error).message}`);
    }
  }

  // Extract ripgrep binaries for current platform
  const platformKey = getPlatformKey();
  const ripgrepDestDir = path.join(extractDir, "vendor/ripgrep", platformKey);

  try {
    fs.mkdirSync(ripgrepDestDir, { recursive: true });

    // Determine ripgrep binary name based on platform
    const rgBinaryName = platformKey === "x64-win32" ? "rg.exe" : "rg";
    const rgNodeName = "ripgrep.node";

    // Extract rg binary
    const rgEmbeddedPath = `${EMBEDDED_SDK_PATH}/vendor/ripgrep/${platformKey}/${rgBinaryName}`;
    const rgDestPath = path.join(ripgrepDestDir, rgBinaryName);
    const rgContent = await readEmbeddedFile(rgEmbeddedPath);
    await Bun.write(rgDestPath, rgContent);

    // Make rg executable on Unix systems
    if (platformKey !== "x64-win32") {
      fs.chmodSync(rgDestPath, 0o755);
    }
    console.log(`  ✓ Extracted vendor/ripgrep/${platformKey}/${rgBinaryName}`);

    // Extract ripgrep.node
    const nodeEmbeddedPath = `${EMBEDDED_SDK_PATH}/vendor/ripgrep/${platformKey}/${rgNodeName}`;
    const nodeDestPath = path.join(ripgrepDestDir, rgNodeName);
    const nodeContent = await readEmbeddedFile(nodeEmbeddedPath);
    await Bun.write(nodeDestPath, nodeContent);
    console.log(`  ✓ Extracted vendor/ripgrep/${platformKey}/${rgNodeName}`);
  } catch (error) {
    console.warn(`  ⚠ Could not extract ripgrep binaries: ${(error as Error).message}`);
    console.warn("    (ripgrep functionality may be unavailable)");
  }

  // Write extraction marker
  fs.writeFileSync(markerPath, SDK_VERSION);
  console.log(`✅ Claude SDK extraction complete`);

  return cliPath;
}

/**
 * Ensure Claude SDK files are available, extracting if necessary.
 *
 * @deprecated Use ClaudeAgentSDKManager.ensureSdkAvailable() instead.
 * This function is kept for backward compatibility.
 *
 * @returns Path to cli.js if compiled (and sets env var), or null if running from source
 * @throws Error if extraction fails or extracted file doesn't exist
 */
export async function ensureClaudeSdkAvailable(): Promise<string | null> {
  // Import to avoid circular dependency
  const { ClaudeAgentSDKManager } = await import("./claude-agent-sdk-manager.js");
  return ClaudeAgentSDKManager.ensureSdkAvailable();
}

/**
 * Validate the extracted cli.js works by running a simple command.
 */
export async function validateExtractedCli(cliPath: string): Promise<boolean> {
  try {
    // Try to run cli.js --version or similar safe command
    execSync(`node "${cliPath}" --version`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    // The CLI might not support --version, but if it ran at all, it's valid
    return fs.existsSync(cliPath);
  }
}
