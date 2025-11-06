# Chronicler Output Files - Execution Specification

## Overview

This feature enables chroniclers to write their outputs to files in the execution directory. Unlike phase output files (which copy completed work to `tadpole-results`), chronicler output files are **continuous logs** that capture the ongoing observation work of each chronicler throughout phase execution.

**Configuration Split**: File paths are specified in **phase config** (execution-specific), while formatting options like `joinString` live in **chronicler config** (portable across phases and projects).

## Goals & Non-Goals

### Goals

1. **Always capture chronicler output** to files (auto-generated if not configured in phase)
2. Support path convention: filename-only → .tadpole, path-with-slash → workspace
3. Support both continuous logging (full history) and current-value tracking (latest only)
4. Validate file paths at chronicler load time to fail fast
5. Support both text and structured output formats with appropriate file extensions
6. Provide flexible text formatting with `joinString` parameter (supports escape sequences)
7. Allow file reuse across phases (append to logFile, replace lastValueFile)

### Non-Goals

1. Not copying chronicler outputs to `tadpole-results` (that's phase output files)
2. Not supporting remote/cloud storage (local filesystem only)
3. Not implementing log rotation or size limits
4. Not supporting binary formats (text/JSON only)

## Design Decisions

### 1. Configuration Split: Phase vs Chronicler

**Phase Config** (execution-specific, where chroniclers are loaded):

```typescript
chroniclers: [{
  id: "narrator",
  outputPaths: {
    logFile?: string,        // Where to write append-only log
    lastValueFile?: string,  // Where to write current value
  }
}]
```

**Chronicler Config** (portable, in chronicler definition):

```typescript
{
  id: "narrator",
  joinString: "\n---\n",  // How to format text output (portable)
  // ... other portable settings (model, prompts, triggers, etc.)
}
```

**Rationale**:

- **Portability**: Same chronicler definition works across different phases/projects
- **Flexibility**: Phase authors control where outputs go in their execution environment
- **Separation of Concerns**: Chronicler defines "how to observe", phase defines "where to write"
- **Reusability**: Chroniclers can be shared without hardcoded paths

### 2. Path Convention & Auto-Generation

**Path Convention**:

```
"output.md"                     → .tadpole/chronicler-outputs/{id}/output.md
"data/analysis.md"              → execution-dir/data/analysis.md
"chroniclers/monitor.ndjson"    → execution-dir/chroniclers/monitor.ndjson
(no config)                     → auto: .tadpole/chronicler-outputs/{id}/{id}-{phase}-{ts}.md
```

**Rules**:

- **Filename only** (no `/`): Goes to `.tadpole/chronicler-outputs/{chronicler-id}/`
- **Path with `/`**: Interpreted relative to execution directory (workspace access)
- **No outputPaths in phase config**: Auto-generate `logFile`
- **Only lastValueFile provided**: Auto-generate `logFile` anyway (observability principle)

**Rationale**:

- Simple, intuitive convention (presence of `/` signals intent)
- Clean workspace by default (.tadpole isolation)
- Flexible workspace access when needed (chroniclers → agent communication)
- **Always have observability**: Auto-generation ensures we never lose chronicler output
- Per-chronicler directories prevent filename collisions

**Example Use Cases**:

```
# Case 1: Auto-generated (no phase config)
.tadpole/chronicler-outputs/narrator/
  narrator-phase-1-1737456789.md
  narrator-phase-2-1737456790.md

# Case 2: Custom filename in .tadpole
outputPaths: { logFile: "summaries.md", lastValueFile: "current.md" }
→ .tadpole/chronicler-outputs/narrator/summaries.md
→ .tadpole/chronicler-outputs/narrator/current.md

# Case 3: Agent-accessible workspace
outputPaths: { logFile: "monitoring/security-log.ndjson" }
→ execution-dir/monitoring/security-log.ndjson

# Case 4: Mixed (workspace + .tadpole)
outputPaths: {
  logFile: "agent-data/entities.ndjson",
  lastValueFile: "latest.json"
}
→ execution-dir/agent-data/entities.ndjson
→ .tadpole/chronicler-outputs/entity-tracker/latest.json

# Case 5: Cross-phase file reuse
# Phase 1 config:
outputPaths: { logFile: "analysis.md" }
# Phase 2 config (same chronicler, same filename):
outputPaths: { logFile: "analysis.md" }
→ Both phases append to: .tadpole/chronicler-outputs/analyzer/analysis.md
→ Builds cross-phase narrative
```

### 3. File Reuse Behavior

When the same file paths are used across multiple phases:

- **logFile**: **Appends** to existing file (accumulates history across phases)
- **lastValueFile**: **Replaces** existing file (always shows latest value from current phase)

This enables powerful patterns:

- Cross-phase narratives (e.g., "analysis started in phase 1, continued in phase 2")
- Running metrics that accumulate across workflow
- Latest-state tracking that updates as phases progress

### 4. Escape Sequence Support

The `joinString` parameter supports common escape sequences:

- `\n` → newline
- `\t` → tab
- `\r` → carriage return
- `\\` → literal backslash

Processed at write time using `joinString.replace(/\\n/g, '\n').replace(/\\t/g, '\t')` etc.

## Requirements

### Functional Requirements

#### FR1: Configuration Schema

**Phase Config** (passed to ChroniclerManager):

```typescript
interface PhaseChroniclerInstance {
  id: string;                    // References chronicler definition
  outputPaths?: {                // Optional: execution-specific paths
    logFile?: string,           // Optional: append-only log
    lastValueFile?: string,     // Optional: current value snapshot
  };
}
```

**Chronicler Config** (in chronicler definition):

```typescript
{
  id: "narrator",
  name: "Development Narrator",
  // ... trigger, execution, prompts, model ...
  joinString?: "\n---\n",  // Optional formatting (defaults to "\n---\n")
}
```

**Path Convention**:

1. **Filename only** (no `/`):

   - Resolved to: `.tadpole/chronicler-outputs/{chronicler-id}/{filename}`
   - Example: `"output.md"` → `.tadpole/chronicler-outputs/narrator/output.md`
1. **Path with directory** (contains `/`):

   - Resolved relative to execution directory
   - Example: `"data/output.md"` → `execution-dir/data/output.md`

**Auto-Generation**:

- If no `outputPaths`: Auto-generate logFile
- If only `lastValueFile`: Auto-generate logFile
- Auto-generated: `.tadpole/chronicler-outputs/{id}/{id}-{phase}-{timestamp}.{ext}`
- Default extension: `.md` (text) or `.ndjson` (structured)

**Validation**:

1. Paths must be relative (no leading `/` or `C:\`)
2. Paths cannot escape execution directory (no `../` climbing out)
3. File extensions for structured output:

   - logFile: `.ndjson` or `.jsonl` (required)
   - lastValueFile: `.json` (required)
4. Text output: `.md` or `.txt` recommended but not enforced

#### FR2: File Creation on Load

When chronicler loads:

1. Receive `outputPaths` from phase config (or undefined for auto-generation)
2. Apply path convention to resolve absolute paths
3. Validate paths (FR1 rules)
4. Create parent directories (`fs.mkdirSync(recursive: true)`)
5. Create empty files if they don't exist
6. Verify write permissions
7. Store absolute paths for runtime use

**Error Handling**:

- Path validation failures → `ChroniclerFatalError` (configuration category)
- Directory creation failures → `ChroniclerFatalError` (configuration category)
- Permission errors → `ChroniclerFatalError` (configuration category)

#### FR3: Writing After Each LLM Call

**For Text Output**:

```typescript
// Process escape sequences in joinString
const processedJoinString = this.processEscapeSequences(joinString);

// Append to logFile
fs.appendFileSync(logFilePath, processedJoinString + response.text + '\n');

// Replace lastValueFile (if configured)
if (lastValueFilePath) {
  this.writeAtomic(lastValueFilePath, response.text);
}
```

**For Structured Output**:

```typescript
// Append to logFile (NDJSON format)
fs.appendFileSync(logFilePath, JSON.stringify(response.object) + '\n');

// Replace lastValueFile (if configured)
if (lastValueFilePath) {
  this.writeAtomic(lastValueFilePath, JSON.stringify(response.object, null, 2));
}
```

**File Reuse Behavior**:

- **logFile** appends → accumulates across phases when same path used
- **lastValueFile** replaces → always shows latest from current phase

### Non-Functional Requirements

#### NFR1: Performance

- Use synchronous writes (simple, sufficient for typical outputs)
- File operations are fast for chronicler-sized outputs (<10KB typical)

#### NFR2: Reliability

- Handle write failures gracefully (log error, don't crash)
- Atomic writes for lastValueFile (write to temp, rename)
- Direct append for logFile (append-only, no atomicity needed)

#### NFR3: Debugging

- Log resolved paths at chronicler initialization
- Log write operations at debug level
- Include chronicler ID in all file operation logs

## Implementation Plan

### Phase 1: Chronicler Config Schema

#### 1.1 Add joinString to Chronicler Schema

**File**: `server/config-validation/chronicler.schema.ts`

```typescript
// Add to existing chroniclerConfigSchema
export const chroniclerConfigSchema = z.object({
  // ... existing fields (id, name, trigger, execution, prompts, model, etc.) ...

  joinString: z.string().optional().describe(
    "String to join entries in text-based log file. Only valid for text output. " +
    "Supports escape sequences: \\n (newline), \\t (tab), \\r (carriage return). " +
    "Defaults to '\\n---\\n' for visual separation."
  ),
})
.superRefine((data, ctx) => {
  // ... existing superRefine validations ...

  // Validate joinString only for text output
  if (data.joinString && data.structuredOutput) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "joinString is only valid for text output, not structured output",
      path: ['joinString']
    });
  }
});
```

#### 1.2 Update ChroniclerConfig Type Export

**File**: `server/types/chronicler-types.ts`

The type is automatically inferred from the schema, so just verify:

```typescript
// Should now include:
// joinString?: string;
```

### Phase 2: Output Path Types (For Testing)

**File**: `server/types/chronicler-types.ts` or create new file

```typescript
/**
 * Output paths configuration passed from phase to chronicler.
 * This will eventually live in phase configuration, but for now
 * we pass it as a parameter to ChroniclerManager for testing.
 */
