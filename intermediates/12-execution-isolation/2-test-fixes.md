## Additional notes:
1. The cleanup command shouldn't just remove latest execution when multiple exist. It should remove the latest execution even if it's the last one.
2. For datahasher - is this an actual functionality issue? It should be able to pass datahasher (not just for testing) other execution directories so that we can specify it from the user side.
3. What is sourcerealpath? Explain it to me.
4. Why do we have a lot of fallbacks for manual cleanup? Can you explain this?

# Test Fixes for Execution Isolation

## Overview

After implementing execution isolation, several tests are failing due to:
1. Changed assumptions about directory locations and cleanup behavior
2. Test expectations not matching actual behavior
3. Module mocking limitations in Bun
4. Test isolation issues

## Detailed Investigation

### 1. happy-path test analysis
- **Q: Are we creating a data dir and symlinking it?**
  - Yes, execution isolation creates an execution directory and symlinks/copies the data source
  - The server runs in the execution directory with user data accessible via `data/` subdirectory

- **Q: Can you run without a data directory?**
  - No, the current implementation requires a data source directory (defaults to CWD if not specified)
  - The `--data` flag specifies the source data location

### 2. Is cleanup the problem?
- **Root cause**: The cleanup is working correctly, but the test has incorrect expectations
- The test calls `executeTestCleanup` with `testDir: DATA_SOURCE_DIR`
- This removes the data source directory
- Then the test tries to verify the data source directory contents, causing ENOENT
- **Solution**: Don't clean up the data source directory in tests

### 3. Should we fix unit tests first?
- **Yes**, this is a better approach:
  - Unit tests are simpler and faster to fix
  - Fixing CleanupCommand validation will fix multiple unit tests
  - E2E tests depend on the correct behavior established by unit tests

