#!/usr/bin/env bun

/**
 * Local test script for sync-public.ts
 *
 * Tests the sync workflow locally before running in CI.
 *
 * Usage:
 *   bun scripts/test-sync-local.ts --version 0.1.40
 *   bun scripts/test-sync-local.ts --version 0.1.40 --push   # Actually push to public repo
 */

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : undefined;
}

const version = getArg("version");
const shouldPush = args.includes("--push");
const initialSync = args.includes("--initial");
const useHead = args.includes("--use-head");

if (!version) {
  console.error("Usage: bun scripts/test-sync-local.ts --version X.Y.Z [--push] [--initial] [--use-head]");
  console.error("  --push       Actually push to public repo (default: dry run)");
  console.error("  --initial    Perform initial sync (full history) instead of snapshot");
  console.error("  --use-head   Use current HEAD instead of the tag (for testing uncommitted changes)");
  process.exit(1);
}

const TEST_DIR = "/tmp/hankweave-sync-test";
const REPO_ROOT = resolve(import.meta.dir, "..");
const SYNC_SCRIPT = resolve(import.meta.dir, "sync-public.ts");

async function exec(cmd: string, options: { cwd?: string; silent?: boolean } = {}): Promise<string> {
  console.log(`$ ${cmd}`);
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: options.silent ? "pipe" : "inherit",
  });

  const exitCode = await proc.exited;
  const output = proc.stdout ? await new Response(proc.stdout).text() : "";

  if (exitCode !== 0 && !options.silent) {
    throw new Error(`Command failed (exit ${exitCode}): ${cmd}`);
  }

  return output.trim();
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║              Testing Sync to Public Repo                   ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`Version: v${version}`);
  console.log(`Mode: ${initialSync ? "Initial sync (full history)" : "Snapshot sync"}`);
  console.log(`Source: ${useHead ? "Current HEAD (uncommitted changes included)" : `Tag v${version}`}`);
  console.log(`Push: ${shouldPush ? "YES - will push to public repo" : "No (dry run)"}`);
  console.log(`Test directory: ${TEST_DIR}`);
  console.log("");

  // Clean up and create test directory
  if (existsSync(TEST_DIR)) {
    await rm(TEST_DIR, { recursive: true });
  }
  await mkdir(TEST_DIR, { recursive: true });

  // Step 1: Clone the private repo
  if (useHead) {
    console.log("\n=== Step 1: Copy current repo (HEAD) ===");
    // Copy the current working directory (including uncommitted changes)
    await exec(`rsync -av --exclude='.git' --exclude='node_modules' --exclude='intermediates' ${REPO_ROOT}/ private/`, { cwd: TEST_DIR });
    // Initialize a git repo for the sync script to work
    await exec(`git init && git add -A && git commit -m "Test snapshot"`, { cwd: `${TEST_DIR}/private` });
  } else {
    console.log("\n=== Step 1: Clone private repo at tag ===");
    await exec(`git clone --branch v${version} ${REPO_ROOT} private`, { cwd: TEST_DIR });
  }

  // Step 2: Extract changelog
  console.log("\n=== Step 2: Extract changelog ===");
  await exec(`bun ${SYNC_SCRIPT} extract-changelog --version ${version}`, { cwd: TEST_DIR });

  // Step 3: Prepare snapshot (for snapshot sync only)
  if (!initialSync) {
    console.log("\n=== Step 3: Prepare snapshot ===");
    await exec(`bun ${SYNC_SCRIPT} prepare-snapshot --version ${version}`, { cwd: TEST_DIR });
  }

  // Step 4: Clone public repo
  console.log("\n=== Step 4: Clone public repo ===");
  try {
    await exec(`git clone git@github.com:SouthBridgeAI/hankweave-runtime.git public`, { cwd: TEST_DIR });
    // Check out or create release/alpha
    const branchExists = await exec(`git ls-remote --heads origin release/alpha`, { cwd: `${TEST_DIR}/public`, silent: true });
    if (branchExists.includes("release/alpha")) {
      await exec(`git checkout release/alpha`, { cwd: `${TEST_DIR}/public` });
    } else {
      await exec(`git checkout --orphan release/alpha`, { cwd: `${TEST_DIR}/public` });
      await exec(`git rm -rf . 2>/dev/null || true`, { cwd: `${TEST_DIR}/public` });
    }
  } catch {
    console.log("⚠ Could not clone public repo - creating empty directory for testing");
    await mkdir(`${TEST_DIR}/public`, { recursive: true });
    await exec(`git init`, { cwd: `${TEST_DIR}/public` });
    await exec(`git checkout --orphan release/alpha`, { cwd: `${TEST_DIR}/public` });
  }

  // Step 5: Run sync
  if (initialSync) {
    console.log("\n=== Step 5: Initial sync ===");
    await exec(`bun ${SYNC_SCRIPT} initial-sync --version ${version}`, { cwd: TEST_DIR });
  } else {
    console.log("\n=== Step 5: Snapshot sync ===");
    await exec(`bun ${SYNC_SCRIPT} snapshot-sync --version ${version}`, { cwd: TEST_DIR });
  }

  // Step 6: Create tag
  console.log("\n=== Step 6: Create tag ===");
  await exec(`bun ${SYNC_SCRIPT} create-tag --version ${version}`, { cwd: TEST_DIR });

  // Show results
  console.log("\n=== Results ===");
  console.log("\nFiles in public repo:");
  await exec(`ls -la`, { cwd: `${TEST_DIR}/public` });
  
  console.log("\nGit log:");
  await exec(`git log --oneline -5`, { cwd: `${TEST_DIR}/public` });

  console.log("\npackage.json name:");
  await exec(`node -p 'require("./package.json").name'`, { cwd: `${TEST_DIR}/public` });

  // Check for files that should NOT be there
  console.log("\n=== Verification ===");
  const shouldNotExist = [
    "intermediates",
    "external-docs", 
    "CLAUDE.md",
    "Claude.md",  // Check both cases
    "CONTRIBUTING.md",
    "PUBLISHING-PLAN.md",
    "public-release-files",
    "scripts/sync-public.ts",
    "scripts/test-sync-local.ts",
    ".github/workflows/ci.yml",
  ];

  let allGood = true;
  for (const path of shouldNotExist) {
    if (existsSync(`${TEST_DIR}/public/${path}`)) {
      console.log(`❌ Should not exist: ${path}`);
      allGood = false;
    } else {
      console.log(`✓ Correctly removed: ${path}`);
    }
  }

  // Check for files that SHOULD be there
  const shouldExist = [
    "package.json",
    "README.md",
    ".github/workflows/release.yml",
    "server",  // Main source directory
  ];

  for (const path of shouldExist) {
    if (existsSync(`${TEST_DIR}/public/${path}`)) {
      console.log(`✓ Exists: ${path}`);
    } else {
      console.log(`❌ Missing: ${path}`);
      allGood = false;
    }
  }

  if (!allGood) {
    console.log("\n⚠ Some verification checks failed!");
  } else {
    console.log("\n✓ All verification checks passed!");
  }

  // Step 7: Push (optional)
  if (shouldPush) {
    console.log("\n=== Step 7: Pushing to public repo ===");
    await exec(`bun ${SYNC_SCRIPT} push --version ${version}`, { cwd: TEST_DIR });
    console.log("\n✓ Pushed to public repo!");
    console.log(`Check: https://github.com/SouthBridgeAI/hankweave-runtime/tree/release/alpha`);
  } else {
    console.log("\n=== Dry run complete ===");
    console.log(`Test directory: ${TEST_DIR}`);
    console.log(`To inspect: cd ${TEST_DIR}/public && ls -la`);
    console.log(`To push: bun scripts/test-sync-local.ts --version ${version} --push`);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
