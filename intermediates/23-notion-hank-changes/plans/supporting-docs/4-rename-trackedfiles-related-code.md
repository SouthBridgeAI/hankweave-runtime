# ENG-92: Rename trackedFiles to checkpointedFiles - Related Code

## Current Usage

**`trackedFiles` appears in 6 files**:
- server/config.ts (schema definitions, validation)
- server/hankweave-runtime.ts (main usage for watching and checkpoints)
- server/checkpoint-git.ts (file resolution for git operations)
- server/types/types.ts (TypeScript type definitions)
- server/file-resolver.ts (gitignore-aware resolution)

## Schema Definition (`server/config.ts`)

**Lines 295-300:**
```typescript
trackedFiles: z
  .array(z.string())
  .optional()
  .describe(
    "Glob patterns for files to track during codon execution. These files will be: watched for changes and streamed to the client, tracked in the git-based checkpoint system, and resolved using gitignore rules for consistency.",
  ),
```

**Lines 1469-1473, 1522-1524: Usage in validation**
```typescript
if (codon.trackedFiles && codon.trackedFiles.length > 0) {
  result.trackingCodonCount++;
  result.checkpointCodonCount++;
}
```

## Runtime Usage (`server/hankweave-runtime.ts`)

**Lines 134, 1733-1738: Watching patterns**
```typescript
private watchedPatterns: string[] = [];

if (codon.trackedFiles && codon.trackedFiles.length > 0) {
  this.watchedPatterns = codon.trackedFiles;
  this.logger.log(`Watching patterns: ${this.watchedPatterns.join(", ")}`);
}
```

**Lines 1609-1624: Checkpoint pattern accumulation**
```typescript
const currentCodonIndex = this.config.codons.findIndex((p) => p.id === codon.id);
if (currentCodonIndex >= 0) {
  // Accumulate patterns from all codons up to and including current
  for (let i = 0; i <= currentCodonIndex; i++) {
    const codonConfig = this.config.codons[i];
    if (
      codonConfig.type !== "loop" &&
      codonConfig.trackedFiles &&
      codonConfig.trackedFiles.length > 0
    ) {
      await this.addCheckpointPatterns(codonConfig.trackedFiles);
    }
  }
}
```

**Lines 1742-1792: Initial file state capture**
```typescript
if (codon.trackedFiles && codon.trackedFiles.length > 0) {
  const resolvedFiles = await fileResolver.resolveFiles(
    this.config.executionPath,
    codon.trackedFiles,
  );
  // ... sends file.updated events ...
}
```

## Checkpoint System (`server/checkpoint-git.ts`)

**Line 152: File resolution**
```typescript
const files = await fileResolver.resolveFiles(this.executionPath, patterns);
```

**Note**: Checkpoint system uses patterns from `trackedFiles`, but the field name doesn't appear directly in this file (it receives patterns as function parameter).

## Type Definitions (`server/types/types.ts`)

Need to check TypeScript types - likely defined here.

## Summary

**Rename locations** (must change all):
1. `server/config.ts` line 295: Schema field name + description
2. `server/config.ts` lines 1469, 1522: Validation logic
3. `server/hankweave-runtime.ts` lines 1733, 1619, 1742: Runtime usage
4. TypeScript type definitions (need to check types/types.ts)
5. Documentation in README.md (multiple locations)
6. All test files referencing trackedFiles

**Difficulty**: Low (find-and-replace, but careful about comments and docs)
