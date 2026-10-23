## [0.13.2] - 2026-10-23

### Added
- 

### Changed
- 

### Fixed
- **A model newer than the cached models.dev catalog was rejected until some other run refreshed the cache** — models.dev was only refreshed in the background, which `--validate` never starts and which a run that fails validation exits before finishing, so on a fresh machine (or a cache older than the model) a new model failed every time. When a harness does not know a model and the models.dev cache is missing or more than six hours old, startup now refreshes models.dev once (bounded) and checks that model again. `noOnlineModelChecks` still turns this off.