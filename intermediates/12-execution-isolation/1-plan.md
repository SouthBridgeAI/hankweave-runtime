# Langton Execution Isolation - Complete Implementation Plan (Updated)

## Overview

This plan implements execution isolation where Langton runs in a separate directory from user data, enabling clean rollbacks and multiple execution tracking. All user data is accessed through a `data/` subdirectory (via symlink or copy) within the execution directory.

## Core Concepts

### Directory Structure
```
/user/project/              # Original data source (--data flag)
/home/.langton-executions/  # Execution root
  └── a1b2c3d4e5f6/        # Hash-based execution directory
      ├── .langton/         # Langton state/logs/checkpoints
      ├── data/             # Symlink/copy of user project
      └── generated-files/  # Files created by Claude
```

### Key Paths - UPDATED NAMES
- **`readOnlySourceDataPath`**: Original user project directory (from `--data` flag, default: cwd)
- **`executionPath`**: Primary directory where EVERYTHING gets written - server runs here, `.langton` lives here, git operates here, Claude runs here
- **`dataPathInExecutionDir`**: Always `${executionPath}/data` - the symlink/copy target used ONLY during setup and verification

### Template Variables
- **`<%PROJECT_DIR%>`**: Points to `executionPath` (legacy support)
- **`<%EXECUTION_DIR%>`**: Points to `executionPath`
- **`<%DATA_DIR%>`**: Points to `dataPathInExecutionDir` (the data/ subdirectory)

### Important Principles - CLARIFIED
- `readOnlySourceDataPath` is ONLY used during initial setup to create the symlink/copy
- `dataPathInExecutionDir` is ONLY used:
  1. During execution directory setup (to create symlink/copy)
  2. At startup for verification
  3. NOWHERE ELSE - everything else uses `executionPath`
- All file operations after setup use `executionPath`
- Claude runs with `cwd = executionPath` and accesses user files via `data/` subdirectory
- Checkpoint git completely ignores the `data/` directory via file resolver, NOT gitignore
- Config files are loaded from their original locations (not copied)
- Relative paths in config:
  - Prompt files: resolved relative to config file location
  - Copy sources: resolved relative to config file location
  - Copy targets: resolved relative to executionPath
  - `.langton` is always in executionPath

## Implementation Plan

### Phase 1: Core Infrastructure

#### 1.1 Create `server/data-hasher.ts` - AS FUNCTIONS NOT CLASS
```typescript
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Generate a hash based on directory structure with depth and time limits
 * Uses file names, types, sizes, and modification times
 */
export async function hashDataDirectory(
  dataPath: string,
  timeLimit: number = 5000
): Promise<string> {
  const maxDepth = 3;
  const startTime = Date.now();
  const entries: string[] = [];

  async function scan(currentDir: string, depth: number) {
    // Check time limit
    if (Date.now() - startTime > timeLimit) {
      entries.push('TIMEOUT:scan_truncated');
      return;
    }

    if (depth > maxDepth) return;

    try {
      const items = await fs.promises.readdir(currentDir, { withFileTypes: true });

      // Sort for deterministic hashing
      items.sort((a, b) => a.name.localeCompare(b.name));

      // Limit entries per directory to prevent explosion
      const limitedItems = items.slice(0, 100);
      if (items.length > 100) {
        entries.push(`TRUNCATED:${currentDir}:${items.length - 100}_more_items`);
      }

      for (const item of limitedItems) {
        // Skip hidden files and common large directories
        if (item.name.startsWith('.') ||
            item.name === 'node_modules' ||
            item.name === '__pycache__' ||
            item.name === 'dist' ||
            item.name === 'build') {
          continue;
        }

        const fullPath = path.join(currentDir, item.name);
        const relativePath = path.relative(dataPath, fullPath);

        try {
          const stats = await fs.promises.stat(fullPath);

          // Include type, name, size, and mtime for better discrimination
          const mtime = Math.floor(stats.mtimeMs / 1000); // Round to seconds
          const entry = item.isDirectory()
            ? `d:${relativePath}:${mtime}`
            : `f:${relativePath}:${stats.size}:${mtime}`;

          entries.push(entry);

          // Recurse into directories
          if (item.isDirectory() && depth < maxDepth) {
            await scan(fullPath, depth + 1);
          }
        } catch (error) {
          // Skip files we can't stat (permissions, symlinks, etc)
          entries.push(`e:${relativePath}:error`);
        }
      }
    } catch (error) {
      // Skip directories we can't read
      entries.push(`e:${currentDir}:read_error`);
    }
  }

  await scan(dataPath, 0);

  // If we got very few entries, add the data path itself for uniqueness
  if (entries.length < 5) {
    entries.push(`path:${dataPath}`);
  }

  // Create hash from sorted entries
  const hash = crypto.createHash('sha256');
  hash.update(entries.join('\n'));
  return hash.digest('hex').substring(0, 12);
}

/**
 * Find existing execution directories for a data hash
 */
export async function findExecutionDirs(dataHash: string): Promise<string[]> {
  const executionRoot = path.join(os.homedir(), '.langton-executions');
  if (!fs.existsSync(executionRoot)) return [];

  const dirs: string[] = [];
  const entries = await fs.promises.readdir(executionRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metaPath = path.join(executionRoot, entry.name, '.langton', 'execution-meta.json');
    try {
      const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
      if (meta.dataHash === dataHash) {
        dirs.push(path.join(executionRoot, entry.name));
      }
    } catch {
      // Ignore directories without valid metadata
    }
  }

  return dirs.sort((a, b) => b.localeCompare(a)); // Newest first
}
```

