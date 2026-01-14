# Changes & Decisions: Fixing Execution Directory Behavior

## From Step 3 Agent

Research confirms that the proposed dry-run approach aligns with industry best practices from Kubernetes, AWS CLI, and other mature CLI tools. The key insight from Kubernetes' server-side dry-run KEP is that proper dry-run implementation requires factoring the "do it" logic to avoid "if dry-run / else" soup. The current plan to create a separate determinePaths() function follows this pattern perfectly. Research also validated the current approach of using fs.promises.rm() with { recursive: true, force: true } for safe deletion when overwriting read_only_data_source links, though we should be cautious with force: true and add appropriate logging. The existing symlink-with-fallback-to-copy pattern matches real-world packages like symlink-or-copy and copy-concurrently, confirming this is a robust cross-platform approach. No external libraries are needed - the current implementation choices are sound.

## From Step 2 Agent

After thoroughly exploring the codebase, the necessary changes are more focused than initially thought. The main issue is that setupExecutionEnvironment() is called before the validateMode check in index.ts, causing directory creation during validation runs. The existing three-tier safety system is working correctly - the Linear ticket's complaint about "--start-new fails if directory exists" is actually the Tier 2 safety working as intended (requiring --force for directories with existing .hankweave/). The only genuine bugs are: (1) validation mode creates directories unnecessarily, and (2) --start-new --force doesn't properly overwrite the read_only_data_source link when reusing a directory. My recommendation is to implement a lightweight dry-run function rather than making setupExecutionEnvironment() itself conditional, as this preserves the clean separation of concerns and makes the code more testable.

## Research Findings (Step 3)

### CLI Dry-Run Validation Patterns

