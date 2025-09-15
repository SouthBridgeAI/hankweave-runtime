# Implementation Plan: Output Files to tadpole-results

## Requirements Analysis

The feature requires implementing file copying capabilities that allow users to:
1. Specify output files to copy at the end of the final phase to `tadpole-results` subdirectory
2. Specify files to copy after each phase completion, accumulating in `tadpole-results`

This involves extending the phases.json configuration format and adding file copying logic to the phase execution engine.

## Current Architecture Analysis

### Phase Configuration Structure
- `phases.json` defines phase configurations with `name`, `prompt`, and `background` properties
- `PhaseConfig` interface in `src/types.ts:12-16` currently supports:
  ```typescript
  export interface PhaseConfig {
    name: string;
    prompt: string;
    background?: string;
  }
  ```

### Phase Execution Flow
- `src/lib/execute-phase.ts` handles phase execution
- `executePhase()` function at line 15 orchestrates the execution
- Uses Claude API to process phases and generates outputs to execution directory
- No current file copying mechanism exists

## Implementation Plan

### 1. Extend PhaseConfig Interface

**File**: `src/types.ts:12-16`

```typescript
export interface PhaseConfig {
  name: string;
  prompt: string;
  background?: string;
  // New properties for output file handling
  outputFiles?: string[]; // Files to copy after this phase
  finalOutputFiles?: string[]; // Files to copy only after final phase
}
```

### 2. Update Phase Schema Validation

**File**: `src/lib/phases.ts` (around line 20-30 where schema validation occurs)

```typescript
// Add to existing Zod schema
const PhaseConfigSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  background: z.string().optional(),
  outputFiles: z.array(z.string()).optional(),
  finalOutputFiles: z.array(z.string()).optional(),
});
```

### 3. Create File Copying Utility

**New file**: `src/lib/copy-output-files.ts`

```typescript
import { promises as fs } from 'fs';
import { join, dirname, basename } from 'path';

export interface CopyFilesOptions {
  sourceDir: string; // tadpole execution directory
  targetDir: string; // user's current working directory + 'tadpole-results'
  files: string[];
  createTargetDir?: boolean;
}

export async function copyOutputFiles(options: CopyFilesOptions): Promise<void> {
  const { sourceDir, targetDir, files, createTargetDir = true } = options;
  
  if (createTargetDir) {
    await fs.mkdir(targetDir, { recursive: true });
  }

  for (const file of files) {
    const sourcePath = join(sourceDir, file);
    const targetPath = join(targetDir, basename(file));
    
    try {
      await fs.copyFile(sourcePath, targetPath);
      console.log(`Copied: ${file} -> tadpole-results/`);
    } catch (error) {
      console.warn(`Failed to copy ${file}:`, error);
    }
  }
}

export async function ensureTadpoleResultsDir(userCwd: string): Promise<string> {
  const resultsDir = join(userCwd, 'tadpole-results');
  await fs.mkdir(resultsDir, { recursive: true });
  return resultsDir;
}
```

### 4. Integrate File Copying into Phase Execution

**File**: `src/lib/execute-phase.ts`

**Location**: After phase completion logic (around line 60-80)

```typescript
import { copyOutputFiles, ensureTadpoleResultsDir } from './copy-output-files';

// Add to executePhase function after successful phase completion
export async function executePhase(
  phaseConfig: PhaseConfig,
  context: ExecutionContext,
  isLastPhase: boolean = false
): Promise<PhaseResult> {
  // ... existing execution logic ...
  
  // After successful phase completion
  if (result.success) {
    const userCwd = process.cwd(); // User's current working directory
    const resultsDir = await ensureTadpoleResultsDir(userCwd);
    
    // Copy phase-specific output files
    if (phaseConfig.outputFiles && phaseConfig.outputFiles.length > 0) {
      await copyOutputFiles({
        sourceDir: context.workingDir, // tadpole execution directory
        targetDir: resultsDir,
        files: phaseConfig.outputFiles,
      });
    }
    
    // Copy final output files only on last phase
    if (isLastPhase && phaseConfig.finalOutputFiles && phaseConfig.finalOutputFiles.length > 0) {
      await copyOutputFiles({
        sourceDir: context.workingDir,
        targetDir: resultsDir,
        files: phaseConfig.finalOutputFiles,
      });
    }
  }
  
  return result;
}
```

### 5. Update Main Execution Loop

**File**: `src/lib/phases.ts` (main execution function)

**Location**: Where phases are executed in sequence

```typescript
// Update to pass isLastPhase flag
export async function executeAllPhases(phases: PhaseConfig[]): Promise<void> {
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const isLastPhase = i === phases.length - 1;
    
    const result = await executePhase(phase, context, isLastPhase);
    
    if (!result.success) {
      throw new Error(`Phase "${phase.name}" failed`);
    }
  }
}
```

### 6. Configuration Examples

**File**: Update documentation or create example `phases.json`

```json
{
  "phases": [
    {
      "name": "analysis",
      "prompt": "Analyze the codebase",
      "outputFiles": ["analysis-report.md", "findings.json"]
    },
    {
      "name": "implementation", 
      "prompt": "Implement the feature",
      "outputFiles": ["implementation-log.md"],
      "finalOutputFiles": ["final-code.zip", "deployment-guide.md"]
    }
  ]
}
```

## Implementation Complexity Considerations

### Path Resolution
- Need to handle relative paths in `outputFiles` arrays
- Should support glob patterns for flexible file selection
- Consider security implications of path traversal

### Error Handling
- Graceful handling when specified files don't exist
- Logging for debugging file copy operations
- Should not fail entire phase if file copy fails

### Performance
- Large files could impact execution time
- Consider async/parallel copying for multiple files
- Memory usage for large file operations

### User Experience
- Clear feedback about what files were copied
- Ability to see what will be copied before execution
- Option to skip file copying if desired

## Testing Requirements

1. Unit tests for `copyOutputFiles` utility
2. Integration tests for phase execution with file copying
3. Test error scenarios (missing files, permission issues)
4. Test path resolution and security boundaries

## Migration Considerations

- Existing `phases.json` files should continue working (backward compatibility)
- New properties are optional, so gradual adoption is possible
- Consider versioning for configuration format

This implementation provides a robust foundation for the output file copying feature while maintaining the existing architecture and allowing for future enhancements.