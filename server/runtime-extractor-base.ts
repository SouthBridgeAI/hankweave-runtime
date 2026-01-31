/**
 * Runtime Extractor Base
 *
 * Shared utilities for extracting embedded runtime files (binaries, SDKs, shims)
 * from compiled executables. This module provides common functionality used by:
 * - codex-runtime-extractor.ts (Codex binary extraction)
 * - claude-runtime-extractor.ts (Claude SDK files extraction)
 * - shim-runtime-extractor.ts (Shim files extraction)
 *
 * Key Concepts:
 * - Embedded files: Files bundled into the executable using Bun's --embed flag
 * - Extraction: Writing embedded files to disk for use as subprocesses
 * - Versioned cache: Extracted files stored in versioned directories (e.g., ~/.hankweave/component/version/)
 * - Marker files: Indicate successful extraction and version tracking
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Configuration for a single file to extract
 */
export interface FileToExtract {
  /** Path to the embedded file (e.g., "node_modules/package/file.js") */
  embeddedPath: string;
  /** Path where the file should be extracted (relative to extraction directory) */
  outputPath: string;
  /** Whether extraction should fail if this file is missing */
  required: boolean;
  /** Whether to make the file executable (Unix only) */
  makeExecutable?: boolean;
}

/**
 * Configuration for extracting a component's files
 */
export interface ExtractionConfig {
  /** Human-readable component name (e.g., "Codex", "Claude SDK") */
  componentName: string;
  /** Version string for cache directory naming */
  version: string;
  /** Optional base path prefix for embedded files */
  embeddedBasePath?: string;
  /** List of files to extract */
  filesToExtract: FileToExtract[];
  /** Custom marker file name (defaults to ".extraction-complete") */
  markerFileName?: string;
  /** Optional function to validate extraction was successful */
  validateExtraction?: (extractionDir: string) => boolean;
}

/**
 * Result of an extraction operation
 */
export interface ExtractionResult {
  /** Directory where files were extracted */
  extractionDir: string;
  /** Paths of successfully extracted files */
  extractedFiles: string[];
  /** Files that failed to extract (with error messages) */
  failedFiles: Array<{ path: string; error: string }>;
  /** Whether cached files were used (no extraction needed) */
  usedCache: boolean;
}

/**
 * Get the Bun virtual filesystem prefix for the current platform.
 * - Unix: /$bunfs/root
 * - Windows: X:/~BUN/root (where X is the drive letter from process.argv[1])
 */
