# ENG-105: Repository Link Hanks - Related Code Analysis

## Key Files and Their Roles

### 1. Configuration Loading (`server/config.ts`)

**Lines 684-713: loadHankFile()**
```typescript
export function loadHankFile(hankPath: string): z.infer<typeof hankFileSchema> {
  try {
    const content = fs.readFileSync(hankPath, 'utf-8');
    const rawConfig = JSON.parse(content);

    // Validate with hankFileSchema
    const result = hankFileSchema.safeParse(rawConfig);
    if (!result.success) {
      const errors = formatZodErrors(result.error, rawConfig);
      throw new Error(`Invalid hank file:\n${errors}`);
    }

    return result.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Hank file not found: ${hankPath}`);
    }
    throw error;
  }
}
```

**Purpose**: This is the entry point for loading hank configurations. Currently only supports local filesystem paths.

**Modification needed**: Must detect if `hankPath` is a URL and handle differently.

---

**Lines 910-990: resolveCodonOrLoopPaths()**
```typescript
function resolveCodonOrLoopPaths(config: CodonConfig): CodonConfig {
  // If it's a loop, resolve paths in nested codons
  if (config.type === 'loop') {
    return {
      ...config,
      codons: config.codons.map(codon => resolveCodonOrLoopPaths(codon) as Codon)
    };
  }

  // It's a codon - resolve its paths
  const resolved = { ...config };

  // Handle promptFile - can be string or array
  if (resolved.promptFile) {
    if (Array.isArray(resolved.promptFile)) {
      resolved.promptFile = resolved.promptFile.map((file: string) =>
        path.isAbsolute(file) ? file : path.resolve(configDir, file)
      );
    } else if (!path.isAbsolute(resolved.promptFile)) {
      resolved.promptFile = path.resolve(configDir, resolved.promptFile);
    }
  }

  // Similar for appendSystemPromptFile and rigSetup...
}
```

**Purpose**: Resolves relative paths in codon configurations based on the config file's directory.

**Modification needed**: When hank is loaded from URL, `configDir` will be the cache directory where the hank was downloaded.

### 2. CLI Argument Parsing (`server/index.ts`)

**Lines 101-103: Config path extraction**
```typescript
const configPath = args.find(arg => arg.startsWith('--config='))?.split('=')[1] || 'hank.json';
```

**Purpose**: Extracts the config path from CLI arguments.

**Current limitation**: No URL detection or handling. Simply treats everything as a filesystem path.

**Modification needed**: Add URL detection logic here before passing to `loadHankFile`.

---

**Lines 201-260: Main execution flow**
```typescript
// Load hank configuration
const absoluteConfigPath = path.resolve(process.cwd(), configPath);
const codons = loadCodonSequence(absoluteConfigPath);

// Setup execution environment
const setup = await setupExecutionEnvironment({
  readOnlySourceDataPath: absoluteDataSourcePath,
  executionPath: executionPath ? absoluteExecutionPath : undefined,
  useSymlink,
  dataHashTimeLimit: mergedSettings.dataHashTimeLimit,
  startNew,
});
```

**Purpose**: Main workflow for loading config and setting up execution.

**Modification needed**: Must branch before `path.resolve()` if config is a URL. Download to cache, then use cached path.

### 3. Git Operations (`server/checkpoint-git.ts`)

**Lines 1-105: CheckpointGit class**
```typescript
export class CheckpointGit {
  private executionPath: string;
  private checkpointPath: string;
  private git: SimpleGit | null = null;

  constructor(executionPath: string, logger: Logger) {
    this.executionPath = executionPath;
    this.checkpointPath = path.join(executionPath, '.hankweave', 'checkpoints');
    this.logger = logger;
  }

  async initialize(): Promise<string | undefined> {
    // Initialize the shadow git repository
    const gitConfigPath = path.join(this.checkpointPath, '.gitconfig');
    // ...
    this.git = simpleGit(this.executionPath, {
      maxConcurrentProcesses: 1,
      config: [
        `core.worktree=${this.executionPath}`,
        `core.gitdir=${path.join(this.checkpointPath, '.git')}`,
      ],
    }).env({
      GIT_DIR: path.join(this.checkpointPath, '.git'),
      GIT_WORK_TREE: this.executionPath,
      // ...
    });

    await this.git.init(false, { '--initial-branch': 'main' });
    // ...
  }
}
```

**Purpose**: Manages the shadow Git repository for checkpointing codon execution states.

**Relevance**: This uses `simple-git` npm package, which we can also use for cloning remote repositories. The pattern is already established.

**Dependencies**:  The codebase already has `simple-git` as a dependency (imported in this file).

### 4. Path Resolution and File Operations

**server/execution-setup.ts** (Lines 23-235)
- Handles creation of execution directories
- Validates and resolves data source paths
- Creates symlinks or copies data into execution directory
- Stores metadata in `.hankweave/execution-meta.json`

**Key insight**: The execution directory is completely isolated. Downloaded hanks would fit naturally into this pattern - we download to a cache directory, then treat it like any other data source.

## Code Patterns to Follow

### Pattern 1: Validation with Detailed Errors
Throughout `config.ts`, validation uses Zod schemas with custom error formatting:
```typescript
const result = hankFileSchema.safeParse(rawConfig);
if (!result.success) {
  const errors = formatZodErrors(result.error, rawConfig);
  throw new Error(`Invalid hank file:\n${errors}`);
}
```

**Implication**: URL validation should follow this pattern with clear error messages for invalid URLs, network failures, etc.

### Pattern 2: Configuration Layer Merging
`resolveSettings()` (lines 852-908) merges config from multiple sources:
1. Default config
2. Runtime config file (hankweave.json)
3. Hank recommendations
4. Environment variables
5. CLI arguments (highest priority)

**Implication**: URL-based config source could be another layer, or it could replace the hank.json layer when a URL is provided.

### Pattern 3: Path Resolution Relative to Config
All relative paths in a hank (promptFile, rigSetup copy operations) are resolved relative to the hank.json location:
```typescript
const configDir = path.dirname(configPath);
const resolved = path.isAbsolute(file) ? file : path.resolve(configDir, file);
```

**Implication**: For URL-based hanks, `configDir` becomes the local cache directory where the repo was cloned.

## Dependencies and Existing Libraries

### Git Operations: `simple-git`
Already in use for checkpoint system. Can be reused for cloning remote repositories.

```typescript
import simpleGit from 'simple-git';

