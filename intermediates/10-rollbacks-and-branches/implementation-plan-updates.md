# State Management Implementation Enhancements

This document outlines recommended enhancements to the state management implementation plan based on review of `implementation.md`, `state.md`, and `tests-implementation.md`.

## 1. Enhanced Transition Mutex with Internal Queue

**Reference**: `implementation.md` - Phase 1, Step 1.2

Replace the Promise-based mutex with a proper async mutex and internal queue system:

```typescript
// server/state-manager.ts
import { Mutex } from "async-mutex";

export class StateManager extends TypedEventEmitter<StateManagerEvents> {
  private transitionQueue: StateTransition[] = [];
  private isProcessing = false;

  // Running cost tallies for performance
  private costCache = {
    total: 0,
    currentRun: 0,
    lastUpdated: null as string | null,
  };

  // Public API - fire and forget!
  transition(event: StateTransition): void {
    this.transitionQueue.push(event);
    this.processQueue(); // Don't await - let it run
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;

    while (this.transitionQueue.length > 0) {
      const event = this.transitionQueue.shift()!;

      try {
        this.validateTransition(event);
        const oldState = this.state;
        const newState = this.applyTransition(this.state, event);
        this.state = newState;

        // Update cost cache if needed
        this.updateCostCache(event);

        await this.save();

        // Emit event AFTER state is persisted
        this.emit("stateChanged", event);

        // Emit specific events for important transitions
        if (event.type === "PhaseTransitioned" && event.data.to === "running") {
          this.emit("phaseRunning", event.data);
        }
      } catch (error) {
        this.logger.log(`State transition failed: ${error}`, "error");
        this.emit("transitionError", { event, error });

        if (error instanceof InvalidTransitionError) {
          continue; // Skip this transition
        } else {
          break; // Fatal error
        }
      }
    }

    this.isProcessing = false;
  }
}
```

**Update in `implementation.md`**: Modify Phase 3.3 to remove all `await` calls on transitions in synchronous handlers. Instead, use the fire-and-forget pattern.

## 2. Cost Calculation Performance

**Reference**: `state.md` - StateManager Interface, Cost Queries section

Add cost caching to avoid iterating all runs on every query:

```typescript
// In state-manager.ts
private updateCostCache(event: StateTransition): void {
  if (event.type === 'CostsUpdated') {
    // Update running tallies
    const phase = this.getPhaseInCurrentRun(event.data.phaseId);
    if (phase && 'currentCost' in phase) {
      const delta = event.data.cost - phase.currentCost;
      this.costCache.currentRun += delta;
      this.costCache.total += delta;
    }
  } else if (event.type === 'RunStarted') {
    this.costCache.currentRun = 0;
  } else if (event.type === 'RunCompleted' || event.type === 'RunFailed') {
    // Current run cost already in total, just reset current
    this.costCache.currentRun = 0;
  }
}

getCurrentRunCost(): number {
  return this.costCache.currentRun;
}

getTotalCost(): number {
  return this.costCache.total;
}

// In initialize(), rebuild cache from state
private rebuildCostCache(): void {
  this.costCache.total = this.state.runs.reduce((total, run) => {
    return total + run.phases.reduce((runTotal, phase) => {
      if (phase.status === 'completed') return runTotal + phase.finalCost;
      if (phase.status === 'failed') return runTotal + phase.partialCost;
      return runTotal;
    }, 0);
  }, 0);

  const currentRun = this.getCurrentRun();
  if (currentRun) {
    this.costCache.currentRun = currentRun.phases.reduce((total, phase) => {
      if ('currentCost' in phase) return total + phase.currentCost;
      if ('finalCost' in phase) return total + phase.finalCost;
      if ('partialCost' in phase) return total + phase.partialCost;
      return total;
    }, 0);
  }
}
```

## 3. Git Operations Error Handling

**Reference**: `implementation.md` - Phase 3.1, Phase 3.2

Ensure checkpoint creation is atomic with state transitions:

