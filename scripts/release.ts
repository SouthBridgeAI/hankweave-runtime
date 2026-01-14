#!/usr/bin/env bun

/**
 * Release automation script for Hankweave
 *
 * Handles version bumping, changelog management, git tagging, and pushing
 * Inspired by pi-mono's release flow
 *
 * Usage:
 *   npm run release:patch  # 0.1.26 -> 0.1.27
 *   npm run release:minor  # 0.1.26 -> 0.2.0
 *   npm run release:major  # 0.1.26 -> 1.0.0
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Bump type from command line argument
const BUMP_TYPE = process.argv[2];
const VALID_BUMP_TYPES = ["patch", "minor", "major"] as const;
type BumpType = (typeof VALID_BUMP_TYPES)[number];

if (!BUMP_TYPE || !VALID_BUMP_TYPES.includes(BUMP_TYPE as BumpType)) {
  console.error("Error: Invalid or missing bump type");
  console.error("Usage: npm run release:patch|minor|major");
  process.exit(1);
}

const ROOT = resolve(process.cwd());
const CHANGELOG_PATH = resolve(ROOT, "CHANGELOG.md");
const PACKAGE_JSON_PATH = resolve(ROOT, "package.json");

/**
 * Execute a command using Bun's shell
 */
async function exec(
  command: string,
  options: { silent?: boolean } = {}
): Promise<string> {
  try {
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: options.silent ? "pipe" : "inherit",
      stderr: options.silent ? "pipe" : "inherit",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Command failed with exit code ${exitCode}: ${command}`);
    }

    if (options.silent && proc.stdout) {
      const output = await new Response(proc.stdout).text();
      return output.trim();
    }

    return "";
  } catch (error) {
    console.error(`Command failed: ${command}`);
    throw error;
  }
}

/**
 * Check if git working directory is clean
 */
async function checkGitStatus(): Promise<void> {
  console.log("\n📋 Checking git status...");
  const status = await exec("git status --porcelain", { silent: true });

  if (status) {
    console.error(
      "Error: Uncommitted changes detected. Commit or stash first."
    );
    console.error("\nUncommitted changes:");
    console.error(status);
    process.exit(1);
  }

  console.log("✓ Git working directory is clean");
}

/**
 * Check if currently on the correct branch
 */
async function checkCurrentBranch(expectedBranch: string): Promise<void> {
  console.log(`\n🔍 Checking current branch...`);
  const currentBranch = await exec("git branch --show-current", {
    silent: true,
  });

  if (currentBranch !== expectedBranch) {
    console.error(`Error: Must be on ${expectedBranch} branch to run release.`);
    console.error(`Current branch: ${currentBranch}`);
    console.error(`\nTo switch to ${expectedBranch}:`);
    console.error(`  git checkout ${expectedBranch}`);
    process.exit(1);
  }

  console.log(`✓ On ${expectedBranch} branch`);
}

/**
 * Check if local branches are in sync with remote
 * Allows local to be ahead (will be pushed during release)
 * but not behind or diverged
 */
async function checkRemoteSync(branches: string[]): Promise<void> {
  console.log("\n🔄 Checking remote sync...");

  // Fetch latest from remote
  await exec("git fetch origin", { silent: true });

  for (const branch of branches) {
    try {
      // Check if remote branch exists
      const remoteBranch = await exec(
        `git rev-parse --verify origin/${branch}`,
        { silent: true }
      );

      if (!remoteBranch) {
        console.error(`Error: Remote branch origin/${branch} does not exist.`);
        process.exit(1);
      }

      // Compare local and remote
      const localCommit = await exec(`git rev-parse ${branch}`, {
        silent: true,
      });
      const remoteCommit = await exec(`git rev-parse origin/${branch}`, {
        silent: true,
      });

      if (localCommit !== remoteCommit) {
        // Check if local is ahead, behind, or diverged
        const commitsAhead = await exec(
          `git rev-list --count origin/${branch}..${branch}`,
          { silent: true }
        );
        const commitsBehind = await exec(
          `git rev-list --count ${branch}..origin/${branch}`,
          { silent: true }
        );

        const ahead = parseInt(commitsAhead);
        const behind = parseInt(commitsBehind);

        if (behind > 0 && ahead > 0) {
          // Diverged
          console.error(
            `Error: Branch ${branch} has diverged from remote.`
          );
          console.error(
            `  Local is ${ahead} commit(s) ahead and ${behind} commit(s) behind.`
          );
          console.error(`\nYou need to reconcile the branches:`);
          console.error(`  git checkout ${branch}`);
          console.error(`  git pull origin ${branch}`);
          process.exit(1);
        } else if (behind > 0) {
          // Behind remote
          console.error(
            `Error: Branch ${branch} is ${behind} commit(s) behind remote.`
          );
          console.error(`\nTo sync:`);
          console.error(`  git checkout ${branch}`);
          console.error(`  git pull origin ${branch}`);
          process.exit(1);
        } else if (ahead > 0) {
          // Ahead of remote - this is OK, we'll push during release
          console.log(
            `✓ ${branch} is ${ahead} commit(s) ahead of origin/${branch} (will be pushed during release)`
          );
        }
      } else {
        console.log(`✓ ${branch} is in sync with origin/${branch}`);
      }
    } catch (error) {
      console.error(
        `Error checking branch ${branch}:`,
        (error as Error).message
      );
      process.exit(1);
    }
  }
}

/**
 * Validate that CHANGELOG has actual content in [Unreleased] section
 */
async function validateChangelog(): Promise<void> {
  console.log("\n📝 Validating CHANGELOG...");

  if (!existsSync(CHANGELOG_PATH)) {
    console.error("Error: CHANGELOG.md not found.");
    console.error("Please create a CHANGELOG.md with an [Unreleased] section.");
    process.exit(1);
  }

  const changelogFile = Bun.file(CHANGELOG_PATH);
  const changelog = await changelogFile.text();

  // Check if there's an [Unreleased] section
  if (!changelog.includes("## [Unreleased]")) {
    console.error("Error: No [Unreleased] section found in CHANGELOG.md");
    console.error(
      "Please add a ## [Unreleased] section and list your changes there."
    );
    process.exit(1);
  }

  // Extract content between [Unreleased] and next ## heading
  const unreleasedMatch = changelog.match(
    /## \[Unreleased\]([\s\S]*?)(?=\n## |\n#+ |$)/
  );

  if (!unreleasedMatch) {
    console.error("Error: Could not parse [Unreleased] section.");
    process.exit(1);
  }

  const unreleasedContent = unreleasedMatch[1].trim();

  // Check if there's actual content (not just empty bullets or whitespace)
  const hasContent = /^[^-\s]|\n[^-\s]|- .+\S/.test(unreleasedContent);

  if (!hasContent) {
    console.error("Error: [Unreleased] section is empty.");
    console.error("Please add your changes to the CHANGELOG before releasing.");
    console.error("\nExample:");
    console.error("  ## [Unreleased]");
    console.error("  ");
    console.error("  ### Added");
    console.error("  - New feature description");
    process.exit(1);
  }

  console.log("✓ CHANGELOG has content in [Unreleased] section");
}

/**
 * Check if version tag already exists on remote
 */
async function checkTagExists(version: string): Promise<void> {
  console.log("\n🏷️  Checking if tag exists...");

  try {
    const tag = `v${version}`;
    const remoteTag = await exec(`git ls-remote --tags origin ${tag}`, {
      silent: true,
    });

    if (remoteTag) {
      console.error(`Error: Tag ${tag} already exists on remote.`);
      console.error("\nThe version may have already been released.");
      console.error("If you need to release again, bump the version first.");
      process.exit(1);
    }

    console.log(`✓ Tag v${version} does not exist`);
  } catch (error) {
    console.error("Error checking remote tags:", (error as Error).message);
    process.exit(1);
  }
}

/**
 * Bump version using npm version command
 */
async function bumpVersion(): Promise<string> {
  console.log(`\n📦 Bumping ${BUMP_TYPE} version...`);

  // Use npm version but don't create git tag yet (we'll do it manually)
  await exec(`npm version ${BUMP_TYPE} --no-git-tag-version`);

  // Read the new version
  const packageJsonFile = Bun.file(PACKAGE_JSON_PATH);
  const packageJson = await packageJsonFile.json();
  const newVersion = packageJson.version;

  console.log(`✓ Version bumped to ${newVersion}`);
  return newVersion;
}

/**
 * Update CHANGELOG.md with version and date
 * Replaces ## [Unreleased] with ## [version] - YYYY-MM-DD
 */
async function updateChangelog(version: string): Promise<void> {
  console.log("\n📝 Updating CHANGELOG.md...");

  if (!existsSync(CHANGELOG_PATH)) {
    console.log("⚠️  CHANGELOG.md not found, skipping changelog update");
    return;
  }

  const changelogFile = Bun.file(CHANGELOG_PATH);
  const changelog = await changelogFile.text();
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // Check if there's an [Unreleased] section
  if (!changelog.includes("## [Unreleased]")) {
    console.log("⚠️  No [Unreleased] section found in CHANGELOG.md");
    console.log("   Add a ## [Unreleased] section and list your changes there");
    console.log("   Continuing without changelog update...");
    return;
  }

  // Replace [Unreleased] with [version] - date
  const updatedChangelog = changelog.replace(
    "## [Unreleased]",
    `## [${version}] - ${date}`
  );

  await Bun.write(CHANGELOG_PATH, updatedChangelog);
  console.log(`✓ Updated CHANGELOG.md: [Unreleased] -> [${version}] - ${date}`);
}

