# ENG-106: Command Line Improvements - Related Code Analysis

## Overview

This task encompasses five related subtasks that modernize Hankweave's CLI to match common Unix/CLI conventions. The changes affect argument parsing, defaults, and path handling across multiple files.

## Key Files and Current Implementation

### 1. CLI Argument Parsing (`server/index.ts`)

**Lines 22-60: parseCliArgs() function**
```typescript
function parseCliArgs(args: string[]): Partial<HankweaveConfig> {
  const cliArgs: Partial<HankweaveConfig> = {};

  // Parse port
  const portArg = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
  if (portArg) {
    cliArgs.port = parseInt(portArg, 10);
  }

  // Parse model
  const modelArg = args.find((arg) => arg.startsWith("--model="))?.split("=")[1];
  if (modelArg) {
    cliArgs.model = modelArg as "sonnet" | "opus";
  }

  // Parse anthropicBaseUrl
  const baseUrlArg = args.find((arg) => arg.startsWith("--anthropic-base-url="))?.split("=")[1];
  if (baseUrlArg) {
    cliArgs.anthropicBaseUrl = baseUrlArg;
  }

  // Parse autostart (inverse of --no-autostart)
  if (args.includes("--no-autostart")) {
    cliArgs.autostart = false;
  }

  // Parse withoutProxy
  if (args.includes("--without-proxy")) {
    cliArgs.withoutProxy = true;
  }

  // Parse idleTimeout
  const idleTimeoutArg = args.find((arg) => arg.startsWith("--idle-timeout="))?.split("=")[1];
  if (idleTimeoutArg) {
    cliArgs.idleTimeout = parseInt(idleTimeoutArg, 10);
  }

  return cliArgs;
}
```

**Current pattern**: All value-bearing arguments use `--param=value` format with `split("=")` parsing.

**Issues addressed by changes**:
- ENG-22: Equals signs prevent shell autocompletion
- Need to support `--param value` format instead

---

**Lines 70-99: Strict Argument Validation**
```typescript
const validPatterns = [
  /^--basic$/,
  /^-b$/,
  /^--validate$/,
  /^-v$/,
  /^--cleanup$/,
  /^-y$/,
  /^--no-autostart$/,
  /^--start-new$/,
  /^--config=.+$/,    // Currently requires = sign
  /^--data=.+$/,      // Currently requires = sign
  /^--execution=.+$/,
  /^--copy$/,
  /^--anthropic-base-url=.+$/,
  /^--port=\d+$/,
  /^--model=(sonnet|opus)$/,
  /^--without-proxy$/,
  /^--idle-timeout=\d+$/,
  /^--init$/,
  /^--help$/,
  /^-h$/,
];
```

**Current pattern**: Regex validation enforces exact argument formats.

**Issues addressed by changes**:
- ENG-22: Need to update patterns to accept both `--param=value` and `--param value`
- Main task: Need to add positional argument validation

---

**Lines 101-111: Argument Extraction**
```typescript
const args = process.argv.slice(2);
const configPath =
  args.find((arg) => arg.startsWith("--config="))?.split("=")[1] || "hank.json";
const dataSourcePath = args.find((arg) => arg.startsWith("--data="))?.split("=")[1];
const executionPath = args.find((arg) => arg.startsWith("--execution="))?.split("=")[1];
const useSymlink = !args.includes("--copy");
const basicMode = args.includes("--basic") || args.includes("-b");
const validateMode = args.includes("--validate") || args.includes("-v");
const cleanupMode = args.includes("--cleanup");
const skipConfirmation = args.includes("-y");
const startNew = args.includes("--start-new");
const initMode = args.includes("--init");
```

**Current pattern**:
- Config and data are extracted as flags
- Boolean flags use direct inclusion checks
- Config defaults to "hank.json" if not provided

**Issues addressed by changes**:
- Main task: Need to extract config and data as positional arguments
- ENG-22: Need to support space-separated values

### 2. Path Resolution (`server/index.ts`)

