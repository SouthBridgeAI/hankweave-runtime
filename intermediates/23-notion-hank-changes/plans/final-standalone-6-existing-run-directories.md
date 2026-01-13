# ENG-88: Run Hanks in Existing Run Directories

> **Implementation Order:** Phase 3 (with ENG-91) - See [00-index.md](00-index.md) for full context

## Related Plans

This task should be implemented alongside ENG-91 as they both modify `execution-setup.ts`:

- **[ENG-91: Config Warnings Resume](final-standalone-5-config-warnings-resume.md)** - Both address execution directory safety; coordinate changes to `execution-setup.ts`
- **[ENG-105: Repository URLs](final-standalone-1-repository-link-hank.md)** - Security prompts in both tasks should use consistent patterns

## Task Summary

Allow users to run Hankweave in existing non-empty directories (like project directories), rather than forcing creation of empty execution directories. The current restriction is too rigid for practical workflows. This requires implementing a tiered safety system to prevent dangerous operations while enabling flexibility.

**Original Request (Hrishi Olickel):**
> "This in some ways is figuring out how to run hanks in non-empty run directories - which is a really really useful feature. My thinking is:
> 1. If there's no .hankweave folder, just go ahead and run.
> 2. If there is, require `start-new`, which will backup the old .hankweave folder and start fresh. And warn users this is what will happen."

## Sources and Context

### Linear Ticket
- **Identifier:** ENG-88
- **Status:** In Progress
- **Priority:** Medium
- **Labels:** Improvement
- **Created:** 2025-12-18

### Related Issues
- **ENG-90:** Fixing execution directory behavior (Urgent) - Detailed specification
- **ENG-91:** Config warnings when resuming (Medium) - Related symptom

### Original Planning Documents
The following documents were synthesized by the Step 4 Agent to create this plan:
- [`supporting-docs/6-existing-run-directories-full-task.md`](supporting-docs/6-existing-run-directories-full-task.md) - Original task with Step 1/2/3 agent analysis
- [`supporting-docs/6-existing-run-directories-related-code.md`](supporting-docs/6-existing-run-directories-related-code.md) - Codebase integration points
- [`supporting-docs/6-existing-run-directories-changes-decisions-and-judgement-calls.md`](supporting-docs/6-existing-run-directories-changes-decisions-and-judgement-calls.md) - Technical decisions

### Current Code Restriction (from Step 2 Agent)

The Step 2 Agent identified the current restriction in `server/execution-setup.ts` (lines 63-69):

```typescript
if (startNew) {
  if (fs.existsSync(executionPath)) {
    const entries = await fs.promises.readdir(executionPath);
    if (entries.length > 0) {
      throw new Error(
        `Cannot use --start-new with non-empty execution directory`
      );
    }
  }
}
```

**Problem:** This prevents users from using their project directories as execution workspaces, which is a common and valid use case.

### Research Findings (from Step 3 Agent)

The Step 3 Agent validated the three-tier safety approach:

> "The three-tier safety system proposed in Step 2 is well-designed and follows security best practices. The key insight is distinguishing between 'this is obviously dangerous' (Tier 1: inside .hankweave-executions), 'this needs explicit confirmation' (Tier 2: existing Hankweave state), and 'user might know what they're doing' (Tier 3: non-empty directory). This mirrors how other tools handle potentially destructive operations - Git won't let you init in a repo but warns about untracked files, Docker warns about overwriting containers, etc."

## Decision Points and Judgement Calls

### Decision 1: Three-Tier Safety System

**The Step 4 Agent recommends:** Implement graduated safety based on risk level.

| Tier | Condition | Behavior |
|------|-----------|----------|
| 1 | Path inside `~/.hankweave-executions/` | **Hard error** - Always blocked |
| 2 | Directory contains `.hankweave/` | **Hard error** - Blocked unless `--force` |
| 3 | Non-empty directory without Hankweave | **Warning + prompt** - Confirm unless `-y` |

**Rationale:**
- Tier 1 protects the managed execution space from corruption
- Tier 2 prevents accidental overwrite of previous execution state
- Tier 3 enables legitimate workflow while ensuring user awareness

### Decision 2: Allow Non-Empty Directories

**The Step 4 Agent recommends:** Remove the non-empty directory restriction, replacing it with warnings and prompts.

**Use cases this enables:**

1. **Run in project directory:**
   ```bash
   cd ~/my-project
   hankweave --execution=. --start-new hank.json .
   ```

2. **Run in specific workspace:**
   ```bash
   hankweave --execution=/workspace/analysis --start-new analysis.json /data
   ```

3. **Iterative development:**
   ```bash
   # Run hank, review results, modify hank, run again
   hankweave --execution=./workspace --start-new updated-hank.json /data
   ```

### Decision 3: Confirmation Behavior

**The Step 4 Agent recommends:** Tiered confirmation requirements.

