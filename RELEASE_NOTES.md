- 2026-02-08

### Added

- **HTML Comment Stripping in Prompts** (ENG-158)
  - HTML comments (`<!-- ... -->`) are now automatically stripped from all prompts before sending to LLM
  - Applies to system prompts, user prompts, and template variable processing
  - Trailing newlines are also consumed to prevent blank line accumulation
  - Useful for adding internal notes and documentation that shouldn't reach the model

- **Output File Conflict Resolution** (ENG-115)
  - Automatic handling of filename collisions when copying output files
  - Conflicting files are renamed with format: `file_<counter>_<timestamp>.ext` (e.g., `report_1_1738678800.pdf`)
  - Preflight warnings shown when output directory is non-empty
  - New `resolveFileConflict()` utility with safety limit (max 100 conflicts)
  - Server emits info events with conflict details for client awareness
  - Updated `copyFiles()` returns conflict information for post-copy processing

- **Headless Autostart Control** (ENG-180)
  - New `requestAutostart()` method for idempotent codon execution triggering
  - Headless mode now automatically starts execution without waiting for client connection
  - Prevents race condition where both headless startup and client handshake trigger autostart
  - Smart exit codes: 0 for success/user shutdown, 1 for codon failure (based on run status)

### Changed

- **Dynamic Port Allocation by Default** (ENG-179)
  - Default WebSocket server port changed from 7777 to 0 (OS-assigned ephemeral port)
  - Prevents port conflicts when running multiple Hankweave instances
  - Startup sequence reordered: WebSocket server binds first, then proxy on `actualPort + 1`
  - Lock file now updated with actual ports after binding
  - `start()` method now returns actual port for callers
  - CLI help text updated to reflect auto-selection behavior
  - Proxy falls back to dynamic port if preferred port unavailable

- **`shutdown()` signature enhanced** (ENG-180)
  - New optional parameter: `shutdown(reason, exitProcess = true, exitCode?)`
  - Exit code can now be explicitly set or auto-determined from run status
  - Fully backward compatible with existing `shutdown(reason)` and `shutdown(reason, exitProcess)` calls

- **Cleaner Startup Logs**
  - Removed noisy `[MODULE]` debug output from startup
  - Version and platform info now displayed in a clean rounded box matching codon display style
  - Execution info grouped together: status, source, path, and SDK versions
  - Paths shortened with `~` for home directory
  - Suppressed verbose "Calculating data signature..." message
  - SDK managers now return structured info instead of printing directly

### Fixed

- **Critical: Dynamic Port Display Bug**
  - Fixed banner showing `ws://localhost:0` instead of actual assigned port
  - TUI was attempting to connect to port 0, causing immediate connection failure
  - Now correctly reads actual port from crossws Bun adapter via `.bun.server.port`
  - Affects all dynamic port allocations (default behavior)

- **Critical: HTTP Request Crash in Headless Mode**
  - Fixed crash when server receives HTTP requests (curl, browser, health checks)
  - Previously crashed with "fetchHandler is not a function" error
  - Now returns helpful JSON error message directing users to WebSocket endpoint
  - Particularly important for CI/CD environments where stray HTTP probes could kill entire runs
  - Added CORS headers for better browser compatibility

- **Sentinel Output Path Resolution**
  - Sentinel output paths with `/` (including `./`) now correctly resolve relative to `agentRootPath`
  - Previously, all explicit paths resolved relative to `executionPath` (outer directory)
  - Filename-only paths continue to use managed directory: `.hankweave/sentinels/outputs/{id}/`
  - Allows sentinels to write outputs directly to agent workspace (e.g., `./analysis.log`)
  - Path safety validation updated to allow paths within both `executionPath` and `agentRootPath`