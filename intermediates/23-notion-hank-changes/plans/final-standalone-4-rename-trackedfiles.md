# ENG-92: Rename trackedFiles to checkpointedFiles

> **Implementation Order:** Phase 1 (first, independent) - See [00-index.md](00-index.md) for full context

## Related Plans

This task is independent and can be implemented first:

- No dependencies on other tasks in this batch
- Should be completed before README documentation updates from other tasks to avoid merge conflicts

## Task Summary

Rename the `trackedFiles` field in codon configurations to `checkpointedFiles` to better communicate its purpose. The current name is ambiguous and could imply Git tracking or file watching, when the actual purpose is to specify which files should be included in the shadow Git checkpoint system between codons.

**Original Request (Hrishi Olickel):**
> "Simple - makes it more obvious to humans (like me) and AIs"

## Sources and Context

### Linear Ticket
- **Identifier:** ENG-92
- **Status:** In Progress
- **Priority:** Medium
- **Labels:** Minor
- **Created:** 2025-12-18

### Original Planning Documents
The following documents were synthesized by the Step 4 Agent to create this plan:
- [`supporting-docs/4-rename-trackedfiles-full-task.md`](supporting-docs/4-rename-trackedfiles-full-task.md) - Original task with Step 1/2/3 agent analysis
- [`supporting-docs/4-rename-trackedfiles-related-code.md`](supporting-docs/4-rename-trackedfiles-related-code.md) - Codebase integration points
- [`supporting-docs/4-rename-trackedfiles-changes-decisions-and-judgement-calls.md`](supporting-docs/4-rename-trackedfiles-changes-decisions-and-judgement-calls.md) - Technical decisions

### Current Usage in Codebase

The Step 2 Agent identified `trackedFiles` usage in these files:

| File | Location | Purpose |
|------|----------|---------|
| `server/config.ts` | Lines 295-300 | Schema definition |
| `server/config.ts` | Lines 1469-1473, 1522-1524 | Validation logic |
| `server/hankweave-runtime.ts` | Lines 134, 1733-1738 | Watched patterns |
| `server/hankweave-runtime.ts` | Lines 1609-1624 | Checkpoint pattern accumulation |
| `server/hankweave-runtime.ts` | Lines 1742-1792 | Initial file state capture |
| `server/types/types.ts` | Type definitions | TypeScript interface |
| `server/checkpoint-git.ts` | Line 152 | Receives patterns as parameter |
| `server/file-resolver.ts` | Various | Gitignore-aware resolution |

### Why the Current Name Is Problematic

The Step 1 Agent identified several issues with "trackedFiles":

1. **Git confusion:** In Git terminology, "tracked" means files under version control. Users may think these are files already tracked by their project's main Git repository.

2. **Monitoring confusion:** "Tracked" could imply real-time file watching, which is only part of what this feature does.

3. **Unclear purpose:** It doesn't communicate that these files will be checkpointed between phases.

4. **AI confusion:** LLMs reading hank configurations don't get strong semantic clues about the field's purpose.

### Why "checkpointedFiles" Is Better

1. **Explicit purpose:** "Checkpointed" directly describes what happens to these files.
2. **Mental model alignment:** It reinforces the "save game" mental model from the README.
3. **Action-oriented:** The past participle form suggests these files undergo an action.
4. **Unambiguous:** No other common meaning for "checkpointed" in this context.

## Decision Points and Judgement Calls

### Decision 1: Use `checkpointedFiles` as the New Name

**The Step 4 Agent recommends:** Rename to `checkpointedFiles` (not `checkpointFiles`).

**Alternative rejected:** `checkpointFiles`
- Reasoning: Could be confused with "files that ARE checkpoints" vs "files TO checkpoint"

### Decision 2: Support Both Names During Deprecation Period

**The Step 4 Agent recommends:** Accept both `trackedFiles` (deprecated) and `checkpointedFiles`, with automatic migration and warnings.