/**
 * Re-add [Unreleased] section to CHANGELOG.md after release
 */
async function addUnreleasedSection(): Promise<void> {
  console.log("\n📝 Re-adding [Unreleased] section to CHANGELOG.md...");

  if (!existsSync(CHANGELOG_PATH)) {
    console.log("⚠️  CHANGELOG.md not found, skipping");
    return;
  }

  const changelogFile = Bun.file(CHANGELOG_PATH);
  const changelog = await changelogFile.text();

  // Find the first ## heading and insert ## [Unreleased] before it
  const lines = changelog.split("\n");
  const firstHeadingIndex = lines.findIndex((line) => line.startsWith("## ["));

  if (firstHeadingIndex === -1) {
    console.log("⚠️  No version headings found in CHANGELOG.md, skipping");
    return;
  }

  // Insert [Unreleased] section
  const unreleasedSection = [
    "## [Unreleased]",
    "",
    "### Added",
    "- ",
    "",
    "### Changed",
    "- ",
    "",
    "### Fixed",
    "- ",
    "",
  ];

  lines.splice(firstHeadingIndex, 0, ...unreleasedSection);

  await Bun.write(CHANGELOG_PATH, lines.join("\n"));
  console.log("✓ Added [Unreleased] section for next release");
}

/**
 * Create release commit on develop branch
 */
