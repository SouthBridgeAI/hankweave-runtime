# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- 

### Changed
- 

### Fixed
- 

## [0.2.0] - 2026-02-03

### Added

- **Execution Isolation (Hidden Execution Area)**
  - New directory structure separates agent workspace from system files
  - `agentRoot/` - Agent's workspace where all work happens (Git work tree)
  - `rigArchive/` - Archive storage for `archiveOnSuccess` feature
  - `.hankweave/` - System files (checkpoints, logs, manifest) hidden from agent
  - Template variables (`<%AGENT_ROOT%>`, `<%PROJECT_DIR%>`, `<%EXECUTION_DIR%>`) all resolve to `agentRoot/`
  - `server.ready` event now includes `agentRootPath` in addition to `executionPath`

- **Rig Archiving (`archiveOnSuccess` field)**
  - New `archiveOnSuccess` field on codons and loops to archive files after successful completion
  - Files are moved from `agentRoot/` to `rigArchive/<codonId>/` preserving directory structure
  - Loop-level archives create iteration-specific directories: `rigArchive/<loopId>-<iteration>/`
  - Archive manifest tracks all archived files at `.hankweave/archive-manifest.json`
  - Supports glob patterns for specifying files to archive
  - New events: `archive.completed`, `archive.partial` for tracking archive operations

- **Rollback Archive Restoration**
  - When rolling back, archived files are automatically restored from `rigArchive/` to `agentRoot/`
  - Archive manifest is updated to remove entries for rolled-back checkpoints
  - Empty archive directories are cleaned up after restoration
  - New `rollback.archiveRestore` event emitted with details of restored files

### Changed

- Renamed checkpoint git directory from `.git` to `.hankweavecheckpoints` to prevent Git submodule detection when committing execution environments (ENG-178)
  - Existing execution environments are automatically migrated on startup
  - Backup directories (from `--start-new --force`) are also migrated when main checkpoint needs migration
  - File resolver updated to exclude the new directory name from checkpoints
- `beforeCopy` commands in `outputFiles` now only run when `outputDirectory` is configured
  - Previously, `beforeCopy` would run even if there was no output directory to copy to
  - This prevents unnecessary command execution and potential errors
- Process managers now use `agentRootPath` as working directory (previously `executionPath`)
- `PromptBuilder` simplified to only require `agentRootPath` (removed unused `executionPath` parameter)

### Fixed

-

## [0.1.48] - 2026-01-31

### Added

-

### Changed

-

### Fixed

-

## [0.1.47] - 2026-01-31

### Added

- **ASCII structure visualization** (ENG-175)
  - Visual tree diagram of hank structure appears in both `--validate` mode and before normal execution
  - Hierarchical numbering: [1], [2], [2.1], [2.2], [3] for clear codon references
  - Flow arrows (↓) showing execution order between codons
  - Rounded box corners and loop body boxes with visual grouping
  - Color output when running in terminal (auto-disabled when piped)
  - Prompt line counts (e.g., "prompts: 2 (347 lines)") for at-a-glance sizing
  - Terminal-width-aware rendering that adapts to narrow terminals