**Implementation approach:**
1. Add `checkpointedFiles` as the primary field
2. Keep `trackedFiles` as a deprecated alias
3. Auto-migrate `trackedFiles` to `checkpointedFiles` during schema parsing
4. Emit deprecation warning when old name is used
5. Error if both names are specified simultaneously

### Decision 3: Deprecation Timeline

**Phase 1 (Current release):** Support both, warn on old name
**Phase 2 (Next release):** Support both, louder/more prominent warning
**Phase 3 (2-3 releases later):** Remove old name (breaking change)

### Decision 4: Update Schema Description

**The Step 4 Agent recommends:** Rewrite the schema description to emphasize checkpointing, not just watching.

**Current description:**
> "Glob patterns for files to track during codon execution. These files will be: watched for changes and streamed to the client, tracked in the git-based checkpoint system, and resolved using gitignore rules for consistency."

**New description:**
> "Glob patterns for files to checkpoint. These files are saved in Git checkpoints after each codon completes, enabling rollback to previous states. Files are also watched for changes and resolved using gitignore rules."

## Implementation Plan

### Step 1: Update Schema Definition

**File: `server/config.ts` (around line 295)**

**Before:**
```typescript
trackedFiles: z
  .array(z.string())
  .optional()
  .describe("Glob patterns for files to track during codon execution..."),
```

**After:**
```typescript
checkpointedFiles: z
  .array(z.string())
  .optional()
  .describe(
    "Glob patterns for files to checkpoint. These files are saved in Git " +
    "checkpoints after each codon completes, enabling rollback to previous states. " +
    "Files are also watched for changes and resolved using gitignore rules."
  ),
trackedFiles: z
  .array(z.string())
  .optional()
  .describe("DEPRECATED: Use checkpointedFiles instead."),
```

### Step 2: Add Migration Transform

**File: `server/config.ts`**

Add a Zod transform to auto-migrate:

```typescript
const codonObjectSchema = z.object({
  // ... existing fields ...
  checkpointedFiles: z.array(z.string()).optional(),
  trackedFiles: z.array(z.string()).optional(),
})
.transform((data) => {
  // Auto-migrate trackedFiles to checkpointedFiles
  if (data.trackedFiles && !data.checkpointedFiles) {
    data.checkpointedFiles = data.trackedFiles;
    delete data.trackedFiles;  // Remove deprecated field
  }
  return data;
})
.refine((data) => {
  // Error if both specified
  if (data.trackedFiles && data.checkpointedFiles) {
    return false;
  }
  return true;
}, {
  message: "Cannot specify both trackedFiles (deprecated) and checkpointedFiles. Use checkpointedFiles only.",
});
```

### Step 3: Add Deprecation Warning

**File: `server/config.ts` or `server/hankweave-runtime.ts`**

During config loading or codon start:

```typescript
function checkDeprecatedFields(codon: CodonConfig, logger: Logger): void {
  // Check for deprecated trackedFiles usage
  // Note: By this point, trackedFiles has been migrated to checkpointedFiles,
  // so we need to check the raw config before transform
}

// Or during validation:
if (rawCodon.trackedFiles) {
  warnings.push(
    `Codon "${codon.name || codon.id}": "trackedFiles" is deprecated. ` +
    `Please update to "checkpointedFiles" for clarity.`
  );
}
```

### Step 4: Update Runtime Code

**File: `server/hankweave-runtime.ts`**

Change all references from `trackedFiles` to `checkpointedFiles`:

**Line 134 area:**
```typescript
// Before:
private watchedPatterns: string[] = [];

// After (no change needed, but associated code changes):
if (codon.checkpointedFiles && codon.checkpointedFiles.length > 0) {
  this.watchedPatterns = codon.checkpointedFiles;
  this.logger.log(`Checkpointed patterns: ${this.watchedPatterns.join(", ")}`);
}
```

