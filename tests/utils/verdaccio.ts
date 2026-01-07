#!/usr/bin/env bun
/**
 * Verdaccio registry management for E2E tests.
 * Provides utilities for setting up a local npm registry to test package installation.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TestServerConfig } from "./test-helpers.js";
import {
  colors,
  createNpmrcForVerdaccio,
  removeNpmrc,
  startVerdaccioRegistry,
  stopVerdaccioRegistry,
  type VerdaccioRegistry,
} from "./test-helpers.js";

/**
 * Verdaccio setup state including registry, npmrc path, and package info.
 */
export interface VerdaccioSetup {
  registry: VerdaccioRegistry;
  npmrcPath: string;
  packageName: string;
  packageVersion: string;
}

/**
 * Checks if Verdaccio setup is needed based on environment variables.
 * Returns true if any package manager testing env var is set.
 */
export function needsVerdaccio(): boolean {
  return Boolean(
    process.env.STRANDWEAVE_TEST_USE_NPX ||
      process.env.STRANDWEAVE_TEST_USE_BUNX ||
      process.env.STRANDWEAVE_TEST_USE_PNPM_DLX,
  );
}

/**
 * Determines command override based on environment variables.
 * Returns command configuration for npx/bunx/pnpm dlx, or undefined for direct bun execution.
 */
export function getCommandOverride(): TestServerConfig["commandOverride"] {
  if (process.env.STRANDWEAVE_TEST_USE_NPX) {
    return { command: "npx", args: ["strandweave"] };
  }
  if (process.env.STRANDWEAVE_TEST_USE_BUNX) {
    return { command: "bunx", args: ["strandweave"] };
  }
  if (process.env.STRANDWEAVE_TEST_USE_PNPM_DLX) {
    return { command: "pnpm", args: ["dlx", "strandweave"] };
  }
  return undefined;
}

/**
 * Sets up a Verdaccio registry for package testing.
 *
 * This function:
 * 1. Reads package.json to get package name and version
 * 2. Builds the package with `bun run build`
 * 3. Starts a local Verdaccio registry
 * 4. Creates .npmrc file for authentication
 * 5. Publishes the package to the registry
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns VerdaccioSetup object containing registry info and package details
 * @throws {Error} If build fails, registry startup fails, or publish fails
 */
export async function setupVerdaccio(projectRoot: string): Promise<VerdaccioSetup> {
  console.log(`\n${colors.blue}=== Setting up Verdaccio for package testing ===${colors.reset}\n`);

  const packageJsonPath = path.join(projectRoot, "package.json");

  // 1. Read package.json
  const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, "utf-8")) as {
    name: string;
    version: string;
  };

  console.log(`📦 Package: ${packageJson.name}@${packageJson.version}`);

  // 2. Build package
  console.log("\n🏗️  Building package...");
  const buildProc = spawn("bun", ["run", "build"], {
    cwd: projectRoot,
    stdio: "inherit", // Show build output
  });

  await new Promise<void>((resolve, reject) => {
    buildProc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed with code ${code}`));
    });
  });

  console.log(`${colors.green}✓ Build complete${colors.reset}`);

  // 3. Start Verdaccio
  const registry = await startVerdaccioRegistry(packageJson.name);

  // 4. Create .npmrc
  const npmrcPath = await createNpmrcForVerdaccio(projectRoot, registry.port);

  // 5. Publish to registry
  console.log(`\n📤 Publishing ${packageJson.name}@${packageJson.version}...`);
  const publishProc = spawn("npm", ["publish", `--registry=${registry.registryURL}`], {
    cwd: projectRoot,
    stdio: "inherit", // Show publish output
    shell: true, // Required for Windows compatibility (npm.cmd)
  });

  await new Promise<void>((resolve, reject) => {
    publishProc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Publish failed with code ${code}`));
    });
  });

  console.log(`${colors.green}✓ Published to ${registry.registryURL}${colors.reset}`);

  console.log(`${colors.green}\n=== Verdaccio setup complete ===\n${colors.reset}`);

  return {
    registry,
    npmrcPath,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
  };
}

/**
 * Cleans up Verdaccio registry and associated files.
 *
 * This function:
 * 1. Removes .npmrc file
 * 2. Stops Verdaccio server
 * 3. Cleans up temporary storage
 *
 * @param setup - VerdaccioSetup object from setupVerdaccio()
 */
export async function cleanupVerdaccio(setup: VerdaccioSetup): Promise<void> {
  console.log(`\n${colors.blue}Cleaning up Verdaccio...${colors.reset}`);

  await removeNpmrc(setup.npmrcPath);
  await stopVerdaccioRegistry(setup.registry);

  console.log(`${colors.green}✓ Verdaccio cleanup complete${colors.reset}`);
}
