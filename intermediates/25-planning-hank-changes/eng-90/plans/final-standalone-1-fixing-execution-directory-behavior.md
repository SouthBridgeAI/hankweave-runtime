# Final Plan: Fixing Execution Directory Behavior

## Summary

This task fixes two bugs in Hankweave's execution directory management and clarifies CLI flag behavior. The primary bug is architectural: `setupExecutionEnvironment()` is called before the `--validate` mode check in `server/index.ts`, causing directory creation, file copying, and metadata writing even when the user only wants a preflight check. The secondary bug is that `--start-new --force` does not overwrite the existing `read_only_data_source` symlink/copy when rerunning in an existing execution directory with different data.

The fix involves creating a lightweight `determinePaths()` function that simulates execution setup without filesystem side effects, reordering the validation flow in `index.ts` to check for `--validate` before calling `setupExecutionEnvironment()`, and updating the data linking condition in `execution-setup.ts` to handle the force-overwrite case. The existing three-tier safety system (Tier 1: block `~/.hankweave-executions/` as explicit path; Tier 2: require `--force` for directories with existing `.hankweave/`; Tier 3: prompt for non-empty directories) is working correctly and should be preserved.

This is a focused bug fix, not a major refactor. The codebase has high quality, comprehensive test coverage (598 lines in `execution-setup.test.ts`), and excellent error messages. Implementation should follow existing patterns and preserve the defensive programming style.

## Background

### Original Task

From Linear ticket ENG-90 (https://linear.app/southbridge/issue/ENG-90):

> **Title:** Fixing execution directory behavior
>
> **Description:** The overall behavior around execution directories makes for a cumbersome experience:
>
> * --start-new fails if the directory exists.
> * --validate creates a new directory for some reason.
>
> Let's clean up a bit. (also related to ENG-88) - here's the behavior we want:
>
> 1. Validate doesn't make a directory or start up the server. It just runs a comprehensive preflight check to make sure that the server with all the currently enabled settings (whether that's resume, start new, etc) will work once validate flag is removed.
>
> 2. --start-new will create a dir if it doesn't exist,
>    1. if --force is on, backup .strandweave in existing dir, overwrite read_only_data_source in existing dir, otherwise fail
>    2. or run in directory if nothing wrong with it
> 3. neither will try to resume in a directory.

Additionally, from the input task file: "we also want to check whether simply running with an execution directory in params makes hankweave make that directory (--start-new if the dir doesn't exist). If not we want it to!"

### Key Context

**The "--start-new fails if directory exists" is not actually a bug.** Step 2 Agent's code exploration revealed this is the three-tier safety system working as designed. Tier 2 intentionally requires `--force` when a directory has an existing `.hankweave/` folder, to prevent accidental overwrites. The Linear ticket's wording was about perceived confusing behavior, but the underlying logic is correct and should be preserved.

**The ".strandweave" vs ".hankweave" naming confusion**: The Linear ticket mentions `.strandweave` but the code uses `.hankweave`. This is from before the project was renamed from Strandweave to Hankweave. The code is correct; the ticket is just using old terminology.

**Related work - ENG-88** ("Run strands in existing run directories", Done): Implemented the `--start-new` and `--force` flags along with the three-tier safety system. ENG-90 builds on this foundation.

**Research validation** (from Step 3 Agent): The Kubernetes Enhancement Proposal for dry-run explicitly recommends factoring out side-effect logic into separate functions rather than adding conditional branches everywhere. This validates the proposed `determinePaths()` approach. The `fs.promises.rm()` call with `{ recursive: true, force: true, maxRetries: 3, retryDelay: 100 }` is the correct pattern for robust directory deletion across platforms.

## Decision Points

### Decision 1: How to Handle Validation Mode Paths

**Problem**: Validation mode currently creates real execution directories because `setupExecutionEnvironment()` is called before checking `validateMode`. How should validation determine paths without side effects?

**Options considered**:
- Option A: Pass current working directory to `validateHank()` - Simple but misleading; rig setup validation would be incorrect if CWD != execution directory.
- Option B: Pass a temporary/dummy directory - Clean separation but may not match actual execution behavior.
- Option C: Create `determinePaths()` function that mirrors `setupExecutionEnvironment()` logic without side effects - Accurate simulation of what would happen.

**Decision**: Option C - Create a separate `determinePaths()` function.

**Rationale**: As Step 2 Agent noted: "Option 3 seems cleanest - we can implement a 'dry run' version of setupExecutionEnvironment() that returns what paths would be used without actually creating anything." Step 3 Agent's research confirmed this aligns with the Kubernetes dry-run KEP recommendation: "the underlying 'do it' logic really needs to be factored properly for individual side effects, otherwise you end up with loads of 'if dry-run / else' soup."

### Decision 2: Should --force Skip Data Hash Validation?

**Problem**: When using `--start-new --force` on an existing execution directory, should we allow running with different data than the previous execution?

**Options considered**:
- Keep hash check even with `--force` - Confusing; why does `--force` not force?
- Skip hash check with `--start-new --force` - Matches user intent but could be dangerous without warning.

