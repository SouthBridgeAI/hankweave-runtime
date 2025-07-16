# Remaining Work for State Management Implementation

## Completed ✅

1. **Cost Cache Bug** - Fixed `updateCostCache` to rebuild cache from scratch
2. **previousSessionId Handling** - Removed from PhaseStarted event, stored in phase
3. **checkIncompletePhases** - Removed old log checking logic
4. **ClaudeProcessManager** - Already accepts custom log path
5. **Lock File Updates** - Lock file now includes runId and heartbeat

## Still To Do

### 1. Cleanup Integration Updates

The cleanup system needs to be updated to handle the new run folder structure:

```typescript
// In cleanup-command.ts or manifest-builder.ts
// Add logic to:
// 1. Find all run folders in .langton/runs/
// 2. Remove them during cleanup
// 3. Update cleanup messages to mention run history deletion
```

### 2. Test Updates

Major test files that need updating:

1. **E2E Tests**:

   - `happy-path-e2e.test.ts` - Replace completedPhases array checks with state queries
   - `skip-phase-continue-e2e.test.ts` - Verify skip transitions
   - `server-shutdown-e2e.test.ts` - Test crash detection

2. **Unit Tests**:

   - Create `tests/unit/state-manager.test.ts` (already stubbed)
   - Update `business-logic.test.ts` to use state manager
   - Remove tests for deleted functions like `loadPhaseStateFromLog`

3. **Test Helpers**:
   - Create state inspection helpers
   - Update cleanup integration tests

### 3. Migration Documentation

Create a migration guide for users:

1. **Breaking Changes**:

   - Log files now in `.langton/runs/{runId}/`
   - State persisted in `.langton/state.json`
   - Cleanup command removes all history

2. **New Features**:
   - Full crash recovery
   - Run history tracking
   - Future: Rollback/retry support

### 4. Final Cleanup

1. Remove deprecated code:

   - `loadPhaseStateFromLog` from `claude-log-parser.ts`
   - `extractSessionIdFromLog` from `utils.ts` (if only used for state)

2. Update READMEs:
   - Document new state file structure
   - Update server README with state management details
   - Add troubleshooting section for state corruption

## Testing Strategy

1. **Manual Testing Checklist**:

   - [ ] Server crash recovery
   - [ ] Phase failure handling
   - [ ] Skip functionality
   - [ ] Cost tracking accuracy
   - [ ] Cleanup with multiple runs

2. **Performance Testing**:
   - [ ] State file size with many runs
   - [ ] Transition processing speed
   - [ ] Concurrent state updates

## Known Issues/Limitations

1. **State File Growth**: No archival/pruning of old runs yet
2. **Rollback UI**: State supports rollback but no UI/commands yet
3. **Migration Tool**: No tool to migrate from old log-based state