const git = simpleGit();
await git.clone(url, targetDir, options);
```

### HTTP Requests: Not currently in use
No HTTP client is currently imported or used. Would need to add one for:
- HEAD requests to check if URL is accessible
- Fetching raw files (for single-file hanks)
- Or could rely entirely on git clone which handles HTTP/HTTPS/SSH

**Options**:
1. Use only `git clone` for all remote operations (simplest, handles auth via Git)
2. Add `node-fetch` or `axios` for more flexibility with raw file URLs

## Security Considerations in Codebase

### Current Security Patterns

**1. Dangerous Command Detection** (`config.ts` lines 1448-1464)
```typescript
const dangerousPatterns = [
  /rm\s+-rf\s+\//,     // rm -rf /
  /rm\s+-rf\s+~/,      // rm -rf ~
  />\s*\/dev\/sda/,    // Writing to disk devices
  // ...
];

for (const pattern of dangerousPatterns) {
  if (pattern.test(command)) {
    result.warnings.push(
      `${codonLabel}: Potentially dangerous command detected: "${command}"`
    );
  }
}
```

**2. Path Traversal Prevention** (execution-setup.ts lines 94-101)
```typescript
// Prevent nested execution
if (executionPath.includes('/.hankweave-executions/') && executionPath.includes('/data')) {
  throw new Error('Cannot create execution inside another execution directory');
}

// Prevent using data source as execution
if (path.resolve(executionPath) === path.resolve(readOnlySourceDataPath)) {
  throw new Error('Execution directory cannot be the same as data source');
}
```

**Implication for remote hanks**: Should add similar validation for downloaded content:
- Check rigSetup commands for dangerous operations
- Warn user before executing downloaded hank (especially first time)
- Consider a "trust" system similar to npm/cargo

## Cache Location Patterns

The codebase uses `~/.hankweave-executions/` for execution directories (config.ts line 664):
```typescript
executionBaseDir: path.join(os.homedir(), '.hankweave-executions'),
```

**Natural cache location**: `~/.hankweave-cache/hanks/`
- Parallel structure to execution dirs
- Keeps cache separate from ephemeral execution directories
- Can be cleaned up independently

## URL Format Considerations

Looking at CLI parsing, the current pattern uses `=` separators and specific prefixes:
```typescript
const configPath = args.find(arg => arg.startsWith('--config='))?.split('=')[1];
```

**URL detection heuristics**:
1. Starts with `http://` or `https://` → HTTP URL
2. Starts with `git@` → SSH URL
3. Matches `user@host:path` → SCP-style SSH URL
4. Contains `://` → Generic URL protocol
5. Otherwise → Local filesystem path

## Related Validation Patterns

**validateHank() function** (config.ts lines 1207-1665) performs comprehensive pre-flight checks:
- File existence and readability
- Dangerous commands in rigSetup
- Duplicate codon IDs
- Model compatibility
- Self-tests for shims

**For URL-based hanks**, this validation should run after download, before execution begins.

## Environment Variable Patterns

Config can be influenced by `HANKWEAVE_RUNTIME_*` env vars (lines 777-850). Could add:
- `HANKWEAVE_CACHE_DIR` to customize cache location
- `HANKWEAVE_TRUST_REPOS` to whitelist trusted repositories
- `HANKWEAVE_GIT_SSH_KEY` to specify SSH key for private repos

## Error Handling Patterns

Consistent error pattern throughout codebase:
```typescript
try {
  // operation
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(`Specific contextual error message`);
  }
  throw error; // Re-throw if not handled
}
```

**For URL operations**, should handle:
- Network errors (ENOTFOUND, ETIMEDOUT)
- Git errors (authentication, not found, invalid repo)
- Filesystem errors (cache directory permissions)
- Invalid hank content (validation after download)

## Summary of Integration Points

1. **URL Detection**: `server/index.ts` line 101-103 (CLI parsing)
2. **Download Logic**: New module `server/hank-downloader.ts` (to create)
3. **Config Loading**: `server/config.ts` line 684-713 (modify loadHankFile)
4. **Path Resolution**: `server/config.ts` line 910-990 (works with cached path)
5. **Validation**: `server/config.ts` line 1207-1665 (no changes needed)
6. **Cache Management**: New command in `server/index.ts` (e.g., `--clean-cache`)

The codebase architecture is well-suited for this feature - the execution isolation pattern means downloaded hanks naturally fit into the existing flow once they're in the cache.