| Flag | Tier 1 | Tier 2 | Tier 3 |
|------|--------|--------|--------|
| No flags | Error | Error | Prompt |
| `-y` | Error | Error | Skip prompt, warn |
| `--force` | Error | Skip error, backup | Skip prompt |
| `-y --force` | Error | Skip error, backup | Skip prompt |

**Note:** Tier 1 (managed execution directory) is ALWAYS an error - this is critical infrastructure protection.

### Decision 4: Backup Behavior for Existing .hankweave

**The Step 4 Agent recommends:** When `--force` is used on a directory with existing `.hankweave/`:

1. Backup to `.hankweave.backup-{timestamp}/`
2. Log the backup location
3. Create fresh `.hankweave/`

**Backup naming:**
```
.hankweave.backup-2026-01-13T143022
```

### Decision 5: Safety Warnings Must Be Prominent

**The Step 4 Agent recommends:** Clear, prominent warnings that explain the risks.

**Example warning for Tier 3:**
```
⚠️  WARNING: Running in existing non-empty directory: /home/user/my-project

  This directory contains 147 files and 23 directories.
  Hankweave agents will have access to READ and MODIFY files in this directory.

  Hankweave will create:
    ./.hankweave/           (execution metadata)
    ./read_only_data_source/  (symlink to data)

  IMPORTANT: Always use version control. Test hanks on non-critical directories first.

Continue? [y/N]
```

## Implementation Plan

### Step 1: Add Tier 1 Check (Managed Directory Protection)

**File: `server/execution-setup.ts` (before line 57)**

```typescript
import os from 'node:os';

// Tier 1: Hard error for managed execution directory
const managedExecBase = path.join(os.homedir(), '.hankweave-executions');
if (executionPath.startsWith(managedExecBase)) {
  throw new Error(
    `Cannot use ${managedExecBase}/ as explicit execution directory.\n` +
    `This location is reserved for auto-managed executions.\n` +
    `Use a different path for --execution.`
  );
}
```

### Step 2: Modify Tier 2 Check (Existing Hankweave)

**File: `server/execution-setup.ts` (replace lines 63-69)**

```typescript
if (startNew && fs.existsSync(executionPath)) {
  const entries = await fs.promises.readdir(executionPath);

  if (entries.length > 0) {
    const hasHankweave = entries.includes('.hankweave');

    // Tier 2: Directory already has Hankweave execution
    if (hasHankweave) {
      if (forceMode) {
        // Backup existing .hankweave
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupPath = path.join(executionPath, `.hankweave.backup-${timestamp}`);
        await fs.promises.rename(
          path.join(executionPath, '.hankweave'),
          backupPath
        );
        console.log(`📦 Backed up existing execution to: ${backupPath}`);
      } else {
        throw new Error(
          `Directory already contains Hankweave execution: ${executionPath}\n` +
          `Options:\n` +
          `  1. Remove .hankweave/ directory and try again\n` +
          `  2. Use --force to backup existing state and start fresh\n` +
          `  3. Use a different directory`
        );
      }
    }

    // Tier 3: Non-Hankweave non-empty directory
    if (!hasHankweave) {
      await warnAboutExistingDirectory(executionPath, entries, skipConfirmation);
    }
  }
}
```

### Step 3: Add Tier 3 Warning Function

**File: `server/execution-setup.ts` (new function)**

```typescript
import readline from 'node:readline';

async function warnAboutExistingDirectory(
  executionPath: string,
  entries: string[],
  skipConfirmation: boolean
): Promise<void> {
  // Count files and directories
  let fileCount = 0;
  let dirCount = 0;
  for (const entry of entries) {
    const stat = await fs.promises.stat(path.join(executionPath, entry));
    if (stat.isDirectory()) {
      dirCount++;
    } else {
      fileCount++;
    }
  }

  console.warn(`\n⚠️  WARNING: Running in existing non-empty directory: ${executionPath}\n`);
  console.warn(`  This directory contains ${fileCount} files and ${dirCount} directories.`);
  console.warn(`  Hankweave agents will have access to READ and MODIFY files in this directory.\n`);
  console.warn(`  Hankweave will create:`);
  console.warn(`    ./.hankweave/           (execution metadata)`);
  console.warn(`    ./read_only_data_source/  (symlink to data)\n`);
  console.warn(`  IMPORTANT: Always use version control. Test hanks on non-critical directories first.\n`);

  if (!skipConfirmation) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>(resolve => {
      rl.question('Continue? [y/N] ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      throw new Error('Aborted by user. Use a different directory or add -y to skip confirmation.');
    }
  }

  console.log('Proceeding with existing directory...\n');
}
```

### Step 4: Add --force Flag Support

**File: `server/index.ts` (around line 80)**

Add to valid patterns:
```typescript
/^--force$/,
```

Add to argument parsing:
```typescript
const forceMode = args.includes('--force');
```

