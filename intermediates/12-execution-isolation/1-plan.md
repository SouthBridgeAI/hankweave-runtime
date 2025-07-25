# Langton Execution Isolation - Complete Implementation Plan

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

### Key Paths
- **`dataSourcePath`**: Original user project directory (from `--data` flag, default: cwd)
- **`executionPath`**: Where server runs, `.langton` lives, git operates
- **`usableDataPath`**: Always `${executionPath}/data` (symlink/copy target)

### Template Variables
- **`<%EXECUTION_DIR%>`**: Points to `executionPath` (replaces `PROJECT_DIR`)
- **`<%DATA_DIR%>`**: Points to `usableDataPath` (new, for accessing user data)

### Important Principles
- `dataSourcePath` is ONLY used during initial setup
- All file operations after setup use either `executionPath` or `usableDataPath`
- Claude runs with `cwd = executionPath` and accesses user files via `data/` subdirectory
- Checkpoint git completely ignores the `data/` directory
- Config files are loaded from their original locations (not copied)

## Implementation Plan

### Phase 1: Core Infrastructure

#### 1.1 Create `server/data-hasher.ts`
```typescript
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DEFAULT_CONFIG } from './config.js';

export class DataHasher {
  /**
   * Generate a hash based on directory structure with depth and time limits
   * Uses file names, types, sizes, and modification times
   */
  static async hashDataDirectory(dataPath: string, timeLimit?: number): Promise<string> {
    const maxDepth = 3;
    const limit = timeLimit ?? DEFAULT_CONFIG.dataHashTimeLimit;
    const startTime = Date.now();
    const entries: string[] = [];

    async function scan(currentDir: string, depth: number) {
      // Check time limit
      if (Date.now() - startTime > limit) {
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
  static async findExecutionDirs(dataHash: string): Promise<string[]> {
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
}
```

#### 1.2 Create `server/execution-setup.ts`
```typescript
import os from 'os';
import fs from 'fs';
import path from 'path';
import { DataHasher } from './data-hasher.js';

export interface ExecutionSetup {
  dataSourcePath: string;    // Absolute path to original data
  executionPath: string;     // Absolute path where we run
  usableDataPath: string;    // Always executionPath + '/data'
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
  dataSourcePath: string;    // Already resolved to absolute
  executionPath?: string;     // Already resolved to absolute, or undefined
  useSymlink?: boolean;       // Default true, --copy flag sets to false
}): Promise<ExecutionSetup> {
  const { dataSourcePath, executionPath, useSymlink = true } = options;

  // Verify data source exists
  if (!fs.existsSync(dataSourcePath)) {
    throw new Error(`Data source not found: ${dataSourcePath}`);
  }

  const stats = await fs.promises.stat(dataSourcePath);
  if (!stats.isDirectory()) {
    throw new Error(`Data source is not a directory: ${dataSourcePath}`);
  }

  // Calculate data hash
  console.log('Calculating data signature...');
  const dataHash = await DataHasher.hashDataDirectory(dataSourcePath);
  console.log(`Data signature: ${dataHash}`);

  let finalExecutionPath: string;
  let isNewExecution = false;
  let isResuming = false;

  if (executionPath) {
    // Explicit execution path provided - resume mode
    if (!fs.existsSync(executionPath)) {
      throw new Error(`Execution directory not found: ${executionPath}`);
    }

    // Prevent nested execution
    if (executionPath.includes('/.langton-executions/') &&
        executionPath.includes('/data')) {
      throw new Error('Cannot create execution inside another execution directory');
    }

    // Prevent using data source as execution
    if (path.resolve(executionPath) === path.resolve(dataSourcePath)) {
      throw new Error('Execution directory cannot be the same as data source');
    }

    // Verify it's a valid execution directory
    const metaPath = path.join(executionPath, '.langton', 'execution-meta.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error(`Not a valid execution directory (missing metadata): ${executionPath}`);
    }

    // Verify data hash matches
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
    if (meta.dataHash !== dataHash) {
      throw new Error(
        `Data source mismatch. Execution directory was created for different data.\n` +
        `Expected hash: ${meta.dataHash}\n` +
        `Current hash: ${dataHash}`
      );
    }

    finalExecutionPath = executionPath;
    isResuming = true;
  } else {
    // Auto-detect or create execution directory
    const executionRoot = path.join(os.homedir(), '.langton-executions');
    await fs.promises.mkdir(executionRoot, { recursive: true });

    // Look for existing execution directories
    const existingDirs = await DataHasher.findExecutionDirs(dataHash);

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

  const usableDataPath = path.join(finalExecutionPath, 'data');

  // Set up data access (symlink or copy)
  let linkType: 'symlink' | 'copy' = 'symlink';
  if (isNewExecution || !fs.existsSync(usableDataPath)) {
    if (useSymlink) {
      try {
        await fs.promises.symlink(dataSourcePath, usableDataPath, 'dir');
        linkType = 'symlink';
      } catch (error) {
        console.warn(`Failed to create symlink: ${error}. Falling back to copy.`);
        await copyDirectory(dataSourcePath, usableDataPath);
        linkType = 'copy';
      }
    } else {
      await copyDirectory(dataSourcePath, usableDataPath);
      linkType = 'copy';
    }
  }

  // Create/update metadata
  const metaDir = path.join(finalExecutionPath, '.langton');
  await fs.promises.mkdir(metaDir, { recursive: true });

  const meta = {
    version: '1.0.0',
    dataSourcePath,
    sourceRealPath: await fs.promises.realpath(dataSourcePath),
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
    dataSourcePath,
    executionPath: finalExecutionPath,
    usableDataPath,
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
    } else {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}
```

