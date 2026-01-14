# ENG-91: Config Warnings When Resuming on Previous Execution Directory

> **Implementation Order:** Phase 3 (with ENG-88) - See [00-index.md](00-index.md) for full context

## Related Plans

This task should be implemented alongside ENG-88 as they both modify `execution-setup.ts`:

- **[ENG-88: Existing Run Directories](final-standalone-6-existing-run-directories.md)** - Both address execution directory safety; coordinate changes to `execution-setup.ts`
- **[ENG-106: Command Line Improvements](final-standalone-2-command-line-improvements.md)** - The `-y` flag behavior should be consistent with this task's skip-confirmation logic

## Task Summary

Add hank configuration change detection when resuming an existing execution. Currently, only the data source hash is verified on resume, allowing users to silently resume with a modified hank.json which can cause confusing behavior. The system should detect config changes and warn users before continuing.

**Original Request (Hrishi Olickel):**
> "If the server was shut down and then resumed, we get this message:
> ```
> Configuration warnings:
>   - Codon 1 (build-pre-loop): Copy target "eval-suite" already exists and will be overwritten
>
> [ERROR] Execution thread failed, rolling back...
> ```
> Is this expected?"

**Step 4 Agent Note:** The original issue describes a specific bug with copy target warnings, but the broader need (validated during grooming) is to detect and warn about hank configuration changes on resume. The Step 2 Agent clarified: "Currently only data hash is verified on resume (execution-setup.ts line 107), not hank config."

## Sources and Context

### Linear Ticket
- **Identifier:** ENG-91
- **Status:** In Progress
- **Priority:** Medium
- **Labels:** Bug
- **Created:** 2025-12-18

### Original Planning Documents
The following documents were synthesized by the Step 4 Agent to create this plan:
- [`supporting-docs/5-config-warnings-resume-full-task.md`](supporting-docs/5-config-warnings-resume-full-task.md) - Original task with Step 1/2/3 agent analysis
- [`supporting-docs/5-config-warnings-resume-related-code.md`](supporting-docs/5-config-warnings-resume-related-code.md) - Codebase integration points
- [`supporting-docs/5-config-warnings-resume-changes-decisions-and-judgement-calls.md`](supporting-docs/5-config-warnings-resume-changes-decisions-and-judgement-calls.md) - Technical decisions

### Related Issues
- **ENG-90:** Fixing execution directory behavior (Urgent) - Related but distinct
- **ENG-88:** Run hanks in existing run directories - Overlapping concern

### Research Findings (from Step 3 Agent)

The Step 3 Agent's research validated the hash-based approach:

> "Hash-based change detection is well-established in configuration management. Network devices use SHA-256 hashes for config change detection, and comparing current hash with cached versions is standard practice."