### 4. Why is CleanupCommand trying to remove non-existent paths?
- **It's not** - this is a misunderstanding
- When given a non-existent `dataSourcePath`, CleanupCommand:
  1. Tries to hash the directory
  2. `hashDataDirectory` throws an error (can't read non-existent directory)
  3. CleanupCommand catches this error and adds it to `result.errors`
  4. Returns `result.success = false`
- The tests expect this to succeed, but it correctly fails
- **Solution**: Update test expectations to match this correct behavior

## Investigation Results

After examining the code, the actual issues are:

1. **CleanupCommand behavior with non-existent paths**:
   - When given a non-existent `dataSourcePath`, `hashDataDirectory` throws an error
   - This error is caught by CleanupCommand and added to `result.errors`
   - This makes `result.success = false`, which is correct behavior
   - Test expectations need to be updated to match this behavior

2. **isCleanupNeeded function**:
   - Currently checks if directory exists, not if it contains `.langton`
   - This is actually correct for execution directories
   - Test is creating directories but expecting `false` return value

3. **Bun module mocking**:
   - ES module exports are read-only in Bun
   - Need alternative testing approach without mocking

4. **happy-path test cleanup**:
   - Test cleans up data source directory then tries to read it
   - This causes ENOENT error
   - Should not clean up data source directory in tests

## Failing Tests Analysis

### 1. happy-path-e2e.test.ts

**Error**: `ENOENT: No such file or directory` when trying to read `/tests/test-area/happy-path-data`

**Root Cause**:
- The test cleans up both the execution directory AND the data source directory
- After cleanup, it tries to verify the data source directory state, but it's already been removed

**Fix**:
- Remove the verification of data source directory contents after cleanup
- Only verify that the execution directory was removed
- The data source cleanup is optional and should be handled separately

### 2. cleanup-integration.test.ts

**Multiple Issues**:

#### Issue 2.1: "returns false when no directories exist" test failing
- Test creates `testExecutionDir` in `beforeEach`
- Then calls `isCleanupNeeded(testExecutionDir)` expecting `false`
- But `isCleanupNeeded` returns `true` because the directory exists

**Root Cause**: The test name is misleading. The test creates a directory but doesn't create `.langton` inside it.

**Fix**: Update test expectations to match actual behavior, or rename test

#### Issue 2.2: "returns success when no directories to clean" test failing
- Test passes non-existent path to `executeTestCleanup`
- `CleanupCommand` tries to hash non-existent data source
- `hashDataDirectory` throws error because directory doesn't exist
- This makes `result.success = false`

**Root Cause**: This is actually correct behavior - you can't clean up a non-existent data source.

**Fix**: Update test to expect failure when given non-existent paths, or use a valid but empty execution path

#### Issue 2.3: "falls back to manual cleanup when force is true" test failing
- Test provides an invalid `dataSourcePath` that can't be hashed
- This causes CleanupCommand to fail
- With `force: true`, it should fall back to manual cleanup
- But the test expects warnings that aren't being generated

**Root Cause**: Manual cleanup fallback isn't generating the expected warning message.

**Fix**: Ensure manual cleanup generates "Performing manual cleanup" warning

#### Issue 2.4: "returns error without fallback when force is false" test failing
- Test passes non-existent data source path
- With `force: false`, it should return an error
- But CleanupCommand returns success with 0 directories removed

**Root Cause**: CleanupCommand returns success even when it can't find any directories to clean.

**Fix**: Return error when dataSourcePath is invalid and no directories can be found

### 3. cleanup-command.test.ts

**Issues**:

#### Issue 3.1: "handles errors gracefully" test failing
- Test passes non-existent path `/non-existent/path` to CleanupCommand
- Expects failure but gets success

**Root Cause**: Same as Issue 2.4 - CleanupCommand should fail when given invalid dataSourcePath.

**Fix**: Validate data source path exists before attempting to hash it

#### Issue 3.2: "only removes latest execution when multiple exist" test failing
- Test tries to mock `hashDataDirectory` function
- But Bun's ES modules have read-only exports
- Gets error: "Cannot redefine property: hashDataDirectory"

**Root Cause**: Bun doesn't allow mocking ES module exports like Jest does.

**Fix**: Create real test data with known hashes instead of mocking

### 4. checkpoint-file-resolution.test.ts

**Issues**:
- Tests timing out with git errors
- Directory cleanup between tests not working properly
- "No such file or directory" errors

**Fix**: Ensure proper test isolation and cleanup

## Implementation Plan

### Phase 1: Fix CleanupCommand Validation

Update `server/cleanup-command.ts`:

1. Add existence checks before attempting removal
2. Validate data source path exists when using hash-based cleanup
3. Return appropriate errors for non-existent paths
4. Don't report success for removing non-existent directories

```typescript
// In execute() method:
if (this.options.dataSourcePath) {
  // Validate data source exists
  if (!fs.existsSync(this.options.dataSourcePath)) {
    result.errors.push(`Data source not found: ${this.options.dataSourcePath}`);
    return result;
  }
}

// When removing directories:
for (const dir of dirsToRemove) {
  if (!fs.existsSync(dir)) {
    result.warnings.push(`Directory does not exist: ${dir}`);
    continue;
  }
  // ... rest of removal logic
}
```

### Phase 2: Fix Test Helper Functions

Update `tests/utils/cleanup-integration.ts`:

1. Fix `isCleanupNeeded` to check for `.langton` directory
2. Update manual cleanup to generate proper warnings
3. Handle non-existent paths gracefully

```typescript
export function isCleanupNeeded(executionPath?: string, testDir?: string): boolean {
  // Check execution directory has .langton
  if (executionPath && fs.existsSync(executionPath)) {
    const langtonPath = path.join(executionPath, '.langton');
    if (fs.existsSync(langtonPath)) {
      return true;
    }
  }
  // ... similar for testDir
}
```

### Phase 3: Fix E2E Test Cleanup Verification

Update `tests/e2e/happy-path-e2e.test.ts`:

1. Remove data source directory verification after cleanup
2. Only verify execution directory removal
3. Make data source cleanup optional

```typescript
// In afterAll cleanup verification:
// Remove this section that checks data source contents:
// const dataSourceContents = fs.readdirSync(DATA_SOURCE_DIR);

// Only verify execution directory is gone:
if (testState.executionPath) {
  expect(fs.existsSync(testState.executionPath)).toBe(false);
}
```

### Phase 4: Fix Unit Test Mocking

Update `tests/unit/cleanup-command.test.ts`:

1. Use real execution directories instead of mocking
2. Create proper test data structure
3. Alternative: use jest.mock() if switching test framework

```typescript
// Instead of mocking, create real test data:
const execDir1 = path.join(executionRoot, "1000000-aaa-abc123");
const execDir2 = path.join(executionRoot, "2000000-bbb-abc123");

// Create with consistent hash by using same files
await createTestDataSource(dataSourcePath);
await createExecutionDir(execDir1, dataSourcePath, "abc123");
await createExecutionDir(execDir2, dataSourcePath, "abc123");
```

### Phase 5: Fix Test Isolation

Update test setup/teardown:

1. Use unique directory names with timestamps
2. Ensure complete cleanup in afterEach
3. Add error handling for cleanup failures

```typescript
beforeEach(async () => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 6);
  tempDir = path.join("tests", "test-area", `test-${timestamp}-${random}`);
});

afterEach(async () => {
  try {
    if (fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn(`Cleanup failed: ${error}`);
  }
});
```

## Rollback E2E Test Updates

Both rollback tests need updates for execution isolation:

### rollback-improved-1-e2e.test.ts

**Required Changes**:

1. **Server startup with --data flag**:
   ```typescript
   // Update server start to use execution isolation
   testState.serverProcess = spawn(
     "bun",
     [serverPath, `--config=${PHASES_CONFIG}`, `--port=${SERVER_PORT}`,
      `--data=${TEST_DIR}`, "--no-autostart"],
     {
       cwd: process.cwd(), // Run from test runner's CWD, not TEST_DIR
       // ...
     }
   );
   ```

2. **Capture execution path from server.ready event**:
   ```typescript
   const readyEvent = await testState.client.waitForEvent("server.ready");
   if (readyEvent.type === "server.ready") {
     // Store execution path for later use
     const executionPath = readyEvent.data.executionPath;
     const dataPath = readyEvent.data.dataPath;
   }
   ```

3. **Update snapshot creation**:
   - Snapshots should capture execution directory, not TEST_DIR
   - Update paths to use execution directory for .langton files

4. **Update file system expectations**:
   - Files are created in execution directory, not TEST_DIR
   - Check `executionPath/notes` instead of `TEST_DIR/notes`

### rollback-improved-2-e2e-snapshot-tests.test.ts

**Required Changes**:

1. **Update snapshot directory structure**:
   ```typescript
   // Snapshots are now of execution directories
   const statePath = path.join(dir, ".langton", "state.json");
   const websocketLogPath = path.join(dir, ".langton", "logs", "websocket.log");
   const gitDir = path.join(dir, ".langton", "checkpoints", ".git");
   ```

2. **Fix directory hash function**:
   ```typescript
   // Update hashDirectory to handle execution isolation
   // Project files are now in the execution directory
   // Data files are in executionDir/data/
   ```

3. **Update file existence tests**:
   ```typescript
   // Instead of:
   expect(fs.existsSync(path.join(s1.directory, "notes"))).toBe(true);

   // Check in execution directory:
   expect(fs.existsSync(path.join(s1.directory, "notes"))).toBe(true);
   // Or if notes is user data:
   expect(fs.existsSync(path.join(s1.directory, "data/notes"))).toBe(true);
   ```

4. **Update rollback verification**:
   - Git checkouts should match execution directory state
   - File comparisons need to account for data/ subdirectory

### Common Updates for Both Tests

1. **Use test-helpers.ts ServerConfig properly**:
   ```typescript
   const serverConfig: ServerConfig = {
     testRunDir: TEST_RUN_DIR,
     phasesConfig: PHASES_CONFIG,
     port: SERVER_PORT,
     testMode: "rollback-test",
     cwd: process.cwd(),
     dataSourceDir: TEST_DIR,
     useDataFlag: true, // Enable execution isolation
   };
   ```

2. **Update cleanup procedures**:
   - Clean up execution directories, not just TEST_DIR
   - Use cleanup-integration helpers if possible

3. **Handle server paths correctly**:
   - Server runs in execution directory
   - Config files loaded from original locations
   - Output files created in execution directory

## Testing Strategy

1. Fix CleanupCommand validation first
2. Update test helpers to match new behavior
3. Fix individual test expectations
4. Run tests in isolation to verify fixes
5. Run full test suite to ensure no regressions

## Key Principles

1. **Fail Fast**: Validate inputs early and return appropriate errors
2. **Clear Errors**: Distinguish between warnings and errors
3. **Test Isolation**: Each test should be completely independent
4. **Real Testing**: Prefer real file operations over mocking when possible
5. **Graceful Degradation**: Handle missing directories without crashing
