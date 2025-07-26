# Implementation Plan: --start-new Flag for Langton Server

## Overview

Add a `--start-new` flag to force creation of a new execution directory, preventing reuse of existing executions. This is essential for tests and scenarios where a clean start is required.

## Design Principles

1. **Explicit Control**: Users should have explicit control over whether to reuse or create new executions
2. **Safety First**: Prevent accidental data loss by validating directory state
3. **Clear Errors**: Provide clear error messages when constraints are violated
4. **Backward Compatible**: Default behavior remains unchanged (auto-detect/reuse)

## Implementation Details

### 1. Command Line Argument Updates

**File: `server/index.ts`**

Add to argument validation pattern array:
```typescript
const validPatterns = [
  // ... existing patterns ...
  /^--start-new$/,      // NEW: Force new execution
];
```

Add parsing logic:
```typescript
const startNew = args.includes("--start-new");
```

Update help text:
```typescript
Options:
  --config=<path>           Path to phases configuration file (default: phases.json)
  --data=<path>             Path to data/project directory (default: current directory)
  --execution=<path>        Resume in specific execution directory
  --start-new               Force creation of a new execution directory
  --copy                    Copy data instead of symlinking (for compatibility)
  // ... rest of options ...

Examples:
  # Start fresh execution (ignore existing)
  bun server/index.ts --data=/path/to/project --start-new

  # Start fresh in specific empty directory
  bun server/index.ts --data=/path/to/project --execution=/path/to/empty/dir --start-new
```

### 2. Execution Setup Updates

**File: `server/execution-setup.ts`**

Add `startNew` to options interface:
```typescript
export async function setupExecutionEnvironment(options: {
  readOnlySourceDataPath: string;
  executionPath?: string;
  useSymlink?: boolean;
  dataHashTimeLimit?: number;
  startNew?: boolean;              // NEW: Force new execution
}): Promise<ExecutionSetup> {
```

Update the execution path logic:
```typescript
if (executionPath) {
  // Explicit execution path provided

  if (options.startNew) {
    // With --start-new, directory must not exist OR be empty
    if (fs.existsSync(executionPath)) {
      const entries = await fs.promises.readdir(executionPath);
      if (entries.length > 0) {
        throw new Error(
          `Cannot use --start-new with non-empty execution directory: ${executionPath}\n` +
          `Directory contains ${entries.length} items. Please use an empty directory or omit --execution.`
        );
      }
      // Directory exists but is empty - OK to use
      console.log(`Using empty directory for new execution: ${executionPath}`);
    } else {
      // Directory doesn't exist - create it
      await fs.promises.mkdir(executionPath, { recursive: true });
      console.log(`Created directory for new execution: ${executionPath}`);
    }

    isNewExecution = true;
    isResuming = false;
    finalExecutionPath = executionPath;

  } else {
    // Without --start-new, existing logic applies
    if (!fs.existsSync(executionPath)) {
      throw new Error(`Execution directory not found: ${executionPath}`);
    }
    // ... rest of existing validation logic ...
  }

} else {
  // Auto-detect or create execution directory
  const executionRoot = path.join(os.homedir(), '.langton-executions');
  await fs.promises.mkdir(executionRoot, { recursive: true });

  if (options.startNew) {
    // With --start-new, always create new directory
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6);
    const dirName = `${timestamp}-${random}-${dataHash.substring(0, 6)}`;
    finalExecutionPath = path.join(executionRoot, dirName);
    await fs.promises.mkdir(finalExecutionPath, { recursive: true });
    isNewExecution = true;
    isResuming = false;
    console.log(`Created new execution directory: ${finalExecutionPath}`);

  } else {
    // Without --start-new, use existing logic
    const existingDirs = await findExecutionDirs(dataHash);

    if (existingDirs.length > 0) {
      finalExecutionPath = existingDirs[0];
      isResuming = true;
      console.log(`Resuming execution in: ${finalExecutionPath}`);
    } else {
      // Create new if none exist
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 6);
      const dirName = `${timestamp}-${random}-${dataHash.substring(0, 6)}`;
      finalExecutionPath = path.join(executionRoot, dirName);
      await fs.promises.mkdir(finalExecutionPath, { recursive: true });
      isNewExecution = true;
      console.log(`Created execution directory: ${finalExecutionPath}`);
    }
  }
}
```

### 3. Main Function Updates

**File: `server/index.ts` - main() function**

