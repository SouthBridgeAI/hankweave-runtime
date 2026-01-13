# ENG-106: Command Line Behavior Quality of Life Improvements

> **Implementation Order:** Phase 2 (foundational) - See [00-index.md](00-index.md) for full context

## Related Plans

This is foundational work that enables other improvements:

- **[ENG-93: Simple Input Text](final-standalone-3-simple-input-text-data.md)** - Uses the parsing patterns introduced here
- **[ENG-105: Repository URLs](final-standalone-1-repository-link-strand.md)** - Builds on CLI patterns and adds new flags following the same conventions

## Task Summary

Modernize Strandweave's command-line interface to match common Unix/CLI conventions. This includes supporting space-separated flag values (instead of equals signs), adding positional arguments for strand and data paths, making the TUI default, and turning off the proxy by default.

This is an umbrella task that encompasses five related subtasks: ENG-22 (remove equals signs), ENG-21 (relative paths), ENG-101 (TUI default), ENG-96 (proxy off), and the main ENG-106 (positional arguments).

**Original Request (Hrishi Olickel):**
> "We should do a bit of a rethink to make sure strandweave's command line configs are easy to grok and use. Some things off the top of my head:
> 1. A strand shouldn't be a parameter (since it's required) - it should just be the input. So no switch. Also data. One way is `strandweave <strand> <data>`?
> 2. Ideally the basic cli and autostart is on by default.
> 3. Let's turn off the proxy by default."

## Sources and Context

### Linear Tickets

| Ticket | Title | Priority | Key Quote |
|--------|-------|----------|-----------|
| ENG-106 | Command line behavior quality of life improvements | High | Main umbrella task |
| ENG-22 | Remove the equals in arguments passed to the cli | No priority | "Better shell autocompletion that way" |
| ENG-21 | Allow relative paths when calling the server | High | "Realised this is a pretty big hurdle when quickly using the server" |
| ENG-101 | Make --basic the default option | High | "Let's reduce the number of config params to start strandweave" |
| ENG-96 | Turn off proxy by default | Low | "We're not using it for anything at the moment - and it causes some brittleness" |
| ENG-90 | Fixing execution directory behavior | Urgent | Related but separate |

### Original Planning Documents
The following documents were synthesized by the Step 4 Agent to create this plan:
- [`supporting-docs/2-command-line-improvements-full-task.md`](supporting-docs/2-command-line-improvements-full-task.md) - Original task with Step 1/2/3 agent analysis
- [`supporting-docs/2-command-line-improvements-related-code.md`](supporting-docs/2-command-line-improvements-related-code.md) - Codebase integration points
- [`supporting-docs/2-command-line-improvements-changes-decisions-and-judgement-calls.md`](supporting-docs/2-command-line-improvements-changes-decisions-and-judgement-calls.md) - Technical decisions

### Research Findings (from Step 3 Agent)

The Step 3 Agent's research on CLI design validated the proposed approach:

