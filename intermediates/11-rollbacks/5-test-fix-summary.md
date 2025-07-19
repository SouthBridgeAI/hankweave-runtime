# Rollback Test Fix Summary

## Changes Made

### 1. Fixed `getPreviousSessionId` Logic
**File**: `server/langton-server.ts` (lines 901-910)

Changed the logic to check if a skipped phase has generated output tokens before considering its session ID valid for continuation:

```typescript
// If it was skipped but has a session ID and Claude generated output, we can use it
if (
  lastExecution.status === "skipped" &&
  "claudeSessionId" in lastExecution &&
  lastExecution.claudeSessionId &&
  "partialTokens" in lastExecution &&
  lastExecution.partialTokens.outputTokens > 0
) {
  return lastExecution.claudeSessionId;
}
```

This prevents trying to continue from sessions that were terminated before Claude could establish a meaningful conversation.

### 2. Added Assistant Message Tracking
**File**: `server/langton-server.ts` (lines 1092-1108)

Added tracking of assistant messages to the state:
- Increments `assistantMessageCount` when assistant messages are received
- Uses the new `AssistantMessageCountUpdated` state transition

### 3. Updated Mock Builders
**File**: `tests/utils/mock-builders.ts` (line 87)

Added `assistantMessageCount: 0` to the `createRunningPhase` mock to match the updated state type.

## How the Fix Works

1. When a phase is skipped, it retains its Claude session ID in the state
2. When the next phase checks for a previous session ID to continue from:
   - It first looks for completed phases (these always have valid sessions)
   - For skipped phases, it now checks if Claude generated any output tokens
   - If there are no output tokens, the session is considered invalid for continuation
3. This prevents the "No conversation found with session ID" error

## Alternative Approaches

The state has been prepared to support more sophisticated tracking:
- `assistantMessageCount` field is now tracked for all phases
- Could use this instead of output tokens for more precise detection
- Current approach (output tokens) is simpler and sufficient

## What to Test

Run the tests that were previously failing:

```bash
# Run the specific failing tests
bun test tests/e2e/skip-phase-continue-e2e.test.ts
bun test tests/e2e/rollback-e2e.test.ts

# Or run all tests
bun test
```

Expected behavior:
- Phases that are skipped early (before Claude generates output) won't pass their session IDs to subsequent phases
- This prevents the "No conversation found" error
- Tests should now pass

## Edge Cases Handled

1. **Skip before session established**: Phase starts fresh
2. **Skip after Claude responds**: Session ID could be reused (if we wanted to support this)
3. **Skip during different phase states**: Properly tracks whether meaningful conversation occurred