```typescript
// In langton-server.ts - modify handlePhaseComplete()
private async handlePhaseComplete(exitCode: number): Promise<void> {
  // ... existing code ...

  // Create checkpoint BEFORE state transition
  let checkpointSha: string | undefined;
  if (this.checkpointingEnabled && shouldCreateCheckpoint) {
    try {
      checkpointSha = await this.createCheckpoint({
        status: checkpointType,
        phaseId,
        phaseName: phase.name,
        runId: this.currentRunId!,
        timestamp: new Date().toISOString(),
        duration: Date.now() - new Date(currentPhase.startTime).getTime()
      });
    } catch (error) {
      this.logger.log(`Checkpoint creation failed: ${error}`, 'error');
      // Decide: fail the phase or continue without checkpoint?
      if (finalStatus === 'completed') {
        // For completed phases, checkpoint failure is critical
        finalStatus = 'failed';
        this.phaseFailureReason = {
          type: 'unknown',
          retriable: false,
          message: `Checkpoint creation failed: ${error.message}`
        };
      }
    }
  }

  // Now do state transition with checkpoint SHA if available
  this.stateManager.transition({
    type: "PhaseTransitioned",
    data: {
      runId: this.currentRunId!,
      phaseId,
      from: currentPhase.status,
      to: finalStatus,
      metadata: {
        checkpointSha,
        // ... other metadata
      }
    }
  });
}
```

## 4. Lock File Heartbeat

**Reference**: `implementation.md` - Phase 2.2, startNewRun method

Enhance lock file with heartbeat to detect stale locks:

```typescript
// Add to server/types.ts
interface LockFile {
  pid: number;
  runId: string;
  startTime: string;
  lastHeartbeat: string;
}

// In langton-server.ts
private heartbeatInterval?: NodeJS.Timeout;

private async startNewRun(): Promise<void> {
  // ... existing code ...

  const lockData: LockFile = {
    pid: process.pid,
    runId: runId,
    startTime: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString()
  };
  fs.writeFileSync(this.config.lockFile, JSON.stringify(lockData));

  // Start heartbeat
  this.heartbeatInterval = setInterval(() => {
    this.updateHeartbeat();
  }, 30000); // Every 30 seconds
}

private updateHeartbeat(): void {
  try {
    if (fs.existsSync(this.config.lockFile)) {
      const lock: LockFile = JSON.parse(fs.readFileSync(this.config.lockFile, 'utf-8'));
      lock.lastHeartbeat = new Date().toISOString();
      fs.writeFileSync(this.config.lockFile, JSON.stringify(lock));
    }
  } catch (error) {
    this.logger.log(`Failed to update heartbeat: ${error}`, 'error');
  }
}

// In start() method, update lock detection:
if (fs.existsSync(this.config.lockFile)) {
  const lockData: LockFile = JSON.parse(fs.readFileSync(this.config.lockFile, 'utf-8'));

  // Check heartbeat age
  const heartbeatAge = Date.now() - new Date(lockData.lastHeartbeat).getTime();
  if (heartbeatAge > 120000) { // 2 minutes
    this.logger.log(`Found stale lock file (heartbeat age: ${heartbeatAge}ms), removing...`);
    fs.unlinkSync(this.config.lockFile);

    // Mark the run as crashed
    if (lockData.runId) {
      await this.stateManager.transition({
        type: "RunCrashed",
        data: {
          runId: RunId(lockData.runId),
          detectedAt: new Date().toISOString(),
          lastPhaseStatus: "unknown" as PhaseStatus
        }
      });
    }
  } else if (state.currentRunId && state.currentRunId === lockData.runId) {
    // Recovery case - existing code
  } else {
    throw new Error(`Server already running (PID: ${lockData.pid}, Run: ${lockData.runId})`);
  }
}

// In shutdown(), clear heartbeat:
if (this.heartbeatInterval) {
  clearInterval(this.heartbeatInterval);
  this.heartbeatInterval = undefined;
}
```

## 5. Test Isolation

**Reference**: `tests-implementation.md` - Phase 9.1

Update test utilities to use isolated state files:

```typescript
// tests/utils/state-test-helpers.ts
export function createIsolatedStateManager(
  testDir: string,
  logger: Logger
): StateManager {
  // Each test gets its own state file
  const testLangtonDir = path.join(testDir, ".langton");
  return new StateManager(testLangtonDir, logger);
}

// In test setup
beforeEach(async () => {
  const testDir = path.join(TEST_ROOT, "test-isolation", generateId());
  await fs.promises.mkdir(testDir, { recursive: true });

  const stateManager = createIsolatedStateManager(testDir, logger);
  await stateManager.initialize();

  // Pass custom state manager to server
  const server = new LangtonServer({
    projectPath: testDir,
    stateManager, // Allow injection for tests
    // ... other config
  });
});
```

