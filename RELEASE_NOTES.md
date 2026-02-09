- 2026-02-09

### Added
- 

### Changed
- 

### Fixed
- **Codon env variables not available in rig setup and beforeCopy commands** (PR #103)
  - Codon `env` variables were only passed to the Claude/shim process, not to `rigSetup` or `beforeCopy` commands
  - Shell expansions like `${MY_VAR}` in rig commands now correctly resolve instead of expanding to empty strings
  - `runCommand()` now accepts and forwards codon env variables to `spawn()`