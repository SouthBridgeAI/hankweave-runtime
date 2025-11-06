# Event Queueing Design for Chroniclers

## Initial Recommendation: Skip Flush Queueing

Based on analysis of the chroniclers implementation, here's my recommendation:

### Don't Solve Flush Queueing Now - It Will Be Solved By Trigger Queueing

The flush queueing problem is actually a **subset** of the trigger queueing problem. Here's why:

#### Current Flush Issue
- Events arriving during `flush()` are dropped (checked by `if (this.isFlushing)` in `handleEvent()`)
- This is a ~short window (duration of one LLM call) that only happens at phase boundaries
- Current impact is minimal and logged for debugging

#### How Trigger Queueing Solves This

When you implement trigger queueing where triggers execute serially:
1. **Events can always be accepted** - they just get queued for processing
2. **Flush becomes trivial** - just "wait for queue to drain, then return"
3. **No special `isFlushing` flag needed** - queue handles everything
4. **Memory is already managed** - you have `MAX_BUFFER_SIZE = 10000`

#### Pseudocode After Trigger Queueing:
```typescript
// In Chronicler
private triggerQueue: QueuedTrigger[] = [];
private isProcessingTrigger = false;

async handleEvent(event: ServerEvent) {
  const triggerResult = this.triggerEngine.processEvent(event);
  if (triggerResult.matched) {
    this.enqueueTrigger(triggerResult.events);
    this.processQueueIfIdle(); // Start processing if not already
  }
}

async flush() {
  // Just wait for the queue to drain
  await this.waitForQueueToEmpty();
}
```

#### Solving the Ordering Problem

For your bigger questions about trigger queueing:

1. **Memory**: Events by reference + MAX_BUFFER_SIZE already handles this
2. **Time-based triggers**: Queue them like any other trigger, include timestamp when triggered
3. **Conversational history**: Template only when actually executing (already your design)
4. **Pileups**: Can add backpressure warnings or max queue size limits

#### My Recommendation

**Skip flush queueing entirely.** Move directly to designing trigger queueing, which will:
- Solve flush automatically
- Solve the ordered output problem
- Solve the conversational ordering problem
- Be cleaner architecturally (no temporary fixes)

The current flush behavior (dropping events with debug log) is acceptable as a temporary state because the window is small and the real fix is coming.

---

## Trigger Queueing Design

### Core Architecture

#### Queue Granularity: Per-Chronicler