#### 1.2 Create `server/execution-setup.ts`
```typescript
import os from 'os';
import fs from 'fs';
import path from 'path';
import { hashDataDirectory, findExecutionDirs } from './data-hasher.js';
import { DEFAULT_CONFIG } from './config.js';

export interface ExecutionSetup {
  readOnlySourceDataPath: string;   // Absolute path to original data
  executionPath: string;            // Absolute path where we run
  dataPathInExecutionDir: string;   // Always executionPath + '/data'
  dataHash: string;
  isNewExecution: boolean;
  isResuming: boolean;
  linkType: 'symlink' | 'copy';
  meta: {
    createdAt: string;
    lastUsed: string;
    sourceRealPath: string;
    version: string;
  };
}

export async function setupExecutionEnvironment(options: {
  readOnlySourceDataPath: string;  // Already resolved to absolute
  executionPath?: string;          // Already resolved to absolute, or undefined
  useSymlink?: boolean;            // Default true, --copy flag sets to false
  dataHashTimeLimit?: number;      // Time limit for hashing
}): Promise<ExecutionSetup> {
  const {
    readOnlySourceDataPath,
    executionPath,
    useSymlink = true,
    dataHashTimeLimit = DEFAULT_CONFIG.dataHashTimeLimit
  } = options;

  // Verify data source exists
  if (!fs.existsSync(readOnlySourceDataPath)) {
    throw new Error(`Data source not found: ${readOnlySourceDataPath}`);
  }

  const stats = await fs.promises.stat(readOnlySourceDataPath);
  if (!stats.isDirectory()) {
    throw new Error(`Data source is not a directory: ${readOnlySourceDataPath}`);
  }

  // Calculate data hash
  console.log('Calculating data signature...');
  const dataHash = await hashDataDirectory(readOnlySourceDataPath, dataHashTimeLimit);
  console.log(`Data signature: ${dataHash}`);

  let finalExecutionPath: string;
  let isNewExecution = false;
  let isResuming = false;

  if (executionPath) {
    // Explicit execution path provided - must already exist
    if (!fs.existsSync(executionPath)) {
      throw new Error(`Execution directory not found: ${executionPath}`);
    }

    // Verify it's a directory
    const stats = await fs.promises.stat(executionPath);
    if (!stats.isDirectory()) {
      throw new Error(`Execution path is not a directory: ${executionPath}`);
    }

    // Prevent nested execution
    if (executionPath.includes('/.langton-executions/') &&
        executionPath.includes('/data')) {
      throw new Error('Cannot create execution inside another execution directory');
    }

    // Prevent using data source as execution
    if (path.resolve(executionPath) === path.resolve(readOnlySourceDataPath)) {
      throw new Error('Execution directory cannot be the same as data source');
    }

    // Check if it has execution metadata
    const metaPath = path.join(executionPath, '.langton', 'execution-meta.json');
    if (fs.existsSync(metaPath)) {
      // Verify data hash matches
      const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
      if (meta.dataHash !== dataHash) {
        throw new Error(
          `Data source mismatch. Execution directory was created for different data.\n` +
          `Expected hash: ${meta.dataHash}\n` +
          `Current hash: ${dataHash}`
        );
      }
      isResuming = true;
    } else {
      // Directory exists but no metadata - treat as fresh execution
      isNewExecution = true;
      console.log(`Using existing directory as execution directory: ${executionPath}`);
    }

    finalExecutionPath = executionPath;
  } else {
    // Auto-detect or create execution directory
    const executionRoot = path.join(os.homedir(), '.langton-executions');
    await fs.promises.mkdir(executionRoot, { recursive: true });

    // Look for existing execution directories
    const existingDirs = await findExecutionDirs(dataHash);

    if (existingDirs.length > 0) {
      // Use most recent
      finalExecutionPath = existingDirs[0];
      isResuming = true;
      console.log(`Resuming execution in: ${finalExecutionPath}`);
    } else {
      // Create new execution directory
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 6);
      const dirName = `${timestamp}-${random}-${dataHash.substring(0, 6)}`;
      finalExecutionPath = path.join(executionRoot, dirName);
      await fs.promises.mkdir(finalExecutionPath, { recursive: true });
      isNewExecution = true;
      console.log(`Created execution directory: ${finalExecutionPath}`);
    }
  }

  const dataPathInExecutionDir = path.join(finalExecutionPath, 'data');

  // Set up data access (symlink or copy)
  let linkType: 'symlink' | 'copy' = 'symlink';
  if (isNewExecution || !fs.existsSync(dataPathInExecutionDir)) {
    if (useSymlink) {
      try {
        await fs.promises.symlink(readOnlySourceDataPath, dataPathInExecutionDir, 'dir');
        linkType = 'symlink';
      } catch (error) {
        console.warn(`Failed to create symlink: ${error}. Falling back to copy.`);
        await copyDirectory(readOnlySourceDataPath, dataPathInExecutionDir);
        linkType = 'copy';
      }
    } else {
      await copyDirectory(readOnlySourceDataPath, dataPathInExecutionDir);
      linkType = 'copy';
    }
  }

  // Create/update metadata
  const metaDir = path.join(finalExecutionPath, '.langton');
  await fs.promises.mkdir(metaDir, { recursive: true });

  const meta = {
    version: '1.0.0',
    readOnlySourceDataPath,
    sourceRealPath: await fs.promises.realpath(readOnlySourceDataPath),
    dataHash,
    linkType,
    createdAt: isNewExecution ? new Date().toISOString() :
               (fs.existsSync(path.join(metaDir, 'execution-meta.json')) ?
                JSON.parse(await fs.promises.readFile(path.join(metaDir, 'execution-meta.json'), 'utf-8')).createdAt :
                new Date().toISOString()),
    lastUsed: new Date().toISOString()
  };

  await fs.promises.writeFile(
    path.join(metaDir, 'execution-meta.json'),
    JSON.stringify(meta, null, 2)
  );

  return {
    readOnlySourceDataPath,
    executionPath: finalExecutionPath,
    dataPathInExecutionDir,
    dataHash,
    isNewExecution,
    isResuming,
    linkType,
    meta
  };
}

async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Handle symlinks
      const target = await fs.promises.readlink(srcPath);
      await fs.promises.symlink(target, destPath);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
    }
    // Skip other types (FIFO, socket, etc.)
  }
}
```