export interface ChroniclerOutputPaths {
  /** Path to append-only log file. Path convention:
   * - Filename only (e.g., "output.md") → .tadpole/chronicler-outputs/{id}/
   * - Path with slash (e.g., "data/output.md") → execution-dir relative
   * Auto-generated if omitted: .tadpole/chronicler-outputs/{id}/{id}-{phase}-{timestamp}.md
   */
  logFile?: string;

  /** Path to last-value-only file. Same path convention. Truly optional. */
  lastValueFile?: string;
}
```

### Phase 3: Chronicler Constructor Updates

#### 3.1 Update Chronicler Constructor Signature

**File**: `server/chroniclers/chronicler.ts`

```typescript
export class Chronicler {
  private readonly outputPaths: {
    continuousLog: string;            // Always present (auto-gen if needed)
    currentValue: string | undefined; // Optional
    joinString: string;               // Processed escape sequences
  };

  constructor(
    private config: ChroniclerConfig,
    private phaseId: PhaseId,
    private llmCall: (...) => Promise<...>,
    private logger?: Logger,
    chroniclerDir?: string,
    configDirectory?: string,
    runStartTime?: Date,
    private onExecute?: (...) => void,
    modelCost?: { input: number; output: number },
    private llmObjectCall?: (...) => Promise<...>,
    private executionPath?: string,      // For path resolution
    outputPaths?: ChroniclerOutputPaths, // NEW: from phase config
  ) {
    // ... existing initialization ...

    // Initialize output files (ALWAYS - auto-gen if needed)
    this.outputPaths = this.initializeOutputFiles(
      outputPaths,
      executionPath
    );
  }
```

#### 3.2 Implement Path Resolution Methods

**File**: `server/chroniclers/chronicler.ts`

```typescript
/**
 * Initialize output file paths and create necessary directories.
 * Auto-generates logFile if not provided.
 *
 * @param outputPaths - Optional paths from phase config
 * @param executionPath - Execution directory for path resolution
 * @returns Resolved absolute paths and processed joinString
 * @throws ChroniclerFatalError if validation or creation fails
 */
private initializeOutputFiles(
  outputPaths: ChroniclerOutputPaths | undefined,
  executionPath?: string
): {
  continuousLog: string;
  currentValue: string | undefined;
  joinString: string;
} {
  if (!executionPath) {
    throw new ChroniclerFatalError(
      this.config.id,
      "Output files require execution path",
      "configuration",
      true
    );
  }

  // Determine logFile path (auto-generate if needed)
  let logFilePath: string;

  if (!outputPaths?.logFile) {
    // Auto-generate
    logFilePath = this.generateLogFilePath(executionPath);
    this.logger?.log(
      `[Chronicler:${this.config.id}] Auto-generated logFile: ${path.relative(executionPath, logFilePath)}`,
      "info"
    );
  } else {
    // User-provided - apply path convention
    logFilePath = this.resolveOutputPath(outputPaths.logFile, executionPath);
  }

  // Resolve lastValueFile if provided
  const lastValuePath = outputPaths?.lastValueFile
    ? this.resolveOutputPath(outputPaths.lastValueFile, executionPath)
    : undefined;

  // Validate paths stay within execution directory
  this.validatePathSafety(logFilePath, executionPath);
  if (lastValuePath) {
    this.validatePathSafety(lastValuePath, executionPath);
  }

  // Validate extensions for structured output
  if (this.config.structuredOutput) {
    if (!logFilePath.endsWith('.ndjson') && !logFilePath.endsWith('.jsonl')) {
      throw new ChroniclerFatalError(
        this.config.id,
        `Structured output logFile must use .ndjson or .jsonl extension: ${logFilePath}`,
        "configuration",
        true
      );
    }
    if (lastValuePath && !lastValuePath.endsWith('.json')) {
      throw new ChroniclerFatalError(
        this.config.id,
        `Structured output lastValueFile must use .json extension: ${lastValuePath}`,
        "configuration",
        true
      );
    }
  }

  // Create directories and files
  const paths = [logFilePath, lastValuePath].filter(Boolean) as string[];
  for (const filePath of paths) {
    // Create parent directory
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (error) {
      throw new ChroniclerFatalError(
        this.config.id,
        `Failed to create directory for ${filePath}: ${error}`,
        "configuration",
        true
      );
    }

    // Create empty file if doesn't exist (idempotent)
    try {
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '');
      }
    } catch (error) {
      throw new ChroniclerFatalError(
        this.config.id,
        `Failed to create file ${filePath}: ${error}`,
        "configuration",
        true
      );
    }

