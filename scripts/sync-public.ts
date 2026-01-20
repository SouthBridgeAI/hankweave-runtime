#!/usr/bin/env bun

/**
 * Sync to Public Repository Script
 *
 * Handles syncing releases from the private repo to the public repo.
 * Called by the sync-public.yml workflow.
 *
 * Usage:
 *   bun scripts/sync-public.ts prepare-snapshot --version 0.1.41
 *   bun scripts/sync-public.ts initial-sync --version 0.1.41
 *   bun scripts/sync-public.ts snapshot-sync --version 0.1.41
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm, readdir, cp } from "node:fs/promises";
import { resolve, join } from "node:path";

// Configuration
// Directories to strip (will be excluded with trailing /)
const STRIP_DIRS = [
  "intermediates",
  "external-docs",
  "public-release-files",
];

// Files to strip (excluded without trailing /)
const STRIP_FILES = [
  "CLAUDE.md",
  "Claude.md",  // Handle both cases
  "CONTRIBUTING.md",
  "PUBLISHING-PLAN.md",
  "scripts/sync-public.ts",
  "scripts/test-sync-local.ts",
];

const GIT_AUTHOR_NAME = "Hrishibot";
const GIT_AUTHOR_EMAIL = "operations@southbridge.ai";

// Parse arguments
const command = process.argv[2];
const args = process.argv.slice(3);

function getArg(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : undefined;
}

const version = getArg("version");

if (!command) {
  console.error("Usage: bun scripts/sync-public.ts <command> [options]");
  console.error("Commands: prepare-snapshot, initial-sync, snapshot-sync, extract-changelog");
  process.exit(1);
}

/**
 * Execute a shell command
 */