async function createReleaseCommit(version: string): Promise<void> {
  console.log("\n💾 Creating release commit...");

  // Stage changes
  await Bun.$`git add package.json CHANGELOG.md`;

  // Commit
  await Bun.$`git commit -m ${"Release v" + version}`;
  console.log(`✓ Created commit for v${version}`);
}

/**
 * Commit the unreleased section
 */
async function commitUnreleasedSection(): Promise<void> {
  console.log("\n📝 Committing [Unreleased] section...");
  await Bun.$`git add CHANGELOG.md`;
  await Bun.$`git commit -m "chore: add [Unreleased] section to CHANGELOG.md"`;
  console.log("✓ Committed [Unreleased] section");
}

/**
 * Push develop branch to origin
 */
async function pushDevelop(): Promise<void> {
  console.log("\n🚀 Pushing develop branch to origin...");
  await Bun.$`git push origin develop`;
  console.log("✓ Pushed develop to origin");
}

/**
 * Merge develop to release/alpha and create tag
 */
async function mergeToReleaseAlpha(version: string): Promise<void> {
  console.log("\n🔀 Merging to release/alpha...");

  try {
    // Checkout release/alpha
    await exec("git checkout release/alpha");
    console.log("✓ Checked out release/alpha");

    // Merge develop
    await exec("git merge develop --no-edit");
    console.log("✓ Merged develop into release/alpha");

    // Remove intermediates directory
    console.log("Removing intermediates/ from release/alpha...");
    await exec("git rm -rf intermediates/");
    await exec(
      'git commit -m "chore: remove intermediates/ from release branch"'
    );
    console.log("✓ Removed intermediates/");

    // Create tag on release/alpha
    const tag = `v${version}`;
    await Bun.$`git tag ${tag}`;
    console.log(`✓ Created tag ${tag} on release/alpha`);

    // Push release/alpha and tag
    console.log("\n🚀 Pushing release/alpha and tag to origin...");
    console.log(`\nAbout to push release/alpha and tag ${tag} to origin.`);
    console.log("This will trigger the release workflow");
    console.log("\nPress Ctrl+C to cancel, or Enter to continue...");

    // Wait for user input
    await Bun.$`sh -c "read"`.quiet();

    await Bun.$`git push origin release/alpha`;
    await Bun.$`git push origin ${tag}`;
    console.log("✓ Pushed release/alpha and tag to origin");
  } catch (error) {
    console.error(
      "\n❌ Merge to release/alpha failed:",
      (error as Error).message
    );
    console.error("\nRecovery steps:");
    console.error("  1. Check current branch: git branch");
    console.error(
      "  2. If on release/alpha, checkout develop: git checkout develop"
    );
    console.error("  3. Reset release/alpha if needed:");
    console.error("     git checkout release/alpha");
    console.error("     git reset --hard origin/release/alpha");
    console.error("  4. The develop branch has been pushed successfully.");
    console.error(
      "     You can manually merge and push when the issue is resolved."
    );
    throw error;
  }
}