### Phase 2: Type System Updates

#### 2.1 Update `server/types.ts`

**REMOVE projectPath from ServerConfig**:
```typescript
export interface ServerConfig {
  projectPath: string;  // DELETE THIS LINE
}
```

**REMOVE executionSetup from config and embed directly**:
```typescript
// REMOVE the ExecutionPaths interface and instead embed these properties directly in ServerConfig

export interface ServerConfig {
  // Execution paths (from ExecutionSetup)
  dataSourcePath: string;    // Original data location (for reference only)
  executionPath: string;     // Where server runs
  usableDataPath: string;    // executionPath + '/data'
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

// Update event types - REMOVE projectPath entirely
export interface ServerReadyEvent {
  id: EventId;
  timestamp: string;
  type: "server.ready";
  data: {
    serverVersion: string;
    executionPath: string;    // Where server/git/logs operate
    dataPath: string;         // Where user data is accessible
  };
}
```

**ADD to DEFAULT_CONFIG in server/config.ts**:
```typescript
export const DEFAULT_CONFIG = {
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
  // 'to' is relative to usableDataPath
  const targetPath = path.join(this.config.usableDataPath, to);

  // Check if target parent directory exists
  const targetParent = path.dirname(targetPath);
  const parentStats = await fs.promises.stat(targetParent).catch(() => null);
  if (!parentStats || !parentStats.isDirectory()) {
    throw new Error(`Target parent directory does not exist: ${targetParent}`);
  }

  // ... rest of existing copy logic
}
```

4. **Workspace setup command execution**:
```typescript
// In startPhase() workspace setup section
const workingDir = item.command.workingDirectory === "lastCopied" && lastCopiedPath
  ? lastCopiedPath
  : this.config.usableDataPath;  // Changed from this.config.projectPath
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
    filePath = path.relative(this.config.usableDataPath, filePath);
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
    const fullPath = path.join(this.config.usableDataPath, filePath);
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

  // Build file tree for patterns within usableDataPath
  const allTrees = await Promise.all(
    this.watchedPatterns.map((pattern) =>
      buildFileTree(this.config.usableDataPath, pattern)
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
      .replace(/<%DATA_DIR%>/g, this.config.usableDataPath);
  }

  return null;
}
```