**Source**: [Kubernetes Enhancement Proposal - Dry Run](https://github.com/kubernetes/enhancements/blob/master/keps/sig-api-machinery/576-dry-run/README.md)

**Key insight**: The Kubernetes dry-run KEP emphasizes that the underlying "do it" logic really needs to be factored properly for individual side effects, otherwise you end up with loads of "if dry-run / else" soup or worse, bugs caused by dry-run support. The goal is to send requests to modifying endpoints and see if the request would have succeeded without having it actually happen, with the response body as close as possible to a non dry-run response.

**Relevance**: This validates our approach of creating a separate determinePaths() function rather than adding conditional logic throughout setupExecutionEnvironment(). The determinePaths() function simulates what would happen without side effects, matching the Kubernetes design pattern.

**Additional source**: [AWS CLI Dry-Run](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-help.html) - AWS uses --dry-run to check permissions without making requests, demonstrating that validation without side effects is an industry standard pattern.

### Safe Directory Deletion in Node.js

**Source**: [Node.js fs.promises.rm() Documentation](https://nodejs.org/api/fs.html)

**Key insight**: The fs.promises.rm() method supports { recursive: true, force: true } options for safe deletion. The recursive option is required for deleting directories with contents, while force prevents errors if the path doesn't exist. Additional options include maxRetries and retryDelay for handling transient filesystem errors (EBUSY, EMFILE, ENFILE, ENOTEMPTY, EPERM).

**Relevance**: The current plan to use `await fs.promises.rm(dataPathInExecutionDir, { recursive: true, force: true })` when overwriting read_only_data_source is correct and follows Node.js best practices. However, we should note that force: true should be used carefully and with appropriate logging to prevent silent data loss.

**Additional consideration**: For atomic file operations, the [write-file-atomic](https://www.npmjs.com/package/write-file-atomic) package provides write-to-temporary-then-rename pattern, though this is more relevant for file writes than directory operations. Our use case of removing and recreating symlinks/directories doesn't require this pattern.

### Symlink vs Copy Performance and Cross-Platform Handling

**Source**: [symlink-or-copy npm package](https://www.npmjs.com/package/symlink-or-copy)

**Key insight**: Symlinks provide significantly better performance than copying for data directories, as they create a reference rather than duplicating content. This saves both disk space and I/O operations. However, symlinks on Windows require special rights, so the standard pattern is to attempt symlinking and fall back to copying if it fails.

**Relevance**: The existing code already implements this pattern correctly at execution-setup.ts:357-375, attempting symlink first and falling back to copy on failure. This matches the symlink-or-copy package approach and is considered best practice.

**Cross-platform considerations**: From [copy-concurrently](https://www.npmjs.com/package/copy-concurrently), on Windows, if symlinking a directory fails, junctions are tried as an alternative. The current implementation's fallback to full copy is more conservative but works reliably across all platforms.

**Performance note**: Using symlinks means "modules no longer need to be physically copied and duplicated wherever they're used on a given machine", which is exactly the behavior we want for read-only data sources.

## Required Changes

### Change 1: Fix Validation Mode to Not Create Directories

**File**: `server/index.ts`
**Lines**: 256-382

**Current flow:**
```
Parse CLI → Setup execution environment → Check validateMode → Run validation
                  ↑ Creates directories!
```

**Desired flow:**
```
Parse CLI → Check validateMode → Run validation without directories
         OR
Parse CLI → Setup execution environment → Run server
```

**Specific implementation:**

Add a new function `determinePaths()` that simulates setupExecutionEnvironment() without side effects:

```typescript
interface PathsForValidation {
  executionPath: string;        // Where execution would happen
  dataPathInExecutionDir: string;
  configPath: string;
}

function determinePaths(options: {
  readOnlySourceDataPath: string;
  executionPath?: string;
  startNew?: boolean;
  dataHash: string;
}): PathsForValidation {
  // Logic to determine what paths WOULD be used
  // without creating any directories or files

  if (options.executionPath) {
    // Would use explicit path
    return {
      executionPath: options.executionPath,
      dataPathInExecutionDir: path.join(options.executionPath, "read_only_data_source"),
      configPath: options.executionPath, // For relative path resolution
    };
  } else if (options.startNew) {
    // Would create new auto-managed directory
    const executionRoot = path.join(os.homedir(), ".hankweave-executions");
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6);
    const dirName = `${timestamp}-${random}-${options.dataHash.substring(0, 6)}`;
    const execPath = path.join(executionRoot, dirName);
    return {
      executionPath: execPath,
      dataPathInExecutionDir: path.join(execPath, "read_only_data_source"),
      configPath: execPath,
    };
  } else {
    // Would find existing or create new
    // For validation, just use a hypothetical path
    const executionRoot = path.join(os.homedir(), ".hankweave-executions");
    const dirName = `validation-${options.dataHash.substring(0, 6)}`;
    const execPath = path.join(executionRoot, dirName);
    return {
      executionPath: execPath,
      dataPathInExecutionDir: path.join(execPath, "read_only_data_source"),
      configPath: execPath,
    };
  }
}
```

**Changes to index.ts:**

```typescript
// After line 254 (config path resolution)
// Add data hash calculation for validation mode
let dataHash: string | undefined;
if (validateMode) {
  console.log("Calculating data signature for validation...");
  const { hashDataSource } = await import("./data-hasher.js");
  dataHash = await hashDataSource(resolvedDataPath, DEFAULT_CONFIG.dataHashTimeLimit);
}

// Lines 256-272: Wrap in if (!validateMode)
let executionSetup: ExecutionSetup;
if (!validateMode) {
  try {
    executionSetup = await setupExecutionEnvironment({
      readOnlySourceDataPath: resolvedDataPath,
      executionPath: executionPath ? path.resolve(executionPath) : undefined,
      useSymlink: inputSourceType === "path" ? useSymlink : false,
      startNew,
      forceMode,
      skipConfirmation,
      hankPath: absoluteConfigPath,
    });
  } catch (error) {
    console.error(`❌ Execution setup failed: ${(error as Error).message}`);
    process.exit(1);
  }

  // These outputs only make sense in non-validation mode
  if (inputSourceType !== "path") {
    console.log(`📥 Input type: ${inputSourceType}`);
  }
  console.log(`📁 Data source: ${executionSetup.readOnlySourceDataPath}`);
  console.log(`🏃 Execution: ${executionSetup.executionPath}`);
  console.log(`🔗 Link type: ${executionSetup.linkType}`);

  // Change to execution directory for server operation
  process.chdir(executionSetup.executionPath);
}

// Lines 325-382: Update validation block
if (validateMode) {
  console.log(`\n🔍 Validating configuration: ${absoluteConfigPath}\n`);

  // Determine paths without creating anything
  const paths = determinePaths({
    readOnlySourceDataPath: resolvedDataPath,
    executionPath: executionPath ? path.resolve(executionPath) : undefined,
    startNew,
    dataHash: dataHash!, // We calculated this above
  });

  console.log(`📁 Data source: ${resolvedDataPath}`);
  console.log(`🏃 Would execute in: ${paths.executionPath}`);

  const validationResult = await validateHank(
    absoluteConfigPath,
    paths.executionPath, // Use determined path, not created path
    validationLogger,
  );

  // ... rest of validation output ...
  process.exit(0);
}
```

**Location to add determinePaths()**: After the helper functions (after line 51, before main())

**Lines to modify**:
- Line 256: Add `if (!validateMode) {` before setupExecutionEnvironment
- Line 272: Add closing `}` and console.log wrapping
- Line 284: Wrap `process.chdir()` in the same if block
- Line 327-382: Rewrite validation block to use determinePaths()

### Change 2: Fix read_only_data_source Overwriting with --start-new --force

**File**: `server/execution-setup.ts`
**Lines**: 342-376

**Current code:**
```typescript
let linkType: "symlink" | "copy" = useSymlink ? "symlink" : "copy";
if (isNewExecution || !fs.existsSync(dataPathInExecutionDir)) {
  // Create symlink or copy
  // ...
}
```

**Problem**: When using `--start-new --force` on a directory with existing `.hankweave/`, the old `read_only_data_source` isn't removed. The condition `!fs.existsSync(dataPathInExecutionDir)` is false, so no new link is created.

**Fix:**

```typescript
let linkType: "symlink" | "copy" = useSymlink ? "symlink" : "copy";

// Determine if we need to create/recreate data access
const needsDataSetup =
  isNewExecution ||
  !fs.existsSync(dataPathInExecutionDir) ||
  (startNew && forceMode); // Also recreate when force-starting in existing dir

if (needsDataSetup) {
  // Remove existing read_only_data_source if present (for --start-new --force case)
  if (fs.existsSync(dataPathInExecutionDir)) {
    console.log(`🗑️  Removing existing data link: ${dataPathInExecutionDir}`);
    await fs.promises.rm(dataPathInExecutionDir, {
      recursive: true,
      force: true,
      maxRetries: 3,  // Retry on transient errors (EBUSY, etc.)
      retryDelay: 100 // Wait 100ms between retries
    });
  }

  if (stats.isDirectory()) {
    // ... existing directory logic ...
  } else if (stats.isFile()) {
    // ... existing file logic ...
  }
}
```

**Lines to modify**:
- Line 342-343: Update condition to include `(startNew && forceMode)`
- After line 343, before line 344: Add removal logic for existing dataPathInExecutionDir

**Note from research**: Using maxRetries and retryDelay options helps handle transient filesystem errors (EBUSY, EMFILE, ENFILE, ENOTEMPTY, EPERM) that can occur on Windows and other platforms when files are temporarily locked by other processes.

### Change 3: Update Help Text for Clarity

**File**: `server/index.ts`
**Lines**: 88-166

**Current help text** (lines 106-108):
```
--start-new               Start a new execution (creates or reuses directory)
--force                   Force operation in directories with existing .hankweave/
--validate, -v            Validate configuration without running
```

**Updated help text:**
```
--start-new               Start a new execution (don't resume existing)
                          - Creates directory if it doesn't exist
                          - Requires --force if directory has .hankweave/
--force                   Force operation in directories with existing .hankweave/
                          - Backs up existing .hankweave.backup-{timestamp}
                          - Overwrites read_only_data_source link
--validate, -v            Validate configuration without creating directories
                          - Performs comprehensive preflight checks
                          - No filesystem side effects
```

Also update the "Execution Safety" section (lines 122-126) to clarify the --start-new behavior.

**Lines to modify**:
- Lines 106-112: Expand flag descriptions with details
- Lines 122-126: Clarify three-tier safety in relation to --start-new

### Change 4: Add Test for Validation Mode Not Creating Directories

**File**: Create `tests/unit/validate-mode.test.ts` (new file)

This test should verify:
1. `--validate` doesn't create execution directories
2. `--validate` doesn't create read_only_data_source links
3. `--validate` doesn't write metadata files
4. `--validate` still catches configuration errors
5. `--validate --execution /nonexistent/path` works (doesn't require existing path)

**Example test structure:**
```typescript
describe("Validation Mode", () => {
  it("should not create execution directory", async () => {
    const testDir = path.join(os.tmpdir(), "validate-test-exec");

    // Ensure directory doesn't exist
    if (fs.existsSync(testDir)) {
      await rimrafSimple(testDir);
    }

    // Run validation (would need to mock/call the validation flow)
    // ...

    // Verify directory was NOT created
    expect(fs.existsSync(testDir)).toBe(false);
  });

  // ... more tests
});
```

### Change 5: Update Existing Tests for New Behavior

**File**: `tests/unit/execution-setup.test.ts`

Verify all existing tests still pass with the new `needsDataSetup` condition. Specifically:
- Test at line 116-152 (resume existing execution)
- Test at line 180-198 (resume without --start-new)

Add new test:
```typescript
it("should overwrite read_only_data_source with --start-new --force", async () => {
  // Create execution with old data link
  await setupExecutionEnvironment({
    readOnlySourceDataPath: DATA_SOURCE_DIR,
    executionPath: EXECUTION_DIR,
    startNew: true,
  });

  // Create a new data source
  const NEW_DATA_SOURCE = path.join(TEST_BASE_DIR, "new-data");
  await fs.promises.mkdir(NEW_DATA_SOURCE, { recursive: true });
  await fs.promises.writeFile(path.join(NEW_DATA_SOURCE, "new.txt"), "new content");

  // Run with --start-new --force on same directory but different data
  await setupExecutionEnvironment({
    readOnlySourceDataPath: NEW_DATA_SOURCE,
    executionPath: EXECUTION_DIR,
    startNew: true,
    forceMode: true,
    skipConfirmation: true,
  });

  // Verify read_only_data_source points to new data
  const newFile = path.join(EXECUTION_DIR, "read_only_data_source", "new.txt");
  expect(fs.existsSync(newFile)).toBe(true);
  const content = await fs.promises.readFile(newFile, "utf-8");
  expect(content).toBe("new content");

  // Verify old data files are gone from read_only_data_source
  const oldFile = path.join(EXECUTION_DIR, "read_only_data_source", "test.txt");
  expect(fs.existsSync(oldFile)).toBe(false);
});
```

## Judgement Calls

### Decision 1: How to Handle Validation Mode Paths

**Options:**

**A) Pass current working directory to validateHank()**
- Pro: Simple, no new code needed
- Con: Misleading - validation results would vary based on where you run the command
- Con: Rig setup validation would be incorrect if CWD != execution directory

**B) Pass a temporary/dummy directory to validateHank()**
- Pro: Clean separation
- Con: May not match actual execution behavior
- Con: Could mask issues with relative paths

**C) Determine what the execution path WOULD be without creating it**
- Pro: Accurate simulation of actual execution
- Con: Some code duplication with setupExecutionEnvironment()
- Pro: Validation results match what would actually happen

**Recommendation: Option C** - Create `determinePaths()` function that mirrors the logic of setupExecutionEnvironment() but with no side effects. This gives users accurate validation results while maintaining the "dry run" property.

**Reasoning:** When a user runs `hankweave --validate`, they want to know if their configuration will work when they remove the --validate flag. Option C provides this guarantee.

**Supported by research:** The Kubernetes dry-run KEP explicitly recommends factoring out side-effect logic into separate functions rather than adding conditional branches. This prevents "if dry-run / else soup" and makes the code more maintainable. AWS CLI and other mature tools follow similar patterns.

### Decision 2: Should --validate Require Data Source to Exist?

**Context:** Currently, setupExecutionEnvironment() checks if data source exists (line 134-136). Should validation mode do the same?

**Options:**

**A) Require data source to exist**
- Pro: Validates that user's data path is correct
- Pro: Can calculate actual data hash for more accurate simulation
- Con: Can't validate configuration without having data ready

**B) Make data source optional for validation**
- Pro: Can validate configuration before data is available
- Con: Less realistic validation (can't check data-dependent issues)
- Con: Hash-based path determination won't work

**Recommendation: Option A** - Require data source to exist even in validation mode.

**Reasoning:** The data source path is a fundamental input to the system. If it doesn't exist, validation should fail fast with a clear error. This also allows for calculating the real data hash, which makes the simulated execution paths more accurate.

### Decision 3: Should --force Skip Hash Validation?

**Context:** Currently, when resuming, the data hash must match exactly (line 269-274). With `--start-new --force`, should we allow different data?

**Current behavior:**
```typescript
// In resume mode (without --start-new)
if (meta.dataHash !== dataHash) {
  throw new Error("Data source mismatch");
}
```

**Question:** Should `--start-new --force` skip this check since we're explicitly starting fresh?

**Options:**

**A) Keep hash check even with --force**
- Pro: Forces explicit data source specification
- Con: Confusing - why does --force not force?

**B) Skip hash check with --start-new --force**
- Pro: Matches user intent ("force start fresh, even with different data")
- Pro: Allows reusing execution directory with new data
- Con: Could be dangerous if user doesn't realize data changed

