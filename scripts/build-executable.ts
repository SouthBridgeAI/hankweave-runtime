#!/usr/bin/env bun
/**
 * Build script for Hankweave standalone executable
 *
 * This script compiles the Hankweave server into a single standalone
 * executable that includes all necessary Claude SDK files embedded.
 *
 * Usage:
 *   bun scripts/build-executable.ts [target] [output]
 *
 * Arguments:
 *   target   - Build target: linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64
 *              Defaults to current platform
 *   output   - Output filename (defaults to 'hankweave' or 'hankweave.exe' for Windows)
 *
 * Examples:
 *   bun scripts/build-executable.ts                          # Build for current platform
 *   bun scripts/build-executable.ts linux-x64                # Build for Linux x64
 *   bun scripts/build-executable.ts darwin-arm64 my-binary   # Build for macOS ARM64 with custom name
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getClaudeBinaryName,
  getClaudePackageDir,
} from "../server/claude-runtime-extractor.js";
import { getCodexPlatform } from "../server/codex-runtime-extractor.js";

// Configuration
const ENTRY_POINT = "server/index.ts";
const OUTPUT_DIR = "releases";

/**
 * Resolve the on-disk directory of the Claude Agent SDK native binary package for a target.
 *
 * As of SDK 0.3.x the runtime ships as a per-platform native binary in
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`. On Linux the installed package may be
 * the glibc (`-x64`) or musl (`-x64-musl`) variant, so fall back to `-musl` when needed.
 */
function resolveClaudePackageDir(target?: string): string {
  const base = getClaudePackageDir(target);
  if (fs.existsSync(base)) return base;
  const muslVariant = `${base}-musl`;
  if (fs.existsSync(muslVariant)) return muslVariant;
  return base; // primary path; the caller's existence check reports a clear error
}

// Get the platform-specific codex package directory name
// In codex-sdk v0.101.0+, binaries are in @openai/codex-<platform>-<arch>/vendor/
function getCodexPackageDir(target?: string): string {
  let platform: string;
  let arch: string;

  if (target) {
    [platform, arch] = target.split("-");
    // Map 'windows' to 'win32' to match npm package naming
    if (platform === "windows") platform = "win32";
  } else {
    platform = os.platform() === "win32" ? "win32" : os.platform();
    arch = os.arch() === "arm64" ? "arm64" : "x64";
  }

  return `node_modules/@openai/codex-${platform}-${arch}`;
}

// Get Bun target string
function getBunTarget(target?: string): string | undefined {
  if (!target) {
    return undefined;
  }

  const targetMap: Record<string, string> = {
    "linux-x64": "bun-linux-x64",
    "linux-arm64": "bun-linux-arm64",
    "darwin-x64": "bun-darwin-x64",
    "darwin-arm64": "bun-darwin-arm64",
    "windows-x64": "bun-windows-x64",
  };

  const bunTarget = targetMap[target];
  if (!bunTarget) {
    throw new Error(
      `Unknown target: ${target}. Valid targets: ${Object.keys(targetMap).join(", ")}`,
    );
  }
  return bunTarget;
}