**Lines 1609-1624:**
```typescript
// Change all instances of codonConfig.trackedFiles to codonConfig.checkpointedFiles
if (
  codonConfig.type !== "loop" &&
  codonConfig.checkpointedFiles &&
  codonConfig.checkpointedFiles.length > 0
) {
  await this.addCheckpointPatterns(codonConfig.checkpointedFiles);
}
```

### Step 5: Update TypeScript Types

**File: `server/types/types.ts`**

```typescript
export interface CodonConfig {
  // ... existing fields ...

  /** Files to checkpoint after codon completion */
  checkpointedFiles?: string[];

  /** @deprecated Use checkpointedFiles instead */
  trackedFiles?: string[];
}
```

### Step 6: Update Validation Code

**File: `server/config.ts` (around lines 1469, 1522)**

```typescript
// Before:
if (codon.trackedFiles && codon.trackedFiles.length > 0) {
  result.trackingCodonCount++;
  result.checkpointCodonCount++;
}

// After:
if (codon.checkpointedFiles && codon.checkpointedFiles.length > 0) {
  result.trackingCodonCount++;
  result.checkpointCodonCount++;
}
```

### Step 7: Update Documentation

**README.md** - Update all examples:

**Before:**
```json
{
  "id": "phase-1-analysis",
  "name": "Analyze Codebase",
  "trackedFiles": ["analysis.md"]
}
```

**After:**
```json
{
  "id": "phase-1-analysis",
  "name": "Analyze Codebase",
  "checkpointedFiles": ["analysis.md"]
}
```

### Step 8: Update Tests

Search for all test files containing `trackedFiles` and update to `checkpointedFiles`. Also add deprecation warning tests.

### Step 9: Update Init Template

**File: `server/init-command.ts`**

Update the template hank.json to use `checkpointedFiles`.

## Code Integration Points

### Primary: `server/config.ts`

- Schema definition (lines 295-300)
- Validation logic (lines 1469-1473, 1522-1524)
- Migration transform (new code)

### Secondary: `server/hankweave-runtime.ts`

- Watched patterns initialization (lines 1733-1738)
- Checkpoint pattern accumulation (lines 1609-1624)
- Initial file state capture (lines 1742-1792)

### Type Definitions: `server/types/types.ts`

- CodonConfig interface

### Documentation: `README.md`

- Multiple example hanks

## Testing Strategy

This is primarily a schema migration with backward compatibility. Testing should focus on the migration logic, deprecation warnings, and ensuring the new field name works identically to the old one.

### Unit Tests (tests/unit/checkpointed-files-migration.test.ts)

Focus on schema migration and validation:

```typescript
describe("Schema Migration", () => {
  test("migrates trackedFiles to checkpointedFiles", () => {
    const oldConfig = {
      id: 'test-codon',
      name: 'Test',
      model: 'sonnet',
      continuationMode: 'fresh',
      promptText: 'test',
      trackedFiles: ['*.md', 'src/**/*.ts'],
    };

    const parsed = codonSchema.parse(oldConfig);
    expect(parsed.checkpointedFiles).toEqual(['*.md', 'src/**/*.ts']);
    expect(parsed.trackedFiles).toBeUndefined(); // Should be removed after migration
  });

  test("accepts new field name directly", () => {
    const newConfig = {
      id: 'test-codon',
      name: 'Test',
      model: 'sonnet',
      continuationMode: 'fresh',
      promptText: 'test',
      checkpointedFiles: ['*.md'],
    };

    const parsed = codonSchema.parse(newConfig);
    expect(parsed.checkpointedFiles).toEqual(['*.md']);
  });

  test("rejects config with both field names", () => {
    const badConfig = {
      id: 'test-codon',
      name: 'Test',
      model: 'sonnet',
      continuationMode: 'fresh',
      promptText: 'test',
      trackedFiles: ['*.md'],
      checkpointedFiles: ['*.ts'],
    };

    expect(() => codonSchema.parse(badConfig))
      .toThrow(/Cannot specify both trackedFiles.*and checkpointedFiles/);
  });

  test("handles undefined trackedFiles gracefully", () => {
    const config = {
      id: 'test-codon',
      name: 'Test',
      model: 'sonnet',
      continuationMode: 'fresh',
      promptText: 'test',
      // No trackedFiles or checkpointedFiles
    };

    const parsed = codonSchema.parse(config);
    expect(parsed.checkpointedFiles).toBeUndefined();
    expect(parsed.trackedFiles).toBeUndefined();
  });

  test("migration preserves array structure", () => {
    const config = {
      id: 'test-codon',
      name: 'Test',
      model: 'sonnet',
      continuationMode: 'fresh',
      promptText: 'test',
      trackedFiles: [], // Empty array
    };

    const parsed = codonSchema.parse(config);
    expect(parsed.checkpointedFiles).toEqual([]);
  });
});
```

