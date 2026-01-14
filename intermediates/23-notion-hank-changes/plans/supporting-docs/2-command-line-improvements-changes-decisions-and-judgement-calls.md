# ENG-106: Command Line Improvements - Changes, Decisions, and Judgement Calls

## Step 2 Agent Analysis

This is actually 5 interrelated tasks masquerading as one. After examining the codebase, I have some surprising findings and strong recommendations about implementation order and breaking changes.

### Surprising Finding 1: ENG-21 (Relative Paths) Might Already Work

**Current code analysis** (server/index.ts lines 208-253):
```typescript
const originalCwd = process.cwd(); // Line 208 - saves CWD BEFORE any changes
const resolvedDataPath = path.resolve(dataSourcePath || originalCwd);  // Line 209
// ... execution setup happens ...
process.chdir(executionSetup.executionPath);  // Line 230 - changes CWD
// ... later, for config resolution ...
const absoluteConfigPath = path.isAbsolute(configPath)
  ? configPath
  : path.resolve(originalCwd, configPath);  // Line 253 - uses SAVED original CWD
```

**Analysis**: The code correctly saves CWD before changing directories, then uses the saved value for path resolution. This SHOULD handle relative paths correctly.

**Step 2 Agent judgement**: Either:
1. This is already fixed and users haven't retested, OR
2. There's a specific edge case that breaks (symlinks? certain shells?)

**Recommendation**: Add comprehensive tests for relative paths before implementing changes. The issue might be documentation ("relative paths work, but many users assume they don't") rather than a bug.

### Surprising Finding 2: The Proxy Situation

**Code archaeology** (server/llm-proxy.ts + hankweave-runtime.ts):
The proxy exists but the codebase shows signs of it being incomplete or experimental:
- It's a "passthrough" proxy (line 383 of hankweave-runtime.ts)
- Hrishi's comment: "not using it for anything at the moment - and it causes some brittleness"

**Implication**: Flipping the default is safe. The proxy was likely intended for future use (monitoring, request modification, caching) but isn't actually needed yet.

### Breaking Changes Assessment

**Summary of proposed changes**:

| Change | Breaking? | Backward Compatible? | Complexity |
|--------|-----------|----------------------|------------|
| Positional arguments | Yes | Can be made compatible | Medium |
| Space-separated flags | No | Both formats can coexist | Low |
| --basic default | Behavior change | Can add --headless flag | Low |
| Proxy off by default | Behavior change | Rare usage, low impact | Low |
| Relative paths | Bug fix | N/A (improves behavior) | Low-None |

**Overall assessment**: This can be done with ZERO breaking changes if implemented carefully.

## Decision 1: Argument Parsing Strategy

**Recommendation**: Enhanced current approach with FULL backward compatibility.