### Phase 2: Type System Updates

#### 2.1 Update `server/types.ts`

**REMOVE projectPath from ServerConfig and ADD execution fields**:
```typescript
export interface ServerConfig {
  // REMOVE THIS:
  // projectPath: string;

  // ADD THESE - Execution paths (from ExecutionSetup)
  readOnlySourceDataPath: string;   // Original data location (for reference only)
  executionPath: string;            // Primary directory where everything runs
  dataPathInExecutionDir: string;   // executionPath + '/data' - ONLY for setup
  dataHash: string;
  isNewExecution: boolean;
  isResuming: boolean;
  linkType: 'symlink' | 'copy';

  // Existing config fields
  port: number;
  version: string;
  autostart: boolean;
  lockFile: string;
  serverLogFile: string;
  socketLogFile: string;
  dataHashTimeLimit: number;  // NEW: Time limit for hashing directories
  // ... other existing fields
}

// Update ServerReadyEvent - IMPORTANT UPDATE
export interface ServerReadyEvent {
  id: EventId;
  timestamp: string;
  type: "server.ready";
  data: {
    serverVersion: string;
    executionPath: string;    // Where server/git/logs operate
    dataPath: string;         // Where user data is accessible (data/ subdirectory)
  };
}
```

**UPDATE DEFAULT_CONFIG in server/config.ts**:
```typescript
export const DEFAULT_CONFIG: Omit<ServerConfig, "executionPath" | "phases" | /* other execution fields */> = {
  // ... existing defaults ...
  dataHashTimeLimit: 5000,  // 5 seconds for directory hashing
};
```

### Phase 3: Core Component Updates

#### 3.1 Update `server/langton-server.ts`

**Constructor changes**:
```typescript
export class LangtonServer extends TypedEventEmitter<ServerInternalEvents> {
  constructor(
    config: Partial<ServerConfig> & {
      phases: PhaseConfig[];
    },
  ) {
    super();

    // Merge with defaults
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    // Update logger to use execution path
    this.logger = new Logger(
      path.join(this.config.executionPath, this.config.serverLogFile)
    );

    // Initialize state manager with execution path
    const langtonDir = path.join(this.config.executionPath, ".langton");
    this.stateManager = new StateManager(langtonDir, this.logger, this.config.phases);
  }
}
```

**Path updates throughout LangtonServer**:

1. **Lock file**:
```typescript
// In constructor or early in start()
this.config.lockFile = path.join(this.config.executionPath, '.langton/server.lock');
```

2. **Checkpoint initialization**:
```typescript
private async initializeCheckpoints(): Promise<void> {
  // ... existing git check ...

  // Initialize checkpoint git in execution directory
  this.checkpointGit = new CheckpointGit(this.config.executionPath, this.logger);
  await this.checkpointGit.initialize();
}
```

3. **File operations** - Update `copyPath()`:
```typescript
private async copyPath(from: string, to: string): Promise<void> {
  // 'from' is already absolute (resolved in loadPhaseConfig)
  // 'to' is relative to executionPath (NOT readOnlySourceData!)
  const targetPath = path.join(this.config.executionPath, to);

  // Check if target parent directory exists
  const targetParent = path.dirname(targetPath);
  const parentStats = await fs.promises.stat(targetParent).catch(() => null);
  if (!parentStats || !parentStats.isDirectory()) {
    throw new Error(`Target parent directory does not exist: ${targetParent}`);
  }

  // ... rest of existing copy logic
}
```

