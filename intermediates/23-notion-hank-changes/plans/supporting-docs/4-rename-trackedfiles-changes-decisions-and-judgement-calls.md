# ENG-92: Rename trackedFiles - Changes and Decisions

## Step 2 Agent Analysis

This is a terminology change to better communicate the field's purpose. Users see "trackedFiles" and think file watching, but the real purpose is checkpointing.

## Decision 1: Full Rename Strategy

**Recommended name**: `checkpointedFiles`

**Reasoning**: More accurate than "tracked" - these files go into Git checkpoints.

**Alternative considered**: `checkpointFiles`
- Rejected: Could be confused with "files that ARE checkpoints" vs "files TO checkpoint"

## Decision 2: Backward Compatibility

**Recommendation**: Support BOTH names during deprecation period.

**Implementation**:
```typescript
// In schema (config.ts):
const codonObjectSchema = z.object({
  // ... other fields ...
  checkpointedFiles: z.array(z.string()).optional(),
  trackedFiles: z.array(z.string()).optional(),  // DEPRECATED
})
.refine(data => {
  if (data.trackedFiles && !data.checkpointedFiles) {
    // Auto-migrate: copy trackedFiles to checkpointedFiles
    data.checkpointedFiles = data.trackedFiles;
  }
  return true;
})
.refine(data => {
  if (data.trackedFiles && data.checkpointedFiles) {
    // Error if both specified
    throw new Error("Cannot specify both trackedFiles (deprecated) and checkpointedFiles");
  }
  return true;
});
```

**Deprecation warning**:
```typescript
if (codon.trackedFiles) {
  console.warn(`⚠️  Codon "${codon.name}": "trackedFiles" is deprecated. Use "checkpointedFiles" instead.`);
}
```

## Decision 3: Migration Timeline

**Phase 1 (v0.X)**: Support both, warn on old name
**Phase 2 (v0.X+1)**: Support both, louder warning
**Phase 3 (v0.X+2)**: Remove old name (breaking change)

## Complexity Assessment

**Implementation**: Low (find-and-replace + deprecation logic)
- Schema updates: ~20 lines
- Runtime updates: ~30 lines
- Deprecation warnings: ~10 lines
- Documentation updates: ~1 hour
- Tests: Update existing tests + add deprecation tests

**Total**: 4-6 hours

## Step 2 Agent Recommendation

Do this rename with deprecation period. It's a quality-of-life improvement that will reduce user confusion.

**Important**: Update schema description to emphasize checkpoint role, not just watching:
```
"Glob patterns for files to checkpoint. These files will be saved in Git checkpoints
after each codon completes, enabling rollback to previous states. Files are also
watched for changes and resolved using gitignore rules."
```
