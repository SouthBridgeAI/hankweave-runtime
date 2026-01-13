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
 * Uses ~/.hankweave/claude-sdk/<version>/ by default.
 */
export function getExtractionDir(): string {
  const cacheDir = process.env.HANKWEAVE_CACHE_DIR || path.join(os.homedir(), ".hankweave");
  return path.join(cacheDir, "claude-sdk", SDK_VERSION);
}

/**
 * Get the path to the extracted cli.js file.
 */
export function getExtractedCliPath(): string {
  return path.join(getExtractionDir(), "cli.js");
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
 * Read an embedded file from Bun.embeddedFiles.
 *
 * Throws if the file doesn't exist or can't be read.
 */
async function readEmbeddedFile(embeddedPath: string): Promise<ArrayBuffer> {
  // Normalize to forward slashes
  const normalizedPath = embeddedPath.replace(/\\/g, "/");
  const basename = path.basename(normalizedPath);
  // Also check for basename with trailing dot (Bun adds this for extensionless files)
  const basenameWithDot = `${basename}.`;

  // Try to find in Bun.embeddedFiles
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

  // File not found in embedded files
  throw new Error(`Embedded file not found: ${embeddedPath}`);
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
  // Note: cli.js is embedded as cli.bundle to avoid Bun's special .js handling
  const filesToExtract = [
    { embeddedName: "cli.bundle", outputName: "cli.js", required: true },
    { embeddedName: "resvg.wasm", outputName: "resvg.wasm", required: false }, // SVG rendering
    { embeddedName: "tree-sitter.wasm", outputName: "tree-sitter.wasm", required: false }, // Syntax parsing
    { embeddedName: "tree-sitter-bash.wasm", outputName: "tree-sitter-bash.wasm", required: false }, // Bash syntax
  ];

  // Extract main files
  for (const file of filesToExtract) {
    // Path matches what was embedded: node_modules/@anthropic-ai/claude-agent-sdk/<file>
    const embeddedPath = `${EMBEDDED_SDK_PATH}/${file.embeddedName}`;
    const destPath = path.join(extractDir, file.outputName);

    try {
      const content = await readEmbeddedFile(embeddedPath);
      await Bun.write(destPath, content);
      console.log(`  ✓ Extracted ${file.outputName} (${computeFileHash(Buffer.from(content))})`);
    } catch (error) {
      if (file.required) {
        throw new Error(`Failed to extract ${file.outputName}: ${(error as Error).message}`);
      }
      console.warn(`  ⚠ Could not extract ${file.outputName}: ${(error as Error).message}`);
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
    // Note: We pass the full path but readEmbeddedFile will also check by basename
    const rgEmbeddedPath = `${EMBEDDED_SDK_PATH}/vendor/ripgrep/${platformKey}/${rgBinaryName}`;
    const rgDestPath = path.join(ripgrepDestDir, rgBinaryName);
    try {
      const rgContent = await readEmbeddedFile(rgEmbeddedPath);
      await Bun.write(rgDestPath, rgContent);

      // Make rg executable on Unix systems
      if (platformKey !== "x64-win32") {
        fs.chmodSync(rgDestPath, 0o755);
      }
      console.log(`  ✓ Extracted vendor/ripgrep/${platformKey}/${rgBinaryName}`);
    } catch (error) {
      console.warn(`  ⚠ Could not extract ${rgBinaryName}: ${(error as Error).message}`);
    }

    // Extract ripgrep.node
    const nodeEmbeddedPath = `${EMBEDDED_SDK_PATH}/vendor/ripgrep/${platformKey}/${rgNodeName}`;
    const nodeDestPath = path.join(ripgrepDestDir, rgNodeName);
    try {
      const nodeContent = await readEmbeddedFile(nodeEmbeddedPath);
      await Bun.write(nodeDestPath, nodeContent);
      console.log(`  ✓ Extracted vendor/ripgrep/${platformKey}/${rgNodeName}`);
    } catch (error) {
      console.warn(`  ⚠ Could not extract ${rgNodeName}: ${(error as Error).message}`);
    }
  } catch (error) {
    console.warn(`  ⚠ Could not setup ripgrep directory: ${(error as Error).message}`);
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