4. **Workspace setup command execution** - Update `runCommand()`:
```typescript
// In startPhase() workspace setup section
const workingDir = item.command.workingDirectory === "lastCopied" && lastCopiedPath
  ? lastCopiedPath
  : this.config.executionPath;  // Changed from this.config.projectPath

// And update the runCommand method itself:
private async runCommand(command: string, cwd: string): Promise<void> {
  // cwd is now already resolved to executionPath or lastCopied path
  // ... existing implementation
}
```

5. **File tracking** - Update `handleFileToolCall()`:
```typescript
private async handleFileToolCall<T extends ToolName>(
  toolName: T,
  toolInput: Record<string, unknown> | undefined,
): Promise<void> {
  // ... extract filePath ...

  if (!filePath) return;

  // Make path relative if it's absolute
  if (path.isAbsolute(filePath)) {
    filePath = path.relative(this.config.executionPath, filePath);
  }

  // Check if file matches any watch pattern
  const normalizedPath = filePath.replace(/^\.\//g, "");
  const matchesPattern = this.watchedPatterns.some((pattern) => {
    const normalizedPattern = pattern.replace(/^\.\//g, "");
    return minimatch(normalizedPath, normalizedPattern, { matchBase: true });
  });

  if (!matchesPattern) {
    return;
  }

  // Read current file content if not provided
  if (!content) {
    const fullPath = path.join(this.config.executionPath, filePath);
    if (fs.existsSync(fullPath)) {
      try {
        content = fs.readFileSync(fullPath, "utf-8");
      } catch (error) {
        this.logger.log(`Error reading file ${filePath}: ${toError(error).message}`, "error");
        return;
      }
    }
  }

  // ... rest of method unchanged
}
```

6. **File tree building** - Update `sendFileTreeUpdate()`:
```typescript
private async sendFileTreeUpdate(): Promise<void> {
  if (this.watchedPatterns.length === 0) return;

  // Build file tree for patterns within executionPath (NOT readOnlySourceData!)
  const allTrees = await Promise.all(
    this.watchedPatterns.map((pattern) =>
      buildFileTree(this.config.executionPath, pattern)
    ),
  );

  // ... rest of logic unchanged
}
```

7. **Template variable substitution** - Update `buildSystemPrompt()`:
```typescript
private buildSystemPrompt(phase: PhaseConfig): string | null {
  // ... existing logic ...

  if (content) {
    // Replace template variables with new names
    return content
      .replace(/<%PROJECT_DIR%>/g, this.config.executionPath)  // Legacy support
      .replace(/<%EXECUTION_DIR%>/g, this.config.executionPath)
      .replace(/<%DATA_DIR%>/g, this.config.dataPathInExecutionDir);
  }

  return null;
}

// ALSO need to update prompt feeding in ClaudeProcessManager feedPrompt method
```

9. **Additional path updates in LangtonServer**:

```typescript
// Update all references to this.config.projectPath to this.config.executionPath:

// In ClaudeProcessManager instantiation:
this.processManager = new ClaudeProcessManager(
  this.config.executionPath,  // Changed from projectPath
  this.logger,
  this.logParser,
  this.config.anthropicBaseURL,
);

// In CheckpointGit instantiation:
this.checkpointGit = new CheckpointGit(this.config.executionPath, this.logger);

// In buildFileTree calls:
buildFileTree(this.config.executionPath, pattern)

// In fileResolver.resolveFiles calls:
const resolvedFiles = await fileResolver.resolveFiles(
  this.config.executionPath,
  phase.trackedFiles,
);

// In file path operations (handleFileToolCall, etc):
const fullPath = path.join(this.config.executionPath, filePath);

// In copyPath method - already covered above but ensure the runCommand call uses executionPath:
await this.runCommand(cpCommand, this.config.executionPath);
```

10. **Additional missing component - Template processing in prompt content**:

Since LangtonServer doesn't directly process prompt content (it's done in ClaudeProcessManager), we need to ensure the prompt content is processed with template variables. Look for where the prompt is loaded and fed to Claude.

8. **Server ready event** - IMPORTANT UPDATE:
```typescript
// In handleConnection()
this.sendEvent({
  id: EventId(generateId()),
  timestamp: new Date().toISOString(),
  type: "server.ready",
  data: {
    serverVersion: this.config.version,
    executionPath: this.config.executionPath,
    dataPath: this.config.dataPathInExecutionDir,
  },
} as ServerReadyEvent);
```

#### 3.2 Update `server/claude-process-manager.ts`

**Constructor update**:
```typescript
constructor(
  private executionPath: string,  // Changed from projectPath
  private logger: Logger,
  private logParser: ClaudeLogParser,
  private anthropicBaseURL?: string,
) {
  super();
}
```

**Spawn changes**:
```typescript
async spawn(
  phase: PhaseConfig,
  previousSessionId: string | null,
  logPath?: string,
): Promise<string> {
  // ... existing setup ...

  // Claude runs in execution directory (can access data/ subdirectory)
  this.process = spawn("claude", args, {
    cwd: this.executionPath,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  // ... rest of spawn logic
}
```

