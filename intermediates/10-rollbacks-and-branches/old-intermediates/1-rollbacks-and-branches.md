```typescript
/**
 * FROM AI:
 * Langton Runner State Management
 *
 * This state system tracks all execution history for a Langton run, enabling:
 * - Crash recovery and resumption
 * - Cost tracking across retries
 * - Rollback to previous checkpoints
 * - Debugging via complete attempt history
 *
 * Terminology:
 * - Run: One server lifecycle (start → shutdown)
 * - Phase: A configured task from phases.json
 * - Attempt: One execution of a phase (may retry multiple times)
 */

/**
 * Root state for a complete Langton run.
 * Stored in .langton/runs/{runId}/state.json
 */
export interface RunState {
  /** Unique identifier for this server run (timestamp-random format) */
  runId: string;

  /** Absolute path where Claude executes (cannot be inferred on resume) */
  projectPath: string;

  /** Path to phases configuration used (for compatibility checking) */
  configPath: string;

  /** Server version for compatibility warnings on resume */
  serverVersion: string;

  /** When this run started */
  startTime: string; // ISO 8601

  /** Custom Anthropic API endpoint if provided */
  baseUrl?: string;

  /** Server process ID for lock file validation */
  serverPid: number;

  /** Path to lock file (typically .langton/server.lock) */
  lockFilePath: string;

  /** Current run status - denormalized for quick checks */
  status: "running" | "completed" | "error" | "shutdown";

  /** When run ended (if not running) */
  endTime?: string; // ISO 8601

  /** Currently executing attempt (null if idle between phases) */
  currentAttemptId: string | null;

  /** Most recent attempt of any status (for continuing after crash) */
  lastAttemptId: string | null;

  /** All attempts in this run, keyed by attemptId */
  attempts: Record<string, AttemptState>;
}

/**
 * Discriminated union for attempt states.
 * Each status has different required fields.
 */
export type AttemptState =
  | RunningAttempt
  | CompletedAttempt
  | FailedAttempt
  | SkippedAttempt;

/**
 * Common fields for all attempt states
 */
interface BaseAttempt {
  /** Unique ID for this attempt (timestamp-random format) */
  attemptId: string;

  /** Which phase this attempt is executing */
  phaseId: string;

  /** When attempt started */
  startTime: string; // ISO 8601

  /** Claude process ID if available (for debugging stuck processes) */
  claudePid?: number;

  /** Path to Claude's JSONL log file for this attempt */
  claudeLogPath: string;

  /** Claude's session UUID from init message (null until received) */
  claudeSessionId: string | null;

  /** Previous Claude session ID if continuing from another phase */
  previousSessionId?: string;

  /** Git checkpoint information */
  checkpoints: {
    /** Commit SHA after workspace setup (if applicable) */
    workspaceSetup?: string;

    /** Git branch name for this attempt (e.g., "run-abc123-attempt-def456") */
    branch: string;
  };

  /** Glob patterns being tracked for checkpointing */
  checkpointPatterns: string[];
}

/**
 * Attempt currently being executed
 */
export interface RunningAttempt extends BaseAttempt {
  status: "running";
  // No end time, cost, or exit code yet
}

/**
 * Successfully completed attempt
 */
export interface CompletedAttempt extends BaseAttempt {
  status: "completed";

  /** When phase completed */
  endTime: string; // ISO 8601

  /** Total cost in USD for this attempt */
  cost: number;

  /** How long the phase took in milliseconds */
  duration: number;

  /** Claude process exit code (always 0 for success) */
  exitCode: 0;

  /** Whether we received Claude's result message or timed out waiting */
  resultMessageReceived: boolean;

  /** Token usage breakdown (optional - can be reconstructed from logs) */
  tokens?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };

  checkpoints: BaseAttempt["checkpoints"] & {
    /** Final commit SHA on successful completion */
    completed: string;
  };
}

/**
 * Attempt that failed with error
 */
export interface FailedAttempt extends BaseAttempt {
  status: "failed";

  /** When phase failed */
  endTime: string; // ISO 8601

  /** Partial cost before failure */
  cost: number;

  /** How long before failure in milliseconds */
  duration: number;

  /** Claude process exit code (non-zero) */
  exitCode: number;

  /** Type of error for recovery decisions */
  errorType?: "timeout" | "api_error" | "process_crash" | "user_error";

  /** Human-readable error message */
  errorMessage?: string;

  /** Whether failure is potentially recoverable */
  recoverable?: boolean;

  checkpoints: BaseAttempt["checkpoints"] & {
    /** Error commit SHA if created before crash */
    error?: string;
  };
}

/**
 * Attempt that was skipped by user
 */
export interface SkippedAttempt extends BaseAttempt {
  status: "skipped";

  /** When skip was initiated */
  endTime: string; // ISO 8601

  /** Always 0 for skipped attempts */
  cost: 0;

  /** Time from start to skip in milliseconds */
  duration: number;

  checkpoints: BaseAttempt["checkpoints"] & {
    /** Skip commit SHA if any files were tracked */
    skipped?: string;
  };
}
```

## Example State Objects

### Example 1: Mid-Execution State

