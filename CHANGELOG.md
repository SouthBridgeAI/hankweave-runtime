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

## [0.1.37] - 2026-01-19

### Added
- `--version` CLI flag for printing version number without banner
- Debug directory support for shims (`--debug-dir` flag, logs stored in `.hankweave/logs/shim-debug/{codon-id}/`)

### Changed
- Package configuration for public npm publishing:
  - Changed npm access from "restricted" to "public"
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