**Lines 208-209: Data Source Resolution**
```typescript
const originalCwd = process.cwd(); // Save original CWD
const resolvedDataPath = path.resolve(dataSourcePath || originalCwd);
```

**Lines 216: Execution Path Resolution**
```typescript
executionPath: executionPath ? path.resolve(executionPath) : undefined,
```

**Lines 251-253: Config Path Resolution**
```typescript
const absoluteConfigPath = path.isAbsolute(configPath)
  ? configPath
  : path.resolve(originalCwd, configPath);
```

**Current pattern**: Paths are resolved using `path.resolve()` which:
- Converts relative paths to absolute based on `process.cwd()`
- Leaves absolute paths unchanged
- Uses saved `originalCwd` for config path (important - prevents issues when cwd changes later)

**Good news**: This SHOULD already handle relative paths correctly!

**Potential issue (ENG-21)**:
Looking at line 230: `process.chdir(executionSetup.executionPath);`
- The CWD is changed AFTER path resolution
- Config path correctly uses saved `originalCwd`
- This should work correctly for relative paths

**Need to verify**: Is there a scenario where this fails? User complaint suggests there might be edge cases.

### 3. Default Configuration (`server/config.ts`)

**Lines 640-680: DEFAULT_CONFIG**
```typescript
export const DEFAULT_CONFIG: Omit<
  HankweaveConfig,
  | "cwd"
  | "readOnlySourceDataPath"
  | "executionPath"
  | "dataPathInExecutionDir"
  | "dataHash"
  | "isNewExecution"
  | "isResuming"
  | "linkType"
  | "codons"
> = {
  port: 7777,
  version: PACKAGE_VERSION,
  outputDirectory: "hankweave-results",
  executionBaseDir: path.join(os.homedir(), ".hankweave-executions"),
  lockFile: ".hankweave/runtime.lock",
  socketLogFile: ".hankweave/logs/websocket.log",
  serverLogFile: ".hankweave/logs/server.log",
  logParsingInterval: 1000,
  autostart: true,              // ENG-101: Should this be default?
  dataHashTimeLimit: 5000,
  toolResultTruncateLength: 2500,
  withoutProxy: false,          // ENG-96: Proxy ENABLED by default
  handshakeHistoryLimit: 50,
  idleTimeout: 0,
  sentinel: {
    enablePersistence: true,
    healthCheckGracePeriodMs: 2000,
    waitForAllHealthChecks: false,
  },
};
```

**Current defaults**:
- `autostart: true` - Codons start automatically when server connects
- `withoutProxy: false` - Proxy is ENABLED by default

**Issues addressed by changes**:
- ENG-101: Should `--basic` be default? Currently it's opt-in
- ENG-96: Turn proxy OFF by default (`withoutProxy: true`)

**Note on --basic**: Looking at the code, `--basic` is NOT a config setting - it's a runtime mode flag that launches the TUI. The question is whether to make TUI mode the default user experience.

### 4. Basic TUI Mode (`server/index.ts`)

**Lines 376-382: TUI Initialization**
```typescript
if (basicMode) {
  // Give server a moment to start before connecting
  setTimeout(() => {
    new BasicTUI(server);
  }, 100);
  console.log("🎮 Running in basic TUI mode");
}
```

**Current pattern**: TUI only launches if `--basic` or `-b` flag is provided.

**Issues addressed by changes** (ENG-101):
- Make `--basic` default
- Add a flag like `--headless` or `--no-tui` to disable TUI

### 5. Proxy Configuration (`server/hankweave-runtime.ts`)

**Lines 378-391: Proxy Server Initialization**
```typescript
// Start proxy server first (if not disabled)
if (!this.config.withoutProxy) {
  const proxyPort = this.config.port + 1;
  this.logger.log(`Starting proxy server on port ${proxyPort}`);

  this.proxyRunner = new ProxyRunner(
    "passthrough",
    proxyPort,
    this.config.anthropicBaseUrl || "https://api.anthropic.com",
    this.logger,
  );
  this.proxyRunner.start();
} else {
  this.logger.log("Proxy server disabled");
}
```