    // Verify write permissions
    try {
      fs.accessSync(filePath, fs.constants.W_OK);
    } catch (error) {
      throw new ChroniclerFatalError(
        this.config.id,
        `Output file not writable: ${filePath}`,
        "configuration",
        true
      );
    }
  }

  this.logger?.log(
    `[Chronicler:${this.config.id}] Output files initialized:` +
    `\n  Log: ${path.relative(executionPath, logFilePath)}` +
    (lastValuePath ? `\n  LastValue: ${path.relative(executionPath, lastValuePath)}` : ''),
    "info"
  );

  // Process escape sequences in joinString
  const rawJoinString = this.config.joinString || '\n---\n';
  const processedJoinString = this.processEscapeSequences(rawJoinString);

  return {
    continuousLog: logFilePath,
    currentValue: lastValuePath,
    joinString: processedJoinString,
  };
}

/**
 * Generate auto path for logFile.
 * Format: .tadpole/chronicler-outputs/{id}/{id}-{phase}-{timestamp}.{ext}
 */
private generateLogFilePath(executionPath: string): string {
  const timestamp = Date.now();
  const extension = this.config.structuredOutput ? 'ndjson' : 'md';
  const filename = `${this.config.id}-${this.phaseId}-${timestamp}.${extension}`;

  return path.join(
    executionPath,
    '.tadpole',
    'chronicler-outputs',
    this.config.id,
    filename
  );
}

