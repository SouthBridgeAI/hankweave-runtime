# ENG-88: Run in Existing Directories - Related Code

## Current Execution Setup (`server/execution-setup.ts`)

**Lines 57-123: Explicit execution path handling**
```typescript
if (executionPath) {
  // Explicit execution path provided

  if (startNew) {
    // With --start-new, directory must not exist OR be empty
    if (fs.existsSync(executionPath)) {
      const entries = await fs.promises.readdir(executionPath);
      if (entries.length > 0) {
        throw new Error(
          `Cannot use --start-new with non-empty execution directory`
        );
      }
      // Directory exists but is empty - OK to use
    }
    isNewExecution = true;
  } else {
    // Without --start-new, existing logic applies
    if (!fs.existsSync(executionPath)) {
      throw new Error(`Execution directory not found: ${executionPath}`);
    }

    // Check if it has execution metadata
    const metaPath = path.join(executionPath, '.hankweave', 'execution-meta.json');
    if (fs.existsSync(metaPath)) {
      // Verify data hash matches
      const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
      if (meta.dataHash !== dataHash) {
        throw new Error(`Data source mismatch`);
      }
      isResuming = true;
    } else {
      // Directory exists but no metadata - treat as fresh execution
      isNewExecution = true;
    }
  }
}
```

**Current behavior**:
- `--execution=<path>` without `--start-new`: Must be existing Hankweave execution dir
- `--execution=<path>` with `--start-new`: Must be empty or non-existent
- No `--execution`: Auto-creates in ~/.hankweave-executions/

**Problem**: Can't use arbitrary existing directory as workspace!

## What Needs to Change

### Allow Non-Empty Directories with `--start-new`

**Current restriction** (line 63-69):
```typescript
if (entries.length > 0) {
  throw new Error(
    `Cannot use --start-new with non-empty execution directory`
  );
}
```

**Proposed behavior**:
```typescript
if (entries.length > 0) {
  // Check if directory contains Hankweave metadata
  const hasHankweaveMeta = entries.includes('.hankweave');

  if (hasHankweaveMeta) {
    // This is already a Hankweave execution - error
    throw new Error(
      `Directory contains existing Hankweave execution. ` +
      `Remove .hankweave/ directory or use a different path.`
    );
  }

  // Non-Hankweave directory - allow with warning
  console.warn(
    `⚠️  Using existing non-empty directory as execution workspace.\n` +
    `  Files in this directory will be accessible to the execution.\n` +
    `  Hankweave metadata will be created in .hankweave/ subdirectory.`
  );
}
```

### Use Cases This Enables

1. **Run in project directory**:
   ```bash
   cd ~/my-project
   hankweave --execution=. --start-new hank.json .
   ```

2. **Run in specific workspace**:
   ```bash
   hankweave --execution=/workspace/analysis --start-new analysis.json /data
   ```

3. **Multiple executions in same directory** (if needed):
   ```bash
   # Different Hankweave runs can coexist if we allow multiple .hankweave-<id> dirs
   # But this is probably not necessary - one .hankweave per directory is cleaner
   ```

## Safety Considerations

### Protect Against Accidental Data Loss

**Risk**: User runs in directory with important files, execution modifies/deletes them.

**Mitigation 1**: Prominent warning (already in proposed code above).

**Mitigation 2**: Dry-run mode (show what would be created):
```bash
hankweave --execution=. --dry-run hank.json
# Output:
# Would create:
#   ./.hankweave/
#   ./.hankweave/checkpoints/
#   ./read_only_data_source/ (symlink)
# Proceed? [y/N]
```

**Mitigation 3**: Require explicit confirmation:
```bash
hankweave --execution=/important/dir --start-new hank.json
# Output:
# ⚠️  WARNING: Running in existing directory: /important/dir
# This directory contains 147 files and 23 directories.
# Hankweave will create .hankweave/ metadata in this location.
#
# Continue? [y/N]
```

### Prevent Nested Executions

**Current check** (line 94-96):
```typescript
if (executionPath.includes('/.hankweave-executions/') && executionPath.includes('/data')) {
  throw new Error('Cannot create execution inside another execution directory');
}
```

**Need to enhance**:
```typescript
// Check if path is inside ~/.hankweave-executions/
if (executionPath.startsWith(path.join(os.homedir(), '.hankweave-executions'))) {
  throw new Error(
    'Cannot use ~/.hankweave-executions/ as explicit execution directory. ' +
    'This location is reserved for auto-managed executions.'
  );
}

// Check if path contains .hankweave already
if (fs.existsSync(path.join(executionPath, '.hankweave'))) {
  throw new Error(
    'Directory already contains Hankweave execution. ' +
    'Remove .hankweave/ or choose different directory.'
  );
}
```

## Summary

**Changes needed**:
1. Remove non-empty directory restriction with `--start-new` (line 63-69)
2. Add warning when using existing directories
3. Add confirmation prompt (respecting `-y` flag)
4. Enhance nested execution prevention
5. Update help text to document this behavior

**Complexity**: Low-Medium (~200 lines including safety checks and prompts)
