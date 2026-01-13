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

**Status:** In Progress

**Completed:**
- [ ] Read server/config.ts to understand current schema
- [ ] Update schema definition
- [ ] Update TypeScript types
- [ ] Update runtime code in strandweave-runtime.ts
- [ ] Update validation logic
- [ ] Update init command template
- [ ] Update tests
- [ ] Update README examples
- [ ] Run lint and type check

**Problems encountered:**
- (none yet)

**Judgement calls:**
- Clean break approach means no migration transform needed - just remove the old field entirely

**Next steps:**
- Read config.ts to understand current trackedFiles usage

---

## Task 2: ENG-106 - CLI Improvements

### Date: (pending)

---

## Task 3: ENG-93 - Simple Input Text

### Date: (pending)

---

## Tasks 4 & 5: ENG-91 & ENG-88 - Execution Safety

### Date: (pending)

---

## Task 6: ENG-87 - Frontmatter on Prompts

### Date: (pending)

**Note:** Scope significantly reduced - frontmatter is metadata-only, no config overrides.

---

## Task 7: ENG-105 - Repository Link Strand

### Date: (pending)

**Note:** Using temp directory for cache, no confirmation prompts (just informational summary).