/**
 * Resolve output path according to path convention.
 * - Filename only (no '/'): .tadpole/chronicler-outputs/{id}/{filename}
 * - Path with '/': execution-dir relative
 */
private resolveOutputPath(userPath: string, executionPath: string): string {
  if (userPath.includes('/')) {
    // Path with directory - use relative to execution dir
    return path.join(executionPath, userPath);
  } else {
    // Filename only - goes to .tadpole/chronicler-outputs/{id}/
    return path.join(
      executionPath,
      '.tadpole',
      'chronicler-outputs',
      this.config.id,
      userPath
    );
  }
}

/**
 * Validate that resolved path stays within execution directory.
 */
private validatePathSafety(filePath: string, executionPath: string): void {
  const resolved = path.resolve(filePath);
  const execResolved = path.resolve(executionPath);

  if (!resolved.startsWith(execResolved)) {
    throw new ChroniclerFatalError(
      this.config.id,
      `Output path escapes execution directory: ${filePath}`,
      "configuration",
      true
    );
  }
}

/**
 * Process escape sequences in joinString.
 * Supports: \n (newline), \t (tab), \r (carriage return), \\ (backslash)
 */
private processEscapeSequences(str: string): string {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
}
```

### Phase 4: File Writing

#### 4.1 Write Methods

**File**: `server/chroniclers/chronicler.ts`

```typescript
/**
 * Write LLM output to files.
 * Called after successful text or structured generation.
 */
