# Related Code: Fixing Execution Directory Behavior

## From Step 2 Agent

The most critical code for this task lives in two files: server/index.ts (lines 256-382) handles the validation mode and server startup flow, while server/execution-setup.ts (lines 112-415) contains all the directory creation and safety logic. The main issue is that setupExecutionEnvironment() is called at index.ts:259 BEFORE the validateMode check at index.ts:327, causing unnecessary directory creation during validation. The execution-setup.ts file already has sophisticated three-tier safety logic (Tier 1: hard block on ~/.hankweave-executions/, Tier 2: require --force for existing .hankweave/, Tier 3: prompt for non-empty dirs) which is mostly working correctly, but the interaction between --start-new and existing directories needs to be clarified. A surprisingly complete test suite exists at tests/unit/execution-setup.test.ts with 598 lines covering most edge cases, which will be helpful for regression testing. The Step 3 Agent should note that validateHank() at config.ts:1214 takes an executionPath parameter but only uses it for relative path resolution in rig setup validation (line 1413), so it could potentially work with a "dry run" path that doesn't actually exist on disk.

## Key Files

### server/index.ts
- **Path**: `./tadpole/server/index.ts`
- **Relevance**: Main entry point that orchestrates the validation flow and execution setup
- **Key sections**: Lines 56-437 (entire main function)

**Critical flow issues:**
```typescript
// Line 256-272: Execution setup happens BEFORE validation check
executionSetup = await setupExecutionEnvironment({
  readOnlySourceDataPath: resolvedDataPath,
  executionPath: executionPath ? path.resolve(executionPath) : undefined,
  useSymlink: inputSourceType === "path" ? useSymlink : false,
  startNew,
  forceMode,
  skipConfirmation,
  hankPath: absoluteConfigPath,
});

// Line 327-382: Validation mode check comes AFTER setup
if (validateMode) {
  console.log(`\n🔍 Validating configuration: ${absoluteConfigPath}\n`);
  // ... validation logic
  process.exit(0);
}
```

The problem is clear: setupExecutionEnvironment() creates directories, copies/symlinks data, and writes metadata files even when --validate is specified. This should be reversed - validation should happen first without any filesystem side effects.

**Current validation flow:**
1. Parse CLI args (line 66)
2. Resolve data source (lines 193-223)
3. Resolve config path (lines 225-254)
4. **Setup execution environment** (lines 256-272) ← Creates directories!
5. Change to execution directory (line 284)
6. Check if validateMode (line 327)
7. Run validation
8. Exit

**Desired validation flow:**
1. Parse CLI args
2. If validateMode, run validation with dry-run paths and exit
3. Otherwise, proceed with normal execution setup

### server/execution-setup.ts
- **Path**: `./tadpole/server/execution-setup.ts`
- **Relevance**: Core logic for execution directory management, safety checks, and data linking
- **Key sections**: Lines 112-415 (setupExecutionEnvironment function)

**Three-tier safety system (currently working well):**

```typescript
// Tier 1: Hard block on managed execution directory (lines 163-171)
const managedExecBase = path.join(os.homedir(), ".hankweave-executions");
if (executionPath.startsWith(managedExecBase)) {
  throw new Error(
    `Cannot use ${managedExecBase}/ as explicit execution directory.\n` +
    `This location is reserved for auto-managed executions.\n` +
    `Use a different path for --execution.`,
  );
}

// Tier 2: Require --force for existing .hankweave/ (lines 173-197)
if (startNew) {
  if (fs.existsSync(executionPath)) {
    const entries = await fs.promises.readdir(executionPath);
    if (entries.length > 0) {
      const hasHankweave = entries.includes(".hankweave");
      if (hasHankweave) {
        if (forceMode) {
          // Backup existing .hankweave
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const backupPath = path.join(executionPath, `.hankweave.backup-${timestamp}`);
          await fs.promises.rename(path.join(executionPath, ".hankweave"), backupPath);
          console.log(`📦 Backed up existing execution to: ${backupPath}`);
        } else {
          throw new Error(/* ... helpful error message ... */);
        }
      }
    }
  }
}

// Tier 3: Warn and prompt for non-empty directories (lines 199-228)
else {
  // Non-empty directory without Hankweave
  const { files, directories } = await countDirectoryContents(executionPath);
  if (!skipConfirmation && !forceMode) {
    console.log(`\n⚠️  WARNING: Running in existing non-empty directory: ${executionPath}`);
    console.log(`\n  This directory contains ${files} files and ${directories} directories.`);
    // ... detailed warning
    const confirmed = await promptConfirmation("Continue?");
    if (!confirmed) {
      throw new Error("Operation cancelled by user.");
    }
  }
}
```