export function getBunVfsPrefix(): string {
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
 * Read an embedded file from Bun.embeddedFiles.
 *
 * First tries to find the file in Bun.embeddedFiles (the recommended way),
 * then falls back to Bun.file() with various path formats.
 *
 * Throws if the file doesn't exist or can't be read.
 */
export async function readEmbeddedFile(embeddedPath: string): Promise<ArrayBuffer> {
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

/**
 * Compute a hash of file content for verification.
 * Returns first 12 characters of MD5 hash for compact display.
 */
export function computeFileHash(content: Buffer | string): string {
  return createHash("md5").update(content).digest("hex").slice(0, 12);
}

/**
 * Get the base extraction directory (usually ~/.hankweave/).
 * Respects HANKWEAVE_CACHE_DIR environment variable.
 */
export function getExtractionBaseDir(): string {
  return process.env.HANKWEAVE_CACHE_DIR || path.join(os.homedir(), ".hankweave");
}

/**
 * Get the extraction directory for a specific component and version.
 *
 * @param componentName - Component identifier (e.g., "codex-sdk", "claude-sdk", "shims")
 * @param version - Version string for directory naming
 * @returns Full path to extraction directory (e.g., ~/.hankweave/codex-sdk/0.87.0/)
 */
export function getComponentExtractionDir(componentName: string, version: string): string {
  return path.join(getExtractionBaseDir(), componentName, version);
}

/**
 * Check if extraction is needed based on marker file and version.
 *
 * @param extractionDir - Directory where files would be extracted
 * @param expectedVersion - Version string to compare against marker
 * @param markerFileName - Name of marker file (defaults to ".extraction-complete")
 * @param requiredFiles - Optional list of files that must exist
 * @returns true if extraction is needed, false if cache is valid
 */
export function needsExtraction(
  extractionDir: string,
  expectedVersion: string,
  markerFileName = ".extraction-complete",
  requiredFiles?: string[],
): boolean {
  const markerPath = path.join(extractionDir, markerFileName);

  // Check if marker file exists
  if (!fs.existsSync(markerPath)) {
    return true;
  }

  // Check marker content matches expected version
  try {
    const marker = fs.readFileSync(markerPath, "utf-8").trim();
    if (marker !== expectedVersion) {
      return true;
    }
  } catch {
    return true;
  }

  // Check if required files exist
  if (requiredFiles) {
    for (const filePath of requiredFiles) {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(extractionDir, filePath);
      if (!fs.existsSync(fullPath)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extract embedded files to disk based on configuration.
 *
 * This is the main extraction engine that:
 * 1. Creates extraction directory
 * 2. Optionally lists all embedded files for debugging
 * 3. Extracts each configured file
 * 4. Sets executable permissions where needed
 * 5. Writes version marker file
 *
 * @param config - Extraction configuration
 * @param debugListFiles - Whether to log all embedded files (default: true)
 * @returns Extraction result with paths and status
 * @throws Error if required files fail to extract
 */
export async function extractFiles(
  config: ExtractionConfig,
  debugListFiles = true,
): Promise<ExtractionResult> {
  const extractionDir = getComponentExtractionDir(config.componentName, config.version);
  const markerFileName = config.markerFileName || ".extraction-complete";
  const markerPath = path.join(extractionDir, markerFileName);

  console.log(`📦 Extracting ${config.componentName} files to: ${extractionDir}`);

  // Debug: List all embedded files if requested
  if (debugListFiles) {
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
  }

  // Create extraction directory
  try {
    fs.mkdirSync(extractionDir, { recursive: true });
  } catch (error) {
    const errorMsg = `Failed to create extraction directory: ${(error as Error).message}`;
    console.error(`❌ ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const extractedFiles: string[] = [];
  const failedFiles: Array<{ path: string; error: string }> = [];

  // Extract each file
  for (const fileConfig of config.filesToExtract) {
    const embeddedPath = config.embeddedBasePath
      ? `${config.embeddedBasePath}/${fileConfig.embeddedPath}`
      : fileConfig.embeddedPath;

    const destPath = path.isAbsolute(fileConfig.outputPath)
      ? fileConfig.outputPath
      : path.join(extractionDir, fileConfig.outputPath);

    try {
      console.log(`  Extracting ${path.basename(fileConfig.outputPath)} from ${embeddedPath}...`);

      // Read embedded file
      console.log(`  Reading embedded file...`);
      const content = await readEmbeddedFile(embeddedPath);
      const sizeMB = (content.byteLength / 1024 / 1024).toFixed(2);
      console.log(`  Read ${sizeMB} MB from embedded file`);

      // Create destination directory if needed
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      // Write file
      console.log(`  Writing to ${destPath}...`);
      await Bun.write(destPath, content);
      console.log(`  Wrote ${sizeMB} MB to disk`);

      // Make executable if requested (Unix only)
      if (fileConfig.makeExecutable && os.platform() !== "win32") {
        fs.chmodSync(destPath, 0o755);
      }

      console.log(
        `  ✓ Extracted ${path.basename(fileConfig.outputPath)} (${computeFileHash(Buffer.from(content))})`,
      );
      extractedFiles.push(destPath);
    } catch (error) {
      const errorMsg = (error as Error).message;
      const stack = (error as Error).stack || "";
      console.error(`  ✗ Extraction failed for ${fileConfig.outputPath}:`);
      console.error(`    Error: ${errorMsg}`);
      if (stack) {
        console.error(`    Stack: ${stack.split("\n").slice(0, 3).join("\n    ")}`);
      }
      failedFiles.push({ path: fileConfig.outputPath, error: errorMsg });

      if (fileConfig.required) {
        throw new Error(`Failed to extract required file ${fileConfig.outputPath}: ${errorMsg}`);
      }

      console.warn(`  ⚠ Could not extract ${fileConfig.outputPath}: ${errorMsg}`);
    }
  }

  // Run custom validation if provided
  if (config.validateExtraction) {
    const isValid = config.validateExtraction(extractionDir);
    if (!isValid) {
      throw new Error(`Extraction validation failed for ${config.componentName}`);
    }
  }

  // Write extraction marker
  fs.writeFileSync(markerPath, config.version);
  console.log(`✅ ${config.componentName} extraction complete`);

  return {
    extractionDir,
    extractedFiles,
    failedFiles,
    usedCache: false,
  };
}