**CLI design research validation:**
According to [Command Line Interface Guidelines](https://clig.dev/), the most important principle is "predictability and familiarity" - users should know what to expect based on their experience with other tools. The [Unix convention](https://betterdev.blog/command-line-arguments-anatomy-explained/) distinguishes between "arguments" (positional parameters) and "flags" (named parameters with - or --), and modern tools support space-separated values as the standard. Supporting both formats honors both legacy scripts and modern conventions.

**Why NOT use a library** (commander, yargs, minimist):
1. **Current approach works**: The regex validation + string manipulation is straightforward
2. **Zero dependencies**: Adding a parsing library adds attack surface and bundle size
3. **Full control**: Can implement exactly the behavior we want
4. **Simple codebase**: Current parsing is ~80 lines. Libraries would require learning their API.

**Implementation approach**:
```typescript
function getArgValue(args: string[], flagName: string): string | undefined {
  // Support both formats:
  // --config=value (old)
  // --config value (new)

  // Try equals format first (explicit)
  const equalsArg = args.find(arg => arg.startsWith(`${flagName}=`));
  if (equalsArg) {
    return equalsArg.split('=', 2)[1];  // split with limit to handle = in value
  }

  // Try space format
  const flagIndex = args.indexOf(flagName);
  if (flagIndex !== -1 && flagIndex + 1 < args.length) {
    const nextArg = args[flagIndex + 1];
    // Only consume next arg if it's not another flag
    if (!nextArg.startsWith('-')) {
      return nextArg;
    }
  }

  return undefined;
}
```

**This approach**:
- Works with old scripts unchanged
- Enables shell completion for new style
- Allows gradual migration
- No deprecation warnings needed (both are valid)

## Decision 2: Positional Arguments Strategy

**Recommendation**: Add positional support WHILE keeping flag support.

**Parsing logic**:
```typescript
// Extract positionals (non-flag arguments that aren't flag values)
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
    if (flagsThatTakeValues.some(f => arg === f || arg.startsWith(f + '='))) {
      if (!arg.includes('=') && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        i++;  // Skip the value
      }
    }
    continue;
  }

  positionals.push(arg);
}

// Interpret positionals
let configPath: string;
let dataSourcePath: string | undefined;

// Check flags first (higher priority)
const configFlag = getArgValue(args, '--config');
const dataFlag = getArgValue(args, '--data');

if (configFlag) {
  configPath = configFlag;
} else if (positionals.length > 0) {
  configPath = positionals[0];
} else {
  configPath = 'hank.json';  // Default
}

if (dataFlag) {
  dataSourcePath = dataFlag;
} else if (positionals.length > 1) {
  dataSourcePath = positionals[1];
} else {
  dataSourcePath = undefined;  // Will default to cwd later
}

// Error on too many positionals
if (positionals.length > 2) {
  throw new Error(`Too many arguments. Expected: [hank] [data], got: ${positionals.join(' ')}`);
}
```

**Precedence rules** (from highest to lowest):
1. `--config` or `--data` flags (explicit)
2. Positional arguments
3. Defaults

**Examples**:
```bash
# All of these work:
hankweave                                    # Uses defaults
hankweave hank.json                        # Positional hank
hankweave hank.json /data                  # Both positional
hankweave --config hank.json               # Flag style
hankweave --config hank.json /data         # Mixed
hankweave hank.json --data /data           # Mixed (opposite order)
hankweave --config=hank.json --data=/data  # Old style (still works!)
```

**This maximizes compatibility**: Old scripts work, new shortcuts work, mixed styles work.

## Decision 3: Default Behavior Changes

### 3a: Make --basic Default (ENG-101)

**Current behavior**: Server starts in non-TUI mode unless `--basic` or `-b` provided.

**Proposed behavior**: Server starts in TUI mode by default, `--headless` to disable.

**Implementation**:
```typescript
// OLD:
const basicMode = args.includes('--basic') || args.includes('-b');

// NEW:
const headlessMode = args.includes('--headless');
const basicMode = !headlessMode;  // TUI is default
```

**Also need to update**:
- Help text to indicate TUI is default
- README examples (most won't need `--basic` anymore)

**Non-breaking**: Scripts can add `--headless` if they were relying on non-TUI behavior, but the TUI doesn't interfere with headless operation anyway (it's a separate interface layer).

### 3b: Turn Off Proxy by Default (ENG-96)

**Current behavior**: Proxy enabled by default, `--without-proxy` to disable.

**Proposed behavior**: Proxy disabled by default, `--proxy` to enable.

**Implementation**:
```typescript
// In parseCliArgs():
if (args.includes('--proxy')) {
  cliArgs.withoutProxy = false;  // Enable proxy
}
// Remove the old --without-proxy check (or keep for backward compat)

// In DEFAULT_CONFIG (config.ts line 672):
withoutProxy: true,  // Changed from false
```

**Alternative (backward compatible)**: Support both flags
```typescript
if (args.includes('--proxy')) {
  cliArgs.withoutProxy = false;
} else if (args.includes('--without-proxy')) {
  cliArgs.withoutProxy = true;
}
// Default in config.ts is withoutProxy: true
```

**Step 2 Agent recommendation**: Keep `--without-proxy` working for compatibility. It's harmless and prevents breaking scripts.

## Decision 4: Validation Patterns Update

**Current**: Regex patterns enforce exact formats (lines 72-93)

**New patterns needed**:
```typescript
const validPatterns = [
  // Existing flags (unchanged)
  /^--basic$/,
  /^-b$/,
  /^--headless$/,        // NEW
  /^--validate$/,
  /^-v$/,
  /^--cleanup$/,
  /^-y$/,
  /^--no-autostart$/,
  /^--start-new$/,
  /^--copy$/,
  /^--proxy$/,           // NEW
  /^--without-proxy$/,   // Keep for compat
  /^--init$/,
  /^--help$/,
  /^-h$/,

  // Value flags - accept both formats
  /^--config(=.+)?$/,    // Matches --config and --config=value
  /^--data(=.+)?$/,
  /^--execution(=.+)?$/,
  /^--port(=\d+)?$/,
  /^--model(=(sonnet|opus))?$/,
  /^--anthropic-base-url(=.+)?$/,
  /^--idle-timeout(=\d+)?$/,

  // Positional arguments (not flags)
  /^[^-]/,               // Any argument not starting with -
];
```

**Note**: This approach still validates, but accepts both `--flag=value` and `--flag` (value comes next).

## Decision 5: Help Text and Documentation Updates

**Help text changes** (server/index.ts lines 115-180):

```typescript
console.log(`
Hankweave Runtime - Codon Orchestration

Usage: hankweave [options] [hank] [data]

Arguments:
  hank                    Path to hank configuration (default: hank.json)
  data                      Path to data directory (default: current directory)

Options:
  --init                    Initialize a new hank in current directory
  --config <path>           Path to hank configuration (default: hank.json)
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
  hankweave

  # Specify hank and data as positional arguments
  hankweave ./my-hank.json ./my-project

  # Using flags (also works)
  hankweave --config ./my-hank.json --data ./my-project

  # Run headless for CI/CD
  hankweave --headless ./hank.json ./data

  # Override model
  hankweave --model opus

  # Start fresh execution
  hankweave --start-new
`);
```

**Key changes**:
- Added "Arguments:" section at top
- Changed flag syntax from `--flag=<value>` to `--flag <value>`
- Added `--headless` (TUI is now default)
- Changed `--without-proxy` to `--proxy` (proxy off by default)
- Updated examples to show positional arguments
- Noted "(TUI is default)" and "(disabled by default)" for clarity

## Decision 6: README Updates

**Current README** (lines 223-229):
```bash
# Traditional local usage
hankweave --config=./hank.json --data=/path/to/project

# New remote usage (future)
hankweave --config=https://github.com/user/repo --data=/path/to/project
```

**Updated README**:
```bash
# Simple usage
hankweave hank.json /path/to/project

# Or with named flags
hankweave --config hank.json --data /path/to/project

# Or the old way (still works)
hankweave --config=hank.json --data=/path/to/project
```

**Note**: Need to update all README examples. There are many instances of `--flag=value` syntax.

## Decision 7: Testing Strategy

**Critical tests for this change**:

### 7a: Argument Parsing Tests (new file: `tests/unit/cli-parsing.test.ts`)

```typescript
test('parseCliArgs - supports both equals and space formats', () => {
  const args1 = ['--config=hank.json', '--port=8080'];
  const args2 = ['--config', 'hank.json', '--port', '8080'];
  const args3 = ['--config=hank.json', '--port', '8080'];  // Mixed

  const result1 = parseCliArgs(args1);
  const result2 = parseCliArgs(args2);
  const result3 = parseCliArgs(args3);

  expect(result1).toEqual({ config: 'hank.json', port: 8080 });
  expect(result2).toEqual({ config: 'hank.json', port: 8080 });
  expect(result3).toEqual({ config: 'hank.json', port: 8080 });
});

test('positional arguments - basic cases', () => {
  expect(extractPositionals([])).toEqual({
    config: 'hank.json',
    data: undefined
  });

  expect(extractPositionals(['my-hank.json'])).toEqual({
    config: 'my-hank.json',
    data: undefined
  });

  expect(extractPositionals(['my-hank.json', '/my/data'])).toEqual({
    config: 'my-hank.json',
    data: '/my/data'
  });
});

test('positional arguments - precedence', () => {
  // Flags take precedence
  const args = ['hank1.json', '--config', 'hank2.json'];
  expect(extractConfig(args)).toBe('hank2.json');
});

test('positional arguments - too many', () => {
  expect(() => extractPositionals(['a', 'b', 'c'])).toThrow('Too many');
});
```

### 7b: Relative Path Tests (new file: `tests/integration/relative-paths.test.ts`)

```typescript
test('relative paths from parent directory', async () => {
  // Setup test structure:
  // /tmp/test-root/
  //   hank.json
  //   data/

  const testRoot = '/tmp/test-root';
  const parentDir = '/tmp';

  process.chdir(parentDir);
  const result = await runHankweave([
    'test-root/hank.json',
    'test-root/data'
  ]);

  expect(result.config).toBe(path.join(testRoot, 'hank.json'));
  expect(result.data).toBe(path.join(testRoot, 'data'));
});

test('relative paths with ../ navigation', async () => {
  // /tmp/test-root/
  //   workspace/
  //   hank.json
  //   data/

  process.chdir('/tmp/test-root/workspace');
  const result = await runHankweave([
    '../hank.json',
    '../data'
  ]);

  expect(result.config).toBe('/tmp/test-root/hank.json');
});

test('relative paths with ./ prefix', async () => {
  process.chdir('/tmp/test-root');
  const result = await runHankweave([
    './hank.json',
    './data'
  ]);

  expect(result.config).toBe('/tmp/test-root/hank.json');
});
```

### 7c: Default Behavior Tests (update existing tests)

```typescript
test('TUI is default', () => {
  const basicMode = determineMode([]);  // No flags
  expect(basicMode).toBe(true);
});

test('--headless disables TUI', () => {
  const basicMode = determineMode(['--headless']);
  expect(basicMode).toBe(false);
});

test('proxy is disabled by default', () => {
  const config = parseCliArgs([]);
  expect(config.withoutProxy).toBe(true);  // Proxy disabled
});

test('--proxy enables proxy', () => {
  const config = parseCliArgs(['--proxy']);
  expect(config.withoutProxy).toBe(false);  // Proxy enabled
});
```

### 7d: Backward Compatibility Tests

```typescript
test('old syntax still works', async () => {
  // All these should work identically:
  const results = await Promise.all([
    runHankweave(['--config=hank.json', '--data=/data']),
    runHankweave(['--config', 'hank.json', '--data', '/data']),
    runHankweave(['hank.json', '/data']),
  ]);

  expect(results[0]).toEqual(results[1]);
  expect(results[1]).toEqual(results[2]);
});

test('--without-proxy still works', () => {
  const config = parseCliArgs(['--without-proxy']);
  expect(config.withoutProxy).toBe(true);
});

test('--basic flag still works', () => {
  const mode = determineMode(['--basic']);
  expect(mode).toBe(true);
});
```

## Step 2 Agent Implementation Recommendations

### Phase 1: Low-Risk Changes (Do First)
1. **Support space-separated flags** alongside equals format
   - Zero breaking changes
   - Enables shell completion
   - Simple to implement (~50 lines in `getArgValue()`)

2. **Flip proxy default**
   - Minimal impact (proxy rarely used)
   - Add `--proxy` flag
   - Keep `--without-proxy` for compat

### Phase 2: Behavior Changes (Do Second)
3. **Make TUI default**
   - Add `--headless` flag
   - Update help text and examples
   - Minimal breaking (TUI doesn't interfere with automation)

### Phase 3: Ergonomic Improvements (Do Last)
4. **Add positional arguments**
   - Most complex change
   - Benefits are primarily ergonomic
   - Full backward compatibility maintained

5. **Relative path testing and documentation**
   - May not require code changes
   - Needs comprehensive tests
   - Update docs if paths already work

### Phase 4: Documentation
6. **Update all documentation**
   - README examples
   - Help text
   - Migration guide (if needed)
   - FAQ for CLI changes

**Rationale for this order**:
- Phase 1 is completely safe, high value
- Phase 2 has minor behavior changes, low risk
- Phase 3 is complex but with full compat
- Phase 4 brings it all together

## Step 2 Agent Judgement Calls

### Judgement Call 1: No CLI Library

**Decision**: Stick with enhanced hand-rolled parsing.

**Reasoning**:
- Current code is simple and works
- Libraries add complexity for minimal benefit
- Full control over backward compatibility
- Zero new dependencies

**Trade-off accepted**: Slightly more code to maintain vs. battle-tested library. Given the simplicity of our needs and the importance of backward compatibility, custom code wins.

### Judgement Call 2: Full Backward Compatibility

**Decision**: Support old syntax forever (no deprecation).

**Reasoning**:
- Easy to support both with our parsing approach
- User scripts will continue to work
- No angry users
- No migration documentation needed

**Trade-off accepted**: Documentation needs to show "preferred" vs "also works" styles. This is better than forcing users to update working scripts.

### Judgement Call 3: Flags > Positionals > Defaults

**Decision**: Flags take precedence over positional arguments.

**Reasoning**:
```bash
# This should use the flag value, not "hank1.json" positional:
hankweave hank1.json --config hank2.json

# Result: Uses hank2.json (flag wins)
```

This matches user expectations - explicit flags override implicit positionals. It also allows positional as defaults with flag overrides.

### Judgement Call 4: TUI Default Despite It Being A Behavior Change

**Decision**: Make TUI default, add `--headless` to disable.

**Reasoning**:
- TUI improves user experience significantly
- Scripts/automation won't break (TUI is non-blocking)
- The benefits outweigh the minor disruption
- Users want this (it's explicitly requested in ENG-101)

**Risk mitigation**: Clearly document in changelog, add `--headless` for explicit non-TUI mode.

### Judgement Call 5: Investigate ENG-21 Before Implementing

**Decision**: Write comprehensive path tests BEFORE making changes.

**Reasoning**:
- Current code looks correct for relative paths
- May be a documentation issue, not a code issue
- Changing working code risks introducing bugs
- Tests will reveal if there's actually a problem

**If tests pass**: Update documentation, close ENG-21 as "already works"
**If tests fail**: Fix the specific edge case that fails

### Judgement Call 6: Validation Pattern Complexity

**Decision**: Use simplified regex patterns that allow both formats.

**Alternative considered**: Parse first, then validate.
```typescript
// Option A: Complex regex (current approach)
/^--config(=.+)?$/  // Allows --config and --config=value

// Option B: Parse then validate
// Don't validate format in regex, just structure
// Then validate values after parsing
```

**Chosen**: Option A (enhanced regex)
- Fails fast (catches typos immediately)
- Clear error messages
- Consistent with current style

## Complexity Assessment

**Overall complexity**: Low to Medium

**Breakdown by change**:
1. Space-separated flags: **Low** (~50 lines, 1 day)
2. Positional arguments: **Medium** (~150 lines, 2 days)
3. Proxy default: **Low** (~20 lines, 1 hour)
4. TUI default: **Low** (~20 lines, 1 hour)
5. Path testing: **Low** (tests only, 1 day)
6. Documentation: **Low** (~2 hours)

**Total estimate**: 5-6 days of work for all changes + testing

**Risk level**: Low if phased correctly

## Open Questions for Step 3

1. **Should we add `hankweave run` as an explicit command?**
   - Current: `hankweave hank.json data`
   - Alternative: `hankweave run hank.json data`
   - Pro: More extensible (room for `hankweave init`, `hankweave validate` as commands)
   - Con: Extra word, less ergonomic
   - **Step 2 Agent opinion**: Not necessary. The implicit "run" works well.

2. **Should validation be strict or lenient on unknown positionals?**
   - Current plan: Error on >2 positionals
   - Alternative: Warn and ignore extras
   - **Step 2 Agent opinion**: Error is better - helps catch typos

3. **What about paths with spaces?**
   - `hankweave "my hank.json" "my data"`
   - Shell handles quoting, should work correctly
   - **Needs testing** to confirm

4. **Should we support environment variables for arguments?**
   - `HANKWEAVE_CONFIG=hank.json hankweave`
   - Not currently supported for CLI args (only runtime config)
   - **Step 2 Agent opinion**: Not necessary for v1, could add later

5. **Autocompletion scripts?**
   - With space-separated args, shell completion becomes viable
   - Should we provide completion scripts for bash/zsh?
   - **Step 2 Agent opinion**: Nice-to-have, not blocker
