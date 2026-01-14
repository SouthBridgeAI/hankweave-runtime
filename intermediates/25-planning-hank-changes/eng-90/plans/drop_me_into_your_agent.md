# Implementation Guide: Hankweave Execution Directory Bug Fix

## For the Implementing Agent

This document is your complete guide to implementing ENG-90, a focused bug fix for Hankweave's execution directory management. You are implementing fixes for two bugs: validation mode creating unnecessary directories, and `--start-new --force` not properly overwriting data sources.

### Before You Start

1. **Read these files first** (in order):
   - This document (you're reading it)
   - `./plans/final-standalone-1-fixing-execution-directory-behavior.md` - The complete implementation plan
   - `./tadpole/server/index.ts` (lines 256-382) - The main flow you'll modify
   - `./tadpole/server/execution-setup.ts` (lines 340-380) - The data linking logic you'll modify

2. **Understand the three-tier safety system** (DO NOT BREAK THIS):
   - **Tier 1**: Hard block on using `~/.hankweave-executions/` as an explicit path
   - **Tier 2**: Require `--force` for directories with existing `.hankweave/`
   - **Tier 3**: Prompt for confirmation on non-empty directories without `.hankweave/`

3. **Run the existing test suite first** to establish a baseline:
   ```bash
   cd tadpole && bun run test:unit
   ```

### Key Conventions

**File naming**: All implementation files live in `./tadpole/server/`. Tests live in `./tadpole/tests/unit/`.

**Testing framework**: Bun Test. Import from `bun:test`, not `vitest`.

**Console output prefixes**:
- `📁` for directory operations
- `🔗` for linking operations
- `⚠️` for warnings
- `❌` for errors
- `✅` for success
- `🔍` for validation
- `📦` for backups
- `🗑️` for removals (new - use for data link removal)

**Error messages**: Follow existing pattern with clear problem statement and numbered options:
```typescript
throw new Error(
  `Problem description: ${context}\n` +
  `Options:\n` +
  `  1. First option\n` +
  `  2. Second option`
);
```

**Path handling**: Always use absolute paths. Use `path.resolve()` early. Keep track of original CWD before any `process.chdir()`.

### How to Use These Plans

The `./plans/` folder contains:
- `index.md` - Overview and context
- `final-standalone-1-fixing-execution-directory-behavior.md` - **THE MAIN PLAN** with all implementation details
- `supporting-docs/` - Background research and decision rationale (read if you need more context on why decisions were made)

The implementation plan has 7 steps. Follow them in order.

---

## Background

### What We're Building

This is a **focused bug fix**, not a refactor. You are fixing two specific bugs in Hankweave's execution directory system:

**Bug 1 (Validation mode creates directories)**: When users run `hankweave --validate`, the system calls `setupExecutionEnvironment()` before checking the validate flag. This creates directories, copies/symlinks data, and writes metadata files - even though validation should have no filesystem side effects.

**Bug 2 (`--start-new --force` doesn't overwrite data)**: When users run `hankweave --start-new --force` on an existing execution directory with different data, the old `read_only_data_source` symlink/copy is not removed and recreated with the new data.

### The Codebase

**Hankweave** is a runtime for reliable, brownfield AI engineering. It freezes ephemeral agentic behaviors into "Hanks" (declarative, reproducible AI programs) that execute deterministically.

**Key concepts**:
- **Execution directory**: Where hank execution happens. Contains `.hankweave/` metadata folder and `read_only_data_source/` link to data.
- **Auto-managed executions**: Created in `~/.hankweave-executions/` with timestamp-based names
- **Explicit execution paths**: User-specified directories via `--execution <path>`

**Key files**:
- `server/index.ts` - Main entry point, CLI flow, validation mode
- `server/execution-setup.ts` - Directory creation, safety checks, data linking
- `server/config.ts` - Contains `validateHank()` function
- `server/cli-parser.ts` - CLI argument parsing (no changes needed)
- `server/data-hasher.ts` - Hash calculation for data sources (no changes needed)

**Test files**:
- `tests/unit/execution-setup.test.ts` - 598 lines of comprehensive tests for execution setup

---

## ⚠️ Lessons Learned from Trial Implementation

**IMPORTANT**: This plan was tested through a trial implementation. The trial revealed critical issues that have been addressed in the updated plan. Read this section before implementing.

### Critical Warnings

1. **Step 2 must be implemented COMPLETELY or not at all.** The trial implementation showed that partial implementation of Step 2 (just adding data hash calculation without restructuring the validation flow) results in code that passes all tests but doesn't fix the bug. The validation mode still creates directories.

2. **The Logger class creates directories automatically.** At utils.ts:40-43, the Logger constructor calls `fs.mkdirSync(logsDir, { recursive: true })`. If you create a validation logger pointing to the execution directory, it will create that directory - defeating the entire bug fix. The plan has been updated to use `os.tmpdir()` instead.

3. **Runtime testing is mandatory for Step 2.** Unit tests will NOT catch an incomplete implementation. After implementing Step 2, you MUST run:
   ```bash
   hankweave --validate --config test.json --data .
   ```
   And verify that NO directories are created in `~/.hankweave-executions/`.

### What the Trial Validated

- Step 1 (determinePaths function) is correct and can be used as-is
- Step 4 (skip config warning) is simple and clear
- Step 5 (help text) is straightforward
- All 1107 unit tests pass with changes
- The three-tier safety system is not affected

### Key Changes Made to Plan

The following corrections were made based on trial findings:

| Issue | Severity | Fix Applied |
|-------|----------|-------------|
| Step 2 showed fragments, not complete code | CRITICAL | Added complete validation branch with all necessary code |
| Validation logger would create directories | CRITICAL | Changed to use `os.tmpdir()` instead of execution path |
| Missing import for DEFAULT_CONFIG | MEDIUM | Added import statement explicitly |
| Test framework was `vitest` instead of `bun:test` | LOW | Fixed imports in Step 6 |
| Step 3 had redundant condition | LOW | Simplified to just add removal logic |

### Implementation Order (Updated)

Based on trial findings, follow this order strictly:

1. **Implement Step 1** - Safe, self-contained
2. **Implement Step 2 COMPLETELY** - All code in the validation branch
3. **STOP and runtime test** - Verify no directories created
4. **Only then proceed** - Steps 3-7 build on Step 2

---

## Decision Points Requiring Human Input

Before writing any code, walk through each of these decisions with the human. Update the plan files with their responses.

### Decision 1: Validation Mode and Model Self-Tests

**Context**: The `validateHank()` function runs self-tests for shims (model adapters), which requires API keys and makes network requests. This means validation isn't purely offline.

**Current plan recommendation**: Keep this behavior and document it. Validation is a "full preflight check," not just syntax checking.

**Ask the human**: "The validation mode currently tests actual model connectivity, which requires API keys and makes network requests. Should validation:
1. Keep current behavior (full preflight check including model tests) - **recommended**
2. Add a `--syntax-only` flag for offline validation
3. Skip model tests in validation mode entirely

The plan recommends option 1. Do you agree?"

**Action after response**: If they choose option 2 or 3, create a note in `implementation_progress_notes.md` and adjust validation block accordingly. Option 2 would require adding a new CLI flag.

### Decision 2: Warning Behavior for Data Hash Changes

**Context**: When using `--start-new --force` on an existing directory with different data, the plan recommends logging a warning about the data source change but proceeding anyway.

**Current plan recommendation**: Show warning, don't block.

**Ask the human**: "When `--start-new --force` is used with different data than the previous execution, should we:
1. Log a prominent warning and proceed - **recommended**
2. Log a warning and require explicit confirmation (unless `-y`)
3. Just proceed silently

The plan recommends option 1. Do you agree?"

**Action after response**: If they choose option 2, add confirmation prompt logic. If option 3, skip the warning logging.

### Decision 3: Test File Location

**Context**: The plan recommends creating a new test file `tests/unit/validate-mode.test.ts` for validation mode tests.

**Ask the human**: "For the new validation mode tests, should I:
1. Create a new file `tests/unit/validate-mode.test.ts` - **recommended**
2. Add tests to an existing file (if so, which one?)

The plan recommends option 1 to keep tests organized by feature. Do you agree?"

**Action after response**: Create tests in the agreed location.

### Decision 4: Help Text Detail Level

**Context**: The plan includes updated help text with multi-line descriptions for `--start-new`, `--force`, and `--validate` flags.

**Ask the human**: "The plan suggests expanding the CLI help text with detailed bullet points for each flag. Would you prefer:
1. Detailed help text as in the plan (more informative but longer output)
2. Keep current concise help text (cleaner but less informative)

Here's what the expanded version looks like:
```
--start-new               Start a new execution (don't resume existing)
                          - Creates directory if it doesn't exist
                          - Requires --force if directory has .hankweave/
--force                   Force operation in directories with existing .hankweave/
                          - Backs up existing .hankweave.backup-{timestamp}
                          - Overwrites read_only_data_source link
```

Do you prefer option 1 (detailed) or option 2 (concise)?"

**Action after response**: Implement help text according to preference.

---

## Implementation Process

### Phase 1: Core Bug Fixes

**Tasks**: Steps 1-4 from the plan
**Testing checkpoint**: Run `bun test tests/unit/execution-setup.test.ts` after each change

#### Task 1: Create `determinePaths()` Function

- **Plan section**: Step 1
- **File**: `./tadpole/server/index.ts`
- **Location**: After line 51 (after helper functions, before `main()`)
- **Scope**: Small (add ~35 lines)

This function determines what paths WOULD be used without creating any directories. It mirrors the path determination logic from `setupExecutionEnvironment()` but with zero side effects.

#### Task 2: Reorder Validation Flow

- **Plan section**: Step 2
- **File**: `./tadpole/server/index.ts`
- **Lines**: 256-382
- **Scope**: Medium (restructure existing code)

Move the validation check before `setupExecutionEnvironment()`. Wrap execution setup in `if (!validateMode) { ... }`. Update the validation block to use `determinePaths()`.

#### Task 3: Fix Data Source Overwriting

- **Plan section**: Step 3
- **File**: `./tadpole/server/execution-setup.ts`
- **Lines**: 342-376
- **Scope**: Small (modify condition, add ~10 lines)

Update the data linking condition to include `(startNew && forceMode)`. Add logic to remove existing `read_only_data_source` before creating new link.

#### Task 4: Skip Config Warning with `--start-new`

- **Plan section**: Step 4
- **File**: `./tadpole/server/execution-setup.ts`
- **Line**: 278
- **Scope**: Tiny (add `!startNew &&` to condition)

### Phase 2: Documentation and Tests

**Tasks**: Steps 5-7 from the plan
**Testing checkpoint**: Run full test suite `bun run test:unit` after completing Phase 2

#### Task 5: Update Help Text

- **Plan section**: Step 5
- **File**: `./tadpole/server/index.ts`
- **Lines**: 106-112
- **Scope**: Small (update text strings)

Update descriptions for `--start-new`, `--force`, and `--validate` flags per Decision 4 response.

#### Task 6: Add Validation Mode Tests

- **Plan section**: Step 6
- **File**: `./tadpole/tests/unit/validate-mode.test.ts` (new, per Decision 3)
- **Scope**: Medium (new test file, ~50 lines)

Test that validation mode:
- Does not create execution directories
- Works with non-existent execution paths
- Calculates data hash correctly

#### Task 7: Add Force Overwrite Test

- **Plan section**: Step 7
- **File**: `./tadpole/tests/unit/execution-setup.test.ts`
- **Scope**: Small (add one test, ~30 lines)

Test that `--start-new --force` properly removes and recreates `read_only_data_source`.

### Phase 3: Manual Testing and Verification

**Testing checkpoint**: Complete the 9-scenario manual testing checklist

After all code changes, perform these manual tests:

1. `hankweave --validate --config hank.json --data ./data` - Verify no directories created
2. `hankweave --validate --execution /nonexistent/path` - Verify works without error
3. Create execution with data-v1, then `--start-new --force` with data-v2 - Verify data-v2 is accessible
4. Run `--start-new` without `--force` on directory with `.hankweave/` - Verify error suggests `--force`
5. Run `--start-new --execution ~/.hankweave-executions` - Verify Tier 1 block works
6. Check `hankweave --help` output matches expectations

---

## Progress Tracking

Create `implementation_progress_notes.md` in the same directory as this file and update it as you go:

```markdown
# Implementation Progress Notes

## Decisions Made with Human

### Decision 1: Validation Mode and Model Self-Tests
- **Date**:
- **Choice**:
- **Notes**:

### Decision 2: Warning Behavior for Data Hash Changes
- **Date**:
- **Choice**:
- **Notes**:

### Decision 3: Test File Location
- **Date**:
- **Choice**:
- **Notes**:

### Decision 4: Help Text Detail Level
- **Date**:
- **Choice**:
- **Notes**:

## Implementation Log

### Step 1: determinePaths() Function
- **Status**:
- **Notes**:

### Step 2: Validation Flow Reorder
- **Status**:
- **Notes**:

[... continue for all steps ...]

## Problems Encountered

[Document any issues, how they were resolved]

## Deviations from Plan

[Document any changes made to the plan and why]

## Bugs Found

[Document any bugs discovered during implementation]
```

---

## Testing Strategy

### Test Execution Order

Run tests in this order to catch issues early:

1. **After each code change**: `bun test tests/unit/execution-setup.test.ts`
2. **After Phase 1**: `bun test tests/unit/execution-setup.test.ts`
3. **After Phase 2**: `bun run test:unit` (full unit test suite)
4. **After all code**: `bun run test` (includes integration and e2e)
5. **Final**: Manual testing checklist

### Critical Existing Tests to Verify

These tests in `execution-setup.test.ts` MUST still pass:
- "should create new execution in non-existent directory with --start-new"
- "should resume existing execution without --start-new"
- "should prompt for confirmation in non-empty directory"
- All three-tier safety tests

### Test Data

Use existing test fixtures in `./tadpole/tests/config/`:
- `test-codons.config.json` - Sample hank config
- `poem_guides.txt` - Sample data file

No new fixtures are needed.

---

## What NOT to Do

1. **Don't refactor beyond the bug fixes**. This is a surgical fix, not a cleanup. Resist the temptation to "improve" surrounding code.

2. **Don't break the three-tier safety system**. This is intentional, well-designed safety. Preserve it exactly.

3. **Don't skip testing**. Run tests after each change. The existing 598-line test suite will catch regressions.

4. **Don't make decisions without checking with the human first**. Walk through the Decision Points section before writing code.

5. **Don't create unnecessary markdown files**. The plan files are complete. Only create `implementation_progress_notes.md` for tracking.

6. **Don't add features**. No `--dry-run` flag, no `--syntax-only` flag unless the human explicitly requests it.

7. **Don't change the `.hankweave` naming**. The Linear ticket mentions `.strandweave` but the code uses `.hankweave`. The code is correct; the ticket uses old terminology.

8. **Don't modify cli-parser.ts or data-hasher.ts**. These files work correctly and don't need changes.

---

## Cross-Task Implications

Since this is a single task (ENG-90), there are no cross-task dependencies. However, be aware of:

**Related completed work (ENG-88)**: The three-tier safety system was implemented in ENG-88. Don't break it.

**Future considerations noted in the plan**:
- A `--dry-run` flag could be added later if users find `--validate` confusing
- A `--syntax-only` flag could be added for offline validation

These are NOT part of this implementation unless the human specifically requests them.

---

## Quick Reference: File Changes Summary

| File | Changes |
|------|---------|
| `./tadpole/server/index.ts` | Add `determinePaths()` function; wrap execution setup in `if (!validateMode)`; update validation block; update help text |
| `./tadpole/server/execution-setup.ts` | Update data linking condition (line 343); add removal logic for existing data; add `!startNew &&` to config check (line 278) |
| `./tadpole/tests/unit/execution-setup.test.ts` | Add test for `--start-new --force` data overwriting |
| `./tadpole/tests/unit/validate-mode.test.ts` (new) | Add tests for validation mode not creating directories |

---

## Final Checklist

Before declaring the implementation complete:

- [ ] All 4 Decision Points discussed with human and documented
- [ ] Step 1: `determinePaths()` function added to index.ts
- [ ] Step 2: Validation flow reordered to check before execution setup
  - [ ] **CRITICAL**: Validation branch uses `os.tmpdir()` for logger (NOT execution path)
  - [ ] **CRITICAL**: LLM registry initialized before validateHank()
  - [ ] **RUNTIME TEST**: Verified no directories created in `~/.hankweave-executions/` during validation
- [ ] Step 3: Data source overwriting fixed for `--start-new --force`
- [ ] Step 4: Config warning skipped with `--start-new`
- [ ] Step 5: Help text updated per Decision 4
- [ ] Step 6: Validation mode tests added (using `bun:test`, NOT `vitest`)
- [ ] Step 7: Force overwrite test added
- [ ] All existing tests pass (`bun run test:unit`)
- [ ] Manual testing checklist completed (9 scenarios)
- [ ] `implementation_progress_notes.md` is complete
- [ ] Human has signed off on the implementation

---

## Questions to Ask If Stuck

If you encounter issues not covered in this guide:

1. Check `./plans/supporting-docs/` for additional context on decisions
2. Look at the Linear tickets: [ENG-90](https://linear.app/southbridge/issue/ENG-90) and [ENG-88](https://linear.app/southbridge/issue/ENG-88)
3. The existing test suite (`execution-setup.test.ts`) demonstrates expected behaviors
4. Ask the human for clarification before making assumptions

---

*This handoff document was generated as part of the ENG-90 planning process. The implementation plan is fully self-contained in `final-standalone-1-fixing-execution-directory-behavior.md`.*
