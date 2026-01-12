# CI/CD Documentation

This document describes the Continuous Integration and Continuous Deployment (CI/CD) system for Strandweave.

## Table of Contents

1. [Overview](#overview)
2. [Workflows](#workflows)
3. [CI Workflow Details](#ci-workflow-details)
4. [Release Workflow Details](#release-workflow-details)
5. [Required Secrets](#required-secrets)
6. [Local Testing](#local-testing)
7. [Skipping CI](#skipping-ci)
8. [Troubleshooting](#troubleshooting)

---

## Overview

Strandweave has two main GitHub Actions workflows:

1. **`ci.yml`** - Runs on every push and PR to ensure code quality
2. **`release.yml`** - Runs on version tags to publish releases

Both workflows run comprehensive tests across multiple platforms to ensure Strandweave works correctly in all deployment modes:
- **Normal mode:** Direct source execution
- **NPX mode:** Via package managers (npm, bunx)
- **Executable mode:** Standalone binaries

---

## Workflows

### CI Workflow (`.github/workflows/ci.yml`)

**Triggers:**
- Push to `master`, `main`, or `strandweave-npx` branches
- Pull requests targeting `master` or `main`

**Concurrency:**
- Cancels previous runs for the same branch/PR to save resources

**Jobs:**
1. `lint-and-typecheck` - Code quality checks
2. `tests` - Unit and integration tests
3. `init-e2e-normal` - Init command in normal mode (source)
4. `init-e2e-npx` - Init command via NPX with Verdaccio
5. `init-e2e-binary` - Init command with compiled binary

**Runtime:** ~15-25 minutes total (jobs run in parallel)

### Release Workflow (`.github/workflows/release.yml`)

**Triggers:**
- Push of tags matching `v*` (e.g., `v0.1.27`)

**Jobs:**
1. `publish-npm` - Runs CI checks and publishes to npm
2. `build-executables` - Builds executables for 5 platforms
3. `create-release` - Creates GitHub release with binaries

**Runtime:** ~20-30 minutes total

---

## CI Workflow Details

### Job 1: Lint and Type Check

**Purpose:** Ensure code quality and type safety

**Runs on:** `ubuntu-latest`

**Steps:**
1. Install dependencies
2. Run Biome linting: `bun run lint`
3. Run TypeScript type check: `bun run tc`

**Fast fail:** This job fails fast to catch obvious issues early

### Job 2: Unit & Integration Tests

**Purpose:** Test code units and integration with external APIs

**Runs on:** `ubuntu-latest`

**Environment Variables:**
- `CLAUDE_CODE_OAUTH_TOKEN` - for Claude API tests
- `GEMINI_API_KEY` - for Gemini API tests
- `STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY` - for sentinel tests

**Steps:**
1. Install dependencies
2. Install gemini-cli globally
3. Run unit tests: `bun test tests/unit`
4. Run integration tests: `bun test tests/integration`

**Coverage:**
- All files in `tests/unit/`
- All files in `tests/integration/`

**Why combined:** Reduces setup overhead and ensures unit tests pass before running integration tests

### Job 3: Init E2E - Normal Mode

**Purpose:** Test `--init` command in direct source execution mode

**Runs on:** `ubuntu-latest`

**Test Script:** `scripts/e2e/init.ts` (runs `tests/e2e/init-command-e2e.test.ts`)

**What it tests:**
1. Creates all required files (`strand.json`, `README.md`, `.gitignore`, `prompts/`, `data/`)
2. Validates generated config is correct
3. Tests init command fails in non-empty directory
4. Supports multiple execution modes (normal, binary, package manager)

**Why this matters:** Ensures init works when users run from source

**Run locally:** `bun test:e2e:init`

### Job 4: Init E2E - NPX Mode

**Purpose:** Test `--init` command via NPX with Verdaccio local registry

**Runs on:** `ubuntu-latest`

**Test Script:** `scripts/e2e/init.ts npx`

**Steps:**
1. Build package (`bun run build`)
2. Start Verdaccio local npm registry
3. Publish package to Verdaccio
4. Run init command via `npx @southbridgeai/strandweave --init`
5. Verify generated files

**Why this matters:** Ensures package installation and init work via npx

**Run locally:** `bun test:e2e:init:npx` (requires build first)

### Job 5: Init E2E - Binary Mode

**Purpose:** Test `--init` command with compiled standalone binary

**Runs on:** `ubuntu-latest`

**Test Script:** `scripts/e2e/init.ts binary`

**Steps:**
1. Build binary for linux-x64
2. Run binary's `--init` command
3. Verify generated files
4. Validate config

**Why this matters:** Ensures standalone executables work correctly

**Run locally:** `bun test:e2e:init:binary` (requires binary build first)

---

## Release Workflow Details

### Job 1: Publish to npm

**Runs on:** `ubuntu-latest`

**Pre-publish checks:**
1. Verify tag matches package.json version
2. Run linting
3. Run type check
4. Run unit tests
5. Run integration tests
6. Build package

**Publish:**
- Uses `NPM_TOKEN` secret for authentication
- Runs `npm publish`
- Outputs package name and version for downstream jobs

**Fail fast:** If any check fails, the workflow stops and doesn't publish

### Job 2: Build Executables

**Depends on:** `publish-npm`

**Matrix:** 5 platforms
- `linux-x64` on `ubuntu-latest`
- `linux-arm64` on `ubuntu-latest`
- `darwin-x64` on `macos-latest`
- `darwin-arm64` on `macos-latest`
- `windows-x64` on `windows-latest`

**Steps per platform:**
1. Setup Node.js and Bun
2. Install dependencies
3. Install gemini-cli
4. Build executable: `bun scripts/build-executable.ts <target>`
5. Upload executable as artifact

**Artifacts:** Each executable is uploaded separately for the next job

### Job 3: Create GitHub Release

**Depends on:** `publish-npm` and `build-executables`

**Steps:**
1. Download all executable artifacts
2. Rename to platform-specific names
3. Extract changelog section for this version
4. Generate release notes with:
   - npm package installation instructions
   - Executable download instructions
   - Platform-specific setup guides
   - Changelog excerpt
5. Create GitHub release with all executables attached

**Release naming:**
- Tag: `v0.1.27`
- Title: `Strandweave v0.1.27`

---

## Required Secrets

Configure these in **Repository Settings** → **Secrets and variables** → **Actions**:

### NPM_TOKEN

**Purpose:** Authenticate with npm registry for publishing

**How to get:**
1. Go to [npmjs.com](https://www.npmjs.com)
2. Account → Access Tokens → Generate New Token
3. Select "Granular Access Token"
4. Enable "Bypass 2FA on publish"
5. Grant read/write permissions for packages

### CLAUDE_CODE_OAUTH_TOKEN

**Purpose:** Run integration tests with Claude Code

**How to get:**
1. Follow Claude Code authentication process
2. Extract OAuth token from config

### GEMINI_API_KEY

**Purpose:** Run integration tests with Gemini

**How to get:**
1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create API key

### STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY

**Purpose:** Run sentinel tests with Anthropic API

**How to get:**
1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Create API key with appropriate permissions

---

## Local Testing

### Run CI checks locally

Before pushing, run the same checks CI will run:

```bash
# Linting
bun run lint

# Type check
bun run tc

# Unit tests
bun test tests/unit

# Integration tests (requires API keys)
export CLAUDE_CODE_OAUTH_TOKEN=your_token
export GEMINI_API_KEY=your_key
export STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY=your_key
bun test tests/integration
```

### Test init command locally

**Normal mode:**
```bash
bun test:e2e:init
# or
bun scripts/e2e/init.ts normal
```

**NPX mode (requires build):**
```bash
bun run build
bun test:e2e:init:npx
# or
bun scripts/e2e/init.ts npx
```

**Bunx mode (requires build):**
```bash
bun run build
bun test:e2e:init:bunx
# or
bun scripts/e2e/init.ts bunx
```

**Binary mode (requires binary build):**
```bash
bun run build:exe:linux  # or :mac, :windows
bun test:e2e:init:binary
# or
bun scripts/e2e/init.ts binary
```

**Docker executable tests:**
```bash
bun test:docker
```

### Test full release flow locally

**Build and test package:**
```bash
bun run build
bun run test:package
```

**Build all executables:**
```bash
bun run build:exe:all
```

**Test executables in Docker:**
```bash
bun test:docker:full-e2e
```

---

## Skipping CI

### Skip CI on specific commits

Add `[skip ci]` or `[ci skip]` to your commit message:

```bash
git commit -m "docs: update README [skip ci]"
```

**Use sparingly!** Only skip CI for:
- Documentation-only changes
- README updates
- Comment changes

### Skip specific jobs

You cannot skip individual jobs, but you can:
- Use draft PRs to prevent CI from running
- Cancel workflows manually in GitHub Actions UI

---

## Troubleshooting

### CI is slow

**Problem:** Workflows taking too long

**Solutions:**
- Check if parallel jobs are running correctly
- Verify matrix strategies are configured properly
- Look for bottlenecks in specific jobs
- Consider caching dependencies (already implemented for Node.js)

### Tests fail in CI but pass locally

**Common causes:**

1. **Missing environment variables**
   - Check GitHub Secrets are set correctly
   - Verify secret names match exactly

2. **Platform differences**
   - Test on the same platform CI uses
   - Use Docker to replicate CI environment

3. **Timing issues**
   - Add retries for flaky tests
   - Increase timeouts if needed

4. **Dependency versions**
   - CI uses latest versions (Bun, Node.js)
   - Pin versions if needed for stability

### Workflow doesn't trigger

**Problem:** Pushed code but no workflow run

**Check:**
1. Workflow file syntax (YAML errors)
2. Trigger conditions (branches, tags)
3. GitHub Actions enabled for repository
4. Permissions (workflows require write access)

**View workflow files:**
```bash
cat .github/workflows/ci.yml
cat .github/workflows/release.yml
```

### Jobs fail with "secrets not available"

**Problem:** Integration tests fail with missing API keys

**Solution:**
1. Go to Repository Settings → Secrets
2. Verify all required secrets are set
3. Check secret names match exactly (case-sensitive)
4. For forked PRs: secrets are not available (expected)

### Executable builds fail

**Problem:** Build executable job fails

**Common issues:**

1. **Missing gemini-cli**
   - Ensure `npm install -g @google/gemini-cli` runs

2. **Bun compilation errors**
   - Check Bun version compatibility
   - Review build script logs

3. **Platform-specific errors**
   - macOS: Code signing issues
   - Windows: Path separator issues
   - Linux ARM: Cross-compilation issues

### Release workflow doesn't run

**Problem:** Pushed tag but release didn't trigger

**Check:**
1. Tag format: Must be `v*` (e.g., `v0.1.27`)
2. Tag was actually pushed: `git ls-remote --tags origin`
3. Workflow file is on the tagged commit

**Fix:**
```bash
# If tag wasn't pushed
git push --tags

# If tag format is wrong
git tag -d wrong-tag
git tag v0.1.27
git push --tags
```

---

## Workflow Optimization Tips

### Parallel Execution

Jobs run in parallel when they don't depend on each other:

```
lint-and-typecheck ────┐
unit-tests ────────────┼─── (all run in parallel)
integration-tests ─────┤
init-e2e-normal ───────┤
init-e2e-npx ──────────┤
init-e2e-executable ───┘
```

### Matrix Strategies

Matrix jobs run in parallel for different configurations:

```yaml
matrix:
  os: [ubuntu-latest, macos-latest, windows-latest]
```

Spawns 3 jobs that run simultaneously.

### Caching

Node.js dependencies are cached automatically by `actions/setup-node@v4`:

```yaml
with:
  node-version: '20'
  cache: 'npm'  # Implied by actions/setup-node
```

### Timeouts

All jobs have timeout limits to prevent runaway processes:

```yaml
timeout-minutes: 10  # Fail after 10 minutes
```

Adjust based on job requirements.

---

## CI Best Practices

1. **Keep CI fast:** Target < 15 minutes for full CI run
2. **Run expensive tests in parallel:** Use matrix strategies
3. **Fail fast:** Lint and type check before running tests
4. **Cache aggressively:** Cache dependencies, build artifacts
5. **Monitor costs:** GitHub Actions has usage limits
6. **Test locally first:** Don't rely on CI to catch basic errors
7. **Use draft PRs:** For work-in-progress, use draft PRs to skip CI
8. **Clear commit messages:** Help reviewers understand changes

---

## Related Documentation

- [Release Process](./RELEASE.md) - How to create releases
- [Packaging Details](./packaging_details.md) - How executables are built
- [Testing Guide](../tests/README.md) - How to write and run tests

---

## Quick Reference

### View workflow runs

```bash
# Open in browser
gh run list
gh run view <run-id>

# Or visit
https://github.com/YOUR_ORG/strandweave-npx/actions
```

### Cancel a workflow

```bash
gh run cancel <run-id>

# Or in GitHub UI:
# Actions → Select run → Cancel workflow
```

### Re-run a workflow

```bash
gh run rerun <run-id>

# Or in GitHub UI:
# Actions → Select run → Re-run jobs
```

### Debug workflow failures

1. Check the logs in GitHub Actions UI
2. Look for the failing step
3. Reproduce locally using the same commands
4. Fix the issue
5. Push and CI will re-run

### Common CI commands

```bash
# Full local CI check (lint + typecheck + tests)
bun run lint && bun run tc && bun test tests/unit tests/integration

# Just tests
bun test tests/unit tests/integration

# E2E init tests (all modes)
bun test:e2e:init          # Normal mode
bun test:e2e:init:npx      # NPX mode (requires build)
bun test:e2e:init:bunx     # Bunx mode (requires build)
bun test:e2e:init:binary   # Binary mode (requires binary)

# Build and test package
bun run build && bun run test:package

# Test executables
bun test:docker:full-e2e
```