**Rationale:** Schema migration is the core functionality. These tests ensure the Zod transform works correctly for all scenarios: old name only, new name only, both names (error), neither name.

### Integration Tests (tests/integration/checkpointed-files-behavior.test.ts)

Verify the new field name works identically to the old one:

```typescript
describe("Checkpointed Files Behavior", () => {
  test("checkpointedFiles patterns work for file watching", async () => {
    const hank = createTestHank({
      codons: [{
        id: 'test',
        promptText: 'Create a test file',
        checkpointedFiles: ['*.md', 'results/**'],
      }],
    });

    const result = await runHank(hank);

    // Files matching patterns should be tracked
    expect(result.watchedPatterns).toContain('*.md');
    expect(result.watchedPatterns).toContain('results/**');
  });

  test("checkpointedFiles patterns work for git checkpoints", async () => {
    const hank = createTestHank({
      codons: [{
        id: 'create-files',
        promptText: 'Create test.md and result.txt',
        checkpointedFiles: ['*.md'],
      }],
    });

    const result = await runHank(hank);

    // Check git history
    const commits = await getGitCommits(result.executionPath);
    const lastCommit = commits[0];
    const files = await getCommitFiles(result.executionPath, lastCommit);

    // test.md should be checkpointed, result.txt should not
    expect(files).toContain('test.md');
    expect(files).not.toContain('result.txt');
  });

  test("backward compatibility: trackedFiles still works", async () => {
    // Even though we migrate internally, verify it works end-to-end
    const hankJson = {
      hank: [{
        id: 'test',
        name: 'Test',
        model: 'sonnet',
        continuationMode: 'fresh',
        promptText: 'Create a test file',
        trackedFiles: ['*.md'], // Old name
      }],
    };

    const result = await runHank(hankJson);

    // Should work identically
    expect(result.watchedPatterns).toContain('*.md');
  });
});
```

**Rationale:** These tests verify that the renamed field actually does what it's supposed to do in the runtime. The schema migration could work correctly but fail to connect to the runtime code.

### Integration Tests: Deprecation Warning

```typescript
describe("Deprecation Warning", () => {
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  test("warns when loading hank with trackedFiles", async () => {
    const hankPath = path.join(TEST_DIR, 'old-hank.json');
    fs.writeFileSync(hankPath, JSON.stringify({
      hank: [{
        id: 'test',
        name: 'Test',
        model: 'sonnet',
        continuationMode: 'fresh',
        promptText: 'test',
        trackedFiles: ['*.md'],
      }],
    }));

    await loadHankFile(hankPath);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('trackedFiles" is deprecated')
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('checkpointedFiles')
    );
  });

  test("does not warn when using checkpointedFiles", async () => {
    const hankPath = path.join(TEST_DIR, 'new-hank.json');
    fs.writeFileSync(hankPath, JSON.stringify({
      hank: [{
        id: 'test',
        name: 'Test',
        model: 'sonnet',
        continuationMode: 'fresh',
        promptText: 'test',
        checkpointedFiles: ['*.md'],
      }],
    }));

    await loadHankFile(hankPath);

    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });
});
```

**Rationale:** Deprecation warnings guide users to migrate. These tests ensure warnings appear at the right time with clear messaging.

