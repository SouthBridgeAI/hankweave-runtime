#!/usr/bin/env bun
/**
 * Binary test mode management for E2E tests.
 * Provides utilities for building and testing the standalone compiled binary.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TestServerConfig } from "./test-helpers.js";
import { colors } from "./test-helpers.js";

/**
 * Binary setup state including binary path and isolated test directory.
 */
export interface BinarySetup {
  binaryPath: string;
  platform: string;
  testIsolationDir: string; // Temp directory isolated from project
}

/**
 * Checks if Binary setup is needed based on environment variables.
 * Returns true if STRANDWEAVE_TEST_USE_BINARY is set.
 */
export function needsBinary(): boolean {
  return Boolean(process.env.STRANDWEAVE_TEST_USE_BINARY);
}

/**
 * Get the platform-specific binary name.
 */
function getBinaryName(): string {
  const platform = os.platform();

  if (platform === "win32") {
    return "strandweave-test.exe";
  }

  return "strandweave-test";
}

/**
 * Get the platform target string for build script.
 */
function getPlatformTarget(): string {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "darwin") {
    return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "linux-arm64" : "linux-x64";
  }
  if (platform === "win32") {
    return "windows-x64";
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/**
 * Determines command override for using the compiled binary.
 * Returns command configuration for binary execution.
 */
export function getBinaryCommandOverride(
  binaryPath: string,
): NonNullable<TestServerConfig["commandOverride"]> {
  return {
    command: binaryPath,
    args: [],
  };
}

/**
 * Builds the standalone compiled binary for testing.
 *
 * This function:
 * 1. Determines the current platform
 * 2. Runs the build script to compile the binary
 * 3. Verifies the binary was created
 * 4. Creates an isolated temp directory for testing (outside project)
 * 5. Returns the binary path and test isolation directory
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns BinarySetup object containing binary path, platform info, and isolated test directory
 * @throws {Error} If build fails or binary not created
 */
export async function setupBinary(projectRoot: string): Promise<BinarySetup> {
  console.log(`\n${colors.blue}=== Building standalone binary for testing ===${colors.reset}\n`);

  const platform = getPlatformTarget();
  const binaryName = getBinaryName();
  const releasesDir = path.join(projectRoot, "releases");
  const binaryPath = path.join(releasesDir, binaryName);

  console.log(`📦 Platform: ${platform}`);
  console.log(`📦 Binary name: ${binaryName}`);
  console.log(`📦 Output path: ${binaryPath}`);

  // Remove old test binary if it exists
  if (fs.existsSync(binaryPath)) {
    console.log(`\n🧹 Removing old test binary...`);
    fs.unlinkSync(binaryPath);
  }

  // Build the binary
  console.log(`\n🏗️  Building binary...`);
  const buildScript = path.join(projectRoot, "scripts/build-executable.ts");
  const buildProc = spawn("bun", [buildScript, platform, binaryName], {
    cwd: projectRoot,
    stdio: "inherit", // Show build output
  });

  await new Promise<void>((resolve, reject) => {
    buildProc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Binary build failed with code ${code}`));
    });
  });

  // Verify binary was created
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Binary build appeared to succeed but file not found: ${binaryPath}`);
  }

  const binarySize = fs.statSync(binaryPath).size;
  console.log(`${colors.green}✓ Binary build complete${colors.reset}`);
  console.log(`  Size: ${(binarySize / 1024 / 1024).toFixed(2)} MB`);

  // Create isolated temp directory for testing (outside project to ensure no access to codebase)
  console.log(`\n📁 Creating isolated test directory...`);
  const testIsolationDir = await mkdtemp(path.join(os.tmpdir(), "strandweave-binary-test-"));
  console.log(`${colors.green}✓ Test isolation directory: ${testIsolationDir}${colors.reset}`);

  console.log(`${colors.green}\n=== Binary setup complete ===\n${colors.reset}`);

  return {
    binaryPath,
    platform,
    testIsolationDir,
  };
}

/**
 * Copy test fixtures from project to isolated test directory.
 * Only copies specific files/directories needed for tests.
 *
 * @param sourcePaths - Array of paths relative to project root to copy
 * @param projectRoot - Absolute path to project root
 * @param testIsolationDir - Isolated test directory to copy to
 */
export function copyTestFixtures(
  sourcePaths: string[],
  projectRoot: string,
  testIsolationDir: string,
): void {
  console.log(`\n${colors.blue}Copying test fixtures to isolated directory...${colors.reset}`);

  for (const sourcePath of sourcePaths) {
    const fullSourcePath = path.join(projectRoot, sourcePath);
    const destPath = path.join(testIsolationDir, sourcePath);

    if (!fs.existsSync(fullSourcePath)) {
      console.warn(
        `${colors.yellow}Warning: Source path does not exist: ${fullSourcePath}${colors.reset}`,
      );
      continue;
    }

    // Create parent directory if needed
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Copy file or directory
    const stat = fs.statSync(fullSourcePath);
    if (stat.isDirectory()) {
      fs.cpSync(fullSourcePath, destPath, { recursive: true });
      console.log(`${colors.gray}  ✓ Copied directory: ${sourcePath}${colors.reset}`);
    } else {
      fs.copyFileSync(fullSourcePath, destPath);
      console.log(`${colors.gray}  ✓ Copied file: ${sourcePath}${colors.reset}`);
    }
  }

  console.log(`${colors.green}✓ Test fixtures copied${colors.reset}`);
}

/**
 * Cleans up the test binary and isolated test directory.
 *
 * This function:
 * 1. Removes the compiled binary
 * 2. Removes the isolated test directory
 *
 * @param setup - BinarySetup object from setupBinary()
 */
export async function cleanupBinary(setup: BinarySetup): Promise<void> {
  console.log(`\n${colors.blue}Cleaning up test binary...${colors.reset}`);

  if (fs.existsSync(setup.binaryPath)) {
    fs.unlinkSync(setup.binaryPath);
    console.log(`${colors.green}✓ Binary removed${colors.reset}`);
  }

  // Remove isolated test directory
  if (fs.existsSync(setup.testIsolationDir)) {
    fs.rmSync(setup.testIsolationDir, { recursive: true, force: true });
    console.log(`${colors.green}✓ Test isolation directory removed${colors.reset}`);
  }

  console.log(`${colors.green}✓ Binary cleanup complete${colors.reset}`);
}