private writeOutputFiles(output: string | object): void {
  if (!this.outputPaths) return;

  const isStructured = typeof output === 'object';

  try {
    if (isStructured) {
      // Structured output
      const jsonLine = JSON.stringify(output);
      const jsonPretty = JSON.stringify(output, null, 2);

      // Append to logFile (NDJSON - one object per line)
      fs.appendFileSync(this.outputPaths.continuousLog, jsonLine + '\n');

      // Replace lastValueFile if configured (pretty JSON)
      if (this.outputPaths.currentValue) {
        this.writeAtomic(this.outputPaths.currentValue, jsonPretty);
      }

      this.logger?.log(
        `[Chronicler:${this.config.id}] Wrote structured output`,
        "debug"
      );
    } else {
      // Text output
      const text = output as string;

      // Append to logFile with processed joinString
      fs.appendFileSync(
        this.outputPaths.continuousLog,
        this.outputPaths.joinString + text + '\n'
      );

      // Replace lastValueFile if configured (no joinString)
      if (this.outputPaths.currentValue) {
        this.writeAtomic(this.outputPaths.currentValue, text);
      }

      this.logger?.log(
        `[Chronicler:${this.config.id}] Wrote text output (${text.length} chars)`,
        "debug"
      );
    }
  } catch (error) {
    // Don't throw - log error but continue execution
    this.logger?.log(
      `[Chronicler:${this.config.id}] Failed to write output files: ${error}`,
      "error"
    );
  }
}

/**
 * Atomic write for lastValueFile.
 * Writes to temp file first, then renames to avoid partial writes.
 */
private writeAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}
```

#### 4.2 Integration Points

**File**: `server/chroniclers/chronicler.ts`

In both `executeTextGeneration()` and `executeStructuredOutput()`:

- After successful LLM call
- After adding to history (if conversational)
- Call `this.writeOutputFiles(response.text)` or `this.writeOutputFiles(response.object)`

### Phase 5: ChroniclerManager Updates

#### 5.1 Update Constructor Call

**File**: `server/chroniclers/chronicler-manager.ts`

```typescript
// In loadChroniclersForPhase method
const chronicler = new Chronicler(
  config,                    // Chronicler definition (with joinString)
  this.phaseId,
  this.llmCall,
  this.logger,
  this.chroniclerDir,
  this.configDirectory,
  this.runStartTime,
  undefined,                 // onExecute callback
  modelCost,
  this.llmObjectCall,
  this.executionPath,        // For path resolution
  undefined,                 // TODO: outputPaths from phase config (for now undefined = auto-gen)
);
```

**Note**: For initial implementation, we pass `undefined` for outputPaths to test auto-generation. Once phase integration is ready, this will come from phase config.

## Testing

### Unit Tests

**File**: `tests/unit/chronicler-output-files.test.ts`

```typescript
describe("Chronicler Output Files", () => {
  describe("Path Convention", () => {
    test("filename-only resolves to .tadpole/chronicler-outputs/{id}/", () => {});
    test("path-with-slash resolves to execution-dir relative", () => {});
  });

  describe("Auto-Generation", () => {
    test("auto-generates logFile when no outputPaths provided", () => {});
    test("auto-generates logFile when only lastValueFile provided", () => {});
    test("uses .md extension for text chroniclers", () => {});
    test("uses .ndjson extension for structured chroniclers", () => {});
  });

  describe("Path Validation", () => {
    test("rejects absolute paths", () => {});
    test("rejects paths escaping execution directory", () => {});
    test("enforces .ndjson/.json for structured output", () => {});
  });

  describe("Escape Sequences", () => {
    test("processes \\n to newline", () => {});
    test("processes \\t to tab", () => {});
    test("processes \\r to carriage return", () => {});
    test("processes \\\\ to backslash", () => {});
  });

  describe("File Writing", () => {
    test("appends to logFile with joinString", () => {});
    test("replaces lastValueFile atomically", () => {});
    test("handles missing lastValueFile gracefully", () => {});
  });

  describe("File Reuse", () => {
    test("appends to existing logFile across phases", () => {});
    test("replaces existing lastValueFile", () => {});
  });
});
```

### Integration Tests

**File**: `tests/integration/chronicler-output-files.test.ts`

```typescript
describe("Chronicler Output Files Integration", () => {
  test("auto-generation creates expected files", async () => {});
  test("path convention works for workspace access", async () => {});
  test("cross-phase file reuse accumulates correctly", async () => {});
  test("escape sequences render correctly in output", async () => {});
});
```

### E2E Test

**File**: `tests/e2e/chronicler-output-files-e2e.test.ts`

```typescript
describe("Chronicler Output Files E2E", () => {
  test("complete workflow with auto-generated files", async () => {});
  test("complete workflow with explicit paths", async () => {});
});
```

## Implementation Checklist

- [ ] **Phase 1: Chronicler Config**
    - [ ] Add `joinString` field to chronicler schema
    - [ ] Add validation for joinString vs structuredOutput
    - [ ] Verify type exports include joinString
- [ ] **Phase 2: Output Path Types**
    - [ ] Create `ChroniclerOutputPaths` interface
    - [ ] Document path convention in type comments
    - [ ] Add to type exports
- [ ] **Phase 3: Path Resolution**
    - [ ] Add `outputPaths` field to Chronicler class
    - [ ] Update constructor signature to accept `outputPaths` parameter
    - [ ] Implement `generateLogFilePath()` method
    - [ ] Implement `resolveOutputPath()` method (path convention)
    - [ ] Implement `validatePathSafety()` method
    - [ ] Implement `processEscapeSequences()` method
    - [ ] Update `initializeOutputFiles()` method
- [ ] **Phase 4: File Writing**
    - [ ] Implement `writeOutputFiles()` method
    - [ ] Implement `writeAtomic()` helper
    - [ ] Integrate into `executeTextGeneration()`
    - [ ] Integrate into `executeStructuredOutput()`
    - [ ] Add error handling
- [ ] **Phase 5: Testing**
    - [ ] Unit tests for path convention
    - [ ] Unit tests for auto-generation
    - [ ] Unit tests for escape sequences
    - [ ] Integration tests for file reuse
    - [ ] E2E tests with real LLM calls
- [ ] **Phase 6: Documentation**
    - [ ] Update chronicler-system.md
    - [ ] Add path convention examples
    - [ ] Document file reuse behavior

## Edge Cases & Behaviors

### 1. File Already Exists (Resumption)

**Behavior**: Continue using existing files.

- logFile: Append new entries
- lastValueFile: Replace with new values

**Use Case**: Phase restarts, chronicler resumes logging

### 2. Same Filename Across Phases

**Behavior**: Cross-phase accumulation.

- logFile: Appends to same file (builds narrative)
- lastValueFile: Replaces (shows latest phase state)

**Use Case**: Multi-phase workflows tracking progress

### 3. Disk Full

**Behavior**: Log error, continue execution.

**Rationale**: Chronicler failures never block main workflow.

### 4. Invalid Extensions (Auto-Generated)

**Behavior**: Always use correct extension.

- Text: `.md`
- Structured: `.ndjson`

**Guarantee**: Auto-generated paths always valid.

### 5. Escape Sequence Edge Cases

```typescript
"\\n"     → newline
"\\\\n"   → literal \n
"\\t\\n"  → tab + newline
```

## Success Criteria

1. ✅ logFile ALWAYS created (auto-generated or explicit)
2. ✅ Path convention works intuitively (filename vs path)
3. ✅ File reuse enables cross-phase chronicler narratives
4. ✅ Escape sequences render correctly
5. ✅ Invalid configs caught at load time
6. ✅ Write failures don't crash chroniclers
7. ✅ All tests passing with >90% coverage