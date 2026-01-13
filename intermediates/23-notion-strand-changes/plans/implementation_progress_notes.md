# Implementation Progress Notes

## User Decisions (2026-01-13)

All decisions confirmed with user before implementation:

### Task 1: ENG-92 - Rename trackedFiles
- **Decision 1.1:** Clean break now - immediately remove `trackedFiles` support (breaking change, no deprecation period)

### Task 2: ENG-106 - CLI Improvements
- **Decision 2.1:** Deprecate equals syntax with warnings, prefer space-separated
- **Decision 2.2:** TUI default with `--headless` to disable
- **Decision 2.3:** Skip ENG-21 - relative paths already verified working

### Task 3: ENG-93 - Simple Input Text
- **Decision 3.1:** Use `-` for stdin (Unix convention)
- **Decision 3.2:** Use `--input` flag (not `--data-text`)

### Tasks 4 & 5: ENG-91 & ENG-88 - Execution Safety
- **Decision 4.1:** Keep strict three-tier system (Tier 2 requires `--force`)
- **Decision 4.2:** Current security warning is sufficient
- **Decision 4.3:** Whitespace sensitivity is fine (hash raw content)

### Task 6: ENG-87 - Frontmatter on Prompts
- **Decision 6.1:** Strict schema validation - reject unknown fields
- **Decision 6.2:** **MAJOR CHANGE:** Frontmatter is ONLY for metadata/labeling (name, description, tags, version, author). NO config overrides (model, continuationMode removed from scope)
- **Decision 6.3:** Show metadata in TUI when codon starts

### Task 7: ENG-105 - Repository Link Strand
- **Decision 7.1:** Use cross-platform temp directory (`os.tmpdir()`) - OS handles cleanup
- **Decision 7.2:** Show strand summary before execution
- **Decision 7.3:** No confirmation prompt - show summary but continue automatically

---

## Task 1: ENG-92 - Rename trackedFiles

### Date: 2026-01-13

**Status:** ✅ COMPLETED (2026-01-13)

**Completed:**
- [x] Read server/config.ts to understand current schema
- [x] Update schema definition in config.ts (line 295-300)
- [x] Update error message valid fields list (line 74)
- [x] Update validation logic (lines 1470, 1522)
- [x] Update runtime code in strandweave-runtime.ts (4 locations)
- [x] Update init command template (3 locations)
- [x] Update test files (12 TypeScript files)
- [x] Update test config files (6 JSON files)
- [x] Update README and documentation (4 files)
- [x] Run lint and type check - all passing

**Problems encountered:**
- None

**Judgement calls:**
- Clean break approach means no migration transform needed - just remove the old field entirely
- No deprecation warning - breaking change as requested by user

