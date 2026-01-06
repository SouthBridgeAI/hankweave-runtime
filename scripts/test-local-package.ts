#!/usr/bin/env bun
/**
 * Local package testing script for strandweave
 * Cross-platform TypeScript version (works on Windows, macOS, Linux)
 */

import { mkdir, rm, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

// ANSI color codes for output
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

function log(message: string) {
  console.log(message);
}

function logSuccess(message: string) {
  console.log(`${colors.green}${message}${colors.reset}`);
}

function logError(message: string) {
  console.log(`${colors.red}${message}${colors.reset}`);
}

function logWarning(message: string) {
  console.log(`${colors.yellow}${message}${colors.reset}`);
}

function logInfo(message: string) {
  console.log(`${colors.blue}${message}${colors.reset}`);
}

async function execCommand(
  command: string,
  args: string[] = [],
  cwd?: string
): Promise<{ output: string; success: boolean; exitCode: number }> {
  try {
    const proc = Bun.spawn([command, ...args], {
      cwd: cwd || process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const errorOutput = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return {
      output: output + errorOutput,
      success: exitCode === 0,
      exitCode,
    };
  } catch (error) {
    return {
      output: error instanceof Error ? error.message : String(error),
      success: false,
      exitCode: 1,
    };
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const result = await execCommand(
      process.platform === "win32" ? "where" : "which",
      [command]
    );
    return result.success;
  } catch {
    return false;
  }
}

function getFirstLines(text: string, count: number): string {
  return text.split("\n").slice(0, count).join("\n");
}

async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  async function traverse(currentPath: string) {
    const items = await readdir(currentPath);
    for (const item of items) {
      const fullPath = join(currentPath, item);
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        await traverse(fullPath);
      } else {
        totalSize += stats.size;
      }
    }
  }

  await traverse(dirPath);
  return totalSize;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

async function showPackageStructure(packagePath: string) {
  const treeAvailable = await commandExists("tree");

  if (treeAvailable && process.platform !== "win32") {
    const result = await execCommand("tree", [
      "-L",
      "3",
      "-I",
      "node_modules",
      packagePath,
    ]);
    log(result.output);
  } else {
    // Fallback: manual directory listing
    log("node_modules/strandweave/");

    async function listDir(
      dir: string,
      prefix: string = "  ",
      depth: number = 0
    ) {
      if (depth > 2) return;

      const items = await readdir(dir);
      for (const item of items.sort()) {
        if (item === "node_modules") continue;
        const fullPath = join(dir, item);
        const stats = await stat(fullPath);
        const relativePath = fullPath
          .replace(packagePath, "")
          .replace(/^[/\\]/, "");

        log(`${prefix}${relativePath}`);

        if (stats.isDirectory() && depth < 2) {
          await listDir(fullPath, prefix, depth + 1);
        }
      }
    }

    await listDir(packagePath);
  }
}

async function main() {
  const startCwd = process.cwd();

  try {
    log("📦 Strandweave Local Package Testing");
    log("====================================");
    log("");

    // Step 1: Build
    log("🏗️  Step 1: Building package...");
    const buildResult = await execCommand("bun", ["run", "build"]);
    if (!buildResult.success) {
      logError("❌ Build failed");
      log(buildResult.output);
      process.exit(1);
    }
    logSuccess("✅ Build complete");
    log("");

    // Step 2: Pack
    log("📦 Step 2: Creating tarball with npm pack...");
    const packResult = await execCommand("npm", ["pack", "--json"]);
    if (!packResult.success) {
      logError("❌ Pack failed");
      log(packResult.output);
      process.exit(1);
    }

    // Parse the filename from npm pack output
    const packData = JSON.parse(packResult.output);
    const tarball = packData[0]?.filename;
    if (!tarball) {
      logError("❌ Could not determine tarball filename");
      process.exit(1);
    }

    logSuccess(`✅ Created: ${tarball}`);
    log("");

    // Step 3: Create test directory
    const testDir = `test-install-${process.pid}`;
    log(`📁 Step 3: Creating test directory: ${testDir}`);
    await mkdir(testDir, { recursive: true });
    const testDirPath = resolve(testDir);
    process.chdir(testDirPath);

    // Create minimal package.json
    await writeFile(
      "package.json",
      JSON.stringify(
        {
          name: "test-strandweave",
          version: "1.0.0",
          private: true,
        },
        null,
        2
      )
    );
    log("");

    // Step 4: Install
    log("📥 Step 4: Installing package from tarball...");
    const installResult = await execCommand(
      "npm",
      ["install", `../${tarball}`],
      testDirPath
    );
    if (!installResult.success) {
      logError("❌ Install failed");
      log(installResult.output);
      process.exit(1);
    }
    logSuccess("✅ Package installed");
    log("");

    // Step 4.5: Show package structure
    log("📂 Step 4.5: Inspecting installed package structure...");
    log("");
    const packagePath = join(testDirPath, "node_modules", "strandweave");
    await showPackageStructure(packagePath);

    log("");
    log("📊 Package size breakdown:");
    const totalSize = await getDirectorySize(packagePath);
    const distSize = await getDirectorySize(join(packagePath, "dist"));
    const indexSize = (await stat(join(packagePath, "dist", "index.js"))).size;
    const mapPath = join(packagePath, "dist", "index.js.map");
    const mapSize = existsSync(mapPath) ? (await stat(mapPath)).size : 0;

    log(`${formatBytes(totalSize)}\tnode_modules/strandweave`);
    log(`${formatBytes(distSize)}\tnode_modules/strandweave/dist`);
    log(`${formatBytes(indexSize)}\tnode_modules/strandweave/dist/index.js`);
    if (mapSize > 0) {
      log(
        `${formatBytes(mapSize)}\tnode_modules/strandweave/dist/index.js.map`
      );
    } else {
      log("  (no source map)");
    }
    log("");

    // Step 5: Test package runners
    log("🧪 Step 5: Testing with package runners...");
    log("");

    // Test npx
    log("--- Testing with npx (npm) ---");
    if (await commandExists("npx")) {
      const npxResult = await execCommand(
        "npx",
        ["strandweave", "--help"],
        testDirPath
      );
      if (npxResult.success && npxResult.output.includes("Strandweave")) {
        log(getFirstLines(npxResult.output, 10));
        log("...");
        logSuccess("✅ npx works (uses local node_modules)");
      } else {
        logError("❌ npx failed");
        log(getFirstLines(npxResult.output, 10));
      }
    } else {
      logWarning("⚠️  npx not available");
    }
    log("");

    // Test bunx
    log("--- Testing with bunx (bun) ---");
    if (await commandExists("bun")) {
      logInfo("ℹ️  Testing bunx with global link...");
      const linkDir = join(testDirPath, "node_modules", "strandweave");
      const linkResult = await execCommand("bun", ["link"], linkDir);

      if (linkResult.success) {
        const bunxResult = await execCommand(
          "bunx",
          ["--bun", "strandweave", "--help"],
          testDirPath
        );
        if (bunxResult.success && bunxResult.output.includes("Strandweave")) {
          log(getFirstLines(bunxResult.output, 10));
          log("...");
          logSuccess("✅ bunx works (using bun link)");
        } else {
          logError("❌ bunx failed with linked package");
          log(getFirstLines(bunxResult.output, 10));
        }

        // Cleanup
        await execCommand("bun", ["unlink"], linkDir);
      } else {
        logWarning("⚠️  bun link failed:");
        log(getFirstLines(linkResult.output, 5));
        logInfo("ℹ️  Skipping bunx test");
      }
    } else {
      logWarning("⚠️  bun not available");
    }
    log("");

    // Test pnpm
    log("--- Testing with pnpm (pnpm) ---");
    if (await commandExists("pnpm")) {
      logInfo("ℹ️  Testing pnpm with global link...");
      const linkDir = join(testDirPath, "node_modules", "strandweave");
      const linkResult = await execCommand(
        "pnpm",
        ["link", "--global"],
        linkDir
      );

      if (
        linkResult.success ||
        linkResult.output.includes("linked") ||
        linkResult.output.includes("added")
      ) {
        if (await commandExists("strandweave")) {
          const pnpmResult = await execCommand(
            "strandweave",
            ["--help"],
            testDirPath
          );
          if (pnpmResult.success && pnpmResult.output.includes("Strandweave")) {
            log(getFirstLines(pnpmResult.output, 10));
            log("...");
            logSuccess("✅ pnpm link works");
          } else {
            logWarning("⚠️  Linked command not working");
            log(getFirstLines(pnpmResult.output, 10));
          }
        } else {
          logWarning("⚠️  Linked command not in PATH");
        }

        // Cleanup
        await execCommand("pnpm", ["unlink", "--global", "strandweave"]);
      } else {
        logWarning("⚠️  pnpm link failed:");
        log(getFirstLines(linkResult.output, 5));
        logInfo("ℹ️  Skipping pnpm test");
      }
    } else {
      logWarning("⚠️  pnpm not available");
    }
    log("");

    // Step 6: Test runtimes
    log("🔄 Step 6: Testing cross-runtime compatibility...");
    log("");

    // Test node
    log("--- Testing with node directly ---");
    const nodeResult = await execCommand(
      "node",
      [join("node_modules", "strandweave", "dist", "index.js"), "--help"],
      testDirPath
    );
    if (nodeResult.success && nodeResult.output.includes("Strandweave")) {
      log(getFirstLines(nodeResult.output, 10));
      log("...");
      logSuccess("✅ node runtime works");
    } else {
      logError("❌ node runtime failed");
      log(getFirstLines(nodeResult.output, 10));
    }
    log("");

    // Test bun
    log("--- Testing with bun directly ---");
    if (await commandExists("bun")) {
      const bunResult = await execCommand(
        "bun",
        [join("node_modules", "strandweave", "dist", "index.js"), "--help"],
        testDirPath
      );
      if (bunResult.success && bunResult.output.includes("Strandweave")) {
        log(getFirstLines(bunResult.output, 10));
        log("...");
        logSuccess("✅ bun runtime works");
      } else {
        logError("❌ bun runtime failed");
        log(getFirstLines(bunResult.output, 10));
      }
    } else {
      logWarning("⚠️  bun not available");
    }
    log("");

    // Step 7: Cleanup
    process.chdir(startCwd);
    log("🧹 Step 7: Cleaning up...");
    await rm(testDirPath, { recursive: true, force: true });
    await rm(tarball, { force: true });
    logSuccess("✅ Cleaned up test artifacts");
  } catch (error) {
    logError(
      `\n❌ Test failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