**Behavior with --start-new flag (lines 173-241):**

The current logic for `startNew === true` with explicit execution path:
1. If directory doesn't exist: create it (lines 234-236) ✓
2. If directory exists and has .hankweave/: backup with --force or error (lines 182-197) ✓
3. If directory exists without .hankweave/: Tier 3 safety check (lines 199-228) ✓

This is actually working correctly! The issue described in the Linear ticket about "--start-new fails if directory exists" appears to be about the Tier 2 safety requiring --force, which is intentional and correct behavior.

**Behavior without --start-new (lines 242-301):**

When `startNew === false` and executionPath is provided:
1. Directory must exist (lines 244-246) - error if doesn't exist
2. Must be a directory (lines 249-252)
3. Check for execution metadata (lines 264-266)
4. If metadata exists: verify data hash matches (lines 267-275), check for config changes (lines 277-291), mark as resuming
5. If no metadata: mark as new execution (lines 294-297)

**Auto-managed mode (lines 302-337):**

With no explicit executionPath:
- If `startNew === true`: always create new directory (lines 307-316) ✓
- If `startNew === false`: find existing by data hash or create new (lines 318-336) ✓

**Data linking (lines 339-376):**

Currently creates symlink/copy only if `isNewExecution || !fs.existsSync(dataPathInExecutionDir)` (line 343).

Issue: With `--start-new --force`, the condition should also handle overwriting existing `read_only_data_source`. The current logic will skip creating a new link if the old one exists.

```typescript
// Line 343 - needs updating for --start-new --force case
if (isNewExecution || !fs.existsSync(dataPathInExecutionDir)) {
  // create symlink or copy
}
```

Should be:
```typescript
if (isNewExecution || !fs.existsSync(dataPathInExecutionDir) || (startNew && forceMode)) {
  // Remove existing if present (for --start-new --force)
  if (fs.existsSync(dataPathInExecutionDir)) {
    await fs.promises.rm(dataPathInExecutionDir, { recursive: true, force: true });
  }
  // create symlink or copy
}
```

### server/config.ts
- **Path**: `./tadpole/server/config.ts`
- **Relevance**: Contains validateHank() function that performs configuration validation
- **Key sections**: Lines 1214-1600+ (validateHank function)

**Function signature:**
```typescript
export async function validateHank(
  configPath: string,
  executionPath: string,  // ← Used for relative path resolution
  logger: Logger,
): Promise<ValidationResult>
```

**How executionPath is used:**

The executionPath parameter is primarily used in one place:

```typescript
// Line 1413 - Rig setup validation
const targetPath = path.join(executionPath, item.copy.to);
const targetParent = path.dirname(targetPath);

try {
  const relativeParent = path.relative(executionPath, targetParent);
  if (relativeParent.startsWith("..")) {
    throw new Error(
      `${codonLabel}, rig setup item ${itemIndex + 1}: ` +
      `Target path "${item.copy.to}" would write outside execution directory`,
    );
  }
}
```

This validates that rig setup `copy` operations don't write outside the execution directory. It doesn't actually read or write files - it's just path validation.

**Implications for --validate mode:**

Since validateHank() only uses executionPath for path validation (not actual file I/O), it could work with a hypothetical path that doesn't exist. We could:
1. Pass a temporary/dummy path for validation
2. Or pass the current working directory
3. Or determine what the execution path WOULD be without creating it

Option 3 seems cleanest - we can implement a "dry run" version of setupExecutionEnvironment() that returns what paths would be used without actually creating anything.

### server/cli-parser.ts
- **Path**: `./tadpole/server/cli-parser.ts`
- **Relevance**: Parses CLI arguments including --validate, --start-new, and --force flags
- **Key sections**: Lines 20-35 (flag definitions), 82-92 (result type), 225-235 (parsing)

**Flag parsing:**
```typescript
// Lines 20-35: Boolean flags definition
const BOOLEAN_FLAGS = new Set([
  "--headless",
  "--validate",
  "-v",
  "--cleanup",
  "-y",
  "--no-autostart",
  "--proxy",
  "--start-new",  // ← New flag for explicit new execution
  "--init",
  "--help",
  "-h",
  "--force",      // ← Force operation in existing directories
]);

// Lines 82-92: Result type
export interface CliArgs {
  // ... other fields
  validate?: boolean;     // --validate, -v
  skipConfirmation?: boolean; // -y
  startNew?: boolean;     // --start-new
  force?: boolean;        // --force
  // ...
}

// Lines 225-235: Parsing
result.validate = args.includes("--validate") || args.includes("-v");
result.skipConfirmation = args.includes("-y");
result.startNew = args.includes("--start-new");
result.force = args.includes("--force");
```