```json
{
  "runId": "1732654321000-a1b2c3d4e5",
  "projectPath": "/home/user/projects/my-assistant",
  "configPath": "/home/user/projects/my-assistant/phases.json",
  "serverVersion": "1.0.0",
  "startTime": "2024-11-26T10:00:00.000Z",
  "serverPid": 12345,
  "lockFilePath": ".langton/server.lock",
  "status": "running",
  "currentAttemptId": "1732654500000-f6g7h8i9j0",
  "lastAttemptId": "1732654400000-x1y2z3a4b5",
  "attempts": {
    "1732654350000-k1l2m3n4o5": {
      "attemptId": "1732654350000-k1l2m3n4o5",
      "phaseId": "research",
      "status": "completed",
      "startTime": "2024-11-26T10:01:00.000Z",
      "endTime": "2024-11-26T10:03:30.000Z",
      "claudePid": 12346,
      "claudeLogPath": ".langton/logs/log-research.jsonl",
      "claudeSessionId": "8b4e6a2d-1234-4567-8901-234567890abc",
      "cost": 0.0234,
      "duration": 150000,
      "exitCode": 0,
      "resultMessageReceived": true,
      "tokens": {
        "inputTokens": 1523,
        "outputTokens": 892,
        "cacheCreationTokens": 200,
        "cacheReadTokens": 0
      },
      "checkpoints": {
        "workspaceSetup": "a1b2c3d4e5f6789",
        "branch": "run-1732654321000-a1b2c3d4e5-attempt-1732654350000-k1l2m3n4o5",
        "completed": "9f8e7d6c5b4a321"
      },
      "checkpointPatterns": ["research/**/*.md", "research/**/*.txt"]
    },
    "1732654400000-x1y2z3a4b5": {
      "attemptId": "1732654400000-x1y2z3a4b5",
      "phaseId": "implement",
      "status": "failed",
      "startTime": "2024-11-26T10:04:00.000Z",
      "endTime": "2024-11-26T10:05:15.000Z",
      "claudePid": 12347,
      "claudeLogPath": ".langton/logs/log-implement.jsonl",
      "claudeSessionId": "7c5f8b3e-2345-5678-9012-345678901bcd",
      "previousSessionId": "8b4e6a2d-1234-4567-8901-234567890abc",
      "cost": 0.0156,
      "duration": 75000,
      "exitCode": 1,
      "errorType": "timeout",
      "errorMessage": "API Error: Request timed out.",
      "recoverable": true,
      "checkpoints": {
        "branch": "run-1732654321000-a1b2c3d4e5-attempt-1732654400000-x1y2z3a4b5",
        "error": "6d5c4b3a2f1e098"
      },
      "checkpointPatterns": ["src/**/*.ts", "package.json"]
    },
    "1732654500000-f6g7h8i9j0": {
      "attemptId": "1732654500000-f6g7h8i9j0",
      "phaseId": "implement",
      "status": "running",
      "startTime": "2024-11-26T10:06:00.000Z",
      "claudePid": 12348,
      "claudeLogPath": ".langton/logs/log-implement.jsonl",
      "claudeSessionId": null,
      "previousSessionId": "8b4e6a2d-1234-4567-8901-234567890abc",
      "checkpoints": {
        "branch": "run-1732654321000-a1b2c3d4e5-retry-1732654400000-x1y2z3a4b5"
      },
      "checkpointPatterns": ["src/**/*.ts", "package.json"]
    }
  }
}
```

### Example 2: Completed Run with Skipped Phase

```json
{
  "runId": "1732650000000-p9q8r7s6t5",
  "projectPath": "/home/user/projects/analyzer",
  "configPath": "./analysis-phases.json",
  "serverVersion": "1.0.0",
  "startTime": "2024-11-26T09:00:00.000Z",
  "endTime": "2024-11-26T09:15:00.000Z",
  "baseUrl": "https://proxy.company.com/anthropic",
  "serverPid": 11111,
  "lockFilePath": ".langton/server.lock",
  "status": "completed",
  "currentAttemptId": null,
  "lastAttemptId": "1732650600000-u5v6w7x8y9",
  "attempts": {
    "1732650100000-a1a1a1a1a1": {
      "attemptId": "1732650100000-a1a1a1a1a1",
      "phaseId": "analyze",
      "status": "completed",
      "startTime": "2024-11-26T09:01:00.000Z",
      "endTime": "2024-11-26T09:05:00.000Z",
      "claudePid": 11112,
      "claudeLogPath": ".langton/logs/log-analyze.jsonl",
      "claudeSessionId": "1a2b3c4d-5678-9012-3456-789012345678",
      "cost": 0.0512,
      "duration": 240000,
      "exitCode": 0,
      "resultMessageReceived": true,
      "checkpoints": {
        "branch": "run-1732650000000-p9q8r7s6t5-attempt-1732650100000-a1a1a1a1a1",
        "completed": "abc123def456789"
      },
      "checkpointPatterns": ["analysis/**/*"]
    },
    "1732650600000-u5v6w7x8y9": {
      "attemptId": "1732650600000-u5v6w7x8y9",
      "phaseId": "report",
      "status": "skipped",
      "startTime": "2024-11-26T09:10:00.000Z",
      "endTime": "2024-11-26T09:10:30.000Z",
      "claudePid": 11113,
      "claudeLogPath": ".langton/logs/log-report.jsonl",
      "claudeSessionId": "2b3c4d5e-6789-0123-4567-890123456789",
      "previousSessionId": "1a2b3c4d-5678-9012-3456-789012345678",
      "cost": 0,
      "duration": 30000,
      "checkpoints": {
        "branch": "run-1732650000000-p9q8r7s6t5-attempt-1732650600000-u5v6w7x8y9",
        "skipped": "789def123abc456"
      },
      "checkpointPatterns": ["reports/**/*"]
    }
  }
}
```

</ideas>

<PRIMARY_TASK>
Think through the state system and how it would work, what things need to be hooked over in order to make it the source of truth, how to store it and manage it, etc. USe the ideas but just as a starting point.

Then consider how this state system would work with server exits, partial failures, retry, rollbacks, branching, etc. Think through the scenarios.

Log your thoughts into `intermediates/11-thoughts-about-state.md` - questions, things to explore, possible edge cases, gotchas, aha moments, implementation quirks, etc.

Take your time - keep putting down thoughts and moving methodically.
</PRIMARY_TASK>