Pass to execution setup:
```typescript
executionSetup = await setupExecutionEnvironment({
  readOnlySourceDataPath: resolvedDataPath,
  executionPath: executionPath ? path.resolve(executionPath) : undefined,
  useSymlink,
  startNew,
  skipConfirmation,  // Already exists
  forceMode,         // NEW
});
```

### Step 5: Update Function Signature

**File: `server/execution-setup.ts`**

```typescript
interface ExecutionSetupOptions {
  readOnlySourceDataPath: string;
  executionPath?: string;
  useSymlink?: boolean;
  startNew?: boolean;
  skipConfirmation?: boolean;
  forceMode?: boolean;  // NEW
}

export async function setupExecutionEnvironment(
  options: ExecutionSetupOptions
): Promise<ExecutionSetup> {
  const { forceMode = false, skipConfirmation = false } = options;
  // ... rest of implementation
}
```

### Step 6: Update Help Text

**File: `server/index.ts` (help text section)**

Add documentation:
```typescript
console.log(`
Options:
  --execution <path>        Use specific directory for execution
  --start-new               Force creation of a new execution
  --force                   Force overwrite of existing Hankweave state (backups created)
  -y                        Skip confirmation prompts

Running in Project Directories:
  You can run Hankweave directly in your project directory:

    cd ~/my-project
    hankweave --execution=. --start-new hank.json .

  This creates a .hankweave/ subdirectory while leaving your files intact.
  ⚠️  Note: Hankweave agents will have access to modify files in the directory.
`);
```

## Code Integration Points

### Primary: `server/execution-setup.ts`

- Lines 57-123: Main logic for execution path handling
- New function: `warnAboutExistingDirectory()`
- Updated signature: Add `forceMode` parameter

### Secondary: `server/index.ts`

- Lines 72-93: Add `--force` to valid patterns
- Lines 101-111: Parse `--force` flag
- Lines 214-219: Pass `forceMode` to setup function
- Help text: Document new behavior

## Testing Strategy

This feature implements a three-tier safety system for running in non-empty directories. Testing should focus on correctly identifying tiers, enforcing safety rules, creating backups, and displaying appropriate warnings.

### Unit Tests (tests/unit/execution-directory-safety.test.ts)

Focus on tier detection logic:

```typescript
describe("Safety Tier Detection", () => {
  test("Tier 1: identifies managed execution directory", () => {
    const managedPath = path.join(os.homedir(), '.hankweave-executions', 'test-123');
    expect(isManagedExecutionDirectory(managedPath)).toBe(true);
  });

  test("Tier 1: blocks managed execution directory", async () => {
    const managedPath = path.join(os.homedir(), '.hankweave-executions', 'test');
    await expect(setupExecutionEnvironment({
      readOnlySourceDataPath: '/data',
      executionPath: managedPath,
      startNew: true,
    })).rejects.toThrow(/reserved for auto-managed executions/);
  });

  test("Tier 1: allows managed directory for resume (not startNew)", async () => {
    const managedPath = path.join(os.homedir(), '.hankweave-executions', 'test');
    await fs.promises.mkdir(managedPath, { recursive: true });

    // Resume (not startNew) should be allowed
    const result = await setupExecutionEnvironment({
      readOnlySourceDataPath: '/data',
      executionPath: managedPath,
      startNew: false, // Resume mode
    });

    expect(result.executionPath).toBe(managedPath);
  });

  test("Tier 2: identifies directory with .hankweave", () => {
    const dir = '/path/to/dir';
    const entries = ['.hankweave', 'file.txt', 'other.md'];
    expect(hasHankweaveState(entries)).toBe(true);
  });

  test("Tier 2: blocks existing .hankweave without --force", async () => {
    const testDir = await createTempDirWithHankweave();
    await expect(setupExecutionEnvironment({
      readOnlySourceDataPath: '/data',
      executionPath: testDir,
      startNew: true,
      forceMode: false,
    })).rejects.toThrow(/already contains Hankweave execution/);
  });

  test("Tier 2: allows existing .hankweave with --force", async () => {
    const testDir = await createTempDirWithHankweave();
    const result = await setupExecutionEnvironment({
      readOnlySourceDataPath: '/data',
      executionPath: testDir,
      startNew: true,
      forceMode: true,
      skipConfirmation: true,
    });

    expect(result.isNewExecution).toBe(true);
    // Verify backup was created
    const entries = await fs.promises.readdir(testDir);
    const backups = entries.filter(e => e.startsWith('.hankweave.backup-'));
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/\.hankweave\.backup-\d{4}-\d{2}-\d{2}T\d{6}/);
  });

  test("Tier 3: identifies non-empty directory", () => {
    const entries = ['file1.txt', 'dir1', 'file2.md'];
    expect(isNonEmptyDirectory(entries)).toBe(true);
    expect(hasHankweaveState(entries)).toBe(false);
  });

  test("Tier 3: allows non-empty directory with confirmation", async () => {
    const testDir = await createTempDirWithFiles(['file.txt', 'package.json']);
    const result = await setupExecutionEnvironment({
      readOnlySourceDataPath: '/data',
      executionPath: testDir,
      startNew: true,
      skipConfirmation: true, // Skip prompt for test
    });

    expect(result.isNewExecution).toBe(true);
  });
});
```