**Recommendation: Option B with strong warning** - Skip hash check with `--start-new --force`, but log a prominent warning:

```typescript
if (startNew && forceMode) {
  // Allow different data hash
  if (meta.dataHash !== dataHash) {
    console.warn(`⚠️  WARNING: Data source hash changed!`);
    console.warn(`  Previous: ${meta.dataHash.substring(0, 12)}...`);
    console.warn(`  Current:  ${dataHash.substring(0, 12)}...`);
    console.warn(`  Starting fresh execution with new data.\n`);
  }
  isNewExecution = true; // Treat as new execution
} else if (meta.dataHash !== dataHash) {
  throw new Error(/* existing error */);
}
```

**Reasoning:** The `--force` flag indicates strong user intent. Combined with `--start-new`, it should mean "I want to start fresh in this directory, even if things have changed." The warning ensures the user is aware of what's happening.

### Decision 4: Should --start-new Without --execution Auto-Create?

**Context:** The Linear ticket note says: "we also want to check whether simply running with an execution directory in params makes hankweave make that directory (--start-new if the dir doesn't exist). If not we want it to!"

**Current behavior:**
```typescript
// Without --start-new, explicit path that doesn't exist
if (!fs.existsSync(executionPath)) {
  throw new Error(`Execution directory not found: ${executionPath}`);
}
```