**Template processing in `feedPrompt()`**:
```typescript
private async feedPrompt(phase: PhaseConfig): Promise<void> {
  // ... existing prompt loading ...

  const processedContent = promptContent
    .replace(/<%PROJECT_DIR%>/g, this.executionPath)  // Legacy
    .replace(/<%EXECUTION_DIR%>/g, this.executionPath)
    .replace(/<%DATA_DIR%>/g, path.join(this.executionPath, 'data'));

  this.process.stdin.write(processedContent);
  this.process.stdin.end();

  this.logger.log(`Fed prompt to Claude (${processedContent.length} chars)`);
  this.logger.log(`Prompt content:\n${processedContent}`);
}
```

#### 3.3 Update `server/checkpoint-git.ts`

**Constructor and initialization**:
```typescript
export class CheckpointGit {
  private executionPath: string;  // Renamed from projectPath
  private checkpointPath: string;

  constructor(executionPath: string, logger: Logger) {
    this.executionPath = executionPath;
    this.checkpointPath = path.join(executionPath, ".langton", "checkpoints");
    this.logger = logger;
  }

  async initialize(): Promise<string | undefined> {
    // ... existing initialization ...

    // IMPORTANT: Do NOT create gitignore!
    // File resolver will handle excluding data/ directory
    // Add comment explaining this:
    // NOTE: We do NOT create a .gitignore file here.
    // The file resolver is responsible for excluding the data/ directory
    // from checkpoint operations. This ensures consistent behavior
    // across all file operations.

    // Set up git with proper environment
    this.git = simpleGit(this.executionPath, {
      config: [
        `core.worktree=${this.executionPath}`,
        `core.gitdir=${path.join(this.checkpointPath, ".git")}`,
      ],
    }).env({
      GIT_DIR: path.join(this.checkpointPath, ".git"),
      GIT_WORK_TREE: this.executionPath,
      HOME: this.checkpointPath,
      XDG_CONFIG_HOME: this.checkpointPath,
    });

    // ... rest of initialization
  }
}
```

#### 3.4 Update `server/file-resolver.ts`

**Add data directory filtering**:
```typescript
export class UnifiedFileResolver {
  async resolveFiles(basePath: string, patterns: string[]): Promise<string[]> {
    if (patterns.length === 0) {
      return [];
    }

    // Get ignore rules for this project
    const ig = await this.getIgnoreRules(basePath);

    // IMPORTANT: Always ignore the data directory for checkpoints
    // This is enforced here, not via gitignore
    ig.add('data/');
    ig.add('data/**');

    // Expand glob patterns
    const allFiles = await fg(patterns, {
      cwd: basePath,
      absolute: false,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: [".git/**"],
    });

    // Filter through ignore rules
    return allFiles.filter((file) => {
      const normalizedPath = file.startsWith("./") ? file.slice(2) : file;
      return !ig.ignores(normalizedPath);
    });
  }
}
```

#### 3.5 Update `server/utils.ts`

**Update `buildFileTree()` to accept base path**:
```typescript
export async function buildFileTree(basePath: string, pattern: string): Promise<FileNode[]> {
  const tree: FileNode[] = [];

  try {
    // Use unified file resolver with the provided base path
    const resolvedFiles = await fileResolver.resolveFiles(basePath, [pattern]);

    // Get file metadata for each resolved file
    const files = await Promise.all(
      resolvedFiles.map(async (filePath) => {
        const fullPath = path.join(basePath, filePath);
        const stats = await fs.promises.stat(fullPath);
        const content = await fs.promises.readFile(fullPath, "utf-8");
        return {
          path: filePath,
          content,
          lastModified: stats.mtime.toISOString(),
        };
      }),
    );

    // ... rest of existing tree building logic
  } catch (error) {
    console.error("Error building file tree:", error);
  }

  return tree;
}
```

### Phase 4: Entry Point Updates

#### 4.1 COMPLETE REWRITE of `server/index.ts` main function:

**Find the existing `main()` function in server/index.ts and REPLACE THE ENTIRE FUNCTION with this new implementation:**