### E2E Test: Attach to Existing Suite

Since this is a rename, no new E2E tests needed. The existing checkpoint tests already verify the behavior. Simply ensure they pass after the rename.

If needed, add a simple smoke test:

```typescript
// In tests/e2e/happy-path-e2e.test.ts

test("checkpointedFiles field works in E2E flow", async () => {
  const hank = {
    hank: [{
      id: 'test',
      name: 'Test',
      model: 'sonnet',
      continuationMode: 'fresh',
      promptText: 'Create result.md with content "success"',
      checkpointedFiles: ['result.md'],
      outputFiles: [{ copy: ['result.md'] }],
    }],
  };

  const result = await startServer({ config: hank, data: TEST_DATA_DIR, args: ['--start-new'] });

  expect(result.success).toBe(true);
  // Verify file was created and checkpointed
  const resultFile = path.join(result.executionPath, 'hankweave-results', 'result.md');
  expect(fs.existsSync(resultFile)).toBe(true);
});
```

**Rationale:** One E2E test confirms the end-to-end flow works with the new name. Existing checkpoint tests already cover the functionality extensively.

### Documentation Update Test

Verify that documentation examples use the new field name:

```typescript
test("README examples use checkpointedFiles", () => {
  const readme = fs.readFileSync('README.md', 'utf-8');

  // Should use new name
  expect(readme).toContain('checkpointedFiles');

  // Should not use old name in examples
  const exampleMatches = readme.match(/```json[\s\S]*?```/g) || [];
  const jsonExamples = exampleMatches.join('\n');
  expect(jsonExamples).not.toContain('trackedFiles');
});
```

**Rationale:** Documentation should show the current best practice. This test ensures examples are updated.

## Files to Modify (Complete List)

1. `server/config.ts` - Schema, validation, migration
2. `server/hankweave-runtime.ts` - Runtime usage
3. `server/types/types.ts` - TypeScript interface
4. `server/init-command.ts` - Template hank
5. `README.md` - Documentation examples
6. All test files with `trackedFiles` references
7. Any example hanks in the repository

## Complexity Assessment

**Overall complexity:** Low

**Breakdown:**
- Schema updates with migration: ~30 lines
- Runtime code updates: ~20 lines (find-and-replace)
- Deprecation warning logic: ~10 lines
- TypeScript type updates: ~5 lines
- Documentation updates: ~30 minutes
- Test updates: ~1 hour

**Total:** 4-6 hours

## Risk Mitigation

### Risk 1: Breaking Existing Hanks
**Mitigation:** Automatic migration in schema transform. Old field name continues to work with warning.

### Risk 2: Missing Some References
**Mitigation:** Use IDE "Find All References" or grep for `trackedFiles` to ensure all occurrences are found.

### Risk 3: Test Failures
**Mitigation:** Update tests before runtime code changes. Add migration tests first.

## Dependencies

**No new dependencies.** This is purely a renaming operation using existing Zod transform functionality.

## Backward Compatibility

Full backward compatibility maintained during deprecation period:

- Hanks using `trackedFiles` continue to work
- Auto-migration happens transparently
- Warning message guides users to update
- Both names never accepted simultaneously (prevents confusion)
- Clear removal timeline documented in changelog

## CHANGELOG Entry

```markdown
### Changed

- Renamed `trackedFiles` to `checkpointedFiles` in codon configuration
  - The old name `trackedFiles` is now deprecated but still supported
  - Automatic migration converts `trackedFiles` to `checkpointedFiles`
  - A deprecation warning is shown when the old name is used
  - The new name better reflects the field's purpose: files saved in Git checkpoints for rollback
```

---

## Testing Requirements and Affected Tests

This section documents all existing tests that need to be updated when implementing this change, as well as regression testing requirements.

### Tests That Must Be Updated (Required Changes)

These tests currently use `trackedFiles` and must be updated to use `checkpointedFiles`:

#### Unit Tests