Pass the flag through to setupExecutionEnvironment:
```typescript
// Set up execution environment
let executionSetup: ExecutionSetup;
try {
  executionSetup = await setupExecutionEnvironment({
    readOnlySourceDataPath: resolvedDataPath,
    executionPath: executionPath ? path.resolve(executionPath) : undefined,
    useSymlink,
    startNew,  // NEW: Pass the flag through
  });
} catch (error) {
  console.error(`❌ Execution setup failed: ${(error as Error).message}`);
  process.exit(1);
}
```

### 4. Validation Rules

The combination of flags should follow these rules:

| Flags | Behavior |
|-------|----------|
| `--start-new` alone | Creates new directory in ~/.langton-executions |
| `--start-new --execution=/empty/dir` | Uses empty directory |
| `--start-new --execution=/non-empty/dir` | **ERROR**: Directory not empty |
| `--execution=/existing/dir` | Resumes existing execution |
| Neither flag | Auto-detect: resume if exists, create if not |

### 5. Error Messages

Provide clear, actionable error messages:

```typescript
// When --start-new is used with non-empty directory
throw new Error(
  `Cannot use --start-new with non-empty execution directory: ${executionPath}\n` +
  `Directory contains ${entries.length} items.\n\n` +
  `Options:\n` +
  `  1. Remove --execution flag to auto-create a new directory\n` +
  `  2. Use an empty directory\n` +
  `  3. Clean the directory first\n` +
  `  4. Remove --start-new to resume the existing execution`
);

// When execution directory has wrong data hash (existing logic)
throw new Error(
  `Data source mismatch. Execution directory was created for different data.\n` +
  `Expected hash: ${meta.dataHash}\n` +
  `Current hash: ${dataHash}\n\n` +
  `Options:\n` +
  `  1. Use --start-new to create a fresh execution\n` +
  `  2. Use the original data source\n` +
  `  3. Remove --execution flag to auto-detect`
);
```

### 6. Test Updates

**File: `tests/e2e/happy-path-e2e.test.ts`**

Update server configuration:
```typescript
const serverConfig: ServerConfig = {
  testRunDir: TEST_RUN_DIR,
  phasesConfig: PHASES_CONFIG,
  port: SERVER_PORT,
  testMode: "e2e-happy-path",
  dataSourceDir: DATA_SOURCE_DIR,
  cwd: process.cwd(),
  useDataFlag: true,
  startNew: true,  // NEW: Force new execution for tests
};
```

**File: `tests/utils/test-helpers.ts`**

Update ServerConfig interface:
```typescript
export interface ServerConfig {
  // ... existing fields ...
  startNew?: boolean;  // NEW: Force new execution
}
```

Update startServer function:
```typescript
export function startServer(config: ServerConfig): ChildProcess {
  const args = [
    serverPath,
    `--config=${config.phasesConfig}`,
    `--port=${config.port}`,
  ];

  if (config.useDataFlag && config.dataSourceDir) {
    args.push(`--data=${config.dataSourceDir}`);
  }

  if (config.executionDir) {
    args.push(`--execution=${config.executionDir}`);
  }

  if (config.startNew) {
    args.push('--start-new');  // NEW: Add flag
  }

  // ... rest of function
}
```

### 7. Edge Cases and Validation

1. **Hidden Files**: When checking if directory is empty, ignore hidden files like `.DS_Store`:
   ```typescript
   const entries = await fs.promises.readdir(executionPath);
   const visibleEntries = entries.filter(e => !e.startsWith('.'));
   if (visibleEntries.length > 0) {
     // Directory not empty
   }
   ```

2. **Race Conditions**: Multiple servers starting simultaneously:
   ```typescript
   // Use filesystem locking or unique naming to prevent collisions
   const dirName = `${timestamp}-${random}-${dataHash.substring(0, 6)}-${process.pid}`;
   ```

3. **Permissions**: Handle permission errors gracefully:
   ```typescript
   try {
     await fs.promises.mkdir(finalExecutionPath, { recursive: true });
   } catch (error) {
     if (error.code === 'EACCES') {
       throw new Error(
         `Permission denied creating execution directory: ${finalExecutionPath}\n` +
         `Please check permissions or use --execution with a writable directory.`
       );
     }
     throw error;
   }
   ```

## Testing Strategy

1. **Unit Tests**: Test setupExecutionEnvironment with various flag combinations
2. **E2E Tests**: Verify happy-path test works with --start-new
3. **Manual Tests**: Test error cases and edge conditions

## Benefits

1. **Deterministic Tests**: Tests always start fresh, no state pollution
2. **User Control**: Users can force clean starts when needed
3. **Clear Semantics**: --start-new is self-documenting
4. **Safe Defaults**: Existing behavior unchanged without flag

## Migration Path

1. No changes needed for existing users (backward compatible)
2. Tests can adopt --start-new immediately
3. Documentation should highlight when to use --start-new