**Current pattern**: Proxy starts by default unless `withoutProxy: true` (set by `--without-proxy` flag).

**Issues addressed by changes** (ENG-96):
- Flip default: proxy OFF by default
- Add `--proxy` flag to enable it when needed

## Argument Parsing Libraries

**Current approach**: Hand-rolled parsing with regex validation and `split("=")`.

**Why this matters**: Moving to space-separated arguments requires more sophisticated parsing.

**Options**:

### Option 1: Upgrade current approach
Enhance current parsing to support both formats:
```typescript
function getArgValue(args: string[], name: string): string | undefined {
  // Try --param=value format
  const equalsArg = args.find(arg => arg.startsWith(`${name}=`));
  if (equalsArg) {
    return equalsArg.split('=')[1];
  }

  // Try --param value format
  const flagIndex = args.indexOf(name);
  if (flagIndex !== -1 && flagIndex + 1 < args.length) {
    const nextArg = args[flagIndex + 1];
    // Don't consume if next arg is another flag
    if (!nextArg.startsWith('-')) {
      return nextArg;
    }
  }

  return undefined;
}
```

**Pros**: Minimal dependencies, gradual migration path
**Cons**: Custom code to maintain, error-prone edge cases

### Option 2: Use minimist
```typescript
import minimist from 'minimist';

const args = minimist(process.argv.slice(2), {
  string: ['config', 'data', 'execution', 'model', 'anthropic-base-url'],
  boolean: ['basic', 'validate', 'cleanup', 'copy', 'start-new', 'init', 'help', 'no-autostart', 'without-proxy'],
  number: ['port', 'idle-timeout'],
  alias: {
    b: 'basic',
    v: 'validate',
    h: 'help',
    y: 'yes'
  },
  default: {
    config: 'hank.json',
    data: process.cwd()
  }
});
```

**Pros**: Battle-tested, handles edge cases, supports aliases
**Cons**: Another dependency, different API

### Option 3: Use commander.js
```typescript
import { Command } from 'commander';

const program = new Command();
program
  .name('hankweave')
  .argument('[hank]', 'path to hank configuration', 'hank.json')
  .argument('[data]', 'path to data directory', process.cwd())
  .option('-b, --basic', 'run in basic TUI mode', true)  // NEW default
  .option('--no-basic', 'disable TUI mode')
  .option('--proxy', 'enable proxy server', false)       // NEW default
  .option('--config <path>', 'hank configuration path')
  .option('--data <path>', 'data directory path')
  // ... etc
  .parse(process.argv);

const options = program.opts();
const [hank, data] = program.args;
```

**Pros**: Most full-featured, generates help automatically, best CLI conventions
**Cons**: Largest dependency, most invasive change

### Option 4: Use yargs
```typescript
import yargs from 'yargs';

const argv = yargs(process.argv.slice(2))
  .command('$0 [hank] [data]', 'run a hank', (yargs) => {
    yargs
      .positional('hank', {
        describe: 'path to hank configuration',
        default: 'hank.json'
      })
      .positional('data', {
        describe: 'path to data directory',
        default: process.cwd()
      });
  })
  .option('basic', {
    alias: 'b',
    type: 'boolean',
    default: true,  // NEW default
    describe: 'run in basic TUI mode'
  })
  .option('proxy', {
    type: 'boolean',
    default: false,  // NEW default
    describe: 'enable proxy server'
  })
  // ... etc
  .parse();
```

**Pros**: Feature-rich, good TypeScript support, generates help
**Cons**: Large dependency, complex API

**Step 2 Agent Recommendation**: Use Option 1 (enhanced current approach) or Option 2 (minimist).
- Option 1 for minimal disruption and backward compatibility
- Option 2 if we want to outsource the parsing logic to a library
- Option 3 and 4 are overkill for our needs

## Positional Arguments Implementation

