# Terminal Phases Problem Analysis

## Overview

After removing the "completing" state from the Langton system, we discovered that phases that complete successfully are being incorrectly marked as "skipped" instead of "completed". This is causing the rollback functionality to fail because it cannot find any successfully completed phases to rollback to.

## Expected Behavior for Terminal States

The user provided the following logic for how terminal states should be determined:

1. **Skipped**: Should only happen because of an incoming message or command asking for a skip, and even then only if the server process exits and there's no result message.

2. **Completed**: Should happen if the server process exits and there's a result message.

3. **Failed**: Should happen if the server process exits (but it's not due to a skip) and there's no result message.

Exit codes can also be taken into consideration as additional context.

## Current Problem

### Test Case Analysis

From the rollback E2E test (`tests/e2e/rollback-e2e.test.ts`), we can see:

**Test Output:**

```
✓ Phase 2 completed
✓ Phase 3 completed

✓ Found 4 checkpoints
  [1] Phase 1: TestPhase1 - skipped (df7ba18)
  [2] Phase 2: Schema Generation - skipped (e31555b)  ❌ Should be "completed"
  [3] Phase 2a: More Validation - workspace-setup (915684a)
  [4] Phase 2a: More Validation - skipped (c385834)  ❌ Should be "completed"

Expected: "phase-3"
Received: "phase-1"
```

### State Analysis

Looking at `tests/test-area/rollback/.langton/state.json`:

```json
{
  "phases": [
    {
      "phaseId": "phase-1",
      "status": "skipped", // ✓ Correct - was explicitly skipped by test
      "skippedDuring": "running"
    },
    {
      "phaseId": "phase-2",
      "status": "skipped", // ❌ Wrong - should be "completed"
      "skippedDuring": "running"
    },
    {
      "phaseId": "phase-3",
      "status": "skipped", // ❌ Wrong - should be "completed"
      "skippedDuring": "running"
    },
    {
      "phaseId": "phase-3", // Second execution for rollback test
      "status": "failed", // ✓ Correct - was force stopped
      "failureReason": {
        "message": "Force stopped: user request"
      }
    }
  ]
}
```

### Log Evidence

**Server Logs** (`tests/test-area/rollback/.langton/logs/server.log`):

- Phase 2: `Phase phase-2 completed successfully` + `Phase phase-2 result message received: success`
- Phase 3: `Phase phase-3 completed successfully` + `Phase phase-3 result message received: success`

**Claude Logs** (`phase-phase-2-claude.log`):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "...",
  "total_cost_usd": 0.0040881
}
```

**Evidence Summary:**

- ✅ Exit code 0 (success)
- ✅ Result message received with `"subtype":"success"`
- ✅ Server logs show "completed successfully"
- ❌ State shows "skipped"

## Root Cause Analysis

### The `isSkippingPhase` Flag Issue

The problem appears to be in the `handlePhaseComplete` method in `server/langton-server.ts`. The logic uses a `wasSkipped` variable based on `this.isSkippingPhase`:

```typescript
const wasSkipped = this.isSkippingPhase;

let finalStatus: PhaseStatus;
if (wasSkipped) {
  finalStatus = "skipped";
} else if (this.isForceStopping) {
  finalStatus = "failed";
} else if (exitCode === 0) {
  finalStatus = "completed"; // This should be reached but isn't
} else {
  finalStatus = "failed";
}
```

### Key Issues Identified

1. **Flag Not Reset**: `this.isSkippingPhase` is set to `true` when phase-1 is skipped, but it's never reset to `false` after the phase completes. This causes all subsequent phases to be considered "skipped".

2. **Incorrect Logic Flow**: The current logic checks `wasSkipped` first, which overrides the exit code and result message logic.

3. **Missing Result Message Logic**: The expected behavior states that phases should be "completed" if there's a result message, but this logic is not properly implemented after removing the "completing" state.

## Detailed Investigation

### Phase Execution Timeline

1. **Phase 1**:

   - Started normally
   - Test calls `phase.skip` command
   - `this.isSkippingPhase = true` is set
   - Process exits, marked as "skipped" ✓

2. **Phase 2**:

   - Started normally (no skip command)
   - `this.isSkippingPhase` is still `true` from phase 1 ❌
   - Process exits with code 0, result message received
   - Should be "completed" but marked as "skipped" due to stale flag

3. **Phase 3**:
   - Same issue as phase 2
   - `this.isSkippingPhase` still `true`
   - Process exits with code 0, result message received
   - Should be "completed" but marked as "skipped"

### Checkpoint Creation Impact

The incorrect status affects checkpoint creation:

```typescript
const checkpointType =
  finalStatus === "completed"
    ? "completed"
    : finalStatus === "skipped"
    ? "skipped" // This is being used incorrectly
    : "error";
```

This creates "skipped" checkpoints instead of "completed" ones.

### Rollback Impact

The `rollbackToLastSuccess` method looks for phases with `status === "completed"`:

```typescript
for (let i = currentRun.phases.length - 1; i >= 0; i--) {
  if (currentRun.phases[i].status === "completed") {
    lastCompleted = currentRun.phases[i];
    break;
  }
}
```

Since no phases are marked as "completed", it falls back to rolling back to the first checkpoint (phase-1).

## Required Fixes

### 1. Reset Skip Flag

The `isSkippingPhase` flag must be reset after each phase completion:

```typescript
private cleanupCurrentPhase(): void {
  // ... existing cleanup ...
  this.isSkippingPhase = false;  // Add this line
}
```

### 2. Implement Proper Result Message Logic

The logic should prioritize result messages over the skip flag:

```typescript
// Determine final status based on actual outcome
let finalStatus: PhaseStatus;
if (this.isForceStopping) {
  finalStatus = "failed";
} else if (exitCode === 0 && hasResultMessage) {
  finalStatus = "completed"; // Result message takes precedence
} else if (wasSkipped && !hasResultMessage) {
  finalStatus = "skipped"; // Only skip if explicitly requested AND no result
} else if (exitCode !== 0) {
  finalStatus = "failed";
} else {
  finalStatus = "failed"; // Default for unclear cases
}
```

### 3. Track Result Messages

Since we removed the "completing" state, we need to track whether a result message was received during the phase execution. This could be done by:

- Adding a flag in the phase state
- Checking the log parser for result messages
- Using the existing `handleResultMessage` method to set a flag

## Impact Assessment

### Current Impact

- Rollback functionality completely broken
- All successful phases appear as "skipped" in state
- Checkpoint system creates wrong checkpoint types
- Tests failing with incorrect expectations

### Risk Level

**HIGH** - Core functionality is broken and affects the primary rollback feature.

## Next Steps

1. Implement the flag reset fix
2. Add proper result message tracking
3. Update the final status determination logic
4. Test with the rollback E2E test
5. Verify other tests still pass

The fix should be straightforward once the root cause (stale `isSkippingPhase` flag) is addressed.