- **OpenAI Codex CLI support** (PR #77)
  - Run codons using OpenAI models (GPT-4.1, GPT-5.2 variants) via the Codex CLI
  - Platform-specific Codex binary extraction from `@openai/codex-sdk` package
  - Automatic binary detection: uses `node_modules` in dev, extracts to `~/.hankweave/codex-sdk/<version>/` for compiled executables
  - Self-test functionality verifies Codex installation and API key configuration
  - Multiple auth methods supported: `~/.codex/auth.json`, `CODEX_API_KEY`, or `OPENAI_API_KEY` env vars
- **Multi-OS CI testing** (PR #77)
  - CI now runs on Ubuntu, macOS, and Windows
  - E2E tests with retry logic for flaky network conditions
  - Platform-specific test configurations
- **Reusable runtime extractor base** (PR #77)
  - Shared utilities for embedded file extraction, versioning, and caching
  - Handles Bun virtual filesystem paths correctly across platforms
  - Used by Claude SDK, Codex, and shim extractors

### Changed

- **Refactored runtime extractors** (PR #77)
  - `claude-runtime-extractor.ts`: Migrated to base extractor (-215 lines)
  - `shim-runtime-extractor.ts`: Migrated to base extractor (-186 lines)
- **CI workflow enhancements** (PR #77)
  - Added `setup-environment` composite action for Bun, Node.js, and agent auth setup
  - Added `dump-test-logs` composite action for better CI debugging
  - Codex auth via `~/.codex/auth.json` from CI secrets
- **Line ending consistency** (PR #77)
  - `.gitattributes` now enforces LF line endings for text files
  - Prevents CRLF issues that break shell scripts on Windows

### Fixed

- **Comprehensive Windows compatibility fixes** (PR #77)
  - File URL parsing: Use `fileURLToPath()` instead of manual parsing for cross-platform paths
  - Path duplication: Fixed `path.join()` with absolute paths in `HankweaveRuntime` constructor
  - Directory cleanup: Added `rmSyncWithRetry()` with exponential backoff for Windows file locks
  - Build script: Replaced Unix commands (`cp -r`, `chmod`) with cross-platform Node.js APIs
  - Double extension: Prevented `hankweave.exe.exe` on Windows builds
  - NPX discovery: Set `NPM_CONFIG_USERCONFIG` so npx finds `.npmrc` on Windows
  - Codex on Windows: Guide model to use `Write` tool instead of PowerShell commands

## [0.1.46] - 2026-01-27

### Added

- **CLI attach mode** (`--attach` flag) (PR #87, ENG-103)
  - Connect TUI to an already-running server in read-only mode
  - Reads port from execution directory's lock file, or use `--port` to specify directly
  - Commands are disabled in attach mode; press `q` to disconnect without stopping server
- **Required environment variables validation** (`requirements.env`) (PR #87, ENG-121)
  - Declare required env vars in hank.json: `"requirements": { "env": ["ANTHROPIC_API_KEY"] }`
  - Validation runs during both `--validate` and normal startup (fail-fast)
  - Supports `HANKWEAVE_` prefix: `HANKWEAVE_API_KEY` satisfies requirement for `API_KEY`
- **Global system prompts** (`globalSystemPromptFile`/`globalSystemPromptText`) (PR #87, ENG-122)
  - Apply a system prompt to ALL codons in a hank
  - Configure via file path(s) or inline text in hank.json
  - Global prompt is prepended before codon-specific system prompts
- **Rig setup visibility events** (PR #87, ENG-102)
  - Emits `info` events for rig setup start, per-operation progress, and completion
  - TUI formats these events with distinct styling for better visibility
  - Completion event includes duration and success/failure counts
- **`--ignore-rig-failures` CLI flag** (PR #87, ENG-119)
  - Global override to treat all rig setup operations as `allowFailure: true`
  - Useful for resume workflows where rig setup already completed partially

### Changed

- **Directory-aware config resolution** (PR #87, ENG-139)
  - `hankweave ./project/` now finds `./project/hank.json` automatically
  - Data directories containing hank.json are auto-discovered when no explicit config specified
- Lock file now includes `port` field for attach mode discovery
- Refactored prompt building into shared `PromptBuilder` class (used by both SDK and shim managers)
- `loadCodonSequence()` now returns `{ codons, globalSystemPrompt }` object (internal API change)
- Release script now regenerates JSON schemas before commit (ensures schemas are fresh in tagged releases)
- Improved changelog validation with confirmation prompt for empty release notes

### Fixed

- **Symlink copy errors in outputFiles** (PR #87, ENG-125)
  - Added `verbatimSymlinks: true` to `fs.promises.cp()` - symlinks are now preserved during copy
  - Fixes `EINVAL` errors when copying directories with `node_modules/.bin/` symlinks
- Fixed flaky NPX E2E test in CI by adding retry logic (2 attempts) and disabling npm update/audit checks

## [0.1.45] - 2026-01-25

### Changed

- Internal release with build improvements
- Improved changelog validation with confirmation prompt for empty release notes

### Fixed

-

## [0.1.44] - 2026-01-25

### Added

- **JSON Schema support for editor autocomplete** (PR #84)
  - VS Code (and other editors) now provide autocomplete, hover docs, and validation for `hank.json` files
  - Schemas auto-generated from Zod definitions via `bun run generate-schemas`
  - `hankweave init` includes `$schema` in generated files
  - Running or validating auto-adds `$schema` if missing
  - Schemas served via unpkg CDN: `https://unpkg.com/hankweave@latest/schemas/hank.schema.json`
- **Stable data hashing for `--input` flag** (PR #84)
  - Inline/stdin input now creates content-addressed files in `~/.hankweave-cache/inputs/`
  - Same content produces same hash, enabling proper resume with `--execution`
- **`--ignore-data-mismatch` flag** (PR #84)
  - Allows resuming executions when data has intentionally changed
  - Shows warning but continues instead of failing
  - Properly relinks `read_only_data_source` to new data

### Changed

- **Renamed `recommendations` to `overrides` in hank.json** (PR #82)
  - `hank.json` files now use `overrides` instead of `recommendations` for model/settings
  - Old files with `recommendations` will need to be updated
- **Model override now actually works** (PR #81)
  - `--model` CLI flag now properly overrides all codon models
  - Override applied at config loading before validation
  - Simplified architecture: override logic centralized in `loadHankFile()`

### Fixed

- **Better validation error messages for hank files** (PR #80)
  - Errors now show codon ID and name for context
  - Unknown fields get "Did you mean X?" suggestions for common typos
  - Example: `systemPromptFile: Unknown field. Did you mean "appendSystemPromptFile"?`

## [0.1.43] - 2026-01-21

### Changed

- Temporarily disabled OIDC for public npm publishing (requires public package visibility)

## [0.1.42] - 2026-01-21

### Fixed

- Release script improvements for better reliability

## [0.1.41] - 2026-01-20

### Added

- **Public release infrastructure** (PR #79)
  - Two-repo model: private development, public release mirror
  - `hankweave` npm package now available publicly
  - Sync workflow transforms private repo → clean public releases
  - Internal files (`intermediates/`, `CLAUDE.md`, etc.) stripped from public releases

## [0.1.40] - 2026-01-20

### Changed

- Reverted to token-based npm publishing (OIDC requires public package)

## [0.1.39] - 2026-01-20

### Changed

- Switched to npm trusted publishing (OIDC) for secure, token-less releases with provenance attestation

## [0.1.38] - 2026-01-19

### Added

- `--version` CLI flag for printing version number without banner
- Debug directory support for shims (`--debug-dir` flag, logs stored in `.hankweave/logs/shim-debug/{codon-id}/`)

### Changed

- Package configuration:
  - Removed LICENSE field from package.json
  - Added homepage link to Terms of Service
  - Excluded README.md and LICENSE from published package files
  - Increased minimum Node.js version from 18.0.0 to 20.0.0
- Gemini shim consolidated to single `index.js` file (removed `index.mjs` and standalone README)
- Init command E2E test timeouts adjusted for reliability

## [0.1.36] - 2026-01-14

### Added

- Contributing documentation (CONTRIBUTING.md) with branch model and release workflow
- Comprehensive validation mode that performs preflight checks without creating directories
- Tests for validation mode behavior and data source overwriting
- Pre-flight checks in release script: branch verification, remote sync, and changelog validation

### Changed

- Improved execution directory behavior: `--start-new --force` now properly overwrites `read_only_data_source` link
- Refactored validation logic into separate `validate-command.ts` module for better separation of concerns
- Enhanced release automation with develop → release/alpha merge workflow
- Release script now validates changelog content before releasing
- CI now runs on both `develop` and `release/alpha` branches
- Config change warnings now skip when using `--start-new` (user explicitly wants fresh execution)
- Help text clarifications for `--validate`, `--start-new`, and `--force` flags

### Fixed

- Validation mode no longer creates execution directories (regression from ENG-90)
- Data source link now properly refreshed when using `--start-new --force` with different data

## [0.1.35] - 2026-01-13

### Changed

strandweave -> hankweave

## [0.1.34] - 2026-01-13

### Added

- CLI parser with modern space-separated flag syntax (`--flag value`) and comprehensive validation
- Remote strand support: run strands directly from Git URLs (GitHub, GitLab, Bitbucket)
- Remote strand caching system with TTL-based refresh for branches
- Prompt frontmatter: YAML metadata support in prompt markdown files (name, description, tags, version, author)
- Inline text input via `--input <text>` flag for quick data passing
- Stdin support for data input via `--data -` or positional `-` argument
- `--force` flag for running in existing directories with .strandweave/ (creates backups)
- Config change detection on resume with SHA-256 hash tracking and user warnings
- Positional argument support for strand and data paths with smart inference
- Non-interactive mode detection for CI/CD environments (respects CI env vars, test mode, TTY checks)
- Three-tier directory safety validation with user confirmation prompts
- Comprehensive CLI parser tests with 900+ lines of test coverage
- Version banner on startup showing Strandweave version

### Changed

- **BREAKING**: Renamed `trackedFiles` to `checkpointedFiles` in configuration schema for clarity
- TUI now enabled by default (use `--headless` to disable, replaces old `--basic` flag)
- CLI flag syntax: space-separated now preferred (e.g., `--port 8080` instead of `--port=8080`)
- Deprecated `--flag=value` syntax with migration warnings (still supported for backward compatibility)
- Improved help text with examples, positional argument documentation, and remote URL usage
- Execution setup enhanced with directory existence checks and user prompts
- Confirmation prompts now timeout after 30 seconds to prevent hangs
- Help text now shows both positional and flag-based argument formats

### Fixed

- Confirmation prompts now respect non-interactive environments (CI, tests, pipes)
- Directory safety validation with user prompts before potentially destructive operations

## [0.1.33] - 2026-01-12

### Added

- Verdaccio integration for local npm registry testing
- E2E test suite for package installation and executables
- Test utilities for binary file comparison and executable validation
- CI/CD workflows for automated building, testing, and publishing
- Support for testing executables on Linux x64/ARM64, macOS Intel/Apple Silicon, Windows x64

### Changed

- Improved test infrastructure with HankweaveServerTestInstance class
- Updated CI/CD workflows with comprehensive platform matrix testing
- Enhanced error handling and logging throughout runtime extraction

### Fixed

- Test helper utilities for cross-platform compatibility

## [0.1.32] - 2026-01-12

### Added

-

### Changed

-

### Fixed

-

## [0.1.31] - 2026-01-12

### Added

-

### Changed

-

### Fixed

-

## [0.1.30] - 2026-01-12

### Added

-

### Changed

-

### Fixed

-

## [0.1.29] - 2026-01-12

### Added

-

### Changed

-

### Fixed

-

## [0.1.28] - 2026-01-12

### Added

-

### Changed

-

### Fixed

-

## [0.1.27] - 2026-01-12

### Added

-

### Changed

-

### Fixed

-

## [0.1.26] - 2025-01-10

### Added

- NPX package distribution support
- Standalone executables for Linux (x64/ARM64), macOS (Intel/Apple Silicon), and Windows
- Runtime abstraction for Bun, Node.js, and Deno runtimes
- Embedded Claude Agent SDK and shim files in executables with runtime extraction
- CI/CD infrastructure for automated building, testing, and publishing
- Docker-based testing for executables
- Verdaccio integration for local npm registry testing
- Comprehensive E2E tests for package installation and executables

### Changed

- Package name to `@southbridgeai/hankweave` for scoped npm publishing
- Entry point from `server/index.ts` to `dist/index.js` (built artifact)
- Init command templates now inlined as strings (removed template files)
- Server implementation to use runtime-agnostic WebSocket abstraction
- Switched to Haiku for init command (cost-effective default)

### Fixed

- Windows file locking issues with retry logic
- Cross-platform path handling in build scripts
- Binary extraction on different platforms
