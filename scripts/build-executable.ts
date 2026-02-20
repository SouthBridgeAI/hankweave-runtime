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
import { getCodexPlatform } from "../server/codex-runtime-extractor.js";

// Configuration
const SDK_PATH = "node_modules/@anthropic-ai/claude-agent-sdk";
const ENTRY_POINT = "server/index.ts";
const OUTPUT_DIR = "releases";

// Get the platform-specific ripgrep directory
function getRipgrepPlatform(target?: string): string {
  if (target) {
    // Parse target like "linux-x64", "darwin-arm64"
    const [platform, arch] = target.split("-");
    if (platform === "darwin") {
      return arch === "arm64" ? "arm64-darwin" : "x64-darwin";
    }
    if (platform === "linux") {
      return arch === "arm64" ? "arm64-linux" : "x64-linux";
    }
    if (platform === "windows") {
      return "x64-win32";
    }
  }

  // Default to current platform
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
    throw new Error(`Unknown target: ${target}. Valid targets: ${Object.keys(targetMap).join(", ")}`);
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
  const outputFileName = isWindows && !outputBase.endsWith(".exe") ? `${outputBase}.exe` : outputBase;
  const outputFile = path.join(OUTPUT_DIR, outputFileName);

  // Prepare cli.bundle path for cleanup in finally block
  const cliSource = path.join(SDK_PATH, "cli.js");
  const cliBundle = path.join(SDK_PATH, "cli.bundle");

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

    // Verify SDKs exist
    if (!fs.existsSync(SDK_PATH)) {
      console.error(`❌ Claude Agent SDK not found at ${SDK_PATH}`);
      console.error("   Run 'bun install' first.");
      process.exit(1);
    }

    const codexPackageDir = getCodexPackageDir(target);
    if (!fs.existsSync(codexPackageDir)) {
      console.error(`❌ Codex platform package not found at ${codexPackageDir}`);
      console.error("   Run 'bun install' first. For cross-compilation, ensure the target platform package is available.");
      process.exit(1);
    }

    // Determine ripgrep and codex platforms
    const ripgrepPlatform = getRipgrepPlatform(target);
    const codexPlatform = getCodexPlatform(target);
    console.log(`📦 Target: ${target || "current platform"}`);
    console.log(`📦 Ripgrep platform: ${ripgrepPlatform}`);
    console.log(`📦 Codex platform: ${codexPlatform}`);

    // Copy cli.js to cli.bundle to avoid Bun treating it as an entry point
    // Bun has special handling for .js files that prevents them from being embedded properly
    console.log(`\n📋 Preparing cli.js for embedding...`);
    fs.copyFileSync(cliSource, cliBundle);
    console.log(`   ✓ Created temporary cli.bundle`);

    // Build the list of files to embed (use relative paths - they work better with embedding)
    const codexBinaryName = isWindows ? "codex.exe" : "codex";

    const filesToEmbed = [
      // Claude Agent SDK files
      // Note: We embed cli.bundle instead of cli.js to avoid Bun's special .js handling
      cliBundle,
      path.join(SDK_PATH, "resvg.wasm"),
      path.join(SDK_PATH, "tree-sitter.wasm"),
      path.join(SDK_PATH, "tree-sitter-bash.wasm"),
      path.join(SDK_PATH, "vendor/ripgrep", ripgrepPlatform, ripgrepPlatform === "x64-win32" ? "rg.exe" : "rg"),
      path.join(SDK_PATH, "vendor/ripgrep", ripgrepPlatform, "ripgrep.node"),
      // Codex SDK binary (platform-specific, v0.101.0+ uses separate @openai/codex-<platform>-<arch> packages)
      path.join(codexPackageDir, "vendor", codexPlatform, "codex", codexBinaryName),
      // Shim files (use .js extension for embedding compatibility)
      path.join("shims", "gemini", "index.js"),
      path.join("shims", "codex", "index.js"),
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
      throw new Error(`Build appeared to succeed but output file not found: ${outputFile}`);
    }

    const outputSize = fs.statSync(outputFile).size;
    console.log(`✅ Build complete!`);
    console.log(`📄 Output: ${outputFile} (${(outputSize / 1024 / 1024).toFixed(2)} MB)`);

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
    // Clean up temporary cli.bundle file
    if (fs.existsSync(cliBundle)) {
      fs.unlinkSync(cliBundle);
      console.log(`\n🧹 Cleaned up temporary cli.bundle`);
    }
  }
}

main();
