/**
 * Claude Runtime Extractor
 *
 * Handles locating/extracting the Claude Agent SDK's native CLI binary.
 *
 * As of @anthropic-ai/claude-agent-sdk 0.3.x, the agent runtime ships as a native,
 * per-platform compiled binary delivered through optionalDependencies
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude[.exe]`) — there is no longer a
 * bundled `cli.js` + wasm + ripgrep vendor tree.
 *
 * Execution contexts:
 * 1. Source / npm / npx mode: the SDK resolves the native binary itself via the optional
 *    dependency, so no extraction is needed (ensureSdkAvailable returns null).
 * 2. Compiled executable (`bun build --compile`): the native binary is embedded at build
 *    time (scripts/build-executable.ts) and extracted to disk here on first run, because the
 *    SDK's own `require.resolve` cannot reach into Bun's `$bunfs` virtual filesystem.
 *
 * Extraction targets a versioned directory to avoid re-extraction and to handle SDK updates.
 */

import os from "node:os";
import path from "node:path";
import {
  needsExtraction as baseNeedsExtraction,
  extractFiles,
  type FileToExtract,
  getComponentExtractionDir,
} from "./runtime-extractor-base.js";

// SDK version — also used for the extraction cache directory name. It is the only
// cache-busting key for the extracted native runtime, so a stale value makes upgraded
// standalone binaries silently keep the previously extracted executable. Must match the
// @anthropic-ai/claude-agent-sdk version pinned in package.json (enforced by a unit test).
export const CLAUDE_SDK_VERSION = "0.3.232";

/**
 * Resolve the platform/arch suffix used by the SDK's native binary packages,
 * e.g. "darwin-arm64", "linux-x64", "win32-x64".
 *
 * @param target - Optional build target ("linux-x64", "darwin-arm64", "windows-x64", …).
 *                 When omitted, uses the current platform.
 */
export function getClaudePlatformSuffix(target?: string): string {
  let platform: string;
  let arch: string;

  if (target) {
    [platform, arch] = target.split("-");
    // Build targets use "windows"; npm package names use "win32".
    if (platform === "windows") platform = "win32";
  } else {
    platform = os.platform() === "win32" ? "win32" : os.platform();
    arch = os.arch() === "arm64" ? "arm64" : "x64";
  }

  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new Error(`Unsupported platform for Claude Agent SDK: ${platform}-${arch}`);
  }
  return `${platform}-${arch}`;
}

/**
 * The native CLI binary filename for the given target (or current platform).
 */
export function getClaudeBinaryName(target?: string): string {
  const isWindows = target ? target.startsWith("windows") : os.platform() === "win32";
  return isWindows ? "claude.exe" : "claude";
}

/**
 * The node_modules directory of the platform-specific binary package, e.g.
 * `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64`.
 *
 * On Linux the package may be the glibc (`-x64`) or musl (`-x64-musl`) variant; callers that
 * need the on-disk path (the build script) should fall back to the `-musl` suffix when the
 * primary directory is absent.
 */
export function getClaudePackageDir(target?: string): string {
  return `node_modules/@anthropic-ai/claude-agent-sdk-${getClaudePlatformSuffix(target)}`;
}

/** Path prefix for the embedded binary (must match the path embedded during build). */
function getEmbeddedClaudeBasePath(): string {
  return getClaudePackageDir();
}

/**
 * Get the extraction directory (e.g. ~/.hankweave/claude-sdk/<version>/).
 */
export function getClaudeExtractionDir(): string {
  return getComponentExtractionDir("claude-sdk", CLAUDE_SDK_VERSION);
}

/**
 * Path to the extracted native CLI binary. Named `getExtractedCliPath` for backward
 * compatibility with ClaudeAgentSDKManager.ensureSdkAvailable().
 */
export function getExtractedCliPath(): string {
  return path.join(getClaudeExtractionDir(), getClaudeBinaryName());
}

/**
 * Whether the embedded binary still needs to be extracted (missing or outdated cache).
 */
export function needsExtraction(): boolean {
  return baseNeedsExtraction(getClaudeExtractionDir(), CLAUDE_SDK_VERSION, ".extraction-complete", [
    getClaudeBinaryName(),
  ]);
}

/**
 * Extract the embedded native CLI binary to disk.
 *
 * Reads the binary embedded at build time via Bun's --embed flag and writes it to the
 * versioned extraction directory, marking it executable.
 *
 * @returns Path to the extracted binary.
 */
export async function extractClaudeSdkFiles(): Promise<string> {
  const binaryName = getClaudeBinaryName();

  const filesToExtract: FileToExtract[] = [
    {
      embeddedPath: binaryName,
      outputPath: binaryName,
      required: true,
      makeExecutable: true,
    },
  ];

  await extractFiles({
    componentName: "claude-sdk",
    version: CLAUDE_SDK_VERSION,
    embeddedBasePath: getEmbeddedClaudeBasePath(),
    filesToExtract,
    markerFileName: ".extraction-complete",
  });

  return getExtractedCliPath();
}
