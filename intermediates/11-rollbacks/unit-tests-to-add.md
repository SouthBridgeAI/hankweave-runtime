# Unit Tests to Add for Rollback System

Based on our debugging session and analysis of the rollback system logs, here are the critical unit tests we should add to prevent regressions and catch edge cases.

## 1. Checkpoint File Resolution Tests

### Why These Are Critical

From the logs, we saw that file resolution is complex:

- Phase 1: 0 files (no poems created yet)
- Phase 2: 2 files (both poem files created)
- Phase 3: 5 files (poems + TypeScript files)
- Git staging logic only stages new/changed files

### Tests to Add

#### `tests/unit/checkpoint-file-resolution.test.ts`

```typescript
describe("Checkpoint File Resolution", () => {
  test("should find no files when patterns match nothing", () => {
    // Test empty directory with patterns
  });

  test("should find files matching accumulated patterns", () => {
    // Test that patterns from multiple phases accumulate correctly
  });

  test("should respect gitignore rules", () => {
    // Test that .langton/* files are excluded
    // Test that typescript_code/.gitignore is respected
  });

  test("should handle pattern overlaps correctly", () => {
    // Test when multiple patterns match the same files
  });

  test("should only stage new/changed files", () => {
    // Test that files already in git aren't re-staged
  });
});
```

## 2. Git State Management Tests

### Why These Are Critical

The logs showed complex git staging behavior:

- Files already committed aren't re-staged
- Empty commits work for skipped phases
- Branch switching works correctly

### Tests to Add

#### `tests/unit/checkpoint-git-staging.test.ts`

```typescript
describe("Checkpoint Git Staging", () => {
  test("should create empty commit for skipped phases", () => {
    // Test allowEmpty: true behavior
  });

  test("should not re-stage unchanged files", () => {
    // Test that files in previous commits aren't re-added
  });

  test("should handle git status correctly", () => {
    // Test parsing of staged/modified/not_added files
  });

  test("should switch branches correctly", () => {
    // Test branch creation and switching
  });

  test("should handle git reset operations", () => {
    // Test hard reset to specific SHA
  });
});
```

## 3. Rollback State Consistency Tests

### Why These Are Critical

Rollback creates complex state transitions:

- Ends current run
- Creates continuation run
- Restores checkpoint patterns
- Maintains state consistency

### Tests to Add

#### `tests/unit/rollback-state-consistency.test.ts`

```typescript
describe("Rollback State Consistency", () => {
  test("should create proper continuation run", () => {
    // Test that new run has correct startingConditions
  });

  test("should restore checkpoint patterns correctly", () => {
    // Test that patterns are restored up to rollback point
  });

  test("should maintain state consistency across rollback", () => {
    // Test that state.json is valid after rollback
  });

  test("should handle rollback to different checkpoint types", () => {
    // Test rollback to workspace-setup vs completed vs skipped
  });

  test("should preserve cost tracking across rollback", () => {
    // Test that costs are correctly calculated after rollback
  });
});
```

## 4. Rollback Command Validation Tests

### Why These Are Critical

From our debugging, we found several edge cases in command validation:

- Preventing rollback while phase is running
- Handling missing checkpoints
- Validating checkpoint aliases

### Tests to Add

#### `tests/unit/rollback-command-validation.test.ts`

```typescript
describe("Rollback Command Validation", () => {
  test("should prevent rollback while phase is running", () => {
    // Test error when trying to rollback during active phase
  });

  test("should handle missing checkpoint SHA", () => {
    // Test error when SHA doesn't exist
  });

  test("should resolve checkpoint aliases correctly", () => {
    // Test "start" and "end" aliases
  });

  test("should handle rollback to last success with no successful phases", () => {
    // Test fallback to first checkpoint
  });

  test("should validate phase exists before rollback", () => {
    // Test error when phase doesn't exist in run
  });
});
```

## 5. Force Stop Integration Tests

### Why These Are Critical

Force stop has complex interactions with state management:

- Immediate state transition
- Process cleanup
- Checkpoint creation for failed state

### Tests to Add

#### `tests/unit/force-stop-integration.test.ts`

```typescript
describe("Force Stop Integration", () => {
  test("should transition state immediately on force stop", () => {
    // Test that state changes before process exits
  });

  test("should create checkpoint for force-stopped phase", () => {
    // Test that failed checkpoint is created
  });

  test("should clean up process resources", () => {
    // Test that process is properly killed
  });

  test("should allow rollback after force stop", () => {
    // Test that rollback works after force stop
  });
});
```

## 6. Checkpoint Pattern Accumulation Tests

### Why These Are Critical

From the logs, we saw that patterns accumulate across phases:

- Phase 1: `notes/**/*, *.md`
- Phase 2: `notes/**/*, *.md, notes/**/*`
- Phase 3: `notes/**/*, *.md, notes/**/*, typescript_code/src/**/*.ts, typescript_code/package.json`

### Tests to Add

#### `tests/unit/checkpoint-pattern-accumulation.test.ts`

```typescript
describe("Checkpoint Pattern Accumulation", () => {
  test("should accumulate patterns across phases", () => {
    // Test that patterns from previous phases are preserved
  });

  test("should restore patterns correctly after rollback", () => {
    // Test that rollback restores correct pattern set
  });

  test("should handle duplicate patterns", () => {
    // Test that duplicate patterns don't cause issues
  });

  test("should clear patterns on fresh run", () => {
    // Test that new runs start with clean pattern set
  });
});
```

## 7. Autostart Behavior Tests

### Why These Are Critical

The `--no-autostart` flag changes server behavior significantly:

- Server idle events instead of auto-progression
- Manual phase control
- Different shutdown behavior

### Tests to Add

#### `tests/unit/autostart-behavior.test.ts`

```typescript
describe("Autostart Behavior", () => {
  test("should emit server.idle events when autostart disabled", () => {
    // Test idle events on startup, phase completion
  });

  test("should auto-progress when autostart enabled", () => {
    // Test default behavior
  });

  test("should not shutdown after last phase when autostart disabled", () => {
    // Test that server stays running
  });

  test("should handle phase completion differently based on autostart", () => {
    // Test different behaviors
  });
});
```

## 8. Error Recovery Tests

### Why These Are Critical

Our debugging revealed several error scenarios that need proper handling:

- Timeout waiting for events
- Git operation failures
- State corruption scenarios

### Tests to Add

#### `tests/unit/rollback-error-recovery.test.ts`

```typescript
describe("Rollback Error Recovery", () => {
  test("should handle git reset failures gracefully", () => {
    // Test when git reset fails
  });

  test("should handle missing checkpoint repository", () => {
    // Test when .langton/checkpoints doesn't exist
  });

  test("should handle corrupted checkpoint state", () => {
    // Test when checkpoint SHA is invalid
  });

  test("should timeout gracefully on event waits", () => {
    // Test timeout scenarios like we saw in original failure
  });
});
```

## 9. Event System Integration Tests

### Why These Are Critical

The rollback system relies heavily on the event system:

- `rollback.completed` events
- `server.idle` events
- Event ordering and timing

### Tests to Add

#### `tests/unit/rollback-event-integration.test.ts`

```typescript
describe("Rollback Event Integration", () => {
  test("should emit rollback.completed event with correct data", () => {
    // Test event structure and timing
  });

  test("should emit events in correct order during rollback", () => {
    // Test event sequence
  });

  test("should handle event listener failures gracefully", () => {
    // Test when event handlers throw
  });

  test("should not emit events for failed rollbacks", () => {
    // Test that failed rollbacks don't emit completion events
  });
});
```

## 10. State Manager Integration Tests

### Why These Are Critical

Rollback involves complex state manager interactions:

- Multiple rapid transitions
- State validation
- Cost cache updates

### Tests to Add

#### `tests/unit/rollback-state-manager-integration.test.ts`

```typescript
describe("Rollback State Manager Integration", () => {
  test("should handle rapid state transitions during rollback", () => {
    // Test that queue processing works correctly
  });

  test("should update cost cache correctly after rollback", () => {
    // Test that costs are recalculated
  });

  test("should validate state consistency after rollback", () => {
    // Test that state validation passes
  });

  test("should handle concurrent rollback attempts", () => {
    // Test that multiple rollback commands are handled safely
  });
});
```

## Implementation Priority

1. **High Priority** (implement first):

   - Rollback command validation tests
   - Force stop integration tests
   - Rollback state consistency tests

2. **Medium Priority**:

   - Checkpoint file resolution tests
   - Git state management tests
   - Event system integration tests

3. **Lower Priority** (nice to have):
   - Autostart behavior tests
   - Error recovery tests
   - State manager integration tests

## Testing Strategy

- Use the existing test infrastructure (`TestWSClient`, `setupTestDirectory`)
- Mock git operations where appropriate to test error scenarios
- Use real git operations for integration tests
- Focus on edge cases that could cause silent failures
- Test both success and failure paths for each operation

## Notes

- Many of these tests will help catch regressions as we continue to evolve the rollback system
- The file resolution tests are particularly important since that logic is complex and easy to break
- Event system tests will help ensure the UI gets proper feedback during rollback operations
- Error recovery tests will help make the system more robust in production
