#!/usr/bin/env bun
/**
 * Local testing with Verdaccio for developers who want to test
 * registry behavior before pushing to CI
 *
 * This script:
 * 1. Starts a local Verdaccio registry
 * 2. Configures .npmrc to use it
 * 3. Builds and publishes the package
 * 4. Tests with npx, bunx, and pnpm dlx
 * 5. Restores original .npmrc
 */

import { spawn } from "node:child_process";
import { writeFile, rm, rename, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

function log(message: string, color?: string) {
  if (color) {
    console.log(`${color}${message}${colors.reset}`);
  } else {
    console.log(message);
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const result = await execCommand(
      process.platform === "win32" ? "where" : "which",
      [cmd]
    );
    return result.success;
  } catch {
    return false;
  }
}

async function execCommand(
  cmd: string,
  args: string[]
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: "inherit" });
    proc.on("close", (code) => {
      resolve({ success: code === 0, output: "" });
    });
    proc.on("error", () => {
      resolve({ success: false, output: "" });
    });
  });
}

async function main() {
  log("\n🚀 Starting local Verdaccio testing...\n", colors.blue);

  // Check if Verdaccio is installed
  const hasVerdaccio = await commandExists("verdaccio");
  if (!hasVerdaccio) {
    log("❌ Verdaccio not installed. Install with:", colors.red);
    log("   npm install -g verdaccio\n");
    process.exit(1);
  }

  // Start Verdaccio
  log("📦 Starting Verdaccio...", colors.blue);
  const verdaccioConfig = ".github/verdaccio/config.yaml";

  if (!existsSync(verdaccioConfig)) {
    log(`❌ Config file not found: ${verdaccioConfig}`, colors.red);
    process.exit(1);
  }

  const verdaccio = spawn("verdaccio", ["--config", verdaccioConfig], {
    detached: true,
    stdio: "ignore",
  });
  verdaccio.unref();

  // Wait for Verdaccio to start
  await new Promise((resolve) => setTimeout(resolve, 3000));
  log("✅ Verdaccio running on http://localhost:4873\n", colors.green);

  // Backup existing .npmrc if it exists
  let hasOriginalNpmrc = false;
  if (existsSync(".npmrc")) {
    log("📝 Backing up existing .npmrc...", colors.gray);
    if (existsSync(".npmrc.backup")) {
      await rm(".npmrc.backup");
    }
    await rename(".npmrc", ".npmrc.backup");
    hasOriginalNpmrc = true;
  }

  // Create .npmrc pointing to Verdaccio
  log("📝 Configuring registry...", colors.blue);
  await writeFile(".npmrc", "registry=http://localhost:4873/\n");

  try {
    // Build
    log("\n🏗️  Building package...", colors.blue);
    const buildResult = await execCommand("bun", ["run", "build"]);
    if (!buildResult.success) {
      log("❌ Build failed", colors.red);
      process.exit(1);
    }
    log("✅ Build complete", colors.green);

    // Publish
    log("\n📤 Publishing to local registry...", colors.blue);
    const publishResult = await execCommand("npm", ["publish"]);
    if (!publishResult.success) {
      log("❌ Publish failed", colors.red);
      log("   (This is normal if the package version already exists)", colors.yellow);
      log("   Try bumping the version in package.json", colors.yellow);
    } else {
      log("✅ Published to Verdaccio", colors.green);
    }

    // Test package runners
    log("\n🧪 Testing package runners...\n", colors.blue);

    // Test npx
    log("--- Testing with npx (npm) ---", colors.blue);
    const npxResult = await execCommand("npx", ["strandweave@0.1.0", "--help"]);
    if (npxResult.success) {
      log("✅ npx works\n", colors.green);
    } else {
      log("❌ npx failed\n", colors.red);
    }

    // Test bunx
    log("--- Testing with bunx (bun) ---", colors.blue);
    if (await commandExists("bun")) {
      const bunxResult = await execCommand("bunx", ["strandweave@0.1.0", "--help"]);
      if (bunxResult.success) {
        log("✅ bunx works\n", colors.green);
      } else {
        log("❌ bunx failed\n", colors.red);
      }
    } else {
      log("⚠️  bun not available\n", colors.yellow);
    }

    // Test pnpm dlx
    log("--- Testing with pnpm dlx (pnpm) ---", colors.blue);
    if (await commandExists("pnpm")) {
      const pnpmResult = await execCommand("pnpm", ["dlx", "strandweave@0.1.0", "--help"]);
      if (pnpmResult.success) {
        log("✅ pnpm dlx works\n", colors.green);
      } else {
        log("❌ pnpm dlx failed\n", colors.red);
      }
    } else {
      log("⚠️  pnpm not available\n", colors.yellow);
    }

    log("\n✅ Testing complete!\n", colors.green);
  } finally {
    // Restore original .npmrc
    log("🧹 Cleaning up...", colors.gray);
    await rm(".npmrc");
    if (hasOriginalNpmrc) {
      await rename(".npmrc.backup", ".npmrc");
      log("✅ Restored original .npmrc", colors.green);
    }

    log("\n⚠️  Remember to stop Verdaccio when done:", colors.yellow);
    if (process.platform === "win32") {
      log("   taskkill /F /IM verdaccio.exe\n", colors.gray);
    } else {
      log("   pkill -f verdaccio\n", colors.gray);
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    log(`\n❌ Error: ${error.message}`, colors.red);
    process.exit(1);
  });
}
