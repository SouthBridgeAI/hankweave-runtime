# Timeout Error Classification Fix

## Problem

When Claude API requests timed out, the server was:

1. Not properly classifying timeouts as retriable errors
2. Treating all phase failures as fatal, causing server shutdown
3. Not providing failure context to websocket clients

## Solution Implemented

### 1. Added Failure Reason Type (`server/types.ts`)

```typescript
export interface FailureReason {
  type: "timeout" | "rate-limit" | "api-error" | "unknown";
  retriable: boolean;
  message?: string;
}
```

### 2. Enhanced PhaseCompletedEvent

- Added optional `failureReason` field to provide context about phase failures
- Allows clients to determine if they should retry

### 3. Server Changes (`server/langton-server.ts`)

- Added `phaseFailureReason` tracking
- Set failure reason when timeouts are detected in:
  - Synthetic timeout messages
  - Text content with timeout message
  - Result messages with timeout
- Modified `handlePhaseComplete` to:
  - Include failure reason in phase.completed event
  - Not shutdown for retriable errors
  - Clear failure reason during cleanup

### 4. UI Updates (`server/basic-tui.ts`)

- Display failure reason details when phase fails
- Show whether error is retriable

### 5. Tests (`tests/unit/phase-failure-reason.test.ts`)

- Unit tests for FailureReason type
- Tests for PhaseCompletedEvent with failure reasons
- Validation of retriable error classification

## Key Benefits

1. **Server Resilience**: Server no longer shuts down on timeout errors
2. **Client Control**: Clients can see error is retriable and use `phase.redo`
3. **Better Visibility**: Failure reasons are now properly communicated
4. **Extensible**: Easy to add new error types (rate-limit, etc.) in future

## Example WebSocket Event

```json
{
  "type": "phase.completed",
  "data": {
    "phaseId": "phase-2b",
    "success": false,
    "cost": 3.4221681,
    "duration": 1093302,
    "exitStatus": { "type": "error", "code": 1 },
    "failureReason": {
      "type": "timeout",
      "retriable": true,
      "message": "API Error: Request timed out."
    }
  }
}
```
