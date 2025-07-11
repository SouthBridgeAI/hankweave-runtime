# Checkpoint Pattern Accumulation for Resume Support

## Summary

Modified the checkpoint system to accumulate tracked file patterns from all phases up to and including the current phase. This ensures proper file tracking when resuming from a middle phase.

## Changes Made

### 1. Modified `langton-server.ts`

- Changed checkpoint pattern initialization in `startPhase()` method
- Instead of just adding current phase patterns: `await this.addCheckpointPatterns(phase.trackedFiles)`
- Now accumulates from all phases up to current:
  ```typescript
  const currentPhaseIndex = this.config.phases.findIndex(
    (p) => p.id === phase.id
  );
  if (currentPhaseIndex >= 0) {
    // Accumulate patterns from all phases up to and including current
    for (let i = 0; i <= currentPhaseIndex; i++) {
      const phaseConfig = this.config.phases[i];
      if (phaseConfig.trackedFiles && phaseConfig.trackedFiles.length > 0) {
        await this.addCheckpointPatterns(phaseConfig.trackedFiles);
      }
    }
  }
  ```

### 2. Added `clearPatterns()` to `checkpoint-git.ts`

- Added method to clear all tracked patterns
- Not strictly necessary since CheckpointGit is created fresh each run
- Provides clean API for potential future use cases

## Benefits

1. **Resume Support**: When implementing resume functionality, the checkpoint system will correctly track all files from previous phases
2. **Complete History**: Git commits will include all relevant files, not just current phase files
3. **Consistency**: Whether running from start or resuming, checkpoint state matches

## Example Behavior

Given phases with tracked files:

- Phase 1: `["*.md"]`
- Phase 2: `["*.ts"]`
- Phase 3: `["*.json"]`

When starting/resuming from:

- **Phase 1**: Checkpoints track `*.md`
- **Phase 2**: Checkpoints track `*.md` + `*.ts`
- **Phase 3**: Checkpoints track `*.md` + `*.ts` + `*.json`

## Testing

- All 351 unit tests pass
- TypeScript compilation successful
- Linting clean