**Question:** Should `hankweave --execution /new/path` (without --start-new) auto-create the directory?

**Options:**

**A) Current behavior - error if doesn't exist**
- Pro: Explicit intent required (use --start-new to create)
- Pro: Prevents typos from creating directories
- Con: Verbose - need both --execution and --start-new

**B) Auto-create directory with warning**
- Pro: More convenient
- Con: Ambiguous - does user want to resume or create?
- Con: Typos create directories

**C) Auto-create only if parent directory exists**
- Pro: Middle ground - some safety
- Con: Inconsistent behavior based on parent existence

**Recommendation: Option A** - Keep current behavior, require --start-new to create.

**Reasoning:** The distinction between "resume in this directory" and "start new in this directory" is important. Making it explicit via --start-new prevents ambiguity and accidental directory creation. The Linear ticket note is asking to verify this works with --start-new, not to change the behavior without --start-new.

**Implementation note:** The current code at line 234-236 already creates the directory when `--start-new` is provided and directory doesn't exist. This is correct. No change needed.

### Decision 5: Handling Hank Config Changes with --start-new --force

**Context:** Lines 278-283 warn about hank.json changes when resuming. Should this warning be shown with `--start-new --force`?

**Current behavior:**
```typescript
if (hankHash && meta.hankHash && meta.hankHash !== hankHash) {
  configChanged = true;
  console.log(`\n⚠️  WARNING: hank.json has changed since last execution.`);
  // ... prompt for confirmation unless forceMode || skipConfirmation
}
```