**Current**: `--config=hank.json --data=/path/to/data`
**Target**: `hankweave hank.json /path/to/data`

**Key insight from code review**:
Looking at lines 101-104, both config and data have defaults:
- config defaults to `"hank.json"`
- data defaults to `undefined`, which becomes `originalCwd` at line 209

**Proposed behavior**:
```typescript
// Parse positional arguments (non-flag arguments that aren't values for flags)
const positionals = args.filter(arg => !arg.startsWith('-') && !isValueForFlag(arg));

// Interpret positionals based on count:
// 0 positionals: config='hank.json', data=cwd
// 1 positional: config=positionals[0], data=cwd
// 2 positionals: config=positionals[0], data=positionals[1]
// 3+ positionals: error

let configPath: string;
let dataSourcePath: string | undefined;

if (positionals.length === 0) {
  configPath = getArgValue(args, '--config') || 'hank.json';
  dataSourcePath = getArgValue(args, '--data');
} else if (positionals.length === 1) {
  configPath = positionals[0];
  dataSourcePath = getArgValue(args, '--data');  // Allow flag override
} else if (positionals.length === 2) {
  configPath = positionals[0];
  dataSourcePath = positionals[1];
} else {
  throw new Error(`Too many positional arguments: ${positionals.join(', ')}`);
}
```

**Important**: Flags should take precedence over positionals for backward compatibility:
```bash
# This should use --config value, not "hank.json" positional
hankweave hank.json --config=other.json
```

## Relative Path Handling (ENG-21)

**Current implementation** (lines 208-209, 216, 251-253):
```typescript
const originalCwd = process.cwd(); // Save original CWD BEFORE chdir
const resolvedDataPath = path.resolve(dataSourcePath || originalCwd);
// ... later ...
process.chdir(executionSetup.executionPath);  // Change to execution directory
// ... even later ...
const absoluteConfigPath = path.isAbsolute(configPath)
  ? configPath
  : path.resolve(originalCwd, configPath);  // Uses SAVED originalCwd
```

**Analysis**: This should work correctly! The code saves `originalCwd` before changing directories, then uses it for resolving the config path.

**Why might users report issues?** (Speculation based on code review)

1. **Timing issue**: If somehow relative paths are used AFTER `process.chdir()` without using `originalCwd`
2. **Prompt file resolution**: Looking at `config.ts` lines 926-990, prompt files are resolved relative to the config file's directory, not CWD. This should also be correct.
3. **Rig setup copy operations**: Lines 972-986 resolve `from` paths relative to config directory. This is correct for rig setup.

**Testing needed**: Need to reproduce the original issue to understand what specific scenario fails.

**Possible scenarios to test**:
```bash
# From parent directory
cd /home/user/projects
hankweave child-project/hank.json child-project/data

# With relative paths
cd /home/user/projects/my-hank
hankweave ./hank.json ../data

# With symlinks
cd /home/user -> /mnt/storage/user
hankweave projects/hank.json projects/data
```

## Help Text Updates

**Lines 115-180: Help Text**
Current help text shows equals-sign format:
```
  --config=<path>           Path to hank configuration file (default: hank.json)
  --data=<path>             Path to data file or directory (default: current directory)
```

**Needs update** to show space-separated format:
```
  --config <path>           Path to hank configuration file (default: hank.json)
  --data <path>             Path to data file or directory (default: current directory)
```

**Also needs update** to document positional arguments:
```
Usage: hankweave [options] [hank] [data]

Arguments:
  hank                    Path to hank configuration file (default: hank.json)
  data                      Path to data directory or file (default: current directory)

Options:
  --basic, -b               Run in basic TUI mode (default)
  --headless                Run without TUI
  --proxy                   Enable proxy server
  ...
```

## Default Behavior Changes Summary

### Change 1: Make --basic default (ENG-101)

**Current**: No TUI unless `--basic` or `-b` provided
**Proposed**: TUI by default, `--headless` to disable

