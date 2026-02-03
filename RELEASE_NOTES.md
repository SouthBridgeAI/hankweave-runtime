- 2026-02-03

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