**Options:**

**A) Skip warning entirely with --start-new**
- Pro: --start-new implies "I don't care about previous state"
- Con: User might not realize config changed

**B) Show warning but don't prompt with --force**
- Pro: User is informed but not blocked
- Con: Adds noise for something they likely expect

**C) Current behavior (warn and prompt unless --force)**
- Pro: Maximum awareness
- Con: Seems redundant with --start-new

**Recommendation: Option A** - Skip the warning when `startNew === true`.

**Reasoning:** When a user provides `--start-new`, they're explicitly saying "I want a fresh execution." Comparing to previous state doesn't make sense in this context. The check should only apply when resuming.

**Implementation:**
```typescript
// Only check for config changes when resuming (not with --start-new)
if (!startNew && hankHash && meta.hankHash && meta.hankHash !== hankHash) {
  configChanged = true;
  // ... existing warning logic
}
```

**Lines to modify**: Line 278 - add `!startNew &&` condition

## Open Questions

### Question 1: Should Validation Test Actual Model Availability?

The validateHank() function runs self-tests for shims (model adapters). Should this happen in --validate mode?

**Tradeoffs:**
- Pro: Catches model configuration issues early
- Con: Requires API keys to be configured
- Con: Makes network requests during validation
- Con: Slower validation

**Current behavior:** Self-tests are run during validation (config.ts line 1548+).

**Recommendation:** Keep current behavior but document it. Validation isn't just syntax checking - it's a full preflight check. Users who want syntax-only validation can check the hank.json schema separately.

### Question 2: Should --validate Support --execution Paths That Don't Exist?

**Scenario:**
```bash
hankweave --validate --execution /path/that/doesnt/exist/yet
```