**Rationale:** Tier detection is the core safety logic. Misidentifying tiers could lead to data loss or unnecessarily blocked operations.

### Integration Tests (tests/integration/execution-directory-workflows.test.ts)

Test real-world workflows:

```typescript
describe("Execution Directory Workflows", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join('tests', 'test-area', `exec-dir-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("run in project directory workflow", async () => {
    // Create a "project" directory with some files
    const projectDir = path.join(tempDir, 'my-project');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), '', { recursive: true });

    // Run Hankweave with execution in project directory
    const result = await runHankweave({
      executionPath: projectDir,
      startNew: true,
      skipConfirmation: true,
      config: TEST_HANK,
      data: TEST_DATA,
    });

    expect(result.success).toBe(true);

    // Verify .hankweave was created
    expect(fs.existsSync(path.join(projectDir, '.hankweave'))).toBe(true);

    // Verify original files still exist
    expect(fs.existsSync(path.join(projectDir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'src', 'index.ts'))).toBe(true);
  });

  test("force overwrite creates timestamped backup", async () => {
    const dir = path.join(tempDir, 'with-hankweave');
    fs.mkdirSync(path.join(dir, '.hankweave'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.hankweave', 'state.json'), '{"test": true}');

    const beforeTime = new Date();

    await runHankweave({
      executionPath: dir,
      startNew: true,
      forceMode: true,
      skipConfirmation: true,
      config: TEST_HANK,
      data: TEST_DATA,
    });

    const afterTime = new Date();

    // Verify backup exists
    const entries = fs.readdirSync(dir);
    const backups = entries.filter(e => e.startsWith('.hankweave.backup-'));
    expect(backups.length).toBe(1);

    // Verify backup contains old state
    const backupState = JSON.parse(
      fs.readFileSync(path.join(dir, backups[0], 'state.json'), 'utf-8')
    );
    expect(backupState.test).toBe(true);

    // Verify backup timestamp is reasonable
    const timestamp = backups[0].match(/\.hankweave\.backup-(.+)/)[1];
    const backupTime = new Date(timestamp.replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'));
    expect(backupTime.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    expect(backupTime.getTime()).toBeLessThanOrEqual(afterTime.getTime());
  });

  test("warns about file count in non-empty directory", async () => {
    const dir = path.join(tempDir, 'populated');
    fs.mkdirSync(dir);
    // Create various files and directories
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(dir, `file${i}.txt`), 'content');
    }
    fs.mkdirSync(path.join(dir, 'dir1'));
    fs.mkdirSync(path.join(dir, 'dir2'));

    let warningMessage = '';
    const mockWarn = (msg: string) => { warningMessage += msg; };

    await setupExecutionEnvironment({
      readOnlySourceDataPath: '/data',
      executionPath: dir,
      startNew: true,
      skipConfirmation: true,
      warnFunction: mockWarn,
    });

    expect(warningMessage).toContain('10 files');
    expect(warningMessage).toContain('2 directories');
    expect(warningMessage).toContain('READ and MODIFY');
  });
});
```

**Rationale:** These tests verify the feature works in realistic scenarios: running in project directories, force overwriting with backups, and appropriate warnings.

### Integration Tests: Confirmation Prompts

```typescript
describe("User Confirmation Prompts", () => {
  test("prompts user for non-empty directory", async () => {
    const dir = await createTempDirWithFiles(['file.txt']);
    const mockPrompt = jest.fn().mockResolvedValue('y');

    await setupExecutionEnvironment({
      readOnlySourceDataPath: '/data',
      executionPath: dir,
      startNew: true,
      skipConfirmation: false,
      promptFunction: mockPrompt,
    });

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining('non-empty directory')
    );
  });

  test("user declining prompt aborts", async () => {
    const dir = await createTempDirWithFiles(['file.txt']);
    const mockPrompt = jest.fn().mockResolvedValue('n');

    await expect(setupExecutionEnvironment({
      readOnlySourceDataPath: '/data',
      executionPath: dir,
      startNew: true,
      skipConfirmation: false,
      promptFunction: mockPrompt,
    })).rejects.toThrow('Aborted by user');
  });

  test("-y flag skips confirmation", async () => {
    const dir = await createTempDirWithFiles(['file.txt']);
    const mockPrompt = jest.fn();

    const result = await setupExecutionEnvironment({
      readOnlySourceDataPath: '/data',
      executionPath: dir,
      startNew: true,
      skipConfirmation: true,
      promptFunction: mockPrompt,
    });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(result.isNewExecution).toBe(true);
  });

  test("--force does not prompt for Tier 3", async () => {
    const dir = await createTempDirWithFiles(['file.txt']);
    const mockPrompt = jest.fn();

    await setupExecutionEnvironment({
      readOnlySourceDataPath: '/data',
      executionPath: dir,
      startNew: true,
      forceMode: true,
      skipConfirmation: false, // Force should skip prompt even without -y
      promptFunction: mockPrompt,
    });

    expect(mockPrompt).not.toHaveBeenCalled();
  });
});
```

**Rationale:** User confirmation is critical for safety. These tests ensure prompts work correctly and bypass mechanisms function as expected.

### E2E Test: Attach to Existing Suite

Add to tests/e2e/happy-path-e2e.test.ts:

```typescript
describe("Non-Empty Execution Directories", () => {
  test("runs in project directory with --execution=.", async () => {
    // Create a temporary project directory
    const projectDir = path.join(TEST_AREA, `project-${Date.now()}`);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Test Project');

    const result = await startServer({
      config: TEST_HANK_PATH,
      args: [
        `--execution=${projectDir}`,
        '--start-new',
        '-y',
        '--data', TEST_DATA_DIR,
      ],
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.hankweave'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'README.md'))).toBe(true);
  });

  test("--force creates backup and continues", async () => {
    // First run to create .hankweave
    const dir = path.join(TEST_AREA, `force-test-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });

    await startServer({
      config: TEST_HANK_PATH,
      args: [`--execution=${dir}`, '--start-new', '-y', '--data', TEST_DATA_DIR],
    });

    // Second run with --force should backup and continue
    const result = await startServer({
      config: TEST_HANK_PATH,
      args: [`--execution=${dir}`, '--start-new', '--force', '-y', '--data', TEST_DATA_DIR],
    });

    expect(result.success).toBe(true);
    const entries = fs.readdirSync(dir);
    expect(entries.some(e => e.startsWith('.hankweave.backup-'))).toBe(true);
  });
});
```

**Rationale:** E2E tests verify the complete workflow including the TUI, backup creation, and execution in non-empty directories.

## Complexity Assessment

**Overall complexity:** Low-Medium

**Breakdown:**
- Remove restriction: ~5 lines (delete error)
- Tier 1 check: ~15 lines
- Tier 2 check with backup: ~30 lines
- Tier 3 warning function: ~50 lines
- Flag parsing: ~10 lines
- Help text updates: ~20 lines
- Type/signature updates: ~10 lines

**Total new code:** ~140 lines
**Total effort:** 4-5 hours

## Risk Mitigation

### Risk 1: Users Accidentally Running in Important Directories
**Mitigation:** Prominent warnings showing file counts and explaining risks. Confirmation prompt unless `-y`.

### Risk 2: Losing Previous Execution State
**Mitigation:** Automatic backup to timestamped directory before overwrite. Backup location logged.

### Risk 3: Nested Execution Corruption
**Mitigation:** Tier 1 hard error for managed execution directory (`~/.hankweave-executions/`).

### Risk 4: Agent Modifying User Files
**Mitigation:** Warning explicitly states agents can "READ and MODIFY files." Documentation emphasizes version control.

## Dependencies

**No new dependencies.** Uses built-in Node.js modules (fs, path, readline, os).

## Backward Compatibility

Existing behavior preserved by default:
- Without `--execution`, auto-creates in `~/.hankweave-executions/`
- With `--execution` pointing to existing Hankweave dir, resumes
- With `--execution --start-new` on empty dir, starts fresh

New capabilities:
- With `--execution --start-new` on non-empty dir, warns and proceeds (with confirmation)
- With `--execution --start-new --force` on Hankweave dir, backs up and proceeds

## Open Questions for User

Before implementation, please confirm the following decisions:

### 1. Three-Tier Safety Strictness
**Current recommendation:**
- Tier 1 (managed directory `~/.hankweave-executions/`): Always blocked (hard error)
- Tier 2 (existing `.hankweave/`): Blocked unless `--force` (creates backup, then proceeds)
- Tier 3 (non-empty directory): Warning + prompt for confirmation

**Question:** Is the strictness of these tiers appropriate? Some users may prefer Tier 2 to be a warning+prompt instead of an error requiring `--force`. Would you like the default behavior to be more permissive?

### 2. Security Warning Prominence
**Current recommendation:** Display a warning showing file counts and stating that "Hankweave agents will have access to READ and MODIFY files in this directory."

**Question:** Is this warning message sufficient? Should it be more explicit about potential risks? Should we add documentation links to the warning output?

---

## Security Considerations

**This feature grants filesystem access to AI agents in user directories.** Documentation should prominently warn:

1. Always use version control
2. Test hanks on non-critical directories first
3. Review rigSetup commands in hanks before executing
4. Understand that agents can read, modify, and delete files

---

## Testing Requirements and Affected Tests

This section documents all existing tests that need to be updated when implementing this change, as well as comprehensive testing requirements.

### Tests That Must Be Updated (Required Changes)

These tests deal with execution directory validation and the --start-new flag:

#### Unit Tests

1. **tests/unit/execution-setup.test.ts**
   - **Currently:** Has test at line 82-94 that expects error for non-empty directory with --start-new
   - **Must Change:** This test must be removed or updated to reflect new behavior
   - **Lines affected:** Line 82-94 (test "should throw error for non-empty directory with --start-new")
   - **Action:** Update to test new three-tier safety system instead
   - **Critical:** This is a direct contradiction with current behavior

2. **Create: tests/unit/execution-directory-safety.test.ts** (NEW FILE)
   - Implement all tier detection tests from Testing Strategy section
   - Test managed directory protection (Tier 1)
   - Test existing .hankweave handling (Tier 2)
   - Test non-empty directory handling (Tier 3)
   - **Status:** Must be created from scratch
   - **Coverage:** Core safety tier logic
   - **Lines of code:** ~450 lines (as specified in plan)

#### Integration Tests

3. **Create: tests/integration/execution-directory-workflows.test.ts** (NEW FILE)
   - Implement all workflow tests from Testing Strategy section
   - Test project directory workflow
   - Test force overwrite with backup creation
   - Test file count warnings
   - **Status:** Must be created from scratch
   - **Coverage:** Real-world usage workflows
   - **Lines of code:** ~550 lines (as specified in plan)

4. **Create: tests/integration/user-confirmation-prompts.test.ts** (NEW FILE)
   - Test user confirmation flow
   - Test -y flag bypass
   - Test --force flag behavior
   - Test user declining prompts
   - **Status:** Must be created from scratch
   - **Coverage:** Confirmation and bypass mechanisms
   - **Lines of code:** ~220 lines (from plan)

#### E2E Tests

5. **Update: tests/e2e/happy-path-e2e.test.ts**
   - Add new test group from Testing Strategy section
   - Test running in project directory with --execution=.
   - Test --force creates backup
   - **Test groups to add:**
     - "Non-Empty Execution Directories" (from plan lines 631-676)
   - **Action:** Add test group after existing groups

6. **tests/e2e/rollback-comprehensive-e2e.test.ts**
   - Rollback tests may interact with directory validation
   - **Action:** Run tests to ensure no regressions

### New Tests To Add (Test the New Feature)

The plan already has a comprehensive Testing Strategy section. Here are the specific files that must be created:

#### 1. Safety Tier Detection Unit Tests (tests/unit/execution-directory-safety.test.ts)

**From Testing Strategy section, lines 359-441:**
- Tier 1 managed directory detection and blocking
- Tier 2 existing .hankweave detection and handling
- Tier 3 non-empty directory detection and warning

**Status:** Complete test suite already designed in plan
**Estimated:** 15-20 test cases, ~450 lines
**Action:** Implement exactly as specified in Testing Strategy section

#### 2. Workflow Integration Tests (tests/integration/execution-directory-workflows.test.ts)

**From Testing Strategy section, lines 449-554:**
- Project directory workflow
- Force overwrite with timestamped backup
- File count warning display
- Original file preservation

**Status:** Complete test suite already designed in plan
**Estimated:** 10-15 test cases, ~550 lines
**Action:** Implement exactly as specified in Testing Strategy section

#### 3. Confirmation Prompt Tests (tests/integration/user-confirmation-prompts.test.ts)

**From Testing Strategy section, lines 559-622:**
- User prompt display for Tier 3
- -y flag skips confirmation
- User declining prompt aborts
- --force bypasses prompts

**Status:** Complete test suite already designed in plan
**Estimated:** 8-10 test cases, ~220 lines
**Action:** Implement exactly as specified in Testing Strategy section

#### 4. E2E Non-Empty Directory Tests (add to tests/e2e/happy-path-e2e.test.ts)

**From Testing Strategy section, lines 631-676:**
- Run in project directory with --execution=.
- --force creates backup and continues

**Status:** Complete test suite already designed in plan
**Estimated:** 4-6 test cases, ~150 lines
**Action:** Implement exactly as specified in Testing Strategy section

### Regression Tests (Critical - Must Pass)

After implementing the three-tier safety system, these existing test suites must pass:

1. **Execution Setup Tests** (tests/unit/execution-setup.test.ts)
   - **EXCEPT:** The test at lines 82-94 which explicitly tests the old behavior
   - All other execution setup tests must pass
   - **Action:** Remove or update the failing test

2. **File System Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Test group: `runFileSystemTests`
   - Ensures file operations work correctly
   - **Critical:** Must work in non-empty directories

3. **Checkpoint System Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Test group: `runCheckpointSystemTests`
   - Ensures checkpointing works in non-empty directories

4. **Security Validation Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Test group: `runSecurityValidationTests`
   - Ensures security checks still work

### CI/CD Pipeline Considerations

The CI/CD pipeline (`.github/workflows/ci.yml`) considerations:

1. **Lint and Type Check** (Job: `lint-and-typecheck`)
   - New tier detection and warning functions must pass linting
   - Updated ExecutionSetupOptions interface must type check
   - **Action:** Run `bun run tc` locally

2. **Unit & Integration Tests** (Job: `tests`)
   - Three new test files must be included and pass
   - Updated execution-setup.test.ts must pass
   - **Action:** Verify `bun test tests/unit` and `bun test tests/integration` pass

3. **E2E Tests**
   - Existing E2E tests should pass unchanged
   - New E2E test group should be included
   - **Action:** Run full E2E suite

4. **Critical Test Update Required**
   - tests/unit/execution-setup.test.ts line 82-94 WILL FAIL
   - This test explicitly checks the old behavior
   - **Action:** Update or remove this test before merging

### Test Execution Checklist

Execute tests in this order:

```bash
# 1. Type check (verify new interfaces)
bun run tc

# 2. Linting
bun run lint:fix

# 3. Unit tests - UPDATE existing test first
# CRITICAL: Update execution-setup.test.ts line 82-94 first!
bun test tests/unit/execution-setup.test.ts  # Should pass after update

# 4. Unit tests - NEW tests
bun test tests/unit/execution-directory-safety.test.ts  # New file
bun test tests/unit  # All unit tests

# 5. Integration tests - NEW tests
bun test tests/integration/execution-directory-workflows.test.ts  # New file
bun test tests/integration/user-confirmation-prompts.test.ts  # New file
bun test tests/integration  # All integration tests

# 6. E2E tests (expensive)
bun test tests/e2e/happy-path-e2e.test.ts  # With new test group
bun test tests/e2e  # All E2E tests
```

### Manual Testing Scenarios

Test these scenarios manually to verify user experience:

#### 1. Run in Project Directory

```bash
# Create a project directory with files
mkdir my-project
cd my-project
echo "# README" > README.md
mkdir src
echo "code" > src/index.ts

# Run hankweave in this directory
hankweave --execution=. --start-new hank.json . -y

# Expected: Creates .hankweave/ subdirectory
# Expected: Files remain intact
ls -la
# Should show: README.md, src/, .hankweave/
```

#### 2. Tier 1 - Managed Directory Blocked

```bash
# Try to use managed execution directory
hankweave --execution=~/.hankweave-executions/my-exec --start-new hank.json .

# Expected: Hard error
# Error: "Cannot use ~/.hankweave-executions/ as explicit execution directory"
```

#### 3. Tier 2 - Existing .hankweave Without --force

```bash
# Directory with existing .hankweave
cd my-project
# (already has .hankweave from previous run)

hankweave --execution=. --start-new hank.json .

# Expected: Error requiring --force
# Error: "Directory already contains Hankweave execution"
```

#### 4. Tier 2 - Existing .hankweave With --force

```bash
# Same directory
hankweave --execution=. --start-new --force hank.json . -y

# Expected: Backup created
# Expected: Log message: "📦 Backed up existing execution to: .hankweave.backup-TIMESTAMP"
ls -la
# Should show: .hankweave/, .hankweave.backup-2026-01-13T143022/
```

#### 5. Tier 3 - Non-Empty Directory Warning

```bash
# Directory with files but no .hankweave
mkdir new-project
cd new-project
touch file1.txt file2.txt

hankweave --execution=. --start-new hank.json .

# Expected: Warning about non-empty directory
# Expected: Prompt: "Continue? [y/N]"
# (Type 'y' to continue or 'n' to abort)
```

#### 6. Bypass with -y Flag

```bash
# Same as above but with -y
hankweave --execution=. --start-new hank.json . -y

# Expected: Warning logged but no prompt
# Expected: Continues automatically
```

### Warning Message Verification

Verify these warning/error messages display correctly:

1. **Tier 1 Hard Error** (from plan, lines 164-168)
   ```
   Cannot use ~/.hankweave-executions/ as explicit execution directory.
   This location is reserved for auto-managed executions.
   ```

2. **Tier 2 Error** (from plan, lines 194-200)
   ```
   Directory already contains Hankweave execution: /path
   Options:
     1. Remove .hankweave/ directory and try again
     2. Use --force to backup existing state and start fresh
     3. Use a different directory
   ```

3. **Tier 3 Warning** (from plan, lines 235-243)
   ```
   ⚠️  WARNING: Running in existing non-empty directory: /path
     This directory contains X files and Y directories.
     Hankweave agents will have access to READ and MODIFY files...
   ```

4. **Backup Created Message** (from plan, line 192)
   ```
   📦 Backed up existing execution to: .hankweave.backup-TIMESTAMP
   ```

### Search Commands for Implementation

Use these commands during implementation:

```bash
# Find current non-empty directory check (will be modified)
grep -rn "Cannot use --start-new with non-empty" server/execution-setup.ts

# Find execution path validation
grep -rn "executionPath" server/execution-setup.ts

# Find setupExecutionEnvironment function signature
grep -rn "setupExecutionEnvironment" server/

# Verify new tier checks are added
grep -rn "isManagedExecutionDirectory\|hasHankweave\|warnAboutExistingDirectory" server/
```

### Critical Test That Must Be Updated

**File:** tests/unit/execution-setup.test.ts
**Lines:** 82-94

**Current test code:**
```typescript
it("should throw error for non-empty directory with --start-new", async () => {
  // Create directory with content
  await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(EXECUTION_DIR, "existing.txt"), "existing content");

  await expect(
    setupExecutionEnvironment({
      readOnlySourceDataPath: DATA_SOURCE_DIR,
      executionPath: EXECUTION_DIR,
      startNew: true,
    }),
  ).rejects.toThrow(/Cannot use --start-new with non-empty execution directory/);
});
```

**Must be replaced with:**
```typescript
it("should warn but allow non-empty directory with --start-new and skipConfirmation", async () => {
  // Create directory with content
  await fs.promises.mkdir(EXECUTION_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(EXECUTION_DIR, "existing.txt"), "existing content");

  const result = await setupExecutionEnvironment({
    readOnlySourceDataPath: DATA_SOURCE_DIR,
    executionPath: EXECUTION_DIR,
    startNew: true,
    skipConfirmation: true, // Skip prompt for test
  });

  expect(result.isNewExecution).toBe(true);
  expect(result.executionPath).toBe(EXECUTION_DIR);
});
```

### Backup Timestamp Verification

The implementation creates timestamped backups. Test that:

```bash
# Create backup and verify timestamp format
# Format: .hankweave.backup-YYYY-MM-DDTHHMMSS

# Run test
ls -la | grep ".hankweave.backup-"
# Should match pattern: .hankweave.backup-2026-01-13T143022

# Verify backup contains old state
cat .hankweave.backup-*/state.json
# Should show old execution state
```

### Summary of Test Impact

| Test Type | New Files | Updated Files | Test Cases | Lines of Code |
|-----------|-----------|---------------|------------|---------------|
| Unit Tests | 1 new file | 1 file (critical) | ~20 cases | ~450 lines |
| Integration Tests | 2 new files | 0 files | ~20 cases | ~770 lines |
| E2E Tests | 0 new files | 1 file | ~6 cases | ~150 lines |
| Manual Tests | N/A | N/A | 6 scenarios | N/A |
| **Total** | **3 new files** | **2 files** | **~46 cases** | **~1370 lines** |

**Estimated Time for New Tests:** 6-8 hours (comprehensive test suite)
**Estimated Time for Test Updates:** 1 hour (critical test update)
**Estimated Time for Manual Testing:** 2 hours (security-critical feature)
**Total Testing Effort:** 9-11 hours

### Special Testing Considerations

1. **File Count Accuracy**
   - Warning must accurately count files vs directories
   - Test with various directory structures
   - Verify hidden files are counted correctly

2. **Mock readline for Prompts**
   - Tests must mock readline for user confirmation
   - Use PassThrough streams or mock functions
   - Example in plan (lines 559-622)

3. **Backup Integrity**
   - Verify backup contains all files from original .hankweave
   - Test that backup doesn't interfere with new execution
   - Ensure backup is never deleted automatically

4. **Path Handling Edge Cases**
   - Test with relative paths (./directory)
   - Test with absolute paths
   - Test with paths containing spaces
   - Test with symlinks

5. **Concurrent Access**
   - Test what happens if two processes try to run in same directory
   - Verify lock files or conflicts are handled gracefully

### Critical Success Criteria

Before considering this implementation complete, verify:

1. ✅ Tier 1 (managed directory) always blocks
2. ✅ Tier 2 (existing .hankweave) blocks without --force
3. ✅ Tier 2 with --force creates timestamped backup
4. ✅ Tier 3 (non-empty) warns and prompts user
5. ✅ Tier 3 with -y skips prompt
6. ✅ File count in warning is accurate
7. ✅ Backup contains complete old state
8. ✅ Original files are preserved when running in project directory
9. ✅ Updated test at execution-setup.test.ts:82-94
10. ✅ All regression tests pass
11. ✅ `bun run tc` passes without errors
12. ✅ `bun run lint` passes without errors

**CRITICAL:** This feature changes fundamental safety assumptions about where Hankweave can run. The test at execution-setup.test.ts:82-94 directly tests the old behavior and WILL FAIL. This must be updated before the feature can be merged.

This is a security-sensitive feature that requires thorough testing. The three-tier safety system must be bulletproof, as it protects users from accidentally running agents in important directories.