1. **tests/unit/config.test.ts**
   - Update all test fixtures that use `trackedFiles` to use `checkpointedFiles`
   - Verify the schema accepts both old and new field names
   - **Lines affected:** Search for `trackedFiles` in test fixtures
   - **Action:** Update test hank configurations to use new field name

2. **tests/unit/file-resolver.test.ts**
   - Update any test cases that reference `trackedFiles` in codon configs
   - **Action:** Update test fixtures with new field name

3. **tests/unit/checkpoint-git.test.ts**
   - Update tests that verify checkpoint patterns from `trackedFiles`
   - **Action:** Change field references in test setup

#### Integration Tests

4. **tests/integration/config-resolution.test.ts**
   - Update test hanks that include `trackedFiles` configurations
   - **Action:** Update test fixtures

5. **tests/integration/sentinel-*.test.ts** (multiple files)
   - Several sentinel tests use codon configs with `trackedFiles`
   - **Files to check:**
     - `sentinel-hankweave-integration.test.ts`
     - `sentinel-output-files.test.ts`
     - `sentinel-structured-output.test.ts`
   - **Action:** Search each file for `trackedFiles` and update

#### E2E Tests

6. **tests/e2e/happy-path-e2e.test.ts**
   - The main E2E test suite uses hank configurations with `trackedFiles`
   - **Specific test groups affected:**
     - Checkpoint system tests
     - File watching tests
     - File content tests
   - **Action:** Update hank configs in test setup

7. **tests/e2e/rollback-comprehensive-e2e.test.ts**
   - Rollback tests rely heavily on tracked file patterns
   - **Action:** Update all hank configurations

8. **tests/e2e/sentinel-*.test.ts**
   - E2E sentinel tests use hanks with `trackedFiles`
   - **Action:** Update hank configs

#### Test Configuration Files