/**
 * Main release flow
 */
async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════╗");
  console.log("║   Hankweave Release Automation      ║");
  console.log("╚════════════════════════════════════════╝");
  console.log(`\nBump type: ${BUMP_TYPE}`);

  try {
    // 1. Pre-flight checks
    await checkCurrentBranch("develop");
    await checkGitStatus();
    await checkRemoteSync(["develop", "release/alpha"]);
    await validateChangelog();

    // 2. Bump version
    const newVersion = await bumpVersion();

    // 3. Check if tag already exists
    await checkTagExists(newVersion);

    // 4. Update changelog
    await updateChangelog(newVersion);

    // 5. Create release commit on develop
    await createReleaseCommit(newVersion);

    // 6. Re-add [Unreleased] section
    await addUnreleasedSection();

    // 7. Commit the unreleased section
    await commitUnreleasedSection();

    // 8. Push develop to origin
    await pushDevelop();

    // 9. Merge to release/alpha (excluding intermediates) and push
    await mergeToReleaseAlpha(newVersion);

    // 10. Return to develop
    console.log("\n🔙 Returning to develop branch...");
    await exec("git checkout develop");
    console.log("✓ Back on develop branch");

    // Success!
    console.log("\n╔════════════════════════════════════════╗");
    console.log("║   Release process completed! 🎉        ║");
    console.log("╚════════════════════════════════════════╝");
    console.log(`\nVersion: v${newVersion}`);
    console.log("\nWhat happened:");
    console.log("  1. ✓ Created release commits on develop");
    console.log("  2. ✓ Pushed develop to origin");
    console.log(
      "  3. ✓ Merged develop → release/alpha (excluding intermediates/)"
    );
    console.log("  4. ✓ Created tag v" + newVersion + " on release/alpha");
    console.log("  5. ✓ Pushed release/alpha and tag to origin");
    console.log("\nThe release workflow will now:");
    console.log("  1. Run tests");
    console.log("  2. Publish to npm");
    console.log("  3. Build executables");
    console.log("  4. Create GitHub release");

    // Get repository URL for actions link
    const repoUrl = await exec("git remote get-url origin", { silent: true });
    const cleanUrl = repoUrl
      .replace(/\.git$/, "")
      .replace(/.*github\.com[:/]/, "");
    console.log("\nTrack progress at:");
    console.log(`https://github.com/${cleanUrl}/actions`);
  } catch (error) {
    console.error("\n❌ Release failed:", (error as Error).message);
    process.exit(1);
  }
}

main();