async function exec(
  cmd: string,
  options: { cwd?: string; silent?: boolean } = {}
): Promise<string> {
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

/**
 * Extract changelog section for a specific version
 */
async function extractChangelog(ver: string, changelogPath: string): Promise<string> {
  if (!existsSync(changelogPath)) {
    return "See release commits for details.";
  }

  const changelog = await readFile(changelogPath, "utf-8");
  const regex = new RegExp(`## \\[${ver}\\]([\\s\\S]*?)(?=\\n## \\[|$)`);
  const match = changelog.match(regex);

  if (match && match[1].trim()) {
    console.log(`✓ Found changelog entry for v${ver}`);
    return match[1].trim();
  }

  console.log(`⚠ No changelog entry found for v${ver}`);
  return "See release commits for details.";
}

/**
 * Transform package.json for public release
 */
async function transformPackageJson(packagePath: string): Promise<void> {
  const content = await readFile(packagePath, "utf-8");
  const pkg = JSON.parse(content);

  pkg.name = "hankweave";
  pkg.publishConfig = { access: "public" };

  await writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n");
  console.log("✓ Transformed package.json: name='hankweave', access='public'");
}

/**
 * Prepare snapshot directory from private repo
 */
async function prepareSnapshot(): Promise<void> {
  if (!version) {
    console.error("Error: --version required");
    process.exit(1);
  }

  const privateDir = resolve(process.cwd(), "private");
  const snapshotDir = resolve(process.cwd(), "snapshot");

  // Create snapshot directory
  await mkdir(snapshotDir, { recursive: true });

  // Build rsync exclude args (dirs get trailing /, files don't)
  const dirExcludes = [".git", ...STRIP_DIRS].map((p) => `--exclude='${p}/'`);
  const fileExcludes = STRIP_FILES.map((p) => `--exclude='${p}'`);
  const excludes = [...dirExcludes, ...fileExcludes].join(" ");

  // Copy files excluding internal ones
  await exec(`rsync -av ${excludes} ${privateDir}/ ${snapshotDir}/`);
  console.log("✓ Copied code to snapshot (excluding internal files)");

  // Inject public files
  const publicFilesDir = join(privateDir, "public-release-files");
  if (existsSync(publicFilesDir)) {
    await exec(`cp -r ${publicFilesDir}/. ${snapshotDir}/`);
    console.log("✓ Injected public files from public-release-files/");
  } else {
    console.log("⚠ No public-release-files/ directory found");
  }

  // Remove ci.yml
  const ciYmlPath = join(snapshotDir, ".github", "workflows", "ci.yml");
  if (existsSync(ciYmlPath)) {
    await rm(ciYmlPath);
  }
  console.log("✓ Removed ci.yml (tests run only in private repo)");

  // Transform package.json
  await transformPackageJson(join(snapshotDir, "package.json"));

  // Copy changelog section
  const changelogContent = await extractChangelog(
    version,
    join(privateDir, "CHANGELOG.md")
  );
  await writeFile(resolve(process.cwd(), "changelog-section.md"), changelogContent);
  await writeFile(join(snapshotDir, "RELEASE_NOTES.md"), changelogContent);
  console.log("✓ Added RELEASE_NOTES.md");

  // List snapshot contents
  console.log("\nFiles in snapshot:");
  await exec(`ls -la ${snapshotDir}`);
}

/**
 * Initial sync - push full history then apply transformations
 */
async function initialSync(): Promise<void> {
  if (!version) {
    console.error("Error: --version required");
    process.exit(1);
  }

  const publicDir = resolve(process.cwd(), "public");
  const privateDir = resolve(process.cwd(), "private");

  console.log("=== Performing initial sync (full history) ===");

  // Configure git
  await exec(`git config user.name "${GIT_AUTHOR_NAME}"`, { cwd: publicDir });
  await exec(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { cwd: publicDir });

  // Add private repo as remote and fetch
  await exec("git remote add private ../private", { cwd: publicDir, silent: true }).catch(() => {});
  await exec("git fetch private release/alpha", { cwd: publicDir });

  // Reset to private's release/alpha
  await exec("git reset --hard private/release/alpha", { cwd: publicDir });

  // Remove internal files
  for (const dir of STRIP_DIRS) {
    const fullPath = join(publicDir, dir);
    if (existsSync(fullPath)) {
      await rm(fullPath, { recursive: true, force: true });
    }
  }
  for (const file of STRIP_FILES) {
    const fullPath = join(publicDir, file);
    if (existsSync(fullPath)) {
      await rm(fullPath, { force: true });
    }
  }
  console.log("✓ Removed internal files");

  // Copy public files
  const publicFilesDir = join(privateDir, "public-release-files");
  if (existsSync(publicFilesDir)) {
    await exec(`cp -r ${publicFilesDir}/. ${publicDir}/`);
    console.log("✓ Copied public files");
  }

  // Remove ci.yml
  const ciYmlPath = join(publicDir, ".github", "workflows", "ci.yml");
  if (existsSync(ciYmlPath)) {
    await rm(ciYmlPath);
  }
  console.log("✓ Removed ci.yml");

  // Transform package.json
  await transformPackageJson(join(publicDir, "package.json"));

  // Copy release notes
  const changelogPath = resolve(process.cwd(), "changelog-section.md");
  if (existsSync(changelogPath)) {
    await cp(changelogPath, join(publicDir, "RELEASE_NOTES.md"));
  }

  // Commit changes
  await exec("git add -A", { cwd: publicDir });
  const hasChanges = await exec("git diff --staged --quiet", { cwd: publicDir, silent: true })
    .then(() => false)
    .catch(() => true);

  if (hasChanges) {
    await exec(`git commit -m "Apply public release files for v${version}"`, { cwd: publicDir });
    console.log("✓ Committed public file overlay");
  } else {
    console.log("✓ No changes to commit");
  }

  console.log("✓ Initial sync complete");
}

/**
 * Snapshot sync - replace tree with snapshot contents
 */
async function snapshotSync(): Promise<void> {
  if (!version) {
    console.error("Error: --version required");
    process.exit(1);
  }

  const publicDir = resolve(process.cwd(), "public");
  const snapshotDir = resolve(process.cwd(), "snapshot");
  const changelogPath = resolve(process.cwd(), "changelog-section.md");

  console.log("=== Performing snapshot sync ===");

  // Remove everything except .git
  await exec("find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +", { cwd: publicDir });

  // Copy snapshot contents
  await exec(`cp -r ${snapshotDir}/. ${publicDir}/`);

  // Configure git
  await exec(`git config user.name "${GIT_AUTHOR_NAME}"`, { cwd: publicDir });
  await exec(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { cwd: publicDir });

  // Stage all changes
  await exec("git add -A", { cwd: publicDir });

  // Check for changes
  const hasChanges = await exec("git diff --staged --quiet", { cwd: publicDir, silent: true })
    .then(() => false)
    .catch(() => true);

  if (!hasChanges) {
    console.log("⚠ No changes detected. Tree is identical to previous sync.");
    return;
  }

  // Read changelog for commit message
  let changelog = "See release commits for details.";
  if (existsSync(changelogPath)) {
    changelog = await readFile(changelogPath, "utf-8");
  }

  // Create commit
  await exec(
    `git commit -m "Release v${version}" -m "${changelog.replace(/"/g, '\\"')}"`,
    { cwd: publicDir }
  );
  console.log(`✓ Created snapshot commit for v${version}`);
}

/**
 * Create and verify tag
 */
async function createTag(): Promise<void> {
  if (!version) {
    console.error("Error: --version required");
    process.exit(1);
  }

  const publicDir = resolve(process.cwd(), "public");
  const tag = `v${version}`;

  // Check if tag exists locally (use git tag -l, not rev-parse which matches remote refs too)
  const localTagOutput = await exec(`git tag -l ${tag}`, { cwd: publicDir, silent: true });
  if (localTagOutput.includes(tag)) {
    console.log(`⚠ Tag ${tag} already exists locally, deleting...`);
    await exec(`git tag -d ${tag}`, { cwd: publicDir });
  }

  // Check if tag exists on remote
  const remoteTagOutput = await exec(`git ls-remote --tags origin ${tag}`, { cwd: publicDir, silent: true });
  if (remoteTagOutput.includes(tag)) {
    console.error(`Error: Tag ${tag} already exists on remote. Cannot overwrite.`);
    console.error("Delete the tag from the public repo first if you need to re-sync.");
    process.exit(1);
  }

  await exec(`git tag ${tag}`, { cwd: publicDir });
  console.log(`✓ Created tag ${tag}`);
}

/**
 * Push to public repo
 */
async function push(): Promise<void> {
  if (!version) {
    console.error("Error: --version required");
    process.exit(1);
  }

  const publicDir = resolve(process.cwd(), "public");

  console.log("=== Pushing to public repo ===");

  await exec("git push origin release/alpha", { cwd: publicDir });
  console.log("✓ Pushed release/alpha branch");

  await exec(`git push origin v${version}`, { cwd: publicDir });
  console.log(`✓ Pushed tag v${version}`);
}

// Main command router
async function main() {
  switch (command) {
    case "extract-changelog":
      if (!version) {
        console.error("Error: --version required");
        process.exit(1);
      }
      const content = await extractChangelog(version, join(process.cwd(), "private", "CHANGELOG.md"));
      await writeFile(resolve(process.cwd(), "changelog-section.md"), content);
      break;

    case "prepare-snapshot":
      await prepareSnapshot();
      break;

    case "initial-sync":
      await initialSync();
      break;

    case "snapshot-sync":
      await snapshotSync();
      break;

    case "create-tag":
      await createTag();
      break;

    case "push":
      await push();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Commands: extract-changelog, prepare-snapshot, initial-sync, snapshot-sync, create-tag, push");
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
