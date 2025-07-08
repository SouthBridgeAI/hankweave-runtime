# Dual ID System Implementation Plan

## Overview

This document provides a comprehensive plan to implement a dual ID system in Langton Server to separate internal tracking from client-facing session IDs. This addresses the issue where the server generates a temporary timestamp-random ID that is immediately replaced by Claude's UUID, causing confusion and test failures.

## Background

### Current Behavior

1. Server generates a timestamp-random session ID when starting a phase
2. `phase.started` event is sent immediately with this temporary ID
3. Claude provides its own UUID in the init message
4. Server updates the session ID, replacing the temporary one
5. All subsequent events use Claude's UUID

### Problems

1. Tests see 2 different session IDs per phase (confusing)
2. `phase.started` event fires before Claude actually starts
3. If Claude fails before init, we have no proper ID for error handling
4. The temporary ID serves no real purpose but causes complexity

### Solution

Implement a dual ID system:

- **phaseExecutionId**: Internal tracking ID (timestamp-random, never exposed to clients)
- **sessionId**: Claude's UUID (client-facing, starts as null)

## Implementation Steps

### 1. Update CurrentPhase Structure

**File:** `/server/langton-server.ts`

**Current structure (around line 900):**

```typescript
this.currentPhase = {
  phase,
  sessionId, // Currently timestamp-random, then replaced
  isRunning: true,
  startTime: new Date(),
  phaseCost: 0,
  phaseTokens: {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
};
```

**Change to:**

```typescript
this.currentPhase = {
  phase,
  phaseExecutionId: generateId(), // Internal tracking (timestamp-random)
  sessionId: null as string | null, // Claude's UUID (starts null)
  isRunning: true,
  startTime: new Date(),
  phaseCost: 0,
  phaseTokens: {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
};
```

### 2. Update Result Message Promise Management

**Current:** Uses sessionId as key for promises
**Change:** Use phaseExecutionId for internal tracking

**Update `waitForResultMessage` call in `completePhase()`:**

```typescript
// Old:
const resultMsg = await this.waitForResultMessage(
  phaseSnapshot.sessionId,
  TIMEOUTS.RESULT_MESSAGE_MS
);

// New:
const resultMsg = await this.waitForResultMessage(
  phaseSnapshot.phaseExecutionId,
  TIMEOUTS.RESULT_MESSAGE_MS
);
```

**Update `handleResultMessage()` to use phaseExecutionId:**

```typescript
// Find the promise using phaseExecutionId instead
const executionId = this.currentPhase?.phaseExecutionId;
if (executionId) {
  const promise = this.resultMessagePromises.get(executionId);
  // ... rest of handling
}
```

### 3. Delay phase.started Event

**Remove from `startPhase()` method** - Don't send the event immediately after phase initialization.

**Add to `handleSystemMessage()` when init is received:**

```typescript
private handleSystemMessage(msg: SystemMessage, phaseId: string): void {
  if (msg.subtype === "init" && msg.session_id && this.currentPhase) {
    // Set the Claude session ID
    this.currentPhase.sessionId = msg.session_id;

    // Log the session ID update
    this.logger.log(`Claude started phase ${phaseId} with session ID: ${msg.session_id}`);

    // NOW send the phase.started event with the real session ID
    this.sendEvent({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: "phase.started",
      data: {
        phaseId: this.currentPhase.phase.id,
        phaseName: this.currentPhase.phase.name,
        phaseDescription: this.currentPhase.phase.description,
        sessionId: msg.session_id,  // Use Claude's real ID
        previousSessionId: this.getPreviousSessionId(this.currentPhase.phase.id),
        startTime: this.currentPhase.startTime.toISOString(),
      },
    } as PhaseStartedEvent);

    // Send existing info event
    this.sendEvent({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: "info",
      data: {
        message: `Claude started with session ID: ${msg.session_id}`,
      },
    } as InfoEvent);
  }
}
```

### 4. Update Error Handling

For cases where Claude fails before sending init:

```typescript
// In error handling code
if (!this.currentPhase.sessionId) {
  // Claude failed before init - use phaseExecutionId in events
  this.sendEvent({
    type: "phase.failed",
    data: {
      phaseId: this.currentPhase.phase.id,
      phaseExecutionId: this.currentPhase.phaseExecutionId,
      error: "Claude process failed before initialization",
      // Note: no sessionId field since Claude never provided one
    },
  });
}
```

### 5. Update Cleanup Code

**In `completePhase()` cleanup section:**

```typescript
// Use phaseExecutionId for internal cleanup
const executionId = this.currentPhase?.phaseExecutionId;
if (executionId && this.resultMessagePromises.has(executionId)) {
  const promise = this.resultMessagePromises.get(executionId);
  clearTimeout(promise.timeout);
  promise.reject(new Error("Phase cleanup - result message promise cancelled"));
  this.resultMessagePromises.delete(executionId);
}
```

### 6. Update Phase Snapshot

**In `completePhase()` when capturing state:**

```typescript
const phaseSnapshot = {
  phase: { ...this.currentPhase.phase },
  phaseExecutionId: this.currentPhase.phaseExecutionId, // Internal tracking
  sessionId: this.currentPhase.sessionId, // Claude's UUID (may be null if failed early)
  startTime: this.currentPhase.startTime,
  phaseCost: this.currentPhase.phaseCost,
  phaseTokens: { ...this.currentPhase.phaseTokens },
};
```

### 7. Remove Old Session ID Generation

**In `startPhase()` method:**

```typescript
// Remove this line:
const sessionId = generateId();

// The initialization already handles phaseExecutionId generation
```

## Test Updates Required

### 1. State Consistency Tests

**File:** `/tests/e2e/test-groups/state-consistency-tests.ts`

- Update "phase session IDs are consistent" test to expect only 1 session ID per phase (Claude's UUID)
- Update "previousSessionId correctly chains phases" to expect UUID format

### 2. WebSocket Event Tests

- Update to expect `phase.started` event AFTER Claude's init (not immediately)
- Verify events contain Claude's UUID, not timestamp-random format

### 3. Error Handling Tests

- Add test for Claude failing before init
- Verify `phase.failed` event uses phaseExecutionId when no sessionId available

## Benefits

1. **Cleaner Architecture**: Clear separation between internal tracking and client-facing IDs
2. **Accurate Events**: `phase.started` only fires when Claude actually starts
3. **Better Error Handling**: Can track failed phases even if Claude never initializes
4. **Simpler Tests**: No more confusion about dual session IDs
5. **No Breaking Changes**: Clients still see sessionId in events (just more accurately)

## Migration Notes

- This change is backward compatible for clients
- Internal logging will show both IDs for debugging
- Result message promises now keyed by phaseExecutionId (internal change only)
- No database schema changes required