1. **Space-separated is standard:** According to the [Command Line Interface Guidelines (clig.dev)](https://clig.dev/), the most important principle is "predictability and familiarity." Space-separated values (`--config value`) are the standard across Unix tools, while equals format (`--config=value`) is less common and breaks shell autocompletion.

2. **Positional arguments are powerful when order matters:** The [Unix convention](https://betterdev.blog/command-line-arguments-anatomy-explained/) distinguishes between "arguments" (positional parameters) and "flags" (named parameters). For required inputs with a natural order (strand then data), positional arguments are idiomatic.

3. **Double-dash convention:** The `--` separator for options from positionals is well-established if ever needed for disambiguation.

4. **Backward compatibility matters most:** Supporting both old and new formats maximizes both predictability and familiarity. Breaking working scripts for aesthetic reasons would violate Unix philosophy.

### Surprising Code Finding (from Step 2 Agent)

The Step 2 Agent discovered that ENG-21 (relative paths) might already be fixed:

> "The code correctly saves CWD before changing directories, then uses the saved value for path resolution. This SHOULD handle relative paths correctly. Either this is already fixed and users haven't retested, OR there's a specific edge case that breaks."

The relevant code in `server/index.ts`:
```typescript
const originalCwd = process.cwd(); // Line 208 - saves CWD BEFORE any changes
// ... execution setup happens ...
process.chdir(executionSetup.executionPath);  // Line 230 - changes CWD
// ... later, for config resolution ...
const absoluteConfigPath = path.isAbsolute(configPath)
  ? configPath
  : path.resolve(originalCwd, configPath);  // Uses SAVED original CWD
```

**Step 4 Agent recommendation:** Write comprehensive tests for relative paths before implementing any changes. If tests pass, update documentation and close ENG-21 as "already works."

## Decision Points and Judgement Calls

### Decision 1: Enhanced Hand-Rolled Parsing (No CLI Library)

**The Step 4 Agent recommends:** Enhance the current parsing approach to support both formats permanently. Do not add CLI libraries like commander, yargs, or minimist.

**Rationale:**
- Current code is simple and works (approximately 80 lines)
- Libraries add complexity for minimal benefit in this case
- Full control over backward compatibility behavior
- Zero new dependencies

**The parsing helper function:**
```typescript
function getArgValue(args: string[], flagName: string): string | undefined {
  // Try equals format first (--config=value)
  const equalsArg = args.find(arg => arg.startsWith(`${flagName}=`));
  if (equalsArg) {
    return equalsArg.split('=', 2)[1];  // split with limit to handle = in value
  }

  // Try space format (--config value)
  const flagIndex = args.indexOf(flagName);
  if (flagIndex !== -1 && flagIndex + 1 < args.length) {
    const nextArg = args[flagIndex + 1];
    if (!nextArg.startsWith('-')) {
      return nextArg;
    }
  }

  return undefined;
}
```

### Decision 2: Full Backward Compatibility Forever

**The Step 4 Agent recommends:** Support both old and new syntax permanently with no deprecation period.

**Examples of equivalent commands (all work):**
```bash
strandweave                                    # Uses defaults
strandweave strand.json                        # Positional strand
strandweave strand.json /data                  # Both positional
strandweave --config strand.json               # Space-separated flag
strandweave --config=strand.json               # Equals format (old)
strandweave strand.json --data /data           # Mixed styles
```

**Rationale:**
- Easy to support both with our parsing approach
- User scripts continue to work without changes
- No migration documentation needed
- Documentation shows "preferred" vs "also works" styles

### Decision 3: Precedence Order (Flags > Positionals > Defaults)

**The Step 4 Agent recommends:** When both flags and positional arguments are provided, flags take precedence.

**Example:**
```bash
strandweave strand1.json --config strand2.json
# Result: Uses strand2.json (flag wins)
```

**Rationale:** This matches user expectations where explicit flags override implicit positionals. It also allows using positionals as convenient defaults while still permitting flag overrides.

### Decision 4: Make TUI Default with `--headless` to Disable

**Current:** Server starts in non-TUI mode unless `--basic` or `-b` provided.
**Proposed:** Server starts in TUI mode by default, `--headless` to disable.

**Implementation:**
```typescript
// OLD:
const basicMode = args.includes('--basic') || args.includes('-b');

// NEW:
const headlessMode = args.includes('--headless');
const basicMode = !headlessMode;  // TUI is default
```

**Rationale:**
- TUI improves user experience significantly
- Scripts/automation won't break (TUI is non-blocking)
- Explicitly requested in ENG-101
- Keep `--basic` working for backward compatibility

### Decision 5: Turn Off Proxy by Default with `--proxy` to Enable

**Current:** Proxy enabled by default, `--without-proxy` to disable.
**Proposed:** Proxy disabled by default, `--proxy` to enable.

**Implementation:**
```typescript
// In config.ts DEFAULT_CONFIG:
withoutProxy: true,  // Changed from false

// In index.ts:
if (args.includes('--proxy')) {
  cliArgs.withoutProxy = false;  // Enable proxy
}
// Keep --without-proxy working for backward compatibility
```

**Rationale (from Hrishi in ENG-96):**
> "We're not using it for anything at the moment - and it causes some brittleness."

### Decision 6: Error on Too Many Positional Arguments

**The Step 4 Agent recommends:** Throw an error if more than 2 positional arguments are provided.

```bash
strandweave a b c
# Error: Too many arguments. Expected: [strand] [data], got: a b c
```

**Rationale:** Errors help catch typos. Warning and ignoring extras could mask user mistakes.

## Implementation Plan

### Phase 1: Space-Separated Flags (Low Risk, Quick Win)

**Files to modify:**

1. **`server/index.ts`** - Replace all `split("=")[1]` parsing with `getArgValue()` helper.

   **Current code (lines 101-104):**
   ```typescript
   const configPath =
     args.find((arg) => arg.startsWith("--config="))?.split("=")[1] || "strand.json";
   const dataSourcePath = args.find((arg) => arg.startsWith("--data="))?.split("=")[1];
   ```

   **New code:**
   ```typescript
   const configPath = getArgValue(args, '--config') || 'strand.json';
   const dataSourcePath = getArgValue(args, '--data');
   ```

2. **Update validation patterns** (lines 72-93):

   **Current patterns:**
   ```typescript
   /^--config=.+$/,
   /^--data=.+$/,
   /^--port=\d+$/,
   ```

   **New patterns:**
   ```typescript
   /^--config(=.+)?$/,  // Matches --config and --config=value
   /^--data(=.+)?$/,
   /^--port(=\d+)?$/,
   /^[^-]/,             // Allow positional arguments (doesn't start with -)
   ```

### Phase 2: Default Behavior Changes (Low Risk)

1. **Make TUI default:**
   ```typescript
   // Add to valid patterns:
   /^--headless$/,

   // Change mode detection:
   const headlessMode = args.includes('--headless');
   const basicMode = !headlessMode;
   ```

2. **Turn off proxy:**
   ```typescript
   // In config.ts line 672:
   withoutProxy: true,  // Changed from false

   // In index.ts, add proxy flag support:
   /^--proxy$/,  // Add to valid patterns

   // In parseCliArgs:
   if (args.includes('--proxy')) {
     cliArgs.withoutProxy = false;
   }
   ```

### Phase 3: Positional Arguments (Medium Complexity)

**Implementation in `server/index.ts`:**

```typescript
// Extract positional arguments (non-flag arguments)
function extractPositionals(args: string[]): string[] {
  const flagsThatTakeValues = [
    '--config', '--data', '--execution', '--port', '--model',
    '--anthropic-base-url', '--idle-timeout'
  ];

  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Skip flags
    if (arg.startsWith('-')) {
      // If this flag takes a value (space-separated), skip next arg too
      if (flagsThatTakeValues.some(f => arg === f)) {
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          i++;  // Skip the value
        }
      }
      continue;
    }

    positionals.push(arg);
  }

  return positionals;
}

// In main():
const positionals = extractPositionals(args);

// Flags take precedence
const configFlag = getArgValue(args, '--config');
const dataFlag = getArgValue(args, '--data');

let configPath: string;
let dataSourcePath: string | undefined;

if (configFlag) {
  configPath = configFlag;
} else if (positionals.length > 0) {
  configPath = positionals[0];
} else {
  configPath = 'strand.json';
}

if (dataFlag) {
  dataSourcePath = dataFlag;
} else if (positionals.length > 1) {
  dataSourcePath = positionals[1];
}

if (positionals.length > 2) {
  console.error(`Error: Too many arguments. Expected: [strand] [data], got: ${positionals.join(' ')}`);
  process.exit(1);
}
```

### Phase 4: Help Text and Documentation Updates

**Update help text** (lines 115-180):

```typescript
console.log(`
Strandweave Runtime - Codon Orchestration

Usage: strandweave [options] [strand] [data]

Arguments:
  strand                    Path to strand configuration (default: strand.json)
  data                      Path to data directory (default: current directory)

Options:
  --init                    Initialize a new strand in current directory
  --config <path>           Path to strand configuration (default: strand.json)
  --data <path>             Path to data directory (default: current directory)
  --execution <path>        Resume in specific execution directory
  --start-new               Force creation of a new execution directory
  --copy                    Copy data instead of symlinking
  --port <port>             WebSocket server port (default: 7777)
  --headless                Run without TUI (TUI is default)
  --validate, -v            Validate configuration without running
  --cleanup                 Clean up execution directories
  -y                        Skip confirmation prompts
  --no-autostart            Don't automatically start codons
  --model <sonnet|opus>     Override model for all codons
  --anthropic-base-url <url> Custom Anthropic API base URL
  --proxy                   Enable proxy server (disabled by default)
  --idle-timeout <seconds>  Idle timeout in seconds (0-255, default: 0)
  --help, -h                Show this help message

Examples:
  # Simple usage (uses defaults)
  strandweave

  # Specify strand and data as positional arguments
  strandweave ./my-strand.json ./my-project

  # Using flags (also works)
  strandweave --config ./my-strand.json --data ./my-project

  # Run headless for CI/CD
  strandweave --headless ./strand.json ./data

  # Override model
  strandweave --model opus

  # Start fresh execution
  strandweave --start-new
`);
```

**Update README examples** to show preferred positional syntax while noting flag syntax "also works."

### Phase 5: Relative Path Testing

**Write comprehensive tests before changing any path handling code:**

```typescript
// tests/integration/relative-paths.test.ts

test('relative paths from parent directory', async () => {
  // /tmp/test-root/strand.json
  // /tmp/test-root/data/
  process.chdir('/tmp');
  const result = await runStrandweave(['test-root/strand.json', 'test-root/data']);
  expect(result.config).toBe('/tmp/test-root/strand.json');
});

test('relative paths with ../ navigation', async () => {
  process.chdir('/tmp/test-root/workspace');
  const result = await runStrandweave(['../strand.json', '../data']);
  expect(result.config).toBe('/tmp/test-root/strand.json');
});

test('relative paths with ./ prefix', async () => {
  process.chdir('/tmp/test-root');
  const result = await runStrandweave(['./strand.json', './data']);
  expect(result.config).toBe('/tmp/test-root/strand.json');
});
```

**If tests pass:** Update documentation, close ENG-21 as "already works."
**If tests fail:** Fix the specific edge case that fails.

## Code Integration Points

### Primary Integration: `server/index.ts`

All CLI parsing changes are concentrated in this file:
- Lines 22-60: `parseCliArgs()` function
- Lines 70-99: Validation patterns
- Lines 101-111: Argument extraction
- Lines 115-180: Help text
- Lines 376-382: TUI initialization

### Secondary Integration: `server/config.ts`

Only one change needed:
- Line 672: Change `withoutProxy: false` to `withoutProxy: true`

### Path Resolution (No Changes Expected)

The existing path resolution code at lines 208-253 of `index.ts` already correctly handles relative paths by saving `originalCwd` before `process.chdir()`. Testing will confirm this.

## Testing Strategy

This feature primarily changes CLI parsing and default behaviors. Testing should focus on argument parsing correctness, precedence rules, and backward compatibility to avoid breaking existing user scripts.

### Unit Tests (tests/unit/cli-parsing.test.ts)

Focus on the new `getArgValue()` helper and positional argument extraction:

```typescript
describe("getArgValue", () => {
  test("supports equals format", () => {
    expect(getArgValue(['--config=strand.json'], '--config')).toBe('strand.json');
    expect(getArgValue(['--data=/path/to/data'], '--data')).toBe('/path/to/data');
  });

  test("supports space format", () => {
    expect(getArgValue(['--config', 'strand.json'], '--config')).toBe('strand.json');
    expect(getArgValue(['--data', '/path/to/data'], '--data')).toBe('/path/to/data');
  });

  test("handles equals in value", () => {
    // Edge case: value contains =
    expect(getArgValue(['--data=foo=bar'], '--data')).toBe('foo=bar');
  });

  test("returns undefined when flag not present", () => {
    expect(getArgValue(['--other'], '--config')).toBeUndefined();
  });

  test("returns undefined when value looks like flag", () => {
    // Space format but next arg is a flag
    expect(getArgValue(['--config', '--other'], '--config')).toBeUndefined();
  });
});

describe("extractPositionals", () => {
  test("extracts non-flag arguments", () => {
    const positionals = extractPositionals(['strand.json', '/data']);
    expect(positionals).toEqual(['strand.json', '/data']);
  });

  test("skips flags and their values", () => {
    const positionals = extractPositionals(['--port', '8080', 'strand.json', '--model', 'opus', '/data']);
    expect(positionals).toEqual(['strand.json', '/data']);
  });

  test("handles mixed equals and space format", () => {
    const positionals = extractPositionals(['--port=8080', 'strand.json', '--model', 'opus', '/data']);
    expect(positionals).toEqual(['strand.json', '/data']);
  });

  test("handles empty arguments", () => {
    expect(extractPositionals([])).toEqual([]);
    expect(extractPositionals(['--config', 'strand.json'])).toEqual([]);
  });
});

describe("precedence rules", () => {
  test("flags take precedence over positionals", () => {
    const args = ['strand1.json', '--config', 'strand2.json'];
    const config = resolveConfig(args);
    expect(config).toBe('strand2.json');
  });

  test("positionals take precedence over defaults", () => {
    const args = ['custom-strand.json'];
    const config = resolveConfig(args);
    expect(config).toBe('custom-strand.json');
  });

  test("uses default when neither flag nor positional", () => {
    const args = ['--port', '8080'];
    const config = resolveConfig(args);
    expect(config).toBe('strand.json'); // Default
  });
});

describe("error handling", () => {
  test("errors on too many positional arguments", () => {
    expect(() => validateArgs(['a', 'b', 'c', 'd']))
      .toThrow(/Too many arguments/);
  });

  test("provides helpful error message", () => {
    expect(() => validateArgs(['a', 'b', 'c']))
      .toThrow(/Expected: \[strand\] \[data\], got: a b c/);
  });
});
```

**Rationale:** CLI parsing is error-prone with many edge cases (values with special characters, flag-like values, etc.). These tests ensure the parser handles all cases correctly.

### Integration Tests (tests/integration/cli-defaults.test.ts)

Test default behavior changes:

```typescript
describe("CLI Default Behaviors", () => {
  test("TUI is enabled by default", () => {
    const result = parseCliArgs([]);
    expect(result.basicMode).toBe(true);
  });

  test("--headless disables TUI", () => {
    const result = parseCliArgs(['--headless']);
    expect(result.basicMode).toBe(false);
  });

  test("--basic flag still works (backward compatibility)", () => {
    const result = parseCliArgs(['--basic']);
    expect(result.basicMode).toBe(true);
  });

  test("proxy is disabled by default", () => {
    const result = parseCliArgs([]);
    expect(result.withoutProxy).toBe(true);
  });

  test("--proxy enables proxy", () => {
    const result = parseCliArgs(['--proxy']);
    expect(result.withoutProxy).toBe(false);
  });

  test("--without-proxy still works (backward compatibility)", () => {
    const result = parseCliArgs(['--without-proxy']);
    expect(result.withoutProxy).toBe(true);
  });
});
```

**Rationale:** Default behavior changes are breaking changes if not handled carefully. These tests ensure both old and new flags work correctly.

### Backward Compatibility Tests (tests/integration/cli-backward-compat.test.ts)

Critical tests to ensure existing scripts don't break:

```typescript
describe("Backward Compatibility", () => {
  test("old equals format continues to work", () => {
    const args = ['--config=strand.json', '--data=/data', '--port=8080'];
    const result = parseCliArgs(args);

    expect(result.config).toBe('strand.json');
    expect(result.data).toBe('/data');
    expect(result.port).toBe(8080);
  });

  test("mixed old and new formats work together", () => {
    const args = ['--config=strand.json', '--data', '/data', '--port', '8080'];
    const result = parseCliArgs(args);

    expect(result.config).toBe('strand.json');
    expect(result.data).toBe('/data');
    expect(result.port).toBe(8080);
  });

  test("all old flags continue to work", () => {
    const oldStyleArgs = [
      '--config=strand.json',
      '--data=/data',
      '--execution=/exec',
      '--port=8080',
      '--model=opus',
      '--basic',
      '--without-proxy',
      '--start-new',
      '-y',
    ];

    expect(() => parseCliArgs(oldStyleArgs)).not.toThrow();
  });
});
```

**Rationale:** The most important aspect of this change is maintaining backward compatibility. These tests verify that all existing usage patterns continue to work.

### E2E Test: Attach to Existing Suite

Add to tests/e2e/happy-path-e2e.test.ts:

```typescript
describe("CLI Argument Formats", () => {
  test("runs with positional arguments", async () => {
    const result = await startServer({
      args: [
        TEST_STRAND_PATH,  // Positional strand
        TEST_DATA_DIR,     // Positional data
        '--start-new',
      ],
    });

    expect(result.success).toBe(true);
  });

  test("runs with space-separated flags", async () => {
    const result = await startServer({
      args: [
        '--config', TEST_STRAND_PATH,
        '--data', TEST_DATA_DIR,
        '--start-new',
      ],
    });

    expect(result.success).toBe(true);
  });

  test("runs with equals format (backward compat)", async () => {
    const result = await startServer({
      args: [
        `--config=${TEST_STRAND_PATH}`,
        `--data=${TEST_DATA_DIR}`,
        '--start-new',
      ],
    });

    expect(result.success).toBe(true);
  });

  test("headless mode produces no TUI", async () => {
    const result = await startServer({
      args: [
        TEST_STRAND_PATH,
        TEST_DATA_DIR,
        '--headless',
        '--start-new',
      ],
    });

    // TUI control characters should not appear in headless mode
    expect(result.stdout).not.toContain('\x1b[');
  });
});
```

**Rationale:** E2E tests verify the entire system works with the new argument formats. Testing all three formats (positional, space-separated, equals) ensures no regressions.

### No Need for Relative Path Tests

The plan notes that relative paths likely already work based on code analysis (originalCwd is saved before process.chdir). Rather than adding tests speculatively, wait to see if users report issues. If the code is already correct, adding tests just for coverage wastes effort.

**Exception:** If implementing the feature reveals that relative paths don't work, then add targeted tests for the specific edge case that fails.

## Summary of All Changes

| Area | Current | After Changes |
|------|---------|---------------|
| Config argument | `--config=path` only | `--config path` or `--config=path` or positional |
| Data argument | `--data=path` only | `--data path` or `--data=path` or positional |
| TUI mode | Opt-in with `--basic` | Default, disable with `--headless` |
| Proxy | On by default | Off by default, enable with `--proxy` |
| Relative paths | May have edge cases | Test and document (likely already works) |

## Risk Mitigation

### Risk 1: Breaking Existing Scripts
**Mitigation:** Full backward compatibility. All existing flags continue to work exactly as before.

### Risk 2: Introducing Bugs in Path Handling
**Mitigation:** Comprehensive tests before any changes. The existing code appears correct.

### Risk 3: User Confusion with Two Syntaxes
**Mitigation:** Documentation clearly shows "preferred" style while noting alternatives work. Help text shows modern style.

### Risk 4: Edge Cases with Spaces or Special Characters
**Mitigation:** Shell handles quoting naturally. Test paths with spaces: `strandweave "my strand.json" "my data"`

## Dependencies

**No new dependencies.** The enhanced parsing approach uses only built-in JavaScript string methods and array operations.

## Open Questions for User

Before implementation, please confirm the following decisions:

### 1. Backward Compatibility Forever?
**Current recommendation:** Support both old (`--config=value`) and new (`--config value`) syntax permanently with no deprecation period.

**Question:** Is there any reason to eventually deprecate the equals syntax, or is permanent support the right approach?

### 2. TUI Default Behavior in CI/CD
**Current recommendation:** TUI on by default, `--headless` to disable.

**Question:** Are there CI/CD scenarios where this would cause problems? The TUI is non-blocking, but this is still a default behavior change. Scripts that pipe output might behave differently.

### 3. Relative Path Investigation (ENG-21)
**Current recommendation:** Write comprehensive tests for relative paths before implementing any changes. The Step 2 Agent believes this already works based on the code analysis showing `originalCwd` is saved before `process.chdir()`.

**Question:** Can we close ENG-21 as "already works" if tests pass, or is there a specific reproduction case that should be tested?

---

## Backward Compatibility

This implementation maintains full backward compatibility:
- All existing flag formats continue to work
- `--basic` flag continues to work (now redundant since TUI is default)
- `--without-proxy` flag continues to work
- Existing scripts require no modifications

---

## Testing Requirements and Affected Tests

This section documents all existing tests that need to be updated when implementing this change, as well as comprehensive testing requirements.

### Tests That Must Be Updated (Required Changes)

These tests interact with CLI argument parsing and will need updates:

#### Unit Tests

1. **Create: tests/unit/cli-parsing.test.ts** (NEW FILE)
   - Test the new `getArgValue()` helper function
   - Test `extractPositionals()` function
   - Test precedence rules (flags > positionals > defaults)
   - Test error handling for too many positional args
   - **Status:** Must be created from scratch
   - **Coverage:** ~100 test cases for all CLI parsing edge cases
   - **Lines of code:** ~500 lines

2. **Update: tests/unit/config.test.ts**
   - Tests that parse CLI arguments may need updates
   - Verify config loading works with new argument formats
   - **Action:** Check if any tests directly invoke argument parsing

#### Integration Tests

3. **Create: tests/integration/cli-defaults.test.ts** (NEW FILE)
   - Test that TUI is enabled by default
   - Test that `--headless` disables TUI
   - Test that proxy is disabled by default
   - Test that `--proxy` enables proxy
   - Test backward compatibility with `--basic` and `--without-proxy`
   - **Status:** Must be created
   - **Coverage:** Default behavior verification

4. **Create: tests/integration/cli-backward-compat.test.ts** (NEW FILE)
   - Test old equals format continues to work (`--config=value`)
   - Test mixed old and new formats work together
   - Test all old flags still function
   - **Status:** Must be created
   - **Coverage:** Critical for ensuring no breaking changes
   - **Lines of code:** ~200 lines

5. **Update: tests/integration/config-resolution.test.ts**
   - Tests that verify config path resolution
   - May need to test both CLI argument formats
   - **Action:** Add tests for new positional argument format

#### E2E Tests

6. **Update: tests/e2e/happy-path-e2e.test.ts**
   - Add new test group for CLI argument formats
   - Test positional arguments: `strandweave strand.json data/`
   - Test space-separated flags: `--config strand.json`
   - Test equals format (backward compat): `--config=strand.json`
   - Test headless mode produces no TUI control characters
   - **Test groups to add:**
     - `runCliArgumentFormatTests()` (new group)
   - **Action:** Add after existing test groups

7. **Update: tests/e2e/init-command-e2e.test.ts**
   - Init command may be affected by CLI changes
   - Verify init works with both argument styles
   - **Action:** Test with positional and flag-based arguments

8. **tests/e2e/strandweave-server.test.ts**
   - Check if this file tests server startup with various CLI args
   - **Action:** Verify tests pass with new parsing logic

### New Tests To Add (Test the New Feature)

Based on the Testing Strategy section, these specific tests must be created:

#### 1. CLI Parsing Unit Tests (tests/unit/cli-parsing.test.ts)

```typescript
// Key test cases that must be included:
describe("getArgValue", () => {
  // Tests for equals format: --config=value
  // Tests for space format: --config value
  // Tests for equals in value: --data=foo=bar
  // Tests for missing values
  // Tests for flag-like values
});

describe("extractPositionals", () => {
  // Tests for extracting non-flag arguments
  // Tests for skipping flags and their values
  // Tests for mixed equals and space format
  // Tests for empty arguments
});

describe("precedence rules", () => {
  // Flags take precedence over positionals
  // Positionals take precedence over defaults
  // Uses default when neither flag nor positional
});

describe("error handling", () => {
  // Errors on too many positional arguments
  // Provides helpful error messages
});
```

**Estimated:** 20-25 test cases, ~500 lines of code

#### 2. CLI Defaults Tests (tests/integration/cli-defaults.test.ts)

```typescript
describe("CLI Default Behaviors", () => {
  test("TUI is enabled by default");
  test("--headless disables TUI");
  test("--basic flag still works (backward compatibility)");
  test("proxy is disabled by default");
  test("--proxy enables proxy");
  test("--without-proxy still works (backward compatibility)");
});
```

**Estimated:** 6-8 test cases, ~150 lines of code

#### 3. Backward Compatibility Tests (tests/integration/cli-backward-compat.test.ts)

```typescript
describe("Backward Compatibility", () => {
  test("old equals format continues to work");
  test("mixed old and new formats work together");
  test("all old flags continue to work");
  // Test each flag individually with both formats
});
```

**Estimated:** 10-15 test cases, ~200 lines of code

#### 4. E2E CLI Format Tests (add to tests/e2e/happy-path-e2e.test.ts)

```typescript
describe("CLI Argument Formats", () => {
  test("runs with positional arguments");
  test("runs with space-separated flags");
  test("runs with equals format (backward compat)");
  test("headless mode produces no TUI");
});
```

**Estimated:** 4-6 test cases, integrated into existing E2E file

### Regression Tests (Critical - Must Pass)

These existing test suites must continue to pass without modification:

1. **All E2E Tests** (tests/e2e/*.test.ts)
   - All E2E tests use CLI arguments to start the server
   - They currently use equals format: `--config=path`
   - After changes, these tests should continue to work unchanged
   - **Files affected:** All E2E test files
   - **Action:** Run full E2E suite and verify no regressions

2. **Integration Tests** (tests/integration/*.test.ts)
   - Some integration tests may invoke CLI argument parsing
   - **Action:** Run full integration suite

3. **Server State Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Test group: `runServerStateTests`
   - Ensures server initialization works with new CLI parsing

4. **Process Lifecycle Tests** (tests/e2e/happy-path-e2e.test.ts)
   - Test group: `runProcessLifecycleTests`
   - Ensures server starts/stops correctly with new arguments

### Relative Path Testing (ENG-21)

**IMPORTANT:** The plan recommends testing relative paths before implementing changes, as the code may already support this.

#### Tests to Write (tests/integration/relative-paths.test.ts) - NEW FILE

```typescript
describe("Relative Path Support", () => {
  test("relative paths from parent directory");
  test("relative paths with ../ navigation");
  test("relative paths with ./ prefix");
  test("relative paths work from various working directories");
});
```

**Action:** Write these tests FIRST, before implementing any changes. If tests pass, close ENG-21 as "already works" and update documentation only.

**Estimated:** 5-10 test cases, ~200 lines of code

### CI/CD Pipeline Considerations

The CI/CD pipeline (`.github/workflows/ci.yml`) considerations:

1. **Lint and Type Check** (Job: `lint-and-typecheck`)
   - New CLI parsing functions must pass linting
   - Type definitions for argument parsing must be correct
   - **Action:** Run `bun run tc` locally

2. **Unit & Integration Tests** (Job: `tests`)
   - New unit tests must be included in test suite
   - All integration tests must pass
   - **Action:** Verify `bun test tests/unit` and `bun test tests/integration` pass

3. **Init E2E Tests** (Jobs: `init-e2e-*`)
   - Init command must work with new CLI parsing
   - Test in multiple modes (normal, npx, binary)
   - **Action:** Run all init E2E tests: `bun run test:e2e:init`, `test:e2e:init:npx`, `test:e2e:init:binary`

4. **Help Text Display**
   - Verify `--help` displays correctly with updated format
   - **Test manually:** `strandweave --help` should show new syntax

### Test Execution Checklist

Execute tests in this order to catch issues early:

```bash
# 1. Type check (verify type definitions)
bun run tc

# 2. Linting (verify code style)
bun run lint:fix

# 3. Unit tests - NEW tests first
bun test tests/unit/cli-parsing.test.ts  # New file
bun test tests/unit  # All unit tests

# 4. Integration tests - NEW tests
bun test tests/integration/cli-defaults.test.ts  # New file
bun test tests/integration/cli-backward-compat.test.ts  # New file
bun test tests/integration/relative-paths.test.ts  # New file (ENG-21)
bun test tests/integration  # All integration tests

# 5. E2E tests (expensive)
bun test tests/e2e/happy-path-e2e.test.ts  # With new CLI test group
bun test tests/e2e/init-command-e2e.test.ts  # Init command
bun test tests/e2e  # All E2E tests

# 6. Init E2E tests (special)
bun run test:e2e:init  # Normal mode
bun run test:e2e:init:npx  # NPX mode
bun run test:e2e:init:binary  # Binary mode

# 7. Manual verification
strandweave --help  # Verify help text displays correctly
strandweave strand.json data/  # Test positional arguments
strandweave --config strand.json --data data/  # Test space-separated
strandweave --config=strand.json --data=data/  # Test equals format (old)
```

### Manual Testing Scenarios

Test these scenarios manually to verify user experience:

1. **Positional Arguments**
   ```bash
   cd /path/to/project
   strandweave strand.json ./data
   # Should work, using project files
   ```

2. **Space-Separated Flags**
   ```bash
   strandweave --config strand.json --data ./data
   # Should work identically to positional
   ```

3. **Backward Compatibility**
   ```bash
   strandweave --config=strand.json --data=./data
   # Old syntax should still work
   ```

4. **Mixed Styles**
   ```bash
   strandweave strand.json --data ./data --model opus
   # Mix of positional and flags should work
   ```

5. **TUI Default**
   ```bash
   strandweave strand.json ./data
   # Should show TUI by default (verify visually)

   strandweave strand.json ./data --headless
   # Should NOT show TUI
   ```

6. **Help Text**
   ```bash
   strandweave --help
   # Verify examples show new preferred syntax
   ```

### Search Commands for Implementation

Use these commands during implementation:

```bash
# Find all places that parse CLI arguments
grep -r "args.find" server/index.ts
grep -r "split\(\"=\"\)" server/index.ts

# Find validation patterns
grep -r "validPatterns" server/index.ts

# Find help text
grep -r "console.log.*Usage:" server/index.ts

# Verify new helper functions exist
grep -r "function getArgValue" server/index.ts
grep -r "function extractPositionals" server/index.ts
```

### Summary of Test Impact

| Test Type | New Files | Updated Files | Test Cases | Lines of Code |
|-----------|-----------|---------------|------------|---------------|
| Unit Tests | 1 new file | 1 file | ~25 cases | ~500 lines |
| Integration Tests | 3 new files | 1 file | ~25 cases | ~550 lines |
| E2E Tests | 0 new files | 2 files | ~6 cases | ~150 lines |
| Manual Tests | N/A | N/A | 6 scenarios | N/A |
| **Total** | **4 new files** | **4 files** | **~56 cases** | **~1200 lines** |

**Estimated Time for New Tests:** 4-6 hours
**Estimated Time for Test Updates:** 1-2 hours
**Estimated Time for Manual Testing:** 1 hour
**Total Testing Effort:** 6-9 hours

### Critical Success Criteria

Before considering this implementation complete, verify:

1. ✅ All existing E2E tests pass without modification
2. ✅ Backward compatibility tests confirm old syntax works
3. ✅ New CLI parsing tests cover edge cases (equals in values, flag-like values)
4. ✅ TUI appears by default when running server
5. ✅ `--headless` suppresses TUI output
6. ✅ Relative paths work correctly (or ENG-21 is closed as "already works")
7. ✅ Help text shows new syntax as preferred style
8. ✅ All three init E2E test modes pass (normal, npx, binary)
9. ✅ `bun run tc` passes without errors
10. ✅ `bun run lint` passes without errors

This is a foundational change that affects how users interact with Strandweave. Comprehensive testing is critical to ensure no breaking changes.
