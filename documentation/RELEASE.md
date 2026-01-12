# Release Process Documentation

This document describes the release process for Strandweave, including version bumping, changelog management, npm publishing, and creating GitHub releases with executables.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Release Workflow](#release-workflow)
4. [Step-by-Step Guide](#step-by-step-guide)
5. [What Happens During Release](#what-happens-during-release)
6. [Troubleshooting](#troubleshooting)
7. [Rollback Procedures](#rollback-procedures)

---

## Overview

Strandweave uses a **tag-triggered release workflow** inspired by [pi-mono](https://github.com/badlogic/pi-mono). When you push a version tag (e.g., `v0.1.27`), the GitHub Actions workflow automatically:

1. Publishes the npm package to the registry
2. Builds standalone executables for all platforms
3. Creates a GitHub release with binaries attached

The release script (`scripts/release.mjs`) automates the entire process:
- Version bumping
- CHANGELOG.md management
- Git commit and tagging
- Pushing to trigger the workflow

---

## Prerequisites

### 1. NPM Token

You need an NPM authentication token with publish permissions.

**Creating a Granular Access Token:**

1. Log in to [npmjs.com](https://www.npmjs.com)
2. Go to **Access Tokens** → **Generate New Token**
3. Select **Granular Access Token**
4. **Important:** Enable **"Bypass 2FA on publish"** (required for CI)
5. Grant **Read and write** permissions for packages
6. Copy the token

**Configure locally:**

```bash
npm config set //registry.npmjs.org/:_authToken=YOUR_TOKEN
```

**Add to GitHub Secrets:**

Go to your repository **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

- **Name:** `NPM_TOKEN`
- **Value:** Your token

### 2. API Keys (for tests)

The release workflow runs integration and E2E tests that require API keys:

**Required GitHub Secrets:**

- `CLAUDE_CODE_OAUTH_TOKEN` - Claude Code OAuth token
- `GEMINI_API_KEY` - Google Gemini API key
- `STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY` - Anthropic API key for sentinels

### 3. Clean Git State

Ensure you have:
- No uncommitted changes
- All changes pushed to `master` branch
- Tests passing locally

---

## Release Workflow

### Release Scripts

```bash
# Bump patch version (0.1.26 -> 0.1.27)
npm run release:patch

# Bump minor version (0.1.26 -> 0.2.0)
npm run release:minor

# Bump major version (0.1.26 -> 1.0.0)
npm run release:major
```

---

## Step-by-Step Guide

### 1. Update CHANGELOG.md

Before releasing, update the `## [Unreleased]` section with your changes:

```markdown
## [Unreleased]

### Added
- New feature X that does Y

### Changed
- Updated Z to improve performance

### Fixed
- Bug in feature A
```

**Categories:**
- **Added:** New features
- **Changed:** Changes to existing functionality
- **Deprecated:** Soon-to-be-removed features
- **Removed:** Removed features
- **Fixed:** Bug fixes
- **Security:** Security fixes

### 2. Commit Your Changes

```bash
git add .
git commit -m "feat: add feature X"
git push origin master
```

### 3. Run the Release Script

```bash
npm run release:patch  # or minor/major
```

**The script will:**

1. ✅ Check git status (must be clean)
2. 📦 Bump version in `package.json`
3. 📝 Update CHANGELOG.md:
   - Replace `## [Unreleased]` with `## [0.1.27] - 2025-01-12`
4. 🏷️ Create git commit: `"Release v0.1.27"`
5. 🏷️ Create git tag: `v0.1.27`
6. 📝 Re-add `## [Unreleased]` section to CHANGELOG.md
7. 📝 Commit unreleased section
8. 🚀 **Prompt you to push** (Ctrl+C to cancel)

### 4. Push Triggers Release Workflow

When you confirm the push, the script pushes both commits and the tag:

```bash
git push
git push --tags
```

This triggers `.github/workflows/release.yml` which:

1. **Runs full CI checks:**
   - Linting
   - Type checking
   - Unit tests
   - Integration tests

2. **Publishes to npm:**
   - Builds package (`bun run build`)
   - Publishes to npm registry
   - Verifies tag matches package.json version

3. **Builds executables (parallel):**
   - Linux x64
   - Linux ARM64
   - macOS x64 (Intel)
   - macOS ARM64 (Apple Silicon)
   - Windows x64

4. **Creates GitHub release:**
   - Downloads all executables
   - Extracts changelog for this version
   - Creates release with binaries attached
   - Generates installation instructions

### 5. Monitor the Release

Track progress at:
```
https://github.com/YOUR_ORG/strandweave-npx/actions
```

The workflow takes approximately:
- **Publish npm:** ~5-10 minutes
- **Build executables:** ~15-20 minutes (parallel)
- **Create release:** ~2 minutes

**Total:** ~20-30 minutes

---

## What Happens During Release

### Automated Workflow Jobs

#### Job 1: `publish-npm`

**Steps:**
1. Checkout code at tag
2. Setup Node.js and Bun
3. Install dependencies
4. Verify tag matches `package.json` version
5. Run linting (`bun lint`)
6. Run type check (`bun tc`)
7. Run unit tests
8. Run integration tests
9. Build package (`bun build`)
10. Publish to npm

**Outputs:**
- Package name
- Package version

#### Job 2: `build-executables`

**Matrix strategy** (runs in parallel):
- 5 platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64
- Each job builds executable for its platform
- Uploads executable as artifact

**Steps per platform:**
1. Checkout code
2. Setup Node.js and Bun
3. Install dependencies
4. Install gemini-cli globally
5. Build executable (`bun scripts/build-executable.ts <target>`)
6. Upload artifact

#### Job 3: `create-release`

**Depends on:** `publish-npm` and `build-executables`

**Steps:**
1. Download all executable artifacts
2. Rename to platform-specific names
3. Extract changelog section for this version
4. Generate release notes with installation instructions
5. Create GitHub release with executables

**Release includes:**
- npm package info
- Platform-specific binaries
- Installation instructions
- Changelog excerpt

---

## Troubleshooting

### Problem: "Uncommitted changes detected"

**Solution:**
```bash
git status
git add .
git commit -m "your message"
# Then run release script again
```

### Problem: "Tag version does not match package.json version"

This happens if you manually edited `package.json` version but the tag doesn't match.

**Solution:**
```bash
# Delete the tag
git tag -d v0.1.27
# Delete remote tag if pushed
git push origin :refs/tags/v0.1.27
# Run release script again
npm run release:patch
```

### Problem: NPM publish fails with "unauthorized"

**Solution:**
Check your NPM_TOKEN secret:
1. Verify it's set in GitHub Secrets
2. Verify it has publish permissions
3. Verify "Bypass 2FA on publish" is enabled
4. Regenerate token if needed

### Problem: Executable build fails on specific platform

**Solution:**
1. Check the GitHub Actions logs for that platform
2. Common issues:
   - Missing dependencies (gemini-cli)
   - Bun version incompatibility
   - Platform-specific build errors

### Problem: Tests fail in CI but pass locally

**Solution:**
1. Check if API keys are set in GitHub Secrets
2. Verify environment differences (Node version, OS)
3. Run tests in Docker locally to replicate CI environment

### Problem: Release workflow didn't trigger

**Solution:**
Verify the tag was pushed:
```bash
git ls-remote --tags origin
```

If tag is missing:
```bash
git push --tags
```

---

## Rollback Procedures

### If npm publish succeeded but you need to rollback:

**Option 1: Unpublish (within 72 hours)**
```bash
npm unpublish @southbridgeai/strandweave@0.1.27
```

**Option 2: Deprecate**
```bash
npm deprecate @southbridgeai/strandweave@0.1.27 "Version deprecated, please use 0.1.28"
```

### If GitHub release was created incorrectly:

1. Go to GitHub **Releases** page
2. Edit or delete the release
3. Re-run the workflow by re-pushing the tag:
   ```bash
   git tag -d v0.1.27
   git push origin :refs/tags/v0.1.27
   git tag v0.1.27
   git push --tags
   ```

### If you need to cancel a release mid-flight:

1. Go to GitHub Actions
2. Find the running workflow
3. Click **Cancel workflow**

Note: If npm publish already completed, you'll need to unpublish or release a new version.

---

## Version Bumping Guidelines

### Semantic Versioning

Follow [SemVer](https://semver.org/):

- **Patch** (0.1.26 → 0.1.27): Bug fixes, no API changes
- **Minor** (0.1.26 → 0.2.0): New features, backwards compatible
- **Major** (0.1.26 → 1.0.0): Breaking changes

### Examples

**Patch release:**
- Bug fixes
- Performance improvements (no API changes)
- Documentation updates
- Dependency updates

**Minor release:**
- New features
- New optional parameters
- New configuration options
- Deprecations (with warnings)

**Major release:**
- Breaking API changes
- Removed deprecated features
- Changed behavior of existing features
- Node.js version requirement changes

---

## Best Practices

1. **Always update CHANGELOG.md** before releasing
2. **Test locally first:** Run `bun test` and `bun lint` before release
3. **Review changes:** Use `git log` to review commits since last release
4. **Small releases:** Prefer frequent small releases over large infrequent ones
5. **Communication:** Announce breaking changes in advance
6. **Monitoring:** Watch the workflow run to catch issues early

---

## Quick Reference

### Pre-Release Checklist

- [ ] All tests passing locally
- [ ] CHANGELOG.md updated with changes
- [ ] All changes committed and pushed
- [ ] Git working directory clean
- [ ] API keys set in GitHub Secrets
- [ ] NPM_TOKEN configured

### Release Commands

```bash
# Patch release (bug fixes)
npm run release:patch

# Minor release (new features)
npm run release:minor

# Major release (breaking changes)
npm run release:major
```

### Post-Release Verification

1. Check npm: `npm view @southbridgeai/strandweave`
2. Check GitHub release: https://github.com/YOUR_ORG/strandweave-npx/releases
3. Test installation: `npx @southbridgeai/strandweave@latest --help`
4. Test executable download from GitHub releases

---

## Related Documentation

- [CI Documentation](./CI.md) - Details on CI workflows
- [Packaging Details](./packaging_details.md) - How executables are built
- [CHANGELOG.md](../CHANGELOG.md) - Project changelog