8. **Server ready event**:
```typescript
// In handleConnection()
this.sendEvent({
  id: EventId(generateId()),
  timestamp: new Date().toISOString(),
  type: "server.ready",
  data: {
    serverVersion: this.config.version,
    executionPath: this.config.executionPath,
    dataPath: this.config.usableDataPath,
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

    // IMPORTANT: Configure git to ignore the data directory
    const gitignorePath = path.join(this.executionPath, '.gitignore');
    const ignoreContent = 'data/\n';

    // Only create if it doesn't exist (don't overwrite)
    if (!fs.existsSync(gitignorePath)) {
      await fs.promises.writeFile(gitignorePath, ignoreContent);
      this.logger.log('Created .gitignore to exclude data directory');
    }

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

#### 4.1 Complete rewrite of `server/index.ts` main function:

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

  // ... other flag parsing ...

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
      dataSourcePath: resolvedDataPath,
      executionPath: executionPath ? path.resolve(executionPath) : undefined,
      useSymlink,
    });
  } catch (error) {
    console.error(`❌ Execution setup failed: ${error.message}`);
    process.exit(1);
  }

  console.log(`📁 Data source: ${executionSetup.dataSourcePath}`);
  console.log(`🏃 Execution: ${executionSetup.executionPath}`);
  console.log(`🔗 Link type: ${executionSetup.linkType}`);

  // Change to execution directory for server operation
  process.chdir(executionSetup.executionPath);

  // Handle cleanup mode
  if (cleanupMode) {
    try {
      const cleanup = new CleanupCommand({
        dataSourcePath: executionSetup.dataSourcePath,
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
        executionSetup.usableDataPath
      );

      // ... existing validation output ...

      process.exit(0);
    }

    // Normal server mode - validate config
    const { phases, warnings } = await validatePhaseConfig(
      absoluteConfigPath,
      executionSetup.usableDataPath
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
      dataSourcePath: executionSetup.dataSourcePath,
      executionPath: executionSetup.executionPath,
      usableDataPath: executionSetup.usableDataPath,
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

#### 5.1 Rewrite `server/cleanup-command.ts`:

```typescript
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
        // Direct execution path cleanup
        dirsToRemove = [this.options.executionPath];
      } else if (this.options.dataSourcePath) {
        // Find by data hash
        console.log('Calculating data signature for cleanup...');
        const dataHash = await DataHasher.hashDataDirectory(this.options.dataSourcePath);
        console.log(`Data signature: ${dataHash}`);

        dirsToRemove = await DataHasher.findExecutionDirs(dataHash);

        if (dirsToRemove.length === 0) {
          console.log("No execution directories found for this data source.");
          result.success = true;
          return result;
        }
      } else {
        throw new Error("Either dataSourcePath or executionPath must be provided");
      }

      // Display what will be removed
      console.log("🧹 Langton Cleanup Tool\n");
      console.log("The following execution directories will be removed:\n");

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

      // Get confirmation
      if (!this.options.skipConfirmation) {
        const confirmed = await this.getConfirmation();
        if (!confirmed) {
          console.log("\n❌ Cleanup cancelled by user");
          return result;
        }
      }

      // Remove directories
      console.log("\n🗑️  Removing execution directories...\n");

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
        console.log(`   Removed ${result.directoriesRemoved.length} execution directories`);
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

// Also need to import/create these helper functions
async function getDirectorySize(dirPath: string): Promise<number> {
  // ... implementation from original cleanup file-operations.ts
}