**Files modified:**
- server/config.ts
- server/strandweave-runtime.ts
- server/init-command.ts
- tests/utils/test-codon-factory.ts
- tests/unit/*.test.ts (5 files)
- tests/integration/llm-proxy.test.ts
- tests/e2e/*.test.ts (2 files)
- tests/e2e/test-groups/*.ts (2 files)
- tests/utils/sanity-check.ts
- tests/config/*.json (6 files)
- README.md
- documentation/*.md (3 files)

---

## Task 2: ENG-106 - CLI Improvements

### Date: 2026-01-13

**Status:** ✅ COMPLETED

**Changes implemented:**
1. **Space-separated flags** - Added `getFlagValue()` helper that supports both `--flag value` and deprecated `--flag=value` syntax
   - Shows deprecation warning when `=` syntax is used
2. **TUI as default** - Changed from `--basic` to `--headless`
   - TUI now runs by default
   - Use `--headless` to disable for CI/CD and scripts
3. **Positional arguments** - Supports `strandweave [strand-path] [data-path]`
   - First positional arg is strand config path (default: strand.json)
   - Second positional arg is data path (default: current directory)
4. **Proxy off by default** - Changed `withoutProxy: false` → `withoutProxy: true`
   - Proxy disabled by default, use `--proxy` to enable
   - `--without-proxy` kept for backward compatibility
5. **Updated help text** - Reflects new syntax and defaults

**Files modified:**
- server/index.ts
- server/config.ts

**Breaking changes:**
- `--basic` / `-b` flags removed (TUI is now default)
- Use `--headless` instead for scripts and CI/CD
- Proxy is now off by default (use `--proxy` to enable)

---

## Task 3: ENG-93 - Simple Input Text

### Date: 2026-01-13

**Status:** ✅ COMPLETED

**Changes implemented:**
1. **Stdin support** - Added `readStdin()` function for reading piped input
   - Detects TTY and errors if no input piped
   - Uses async iteration for memory efficiency
2. **Inline text support** - Added `--input <text>` flag
   - Changed from recommended `--data-text` to `--input` per user decision
3. **Temp file handling** - Added `generateTempFilePath()` function
   - Creates unique temp files in `os.tmpdir()`
   - Uses timestamp + random suffix for uniqueness
4. **Precedence** - `--input` > `--data -` > `--data path` > default cwd
5. **Updated help text** - Includes new input modes and examples

**Files modified:**
- server/index.ts

**New CLI features:**
```bash
# Inline text
strandweave strand.json --input "Analyze this text"

# Pipe from stdin
echo "Design an API" | strandweave strand.json -

# Pipe file contents
cat spec.md | strandweave strand.json --data -
```

---

## Tasks 4 & 5: ENG-91 & ENG-88 - Execution Safety

### Date: 2026-01-13

**Status:** ✅ COMPLETED

**Task 4 (Config Warnings on Resume):**
- Added strand.json hash storage in execution-meta.json
- Hash calculated using SHA-256 via Node.js crypto
- On resume, compares current strand hash with stored hash
- Warns user if config changed, prompts for confirmation
- Can skip with -y flag or --force

**Task 5 (Run in Existing Directories):**
- Implemented three-tier safety system:
  - **Tier 1:** Hard error for ~/.strandweave-executions/ (reserved for auto-managed)
  - **Tier 2:** Error unless --force for directories with .strandweave/ (backs up existing)
  - **Tier 3:** Warning + prompt for non-empty directories
- Added --force flag
- Added countDirectoryContents() helper
- Added promptConfirmation() helper for user prompts

**Files modified:**
- server/execution-setup.ts (major changes)
- server/index.ts (added --force flag, updated setup call)

**New CLI features:**
```bash
# Force start in directory with existing .strandweave
strandweave --execution ./my-project --start-new --force

# Skip all confirmation prompts
strandweave --execution ./my-project --start-new -y
```

---

## Task 6: ENG-87 - Frontmatter on Prompts

### Date: 2026-01-13

**Status:** ✅ COMPLETED

**Changes implemented:**
1. **Frontmatter parser** - Created `server/prompt-frontmatter.ts` with:
   - Strict Zod schema (rejects unknown fields)
   - Only metadata fields: name, description, tags, version, author
   - Simple YAML parser (no external dependency)
2. **Integration** - Used in `codon-runner.ts`, `shim-process-manager.ts`, `claude-agent-sdk-manager.ts`
3. **TUI display** - Metadata shown in `basic-tui.ts` when codon starts

**Files created:**
- server/prompt-frontmatter.ts

**Files modified:**
- server/codon-runner.ts
- server/shim-process-manager.ts
- server/claude-agent-sdk-manager.ts
- server/basic-tui.ts

---

## Task 7: ENG-105 - Repository Link Strand

### Date: 2026-01-13

**Status:** ✅ COMPLETED

**Changes implemented:**
1. **Remote strand resolver** - Created `server/remote-strand.ts` with:
   - URL parser for GitHub, GitLab, Bitbucket (HTTPS and SSH)
   - Cache in `os.tmpdir()` (cross-platform)
   - 1-hour TTL for branches, indefinite for tags/commits
   - Uses `simple-git` for clone/fetch operations
2. **Integration** - Used in `server/index.ts` main entry point
3. **Strand summary** - Displays strand info before execution (no confirmation needed)

**Files created:**
- server/remote-strand.ts

**Files modified:**
- server/index.ts
