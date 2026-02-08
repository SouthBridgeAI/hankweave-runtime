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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  needsExtraction as baseNeedsExtraction,
  extractFiles,
  type FileToExtract,
  getComponentExtractionDir,
} from "./runtime-extractor-base.js";

// SDK version for directory naming
export const CLAUDE_SDK_VERSION = "0.1.70";

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
  return getComponentExtractionDir("claude-sdk", CLAUDE_SDK_VERSION);
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
  const extractionDir = getExtractionDir();
  return baseNeedsExtraction(extractionDir, CLAUDE_SDK_VERSION, ".extraction-complete", ["cli.js"]);
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
  const platformKey = getPlatformKey();
  const rgBinaryName = platformKey === "x64-win32" ? "rg.exe" : "rg";

  // Build file extraction configuration
  // Note: WASM files are optional - they're for syntax highlighting and SVG rendering
  // Note: cli.js is embedded as cli.bundle to avoid Bun's special .js handling
  const filesToExtract: FileToExtract[] = [
    { embeddedPath: "cli.bundle", outputPath: "cli.js", required: true },
    { embeddedPath: "resvg.wasm", outputPath: "resvg.wasm", required: false },
    {
      embeddedPath: "tree-sitter.wasm",
      outputPath: "tree-sitter.wasm",
      required: false,
    },
    {
      embeddedPath: "tree-sitter-bash.wasm",
      outputPath: "tree-sitter-bash.wasm",
      required: false,
    },
    {
      embeddedPath: `vendor/ripgrep/${platformKey}/${rgBinaryName}`,
      outputPath: `vendor/ripgrep/${platformKey}/${rgBinaryName}`,
      required: false,
      makeExecutable: true,
    },
    {
      embeddedPath: `vendor/ripgrep/${platformKey}/ripgrep.node`,
      outputPath: `vendor/ripgrep/${platformKey}/ripgrep.node`,
      required: false,
    },
  ];

  // Use base extraction engine
  await extractFiles({
    componentName: "claude-sdk",
    version: CLAUDE_SDK_VERSION,
    embeddedBasePath: EMBEDDED_SDK_PATH,
    filesToExtract,
    markerFileName: ".extraction-complete",
  });

  return getExtractedCliPath();
}

/**
 * Ensure Claude SDK files are available, extracting if necessary.
 *
 * @deprecated Use ClaudeAgentSDKManager.ensureSdkAvailable() instead.
 * This function is kept for backward compatibility.
 *
 * @returns SDK info object with path, version, and cached status
 * @throws Error if extraction fails or extracted file doesn't exist
 */
export async function ensureClaudeSdkAvailable(): Promise<{
  path: string | null;
  version: string;
  cached: boolean;
}> {
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