async function main() {
  const args = process.argv.slice(2);
  const target = args[0];
  const outputBase = args[1] || "hankweave";

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Determine output filename (in releases directory)
  const isWindows = target?.startsWith("windows");
  const outputFileName =
    isWindows && !outputBase.endsWith(".exe")
      ? `${outputBase}.exe`
      : outputBase;
  const outputFile = path.join(OUTPUT_DIR, outputFileName);

  // Each shim gets a unique bundle filename because Bun deduplicates embedded
  // files by basename — four "index.bundle" entries would collapse to one.
  const SHIM_NAMES = ["gemini", "codex", "opencode", "pi"] as const;
  const shimBundles: Array<{ name: string; source: string; bundle: string }> =
    SHIM_NAMES.map((name) => ({
      name,
      source: path.join("shims", name, "index.js"),
      bundle: path.join("shims", `${name}.bundle`),
    }));

  try {
    console.log("🔨 Building Hankweave standalone executable\n");

    // Read version from package.json for build-time constants
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf-8"));
    const buildVersion = packageJson.version;
    const buildDate = new Date().toISOString();
    const buildTarget = target || "current-platform";

    console.log(`📝 Build metadata:`);
    console.log(`   Version: ${buildVersion}`);
    console.log(`   Target: ${buildTarget}`);
    console.log(`   Date: ${buildDate}\n`);

    // Verify SDKs exist.
    // Claude Agent SDK 0.3.x ships the runtime as a native per-platform binary package.
    const claudePackageDir = resolveClaudePackageDir(target);
    const claudeBinaryName = getClaudeBinaryName(target);
    const claudeBinaryPath = path.join(claudePackageDir, claudeBinaryName);
    if (!fs.existsSync(claudeBinaryPath)) {
      console.error(`❌ Claude Agent SDK native binary not found at ${claudeBinaryPath}`);
      console.error(
        "   Run 'bun install' first. For cross-compilation, force-install the target's platform package, e.g.\n" +
          "     npm install @anthropic-ai/claude-agent-sdk-linux-x64 --force",
      );
      process.exit(1);
    }

    const codexPackageDir = getCodexPackageDir(target);
    if (!fs.existsSync(codexPackageDir)) {
      console.error(
        `❌ Codex platform package not found at ${codexPackageDir}`,
      );
      console.error(
        "   Run 'bun install' first. For cross-compilation, ensure the target platform package is available.",
      );
      process.exit(1);
    }

    // Determine codex platform
    const codexPlatform = getCodexPlatform(target);
    console.log(`📦 Target: ${target || "current platform"}`);
    console.log(`📦 Claude binary: ${claudeBinaryPath}`);
    console.log(`📦 Codex platform: ${codexPlatform}`);

    // Copy shim .js files to .bundle to avoid Bun treating them as entry points.
    // Bun has special handling for .js files that prevents them from being embedded properly —
    // it rebundles them instead of preserving the raw bytes, which truncates large bundles.
    // (The Claude and Codex native binaries are raw bytes, so they're embedded directly.)
    console.log(`\n📋 Preparing shim .js files for embedding as .bundle...`);
    for (const { source, bundle } of shimBundles) {
      fs.copyFileSync(source, bundle);
      console.log(`   ✓ ${source} → ${bundle}`);
    }

    // Build the list of files to embed (use relative paths - they work better with embedding)
    const codexBinaryName = isWindows ? "codex.exe" : "codex";

    // codex-sdk v0.135.0+ ships the binary under <triple>/bin/; older versions used <triple>/codex/.
    // Mirror codex-runtime-extractor's resolveCodexBinaryInTripleDir() ordering.
    const codexTripleDir = path.join(codexPackageDir, "vendor", codexPlatform);
    const codexBinaryPath =
      [
        path.join(codexTripleDir, "bin", codexBinaryName), // v0.135.0+
        path.join(codexTripleDir, "codex", codexBinaryName), // legacy
      ].find((p) => fs.existsSync(p)) ?? path.join(codexTripleDir, "bin", codexBinaryName);

    const filesToEmbed = [
      // Claude Agent SDK native runtime binary (0.3.x: one binary per platform, self-contained —
      // ripgrep/wasm are baked into it, so no separate vendor files are needed).
      claudeBinaryPath,
      // Codex SDK binary (platform-specific, v0.101.0+ uses separate @openai/codex-<platform>-<arch> packages)
      codexBinaryPath,
      // Shim files — embedded as .bundle to avoid Bun's .js rebundling
      ...shimBundles.map(({ bundle }) => bundle),
    ];

    // Verify all files exist
    console.log("\n📁 Files to embed:");
    let totalEmbedSize = 0;
    for (const file of filesToEmbed) {
      if (!fs.existsSync(file)) {
        console.error(`❌ Required file not found: ${file}`);
        process.exit(1);
      }
      const size = fs.statSync(file).size;
      totalEmbedSize += size;
      console.log(`   ✓ ${file} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    }
    console.log(`   Total: ${(totalEmbedSize / 1024 / 1024).toFixed(2)} MB`);

    // Build target flag
    const bunTarget = getBunTarget(target);

    // Build the arguments array for spawn
    // IMPORTANT: Entry point MUST come BEFORE --compile to avoid embedded .js files being treated as entry points
    const buildArgs = ["build", ENTRY_POINT, "--compile"];

    if (bunTarget) {
      buildArgs.push(`--target=${bunTarget}`);
    }

    // Disable content hashing for embedded files to preserve original names
    buildArgs.push("--asset-naming", "[name].[ext]");

    // Add embed flags
    for (const file of filesToEmbed) {
      buildArgs.push("--embed", file);
    }

    // Add build-time constants via --define
    // Note: Values must be valid JavaScript expressions (e.g., strings need quotes)
    buildArgs.push("--define", `BUILD_VERSION=${JSON.stringify(buildVersion)}`);
    buildArgs.push("--define", `BUILD_DATE=${JSON.stringify(buildDate)}`);
    buildArgs.push("--define", `BUILD_TARGET=${JSON.stringify(buildTarget)}`);

    buildArgs.push("--outfile", outputFile);

    console.log(`\n🛠️  Build command:\n   bun ${buildArgs.join(" ")}\n`);
    console.log("⏳ Building (this may take a moment)...\n");

    // Run the build using spawn
    // Note: shell:false to avoid quote escaping issues with --define
    const buildProc = spawn("bun", buildArgs, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false,
    });

    await new Promise<void>((resolve, reject) => {
      buildProc.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Build process exited with code ${code}`));
        }
      });
      buildProc.on("error", (error) => {
        reject(error);
      });
    });

    // Verify output exists
    if (!fs.existsSync(outputFile)) {
      throw new Error(
        `Build appeared to succeed but output file not found: ${outputFile}`,
      );
    }

    const outputSize = fs.statSync(outputFile).size;
    console.log(`✅ Build complete!`);
    console.log(
      `📄 Output: ${outputFile} (${(outputSize / 1024 / 1024).toFixed(2)} MB)`,
    );

    // Make executable on Unix
    if (!isWindows) {
      fs.chmodSync(outputFile, 0o755);
      console.log("🔐 Made executable");
    }

    console.log(`\n🎉 You can now run: ./${outputFile} --help`);
  } catch (error) {
    console.error(`\n❌ Build failed: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    // Clean up temporary shim .bundle files
    const bundleFiles = shimBundles.map(({ bundle }) => bundle);
    for (const bundleFile of bundleFiles) {
      if (fs.existsSync(bundleFile)) {
        fs.unlinkSync(bundleFile);
      }
    }
    console.log(
      `\n🧹 Cleaned up ${bundleFiles.length} temporary .bundle files`,
    );
  }
}

main();
