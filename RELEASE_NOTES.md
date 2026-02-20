## [0.5.4] - 2026-02-20

### Added
- 

### Changed
- 

### Fixed
- **Release CI: all 5 platform builds now succeed** — `darwin-x64` and `linux-arm64` builds were failing because `bun install` only fetches the codex binary for the host architecture. Cross-compilation targets now fetch the correct binary via `npm pack` before building. Also survived the retirement of `macos-13` (Intel) runners along the way.