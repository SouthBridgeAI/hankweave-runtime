# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Package name to `@southbridgeai/strandweave` for scoped npm publishing
- Entry point from `server/index.ts` to `dist/index.js` (built artifact)
- Init command templates now inlined as strings (removed template files)
- Server implementation to use runtime-agnostic WebSocket abstraction
- Switched to Haiku for init command (cost-effective default)

### Fixed
- Windows file locking issues with retry logic
- Cross-platform path handling in build scripts
- Binary extraction on different platforms