function formatSize(bytes: number): string {
  // ... implementation from original cleanup file-operations.ts
}
```

### Phase 6: Configuration Updates

#### 6.1 Update `server/config.ts`:

The `loadPhaseConfig()` function doesn't need changes - it already resolves paths relative to the config file location, which is correct.

**Update `validatePhaseConfig()` to accept usableDataPath**:
```typescript
export async function validatePhaseConfig(
  configPath: string,
  usableDataPath: string,  // Changed from projectPath
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

  // When checking workspace setup targets, validate against usableDataPath
  if (phase.workspaceSetup) {
    for (const [itemIndex, item] of phase.workspaceSetup.entries()) {
      if (item.type === "copy" && item.copy) {
        // Source files are already validated by loadPhaseConfig
        // Check target would be within usableDataPath
        const targetPath = path.join(usableDataPath, item.copy.to);
        const targetParent = path.dirname(targetPath);

        try {
          const relativeParent = path.relative(usableDataPath, targetParent);
          if (relativeParent.startsWith("..")) {
            throw new Error(
              `${phaseLabel}, workspace setup item ${itemIndex + 1}: ` +
              `Target path "${item.copy.to}" would write outside data directory`,
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

## Summary of Key Changes

1. **Path System**:
   - Removed `projectPath` completely
   - Added three distinct paths: `dataSourcePath`, `executionPath`, `usableDataPath`
   - All components updated to use appropriate paths

2. **Template Variables**:
   - `<%EXECUTION_DIR%>` replaces `<%PROJECT_DIR%>`
   - `<%DATA_DIR%>` added for user data access

3. **Git Isolation**:
   - Checkpoint git runs in `executionPath`
   - Completely ignores `data/` directory
   - Tracks only files created by Claude

4. **Claude Execution**:
   - Runs with `cwd = executionPath`
   - Accesses user files via `data/` subdirectory
   - All paths work naturally from Claude's perspective

5. **File Operations**:
   - User file operations use `usableDataPath`
   - Langton state/logs use `executionPath`
   - Config files loaded from original locations

6. **Data Hashing**:
   - Fast directory signature using readdir with depth/time limits
   - Includes file metadata (size, mtime) for better discrimination
   - Graceful handling of permissions/read errors

7. **Cleanup**:
   - Simplified to just remove execution directories
   - Shows metadata about each execution
   - Prevents removal of running servers

8. **Process Management**:
   - Original CWD saved before chdir
   - Config paths resolved relative to original location
   - Server operates entirely within execution directory

# Additional areas to update

### 1. **Checkpoint Git `.gitignore` Location**
The plan creates `.gitignore` in the execution root, but it should be in the checkpoint repository's working tree:

```typescript
// Current plan (incorrect):
const gitignorePath = path.join(this.executionPath, '.gitignore');

// Should be:
const gitignorePath = path.join(this.checkpointPath, '.gitignore');
```

Since the checkpoint git uses the execution directory as its working tree, we need to be careful about where the `.gitignore` is placed.

### 2. **Missing Path Updates in LangtonServer**

Several methods still reference paths that need updating:

```typescript
// In runCommand() method:
await this.runCommand(cpCommand, this.config.projectPath); // Needs update

// In feedPrompt() - this is actually in LangtonServer, not ClaudeProcessManager:
private async feedPrompt(phase: PhaseConfig): Promise<void> {
  // ...
  // The prompt content also needs template variable replacement:
  const processedContent = promptContent
    .replace(/<%PROJECT_DIR%>/g, this.paths.executionPath)
    .replace(/<%EXECUTION_DIR%>/g, this.paths.executionPath)
    .replace(/<%DATA_DIR%>/g, this.paths.usableDataPath);
}
```

## Missing Updates

### 1. **State Manager Paths**
The state manager's event logging and crash detection need path updates:

```typescript
// In logTransitionEvent():
const eventLog = path.join(this.langtonDir, "events.jsonl");
// This already uses langtonDir, but make sure langtonDir is set correctly

// In detectCrashedRuns() - the lock file path validation
```

### 2. **Environment Variable Documentation**
The `buildSystemPrompt` method handles template variables, but the main prompt feeding in `startClaudeProcess` also needs this.

### 3. **Socket and Server Log Paths**
These paths aren't explicitly updated in the plan:

```typescript
// Should be:
this.config.socketLogFile = path.join(this.paths.executionPath, '.langton/logs/websocket.log');
this.config.serverLogFile = path.join(this.paths.executionPath, '.langton/logs/server.log');
```

## Improvements Needed

### 1. **Symlink and Special File Handling**
The `copyDirectory` function needs better handling:

```typescript
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

### 3. **Data Hash Improvements**
Consider including more metadata:

```typescript
// Add to hash calculation:
- Total file count
- Directory permission bits
- Perhaps first few bytes of files for content-based hashing
```

### 4. **Progress Indication for Large Copies**
```typescript
// Add progress callback to copyDirectory:
async function copyDirectory(src: string, dest: string, onProgress?: (copied: number, total: number) => void): Promise<void> {
  // First count total files
  const total = await countFiles(src);
  let copied = 0;
  // ... in copy loop:
  copied++;
  onProgress?.(copied, total);
}
```

## Additional Components to Update

### 1. **Basic TUI** (`basic-tui.ts`)
- Update any hardcoded paths
- Handle the new execution directory structure in display

### 2. **Error Messages**
Search and update all references to "project directory":
```typescript
// Examples:
"Failed to read project directory" → "Failed to read data directory"
"Outside project directory" → "Outside data directory"
```

### 3. **Rollback Operations**
The rollback system needs to understand it's operating in the execution directory:
- Workspace cleanup should not touch the data/ directory
- File restoration should only restore generated files

## Testing Checklist

- [ ] Symlink creation and fallback to copy
- [ ] Data hashing completes within time limit
- [ ] Execution directory reuse with same data hash
- [ ] Resume with `--execution` flag
- [ ] Git ignores `data/` directory
- [ ] Claude can access files in `data/`
- [ ] Template variables resolve correctly
- [ ] Cleanup removes execution directories
- [ ] Lock file in correct location
- [ ] State persistence in execution directory
- [ ] File watching works for generated files
- [ ] Config file resolution from various locations
- [ ] Windows compatibility with copy mode
- [ ] Error handling for invalid paths
- [ ] Validation against usableDataPath

# Updates needed to the plan

Here are some things we discovered during implementation of the plan above:

1. We need better names. a better name for usablDatAPath is readOnlySourceData. usableDataPath was confusing the agent that did the implementation.
2. Then we also need to better define executionPath as the primary directory where everything gets written to.
3. When we run cleanup, we want to list all the directories we can see with the data hash, but only clean up the latest execution directory. If an execution directory is provided, we want to clean that up - by deleting everything in it.
4. We should NOT use gitignores to enforce the data directory not being added. This should be enforced in fileresolver, and we should add a comment to the git part of things that says NOT to create gitignores because fileresolver is the boss. (checkpoint-git around line 92 but not exactly)
5. <%PROJECT_DIR%> and <%EXECUTION_DIR%> can resolve to the execution path. <%DATA_DIR%> is the symlinked/copied data path inside the execution directory.
6. When the user provides an execution directory, we should see if it has an execution, but if not let's treat it as the execution directory and start a run there, even if it doesn't have a meta.json.
7. Datahasher can be a set of functions instead of a class.
8. ServerReadyEvent, runcommand, copypath and buildsystemprompt also need updating.
9. We should be careful on how relative paths are resolved. In phase.config, relative paths for prompts are resolved to the location of the phase.config, as well as source directories for copying. For the target of the copy, the source is (relative path or not) the execution directory. .langton is a directory that's in the executionpath.
10. If we have a time limit for datahash and things, it should be in a config file.
11. We need to rewrite server/index.ts. Point out where.
12. In lots of places during the implementation, we were using usableDataPath instead of the execution path. As far as we know, usableDataPath (now going to be called readonlySourceData) is only useful for symplinking in and during the creation of the execution directory (and once again for verification at startup). NOTHING ELSE SHOULD BE USING THIS.