Should this work?

**Current behavior:** Would error in setupExecutionEnvironment() at line 244.

**With proposed changes:** determinePaths() would work fine with non-existent paths.

**Recommendation:** Yes, allow this. It's useful to validate "I want to run in this directory when I create it." The validation would check that the configuration is valid for that target path.

### Question 3: What About Cleanup Mode?

Line 181-191 skips Claude SDK check for cleanup and validate modes. Should cleanup mode also skip execution setup?

**Current behavior:** Cleanup mode calls setupExecutionEnvironment() and then runs cleanup on that directory.

**Analysis:** This seems intentional - cleanup needs to know which directory to clean up, and setupExecutionEnvironment() handles the logic of finding/determining that directory.

**Recommendation:** No change needed for cleanup mode. Only validation mode should skip execution setup.

### Question 4: Should We Add --dry-run Flag?

Instead of overloading --validate, should we add a separate --dry-run flag that shows what would happen without doing it?

**Options:**

**A) Overload --validate (current plan)**
- Pro: Fewer flags
- Con: --validate implies config checking, not path determination

**B) Add --dry-run flag**
- Pro: Clear semantics
- Con: Another flag to maintain
- Con: Overlap with --validate

**Recommendation: Option A** - Keep it as --validate behavior.

**Reasoning:** For most users, "validate my configuration" includes "make sure it will work with these paths." Adding --dry-run would create confusion about when to use which. Keep it simple.

## Implementation Priority

### High Priority (Must Fix)

1. **Validation mode creating directories** - This is a genuine bug that wastes resources and confuses users.
2. **read_only_data_source overwriting** - Breaks the advertised behavior of `--start-new --force`.

### Medium Priority (Should Fix)

3. **Help text updates** - Improves user experience and reduces confusion.
4. **Test coverage for validation mode** - Prevents regression of the fix.

### Low Priority (Nice to Have)

5. **Skip hank config warning with --start-new** - Minor quality-of-life improvement.
6. **Enhanced logging for --force operations** - Better visibility into what's happening.

## Testing Strategy

### Unit Tests

1. **Validation mode tests** (new file)
   - Verify no directory creation
   - Verify no file operations
   - Verify error detection still works

2. **Execution setup tests** (update existing)
   - Add test for `--start-new --force` data overwriting
   - Verify all existing tests still pass

### Integration Tests

1. **Full validation flow** (tests/e2e/)
   - Run `hankweave --validate` on sample hank
   - Verify no side effects on filesystem
   - Verify exit code and output

2. **Force overwrite flow** (tests/e2e/)
   - Create execution with data A
   - Run with `--start-new --force` with data B
   - Verify data B is accessible, data A is not

### Manual Testing Checklist

Before considering this task complete:

- [ ] Run `--validate` on valid config, verify no directories created
- [ ] Run `--validate` on invalid config, verify appropriate error
- [ ] Run `--validate --execution /new/path`, verify works without creating path
- [ ] Run `--start-new` in existing empty directory, verify success
- [ ] Run `--start-new` in existing directory with .hankweave, verify error suggests --force
- [ ] Run `--start-new --force` in existing directory with .hankweave, verify backup created
- [ ] Run `--start-new --force` with different data source, verify read_only_data_source updated
- [ ] Verify all existing tests pass
- [ ] Check that help text accurately describes behavior

## Rollback Plan

If these changes cause issues:

1. **Validation mode regression**: Revert index.ts changes, keep old behavior of creating directories. Users can manually clean up.

2. **Data linking issues**: Revert execution-setup.ts changes to line 343 condition. Document as known limitation.

3. **Test failures**: Fix tests to match actual behavior or adjust implementation if tests reveal issues.

The changes are relatively isolated (two files, focused areas), making rollback straightforward if needed.

## Documentation Updates Needed

After implementation:

1. **README.md** - Update examples of `--validate` usage
2. **CLI help text** - Already covered in Change 3
3. **Execution flow documentation** - Update any diagrams showing validation mode
4. **FAQ** - Add entry about validation not creating directories
5. **Error message guide** - Document the three-tier safety system clearly

## Summary

The changes required are surgical and focused. The main architectural change is moving validation before execution setup in index.ts. The secondary fix is ensuring `--start-new --force` properly overwrites data links. All other changes are refinements and clarifications. The existing code quality is high, the test coverage is good, and the safety system is well-designed - this task is about fixing two specific bugs and clarifying behavior through documentation.