**Decision**: Skip hash check with `--start-new --force`, but log a prominent warning about the data source change.

**Rationale**: Step 2 Agent's analysis: "The `--force` flag indicates strong user intent. Combined with `--start-new`, it should mean 'I want to start fresh in this directory, even if things have changed.'" The warning ensures users are informed of what's happening without blocking them from doing what they explicitly requested.

### Decision 3: Should --execution Auto-Create Without --start-new?

**Problem**: The ticket asks if `hankweave --execution /new/path` should auto-create the directory if it doesn't exist.

**Options considered**:
- Current behavior (error if doesn't exist) - Explicit intent required.
- Auto-create with warning - More convenient but ambiguous about resume vs. create intent.

**Decision**: Keep current behavior - require `--start-new` to create.

**Rationale**: Step 2 Agent's recommendation: "The distinction between 'resume in this directory' and 'start new in this directory' is important. Making it explicit via --start-new prevents ambiguity and accidental directory creation." The current code at line 234-236 already creates the directory when `--start-new` is provided. No change needed.

### Decision 4: Handling Config Changes with --start-new --force

**Problem**: Should the hank.json change warning (lines 278-283) be shown when using `--start-new`?

**Decision**: Skip the warning entirely when `startNew === true`.

**Rationale**: When users provide `--start-new`, they're explicitly saying "I want a fresh execution." Comparing to previous state doesn't make sense in this context. The check should only apply when resuming.

### Decision 5: Should Validation Require Data Source to Exist?

**Decision**: Yes, require data source to exist even in validation mode.

**Rationale**: The data source path is a fundamental input. If it doesn't exist, validation should fail fast with a clear error. This also enables calculating the real data hash for accurate path simulation.

## Implementation Plan

### Step 1: Create determinePaths() Function

**File**: `./tadpole/server/index.ts`
**Location**: After the helper functions (after line 51, before `main()`)

Create a new function that determines what paths WOULD be used without creating any directories or files:

```typescript
interface PathsForValidation {
  executionPath: string;
  dataPathInExecutionDir: string;
  configPath: string;
}

function determinePaths(options: {
  readOnlySourceDataPath: string;
  executionPath?: string;
  startNew?: boolean;
  dataHash: string;
}): PathsForValidation {
  if (options.executionPath) {
    return {
      executionPath: options.executionPath,
      dataPathInExecutionDir: path.join(options.executionPath, "read_only_data_source"),
      configPath: options.executionPath,
    };
  } else if (options.startNew) {
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

**Step 4 Agent note**: This function mirrors the path determination logic from `setupExecutionEnvironment()` but with zero side effects. It's intentionally simple because validation mode doesn't need the full complexity of directory creation, safety checks, or metadata handling.

### Step 2: Reorder Validation Flow in index.ts

**File**: `./tadpole/server/index.ts`
**Lines**: 256-382

**Current problematic flow** (lines 256-382):
1. Parse CLI args (line 66)
2. Resolve data source (lines 193-223)
3. Resolve config path (lines 225-254)
4. **Setup execution environment (lines 256-272)** ← Creates directories!
5. Change to execution directory (line 284)
6. Check if validateMode (line 327)
7. Run validation
8. Exit

**New flow**:
1. Parse CLI args
2. Resolve data source
3. Resolve config path
4. **If validateMode**: calculate data hash, determine paths without creating, create temp logger, initialize LLM registry, run validation, exit
5. **Otherwise**: setup execution environment, change directory, run server

**CRITICAL: Complete Validation Branch Structure**

[Updated based on trial: The original plan showed fragments of the validation flow but didn't provide the complete restructured code. Trial implementation revealed that this incompleteness led to a broken implementation where the bug was not fixed. The validation mode MUST be a complete, self-contained branch that runs before any execution setup code.]

[Updated based on trial: The Logger class at utils.ts:40-43 automatically creates directories when instantiated. Using `paths.executionPath` for the logger would defeat the entire purpose of this bug fix. The validation logger MUST use `os.tmpdir()` instead.]

**Changes**:

**First, add the missing import** (after line 9):

```typescript
import { DEFAULT_CONFIG, resolveSettings, validateHank } from "./config.js";
```

**Then, after line 304 (config path resolution), add the COMPLETE validation branch:**

This entire block must be placed BEFORE any call to `setupExecutionEnvironment()`:

```typescript
// ========== VALIDATION MODE BRANCH ==========
// This block must run BEFORE any execution setup to prevent directory creation

if (validateMode) {
  // 1. Calculate data hash (needed for path determination)
  console.log("Calculating data signature for validation...");
  const { hashDataSource } = await import("./data-hasher.js");
  const dataHash = await hashDataSource(resolvedDataPath, DEFAULT_CONFIG.dataHashTimeLimit);

  // 2. Determine paths WITHOUT creating any directories
  const paths = determinePaths({
    readOnlySourceDataPath: resolvedDataPath,
    executionPath: executionPath ? path.resolve(executionPath) : undefined,
    startNew,
    dataHash,
  });

  // 3. Create logger in temp directory to AVOID creating execution directories
  // CRITICAL: The Logger class auto-creates directories (utils.ts:40-43).
  // Using paths.executionPath here would defeat the entire bug fix!
  const validationLogger = new Logger(
    path.join(os.tmpdir(), `hankweave-validation-${Date.now()}.log`)
  );

  // 4. Initialize LLM Provider Registry (required before validation can run)
  LlmProviderRegistry.getInstance({
    logger: validationLogger,
    performHealthCheckOnInit: false,
  });

  // 5. Print validation header
  console.log(`\n🔍 Validating configuration: ${absoluteConfigPath}\n`);
  console.log(`📁 Data source: ${resolvedDataPath}`);
  console.log(`🏃 Would execute in: ${paths.executionPath}`);

  // 6. Run validation
  try {
    const validationResult = await validateHank(
      absoluteConfigPath,
      paths.executionPath,
      validationLogger,
    );

    // ... (keep existing validation output code from lines 387-437) ...

    process.exit(0);
  } catch (error) {
    console.error(`❌ Validation failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

// ========== NORMAL MODE BRANCH ==========
// Only reaches here if NOT in validation mode
```

**Then wrap the existing execution setup in `if (!validateMode) { ... }`:**

Note: Since we already exit in the validation branch above, this wrapper is technically redundant but provides clarity and defensive coding:

```typescript
let executionSetup: ExecutionSetup;
// Normal mode: set up execution environment (creates directories, links data)
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

if (inputSourceType !== "path") {
  console.log(`📥 Input type: ${inputSourceType}`);
}
console.log(`📁 Data source: ${executionSetup.readOnlySourceDataPath}`);
console.log(`🏃 Execution: ${executionSetup.executionPath}`);
console.log(`🔗 Link type: ${executionSetup.linkType}`);

process.chdir(executionSetup.executionPath);
```

**Why this structure is critical:**

The trial implementation attempted to implement Step 2 as originally written (fragments showing individual pieces) and discovered that:
1. The data hash was calculated but the execution setup still ran unconditionally
2. Validation mode still created directories because the conditional wrapping was incomplete
3. Runtime testing confirmed the bug was NOT fixed despite all unit tests passing

The complete validation branch shown above ensures that validation mode:
- Calculates the data hash it needs
- Determines paths without filesystem side effects
- Creates a logger in temp directory (NOT the execution path)
- Initializes the LLM registry (required for validateHank)
- Runs validation and exits BEFORE any execution setup code runs

### Step 3: Fix read_only_data_source Overwriting

**File**: `./tadpole/server/execution-setup.ts`
**Lines**: 342-376

**Current code** (line 343):
```typescript
if (isNewExecution || !fs.existsSync(dataPathInExecutionDir)) {
```

**Problem**: This condition doesn't handle `--start-new --force` on an existing directory with data. The old `read_only_data_source` isn't removed.

**Fix** [Updated based on trial: Simplified approach - the original plan added a redundant `(startNew && forceMode)` condition, but `isNewExecution` is already true when `startNew` is true. Instead, just add removal logic inside the existing block]:

```typescript
// Keep the existing condition as-is
if (isNewExecution || !fs.existsSync(dataPathInExecutionDir)) {
  // Add removal logic for existing read_only_data_source
  // (handles --start-new --force case where directory was reused)
  if (fs.existsSync(dataPathInExecutionDir)) {
    console.log(`🗑️  Removing existing data link: ${dataPathInExecutionDir}`);
    await fs.promises.rm(dataPathInExecutionDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }

  if (stats.isDirectory()) {
    // ... existing directory logic unchanged ...
  } else if (stats.isFile()) {
    // ... existing file logic unchanged ...
  }
}
```

**Rationale for simplified approach**: The trial implementation log noted that adding `(startNew && forceMode)` to the condition is redundant because `isNewExecution` is set to `true` when `startNew` is true (see execution-setup.ts:239). The real fix is simply adding the removal logic inside the existing block to handle the case where `read_only_data_source` already exists.

**Step 4 Agent note on maxRetries/retryDelay**: Step 3 Agent's research found these options help handle transient filesystem errors (EBUSY, EMFILE, ENFILE, ENOTEMPTY, EPERM) common on Windows when files are temporarily locked by other processes.

### Step 4: Skip Config Warning with --start-new

**File**: `./tadpole/server/execution-setup.ts`
**Line**: 278

**Current code**:
```typescript
if (hankHash && meta.hankHash && meta.hankHash !== hankHash) {
```

**Change to**:
```typescript
if (!startNew && hankHash && meta.hankHash && meta.hankHash !== hankHash) {
```

This ensures the hank.json change warning only appears when resuming, not when explicitly starting fresh.

### Step 5: Update Help Text

**File**: `./tadpole/server/index.ts`
**Lines**: 106-112

**Current help text**:
```
--start-new               Start a new execution (creates or reuses directory)
--force                   Force operation in directories with existing .hankweave/
--validate, -v            Validate configuration without running
```

**Updated help text**:
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

### Step 6: Add Test for Validation Mode

**File**: Create `./tadpole/tests/unit/validate-mode.test.ts` (new file)

[Updated based on trial: Changed import from `vitest` to `bun:test` to match the project's testing framework]

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Validation Mode", () => {
  const testDir = path.join(os.tmpdir(), "hankweave-validate-test");
  const execRoot = path.join(os.homedir(), ".hankweave-executions");

  beforeEach(async () => {
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    }
  });

  it("should not create execution directory in validate mode", async () => {
    // Run validation (mock the validation flow)
    // ... test implementation

    // Verify directory was NOT created
    expect(fs.existsSync(testDir)).toBe(false);
  });

  it("should allow --validate with --execution pointing to non-existent path", async () => {
    const nonExistentPath = path.join(testDir, "does-not-exist");

    // Run validation with non-existent execution path
    // ... test implementation

    // Should not throw, should not create the path
    expect(fs.existsSync(nonExistentPath)).toBe(false);
  });

  // [Added based on trial: This critical test was missing from the original plan.
  // The test-fixing-log revealed that runtime testing was required to verify the
  // bug fix because unit tests alone did not catch the incomplete implementation.]
  it("should not create any new directories in ~/.hankweave-executions/ during validation", async () => {
    // Record existing directories before validation
    const beforeDirs = fs.existsSync(execRoot)
      ? fs.readdirSync(execRoot)
      : [];

    // Run validation mode
    // ... test implementation using determinePaths() + validation flow

    // Verify NO new directories were created
    const afterDirs = fs.existsSync(execRoot)
      ? fs.readdirSync(execRoot)
      : [];
    expect(afterDirs).toEqual(beforeDirs);
  });
});
```

### Step 7: Add Test for --start-new --force Data Overwriting

**File**: `./tadpole/tests/unit/execution-setup.test.ts`
**Location**: Add to existing test suite

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

## Code References

### Files to Modify

| File | What to Change |
|------|----------------|
| `./tadpole/server/index.ts` | Add `determinePaths()` function; wrap execution setup in `if (!validateMode)`; update validation block to use determined paths; update help text |
| `./tadpole/server/execution-setup.ts` | Update data linking condition at line 343; add removal logic for existing data path; add `!startNew &&` to config change check at line 278 |
| `./tadpole/tests/unit/execution-setup.test.ts` | Add test for `--start-new --force` data overwriting |
| `./tadpole/tests/unit/validate-mode.test.ts` (new) | Add tests for validation mode not creating directories |

### Files to Read (Context Only)

| File | Why |
|------|-----|
| `./tadpole/server/config.ts:1214-1600` | Contains `validateHank()` which uses `executionPath` only for relative path resolution at line 1413 |
| `./tadpole/server/cli-parser.ts:20-35` | Flag definitions - no changes needed here |
| `./tadpole/server/data-hasher.ts` | Hash calculation - no changes needed here |

### Patterns to Follow

**Error messages** - Use the existing pattern with clear problem statement and numbered options:
```typescript
throw new Error(
  `Directory already contains Hankweave execution: ${executionPath}\n` +
  `Options:\n` +
  `  1. Remove .hankweave/ directory and try again\n` +
  `  2. Use --force to backup existing state and start fresh\n` +
  `  3. Use a different directory`,
);
```

**Console output** - Use established emoji prefixes:
- `📁` for directory operations
- `🔗` for linking operations
- `⚠️` for warnings
- `❌` for errors
- `✅` for success
- `🔍` for validation
- `📦` for backups
- `🗑️` for removals (new, following pattern)

**Three-tier safety system** - Preserve existing behavior:
- Tier 1: Hard block on `~/.hankweave-executions/` as explicit execution path
- Tier 2: Require `--force` for directories with existing `.hankweave/`
- Tier 3: Prompt for confirmation on non-empty directories without `.hankweave/`

## Test Plan

### Test Strategy

This is a focused bug fix affecting directory creation and data linking behavior. The testing approach prioritizes behavior verification over exhaustive coverage. Since the existing test suite is comprehensive (598 lines in `execution-setup.test.ts` alone), we add targeted tests for the new behaviors without duplicating existing coverage.

Key testing principles:
- Unit tests verify the core logic changes (validation mode paths, force overwrite)
- Integration tests would be overkill for this focused change (unit tests are sufficient)
- Manual testing validates the user experience for the specific bug scenarios
- All existing tests must continue to pass (regression prevention)

### Unit Tests

#### New Test File: `./tadpole/tests/unit/validate-mode.test.ts`

This new test file verifies that validation mode no longer creates directories or files. Testing framework: Bun Test (like other unit tests).

[Updated based on trial: Imports must use `bun:test` and `node:` prefixes to match the project's conventions]

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
```

Tests to add:

**Test 1: Validation mode creates no directories**
- Description: Verify `--validate` doesn't create execution directories
- Setup: Create temporary data source file
- Action: Call `determinePaths()` with validation mode parameters
- Verify: No directories created in `~/.hankweave-executions/`
- Cleanup: Remove test data

**Test 2: Validation with non-existent execution path**
- Description: Verify `--validate --execution /nonexistent/path` works
- Setup: Create data source, reference non-existent execution directory
- Action: Call `determinePaths()` with explicit non-existent execution path
- Verify: Function returns path without creating it
- Verify: Non-existent path still doesn't exist after call

**Test 3: Data hash calculation in validate mode**
- Description: Verify validation can calculate data hash from source
- Setup: Create data source with known content
- Action: Calculate hash and call `determinePaths()`
- Verify: Returned paths include data hash substring
- Note: This tests the integration point between validation and path determination

#### Updates to `./tadpole/tests/unit/execution-setup.test.ts`

Add these tests to the existing test suite (following patterns from lines 1-200).

**Test 4: Force overwrite removes old data link**
- Location: Add to "with explicit execution path" describe block
- Description: `--start-new --force` removes and recreates `read_only_data_source`
- Setup:
  1. Create execution with DATA_SOURCE_DIR as data
  2. Verify `read_only_data_source/test.txt` exists
  3. Create NEW_DATA_SOURCE_DIR with different content (`new.txt`)
- Action: Call `setupExecutionEnvironment()` with same execution path but:
  - `readOnlySourceDataPath: NEW_DATA_SOURCE_DIR`
  - `startNew: true`
  - `forceMode: true`
  - `skipConfirmation: true`
- Verify:
  - `read_only_data_source/new.txt` exists with correct content
  - `read_only_data_source/test.txt` no longer exists
  - `.hankweave.backup-*` directory exists
- Cleanup handled by existing afterEach

**Test 5: Config warning skipped with --start-new**
- Location: Add new describe block "config change warnings"
- Description: Verify hank.json change warning doesn't appear with `--start-new`
- Setup:
  1. Create execution with initial hank.json
  2. Calculate hankHash for original config
  3. Create modified hank.json with different hash
- Action: Call `setupExecutionEnvironment()` with:
  - Same execution path
  - `startNew: true`
  - `forceMode: true`
  - Different hankPath (new config)
- Verify: No warning logged about config changes
- Compare: Without `startNew`, warning should appear (existing behavior)

### Regression Testing

**Critical existing tests that must still pass:**

From `execution-setup.test.ts`:
- "should create new execution in non-existent directory with --start-new" (line 51)
- "should resume existing execution without --start-new" (line 116)
- "should prompt for confirmation in non-empty directory" (line 82)
- Three-tier safety system tests (lines 50-153)

From other test files:
- All 598 tests in the existing test suite
- E2E tests in `happy-path-e2e.test.ts`
- Integration tests for config validation

### Manual Testing Checklist

These scenarios test the user-facing behavior changes. Run these after implementation:

**Validation mode (Bug 1 fixes):**
- [ ] `hankweave --validate --config hank.json --data ./data`
  - Verify: No directories created in `~/.hankweave-executions/`
  - Verify: Validation output shows "Would execute in: ..."
  - Verify: Config errors detected correctly
- [ ] `hankweave --validate --execution /new/nonexistent/path --config hank.json --data ./data`
  - Verify: Works without error
  - Verify: `/new/nonexistent/path` not created

**Force overwrite (Bug 2 fixes):**
- [ ] Create execution: `hankweave --start-new --execution ./test-dir --data ./data-v1`
- [ ] Verify `./test-dir/read_only_data_source` points to `data-v1`
- [ ] Run with different data: `hankweave --start-new --force --execution ./test-dir --data ./data-v2 --skip-confirmation`
- [ ] Verify: `./test-dir/read_only_data_source` now points to `data-v2`
- [ ] Verify: `.hankweave.backup-*` directory exists
- [ ] Verify: Warning logged about data source change

**Three-tier safety (must not break):**
- [ ] `hankweave --start-new --execution ~/.hankweave-executions`
  - Verify: Error "Cannot use ~/.hankweave-executions/ as explicit path"
- [ ] Create execution, then run without `--force`:
  - `hankweave --start-new --execution ./test-dir --data ./data`
  - `hankweave --start-new --execution ./test-dir --data ./data`
  - Verify: Error suggests using `--force`
- [ ] Run in non-empty directory without `--skip-confirmation`:
  - Create `./test-dir` with `existing.txt`
  - `hankweave --start-new --execution ./test-dir --data ./data`
  - Verify: Prompts for confirmation (or auto-rejects in non-TTY)

**Help text verification:**
- [ ] `hankweave --help`
  - Verify: `--validate` description mentions "without creating directories"
  - Verify: `--start-new` description mentions directory creation and `--force` requirement
  - Verify: `--force` description mentions backup and overwrite behavior

### Test Data & Fixtures

**Required test fixtures:**

1. **Valid hank.json** - Minimal config for validation tests
2. **Data source directory** - Directory with known files for hashing
3. **Data source file** - Single file for file-based data source tests

These already exist in `./tadpole/tests/config/`:
- `test-codons.config.json` - Sample hank config
- `poem_guides.txt` - Sample data file

**New fixtures needed:** None. Existing fixtures are sufficient.

### Performance Considerations

No performance testing required for this change. The modifications are to setup code that runs once at startup, not hot paths. The `determinePaths()` function is lightweight (no I/O, just path manipulation).

### Error Cases to Test

**Unit test error cases:**

1. Data source doesn't exist (validation should fail with clear error)
2. Data hash calculation times out (should propagate error cleanly)
3. Force mode without startNew (should work normally, no special behavior)

**These are covered by existing tests and don't need new test cases.**

### Test Execution Order

Run tests in this order to catch issues early:

1. Run new validation mode tests: `bun test tests/unit/validate-mode.test.ts`
2. Run updated execution setup tests: `bun test tests/unit/execution-setup.test.ts`
3. Run full unit test suite: `bun run test:unit`
4. Run integration tests: `bun run test:integration`
5. Run E2E tests: `bun run test`
6. Perform manual testing checklist

### Success Criteria

Tests are considered passing when:

- All new unit tests pass
- All existing tests continue to pass (no regressions)
- Manual testing checklist completed without issues
- Code coverage remains at current levels (no significant drops)

### Notes on Test Maintenance

The test files follow Bun Test conventions:
- Use `describe()`, `it()`, `expect()` from `bun:test`
- Use `beforeEach()` and `afterEach()` for setup/cleanup
- Store temp files in `os.tmpdir()` or `tests/test-area/`
- Clean up using `fs.promises.rm()` with `recursive: true, force: true`
- Use descriptive test names that explain behavior being tested

## Existing Test Mapping

This section identifies which existing tests need attention when implementing this plan. This is separate from the new tests described in the Test Plan section above.

### Tests That Need Updates

These tests will likely fail after implementation and need to be updated:

**None expected**. The implementation is designed to be backward-compatible. All existing tests should continue to pass without modification because the changes are focused on fixing bugs (validation creating directories, force mode not overwriting data) rather than changing intended behavior that tests rely on.

### Tests to Run for Regression Check

These tests should pass but run them carefully to catch any unexpected breakage:

**Unit tests:**

- `tests/unit/execution-setup.test.ts` (598 lines, comprehensive)
  - **Why**: Core tests for `setupExecutionEnvironment()` which is being modified
  - **Focus areas**:
    - "should create new execution in non-existent directory with --start-new" (line 51) - verifies directory creation still works
    - "should resume existing execution without --start-new" (line 116) - verifies resume behavior unchanged
    - "should prompt for confirmation in non-empty directory" (line 82) - Tier 3 safety check
    - "Tier 1 safety: ~/.hankweave-executions/ is reserved" (line 301) - verifies Tier 1 still blocks
    - "should create data link/copy in new execution" (line 237) - verifies data linking works
    - Data hash mismatch tests (line 323-352) - verifies existing hash validation logic
  - **Confidence**: Should all pass. The changes preserve existing behavior.

- `tests/unit/cli-parser.test.ts`
  - **Why**: Tests CLI flag parsing which isn't changing, but good to verify
  - **Focus areas**:
    - "--start-new" flag parsing (line 725) - confirms flag still works
    - "--force" flag parsing (if exists) - confirms flag still works
    - "--validate" flag parsing (if exists) - confirms flag still works
  - **Confidence**: Should all pass. No CLI parser changes in this plan.

**Integration tests:**

- `tests/integration/hankweave-server.test.ts`
  - **Why**: Tests HankweaveRuntime initialization which uses execution setup
  - **Focus areas**: Server startup with execution directory configuration
  - **Confidence**: Should pass. Changes don't affect runtime initialization.

**E2E tests:**

- `tests/e2e/happy-path-e2e.test.ts`
  - **Why**: Comprehensive end-to-end test that exercises execution setup
  - **Focus areas**: Complete workflow from server start through execution
  - **Confidence**: Should pass. Changes are internal to setup flow.

- `tests/e2e/rollback-comprehensive-e2e.test.ts`
  - **Why**: Uses `read_only_data_source` and execution directories
  - **Focus areas**: Verifies data access still works after rollback operations
  - **Confidence**: Should pass. Data linking behavior unchanged for normal operations.

### Tests That May Need Removal

**None**. This implementation doesn't deprecate any functionality. All existing features remain available.

### Tests That Might Be Affected (Low Probability)

These tests touch related areas but changes are unlikely to affect them:

- `tests/unit/config.test.ts` - Tests config validation, which is called by validateHank()
- `tests/integration/config-resolution.test.ts` - Tests config file resolution
- `tests/e2e/init-command-e2e.test.ts` - Tests hankweave init command

**Why low probability**: The validation flow changes don't affect config parsing or resolution logic, only the timing of when `setupExecutionEnvironment()` is called relative to validation checks.

### Test Commands

Run these commands in order to verify the implementation:

```bash
# 1. Run new validation mode tests (after creating the file in Step 6)
bun test tests/unit/validate-mode.test.ts

# 2. Run updated execution setup tests (including new force overwrite test from Step 7)
bun test tests/unit/execution-setup.test.ts

# 3. Run all unit tests to catch any unexpected interactions
bun test tests/unit/

# 4. Run integration tests
bun test tests/integration/

# 5. Run E2E tests (comprehensive, may take several minutes)
bun test tests/e2e/

# 6. Run full test suite
bun test

# 7. If any test fails, isolate it
bun test tests/path/to/specific.test.ts
```

### Testing Notes

**Critical regression areas to watch:**

1. **Three-tier safety system** - The most important thing to preserve. If any safety tier is accidentally disabled, tests in `execution-setup.test.ts` will catch it.

2. **Data linking** - The `read_only_data_source` symlink/copy creation is being modified for force mode. Watch for tests that verify data accessibility.

3. **Metadata handling** - Changes to when metadata is written could affect tests that check `execution-meta.json` contents.

**What successful test runs prove:**

- All 598 existing tests in `execution-setup.test.ts` passing = Core execution setup logic intact
- E2E tests passing = End-to-end workflow still works
- New validation tests passing = Bug 1 (validation creating directories) is fixed
- New force overwrite test passing = Bug 2 (force not overwriting data) is fixed

**If tests fail:**

1. Check if the failure is in expected areas (data linking, directory creation)
2. Review the specific implementation step that might have caused it
3. Verify the three-tier safety system is still intact (check error messages)
4. Ensure `determinePaths()` returns the same paths that `setupExecutionEnvironment()` would create

## Open Questions (if any)

### Should Validation Test Model Availability?

The `validateHank()` function runs self-tests for shims (model adapters). This requires API keys and makes network requests. Step 2 Agent's recommendation: "Keep current behavior but document it. Validation isn't just syntax checking - it's a full preflight check." This is an acceptable tradeoff, but the engineer implementing this should be aware that validation is not offline-only.

### Future Enhancement: --dry-run Flag?

Step 2 Agent considered whether to add a separate `--dry-run` flag instead of overloading `--validate`. The decision was to keep it as `--validate` behavior because "for most users, 'validate my configuration' includes 'make sure it will work with these paths.'" However, if future user feedback indicates confusion, a `--dry-run` flag could be added later.

---

## Learnings from Trial Implementation

This section was added after a trial implementation and testing phase. The trial attempted to implement Steps 1-2 of this plan and run the test suite. The findings below should inform the actual implementation.

### Validated

These aspects of the plan worked exactly as expected:

1. **Step 1 (determinePaths function)** - Implemented successfully with no issues. The function and interface were well-designed, self-contained, and clearly documented. The code at lines 107-148 of the plan is correct and can be used as-is.

2. **Step 4 (Skip config warning with --start-new)** - Simple, clear change that's easy to verify. Just add `!startNew &&` to the condition.

3. **Step 5 (Help text)** - Straightforward string updates with no ambiguity.

4. **General codebase quality** - The existing test suite (1107 unit tests, 139 integration tests) is comprehensive and all tests passed with the partial implementation.

### Clarifications Needed

These areas in the plan were unclear and required decisions during implementation:

1. **Where exactly to place determinePaths()**: The plan says "after line 51, before main()" but doesn't clarify whether to place it before or after the comment section at lines 52-55. Decision made: Place it before the "Main Entry Point" comment section for better organization.

2. **The "else" case in determinePaths()**: The plan's else branch at lines 137-147 creates a synthetic path `validation-${dataHash.substring(0, 6)}`, but this doesn't match what `setupExecutionEnvironment()` would actually do (it would search for existing directories). This is intentional simplification for validation mode since we don't want to actually search the file system - should be documented.

### Corrections Made

These issues were identified and corrections have been made to the plan:

1. **[CRITICAL] Step 2 was incomplete** - The original Step 2 showed fragments of code but not the complete validation branch structure. This led to an implementation where the data hash was calculated but execution setup still ran unconditionally. The plan has been updated with the complete validation branch code including:
   - Import statement for `DEFAULT_CONFIG`
   - Complete validation branch with explicit comments
   - Logger creation in `os.tmpdir()` (not execution path)
   - LLM registry initialization
   - Error handling

2. **[CRITICAL] Validation logger would create directories** - The Logger class at utils.ts:40-43 automatically creates directories for log files. The original plan used `paths.executionPath` for the validation logger, which would defeat the entire bug fix. The plan now specifies using `os.tmpdir()` instead.

3. **[MEDIUM] Missing import statement** - The plan used `DEFAULT_CONFIG.dataHashTimeLimit` without showing the import. Added to Step 2: `import { DEFAULT_CONFIG, resolveSettings, validateHank } from "./config.js";`

4. **[LOW] Test framework import** - Changed from `vitest` to `bun:test` in Step 6 and Test Plan sections to match the project's testing framework.

5. **[LOW] Simplified Step 3** - Removed redundant `(startNew && forceMode)` condition. Since `isNewExecution` is already true when `startNew` is true, the fix is simply to add the removal logic inside the existing block.

### Additions

Information discovered during trial that wasn't in the original plan:

1. **Logger auto-creates directories**: The Logger class constructor at utils.ts:40-43 includes `fs.mkdirSync(logsDir, { recursive: true })`. Any code creating a Logger must account for this side effect. For validation mode, use `os.tmpdir()` as the log directory.

2. **LLM registry must be initialized before validateHank()**: The trial revealed that `validateHank()` requires the LLM registry to be initialized. The validation branch must include:
   ```typescript
   LlmProviderRegistry.getInstance({
     logger: validationLogger,
     performHealthCheckOnInit: false,
   });
   ```

3. **Random string generation pattern**: The codebase uses `Math.random().toString(36).substring(2, 6)` for random strings (see execution-setup.ts:310).

4. **Process.chdir() dependency**: Several pieces of code depend on being in the execution directory. Validation mode must NOT call `process.chdir()` since it doesn't create the execution directory.

5. **Cleanup mode and validation are mutually exclusive**: Line 431 shows validation mode does `process.exit(0)`, so it never reaches cleanup mode. This simplifies the restructuring.

### Test Insights

What the test phase revealed:

1. **Unit tests don't catch incomplete implementations** - All 1107 unit tests passed with the incomplete implementation, but runtime testing showed the bug was not fixed. This validates the need for the specific test in Step 6 that checks "no new directories in ~/.hankweave-executions/".

2. **Runtime testing is essential** - The test-fixing-log ran this command and confirmed the bug still existed:
   ```bash
   hankweave --validate --config test.json --data .
   # Output showed: "Created execution directory: ..." ← Bug not fixed!
   ```

3. **The 2 integration test failures were unrelated** - Failures in "LLM proxy" tests were due to missing API keys, not our changes.

4. **Build succeeds with partial implementation** - TypeScript compilation and bundling work correctly with the partial changes, which means you can't rely on build failures to catch incomplete implementations.

5. **Recommended test addition**: Add a test that specifically monitors the `.hankweave-executions` directory before and after validation to verify no directories are created. This is now included in Step 6.

### Code Patterns to Follow

Patterns discovered during implementation that should be followed:

1. **Import `node:` prefix**: Use `import * as fs from "node:fs"` not `import * as fs from "fs"` to match project conventions.

2. **Console output prefixes**: Follow existing emoji conventions:
   - `📁` for directory operations
   - `🔗` for linking operations
   - `🔍` for validation
   - `🗑️` for removals (new)

3. **Error handling pattern**: Wrap potentially failing code in try-catch with clear error message and `process.exit(1)`:
   ```typescript
   try {
     // operation
   } catch (error) {
     console.error(`❌ Operation failed: ${(error as Error).message}`);
     process.exit(1);
   }
   ```

### Implementation Order Recommendation

Based on trial findings, implement in this order:

1. **Step 1 first** - determinePaths() is self-contained and correct
2. **Step 2 COMPLETELY** - Do not proceed until the entire validation branch is working and tested with runtime verification
3. **Runtime test Step 2** - Run `hankweave --validate --config test.json --data .` and verify NO directories are created
4. **Only then proceed to Steps 3-7**

The trial showed that partial implementation of Step 2 creates a worse state than no implementation at all (code appears to work but doesn't).

---

## Sources

- **Step 1 Plan**: [`supporting-docs/1-fixing-execution-directory-behavior-full-task.md`](./supporting-docs/1-fixing-execution-directory-behavior-full-task.md) - Initial task expansion with code exploration and problem decomposition
- **Code Context**: [`supporting-docs/1-fixing-execution-directory-behavior-related-code.md`](./supporting-docs/1-fixing-execution-directory-behavior-related-code.md) - Detailed code analysis with line numbers and patterns
- **Decisions**: [`supporting-docs/1-fixing-execution-directory-behavior-changes-decisions-and-judgement-calls.md`](./supporting-docs/1-fixing-execution-directory-behavior-changes-decisions-and-judgement-calls.md) - Implementation decisions, judgement calls, and research findings
- **Linear Ticket**: ENG-90 (https://linear.app/southbridge/issue/ENG-90)
- **Related Ticket**: ENG-88 (Done) - "Run strands in existing run directories"
- **Research Sources**:
  - [Kubernetes Enhancement Proposal - Dry Run](https://github.com/kubernetes/enhancements/blob/master/keps/sig-api-machinery/576-dry-run/README.md)
  - [AWS CLI Dry-Run Documentation](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-help.html)
  - [Node.js fs.promises.rm() Documentation](https://nodejs.org/api/fs.html)
  - [symlink-or-copy npm package](https://www.npmjs.com/package/symlink-or-copy)
- **Trial Implementation Log**: [`../trial-implementation-log.md`](../trial-implementation-log.md) - Detailed findings from attempting to implement this plan
- **Test Fixing Log**: [`../test-fixing-log.md`](../test-fixing-log.md) - Test results and runtime verification findings
