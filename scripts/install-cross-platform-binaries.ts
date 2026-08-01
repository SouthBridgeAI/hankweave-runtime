#!/usr/bin/env bun
/**
 * Install the cross-platform Claude SDK native binary for a release build.
 *
 * `bun install` only fetches the *host* platform's native binary for the
 * Claude Agent SDK (it ships as per-platform optionalDependencies).
 * When cross-compiling a release artifact (e.g. building linux-arm64 on an x64
 * Ubuntu runner), the target platform's binary is missing, so
 * `scripts/build-executable.ts` would fail. This script fetches the target's
 * Claude binary package and extracts it where the build script looks for it.
 *
 * Versions are derived from the installed runtime so the cross binary always
 * matches the host build — there are no hardcoded version tags to drift when
 * the SDK is upgraded.
 *
 * Usage:
 *   bun scripts/install-cross-platform-binaries.ts <target>
 *
 * Arguments:
 *   target - Build target: linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getClaudeBinaryName, getClaudePackageDir } from "../server/claude-runtime-extractor.js";

/**
 * Print a GitHub Actions error annotation (also visible in plain logs) and exit.
 */
function fail(message: string, details?: () => void): never {
  console.error(`::error::${message}`);
  details?.();
  process.exit(1);
}

/** Read a dependency's installed version from its package.json in node_modules. */
function installedVersion(pkgName: string): string {
  const pkgJsonPath = path.join("node_modules", pkgName, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    fail(`Cannot resolve ${pkgName} version: ${pkgJsonPath} not found. Run 'bun install' first.`);
  }
  const version = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")).version;
  if (!version) {
    fail(`${pkgJsonPath} has no "version" field.`);
  }
  return version;
}

/**
 * `npm pack` the given spec into a temp dir and extract it into destDir,
 * stripping the package's leading "package/" path component.
 */
function packAndExtract(spec: string, destDir: string): void {
  // npm pack prints the created tarball filename on its last stdout line.
  const stdout = execFileSync("npm", ["pack", spec, "--pack-destination", os.tmpdir()], {
    encoding: "utf-8",
  });
  const tarball = stdout.trim().split("\n").pop()?.trim();
  if (!tarball) {
    fail(`npm pack ${spec} did not report a tarball filename.`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync(
    "tar",
    ["xzf", path.join(os.tmpdir(), tarball), "-C", destDir, "--strip-components=1"],
    { stdio: "inherit" },
  );
}

function installClaude(target: string): void {
  const version = installedVersion("@anthropic-ai/claude-agent-sdk");
  // Claude Agent SDK 0.3.x ships its runtime as a per-platform native binary
  // package (@anthropic-ai/claude-agent-sdk-<suffix>) with the executable at the
  // package root. getClaudePackageDir() yields the exact dir build-executable.ts
  // reads from, so derive the package name from its basename.
  const dir = getClaudePackageDir(target);
  const pkgName = `@anthropic-ai/${path.basename(dir)}`;
  packAndExtract(`${pkgName}@${version}`, dir);

  const binaryPath = path.join(dir, getClaudeBinaryName(target));
  if (!fs.existsSync(binaryPath)) {
    fail(
      `No binary found at ${binaryPath} after installing ${pkgName}@${version}. The npm package layout may have changed, or no platform package is published for ${target} at ${version}.`,
      () => {
        console.error("Extracted contents:");
        try {
          execFileSync("ls", ["-R", dir], { stdio: "inherit" });
        } catch {
          /* best-effort listing */
        }
      },
    );
  }
  console.log(`✓ Installed cross-platform claude binary ${version} at ${dir}`);
}

function main(): void {
  const target = process.argv[2];
  if (!target) {
    fail("Missing target argument. Usage: bun scripts/install-cross-platform-binaries.ts <target>");
  }
  console.log(`📦 Installing cross-platform SDK binary for ${target}\n`);
  installClaude(target);
}

main();