Sources cited:
- [Aruba Networks: SHA-256 config checksums](https://arubanetworking.hpe.com/techdocs/AOS-CX/10.14/HTML/fundamentals_8400/Content/Chp_Cfg_FW_mgt/Chk_cmds/sho-run-cfg-hash.htm)
- [File hash comparison tools](https://offlinetools.org/tools/file-hash-compare)

### Current Code Analysis (from Step 2 Agent)

**What's currently checked on resume:**
```typescript
// execution-setup.ts lines 102-122
const metaPath = path.join(executionPath, '.hankweave', 'execution-meta.json');
if (fs.existsSync(metaPath)) {
  const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
  if (meta.dataHash !== dataHash) {
    throw new Error('Data source mismatch. Execution directory was created for different data.');
  }
  isResuming = true;
}
```

**What's NOT checked:** The hank.json configuration. Users can modify the hank between runs without any warning.

## Decision Points and Judgement Calls

### Decision 1: Store Hash + Metadata (Not Just Hash)

**The Step 4 Agent recommends:** Store both a SHA-256 hash of the hank.json content AND metadata about the hank structure.

**Data to store:**
```typescript
hankConfig: {
  path: string;           // Original hank.json path
  hash: string;           // SHA-256 of hank.json content
  codonCount: number;     // Quick validation
  codonIds: string[];     // List of codon IDs for detailed diff
}
```

**Rationale (from Step 3 Agent):**
> "The recommendation to store both hash and metadata is smart - it enables informative warnings about what changed. Consider making the warning even more detailed: show which codons were added/removed/reordered."

### Decision 2: Warning Levels

**The Step 4 Agent recommends:** Two warning levels based on severity:

| Level | Condition | Behavior |
|-------|-----------|----------|
| WARN | Config changed but compatible | Display warning, prompt for confirmation |
| ERROR | Incompatible change (e.g., current codon missing) | Block resume |

**Examples:**
- **WARN:** User added a new codon at the end (compatible)
- **WARN:** User modified prompt text (compatible)
- **ERROR:** User removed the codon that was about to execute (incompatible)

### Decision 3: Prompt Behavior

**The Step 4 Agent recommends:** Prompt user to confirm unless explicitly bypassed.

| Flag/Env | Behavior |
|----------|----------|
| No flag | Prompt user to confirm |
| `-y` flag | Skip prompt, log warning, continue |
| `HANKWEAVE_IGNORE_CONFIG_CHANGES=true` | Skip prompt, log warning, continue |

### Decision 4: Hash Algorithm

**The Step 4 Agent recommends:** Use SHA-256 via Node.js crypto module.

**Rationale:**
- Industry standard for integrity checking
- Fast to compute
- Strong collision resistance (practically impossible for two configs to have same hash)
- Built into Node.js (no dependencies)

## Implementation Plan

### Step 1: Extend Execution Metadata

**File: `server/execution-setup.ts` (around line 204)**

When creating a new execution, store hank config information:

```typescript
import crypto from 'node:crypto';

// In setupExecutionEnvironment(), when writing execution-meta.json:
const hankContent = await fs.promises.readFile(hankPath, 'utf-8');
const hankHash = crypto.createHash('sha256').update(hankContent).digest('hex');

// Parse to extract metadata (loadHankFile should already be called)
const hankFile = loadHankFile(hankPath);
const codonIds = flattenCodons(hankFile.hank).map(c => c.id);

const executionMeta = {
  version: PACKAGE_VERSION,
  readOnlySourceDataPath,
  dataHash,
  createdAt: new Date().toISOString(),
  lastUsed: new Date().toISOString(),
  // NEW:
  hankConfig: {
    path: hankPath,
    hash: hankHash,
    codonCount: codonIds.length,
    codonIds,
  },
};

await fs.promises.writeFile(metaPath, JSON.stringify(executionMeta, null, 2));
```

**Helper function to flatten codons (handles loops):**
```typescript
function flattenCodons(codons: CodonConfig[]): Codon[] {
  const flat: Codon[] = [];
  for (const codon of codons) {
    if (codon.type === 'loop') {
      flat.push(...flattenCodons(codon.codons));
    } else {
      flat.push(codon as Codon);
    }
  }
  return flat;
}
```

### Step 2: Add Resume Config Check

**File: `server/index.ts` (after line 248, before validation)**

```typescript
import crypto from 'node:crypto';
import readline from 'node:readline';

// After execution setup, before validation:
if (executionSetup.isResuming) {
  const metaPath = path.join(executionSetup.executionPath, '.hankweave', 'execution-meta.json');
  const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));

  if (meta.hankConfig) {
    const currentHankContent = await fs.promises.readFile(absoluteConfigPath, 'utf-8');
    const currentHash = crypto.createHash('sha256').update(currentHankContent).digest('hex');

    if (meta.hankConfig.hash !== currentHash) {
      // Config has changed - analyze what changed
      const currentHank = loadHankFile(absoluteConfigPath);
      const currentCodonIds = flattenCodons(currentHank.hank).map(c => c.id);

      const added = currentCodonIds.filter(id => !meta.hankConfig.codonIds.includes(id));
      const removed = meta.hankConfig.codonIds.filter(id => !currentCodonIds.includes(id));

      // Display warning
      console.warn(`\n⚠️  WARNING: Hank configuration has changed since this execution was created!\n`);
      console.warn(`  Original hank: ${meta.hankConfig.path}`);
      console.warn(`  Original codon count: ${meta.hankConfig.codonCount}`);
      console.warn(`  Current codon count: ${currentCodonIds.length}`);

      if (added.length > 0) {
        console.warn(`  Codons added: ${added.join(', ')}`);
      }
      if (removed.length > 0) {
        console.warn(`  Codons removed: ${removed.join(', ')}`);
      }

      console.warn(`\n  This may cause unexpected behavior when resuming.\n`);

      // Check for incompatible changes (current codon was removed)
      const state = await loadState(executionSetup.executionPath);
      if (state?.currentCodonId && removed.includes(state.currentCodonId)) {
        console.error(`\n❌ ERROR: Cannot resume - the next codon "${state.currentCodonId}" was removed from the config.\n`);
        console.error(`  Either restore the codon or use --start-new to begin fresh.\n`);
        process.exit(1);
      }

      // Prompt user to confirm (unless bypassed)
      const ignoreConfigChanges = process.env.HANKWEAVE_IGNORE_CONFIG_CHANGES === 'true';
      if (!skipConfirmation && !ignoreConfigChanges) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise<string>(resolve => {
          rl.question('Continue anyway? [y/N] ', resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted. Use --start-new to begin a fresh execution.');
          process.exit(1);
        }
      }

      console.log('Continuing with modified configuration...\n');
    }
  }
}
```

### Step 3: Update Types

**File: `server/types/types.ts`**

Add or update the ExecutionMeta interface:

```typescript
export interface HankConfigSnapshot {
  path: string;
  hash: string;
  codonCount: number;
  codonIds: string[];
}

export interface ExecutionMeta {
  version: string;
  readOnlySourceDataPath: string;
  dataHash: string;
  createdAt: string;
  lastUsed: string;
  hankConfig?: HankConfigSnapshot;
}
```

### Step 4: Update Help Text

Add documentation for the environment variable:

```typescript
// In help text:
console.log(`
Environment Variables:
  HANKWEAVE_IGNORE_CONFIG_CHANGES=true  Auto-continue when config changes (for automation)
`);
```

## Code Integration Points

### Primary: `server/execution-setup.ts`

- Line 204+: Store hankConfig in execution-meta.json when creating new execution

### Primary: `server/index.ts`

- After line 248: Add config comparison logic before validation runs

### Secondary: `server/types/types.ts`

- Add HankConfigSnapshot and ExecutionMeta interfaces

## Testing Strategy

This feature adds config change detection and warning prompts on resume. Testing should focus on hash computation correctness, change detection logic, and user confirmation flows. The most brittle part is determining what constitutes an "incompatible" change.

### Unit Tests (tests/unit/config-change-detection.test.ts)

Focus on hash computation and codon comparison logic:

```typescript
describe("Hash Computation", () => {
  test("computes consistent hash for same content", () => {
    const content = '{"hank": [{"id": "test"}]}';
    const hash1 = computeHankHash(content);
    const hash2 = computeHankHash(content);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  test("computes different hash for different content", () => {
    const hash1 = computeHankHash('{"hank": [{"id": "a"}]}');
    const hash2 = computeHankHash('{"hank": [{"id": "b"}]}');
    expect(hash1).not.toBe(hash2);
  });

  test("whitespace changes produce different hash", () => {
    // Intentional: whitespace/formatting changes trigger warning
    const hash1 = computeHankHash('{"hank":[]}');
    const hash2 = computeHankHash('{ "hank": [] }');
    expect(hash1).not.toBe(hash2);
  });

  test("different newline styles produce different hash", () => {
    const hash1 = computeHankHash('{"a":\n"b"}');
    const hash2 = computeHankHash('{"a":\r\n"b"}');
    expect(hash1).not.toBe(hash2);
  });
});

describe("Codon ID Comparison", () => {
  test("detects added codons", () => {
    const original = ['codon-1', 'codon-2'];
    const current = ['codon-1', 'codon-2', 'codon-3'];
    const diff = compareCodonIds(original, current);

    expect(diff.added).toEqual(['codon-3']);
    expect(diff.removed).toEqual([]);
  });

  test("detects removed codons", () => {
    const original = ['codon-1', 'codon-2', 'codon-3'];
    const current = ['codon-1', 'codon-3'];
    const diff = compareCodonIds(original, current);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(['codon-2']);
  });

  test("detects reordered codons", () => {
    const original = ['codon-1', 'codon-2', 'codon-3'];
    const current = ['codon-2', 'codon-1', 'codon-3'];
    const diff = compareCodonIds(original, current);

    // Reordering is detected as add + remove
    expect(diff.added.length + diff.removed.length).toBeGreaterThan(0);
  });

  test("handles duplicate codon IDs", () => {
    // Edge case: loop might have same codon ID multiple times
    const original = ['codon-1', 'loop-1', 'loop-1'];
    const current = ['codon-1', 'loop-1'];
    const diff = compareCodonIds(original, current);

    expect(diff.removed).toEqual(['loop-1']); // One instance removed
  });
});

describe("Incompatible Change Detection", () => {
  test("identifies when current codon was removed", () => {
    const removed = ['codon-2', 'codon-3'];
    const currentCodonId = 'codon-2';

    expect(isIncompatibleChange(removed, currentCodonId)).toBe(true);
  });

  test("allows changes when current codon still exists", () => {
    const removed = ['codon-3'];
    const currentCodonId = 'codon-2';

    expect(isIncompatibleChange(removed, currentCodonId)).toBe(false);
  });

  test("allows changes when no current codon (run complete)", () => {
    const removed = ['codon-2'];
    const currentCodonId = undefined;

    expect(isIncompatibleChange(removed, currentCodonId)).toBe(false);
  });
});
```

**Rationale:** Hash computation must be deterministic and sensitive to all changes. Codon comparison logic determines what warnings are shown. Incompatible change detection prevents impossible resumes.

### Integration Tests (tests/integration/config-resume-warnings.test.ts)

Test the end-to-end warning flow:

```typescript
describe("Config Change Warnings on Resume", () => {
  let executionDir: string;
  let originalHank: string;

  beforeEach(async () => {
    executionDir = path.join('tests', 'test-area', `resume-test-${Date.now()}`);
    originalHank = path.join(executionDir, 'hank.json');

    // Create execution directory structure
    await fs.promises.mkdir(path.join(executionDir, '.hankweave'), { recursive: true });
  });

  afterEach(async () => {
    if (fs.existsSync(executionDir)) {
      await fs.promises.rm(executionDir, { recursive: true, force: true });
    }
  });

  test("warns when config changed", async () => {
    // Create initial execution
    const initialHank = {
      hank: [
        { id: 'codon-1', name: 'First', model: 'sonnet', continuationMode: 'fresh', promptText: 'test' },
        { id: 'codon-2', name: 'Second', model: 'sonnet', continuationMode: 'fresh', promptText: 'test' },
      ],
    };
    await writeHank(originalHank, initialHank);
    await createExecutionMetadata(executionDir, originalHank);

    // Modify config - add a codon
    const modifiedHank = {
      hank: [
        ...initialHank.hank,
        { id: 'codon-3', name: 'Third', model: 'sonnet', continuationMode: 'fresh', promptText: 'test' },
      ],
    };
    await writeHank(originalHank, modifiedHank);

    // Check for warning
    const warnings = await detectConfigChanges(executionDir, originalHank);

    expect(warnings.hasChanges).toBe(true);
    expect(warnings.added).toContain('codon-3');
    expect(warnings.removed).toEqual([]);
  });

  test("no warning when config unchanged", async () => {
    const hank = {
      hank: [
        { id: 'codon-1', name: 'First', model: 'sonnet', continuationMode: 'fresh', promptText: 'test' },
      ],
    };
    await writeHank(originalHank, hank);
    await createExecutionMetadata(executionDir, originalHank);

    // Don't modify - check again
    const warnings = await detectConfigChanges(executionDir, originalHank);

    expect(warnings.hasChanges).toBe(false);
  });

  test("blocks resume when current codon removed", async () => {
    const originalHankData = {
      hank: [
        { id: 'codon-1', name: 'First', model: 'sonnet', continuationMode: 'fresh', promptText: 'test' },
        { id: 'codon-2', name: 'Second', model: 'sonnet', continuationMode: 'fresh', promptText: 'test' },
      ],
    };
    await writeHank(originalHank, originalHankData);
    await createExecutionMetadata(executionDir, originalHank);

    // Save state showing we're about to run codon-2
    await writeState(executionDir, { currentCodonId: 'codon-2' });

    // Remove codon-2 from config
    const modifiedHank = {
      hank: [originalHankData.hank[0]], // Only codon-1
    };
    await writeHank(originalHank, modifiedHank);

    // Should detect incompatible change
    const warnings = await detectConfigChanges(executionDir, originalHank);
    expect(warnings.isIncompatible).toBe(true);
    expect(warnings.incompatibleReason).toContain('codon-2');
  });

  test("allows resume when future codon removed", async () => {
    const originalHankData = {
      hank: [
        { id: 'codon-1', name: 'First', model: 'sonnet', continuationMode: 'fresh', promptText: 'test' },
        { id: 'codon-2', name: 'Second', model: 'sonnet', continuationMode: 'fresh', promptText: 'test' },
      ],
    };
    await writeHank(originalHank, originalHankData);
    await createExecutionMetadata(executionDir, originalHank);

    // Save state showing we're about to run codon-1
    await writeState(executionDir, { currentCodonId: 'codon-1' });

    // Remove codon-2 (future codon)
    const modifiedHank = {
      hank: [originalHankData.hank[0]],
    };
    await writeHank(originalHank, modifiedHank);

    // Should warn but not block
    const warnings = await detectConfigChanges(executionDir, originalHank);
    expect(warnings.hasChanges).toBe(true);
    expect(warnings.isIncompatible).toBe(false);
  });
});
```

**Rationale:** These tests verify the core detection logic works correctly for various change scenarios. The incompatible change detection is critical - blocking or allowing the wrong resumes would break workflows.

### Integration Tests: User Confirmation Flow

```typescript
describe("User Confirmation", () => {
  test("prompts user when config changed (no -y flag)", async () => {
    const mockPrompt = jest.fn().mockResolvedValue('y');

    await resumeWithConfigChanges({
      skipConfirmation: false,
      promptFunction: mockPrompt,
    });

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining('configuration has changed')
    );
  });

  test("-y flag skips prompt", async () => {
    const mockPrompt = jest.fn();

    const result = await resumeWithConfigChanges({
      skipConfirmation: true,
      promptFunction: mockPrompt,
    });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(result.continued).toBe(true);
  });

  test("user declining prompt aborts resume", async () => {
    const mockPrompt = jest.fn().mockResolvedValue('n');

    await expect(resumeWithConfigChanges({
      skipConfirmation: false,
      promptFunction: mockPrompt,
    })).rejects.toThrow('Aborted');
  });

  test("HANKWEAVE_IGNORE_CONFIG_CHANGES env var skips prompt", async () => {
    process.env.HANKWEAVE_IGNORE_CONFIG_CHANGES = 'true';
    const mockPrompt = jest.fn();

    const result = await resumeWithConfigChanges({
      skipConfirmation: false,
      promptFunction: mockPrompt,
    });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(result.continued).toBe(true);

    delete process.env.HANKWEAVE_IGNORE_CONFIG_CHANGES;
  });
});
```

**Rationale:** User confirmation is a safety feature. These tests ensure prompts appear at the right time and bypass mechanisms work correctly.

### E2E Test: Attach to Existing Suite

Add to tests/e2e/happy-path-e2e.test.ts:

```typescript
describe("Config Change on Resume", () => {
  test("warns and prompts when resuming with modified config", async () => {
    // Start server, run one codon, stop
    const firstRun = await startServer({
      config: TEST_HANK_PATH,
      data: TEST_DATA_DIR,
      args: ['--start-new'],
    });
    // Manually stop after first codon
    await stopServerAfterCodon(firstRun.serverProcess, 1);

    // Modify hank.json
    const hank = JSON.parse(fs.readFileSync(TEST_HANK_PATH, 'utf-8'));
    hank.hank.push({
      id: 'new-codon',
      name: 'New',
      model: 'sonnet',
      continuationMode: 'fresh',
      promptText: 'test',
    });
    fs.writeFileSync(TEST_HANK_PATH, JSON.stringify(hank, null, 2));

    // Resume - should warn
    const mockStdin = new PassThrough();
    mockStdin.write('y\n'); // User confirms
    mockStdin.end();

    const secondRun = await startServer({
      config: TEST_HANK_PATH,
      data: TEST_DATA_DIR,
      args: [`--execution=${firstRun.executionPath}`],
      stdin: mockStdin,
    });

    expect(secondRun.stderr).toContain('configuration has changed');
    expect(secondRun.stderr).toContain('Codons added: new-codon');
  });

  test("blocks resume when current codon removed", async () => {
    // Similar setup but remove the current codon
    const firstRun = await startServer({
      config: TEST_HANK_PATH,
      data: TEST_DATA_DIR,
      args: ['--start-new'],
    });
    await stopServerAfterCodon(firstRun.serverProcess, 1);

    // Remove codon-2 (the one about to execute)
    const hank = JSON.parse(fs.readFileSync(TEST_HANK_PATH, 'utf-8'));
    hank.hank = hank.hank.filter((c: any) => c.id !== 'codon-2');
    fs.writeFileSync(TEST_HANK_PATH, JSON.stringify(hank, null, 2));

    // Resume should fail
    const secondRun = await startServer({
      config: TEST_HANK_PATH,
      data: TEST_DATA_DIR,
      args: [`--execution=${firstRun.executionPath}`],
      expectFailure: true,
    });

    expect(secondRun.stderr).toContain('Cannot resume');
    expect(secondRun.stderr).toContain('codon-2" was removed');
    expect(secondRun.exitCode).not.toBe(0);
  });
});
```

**Rationale:** E2E tests verify the entire flow works: metadata is stored correctly, changes are detected on resume, warnings are displayed, and incompatible changes block execution.

## Warning Output Example

When a user resumes with a modified config:

```
⚠️  WARNING: Hank configuration has changed since this execution was created!

  Original hank: /path/to/hank.json
  Original codon count: 5
  Current codon count: 6
  Codons added: new-validation
  Codons removed: (none)

  This may cause unexpected behavior when resuming.

Continue anyway? [y/N]
```

When an incompatible change is detected:

```
⚠️  WARNING: Hank configuration has changed since this execution was created!

  Original hank: /path/to/hank.json
  Original codon count: 5
  Current codon count: 4
  Codons added: (none)
  Codons removed: analysis-phase

  This may cause unexpected behavior when resuming.

❌ ERROR: Cannot resume - the next codon "analysis-phase" was removed from the config.

  Either restore the codon or use --start-new to begin fresh.
```

## Complexity Assessment

**Overall complexity:** Low

**Breakdown:**
- Metadata storage: ~30 lines
- Hash computation: ~10 lines
- Comparison logic: ~50 lines
- Warning display: ~30 lines
- User prompt: ~20 lines
- Type definitions: ~15 lines

**Total new code:** ~155 lines

## Risk Mitigation

### Risk 1: Breaking Existing Executions
**Mitigation:** The hankConfig field is optional in the metadata. Old executions without this field will simply not have config change detection (graceful degradation).

### Risk 2: False Positives from Whitespace Changes
**Mitigation:** Hash is computed on raw file content. Users reformatting their JSON will trigger warnings. This is intentional - any change should be noted. If this becomes annoying, we could normalize JSON before hashing in a future iteration.

### Risk 3: Blocking Automation
**Mitigation:** `-y` flag and `HANKWEAVE_IGNORE_CONFIG_CHANGES` environment variable allow automated workflows to continue without prompts.

## Dependencies

**No new dependencies.** Uses built-in Node.js crypto module for SHA-256 hashing.

## Open Questions for User

Before implementation, please confirm the following decision:

### 1. Whitespace/Formatting Sensitivity
**Current recommendation:** Hash is computed on raw file content. Users reformatting their JSON (adding/removing whitespace, reordering fields) will trigger warnings. This is intentional - any change should be noted.

**Question:** Is this the right behavior? The alternative would be to normalize JSON before hashing (parse, sort keys, re-stringify) so formatting changes don't trigger warnings. This adds complexity but reduces false positives.

---

## Backward Compatibility

Full backward compatibility maintained:
- Old execution directories without `hankConfig` in metadata work normally (no config check)
- New executions store config info for future resume validation
- No breaking changes to CLI interface

---

## Testing Requirements and Affected Tests

This section documents all existing tests that need to be updated when implementing this change, as well as comprehensive testing requirements.

### Tests That Must Be Updated (Required Changes)

These tests deal with execution metadata and resume behavior:

#### Unit Tests

1. **tests/unit/execution-setup.test.ts**
   - Currently tests execution metadata creation
   - Must verify `hankConfig` is included in metadata for new executions
   - Must verify old metadata without `hankConfig` still works
   - **Action:** Add tests for new metadata fields
   - **Lines affected:** Tests that read execution-meta.json

2. **Create: tests/unit/config-change-detection.test.ts** (NEW FILE)
   - Implement all hash computation tests from Testing Strategy section
   - Implement all codon comparison tests
   - Implement incompatible change detection tests
   - **Status:** Must be created from scratch
   - **Coverage:** Core detection logic
   - **Lines of code:** ~400 lines (as specified in plan)

#### Integration Tests

3. **Create: tests/integration/config-resume-warnings.test.ts** (NEW FILE)
   - Implement all config change warning tests from Testing Strategy section
   - Test user confirmation flow
   - Test bypass mechanisms (-y flag, env var)
   - **Status:** Must be created from scratch
   - **Coverage:** End-to-end warning flow
   - **Lines of code:** ~600 lines (as specified in plan)

4. **tests/integration/state-manager.test.ts** (if exists)
   - May need to handle new metadata fields
   - **Action:** Verify state loading works with new metadata

#### E2E Tests

5. **Update: tests/e2e/happy-path-e2e.test.ts**
   - Add new test group from Testing Strategy section
   - Test config change detection on resume
   - Test incompatible change blocking
   - **Test groups to add:**
     - Tests for "Config Change on Resume" (from plan)
   - **Action:** Add test group after existing groups

6. **tests/e2e/rollback-comprehensive-e2e.test.ts**
   - Rollback tests involve resume behavior
   - Should verify config changes don't break rollback
   - **Action:** Run tests to ensure no regressions

7. **Create: tests/e2e/session-resume-e2e.test.ts** (if doesn't exist)
   - Comprehensive session resume tests
   - Test various config modification scenarios
   - **Action:** Check if this file exists and add tests

### New Tests To Add (Test the New Feature)

The plan already has a comprehensive Testing Strategy section. Here are the specific files that must be created:

#### 1. Hash Computation Unit Tests (tests/unit/config-change-detection.test.ts)

**From Testing Strategy section, lines 306-400:**
- Hash computation consistency tests
- Hash collision tests
- Whitespace sensitivity tests
- Newline style tests
- Codon ID comparison tests
- Incompatible change detection tests

**Status:** Complete test suite already designed in plan
**Estimated:** 20-25 test cases, ~400 lines
**Action:** Implement exactly as specified in Testing Strategy section

#### 2. Config Warning Integration Tests (tests/integration/config-resume-warnings.test.ts)

**From Testing Strategy section, lines 405-520:**
- Config change detection tests
- Backward compatibility tests (no warning when unchanged)
- Incompatible change blocking tests
- Future codon removal handling

**Status:** Complete test suite already designed in plan
**Estimated:** 15-20 test cases, ~600 lines
**Action:** Implement exactly as specified in Testing Strategy section

#### 3. User Confirmation Tests (tests/integration/config-resume-warnings.test.ts)

**From Testing Strategy section, lines 527-577:**
- Prompt display tests
- -y flag bypass tests
- User decline handling
- Environment variable bypass tests

**Status:** Complete test suite already designed in plan
**Estimated:** 6-8 test cases, included in integration file
**Action:** Implement exactly as specified in Testing Strategy section

#### 4. E2E Config Resume Tests (add to tests/e2e/happy-path-e2e.test.ts)

**From Testing Strategy section, lines 583-651:**
- Warning display on modified config
- Incompatible change blocking
- Successful resume after user confirmation

**Status:** Complete test suite already designed in plan
**Estimated:** 4-6 test cases, ~200 lines
**Action:** Implement exactly as specified in Testing Strategy section

### Regression Tests (Critical - Must Pass)

After implementing config change detection, these existing test suites must pass:

1. **Session Continuity Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Test group: `runSessionContinuityTests`
   - Ensures resume behavior still works
   - **Critical:** Resume must work when config hasn't changed

2. **State Consistency Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Test group: `runStateConsistencyTests`
   - Ensures state persistence works with new metadata

3. **Rollback Tests** (tests/e2e/rollback-comprehensive-e2e.test.ts)
   - Rollback involves resume behavior
   - Must work correctly with config tracking
   - **Critical:** Rollback must not be affected by config change detection

4. **Execution Setup Tests** (tests/unit/execution-setup.test.ts)
   - Existing tests for metadata creation
   - Must pass with additional metadata fields
   - **Action:** Run full test suite

### CI/CD Pipeline Considerations

The CI/CD pipeline (`.github/workflows/ci.yml`) considerations:

1. **Lint and Type Check** (Job: `lint-and-typecheck`)
   - New hash computation and comparison functions must pass linting
   - New interfaces (HankConfigSnapshot, ExecutionMeta) must type check
   - **Action:** Run `bun run tc` locally

2. **Unit & Integration Tests** (Job: `tests`)
   - Two new test files must be included and pass
   - All existing tests must pass
   - **Action:** Verify `bun test tests/unit` and `bun test tests/integration` pass

3. **E2E Tests**
   - Existing E2E tests should pass unchanged
   - New E2E test group should be included
   - **Action:** Run full E2E suite

4. **Backward Compatibility Critical**
   - Old execution directories must still work
   - Tests should verify graceful degradation when hankConfig is missing
   - **Action:** Create specific test for old metadata format

### Test Execution Checklist

Execute tests in this order:

```bash
# 1. Type check (verify new interfaces)
bun run tc

# 2. Linting
bun run lint:fix

# 3. Unit tests - NEW tests first
bun test tests/unit/config-change-detection.test.ts  # New file
bun test tests/unit/execution-setup.test.ts  # Verify metadata changes work
bun test tests/unit  # All unit tests

# 4. Integration tests - NEW tests
bun test tests/integration/config-resume-warnings.test.ts  # New file
bun test tests/integration  # All integration tests

# 5. E2E tests (expensive)
bun test tests/e2e/happy-path-e2e.test.ts  # With new config resume test group
bun test tests/e2e/rollback-comprehensive-e2e.test.ts  # Verify no rollback regressions
bun test tests/e2e  # All E2E tests
```

### Manual Testing Scenarios

Test these scenarios manually to verify user experience:

#### 1. Config Changed - Warning Displayed

```bash
# Start execution
hankweave --config hank.json --data ./data --start-new

# Stop server (Ctrl+C or 'q')

# Modify hank.json (add a codon)
# Resume
hankweave --config hank.json --data ./data

# Expected: Warning message showing what changed
# Prompt: "Continue anyway? [y/N]"
```

#### 2. Config Unchanged - No Warning

```bash
# Start and stop execution (as above)
# DON'T modify hank.json
# Resume
hankweave --config hank.json --data ./data

# Expected: No warning, seamless resume
```

#### 3. Incompatible Change - Blocked

```bash
# Start execution, complete one codon, stop
# Remove the codon that's about to execute from hank.json
# Resume
hankweave --config hank.json --data ./data

# Expected: Error message, exit code 1
# Message should mention the missing codon by ID
```

#### 4. Bypass with -y Flag

```bash
# Start execution, stop
# Modify hank.json
# Resume with -y flag
hankweave --config hank.json --data ./data -y

# Expected: Warning logged, but no prompt, continues automatically
```

#### 5. Bypass with Environment Variable

```bash
# Start execution, stop
# Modify hank.json
# Resume with env var
HANKWEAVE_IGNORE_CONFIG_CHANGES=true hankweave --config hank.json --data ./data

# Expected: Warning logged, no prompt, continues automatically
```

#### 6. Whitespace Changes Trigger Warning

```bash
# Start execution, stop
# Reformat hank.json (add/remove whitespace)
prettier --write hank.json

# Resume
hankweave --config hank.json --data ./data

# Expected: Warning about config change (this is intentional)
```

### Error Message Verification

Verify these error/warning messages display correctly:

1. **Config Change Warning** (from plan, lines 655-671)
   ```
   ⚠️  WARNING: Hank configuration has changed...
   ```

2. **Incompatible Change Error** (from plan, lines 673-689)
   ```
   ❌ ERROR: Cannot resume - the next codon "X" was removed...
   ```

3. **User Prompt** (from plan, line 670)
   ```
   Continue anyway? [y/N]
   ```

### Search Commands for Implementation

Use these commands during implementation:

```bash
# Find execution metadata handling
grep -rn "execution-meta.json" server/

# Find current data hash checking code
grep -rn "dataHash" server/execution-setup.ts

# Find state loading code
grep -rn "loadState" server/

# Verify hash computation is added
grep -rn "createHash.*sha256" server/
```

### Backward Compatibility Testing

**Critical:** Test that old execution directories still work:

```bash
# 1. Create an execution directory without hankConfig in metadata
# (Use an old version of Hankweave or manually edit metadata)

# 2. Try to resume with new version
hankweave --config hank.json --data ./data --execution=/path/to/old/execution

# Expected: No config check performed, seamless resume (graceful degradation)
```

**Test procedure:**
1. Manually create execution-meta.json without `hankConfig` field
2. Verify resume works without errors
3. Verify no warnings about missing metadata

### Summary of Test Impact

| Test Type | New Files | Updated Files | Test Cases | Lines of Code |
|-----------|-----------|---------------|------------|---------------|
| Unit Tests | 1 new file | 1 file | ~25 cases | ~400 lines |
| Integration Tests | 1 new file | 0 files | ~20 cases | ~600 lines |
| E2E Tests | 0 new files | 1 file | ~6 cases | ~200 lines |
| Manual Tests | N/A | N/A | 6 scenarios | N/A |
| **Total** | **2 new files** | **2 files** | **~51 cases** | **~1200 lines** |

**Estimated Time for New Tests:** 5-7 hours (comprehensive test suite)
**Estimated Time for Test Updates:** 1-2 hours
**Estimated Time for Manual Testing:** 1-2 hours
**Total Testing Effort:** 7-11 hours

### Special Testing Considerations

1. **Hash Consistency**
   - Hash must be deterministic (same input = same hash)
   - Test on different platforms (macOS, Linux, Windows)
   - Verify newline handling (LF vs CRLF)

2. **Mock stdin for Prompts**
   - Tests must mock readline for user confirmation
   - Use PassThrough streams or mock functions
   - Example in plan (lines 527-577)

3. **Race Conditions**
   - Config file could change during execution
   - Tests should verify behavior is consistent
   - Consider testing concurrent modifications

4. **Large Config Files**
   - Test with large hank.json files (100+ codons)
   - Verify hash computation is fast enough
   - Ensure memory usage is acceptable

### Critical Success Criteria

Before considering this implementation complete, verify:

1. ✅ Hash computation is deterministic and consistent
2. ✅ Config changes are detected accurately
3. ✅ Incompatible changes block resume with clear error
4. ✅ Compatible changes warn but allow resume
5. ✅ User confirmation prompt works correctly
6. ✅ -y flag bypasses prompt successfully
7. ✅ Environment variable bypass works
8. ✅ Old execution directories (no hankConfig) still work
9. ✅ Warning messages are clear and helpful
10. ✅ All regression tests pass
11. ✅ `bun run tc` passes without errors
12. ✅ `bun run lint` passes without errors

This feature adds critical safety to the resume workflow. The extensive test suite (51+ test cases) reflects the importance of getting change detection and user warnings right.
