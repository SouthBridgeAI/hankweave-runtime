#!/usr/bin/env bun
/**
 * E2E tests for package installation via local Verdaccio registry
 *
 * Step 1: Verify we can publish to a local registry
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { runServer } from "verdaccio";

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

describe("Package Publishing", () => {
  it("publishes strandweave to local Verdaccio registry", async () => {
    // 1. Read package.json to get version
    const packageJson = JSON.parse(await Bun.file(packageJsonPath).text()) as PackageJson;
    const packageName = packageJson.name;
    const packageVersion = packageJson.version;

    console.log(`\n📦 Package: ${packageName}@${packageVersion}`);

    // 2. Run build script
    console.log("🏗️  Running build script...");
    const buildProc = Bun.spawn(["bun", "run", "build"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const buildExitCode = await buildProc.exited;
    if (buildExitCode !== 0) {
      const stderr = await new Response(buildProc.stderr).text();
      throw new Error(`Build failed: ${stderr}`);
    }
    console.log("✅ Build complete");

    // 3. Create temporary storage for Verdaccio
    const verdaccioStorageDir = await mkdtemp(path.join(os.tmpdir(), "strandweave-verdaccio-"));

    // 4. Start Verdaccio server
    const server = (await runServer({
      self_path: import.meta.dir,
      storage: verdaccioStorageDir,
      web: { title: "Test Registry" },
      max_body_size: "128mb",
      max_users: -1, // Disable user registration
      log: { level: "fatal" }, // Minimal logging
      uplinks: {
        npmjs: {
          url: "https://registry.npmjs.org/",
          maxage: "1d",
          cache: true,
        },
      },
      packages: {
        [packageName]: {
          access: "$all",
          publish: "$all", // Allow publishing without auth
        },
        "**": {
          access: "$all",
          publish: "noone",
          proxy: "npmjs",
        },
      },
    })) as http.Server;

    try {
      // 5. Wait for server to be ready
      await new Promise<void>((resolve, reject) => {
        server.listen(0, () => resolve());
        server.on("error", reject);
      });

      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Failed to get Verdaccio server address");
      }

      const registryURL = `http://localhost:${address.port}`;
      console.log(`\n📦 Verdaccio running at ${registryURL}`);

      // 6. Verify registry is responding
      const pingResponse = await fetch(registryURL);
      expect(pingResponse.ok).toBe(true);
      console.log("✅ Registry is responding");

      // 7. Create .npmrc with auth token
      const npmrcPath = path.join(projectRoot, ".npmrc");
      const npmrcContent = `//localhost:${address.port}/:_authToken=dummy`;
      await writeFile(npmrcPath, npmrcContent);
      console.log("✅ Created .npmrc with auth token");

      // 8. Publish to registry
      console.log(`\n📤 Publishing ${packageName}@${packageVersion}...`);

      const publishProc = Bun.spawn(["npm", "publish", `--registry=${registryURL}`], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await publishProc.exited;
      const stdout = await new Response(publishProc.stdout).text();
      const stderr = await new Response(publishProc.stderr).text();

      if (exitCode !== 0) {
        console.error("Publish stdout:", stdout);
        console.error("Publish stderr:", stderr);
        throw new Error(`Publish failed with exit code ${exitCode}`);
      }

      console.log("✅ Published successfully");

      // 9. Verify package is in registry
      const pkgResponse = await fetch(`${registryURL}/${packageName}`);
      expect(pkgResponse.ok).toBe(true);

      const pkgData = (await pkgResponse.json()) as PackageMetadata;
      expect(pkgData.name).toBe(packageName);
      expect(pkgData.versions[packageVersion]).toBeDefined();

      console.log("✅ Package verified in registry");
      console.log(`   Versions: ${Object.keys(pkgData.versions).join(", ")}`);
    } finally {
      // 10. Cleanup
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });

      // Clean up .npmrc file
      const npmrcPath = path.join(projectRoot, ".npmrc");
      await rm(npmrcPath, { force: true });

      // Clean up storage directory
      await rm(verdaccioStorageDir, { recursive: true, force: true });
      console.log("\n🧹 Cleaned up\n");
    }
  });
});