All the necessary flags are already defined and parsed correctly. No changes needed here.

### server/data-hasher.ts
- **Path**: `./tadpole/server/data-hasher.ts`
- **Relevance**: Provides hashDataSource() and findExecutionDirs() used by execution setup
- **Key sections**: Used but not modified by this task

The data hashing logic is used to:
1. Calculate hash of data source (for resume detection)
2. Find existing execution directories with matching hash

No changes needed to this file.

## Patterns to Follow

### Three-Tier Safety System

The existing safety system is well-designed and should be preserved:

**Tier 1: Hard Block**
- Prevent using `~/.hankweave-executions/` as explicit execution path
- This location is reserved for auto-managed executions
- Error message is clear and helpful

**Tier 2: Existing Hankweave Execution**
- Directory already has `.hankweave/` folder
- Without `--force`: hard error with helpful options
- With `--force`: backup existing `.hankweave.backup-{timestamp}` and proceed
- Clear user intent required via `--force` flag

**Tier 3: Non-Empty Directory**
- Directory exists but has no `.hankweave/`
- Show warning with file/directory counts
- Prompt for confirmation (unless `-y` or `--force`)
- In non-interactive mode (CI/tests): auto-reject for safety

### Confirmation Prompting

The promptConfirmation() function (lines 43-69) handles interactive vs non-interactive environments well:

```typescript
async function promptConfirmation(message: string): Promise<boolean> {
  // In non-interactive mode (CI, tests, pipes), default to false (don't continue)
  if (isNonInteractive()) {
    console.warn("⚠️  Non-interactive mode, skipping confirmation prompt.");
    return false;
  }
  // ... interactive prompt with 30s timeout
}
```

This pattern should be maintained - safe defaults in non-interactive mode.

### Error Messages

The codebase has excellent, helpful error messages:

```typescript
throw new Error(
  `Directory already contains Hankweave execution: ${executionPath}\n` +
  `Options:\n` +
  `  1. Remove .hankweave/ directory and try again\n` +
  `  2. Use --force to backup existing state and start fresh\n` +
  `  3. Use a different directory`,
);
```

When writing new error messages, follow this pattern:
- State the problem clearly
- Provide numbered options for resolution
- Reference relevant flags when applicable

### Console Output

Consistent console output patterns:
- `📁` for directory operations
- `🔗` for linking operations
- `⚠️` for warnings
- `❌` for errors
- `✅` for success
- `🔍` for validation
- `📦` for backups

## Dependencies and Connections

### File Dependencies

```
server/index.ts
  ├── imports setupExecutionEnvironment from execution-setup.ts
  ├── imports validateHank from config.ts
  ├── imports parseCliArgs from cli-parser.ts
  └── uses ExecutionSetup interface

server/execution-setup.ts
  ├── imports hashDataSource, findExecutionDirs from data-hasher.ts
  └── exports ExecutionSetup interface and setupExecutionEnvironment

server/config.ts
  ├── imports Logger from utils.ts
  └── exports validateHank function

server/cli-parser.ts
  └── exports CliArgs interface and parseCliArgs
```

### Test Dependencies

```
tests/unit/execution-setup.test.ts
  ├── tests setupExecutionEnvironment with various flag combinations
  ├── covers all three safety tiers
  ├── tests auto-managed vs explicit paths
  ├── tests symlink vs copy behavior
  └── 598 lines, very comprehensive

tests/unit/cli-parser.test.ts
  └── tests CLI argument parsing

tests/e2e/happy-path-e2e.test.ts
tests/e2e/hankweave-server.test.ts
  └── likely test full execution flow including setup
```

### Related Linear Tickets

**ENG-88: "Run strands in existing run directories" (Done)**
- Implemented the ability to run in existing directories with --start-new and --force
- Added the three-tier safety system
- This ticket laid the groundwork for the current safety logic

**ENG-90: "Fixing execution directory behavior" (In Progress)**
- Current ticket
- Builds on ENG-88 to clarify validation behavior and --start-new semantics

## Code Patterns Observed

### 1. Path Resolution Pattern

```typescript
// Always resolve paths to absolute early
const absoluteConfigPath = path.isAbsolute(configPath)
  ? configPath
  : path.resolve(originalCwd, configPath);

// Keep track of original CWD before changing directories
const originalCwd = process.cwd();
// ... change directory later
process.chdir(executionSetup.executionPath);
```

### 2. Metadata Pattern

Execution metadata is stored in `.hankweave/execution-meta.json`:

```typescript
{
  version: "1.0.0",
  readOnlySourceDataPath: string,      // Original path provided
  readOnlySourceResolvedDataPath: string, // Resolved via realpath()
  dataHash: string,
  hankHash?: string,                   // Hash of hank.json content
  hankPath?: string,                   // Path to hank.json
  linkType: "symlink" | "copy",
  createdAt: string,                   // ISO timestamp
  lastUsed: string,                    // ISO timestamp, updated on resume
}
```

### 3. Error Handling Pattern

```typescript
try {
  // operation
} catch (error) {
  console.error(`❌ ${(error as Error).message}`);
  process.exit(1);
}
```

Consistently exit with code 1 on errors, log with ❌ prefix.

### 4. Template Variables

The codebase uses template variables in prompts:
- `<%EXECUTION_DIR%>` - The execution directory path
- `<%DATA_DIR%>` - The data directory path (execution-dir/read_only_data_source)

These are mentioned in help text (index.ts:134-136).

## Naming Conventions

### Historical Naming Issue

The code uses `.hankweave` but the Linear ticket mentions `.strandweave`. This appears to be from the project's renaming:
- Old name: Strand/Strandweave
- New name: Hank/Hankweave

The code is correct (uses `.hankweave`), the Linear ticket description is just using old terminology.

### Directory Structure

```
~/.hankweave-executions/           # Auto-managed execution root
  ├── {timestamp}-{random}-{hash-prefix}/  # Auto-created execution dir
  │   ├── .hankweave/              # Execution metadata
  │   │   └── execution-meta.json
  │   └── read_only_data_source/   # Symlink or copy to data
  └── ...

/path/to/custom/execution/         # User-specified execution dir
  ├── .hankweave/                  # Execution metadata
  │   └── execution-meta.json
  ├── read_only_data_source/       # Symlink or copy to data
  └── ... (user's existing files)
```

## Edge Cases to Consider

### 1. Validation Mode Edge Cases

Current behavior: Creates full execution directory before validating.

Issues:
- Wastes disk space for dry-run validation
- Confusing for users expecting no side effects
- Creates orphaned directories if validation fails

### 2. Race Conditions

Auto-managed directory creation uses timestamp + random:
```typescript
const timestamp = Date.now();
const random = Math.random().toString(36).substring(2, 6);
const dirName = `${timestamp}-${random}-${dataHash.substring(0, 6)}`;
```

This should prevent collisions even with concurrent executions.

### 3. Symlink Failures

```typescript
try {
  await fs.promises.symlink(readOnlySourceDataPath, dataPathInExecutionDir, "dir");
} catch (error) {
  console.warn(`Failed to create symlink for directory: ${error}. Falling back to copy.`);
  await copyDirectory(readOnlySourceDataPath, dataPathInExecutionDir);
  linkType = "copy";
}
```

Good fallback pattern - if symlink fails, automatically fall back to copy.

### 4. Data Source as File

The code handles both file and directory data sources (lines 357-375):
- For directories: symlink/copy the directory
- For files: create `read_only_data_source/` directory, then symlink/copy file into it

This is important for stdin/inline input scenarios.

### 5. Confirmation Timeout

The promptConfirmation has a 30-second timeout (line 61):
```typescript
const timeout = setTimeout(() => {
  rl.close();
  console.warn("\n⚠️  Prompt timed out, defaulting to no.");
  resolve(false);
}, 30000);
```

Good defensive measure against hanging processes.

## Open Questions from Code Review

### Q1: Should --force skip data hash validation?

Currently (line 285), when resuming with config changes, both `--force` and `-y` skip the confirmation prompt. But the data hash check (lines 269-274) still enforces exact hash match.

With `--start-new --force`, should we allow running with different data in the same execution directory? The Linear ticket says "overwrite read_only_data_source in existing dir" which suggests yes.

### Q2: What about hank hash changes with --start-new --force?

Line 278-283 warns about hank.json changes and prompts for confirmation. With `--start-new --force`, should this warning be skipped since the user is explicitly forcing a fresh start?

### Q3: Should validation work on non-existent execution directories?

If user runs `hankweave --validate --execution /some/new/path`, should it:
A) Error because path doesn't exist
B) Validate as if it would create that path
C) Validate using current directory

The current implementation would create the directory (wrong for validation mode).

## Summary for Step 3 Agent

The core issue is architectural: setupExecutionEnvironment() is called too early in the flow. The fix involves:

1. **Refactor index.ts** to check validateMode before calling setupExecutionEnvironment()
2. **Create dry-run function** that determines execution paths without filesystem operations
3. **Update data linking** in execution-setup.ts to handle `--start-new --force` properly
4. **Preserve existing safety** - the three-tier system is working well

The test suite is comprehensive and will catch regressions. The error messages are excellent and should be maintained. The overall code quality is high - this is a refinement task, not a major refactor.
