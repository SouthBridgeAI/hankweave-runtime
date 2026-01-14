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
	options: { silent?: boolean } = {},
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
		console.error("Error: Uncommitted changes detected. Commit or stash first.");
		console.error("\nUncommitted changes:");
		console.error(status);
		process.exit(1);
	}

	console.log("✓ Git working directory is clean");
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
		`## [${version}] - ${date}`,
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
 * Create git commit and tag
 */
async function createGitTag(version: string): Promise<void> {
	console.log("\n🏷️  Creating git commit and tag...");

	// Stage changes
	await Bun.$`git add package.json CHANGELOG.md`;

	// Commit
	await Bun.$`git commit -m ${"Release v" + version}`;
	console.log(`✓ Created commit for v${version}`);

	// Create tag
	await Bun.$`git tag ${"v" + version}`;
	console.log(`✓ Created tag v${version}`);
}

/**
 * Push to origin
 */
async function pushToOrigin(version: string): Promise<void> {
	console.log("\n🚀 Pushing to origin...");

	// Display information
	console.log(`\nAbout to push tag v${version} to origin.`);
	console.log("This will trigger the release workflow which will:");
	console.log("  1. Publish to npm");
	console.log("  2. Build executables for all platforms");
	console.log("  3. Create a GitHub release with binaries");
	console.log("\nPress Ctrl+C to cancel, or Enter to continue...");

	// Wait for user input
	await Bun.$`sh -c "read"`.quiet();

	// Push only the tag (not the commits)
	await Bun.$`git push origin ${`v${version}`}`;

	console.log(`✓ Pushed tag v${version} to origin`);
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
		// 1. Check git status
		await checkGitStatus();

		// 2. Bump version
		const newVersion = await bumpVersion();

		// 3. Update changelog
		await updateChangelog(newVersion);

		// 4. Create git commit and tag
		await createGitTag(newVersion);

		// 5. Re-add [Unreleased] section
		await addUnreleasedSection();

		// 6. Commit the unreleased section
		console.log("\n📝 Committing [Unreleased] section...");
		await Bun.$`git add CHANGELOG.md`;
		await Bun.$`git commit -m "chore: add [Unreleased] section to CHANGELOG.md"`;

		// 7. Push to origin (this triggers the release workflow)
		await pushToOrigin(newVersion);

		console.log("\n╔════════════════════════════════════════╗");
		console.log("║   Release process completed! 🎉        ║");
		console.log("╚════════════════════════════════════════╝");
		console.log(`\nVersion: v${newVersion}`);
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
