## [0.5.3] - 2026-02-20

### Added
- 

### Changed
- 

### Fixed
- **Release CI: darwin-x64 build** — `macos-13` (Intel) runners were retired by GitHub. Switched to cross-compilation on `macos-latest` (ARM) using the same `npm pack` fetch approach as `linux-arm64`.

## [0.5.2] - 2026-02-20

### Added
- 

### Changed
- 

### Fixed
- **Release CI: cross-platform codex binary builds** — `darwin-x64` and `linux-arm64` executable builds now succeed. `darwin-x64` uses `macos-13` (Intel) runner; `linux-arm64` fetches the target platform's codex binary via `npm pack` before building.

## [0.5.1] - 2026-02-20

### Added

-

### Changed

- **Dynamic model selection for credit validation** — `validateApiCredits()` now uses the model registry to find the cheapest recent model per provider instead of hardcoding model names that rot when providers deprecate old models. `findCheapestModel()` prefers models updated in the last 6 months, falls back to 1 year, then all candidates.

### Fixed

- **Remote hanks with slashed branch names** — URLs like `.../tree/release/alpha/path/to/hank` now work correctly. The URL parser couldn't tell where the branch name ended and the file path began for branches containing `/`. Now uses `git ls-remote` to resolve the actual ref before cloning.
- \*\*Release script: The dry-run feasibility check also catches `DU`/`UD` conflict markers it previously missed.