Each `Chronicler` instance maintains its own trigger queue. This design:
- Keeps chroniclers independent (core design principle)
- Allows parallel execution across different chroniclers
- Maintains serial execution within each chronicler (solves ordering)
- Simplifies error handling (errors in one chronicler don't affect others)

#### Queue Structure

```typescript
interface QueuedTrigger {
  id: string; // Unique trigger ID for tracking
  events: ServerEvent[]; // Events that triggered this execution
  strategy: ExecutionStrategy; // immediate, debounce, count, timeWindow
  queuedAt: Date; // When this trigger was queued (for templating)
  priority?: number; // Optional priority (future enhancement)
}

class Chronicler {
  private triggerQueue: QueuedTrigger[] = [];
  private isProcessingQueue = false;
  private queueProcessingPromise?: Promise<void>;
  private readonly MAX_QUEUE_SIZE = 100; // Max queued triggers
}
```

### Processing Model

#### Serial Queue Processor

```typescript
private async processQueue(): Promise<void> {
  if (this.isProcessingQueue) {
    return; // Already processing
  }

  this.isProcessingQueue = true;

  while (this.triggerQueue.length > 0) {
    const trigger = this.triggerQueue.shift()!;

    try {
      await this.executeTrigger(trigger);
    } catch (error) {
      this.logger?.log(
        `[Chronicler:${this.config.id}] Error executing trigger: ${error}`,
        'error'
      );
      // Continue processing queue even if one trigger fails
    }
  }

  this.isProcessingQueue = false;
}

private async executeTrigger(trigger: QueuedTrigger): Promise<void> {
  // CRITICAL: Use trigger.queuedAt for templating timestamp
  // This ensures consistent time even if execution is delayed by queue
  const templateContext: TemplateContext = {
    events: trigger.events,
    phase: {
      id: this.phaseId,
      name: this.config.name,
      description: this.config.description,
      startTime: this.runStartTime,
    },
    world: {
      // IMPORTANT: This must be trigger.queuedAt, NOT new Date()
      // Templates should see when the trigger HAPPENED, not when it's EXECUTING
      currentTime: trigger.queuedAt,
    },
  };

  // Render prompts with the queued timestamp
  let userMessage: string;
  try {
    userMessage = await TemplateRenderer.render(this.userPromptTemplate, templateContext);
  } catch (error) {
    // Handle template errors...
  }

  let renderedSystemPrompt: string | undefined;
  if (this.systemPromptTemplate) {
    try {
      renderedSystemPrompt = await TemplateRenderer.render(this.systemPromptTemplate, templateContext);
    } catch (error) {
      // Handle template errors...
    }
  }

  // Execute LLM call with templated prompts
  // The key: Templates were rendered with trigger.queuedAt, ensuring semantic correctness
  // even if this trigger was delayed in queue behind other slow triggers
  // ...
}
```

### Handling Different Execution Strategies

#### Strategy Integration

The key insight: **Strategies now control WHEN to queue a trigger, not HOW to execute it.**

```typescript
async handleEvent(event: ServerEvent): Promise<void> {
  const triggerResult = this.triggerEngine.processEvent(event);

  if (triggerResult.matched) {
    switch (this.config.execution.strategy) {
      case 'immediate':
        this.enqueueImmediateTrigger(triggerResult.events);
        break;
      case 'debounce':
        this.handleDebounceStrategy(triggerResult.events, this.config.execution.milliseconds);
        break;
      case 'count':
        this.handleCountStrategy(triggerResult.events, this.config.execution.threshold);
        break;
      case 'timeWindow':
        this.handleTimeWindowStrategy(triggerResult.events, this.config.execution.milliseconds);
        break;
    }
  }
}

private enqueueImmediateTrigger(events: ServerEvent[]): void {
  const trigger: QueuedTrigger = {
    id: generateId(),
    events,
    strategy: 'immediate',
    queuedAt: new Date(),
  };

  this.enqueueAndProcess(trigger);
}

private enqueueAndProcess(trigger: QueuedTrigger): void {
  // Check queue size
  if (this.triggerQueue.length >= this.MAX_QUEUE_SIZE) {
    this.logger?.log(
      `[Chronicler:${this.config.id}] Queue full (${this.MAX_QUEUE_SIZE}), dropping oldest trigger`,
      'warn'
    );
    this.triggerQueue.shift(); // Drop oldest
  }

  this.triggerQueue.push(trigger);

  // Start processing if not already running
  if (!this.isProcessingQueue) {
    this.queueProcessingPromise = this.processQueue();
  }
}
```

#### Debounce Strategy with Queueing

```typescript
private pendingDebounce?: {
  events: ServerEvent[];
  timer: Timer;
};

private handleDebounceStrategy(events: ServerEvent[], milliseconds: number): void {
  // Accumulate events
  if (this.pendingDebounce) {
    this.pendingDebounce.events.push(...events);
    clearTimeout(this.pendingDebounce.timer);
  } else {
    this.pendingDebounce = {
      events: [...events],
      timer: undefined as any, // Will be set below
    };
  }

  // Set/reset timer
  this.pendingDebounce.timer = setTimeout(() => {
    const accumulatedEvents = this.pendingDebounce!.events;
    this.pendingDebounce = undefined;

    // Now queue the trigger
    const trigger: QueuedTrigger = {
      id: generateId(),
      events: accumulatedEvents,
      strategy: 'debounce',
      queuedAt: new Date(),
    };

    this.enqueueAndProcess(trigger);
  }, milliseconds);
}
```

#### Count Strategy with Queueing

```typescript
private handleCountStrategy(events: ServerEvent[], threshold: number): void {
  this.addToBuffer(events); // Use existing buffer

  // Check if we've reached threshold
  while (this.pendingEvents.length >= threshold) {
    const batchEvents = this.pendingEvents.splice(0, threshold);

    const trigger: QueuedTrigger = {
      id: generateId(),
      events: batchEvents,
      strategy: 'count',
      queuedAt: new Date(),
    };

    this.enqueueAndProcess(trigger);
  }
}
```

#### TimeWindow Strategy with Queueing

```typescript
private handleTimeWindowStrategy(events: ServerEvent[], milliseconds: number): void {
  this.addToBuffer(events);

  if (!this.timeWindowTimer) {
    this.startTimeWindowLoop(milliseconds);
  }
}

private startTimeWindowLoop(milliseconds: number): void {
  // Similar to existing implementation, but queue the trigger instead of executing
  const fireWindow = () => {
    if (this.pendingEvents.length > 0) {
      const windowEvents = [...this.pendingEvents];
      this.pendingEvents = [];

      const trigger: QueuedTrigger = {
        id: generateId(),
        events: windowEvents,
        strategy: 'timeWindow',
        queuedAt: new Date(),
      };

      this.enqueueAndProcess(trigger);
    }

    // Schedule next window
    this.timeWindowTimer = setTimeout(fireWindow, milliseconds);
  };

  this.timeWindowTimer = setTimeout(fireWindow, milliseconds);
}
```

### Memory Management

#### Queue Size Limits

```typescript
private readonly MAX_QUEUE_SIZE = 100; // Max queued triggers
private readonly MAX_BUFFER_SIZE = 10000; // Max buffered events (existing)

private enqueueAndProcess(trigger: QueuedTrigger): void {
  // Check total queued events across all triggers
  const totalQueuedEvents = this.triggerQueue.reduce(
    (sum, t) => sum + t.events.length,
    0
  );

  if (totalQueuedEvents > this.MAX_BUFFER_SIZE) {
    this.logger?.log(
      `[Chronicler:${this.config.id}] Total queued events (${totalQueuedEvents}) exceeds limit, dropping oldest trigger`,
      'warn'
    );
    this.triggerQueue.shift();
  }

  if (this.triggerQueue.length >= this.MAX_QUEUE_SIZE) {
    this.logger?.log(
      `[Chronicler:${this.config.id}] Queue full (${this.MAX_QUEUE_SIZE} triggers), dropping oldest`,
      'warn'
    );
    this.triggerQueue.shift();
  }

  this.triggerQueue.push(trigger);

  if (!this.isProcessingQueue) {
    this.queueProcessingPromise = this.processQueue();
  }
}
```

#### Backpressure Warnings

```typescript
private checkBackpressure(): void {
  const queueSize = this.triggerQueue.length;
  const threshold = this.MAX_QUEUE_SIZE * 0.7; // 70% full

  if (queueSize > threshold) {
    this.logger?.log(
      `[Chronicler:${this.config.id}] Queue backpressure: ${queueSize}/${this.MAX_QUEUE_SIZE} triggers queued`,
      'warn'
    );
  }
}
```

### Graceful Completion: Renamed from flush()

**Design Question: What should we call this operation?**

Options:
- ~~`flush()`~~ - Ambiguous, could mean "flush buffers" or "flush to disk"
- `waitForPendingTriggers()` - Clear but verbose
- `drainQueue()` - Simple, but doesn't mention that it finalizes buffers too
- **`completeAllWork()`** - Recommended: Clear intent, matches lifecycle semantics

**Recommended Implementation**:

```typescript
/**
 * Complete all pending work before shutdown/phase-end.
 *
 * This method:
 * 1. Stops timers (no new triggers created)
 * 2. Converts any buffered events into final triggers
 * 3. Waits for all queued triggers to execute
 *
 * Called by ChroniclerManager during graceful shutdown.
 * After this completes, calling destroy() should have no pending work.
 */
public async completeAllWork(): Promise<void> {
  this.logger?.log(
    `[Chronicler:${this.config.id}] Completing all work: ${this.triggerQueue.length} triggers queued`,
    'info'
  );

  // 1. Stop time-based trigger creation
  if (this.timeWindowTimer) {
    clearTimeout(this.timeWindowTimer);
    this.timeWindowTimer = undefined;
  }

  // 2. Convert pending debounce into final trigger
  if (this.pendingDebounce) {
    clearTimeout(this.pendingDebounce.timer);
    const trigger: QueuedTrigger = {
      id: generateId(),
      events: this.pendingDebounce.events,
      strategy: 'debounce',
      queuedAt: new Date(), // Use current time for this final trigger
    };
    this.enqueueAndProcess(trigger);
    this.pendingDebounce = undefined;
  }

  // 3. Convert remaining count buffer into final trigger
  if (this.pendingEvents.length > 0) {
    const trigger: QueuedTrigger = {
      id: generateId(),
      events: [...this.pendingEvents],
      strategy: 'count',
      queuedAt: new Date(), // Use current time for this final trigger
    };
    this.enqueueAndProcess(trigger);
    this.pendingEvents = [];
  }

  // 4. Wait for queue to drain completely
  while (this.isProcessingQueue || this.triggerQueue.length > 0) {
    await this.queueProcessingPromise;
    // Check again in case triggers were queued during processing
    if (this.triggerQueue.length > 0 && !this.isProcessingQueue) {
      this.queueProcessingPromise = this.processQueue();
    }
  }

  this.logger?.log(
    `[Chronicler:${this.config.id}] All work completed`,
    'info'
  );
}
```

**Do We Even Need This?**

Good question! With queueing, we could potentially just call `destroy()` and be done. However:

**Keep `completeAllWork()` because**:
1. **Semantic clarity**: Phase ending = complete work, then destroy
2. **Partial buffers**: Debounce/count may have events that haven't triggered yet
3. **User expectations**: If debounce has 4/5 events buffered, user expects those to process
4. **Data loss prevention**: Prevents losing observations just because timing was unlucky

**Lifecycle Pattern**:
```typescript
// In ChroniclerManager
async shutdown(): Promise<void> {
  // Graceful completion
  await this.completeAllWork();  // Process all pending work

  // Forceful cleanup
  for (const chronicler of this.chroniclers) {
    chronicler.destroy();  // Drop anything that arrived during completion
  }
}
```

**Alternative: Make it Optional**

If we want to support both patterns:

```typescript
async shutdown(options: { graceful: boolean } = { graceful: true }): Promise<void> {
  if (options.graceful) {
    await this.completeAllWork(); // Process pending
  }

  // Always destroy
  for (const chronicler of this.chroniclers) {
    chronicler.destroy();
  }
}
```

**Recommendation: Keep `completeAllWork()` as separate method. It's clearer and prevents accidental data loss.**

### Conversational History Ordering

No changes needed! The queue ensures triggers execute serially, so:
1. Trigger 1 executes → adds user message → gets LLM response → adds assistant message
2. Trigger 2 waits → once Trigger 1 done, executes → adds messages
3. History is always in correct order

### Time-Based Triggers

The key design decision: **Use `queuedAt` timestamp for templating, not execution time.**

```typescript
const templateContext: TemplateContext = {
  events: trigger.events,
  phase: {
    id: this.phaseId,
    name: this.config.name,
    description: this.config.description,
    startTime: this.runStartTime,
  },
  world: {
    currentTime: trigger.queuedAt, // Critical: Use when trigger was queued
  },
};
```

This ensures:
- Debounce/timeWindow triggers use the time they were *supposed* to fire
- Even if delayed by queue, timestamp is semantically correct
- Templates see consistent world state

### Cancellation (Future Enhancement)

Could add trigger cancellation for specific scenarios:

```typescript
private cancelQueuedTriggers(filter: (trigger: QueuedTrigger) => boolean): number {
  const originalLength = this.triggerQueue.length;
  this.triggerQueue = this.triggerQueue.filter(t => !filter(t));
  return originalLength - this.triggerQueue.length;
}

// Example: Cancel all triggers older than 5 minutes
cancelStale(): number {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  return this.cancelQueuedTriggers(
    t => t.queuedAt.getTime() < fiveMinutesAgo
  );
}
```

### Error Handling

Errors during trigger execution don't stop queue processing:

```typescript
private async processQueue(): Promise<void> {
  this.isProcessingQueue = true;

  while (this.triggerQueue.length > 0) {
    const trigger = this.triggerQueue.shift()!;

    try {
      await this.executeTrigger(trigger);
    } catch (error) {
      if (error instanceof ChroniclerFatalError) {
        // Fatal error - propagate to manager for unloading decision
        this.logger?.log(
          `[Chronicler:${this.config.id}] Fatal error in trigger ${trigger.id}: ${error}`,
          'error'
        );
        throw error; // Let manager handle unloading
      } else {
        // Regular error - log and continue
        this.logger?.log(
          `[Chronicler:${this.config.id}] Error in trigger ${trigger.id}: ${error}`,
          'error'
        );
        // Continue processing next trigger
      }
    }
  }

  this.isProcessingQueue = false;
}
```

## Implementation Phases

### Phase 1: Core Queue Infrastructure
1. Add `QueuedTrigger` interface and queue data structure
2. Implement `processQueue()` serial processor
3. Update `handleEvent()` to use queueing for immediate strategy
4. Update `flush()` to wait for queue drainage
5. Remove `isFlushing` flag

### Phase 2: Strategy Integration
1. Update debounce strategy to queue triggers
2. Update count strategy to queue triggers
3. Update timeWindow strategy to queue triggers
4. Ensure all strategies use `queuedAt` for templating

### Phase 3: Memory Management
1. Add MAX_QUEUE_SIZE enforcement
2. Add backpressure warnings
3. Add logging for queue metrics

### Phase 4: Testing
1. Test serial execution within chronicler
2. Test parallel execution across chroniclers
3. Test flush with various strategies
4. Test queue overflow handling
5. Test conversational history ordering
6. Test time-based trigger timestamps

### Phase 5: Documentation
1. Update chronicler-system.md
2. Add queue behavior to execution strategy docs
3. Document memory limits and backpressure

## Benefits Summary

### Problems Solved
✅ Flush no longer drops events
✅ Ordered output guaranteed per chronicler
✅ Conversational history always correct
✅ Time-based triggers have consistent timestamps
✅ Memory management through queue limits
✅ Simpler architecture (no special flush flag)

### Trade-offs
⚠️ Additional latency for queued triggers (acceptable)
⚠️ Queue overflow can drop old triggers (logged, acceptable)
⚠️ Slightly more complex than direct execution (worth it)

### What's Not Solved
❌ Cross-chronicler ordering (not a requirement)
❌ Priority scheduling (future enhancement)
❌ Distributed chroniclers (not in scope)

## Open Questions

1. **Queue size limits**: Is 100 triggers and 10,000 events reasonable?
2. **Drop policy**: Should we drop oldest (FIFO) or newest (LIFO) on overflow?
3. **Backpressure threshold**: 70% full for warnings?
4. **Cancellation API**: Do we need explicit trigger cancellation?
5. **Metrics**: Should we expose queue depth metrics to ChroniclerManager?

---

## Design Q&A

### Q1: Is This Better Than a Promise Chain Solution?

**TL;DR: Yes, for our use case. Queue-based is clearer, more debuggable, and handles edge cases better.**

#### Promise Chain Approach

```typescript
private executionChain = Promise.resolve();

async handleEvent(event: ServerEvent): Promise<void> {
  const triggerResult = this.triggerEngine.processEvent(event);
  if (triggerResult.matched) {
    // Chain the execution
    this.executionChain = this.executionChain
      .then(() => this.executeChroniclerCall(triggerResult.events))
      .catch(error => {
        this.logger?.log(`Error in chain: ${error}`, 'error');
      });
  }
}

async flush(): Promise<void> {
  await this.executionChain;
}
```

#### Comparison

| Aspect | Queue-Based | Promise Chain |
|--------|-------------|---------------|
| **Visibility** | ✅ Can inspect queue contents, size, ages | ❌ Chain is opaque, can't see pending work |
| **Debugging** | ✅ Can log/trace each trigger's journey | ❌ Harder to trace through promise chain |
| **Cancellation** | ✅ Can remove items from queue | ❌ Can't cancel pending promises easily |
| **Metrics** | ✅ Queue depth, age, backpressure | ❌ Only know if chain is executing or not |
| **Memory** | ✅ Explicit limits, drop policy | ❌ Memory grows unbounded with chain length |
| **Error Recovery** | ✅ Can handle per-trigger errors | ✅ Similar - catch per-link |
| **Complexity** | ⚠️ More code | ✅ Less code |
| **Semantics** | ✅ "Work queue" is intuitive | ⚠️ "Promise chain" less obvious |

#### Why Queue is Better Here

1. **Visibility for debugging**: "Why is this chronicler slow?" → Check queue depth
2. **Memory control**: Can limit queue size, drop old triggers
3. **Metrics**: Can expose queue depth to ChroniclerManager for health monitoring
4. **Future features**: Priority queues, cancellation, scheduling
5. **Clear semantics**: Queue maps directly to mental model of "pending work"

#### When Promise Chain Would Be Better

- Very simple use case (always immediate execution)
- No need for visibility or metrics
- No memory concerns
- Prefer minimal code

**For chroniclers with batching strategies and future extensibility, queue-based wins.**

### Q2: What Happens When a Chronicler is Destroyed?

**TL;DR: Drop remaining triggers (don't execute). Destruction means "stop working NOW."**

#### Design Decision: Drop All Pending Triggers

```typescript
public destroy(): void {
  // 1. Stop accepting new triggers
  this.destroyTimers(); // Clears debounce/timeWindow timers

  // 2. Clear any strategy-specific buffers
  this.pendingEvents = [];
  this.pendingDebounce = undefined;

  // 3. Drop the entire queue
  const droppedCount = this.triggerQueue.length;
  this.triggerQueue = [];

  if (droppedCount > 0) {
    this.logger?.log(
      `[Chronicler:${this.config.id}] Destroyed with ${droppedCount} pending triggers dropped`,
      'info'
    );
  }

  // 4. Reset trigger engine
  this.triggerEngine.reset();

  // 5. DO NOT wait for queue to drain - we're destroying
  this.isProcessingQueue = false;
  this.queueProcessingPromise = undefined;

  this.logger?.log(`[Chronicler:${this.config.id}] Destroyed.`, 'debug');
}
```

#### Why Drop, Not Execute?

**Semantics of Destruction**:
- `destroy()` is called during:
  - Chronicler unloading (due to errors)
  - Phase completion
  - Server shutdown
- In all cases, the intent is "stop this chronicler NOW"
- Executing remaining triggers would delay destruction

**Flush vs Destroy**:
- `flush()` = "Process all pending work before phase ends" (graceful)
- `destroy()` = "Stop immediately, we're done with you" (forceful)

**Typical Lifecycle**:
```
Phase Ending:
1. manager.flush() - Wait for all triggers to complete
2. Phase completes
3. manager.shutdown() -> destroy() - Drop any new triggers that arrived during flush
```

#### Alternative: Configurable Behavior

Could make it configurable if needed:

```typescript
interface ChroniclerConfig {
  // ...
  onDestroy?: 'flush' | 'drop'; // Default: 'drop'
}

public destroy(): void {
  if (this.config.onDestroy === 'flush') {
    // This is actually problematic - destroy should be synchronous
    // Would need to return Promise<void> which changes API
    this.logger?.log(
      `[Chronicler:${this.config.id}] Flushing ${this.triggerQueue.length} triggers before destroy`,
      'warn'
    );
    // ... but we can't await here without changing signature
  } else {
    // Drop (default)
    const droppedCount = this.triggerQueue.length;
    this.triggerQueue = [];
    this.logger?.log(
      `[Chronicler:${this.config.id}] Dropped ${droppedCount} triggers on destroy`,
      'info'
    );
  }
}
```

**Recommendation: Keep destroy() synchronous and always drop. Use flush() before destroy() if needed.**

### Q3: Strategy Scenarios - When Does Each Queue vs Execute?

Let me walk through concrete timelines for each strategy showing when triggers are queued vs executed.

#### Immediate Strategy

**Behavior**: Every trigger match immediately queues and processes.

**Timeline**:
```
T+0ms:   Event A arrives → Trigger matches → Queue trigger 1 → Start processing
T+100ms: Trigger 1 executing (LLM call in progress)
T+150ms: Event B arrives → Trigger matches → Queue trigger 2 → Wait (still processing 1)
T+200ms: Event C arrives → Trigger matches → Queue trigger 3 → Wait (still processing 1)
T+5000ms: Trigger 1 completes → Start processing trigger 2
T+10000ms: Trigger 2 completes → Start processing trigger 3
T+15000ms: Trigger 3 completes → Queue empty
```

**Queue State Over Time**:
```
T+0ms:    Queue: [Trigger1] (processing)
T+150ms:  Queue: [Trigger1*] [Trigger2] (* = currently processing)
T+200ms:  Queue: [Trigger1*] [Trigger2] [Trigger3]
T+5000ms: Queue: [Trigger2*] [Trigger3]
T+10000ms: Queue: [Trigger3*]
T+15000ms: Queue: []
```

**Key Point**: With immediate, every event creates a separate trigger. Queue provides serialization.

#### Debounce Strategy (2000ms)

**Behavior**: Accumulate events during quiet period, then execute once.

**Timeline**:
```
T+0ms:    Event A arrives → Trigger matches → Start debounce timer (2000ms)
T+500ms:  Event B arrives → Trigger matches → Add to accumulator, reset timer
T+1000ms: Event C arrives → Trigger matches → Add to accumulator, reset timer
T+1500ms: Event D arrives → Trigger matches → Add to accumulator, reset timer
          [No more events for 2000ms]
T+3500ms: Debounce timer fires → Queue trigger with [A,B,C,D] → Start processing
T+8500ms: Trigger completes → Queue empty
```

**Accumulator State Over Time**:
```
T+0ms:    Accumulator: [A]           Timer: 2000ms
T+500ms:  Accumulator: [A,B]         Timer: 2000ms (reset)
T+1000ms: Accumulator: [A,B,C]       Timer: 2000ms (reset)
T+1500ms: Accumulator: [A,B,C,D]     Timer: 2000ms (reset)
T+3500ms: Accumulator cleared → Queue: [Trigger{A,B,C,D}*]
T+8500ms: Queue: []
```

**Key Point**: Debounce batches multiple events into a single trigger. Queue still provides ordering if multiple batches arrive.

**Multiple Batches**:
```
T+0ms:    Events [A,B,C] arrive in burst → Accumulator: [A,B,C]
T+2000ms: Timer fires → Queue trigger 1 → Start processing
T+2500ms: Events [D,E] arrive → Accumulator: [D,E] (new batch)
          Trigger 1 still executing (in queue)
T+4500ms: Timer fires → Queue trigger 2 → Wait (still processing 1)
T+7000ms: Trigger 1 completes → Start processing trigger 2
T+12000ms: Trigger 2 completes → Queue empty
```

#### Count Strategy (threshold = 3)

**Behavior**: Accumulate events until threshold reached, then execute.

**Timeline**:
```
T+0ms:    Event A arrives → Trigger matches → Buffer: [A] (1/3)
T+500ms:  Event B arrives → Trigger matches → Buffer: [A,B] (2/3)
T+1000ms: Event C arrives → Trigger matches → Buffer: [A,B,C] (3/3)
          → Threshold reached → Queue trigger 1 → Start processing
T+1500ms: Event D arrives → Trigger matches → Buffer: [D] (1/3)
          Trigger 1 still executing
T+2000ms: Event E arrives → Trigger matches → Buffer: [D,E] (2/3)
T+2500ms: Event F arrives → Trigger matches → Buffer: [D,E,F] (3/3)
          → Queue trigger 2 → Wait (still processing 1)
T+6000ms: Trigger 1 completes → Start processing trigger 2
T+11000ms: Trigger 2 completes → Queue empty
          Buffer: [] (empty)
```

**Buffer/Queue State Over Time**:
```
T+0ms:    Buffer: [A]           Queue: []
T+500ms:  Buffer: [A,B]         Queue: []
T+1000ms: Buffer: []            Queue: [Trigger1{A,B,C}*]
T+1500ms: Buffer: [D]           Queue: [Trigger1*]
T+2000ms: Buffer: [D,E]         Queue: [Trigger1*]
T+2500ms: Buffer: []            Queue: [Trigger1*] [Trigger2{D,E,F}]
T+6000ms: Buffer: []            Queue: [Trigger2*]
T+11000ms: Buffer: []           Queue: []
```

**Key Point**: Count creates fixed-size batches. Queue ensures batches process in order.

**Partial Batch on Flush**:
```
T+0ms:    Event A arrives → Buffer: [A] (1/3)
T+500ms:  Event B arrives → Buffer: [A,B] (2/3)
T+1000ms: flush() called → Queue trigger with [A,B] → Process
          Even though threshold not reached, flush forces trigger
```

#### TimeWindow Strategy (5000ms)

**Behavior**: Collect events in fixed time windows, execute at end of each window.

**Timeline**:
```
T+0ms:    Event A arrives → Start window timer (5000ms) → Buffer: [A]
T+1000ms: Event B arrives → Buffer: [A,B]
T+2000ms: Event C arrives → Buffer: [A,B,C]
T+5000ms: Window closes → Queue trigger 1 → Start processing → Start new window
T+6000ms: Event D arrives → Buffer: [D] (new window)
T+7000ms: Trigger 1 still executing
T+10000ms: Window closes → Queue trigger 2 → Wait (still processing 1)
          Start new window
T+12000ms: Trigger 1 completes → Start processing trigger 2
T+17000ms: Trigger 2 completes → Queue empty
T+15000ms: Window closes → No events → Nothing queued
```

**Buffer/Queue State Over Time**:
```
T+0-5000ms:   Window 1: Buffer: [A,B,C]     Queue: []
T+5000ms:     Window 2: Buffer: []          Queue: [Trigger1{A,B,C}*]
T+5-10000ms:  Window 2: Buffer: [D]         Queue: [Trigger1*]
T+10000ms:    Window 3: Buffer: []          Queue: [Trigger1*] [Trigger2{D}]
T+10-15000ms: Window 3: Buffer: []          Queue: [Trigger1*] [Trigger2]
T+12000ms:    Window 3: Buffer: []          Queue: [Trigger2*]
T+15000ms:    Window 4: Buffer: []          Queue: []
```

**Key Point**: TimeWindow creates triggers on a fixed schedule regardless of event arrival. Queue ensures windows process in order even if LLM calls take longer than window duration.

**Critical Difference from Debounce**:
- **Debounce**: "Wait for quiet period, then fire" (variable timing)
- **TimeWindow**: "Fire every N ms, regardless of activity" (fixed timing)

#### Mixed Strategy Scenario

**Real-world example: Narrative chronicler with debounce**

```
Scenario: User debugging a complex issue with lots of tool calls

T+0ms:     Read file A → Trigger → Debounce starts (2000ms)
T+100ms:   Read file B → Trigger → Add to batch, reset debounce
T+500ms:   Write file C → Trigger → Add to batch, reset debounce
T+800ms:   Read file D → Trigger → Add to batch, reset debounce
T+1200ms:  Execute command → Trigger → Add to batch, reset debounce
           [User pauses to think]
T+3200ms:  Debounce fires → Queue trigger with 5 events → Start LLM call
           (Chronicler now summarizing: "User is examining files A,B,D and modifying C...")
T+4000ms:  Read file E → Trigger → New batch starts
T+5000ms:  Write file F → Trigger → Add to batch, reset debounce
           First trigger still executing (LLM call takes ~10s for narrative)
T+7000ms:  Debounce fires → Queue second trigger → WAITS in queue
           This is the key: Second batch doesn't interrupt first
T+13200ms: First trigger completes → Second trigger starts
           (Chronicler continues: "Then user examined file E and modified F...")
T+23200ms: Second trigger completes

Result: Narrative is coherent and in order, despite variable LLM timing
```

#### Summary Table

| Strategy | When Queued | Batch Size | Timing | Queue Benefit |
|----------|-------------|------------|--------|---------------|
| **Immediate** | Every match | 1 event | Instant | Serializes rapid-fire triggers |
| **Debounce** | After quiet period | Variable | Event-driven | Orders multiple batches |
| **Count** | Every N events | Fixed | Event-driven | Orders batches, handles partials |
| **TimeWindow** | Every N ms | Variable | Time-driven | Handles slow LLM calls |

**Common Thread**: All strategies create triggers at different times/sizes, but the queue ensures they execute in order within each chronicler.

---

## Critical Design Clarifications

### Naming: flush() → completeAllWork()

**YES, absolutely rename it.** The name `flush()` is confusing because:
- It doesn't flush to disk
- It doesn't flush a single buffer
- It actually does two distinct things: finalizes buffers AND waits for queue

**Better name: `completeAllWork()`** because it:
1. Stops creating new triggers (timers)
2. Converts partial buffers into final triggers
3. Waits for queue to drain

**API Change**:
```typescript
// OLD (confusing)
async flush(): Promise<void>

// NEW (clear)
async completeAllWork(): Promise<void>
```

**ChroniclerManager calls it**:
```typescript
// OLD
async shutdown(): Promise<void> {
  await this.flush(); // Unclear what this does
  // ...
}

// NEW
async shutdown(): Promise<void> {
  await this.completeAllWork(); // Crystal clear: finish pending work
  // ...
}
```

### Timestamp for Templates: trigger.queuedAt is Critical

**YES, you're exactly right.** The Date object in the template context MUST be `trigger.queuedAt`, not the current time when templating happens.

**Why This Matters**:

```typescript
Scenario: Debounce chronicler that includes timestamps in output

T+0ms:     Events arrive, debounce starts
T+2000ms:  Debounce fires → Queue trigger with queuedAt = T+2000ms
T+2100ms:  Another trigger is executing (queue busy)
T+8000ms:  First trigger STARTS executing (6 seconds late!)

If we use new Date() for templating:
  Template sees: "Events at 10:00:08" ❌ WRONG (execution time)

If we use trigger.queuedAt:
  Template sees: "Events at 10:00:02" ✅ CORRECT (when debounce fired)
```

**Implementation Detail**:

```typescript
private async executeTrigger(trigger: QueuedTrigger): Promise<void> {
  const templateContext: TemplateContext = {
    events: trigger.events,
    phase: { /*...*/ },
    world: {
      // CRITICAL: Do NOT use new Date() here
      // This timestamp should reflect when the trigger HAPPENED,
      // not when we're executing it (which could be delayed)
      currentTime: trigger.queuedAt,
    },
  };

  // Templates now see the semantically correct time:
  // - For immediate: when event arrived
  // - For debounce: when quiet period ended
  // - For count: when threshold was hit
  // - For timeWindow: when window closed

  const userMessage = await TemplateRenderer.render(
    this.userPromptTemplate,
    templateContext
  );

  // Even if this render happens 10 seconds late due to queue,
  // the template will use trigger.queuedAt for <%= it.world.currentTime %>
}
```

**Example Template Usage**:

```eta
Summary of events that occurred at <%= it.world.currentTime.toISOString() %>:

<% for (const event of it.events) { %>
- <%= event.type %> (event timestamp: <%= event.timestamp %>)
<% } %>

Note: This summary was queued at the time shown above,
even if it's being executed later due to other work in progress.
```

**Without this design**: Templates would show execution time, making timestamps meaningless when queue is backed up.

**With this design**: Templates always show semantically correct time when the trigger occurred.

### Do We Need Both completeAllWork() AND destroy()?

**YES, keep both. They serve different purposes:**

```typescript
completeAllWork():
  Purpose: Graceful completion - "finish what you started"
  When: Phase ending, server shutdown (normal operation)
  Behavior:
    - Finalize buffers → triggers
    - Wait for queue to drain
    - No data loss

destroy():
  Purpose: Forceful cleanup - "stop NOW"
  When: Error unloading, emergency shutdown
  Behavior:
    - Clear timers
    - Drop queue
    - Immediate return
```

**Normal Lifecycle** (graceful):
```typescript
await chronicler.completeAllWork(); // Process everything
chronicler.destroy(); // Clean up (nothing to drop)
```

**Error Lifecycle** (forceful):
```typescript
chronicler.destroy(); // Drop pending work, cleanup immediately
```

**ChroniclerManager Pattern**:
```typescript
async shutdown(): Promise<void> {
  // Graceful: complete work for all chroniclers
  await this.completeAllWork(); // Calls completeAllWork() on each chronicler

  // Then forceful cleanup
  for (const chronicler of this.chroniclers) {
    chronicler.destroy(); // Should have nothing to drop after completeAllWork()
  }
}
```

**Key Insight**: Having both methods provides:
- Clear separation of concerns
- Flexibility for different shutdown scenarios
- No accidental data loss (must explicitly choose to drop)

---

## Testing Strategy

### Tests to Write

#### Unit Tests (`tests/unit/`)

**1. Queue Mechanics Tests** (new file: `chronicler-queueing.test.ts`)
```typescript
describe("Trigger Queue Mechanics", () => {
  test("queues triggers in FIFO order")
  test("processes triggers serially (one at a time)")
  test("enforces MAX_QUEUE_SIZE limit")
  test("drops oldest trigger on overflow")
  test("tracks queuedAt timestamp correctly")
  test("handles empty queue gracefully")
  test("clears queue on destroy()")
});

describe("Queue Processing", () => {
  test("processQueue() sets isProcessingQueue flag")
  test("processQueue() completes even if trigger fails")
  test("processQueue() propagates ChroniclerFatalError for unloading")
  test("processQueue() continues for regular errors")
  test("queueProcessingPromise is set/unset correctly")
});
```

**2. Strategy Integration Tests** (update: `chronicler-logic.test.ts`)
```typescript
describe("Strategy Queueing Behavior", () => {
  test("immediate: creates one trigger per event")
  test("debounce: queues when timer fires, not on every event")
  test("count: queues when threshold reached")
  test("timeWindow: queues on schedule regardless of events")
  test("pending buffers converted to triggers on completeAllWork()")
});

describe("Debounce with Queueing", () => {
  test("accumulates events in pendingDebounce")
  test("resets timer on new events")
  test("queues single trigger when timer fires")
  test("multiple batches queue sequentially")
  test("completeAllWork() converts pending debounce to trigger")
});

describe("Count with Queueing", () => {
  test("buffers events until threshold")
  test("queues trigger at threshold")
  test("handles multiple batches in one call")
  test("completeAllWork() queues partial batch")
});

describe("TimeWindow with Queueing", () => {
  test("starts window on first event")
  test("accumulates during window")
  test("queues on window close")
  test("schedules next window")
  test("slow LLM doesn't delay next window")
});
```

**3. completeAllWork() Tests** (new in `chronicler-logic.test.ts`)
```typescript
describe("completeAllWork() method", () => {
  test("stops time-based trigger creation (timers)")
  test("converts pending debounce to trigger")
  test("converts partial count buffer to trigger")
  test("waits for queue to drain completely")
  test("handles empty queue gracefully")
  test("handles queue with multiple triggers")
  test("completes even if triggers error")
  test("can be called multiple times safely")
});
```

**4. destroy() Behavior Tests** (update: `chronicler-logic.test.ts`)
```typescript
describe("destroy() with queueing", () => {
  test("drops all queued triggers")
  test("logs dropped trigger count")
  test("clears pendingEvents buffer")
  test("clears pendingDebounce")
  test("stops all timers")
  test("resets isProcessingQueue flag")
  test("is synchronous (returns immediately)")
  test("doesn't wait for queue to drain")
});
```

**5. Timestamp Tests** (new in `chronicler-queueing.test.ts`)
```typescript
describe("Template Timestamp Correctness", () => {
  test("uses trigger.queuedAt for world.currentTime")
  test("immediate: queuedAt equals event arrival time")
  test("debounce: queuedAt equals when timer fired")
  test("count: queuedAt equals when threshold hit")
  test("timeWindow: queuedAt equals window close time")
  test("delayed execution still uses original queuedAt")
});
```

#### Integration Tests (`tests/integration/`)

**6. Serial Execution Tests** (update: `chronicler-edge-cases.test.ts`)
```typescript
describe("Serial Execution Guarantees", () => {
  test("immediate strategy: rapid events execute in order")
  test("debounce strategy: batches execute in order")
  test("count strategy: batches execute in order")
  test("timeWindow strategy: windows execute in order")
  test("mixed strategies: each chronicler processes serially")
});
```

**7. Conversational Ordering Tests** (update: `chronicler-conversational.test.ts`)
```typescript
describe("Conversational History Ordering with Queue", () => {
  test("messages added in correct order despite queue delays")
  test("trigger A (slow) completes before trigger B starts")
  test("history reflects actual conversation sequence")
  test("no race conditions when LLM calls have variable timing")
});
```

**8. Flush/Complete Tests** (new section in `chronicler-edge-cases.test.ts`)
```typescript
describe("completeAllWork() Integration", () => {
  test("completes all debounce work before returning")
  test("completes all count work before returning")
  test("completes all timeWindow work before returning")
  test("handles mixed strategies across chroniclers")
  test("no events dropped during phase completion")
  test("works correctly with ChroniclerManager.completeAllWork()")
});
```

**9. Memory and Performance Tests** (new in `chronicler-queueing.test.ts`)
```typescript
describe("Memory Management", () => {
  test("enforces MAX_QUEUE_SIZE (100 triggers)")
  test("enforces MAX_BUFFER_SIZE (10000 events)")
  test("drops oldest trigger on queue overflow")
  test("logs backpressure warnings at 70% full")
  test("doesn't leak memory with rapid queueing")
  test("handles 1000+ queued triggers without crash")
});

describe("Performance", () => {
  test("queue operations are O(1) for enqueue/dequeue")
  test("processing 100 triggers completes in reasonable time")
  test("no significant latency added by queueing")
  test("backpressure warnings don't spam logs")
});
```

### Tests to Update/Remove

#### Files Requiring Updates

**1. `tests/unit/chronicler-logic.test.ts`**
- ✅ Keep: Basic LLM interaction tests
- ✅ Keep: Template rendering tests
- ✅ Keep: Strategy behavior tests
- ⚠️ Update: Remove/update tests that assume immediate execution
- ⚠️ Update: Tests that check `isFlushing` flag (remove - flag no longer exists)
- ➕ Add: Queue-aware versions of strategy tests

**2. `tests/integration/chronicler-edge-cases.test.ts`**
- ✅ Keep: Empty log handling
- ✅ Keep: No-match scenarios
- ⚠️ Update: Debounce tests to account for queueing
- ⚠️ Update: Tests that verify "events dropped during flush" (should now pass with no drops)
- ➕ Add: Queue overflow scenarios
- ➕ Add: Serial execution verification

**3. `tests/integration/chronicler-conversational.test.ts`**
- ✅ Keep: History persistence tests
- ✅ Keep: Trimming strategy tests
- ⚠️ Update: Add tests verifying no race conditions in history
- ➕ Add: Ordered execution verification for conversational flow

**4. `tests/integration/chronicler-triggers.test.ts`**
- ✅ Keep: Basic trigger matching tests
- ⚠️ Update: Timing assertions (queue adds latency)
- ➕ Add: Queue behavior verification for each strategy

**5. `tests/unit/chronicler-manager.test.ts`**
- ✅ Keep: Initialization and shutdown tests
- ⚠️ Update: `flush()` calls → `completeAllWork()`
- ➕ Add: Tests for parallel chronicler execution with serial internal processing

### Behaviors to Test

#### Critical Behaviors (Must Test)

1. **Serial Execution Within Chronicler**
   - Trigger N fires → starts execution
   - Trigger N+1 fires → queued, waits
   - Trigger N completes → Trigger N+1 starts
   - No concurrent execution within single chronicler

2. **Timestamp Semantic Correctness**
   - Template receives `trigger.queuedAt`, not execution time
   - Debounce: timestamp = when quiet period ended
   - Count: timestamp = when threshold hit
   - TimeWindow: timestamp = when window closed
   - Delayed triggers still show correct original time

3. **Graceful Completion**
   - `completeAllWork()` finalizes all buffers
   - `completeAllWork()` waits for queue to drain
   - No events lost during phase completion
   - ChroniclerManager waits for all chroniclers

4. **Destruction Behavior**
   - `destroy()` drops queue immediately
   - Logs dropped trigger count
   - Never waits for queue (synchronous)
   - Lifecycle: completeAllWork() then destroy()

5. **Memory Limits**
   - Queue overflow drops oldest trigger
   - MAX_QUEUE_SIZE enforced (100)
   - MAX_BUFFER_SIZE enforced (10000 events)
   - Backpressure warnings at 70%

#### Edge Cases (Should Test)

1. **Queue Overflow Scenarios**
   - What happens when 101st trigger queued
   - Rapid event burst with slow LLM
   - Multiple strategies overflowing simultaneously

2. **Error During Queue Processing**
   - Regular error: log, continue to next trigger
   - Fatal error: propagate for unloading decision
   - Error doesn't stop queue processing

3. **Shutdown/Flush Edge Cases**
   - completeAllWork() called twice in a row
   - destroy() called twice
   - destroy() while queue processing
   - completeAllWork() while already completing

4. **Mixed Strategy Coordination**
   - Immediate + debounce in same chronicler (impossible, but validate)
   - Multiple chroniclers with different strategies
   - Queue interactions across strategies

5. **Conversational Edge Cases**
   - Slow first trigger delays second trigger
   - History still correct despite delay
   - No message pair corruption

#### Race Conditions We're Preventing (Verify Fixed)

1. ~~Events dropped during flush~~ → Events queued, never dropped
2. ~~Out-of-order LLM responses~~ → Queue ensures serial execution
3. ~~Conversational history corruption~~ → Queue ensures ordered message pairs
4. ~~Timestamp inconsistency~~ → trigger.queuedAt provides consistency

### Test Metrics and Coverage

**Target Coverage:**
- Unit test coverage: 95%+ of new queue code
- Integration test coverage: All strategies with queueing
- Edge case coverage: All identified edge cases above

**Test Count Estimates:**
- New unit tests: ~25-30 tests
- Updated unit tests: ~15-20 tests
- New integration tests: ~10-15 tests
- Updated integration tests: ~10 tests
- **Total new/updated: ~60-75 tests**

**Files to Create:**
- `tests/unit/chronicler-queueing.test.ts` (new)

**Files to Update:**
- `tests/unit/chronicler-logic.test.ts`
- `tests/unit/chronicler-manager.test.ts`
- `tests/integration/chronicler-edge-cases.test.ts`
- `tests/integration/chronicler-conversational.test.ts`
- `tests/integration/chronicler-triggers.test.ts`

**Files to Review (likely no changes):**
- `tests/unit/chronicler-validation.test.ts` (config validation, unchanged)
- `tests/unit/chronicler-configs.test.ts` (file validation, unchanged)
- `tests/integration/chronicler-templating.test.ts` (template engine, unchanged)
- `tests/integration/chronicler-fatal-errors.test.ts` (error handling, mostly unchanged)

### Testing Approach

**Phase 1: Unit Tests for Queue Infrastructure**
1. Write queue mechanics tests first
2. Test enqueue/dequeue operations
3. Test overflow and memory limits
4. Test timestamp handling

**Phase 2: Strategy Integration Tests**
5. Update existing strategy tests for queueing
6. Verify each strategy queues correctly
7. Test completeAllWork() with each strategy
8. Test destroy() behavior

**Phase 3: Integration Tests for Serial Execution**
9. Test serial execution within chronicler
10. Test parallel execution across chroniclers
11. Test mixed strategy scenarios
12. Test real-world event sequences

**Phase 4: Edge Case and Regression Tests**
13. Test all identified edge cases
14. Verify race conditions are fixed
15. Test error handling in queue processing
16. Test memory and performance characteristics

**Phase 5: Conversational Flow Tests**
17. Test history ordering with queue
18. Test slow triggers don't corrupt history
19. Test timestamp consistency in conversations
20. Test recovery scenarios

### Success Criteria

**All tests pass** with:
- No dropped events (verify with assertions)
- Correct serial execution (verify with timing/sequencing)
- Correct timestamps in templates (verify with captured prompts)
- Memory limits enforced (verify with overflow tests)
- Graceful completion (verify with completeAllWork() tests)
- Clean destruction (verify with destroy() tests)

**Performance benchmarks**:
- Queue operations < 1ms per operation
- No significant latency vs current implementation
- Memory usage stable under load
- Backpressure warnings only when needed
