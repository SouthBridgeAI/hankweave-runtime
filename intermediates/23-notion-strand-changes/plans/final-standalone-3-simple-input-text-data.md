# ENG-93: Run Strands with Simple Input Text as Data

> **Implementation Order:** Phase 2 (after CLI improvements) - See [00-index.md](00-index.md) for full context

## Related Plans

This task should be implemented after CLI improvements:

- **[ENG-106: Command Line Improvements](final-standalone-2-command-line-improvements.md)** - Introduces the `getArgValue()` helper function and parsing patterns this task uses
- **[ENG-105: Repository URLs](final-standalone-1-repository-link-strand.md)** - Both tasks add new input modes; could be combined with remote strands (see "Combining with Remote Strands" in examples)

## Task Summary

Allow users to provide simple text input directly via the command line or stdin, instead of always requiring a file or directory path. This enables quick experimentation and supports strands designed to operate on text content rather than file structures.

**Original Request (Hrishi Olickel):**
> "We can place it into a file in the directory (without symlinks) to do the run. Would be useful for design strands, and for quick testing. The idea here is that much like claude we can do --input or something and provide a simple string for it to run on."

## Sources and Context

### Linear Ticket
- **Identifier:** ENG-93
- **Status:** In Progress
- **Priority:** High
- **Labels:** Minor
- **Created:** 2025-12-18

### Original Planning Documents
The following documents were synthesized by the Step 4 Agent to create this plan:
- [`supporting-docs/3-simple-input-text-data-full-task.md`](supporting-docs/3-simple-input-text-data-full-task.md) - Original task with Step 1/2/3 agent analysis
- [`supporting-docs/3-simple-input-text-data-related-code.md`](supporting-docs/3-simple-input-text-data-related-code.md) - Codebase integration points
- [`supporting-docs/3-simple-input-text-data-changes-decisions-and-judgement-calls.md`](supporting-docs/3-simple-input-text-data-changes-decisions-and-judgement-calls.md) - Technical decisions

### Key Code Finding (from Step 2 Agent)

The Step 2 Agent discovered that **file support already exists** in the codebase:

> "File support ALREADY EXISTS in the code! The execution-setup.ts code (lines 179-196) handles files perfectly. What's missing is creating files from stdin or inline text."

The existing file handling code in `server/execution-setup.ts`:
```typescript
if (stats.isFile()) {
  await fs.promises.mkdir(dataPathInExecutionDir, { recursive: true });
  const destFilePath = path.join(dataPathInExecutionDir, path.basename(readOnlySourceDataPath));

  if (useSymlink) {
    await fs.promises.symlink(readOnlySourceDataPath, destFilePath);
  } else {
    await fs.promises.copyFile(readOnlySourceDataPath, destFilePath);
  }
}
```

This means the implementation only needs to create temporary files from stdin/inline text, then leverage the existing file handling infrastructure.

### Research Findings (from Step 3 Agent)

The Step 3 Agent's research validated the stdin convention:

> "The hyphen convention for stdin has deep Unix roots dating to Ken Thompson in Version 5 Unix, when he modified `sort` to accept '-' for standard input. This spread throughout Unix tools and became so standard that many commands automatically treat '-' as stdin/stdout."