```typescript
async function main() {
  // Parse arguments
  const rawArgs = process.argv.slice(2);

  // ... existing argument validation ...

  const args = process.argv.slice(2);
  const configPath = args.find((arg) => arg.startsWith("--config="))?.split("=")[1] || "phases.json";
  const dataSourcePath = args.find((arg) => arg.startsWith("--data="))?.split("=")[1];
  const executionPath = args.find((arg) => arg.startsWith("--execution="))?.split("=")[1];
  const useSymlink = !args.includes("--copy");

  // ... other flag parsing (port, basic, validate, cleanup, etc.) ...

  // Help text
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Langton Server - Claude Phase Orchestration

Usage: bun server/index.ts [options]

Options:
  --config=<path>           Path to phases configuration file (default: phases.json)
  --data=<path>             Path to data/project directory (default: current directory)
  --execution=<path>        Resume in specific execution directory
  --copy                    Copy data instead of symlinking (for compatibility)
  --port=<port>             WebSocket server port (default: 7777)
  --basic, -b               Run in basic TUI mode
  --validate, -v            Validate configuration without running
  --cleanup                 Clean up execution directories
  -y                        Skip confirmation prompts
  --no-autostart            Don't automatically start phases
  --anthropic-base-url=<url> Custom Anthropic API base URL
  --help, -h                Show this help message

Execution Isolation:
  Langton runs in an isolated execution directory separate from your data.
  This enables clean rollbacks and multiple execution tracking.

  Your data is accessed via: <execution-dir>/data/

Template Variables:
  <%EXECUTION_DIR%>  - The execution directory path
  <%DATA_DIR%>       - The data directory path (execution-dir/data)

Examples:
  # Run with default data (current directory)
  bun server/index.ts

  # Run with specific data directory
  bun server/index.ts --data=/path/to/project

  # Resume specific execution
  bun server/index.ts --execution=/home/.langton-executions/1234-abc

  # Copy data instead of symlinking (for Windows/permissions issues)
  bun server/index.ts --data=/path/to/project --copy

  # Clean up all executions for a data directory
  bun server/index.ts --cleanup --data=/path/to/project
`);
    process.exit(0);
  }

  // Resolve data source path
  const originalCwd = process.cwd();  // Save original CWD
  const resolvedDataPath = path.resolve(dataSourcePath || originalCwd);

  // Set up execution environment
  let executionSetup: ExecutionSetup;
  try {
    executionSetup = await setupExecutionEnvironment({
      readOnlySourceDataPath: resolvedDataPath,
      executionPath: executionPath ? path.resolve(executionPath) : undefined,
      useSymlink,
    });
  } catch (error) {
    console.error(`❌ Execution setup failed: ${error.message}`);
    process.exit(1);
  }

  console.log(`📁 Data source: ${executionSetup.readOnlySourceDataPath}`);
  console.log(`🏃 Execution: ${executionSetup.executionPath}`);
  console.log(`🔗 Link type: ${executionSetup.linkType}`);

  // Change to execution directory for server operation
  process.chdir(executionSetup.executionPath);

  // Handle cleanup mode - UPDATED FOR LATEST EXECUTION ONLY
  if (cleanupMode) {
    try {
      const cleanup = new CleanupCommand({
        dataSourcePath: executionSetup.readOnlySourceDataPath,
        executionPath: executionSetup.executionPath,
        skipConfirmation,
      });

      const result = await cleanup.execute();
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(`\n❌ Cleanup failed: ${error.message}`);
      process.exit(1);
    }
  }

  // Load and validate configuration
  // Config path is resolved relative to original CWD, not execution dir
  const absoluteConfigPath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(originalCwd, configPath);

  try {
    // Validation mode
    if (validateMode) {
      console.log(`\n🔍 Validating configuration: ${absoluteConfigPath}\n`);

      const validationResult = await validatePhaseConfig(
        absoluteConfigPath,
        executionSetup.executionPath  // Changed from readOnlySourceData
      );

      // ... existing validation output ...

      process.exit(0);
    }

    // Normal server mode - validate config
    const { phases, warnings } = await validatePhaseConfig(
      absoluteConfigPath,
      executionSetup.executionPath  // Changed from readOnlySourceData
    );

    // Log any non-fatal warnings
    if (warnings.length > 0) {
      console.log("\n⚠️  Configuration warnings:");
      for (const warning of warnings) {
        console.log(`  - ${warning}`);
      }
      console.log();
    }

    // Create server configuration by merging ExecutionSetup with other config
    const serverConfig: Partial<ServerConfig> & {
      phases: PhaseConfig[];
    } = {
      // Spread all ExecutionSetup properties into config
      readOnlySourceDataPath: executionSetup.readOnlySourceDataPath,
      executionPath: executionSetup.executionPath,
      dataPathInExecutionDir: executionSetup.dataPathInExecutionDir,
      dataHash: executionSetup.dataHash,
      isNewExecution: executionSetup.isNewExecution,
      isResuming: executionSetup.isResuming,
      linkType: executionSetup.linkType,

      // Other config options
      phases,
      anthropicBaseURL,
      autostart: !noAutostart,
    };

    if (port) {
      serverConfig.port = parseInt(port, 10);
    }

    const server = new LangtonServer(serverConfig);
    await server.start();

    if (basicMode) {
      // Give server a moment to start before connecting
      setTimeout(() => {
        new BasicTUI(server);
      }, 100);
      console.log("🎮 Running in basic TUI mode");
    }
  } catch (error) {
    console.error(
      `Failed to start server: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
```

### Phase 5: Command Updates

#### 5.1 Rewrite `server/cleanup-command.ts` - UPDATED FOR LATEST ONLY:

```typescript
import fs from 'fs';
import path from 'path';
import { hashDataDirectory, findExecutionDirs } from './data-hasher.js';

export interface CleanupOptions {
  dataSourcePath?: string;   // For finding by hash
  executionPath?: string;    // For direct cleanup
  skipConfirmation: boolean;
}

export interface CleanupResult {
  success: boolean;
  directoriesRemoved: string[];
  warnings: string[];
  errors: string[];
}

export class CleanupCommand {
  constructor(private options: CleanupOptions) {}

  async execute(): Promise<CleanupResult> {
    const result: CleanupResult = {
      success: false,
      directoriesRemoved: [],
      warnings: [],
      errors: [],
    };

    try {
      let dirsToRemove: string[] = [];

      if (this.options.executionPath) {
        // Direct execution path cleanup - just clean this one
        dirsToRemove = [this.options.executionPath];
      } else if (this.options.dataSourcePath) {
        // Find by data hash - ONLY clean up the latest
        console.log('Calculating data signature for cleanup...');
        const dataHash = await hashDataDirectory(this.options.dataSourcePath);
        console.log(`Data signature: ${dataHash}`);

        const allDirs = await findExecutionDirs(dataHash);

        if (allDirs.length === 0) {
          console.log("No execution directories found for this data source.");
          result.success = true;
          return result;
        }

        // UPDATED: Only clean up the latest (first in sorted list)
        dirsToRemove = [allDirs[0]];

        // Show all directories found but note we're only cleaning the latest
        if (allDirs.length > 1) {
          console.log(`Found ${allDirs.length} execution directories.`);
          console.log('Only the latest will be cleaned up.\n');
        }
      } else {
        throw new Error("Either dataSourcePath or executionPath must be provided");
      }

      // Display what will be removed
      console.log("🧹 Langton Cleanup Tool\n");
      console.log("The following execution directory will be removed:\n");

      for (const dir of dirsToRemove) {
        const metaPath = path.join(dir, '.langton', 'execution-meta.json');
        try {
          const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
          console.log(`📁 ${dir}`);
          console.log(`   Created: ${meta.createdAt}`);
          console.log(`   Last used: ${meta.lastUsed}`);
          console.log(`   Link type: ${meta.linkType}`);
          console.log(`   Original data: ${meta.dataSourcePath}`);

          // Calculate size
          const size = await getDirectorySize(dir);
          console.log(`   Size: ${formatSize(size)}`);
        } catch {
          console.log(`📁 ${dir} (metadata unavailable)`);
        }
        console.log();
      }

      // If there are other directories, list them but note they won't be removed
      if (this.options.dataSourcePath) {
        const allDirs = await findExecutionDirs(await hashDataDirectory(this.options.dataSourcePath));
        const otherDirs = allDirs.filter(d => !dirsToRemove.includes(d));

        if (otherDirs.length > 0) {
          console.log("Other execution directories (will NOT be removed):");
          for (const dir of otherDirs) {
            console.log(`  - ${dir}`);
          }
          console.log();
        }
      }

      // Get confirmation
      if (!this.options.skipConfirmation) {
        const confirmed = await this.getConfirmation();
        if (!confirmed) {
          console.log("\n❌ Cleanup cancelled by user");
          return result;
        }
      }

      // Remove directory
      console.log("\n🗑️  Removing execution directory...\n");

      for (const dir of dirsToRemove) {
        try {
          // Check for running server
          const lockFile = path.join(dir, '.langton', 'server.lock');
          if (fs.existsSync(lockFile)) {
            result.errors.push(`Cannot remove ${dir}: Server is running`);
            console.log(`❌ Skipped (server running): ${dir}`);
            continue;
          }

          await fs.promises.rm(dir, { recursive: true, force: true });
          result.directoriesRemoved.push(dir);
          console.log(`✅ Removed: ${dir}`);
        } catch (error) {
          result.errors.push(`Failed to remove ${dir}: ${error.message}`);
          console.log(`❌ Failed: ${dir} - ${error.message}`);
        }
      }

      result.success = result.errors.length === 0;

      // Display summary
      console.log(`\n${"=".repeat(50)}\n`);
      if (result.success) {
        console.log(`✅ Cleanup completed successfully!`);
        console.log(`   Removed ${result.directoriesRemoved.length} execution directory`);
      } else {
        console.log(`⚠️  Cleanup completed with errors`);
        console.log(`   Removed: ${result.directoriesRemoved.length} directories`);
        console.log(`   Failed: ${result.errors.length} directories`);
      }
    } catch (error) {
      result.errors.push(error.message);
      console.error(`\n❌ Cleanup failed: ${error.message}`);
    }

    return result;
  }

  private async getConfirmation(): Promise<boolean> {
    console.log("❓ Proceed with cleanup? This cannot be undone! (y/N): ");

    return new Promise((resolve) => {
      process.stdin.once("data", (data) => {
        const input = data.toString().trim().toLowerCase();
        resolve(input === "y" || input === "yes");
      });
    });
  }
}

// Helper functions
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      totalSize += await getDirectorySize(fullPath);
    } else if (entry.isFile()) {
      try {
        const stats = await fs.promises.stat(fullPath);
        totalSize += stats.size;
      } catch {
        // Ignore files we can't stat
      }
    }
  }

  return totalSize;
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}
```

### Phase 6: Configuration Updates

#### 6.1 Update `server/config.ts`:

The `loadPhaseConfig()` function doesn't need changes - it already resolves paths relative to the config file location, which is correct.

**Update `validatePhaseConfig()` to accept executionPath**:
```typescript
export async function validatePhaseConfig(
  configPath: string,
  executionPath: string,  // Changed from projectPath, and definitely NOT readOnlySourceData
): Promise<ValidationResult> {
  // First, use loadPhaseConfig to do basic validation
  const phases = loadPhaseConfig(configPath);

  const result: ValidationResult = {
    phases,
    phaseCount: phases.length,
    promptFileCount: 0,
    systemPromptFileCount: 0,
    workspaceSetupCount: 0,
    watchingPhaseCount: 0,
    checkpointPhaseCount: 0,
    warnings: [],
    environmentVariables: {
      fromSystem: {},
      fromPhases: [],
    },
  };

  // ... existing validation logic ...

  // When checking workspace setup targets, validate against executionPath
  if (phase.workspaceSetup) {
    for (const [itemIndex, item] of phase.workspaceSetup.entries()) {
      if (item.type === "copy" && item.copy) {
        // Source files are already validated by loadPhaseConfig
        // Check target would be within executionPath
        const targetPath = path.join(executionPath, item.copy.to);
        const targetParent = path.dirname(targetPath);

        try {
          const relativeParent = path.relative(executionPath, targetParent);
          if (relativeParent.startsWith("..")) {
            throw new Error(
              `${phaseLabel}, workspace setup item ${itemIndex + 1}: ` +
              `Target path "${item.copy.to}" would write outside execution directory`,
            );
          }
        } catch (_error) {
          throw new Error(
            `${phaseLabel}, workspace setup item ${itemIndex + 1}: ` +
            `Invalid target path "${item.copy.to}"`,
          );
        }

        // ... rest of workspace validation
      }
    }
  }

  // ... rest of validation logic
}
```

### Phase 7: Additional Component Updates

#### 7.1 Update `server/basic-tui.ts`

The Basic TUI needs to handle the new execution directory structure:

```typescript
// Update any references to project paths
// Ensure the display shows the correct execution and data paths
// Handle the new ServerReadyEvent structure with executionPath and dataPath
```

#### 7.2 Error Messages

Search for and update all error messages that reference "project directory":

```typescript
// Examples to search and replace:
"Failed to read project directory" → "Failed to read execution directory"
"Outside project directory" → "Outside execution directory"
"Target parent directory does not exist" → Keep as is (already correct)
```

#### 7.3 Log Parser Updates

If log parser references paths, ensure they use execution paths:

```typescript
// Log paths are already relative to run folder which is in execution directory
// No changes likely needed
```

## Additional Considerations

### Windows Compatibility
- The `--copy` flag is essential for Windows where symlinks require admin privileges
- Ensure path separators work correctly across platforms
- Test copy fallback mechanism thoroughly

### Performance Considerations
- Data hashing with time limits prevents hanging on large directories
- Symlinks avoid duplicating data
- File resolver caching remains effective

### Security Considerations
- Execution isolation prevents accidental modification of source data
- Each execution is sandboxed in its own directory
- Rollbacks only affect generated files, not source data

### Migration Path
For existing users:
1. First run will create new execution directory
2. Existing `.langton` in project will be ignored
3. No automatic migration of state (clean start)
4. Old cleanup commands will need updating

## Summary of Key Changes

1. **Path System**:
   - Removed `projectPath` completely
   - Added three distinct paths: `readOnlySourceDataPath`, `executionPath`, `dataPathInExecutionDir`
   - All components updated to use appropriate paths
   - `dataPathInExecutionDir` is ONLY used during setup/verification

2. **Template Variables**:
   - `<%PROJECT_DIR%>` and `<%EXECUTION_DIR%>` resolve to `executionPath`
   - `<%DATA_DIR%>` resolves to `dataPathInExecutionDir` (data/ subdirectory)

3. **Git Isolation**:
   - Checkpoint git runs in `executionPath`
   - File resolver enforces ignoring `data/` directory
   - NO gitignore files created

4. **Claude Execution**:
   - Runs with `cwd = executionPath`
   - Accesses user files via `data/` subdirectory
   - All paths work naturally from Claude's perspective

5. **File Operations**:
   - User file operations use `executionPath`
   - Langton state/logs use `executionPath`
   - Config files loaded from original locations

6. **Data Hashing**:
   - Fast directory signature using readdir with depth/time limits
   - Includes file metadata (size, mtime) for better discrimination
   - Graceful handling of permissions/read errors

7. **Cleanup**:
   - Only removes the latest execution directory by default
   - Shows all executions but clarifies what will be removed
   - Prevents removal of running servers

8. **Process Management**:
   - Original CWD saved before chdir
   - Config paths resolved relative to original location
   - Server operates entirely within execution directory

## Testing Checklist

- [ ] Symlink creation and fallback to copy
- [ ] Data hashing completes within time limit
- [ ] Execution directory reuse with same data hash
- [ ] Resume with `--execution` flag
- [ ] Git operations ignore `data/` directory
- [ ] Claude can access files in `data/`
- [ ] Template variables resolve correctly
- [ ] Cleanup removes only latest execution directory
- [ ] Lock file in correct location
- [ ] State persistence in execution directory
- [ ] File watching works for generated files
- [ ] Config file resolution from various locations
- [ ] Windows compatibility with copy mode
- [ ] Error handling for invalid paths
- [ ] Validation uses executionPath not readOnlySourceData
- [ ] Execution directory must exist when provided by user
- [ ] Execution directory can be used without metadata (but must exist)
- [ ] Nested execution prevention works
- [ ] Data source as execution prevention works
