#!/usr/bin/env bun
/**
 * E2E tests for package installation via local Verdaccio registry
 *
 * Tests that we can:
 * 1. Build the package
 * 2. Start a local Verdaccio registry
 * 3. Publish to the registry
 * 4. Verify the package is available
 */

import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  createNpmrcForVerdaccio,
  removeNpmrc,
  startVerdaccioRegistry,
  stopVerdaccioRegistry,
} from "../utils/test-helpers.js";

const projectRoot = path.resolve(import.meta.dir, "../..");
const packageJsonPath = path.join(projectRoot, "package.json");

// Type for package.json
interface PackageJson {
  name: string;
  version: string;
}

// Type for npm registry package metadata
interface PackageMetadata {
  name: string;
  versions: Record<string, unknown>;
}

describe("Package Installation Tests", () => {
  it("publishes and verifies package in local registry", async () => {
    // 1. Read package.json
    const packageJson = JSON.parse(await Bun.file(packageJsonPath).text()) as PackageJson;

    console.log(`\n📦 Package: ${packageJson.name}@${packageJson.version}`);

    // 2. Build package
    console.log("🏗️  Building...");
    const buildProc = Bun.spawn(["bun", "run", "build"], {
      cwd: projectRoot,
      stdout: "inherit",
      stderr: "inherit",
    });

    const buildCode = await buildProc.exited;
    if (buildCode !== 0) {
      throw new Error("Build failed");
    }

    console.log("✅ Build complete");

    // 3. Start Verdaccio
    const registry = await startVerdaccioRegistry(packageJson.name);

    try {
      // 4. Create .npmrc
      const npmrcPath = await createNpmrcForVerdaccio(projectRoot, registry.port);

      try {
        // 5. Publish
        console.log(`\n📤 Publishing ${packageJson.name}@${packageJson.version}...`);

        const publishProc = Bun.spawn(["npm", "publish", `--registry=${registry.registryURL}`], {
          cwd: projectRoot,
          stdout: "inherit",
          stderr: "inherit",
        });

        const exitCode = await publishProc.exited;
        if (exitCode !== 0) {
          throw new Error("Publish failed");
        }

        console.log("✅ Published");

        // 6. Verify
        const pkgResponse = await fetch(`${registry.registryURL}/${packageJson.name}`);
        expect(pkgResponse.ok).toBe(true);

        const pkgData = (await pkgResponse.json()) as PackageMetadata;
        expect(pkgData.name).toBe(packageJson.name);
        expect(pkgData.versions[packageJson.version]).toBeDefined();

        console.log("✅ Package verified in registry");
        console.log(`   Versions: ${Object.keys(pkgData.versions).join(", ")}`);
      } finally {
        await removeNpmrc(npmrcPath);
      }
    } finally {
      await stopVerdaccioRegistry(registry);
    }
  }, 30000); // 30 second timeout for build + publish operations
});