Sources cited:
- [Baeldung: dash in command-line parameters](https://www.baeldung.com/linux/dash-in-command-line-parameters)
- [LinuxVox: magic of dash in command-line](https://linuxvox.com/blog/what-s-the-magic-of-a-dash-in-command-line-parameters/)

## Decision Points and Judgement Calls

### Decision 1: Use `-` for stdin (Unix Convention)

**The Step 4 Agent recommends:** Support `--data=-` and `-` as a positional argument to read from stdin.

**Examples:**
```bash
# With flag
echo "Analyze this text" | strandweave --data=- strand.json

# With positional (if ENG-106 is implemented)
echo "Analyze this text" | strandweave strand.json -

# Piping file content
cat requirements.txt | strandweave strand.json -
```

**Rationale:** This follows the universal Unix convention established by Ken Thompson. Users already expect `-` to mean stdin.

### Decision 2: Add `--data-text` Flag for Inline Text

**The Step 4 Agent recommends:** Add a new `--data-text="text"` flag for providing text directly without piping.

**Examples:**
```bash
# Quick experiment
strandweave strand.json --data-text="Design a REST API for a todo app"

# With space-separated syntax
strandweave strand.json --data-text "Multi-line text here"
```

**Rationale:** While stdin covers piping use cases, inline text is more ergonomic for quick experiments where you don't want to use `echo` or `cat`.

### Decision 3: Temporary File Strategy

**The Step 4 Agent recommends:** Create temporary files in the system temp directory, then use the existing file handling logic.

**Implementation approach:**
1. Detect stdin (`-`) or inline text (`--data-text`)
2. Read content into memory
3. Write to temp file: `os.tmpdir()/strandweave-input-{timestamp}-{random}.txt`
4. Pass temp file path to existing execution setup logic
5. Let OS handle temp file cleanup (no explicit cleanup needed)

**Temp file naming:**
```typescript
const tempFile = path.join(
  os.tmpdir(),
  `strandweave-input-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
);
```

**Rationale:** This approach:
- Reuses existing file handling code (no duplication)
- Uses cross-platform temp directory
- Includes timestamp and random suffix for uniqueness
- Relies on OS for cleanup (temp directories are ephemeral by nature)

### Decision 4: Precedence Order

**The Step 4 Agent recommends:** `--data-text` > `--data` > positional > default

**Precedence rules:**
1. If `--data-text` provided, use inline text (highest priority)
2. Else if `--data=-` or positional `-`, read from stdin
3. Else if `--data` or positional path provided, use that path
4. Else use current directory as default

**Rationale:** Explicit inline text takes precedence since it's the most specific form of input specification.

### Decision 5: Document Temp File Location in Execution Metadata

**The Step 4 Agent recommends:** Store the original input source information in execution metadata for debugging.

**Add to `.strandweave/execution-meta.json`:**
```json
{
  "dataSource": {
    "type": "inline-text",
    "originalLength": 1234,
    "tempFilePath": "/tmp/strandweave-input-12345-abc.txt"
  }
}
```

**Rationale (from Step 3 Agent):**
> "Temp file cleanup strategy should be explicit even if OS handles it eventually. Consider documenting the temp file location in execution metadata for debugging."

## Implementation Plan

### Step 1: Add stdin Reading Function

**Create helper function in `server/index.ts`:**

```typescript
async function readStdin(): Promise<string> {
  // Check if stdin is a TTY (no piped input)
  if (process.stdin.isTTY) {
    throw new Error('No input provided on stdin. Use: echo "text" | strandweave strand.json -');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
```

### Step 2: Add Input Detection and Temp File Creation

**In `server/index.ts`, before execution setup:**

```typescript
import os from 'node:os';

// Parse data-text flag
const dataTextArg = getArgValue(args, '--data-text');

// Resolve data source
let resolvedDataPath: string;

if (dataTextArg) {
  // Inline text provided
  const tempFile = path.join(
    os.tmpdir(),
    `strandweave-input-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  await fs.promises.writeFile(tempFile, dataTextArg);
  resolvedDataPath = tempFile;
  console.log(`📝 Using inline text input (${dataTextArg.length} chars)`);

} else if (dataSourcePath === '-') {
  // stdin input
  const stdinContent = await readStdin();
  const tempFile = path.join(
    os.tmpdir(),
    `strandweave-stdin-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  await fs.promises.writeFile(tempFile, stdinContent);
  resolvedDataPath = tempFile;
  console.log(`📝 Using stdin input (${stdinContent.length} chars)`);

} else {
  // Normal path (existing behavior)
  resolvedDataPath = path.resolve(dataSourcePath || originalCwd);
}
```

### Step 3: Update CLI Argument Validation

**Add new patterns to `server/index.ts` (around line 72):**

```typescript
const validPatterns = [
  // ... existing patterns ...
  /^--data-text(=.+)?$/,  // New: inline text flag
  // Note: '-' as positional is handled by /^[^-]/ pattern
];
```

### Step 4: Update Help Text

**Add to help text (around line 116):**

```typescript
console.log(`
Strandweave Runtime - Codon Orchestration

Usage: strandweave [options] [strand] [data]

Arguments:
  strand                    Path to strand configuration (default: strand.json)
  data                      Path to data, or "-" for stdin (default: current directory)

Options:
  --data-text <text>        Use inline text as data input
  --data <path>             Path to data file or directory, "-" for stdin
  ...

Examples:
  # Use inline text
  strandweave strand.json --data-text "Analyze this text"

  # Pipe from stdin
  echo "Design a REST API" | strandweave strand.json -

  # Pipe file contents
  cat spec.md | strandweave strand.json --data=-
`);
```

### Step 5: Store Input Metadata

**Modify execution setup to track input source:**

In `server/execution-setup.ts`, when creating execution metadata, include:

```typescript
// In execution metadata
const executionMeta = {
  ...existingMetadata,
  dataSource: dataSourcePath.startsWith(os.tmpdir())
    ? {
        type: dataSourcePath.includes('stdin') ? 'stdin' : 'inline-text',
        tempFilePath: dataSourcePath,
      }
    : {
        type: stats.isDirectory() ? 'directory' : 'file',
        originalPath: readOnlySourceDataPath,
      },
};
```

## Code Integration Points

### Primary Integration: `server/index.ts`

Main changes are in the argument parsing and data source resolution sections:
- Lines 72-93: Add `--data-text` to validation patterns
- Lines 101-111: Add data-text parsing and stdin detection
- Lines 207-209: Resolve data path with temp file handling

### Secondary Integration: `server/execution-setup.ts`

Minor change to record input source type in execution metadata (lines around 130-140).

### No Changes Needed

The existing file handling logic in `execution-setup.ts` (lines 179-196) already handles single files correctly. Once we create a temp file, this code processes it automatically.

## Testing Strategy

This feature adds stdin and inline text input handling. Testing should focus on input detection, temp file creation, and precedence rules. Since it reuses existing file handling, we don't need extensive tests of file mounting logic.

### Unit Tests (tests/unit/input-text.test.ts)

Focus on input type detection and precedence:

```typescript
describe("input type detection", () => {
  test("detects stdin marker", () => {
    expect(isStdinInput('-')).toBe(true);
    expect(isStdinInput('./data')).toBe(false);
    expect(isStdinInput('/absolute/path')).toBe(false);
  });

  test("detects inline text", () => {
    expect(hasInlineText(['--data-text=hello'])).toBe(true);
    expect(hasInlineText(['--data-text', 'hello'])).toBe(true);
    expect(hasInlineText(['--data=/path'])).toBe(false);
  });
});

describe("precedence", () => {
  test("--data-text takes precedence over --data", () => {
    const args = ['--data=/path', '--data-text=inline'];
    const resolved = resolveDataSource(args);
    expect(resolved.type).toBe('inline-text');
    expect(resolved.content).toBe('inline');
  });

  test("--data-text takes precedence over stdin", () => {
    const args = ['--data=-', '--data-text=inline'];
    const resolved = resolveDataSource(args);
    expect(resolved.type).toBe('inline-text');
  });

  test("stdin takes precedence over regular path", () => {
    const args = ['--data=/path', '--data=-'];
    const resolved = resolveDataSource(args);
    expect(resolved.type).toBe('stdin');
  });
});

describe("temp file naming", () => {
  test("generates unique temp file names", () => {
    const name1 = generateTempFileName('input');
    const name2 = generateTempFileName('input');
    expect(name1).not.toBe(name2);
    expect(name1).toMatch(/strandweave-input-/);
    expect(name2).toMatch(/strandweave-input-/);
  });

  test("distinguishes stdin vs inline text in filename", () => {
    const stdinName = generateTempFileName('stdin');
    const inlineName = generateTempFileName('input');
    expect(stdinName).toContain('stdin');
    expect(inlineName).toContain('input');
  });
});
```

**Rationale:** Input type detection and precedence are the core logic. Getting these wrong means processing the wrong input source.

### Integration Tests (tests/integration/input-text.test.ts)

Test temp file creation and content handling:

```typescript
describe("Temp File Creation", () => {
  let tempFiles: string[] = [];

  afterEach(() => {
    // Cleanup temp files
    tempFiles.forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
    tempFiles = [];
  });

  test("creates temp file from inline text", async () => {
    const result = await resolveDataInput({
      dataText: 'test content\nwith newlines',
    });

    tempFiles.push(result.tempFile);
    expect(result.tempFile).toMatch(/strandweave-input-/);
    expect(fs.existsSync(result.tempFile)).toBe(true);

    const content = await fs.promises.readFile(result.tempFile, 'utf-8');
    expect(content).toBe('test content\nwith newlines');
  });

  test("handles large inline text", async () => {
    const largeText = 'x'.repeat(100000); // 100KB
    const result = await resolveDataInput({ dataText: largeText });

    tempFiles.push(result.tempFile);
    const content = await fs.promises.readFile(result.tempFile, 'utf-8');
    expect(content.length).toBe(100000);
  });

  test("handles special characters in inline text", async () => {
    const specialText = 'Hello "world" \n\t <>&';
    const result = await resolveDataInput({ dataText: specialText });

    tempFiles.push(result.tempFile);
    const content = await fs.promises.readFile(result.tempFile, 'utf-8');
    expect(content).toBe(specialText);
  });

  test("creates temp file from stdin", async () => {
    // Mock stdin
    const mockStdin = new PassThrough();
    mockStdin.write('stdin content\n');
    mockStdin.write('line 2');
    mockStdin.end();

    const result = await resolveDataInput({
      dataPath: '-',
      stdin: mockStdin,
    });

    tempFiles.push(result.tempFile);
    expect(result.tempFile).toMatch(/strandweave-stdin-/);

    const content = await fs.promises.readFile(result.tempFile, 'utf-8');
    expect(content).toBe('stdin content\nline 2');
  });

  test("errors when stdin is TTY (no piped input)", async () => {
    // Mock TTY stdin
    const mockStdin = new PassThrough();
    mockStdin.isTTY = true;

    await expect(resolveDataInput({
      dataPath: '-',
      stdin: mockStdin,
    })).rejects.toThrow('No input provided on stdin');
  });

  test("records input source in metadata", async () => {
    const result = await resolveDataInput({
      dataText: 'test content',
    });

    tempFiles.push(result.tempFile);
    expect(result.metadata).toEqual({
      type: 'inline-text',
      originalLength: 12,
      tempFilePath: result.tempFile,
    });
  });
});
```

**Rationale:** Temp file creation is the most brittle part - files must be created with correct permissions, content must be preserved exactly, and edge cases (large inputs, special characters) must work.

### E2E Test: Attach to Existing Suite

Add to tests/e2e/happy-path-e2e.test.ts:

```typescript
describe("Text Input Modes", () => {
  test("runs strand with inline text", async () => {
    const result = await startServer({
      args: [
        TEST_STRAND_PATH,
        '--data-text', 'Analyze this: Hello, Strandweave!',
        '--start-new',
      ],
    });

    expect(result.success).toBe(true);
    // Verify execution metadata shows inline-text
    const meta = readExecutionMetadata(result.executionPath);
    expect(meta.dataSource?.type).toBe('inline-text');
  });

  test("runs strand with piped stdin", async () => {
    // Simulate piped input
    const stdinContent = 'Design a REST API for user management';

    const result = await startServerWithStdin({
      args: [
        TEST_STRAND_PATH,
        '--data', '-',
        '--start-new',
      ],
      stdin: stdinContent,
    });

    expect(result.success).toBe(true);
    const meta = readExecutionMetadata(result.executionPath);
    expect(meta.dataSource?.type).toBe('stdin');
  });

  test("agent can read inline text from data directory", async () => {
    // Create a strand that reads and outputs the data
    const echoStrand = createTestStrand({
      codons: [{
        id: 'echo',
        promptText: 'Read the file in <%DATA_DIR%> and output its content to result.txt',
        checkpointedFiles: ['result.txt'],
      }],
    });

    const result = await startServer({
      config: echoStrand,
      args: [
        '--data-text', 'test input content',
        '--start-new',
      ],
    });

    expect(result.success).toBe(true);
    const output = fs.readFileSync(
      path.join(result.executionPath, 'result.txt'),
      'utf-8'
    );
    expect(output).toContain('test input content');
  });
});
```

**Rationale:** E2E tests verify the full flow works: temp files are created, mounted correctly into the execution environment, and agents can access the content.

### No Need for Extensive File Mounting Tests

The plan notes that "file support ALREADY EXISTS in the code" (execution-setup.ts lines 179-196). Since we're reusing existing file handling, we don't need to test file mounting extensively. The existing tests for file-based data sources already cover this.

**Focus:** Test only the new parts (stdin reading, inline text handling, temp file creation). Trust the existing file mounting code.

## Example Use Cases

### Design Strands

```bash
# Generate API design from description
strandweave api-designer.json --data-text="Build a REST API for managing user tasks with authentication"

# Generate database schema
strandweave schema-generator.json --data-text="E-commerce platform with users, products, orders, and reviews"
```

### Quick Analysis

```bash
# Analyze text sentiment
echo "The product exceeded expectations!" | strandweave sentiment.json -

# Summarize document
cat meeting-notes.md | strandweave summarize.json -
```

### Combining with Remote Strands (if ENG-105 implemented)

```bash
# Use a shared design strand with inline input
strandweave https://github.com/user/design-strand --data-text="Design a REST API for X"
```

## Complexity Assessment

**Overall complexity:** Low

**Breakdown:**
- stdin reading: ~20 lines
- `--data-text` handling: ~15 lines
- Temp file creation: ~10 lines
- Validation pattern updates: ~5 lines
- Help text updates: ~10 lines
- Metadata tracking: ~15 lines

**Total new code:** ~75 lines

## Risk Mitigation

### Risk 1: Large Input Causing Memory Issues
**Mitigation:** For stdin, read in chunks using async iteration. Could add an optional size limit with clear error message.

### Risk 2: Temp Files Accumulating
**Mitigation:** Temp files are in OS temp directory which is periodically cleaned. For extra safety, could register cleanup on process exit, but this is likely over-engineering for initial implementation.

### Risk 3: Encoding Issues
**Mitigation:** Use UTF-8 consistently. For binary data, users should use normal `--data` with file paths.

### Risk 4: TTY Detection on Windows
**Mitigation:** `process.stdin.isTTY` works on Windows. May need testing to confirm behavior in various terminal emulators.

## Dependencies

**No new dependencies.** Uses only built-in Node.js modules:
- `os` for temp directory
- `fs` for file operations (already imported)
- `process.stdin` for stdin reading

## Backward Compatibility

This is purely additive. All existing behavior remains unchanged:
- `--data=/path/to/dir` continues to work
- `--data=/path/to/file` continues to work
- Default data source (current directory) continues to work

New capabilities:
- `--data=-` reads from stdin
- `--data-text="text"` uses inline text
- `-` as positional argument reads from stdin (if ENG-106 implemented)

---

## Testing Requirements and Affected Tests

This section documents all tests needed for this feature and any existing tests that might be affected.

### Tests That Must Be Updated (Required Changes)

This feature is purely additive, so existing tests should not need updates. However, some tests may need verification:

#### Unit Tests

1. **tests/unit/execution-setup.test.ts**
   - Currently tests file and directory handling in execution setup
   - Should verify it still works when temp files are passed as data source
   - **Action:** Run existing tests to ensure no regressions
   - **Potential issue:** Temp file paths might trigger unexpected behavior

2. **tests/unit/path-validation.test.ts** (if exists)
   - May need to handle temp file paths differently
   - **Action:** Verify path validation allows temp directory paths

#### Integration Tests

3. **tests/integration/config-resolution.test.ts**
   - Tests config and data path resolution
   - Should still work with temp file paths
   - **Action:** Run existing tests

4. **tests/integration/event-journal.test.ts**
   - Tests event logging for file operations
   - May record temp file paths in events
   - **Action:** Verify events are logged correctly for inline text input

#### E2E Tests

5. **tests/e2e/happy-path-e2e.test.ts**
   - Currently uses file/directory data sources
   - Should continue to work unchanged
   - **Action:** Run full E2E suite to verify no regressions

### New Tests To Add (Test the New Feature)

Based on the Testing Strategy section, these specific tests must be created:

#### 1. Input Type Detection Unit Tests (tests/unit/input-text.test.ts) - NEW FILE

```typescript
describe("input type detection", () => {
  test("detects stdin marker");
  test("detects inline text");
});

describe("precedence", () => {
  test("--data-text takes precedence over --data");
  test("--data-text takes precedence over stdin");
  test("stdin takes precedence over regular path");
});

describe("temp file naming", () => {
  test("generates unique temp file names");
  test("distinguishes stdin vs inline text in filename");
});
```

**Estimated:** 8-10 test cases, ~200 lines of code
**Status:** Must be created
**Coverage:** Input detection, precedence rules, temp file generation

#### 2. Temp File Creation Integration Tests (tests/integration/input-text.test.ts) - NEW FILE

```typescript
describe("Temp File Creation", () => {
  let tempFiles: string[] = [];

  afterEach(() => {
    // Cleanup temp files
    tempFiles.forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
    tempFiles = [];
  });

  test("creates temp file from inline text");
  test("handles large inline text");
  test("handles special characters in inline text");
  test("creates temp file from stdin");
  test("errors when stdin is TTY (no piped input)");
  test("records input source in metadata");
});
```

**Estimated:** 8-12 test cases, ~300 lines of code
**Status:** Must be created
**Coverage:** Temp file operations, content preservation, error handling

#### 3. E2E Text Input Tests (add to tests/e2e/happy-path-e2e.test.ts)

```typescript
describe("Text Input Modes", () => {
  test("runs strand with inline text");
  test("runs strand with piped stdin");
  test("agent can read inline text from data directory");
});
```

**Estimated:** 3-5 test cases, integrated into existing E2E file
**Status:** Must add test group to existing file
**Coverage:** End-to-end workflow with text input

### Regression Tests (Critical - Must Pass)

After implementing this feature, these existing test suites must pass unchanged:

1. **File System Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Test group: `runFileSystemTests`
   - Ensures existing file handling still works
   - **Critical:** Temp files shouldn't interfere with normal file operations

2. **Execution Setup Tests** (tests/unit/execution-setup.test.ts)
   - Ensures execution directory creation works with temp files
   - **Critical:** Must handle temp file paths correctly

3. **Path Consistency Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Test group: `runPathConsistencyTests`
   - Ensures paths are resolved correctly

4. **Data Mounting Tests**
   - The existing code handles files correctly (lines 179-196 of execution-setup.ts)
   - Tests should verify temp files are mounted correctly
   - **Action:** Run existing file mounting tests

### CI/CD Pipeline Considerations

The CI/CD pipeline (`.github/workflows/ci.yml`) should handle this feature transparently:

1. **Lint and Type Check** (Job: `lint-and-typecheck`)
   - New stdin reading function must pass linting
   - Type definitions for input resolution must be correct
   - **Action:** Run `bun run tc` locally

2. **Unit & Integration Tests** (Job: `tests`)
   - New unit tests must be included
   - All integration tests must pass
   - **Action:** Verify `bun test tests/unit` and `bun test tests/integration` pass

3. **E2E Tests**
   - Existing E2E tests should pass unchanged
   - New text input tests should be included
   - **Action:** Run full E2E suite

4. **No Init Command Changes**
   - The `--init` command doesn't need updates for this feature
   - **Action:** Verify init E2E tests still pass

### Test Execution Checklist

Execute tests in this order:

```bash
# 1. Type check
bun run tc

# 2. Linting
bun run lint:fix

# 3. Unit tests - NEW tests first
bun test tests/unit/input-text.test.ts  # New file
bun test tests/unit/execution-setup.test.ts  # Verify no regressions
bun test tests/unit  # All unit tests

# 4. Integration tests - NEW tests
bun test tests/integration/input-text.test.ts  # New file
bun test tests/integration  # All integration tests

# 5. E2E tests (expensive)
bun test tests/e2e/happy-path-e2e.test.ts  # With new text input test group
bun test tests/e2e  # All E2E tests
```

### Manual Testing Scenarios

Test these scenarios manually to verify user experience:

#### 1. Inline Text Input

```bash
# Basic inline text
strandweave strand.json --data-text "Analyze this text"

# Multi-line text
strandweave strand.json --data-text "Line 1
Line 2
Line 3"

# Text with special characters
strandweave strand.json --data-text "Text with \"quotes\" and 'apostrophes' & symbols"
```

#### 2. Stdin Input

```bash
# Echo to stdin
echo "Analyze this text" | strandweave strand.json --data=-

# Pipe file contents
cat requirements.txt | strandweave strand.json --data=-

# Here document
strandweave strand.json --data=- <<EOF
Multi-line
text input
from stdin
EOF
```

#### 3. Positional Argument (if ENG-106 implemented)

```bash
# Using - as positional
echo "Text" | strandweave strand.json -
```

#### 4. Verify Temp File Creation

```bash
# Run with inline text and check temp directory
strandweave strand.json --data-text "test" &
sleep 1
ls -la /tmp/strandweave-*
# Should show temp file
```

#### 5. Verify Metadata Recording

```bash
# Run strand with inline text
strandweave strand.json --data-text "test input" --start-new

# Check execution metadata
cat ~/.strandweave-executions/*/. strandweave/execution-meta.json
# Should show dataSource.type: "inline-text"
```

### Error Handling Tests

Ensure these error conditions are handled gracefully:

```bash
# 1. No stdin when - is specified (should error)
strandweave strand.json --data=-
# Error: No input provided on stdin. Use: echo "text" | strandweave strand.json -

# 2. Both --data-text and --data-file (precedence test)
strandweave strand.json --data-text "inline" --data=/path/to/file
# Should use inline text (higher precedence)

# 3. Empty inline text (should work or error gracefully)
strandweave strand.json --data-text ""

# 4. Very large inline text (should handle or error with clear message)
strandweave strand.json --data-text "$(cat large-file.txt)"
```

### Search Commands for Implementation

Use these commands during implementation:

```bash
# Find data source handling code
grep -r "readOnlySourceDataPath" server/

# Find execution setup data handling
grep -rn "stats.isFile()" server/execution-setup.ts

# Verify temp file creation
grep -r "os.tmpdir()" server/

# Find CLI argument parsing for --data
grep -r "args.find.*--data" server/index.ts
```

### Summary of Test Impact

| Test Type | New Files | Updated Files | Test Cases | Lines of Code |
|-----------|-----------|---------------|------------|---------------|
| Unit Tests | 1 new file | 0 files | ~10 cases | ~200 lines |
| Integration Tests | 1 new file | 0 files | ~10 cases | ~300 lines |
| E2E Tests | 0 new files | 1 file | ~5 cases | ~100 lines |
| Manual Tests | N/A | N/A | 5 scenarios | N/A |
| **Total** | **2 new files** | **1 file** | **~25 cases** | **~600 lines** |

**Estimated Time for New Tests:** 3-4 hours
**Estimated Time for Manual Testing:** 1 hour
**Total Testing Effort:** 4-5 hours

### Temp File Cleanup Verification

**Important:** Verify OS temp directory doesn't accumulate stale files:

```bash
# Before running tests
ls /tmp/strandweave-* | wc -l

# Run test suite
bun test tests/integration/input-text.test.ts

# After running tests
ls /tmp/strandweave-* | wc -l
# Should be the same or fewer (cleanup successful)
```

The implementation relies on OS cleanup, but tests should explicitly clean up temp files in `afterEach` blocks.

### Special Considerations for Testing

1. **TTY Detection**
   - Tests must mock `process.stdin.isTTY` to test error cases
   - Use `PassThrough` streams to simulate piped input

2. **Content Preservation**
   - Tests must verify exact content preservation (no encoding issues)
   - Test with special characters: `\n`, `\t`, `"`, `'`, `&`, etc.

3. **Large Input Handling**
   - Test with 100KB+ text to verify memory handling
   - Ensure no truncation or corruption

4. **Path Conflicts**
   - Verify temp files don't conflict with existing execution files
   - Test running multiple strands simultaneously with inline text

### Critical Success Criteria

Before considering this implementation complete, verify:

1. ✅ Temp files are created with unique names
2. ✅ Content is preserved exactly (no encoding issues)
3. ✅ Precedence rules work correctly (--data-text > --data > positional)
4. ✅ stdin detection errors when no input piped
5. ✅ Metadata records input source type
6. ✅ Existing file/directory data sources continue to work
7. ✅ All existing E2E tests pass unchanged
8. ✅ Manual testing confirms user experience is smooth
9. ✅ `bun run tc` passes without errors
10. ✅ `bun run lint` passes without errors

This is a clean, additive feature with minimal risk of breaking existing functionality. The main testing focus is on the new input modes and ensuring temp file handling is robust.