**Implementation location**: `server/index.ts` lines 376-382

**Rationale from ENG-101**: "Let's reduce the number of config params to start hankweave"

### Change 2: Turn off proxy by default (ENG-96)

**Current**: Proxy enabled by default, `--without-proxy` to disable
**Proposed**: Proxy disabled by default, `--proxy` to enable

**Implementation locations**:
- `server/config.ts` line 672: Change `withoutProxy: false` to `withoutProxy: true`
- `server/index.ts` line 49: Change logic to detect `--proxy` flag
- `hankweave-runtime.ts` line 378: Condition already works correctly

**Rationale from ENG-96**: "We're not using it for anything at the moment - and it causes some brittleness"

## Backward Compatibility Considerations

**Question**: Should old syntax continue to work?

**Options**:

1. **Hard break**: Only support new syntax
   - Pro: Clean, simple implementation
   - Con: Breaks existing scripts/workflows

2. **Deprecation period**: Support both, warn on old syntax
   - Pro: Smooth migration
   - Con: More complex code

3. **Permanent support**: Accept both forever
   - Pro: Maximum compatibility
   - Con: Code complexity, documentation confusion

**Recommendation**: Option 2 (deprecation period) or Option 3 (permanent support)
- If using enhanced parsing (Option 1), supporting both is trivial
- If using a library (minimist, etc.), they support both natively
- No strong reason to break existing usage

## Testing Requirements

**Test cases needed**:

1. **Positional arguments**:
   - `hankweave` (both default)
   - `hankweave hank.json` (explicit hank, default data)
   - `hankweave hank.json /path/to/data` (both explicit)
   - `hankweave hank.json --data=/other/path` (mixed positional + flag)

2. **Space-separated flags**:
   - `hankweave --config hank.json`
   - `hankweave --data /path/to/data`
   - `hankweave --port 8080`

3. **Backward compatibility** (if supported):
   - `hankweave --config=hank.json`
   - `hankweave --data=/path/to/data`

4. **Relative paths** (ENG-21):
   - From parent directory
   - With `./` prefix
   - With `../` navigation
   - With symlinks in path

5. **Default changes**:
   - TUI launches by default
   - `--headless` disables TUI
   - Proxy is disabled by default
   - `--proxy` enables proxy

6. **Edge cases**:
   - Paths with spaces: `hankweave "./my hank.json" "./my data"`
   - Paths with special characters
   - Multiple values: error handling
   - Conflicting flags: `--config hank1.json --config hank2.json`

## Migration Guide Needed

If implementing breaking changes, need migration guide:

```markdown
# CLI Changes in v0.X.Y

## What Changed

Hankweave's command-line interface has been modernized:

### 1. Positional Arguments (Recommended)
```bash
# Old
hankweave --config=hank.json --data=/path/to/data

# New (recommended)
hankweave hank.json /path/to/data

# Even simpler with defaults
hankweave  # Uses hank.json and current directory
```

### 2. Space-Separated Flags (Both work)
```bash
# Old (still works)
hankweave --port=8080 --model=opus

# New (preferred for shell completion)
hankweave --port 8080 --model opus
```

### 3. Default Changes
```bash
# Basic TUI is now default
hankweave          # Launches TUI automatically
hankweave --headless  # Disables TUI for scripts

# Proxy is now disabled by default
hankweave        # No proxy
hankweave --proxy  # Enables proxy
```

## Updating Your Scripts

Most scripts should work without changes, but consider updating:

```bash
# Before
#!/bin/bash
hankweave --config=./hank.json --data=./data --without-proxy

# After
#!/bin/bash
hankweave ./hank.json ./data
```
```

## Summary of Integration Points

All changes are concentrated in:
1. **server/index.ts**: CLI parsing (lines 22-111), defaults (lines 376-382)
2. **server/config.ts**: Default configuration (line 672 for proxy)
3. **Documentation**: README examples, help text

The path resolution code is already correct - ENG-21 may be a non-issue or require only documentation updates.