## 6. State Validation

**Reference**: `state.md` - StateManager Interface, Recovery Operations

Add to `state-manager.ts` initialize method:

```typescript
async initialize(): Promise<void> {
  try {
    if (fs.existsSync(this.statePath)) {
      const content = await fs.promises.readFile(this.statePath, "utf-8");
      const parsedState = JSON.parse(content);

      // Validate before using
      const validation = this.validate(parsedState);
      if (!validation.valid) {
        this.logger.log("State validation errors found:", "error");
        validation.errors.forEach(e =>
          this.logger.log(`  - ${e.type}: ${e.message}`, "error")
        );

        if (validation.errors.some(e => e.type === 'corrupted_data')) {
          throw new Error("State file corrupted");
        }
      }

      // Log warnings but continue
      validation.warnings.forEach(w =>
        this.logger.log(`Warning - ${w.type}: ${w.message}`, "info")
      );

      this.state = parsedState;
      this.rebuildCostCache();
      this.logger.log("Loaded existing state file");
    }

    await this.detectCrashedRuns();
  } catch (error) {
    // ... existing recovery logic
  }
}

private validate(state: unknown): StateValidation {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Type structure validation
  if (!this.isValidStateStructure(state)) {
    errors.push({
      type: 'corrupted_data',
      message: 'State file has invalid structure'
    });
    return { valid: false, errors, warnings };
  }

  // Referential integrity
  const typedState = state as LangtonState;
  if (typedState.currentRunId &&
      !typedState.runs.find(r => r.runId === typedState.currentRunId)) {
    errors.push({
      type: 'missing_run',
      message: `Current run ${typedState.currentRunId} not found`
    });
  }

  // Check for orphaned run folders
  const runsDir = path.join(this.langtonDir, 'runs');
  if (fs.existsSync(runsDir)) {
    const runFolders = fs.readdirSync(runsDir);
    const stateRunIds = new Set(typedState.runs.map(r => r.runId));

    for (const folder of runFolders) {
      if (!stateRunIds.has(folder as RunId)) {
        warnings.push({
          type: 'orphaned_folder',
          message: `Found run folder without state entry: ${folder}`
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

## 7. Event Logging for Debugging

**Reference**: New addition to `state-manager.ts`

Add event logging for debugging without making it source of truth:

```typescript
// In state-manager.ts
private async logTransitionEvent(event: StateTransition): Promise<void> {
  const eventLog = path.join(this.langtonDir, 'events.jsonl');
  const logEntry = {
    timestamp: new Date().toISOString(),
    serverPid: process.pid,
    event,
    resultingState: {
      currentRunId: this.state.currentRunId,
      runCount: this.state.runs.length,
      totalCost: this.costCache.total,
      currentRunCost: this.costCache.currentRun
    }
  };

  try {
    await fs.promises.appendFile(
      eventLog,
      JSON.stringify(logEntry) + '\n'
    );
  } catch (error) {
    // Don't fail transitions due to logging errors
    this.logger.log(`Failed to log event: ${error}`, 'debug');
  }
}

// Call in processQueue after successful transition:
await this.logTransitionEvent(event);
```

## 8. Phase Timeout Configuration

**Reference**: `server/types.ts` - PhaseConfig interface

Add timeout configuration to phase config:

```typescript
// In server/types.ts
interface PhaseConfig {
  // ... existing fields ...

  /**
   * Custom timeouts for this phase (milliseconds)
   */
  timeouts?: {
    /** Time to wait for Claude init message (default: 30000) */
    initialization?: number;
    /** Time to wait for result message after completion (default: 30000) */
    resultMessage?: number;
    /** Maximum total execution time (default: none) */
    total?: number;
  };
}

// In langton-server.ts - use configured timeouts
private async waitForResultMessage(key: string, phase: PhaseConfig): Promise<ResultMessage> {
  const timeout = phase.timeouts?.resultMessage ?? TIMEOUTS.RESULT_MESSAGE_MS;
  // ... existing implementation with custom timeout
}
```