9. **tests/config/*.config.json**
   - Test hank configuration files in the config directory
   - **Files to update:**
     - `test-codons.config.json`
     - `test-codons-with-loop.config.json`
     - `test-codons-with-loop-rig-setup.config.json`
     - `test-context-exhaustion.config.json`
   - **Action:** Replace `trackedFiles` with `checkpointedFiles` in JSON

10. **tests/config/sentinel-triggers/*.sentinel.json**
    - Sentinel configuration examples may reference the field
    - **Action:** Check and update if needed

### New Tests To Add (Test the New Feature)

These tests should be added as described in the Testing Strategy section of the plan:

1. **tests/unit/checkpointed-files-migration.test.ts** (NEW FILE)
   - Test schema migration from `trackedFiles` to `checkpointedFiles`
   - Test rejection of configs with both fields
   - Test handling of undefined fields
   - **Status:** Must be created
   - **Coverage:** Schema transformation, validation, error handling

2. **tests/integration/checkpointed-files-behavior.test.ts** (NEW FILE)
   - Test that `checkpointedFiles` works identically to old `trackedFiles`
   - Test file watching with new field name
   - Test git checkpointing with new field name
   - Test backward compatibility
   - **Status:** Must be created
   - **Coverage:** Runtime behavior, backward compatibility

3. **Deprecation warning tests** (add to existing integration tests)
   - Test that warnings appear when loading hanks with `trackedFiles`
   - Test that no warnings appear with `checkpointedFiles`
   - **Location:** Add to existing integration test file or config-resolution.test.ts
   - **Coverage:** Warning system, user guidance

### Regression Tests (Critical - Must Pass)

After implementing the rename, these existing test suites must continue to pass without modification:

1. **Checkpoint System Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Ensures checkpointing still works after rename
   - **Test groups:** `runCheckpointSystemTests`, `runCheckpointExclusionTests`
   - **Critical:** These tests verify the core functionality hasn't broken

2. **File Watching Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Ensures file watching patterns still work
   - **Test group:** `runFileWatchingTests`, `runFileWatchingNegativeTests`
   - **Critical:** Watched patterns must continue to function

3. **File System Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Ensures file operations work with new field name
   - **Test groups:** `runFileSystemTests`, `runFileSystemEdgeCasesTests`

4. **Rollback Tests** (tests/e2e/rollback-comprehensive-e2e.test.ts)
   - Ensures rollback functionality still works
   - **Critical:** Rollback depends on tracked/checkpointed files

5. **State Consistency Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Ensures state tracking continues to work
   - **Test group:** `runStateConsistencyTests`

### CI/CD Pipeline Considerations

The CI/CD pipeline runs these test stages (from `.github/workflows/ci.yml`):

1. **Lint and Type Check** (Job: `lint-and-typecheck`)
   - `bun run lint` - Should pass after updating field names
   - `bun run tc` - Type checking should pass after updating TypeScript interfaces
   - **Action:** Run `bun tc` locally before committing

2. **Unit & Integration Tests** (Job: `tests`)
   - `bun test tests/unit` - All unit tests must pass
   - `bun test tests/integration` - All integration tests must pass
   - **Action:** Ensure all updated tests pass locally

3. **Init E2E Tests** (Jobs: `init-e2e-*`)
   - `bun run test:e2e:init` - Tests the --init command
   - Init command creates template with `trackedFiles` - **must update template**
   - **Files affected:** `server/init-command.ts` template generation
   - **Action:** Update template to use `checkpointedFiles`

4. **Standard Test Suite** (via `bun test`)
   - Includes `tests/e2e/happy-path-e2e.test.ts` and `tests/e2e/rollback-improved-1-e2e.test.ts`
   - **Action:** Both must pass with updated field names

### Test Execution Checklist

Before considering this implementation complete, execute tests in this order:

```bash
# 1. Type check
bun run tc

# 2. Linting
bun run lint:fix

# 3. Unit tests (fast feedback)
bun test tests/unit/checkpointed-files-migration.test.ts  # New test
bun test tests/unit/config.test.ts  # Updated test
bun test tests/unit  # All unit tests

# 4. Integration tests
bun test tests/integration/checkpointed-files-behavior.test.ts  # New test
bun test tests/integration  # All integration tests

# 5. E2E tests (expensive - run last)
bun test tests/e2e/happy-path-e2e.test.ts  # Main E2E suite
bun test tests/e2e/rollback-comprehensive-e2e.test.ts  # Rollback suite

# 6. Init command test
bun run test:e2e:init  # Verify template uses new field
```

### Documentation Test

Verify README examples use the new field name:

```bash
# Check that README examples have been updated
grep -n "trackedFiles" README.md  # Should return no matches in code examples
grep -n "checkpointedFiles" README.md  # Should find examples
```

### Search Commands for Implementation

Use these commands to find all occurrences that need updating:

```bash
# Find all uses of trackedFiles in test files
grep -r "trackedFiles" tests/ --include="*.ts" --include="*.json"

# Find all uses in test config files
find tests/config -name "*.json" -exec grep -l "trackedFiles" {} \;

# Find all uses in server code
grep -r "trackedFiles" server/ --include="*.ts"

# Verify no uses remain after changes (should return nothing)
grep -r "trackedFiles" tests/ server/ README.md --include="*.ts" --include="*.json" --include="*.md"
```

### Summary of Test Impact

| Test Type | Files to Update | New Files | Total Tests Affected |
|-----------|----------------|-----------|---------------------|
| Unit Tests | 3 files | 1 new file | ~15-20 test cases |
| Integration Tests | 4-6 files | 1 new file | ~10-15 test cases |
| E2E Tests | 3-4 files | 0 | Multiple test groups |
| Config Files | 10+ JSON files | 0 | All test hanks |
| Total | ~20 files | 2 new files | ~50+ test cases |

**Estimated Time for Test Updates:** 1-2 hours
**Estimated Time for New Tests:** 1 hour
**Total Testing Effort:** 2-3 hours

This is a schema migration that touches many tests. The key is systematic updating - use search/replace carefully and verify each test passes incrementally.
