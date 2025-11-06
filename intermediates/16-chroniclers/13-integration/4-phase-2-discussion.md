# Phase 2 Integration - Design Discussion

## Context

Phase 1 integrated chroniclers into Tadpole server. They load, receive events, and write outputs to files. However, they're currently "invisible" to the main event stream and state system. Phase 2 aims to make chroniclers observable and trackable.

---

## Design Decisions (From Discussion)

**DECIDED:**
1. ✅ Fatal chronicler errors should be passed through websocket events
2. ✅ Create new "Chronicler Events" category (persisted, broadcasted, available in history - same as Server State Events but explicitly categorized for filtering)
3. ✅ Config naming: `reportToWebsocket` (not `reporting`)
4. ✅ Config hierarchy: Settings at chronicler level AND phase level (phase overrides chronicler)
5. ✅ Outputs ON by default, no truncation parameter
6. ✅ Include sequencing metadata (trigger number) in chronicler events
7. ✅ Rename "ChroniclerSnapshot" to "ChroniclerState" (since it's mutable, not immutable)
8. ✅ Add `totalTriggers` count to chronicler state
9. ✅ Trigger events are only for successful triggers (not all trigger attempts)
10. ✅ No batching of chronicler events
11. ✅ Use `completing-chroniclers` phase status (like in Phase 1 spec) for state transitions
12. ✅ Optional parameters with defaults for API cleanup

---

## Question 1: Chronicler Events to Stream

### 1.1 What Events Do We Need?

**Lifecycle Events** (High Priority):
1. **chronicler.loaded** - When chronicler successfully loads
   - `chroniclerId`: string
   - `phaseId`: string
   - `model`: string
   - `triggerType`: "event" | "sequence"
   - `executionStrategy`: "immediate" | "debounce" | "count" | "timeWindow"
   - `conversational`: boolean
   - `source`: "file" | "inline" (from config loader)
   - `sourcePath?`: string (for file-based)

2. **chronicler.unloaded** - When chronicler is unloaded
   - `chroniclerId`: string
   - `phaseId`: string
   - `reason`: "phase-complete" | "fatal-error" | "consecutive-failures" | "shutdown"
   - `errorType?`: "template" | "configuration" | "corruption" | "resource" (if error)
   - `finalCost`: number
   - `llmCallCount`: number (how many times it called LLM)

**Error Events** (High Priority):
3. **chronicler.error** - Non-fatal errors
   - `chroniclerId`: string
   - `phaseId`: string
   - `errorType`: "llm-call-failed" | "template-render-failed" | "file-write-failed"
   - `message`: string
   - `retriable`: boolean
   - `consecutiveFailureCount`: number

**Output Events** (Medium Priority):
4. **chronicler.output** - When chronicler produces output
   - `chroniclerId`: string
   - `phaseId`: string
   - `triggerNumber`: number (sequence number: 1st trigger, 2nd trigger, etc.)
   - `outputType`: "text" | "structured"
   - `content`: string | object (the actual output, no truncation)
   - `cost`: number (cost of this specific LLM call)
   - `tokens`: { input: number; output: number }
   - `eventCount`: number (how many events triggered this)

**Activity Events** (Low Priority):
5. **chronicler.triggered** - When trigger successfully fires (before LLM call)
   - `chroniclerId`: string
   - `phaseId`: string
   - `triggerNumber`: number (sequence number: 1st trigger, 2nd trigger, etc.)
   - `strategy`: execution strategy
   - `eventCount`: number (how many events in this trigger)
   - `queueSize`: number (current queue depth)

**Note on Sequencing**: The `triggerNumber` is a simple sequential counter (1, 2, 3...) maintained by each Chronicler instance. It provides ordering for clients and allows correlation between chronicler.triggered and chronicler.output events - both events from the same trigger execution will have the same triggerNumber.

**Note on Trigger Events**: Only emitted for successful triggers (when trigger conditions match and execution begins), not for match failures.

### 1.2 Event Categorization - New Chronicler Events Category

Create a new fourth event category: **Chronicler Events**
- ✅ Persisted to event journal
- ✅ Broadcasted to all clients
- ✅ Available in history sync
- ✅ Explicitly categorized for easy filtering

**Why separate category?**
- Clear distinction from Server State, Agentic Backbone, and Connection State
- Chroniclers can be filtered out if needed (observers, not participants)
- Maintains clean event architecture while making chroniclers first-class citizens

**Implementation:**
```typescript
// In event-schemas.ts
const CHRONICLER_EVENT_TYPES = new Set<ServerEventType>([
  "chronicler.loaded",
  "chronicler.unloaded",
  "chronicler.error",
  "chronicler.output",
  "chronicler.triggered",
]);

export function isChroniclerEvent(event: ServerEvent): event is ChroniclerEvent {
  return CHRONICLER_EVENT_TYPES.has(event.type);
}

// Treatment same as Server State Events for journaling/broadcasting
export function isJournaledEvent(event: ServerEvent): boolean {
  return isServerStateEvent(event) || isAgenticBackboneEvent(event) || isChroniclerEvent(event);
}
```

### 1.3 Configurability - Two-Level Configuration with Override

**Chronicler-Level Config** (base settings):
```typescript
interface ChroniclerConfig {
  reportToWebsocket?: {
    lifecycle?: boolean;        // Default: true
    errors?: boolean;           // Default: true
    outputs?: boolean;          // Default: true
    triggers?: boolean;         // Default: false
  }
}
```

**Phase-Level Config** (can override chronicler settings):
```typescript
interface PhaseChroniclerEntry {
  chroniclerConfig: string | ChroniclerConfig;
  settings?: {
    failPhaseIfNotLoaded?: boolean;
    outputPaths?: { ... };
    reportToWebsocket?: {
      lifecycle?: boolean;
      errors?: boolean;
      outputs?: boolean;
      triggers?: boolean;
    };
  };
}
```

**Override Behavior:**
- Phase-level settings override chronicler-level settings
- Allows reusable chronicler configs with phase-specific control
- Example: Chronicler has outputs=true, phase can disable with outputs=false

**Default Values**:
- **lifecycle: true** - Users want to know what chroniclers are running
- **errors: true** - Critical for debugging
- **outputs: true** - Full visibility by default, no truncation
- **triggers: false** - Verbose (only for successful triggers), opt-in for debugging

### 1.4 Answered Questions from Original Discussion

**Q1**: Should chronicler.output include the full content or just metadata?
- ✅ **DECIDED**: Full content, NO truncation (decision #5)

**Q2**: Do we emit chronicler.triggered for every trigger or only failed ones?
- ✅ **DECIDED**: Every SUCCESSFUL trigger, configurable via reportToWebsocket.triggers, default OFF (decision #9)

**Q3**: Should we batch chronicler events (e.g., one event per phase with all outputs)?
- ✅ **DECIDED**: Per-output, no batching (decision #10)

---

## Question 2: Chronicler State in state.json

### 2.1 Current State Structure

```typescript
interface TadpoleState {
  runs: Run[];              // Array of runs
  currentRunId: RunId | null;
  initialCheckpoint?: string;
}

interface Run {
  runId: RunId;
  phases: PhaseExecution[]; // Array of phases
  // ... other fields
}

interface PhaseExecution {
  phaseId: PhaseId;
  status: PhaseStatus;
  // ... status-specific fields
}
```

**Design principle**: "Only store what's expensive to aggregate from events"
- Run metadata: Stored (would need full history scan)
- Phase costs: Stored (computed during execution)
- Total costs: Computed on-demand (simple sum)

### 2.2 Chronicler State Design - Per-Phase Summary

```typescript
interface RunningPhase extends BasePhase {
  chroniclers?: {
    loaded: ChroniclerState[];
    totalCost: number;
  }
}

interface CompletedPhase extends BasePhase {
  chroniclers?: {
    executed: ChroniclerState[];
    totalCost: number;
  }
}

interface FailedPhase extends BasePhase {
  chroniclers?: {
    executed: ChroniclerState[];
    totalCost: number;
  }
}

interface SkippedPhase extends BasePhase {
  chroniclers?: {
    executed: ChroniclerState[];
    totalCost: number;
  }
}

interface ChroniclerState {
  id: string;
  model: string;
  loadedAt: string;
  unloadedAt?: string;
  llmCallCount: number;
  failedLLMCalls: number;
  lastLlmCallAt?: string;
  totalTriggers: number;
  totalCost: number;
  status: "active" | "unloaded";
  unloadReason?: "phase-complete" | "fatal-error" | "consecutive-failures";
}
```

**What to track**:
- ID, model (identity)
- Timestamps (when active)
- LLM call counts (successful and failed)
- Trigger count (activity level)
- Cost (billing)
- Status (currently active or unloaded)

**What NOT to track**:
- Queue size (too transient)
- Event count (can compute from events)
- Output content (stored in files)

### 2.3 How State is Updated

**Stored in**:
- `RunningPhase.chroniclers` (while active - field name: `loaded`)
- `CompletedPhase.chroniclers` (final state - field name: `executed`)
- `FailedPhase.chroniclers` (if phase failed with chroniclers - field name: `executed`)
- `SkippedPhase.chroniclers` (if phase skipped with chroniclers - field name: `executed`)

**How State is Updated**:
Since `ChroniclerState` is mutable (not a snapshot), it gets updated in place during phase execution:

1. **Chronicler Loads**: ChroniclerState added to `phase.chroniclers.loaded[]`
2. **During Execution**: Same ChroniclerState object updated (llmCallCount++, totalTriggers++, etc.)
3. **Chronicler Unloads**: ChroniclerState updated with unloadedAt, unloadReason, status="unloaded"
4. **Phase Completes**: Field renamed from `loaded` → `executed` during phase transition to terminal state

**State Updates Happen Via**:
- Phase transition to `completing-chroniclers` status (NEW phase status)
- Chronicler data is metadata in existing phase transitions (no separate chronicler transitions)
- ChroniclerState objects updated in place during `completing-chroniclers` state

**Queried for**:
- UI: "Which chroniclers are running?"
- Debugging: "Did chronicler X run in phase Y?"
- Billing: "How much did chroniclers cost in this phase?"
- Analytics: "How active are chroniclers?"

### 2.4 State Transition Design

No new top-level state transitions for chroniclers. Use the existing `completing-chroniclers` phase status from Phase 1 spec.

**Phase Status Flow**:
```
preparing → starting → initializing → running → completing-chroniclers → completed/failed/skipped
```

**When `running` → `completing-chroniclers` happens**:
- Claude process has exited
- Main agent work is done
- Chroniclers still processing queued triggers

**Chronicler metadata added to PhaseTransitioned**:
```typescript
type StateTransition =
  | {
      type: "PhaseTransitioned";
      data: {
        runId: RunId;
        phaseId: PhaseId;
        from: PhaseStatus;
        to: PhaseStatus;
        metadata?: {
          chroniclerStates?: ChroniclerState[];
          chroniclerTotalCost?: number;
        };
      };
    };
```

**Flow**:
1. Load Phase: TadpoleServer tracks loaded chroniclers locally
2. Running Phase: Chroniclers process events (all in memory)
3. Agent Finishes: Transition `running` → `completing-chroniclers`
4. Complete Chronicler Work: `manager.completeAllWork()` drains queues
5. Gather Final Data: Get costs, counts, triggers from ChroniclerManager
6. Final Transition: `completing-chroniclers` → terminal state with chronicler metadata

**Benefits**:
- No chronicler-specific transition types
- Chronicler data integrated into phase lifecycle
- State updates only at phase boundaries
- No per-LLM-call state churn

### 2.5 Answered Questions from Original Discussion

**Q1**: Do we track chronicler state for skipped/failed phases?
- ✅ **DECIDED**: YES - add chroniclers field to FailedPhase and SkippedPhase (decision #11)

**Q2**: Do we store individual LLM call details or just aggregates?
- ✅ **DECIDED**: Aggregates only (use completing-chroniclers phase status, no per-call transitions)

**Q3**: What if chronicler unloads mid-phase (consecutive failures)?
- ✅ **DECIDED**: ChroniclerState updated in place, marked as unloaded, phase continues with remaining chroniclers

---

## Question 3: Fallback LLM Call Pattern

### 3.1 Current Problem

```typescript
await manager.loadChroniclersForPhase(
  configs,
  phaseId,
  async () => ({ text: "", ... }),  // ← Fallback never used in prod
  configDir,
  runStartTime,
  undefined,
  async () => ({ object: {}, ... }), // ← Fallback never used in prod
  executionPath
);
```

**Issues**:
- Clutters call site with unused functions
- Confusing for readers ("when is this used?")
- Makes production code harder to read
- Only needed for tests

### 3.2 Solution: Optional Parameters with Defaults

**New Signature**:
```typescript
public async loadChroniclersForPhase(
  configs: ChroniclerConfig[],
  phaseId: PhaseId,
  options: {
    configDirectory?: string;
    runStartTime?: Date;
    executionPath?: string;
    llmCallOverride?: LlmCallFn;
    llmObjectCallOverride?: LlmObjectCallFn;
    onExecute?: ExecuteCallback;
  } = {}
): Promise<void>
```

**Usage**:
```typescript
// Production
await manager.loadChroniclersForPhase(configs, phaseId, {
  configDirectory: configDir,
  runStartTime,
  executionPath,
});

// Tests
await manager.loadChroniclersForPhase(configs, phaseId, {
  llmCallOverride: mockLlmCall,
  llmObjectCallOverride: mockObjectCall,
  onExecute: trackExecutions,
});
```

**Benefits**:
- Clean production code (just pass options object)
- Test hooks available when needed
- Named parameters (self-documenting)
- Optional everything (sensible defaults)

---

## Question 4: Additional Considerations

### 4.1 Event Volume Concerns

**Scenario**: Phase with 5 chroniclers, 1000 events
- If all triggers fire: 5000 chronicler.triggered events
- If all produce output: 5000 chronicler.output events

**Mitigation Strategies**:
1. **Default OFF for verbose events** (outputs, triggers)
2. **Sampling**: Only emit every Nth trigger/output
3. **Aggregation**: Batch outputs (e.g., per-minute summary)
4. **Filtering**: Client-side filtering in UI

**Recommendation**: Keep it simple
- Emit all lifecycle/error events (low volume)
- Make output events opt-in per-chronicler
- Add sampling later if needed

### 4.2 Event Ordering and Race Conditions

Chronicler events happen asynchronously to main agent events.

**Example**:
```
T=0: assistant.action emitted
T=1: Chronicler processes event
T=2: tool.result emitted
T=3: Chronicler emits chronicler.output
```

**Client sees**: assistant.action → tool.result → chronicler.output

**This is acceptable** because:
- Chroniclers are observers, not participants in main workflow
- Their events are commentary, not part of main execution flow
- Timestamp and triggerNumber allow reconstruction of causality
- triggerNumber correlates chronicler.triggered with chronicler.output from same execution

### 4.3 State Persistence Performance

**Concern**: Too many state transitions (every LLM call)?

**Current**:
- Every Claude LLM call → CostsIncremented transition
- Every assistant message → AssistantMessageCountUpdated transition

**If we add**:
- Every chronicler LLM call → ChroniclerLlmCallCompleted transition

**Impact**:
- More state writes (atomic, not expensive)
- Larger state.json (but still <10MB typically)
- More state.transition events

**Mitigation**:
- Only update on chronicler completion, not per-call
- Batch updates (update all chroniclers at once)
- Store just totals, not per-call breakdowns

**Recommendation**:
- ChroniclerLoaded: On load (once per chronicler)
- ChroniclerLlmCallCompleted: OPTIONAL, only if tracking needed
- ChroniclerUnloaded: On unload (once per chronicler)

### 4.4 Backward Compatibility

**State.json format change**:
- Adding `chroniclers?` field to phases
- Optional field (no breaking change)
- Old state.json files load fine (field missing = no chroniclers)

**Event stream change**:
- New event types (chronicler.*)
- Old clients ignore unknown events (WebSocket design)
- No breaking change

**Migration path**: Zero-downtime
- Deploy new server
- Old clients work (ignore new events)
- New clients show chronicler info
- Old state.json files upgrade on next write

---

## Question 5: Integration Points

### 5.1 Callback Pattern for Event Emission

Chroniclers don't have access to TadpoleServer.emit(), so we use callbacks.

```typescript
// Chronicler constructor accepts callback
class Chronicler {
  constructor(
    private onEvent?: (event: ChroniclerEvent) => void
  ) {}

  private async executeTextGeneration() {
    this.onEvent?.({
      type: "chronicler.output",
      data: {
        chroniclerId: this.getId(),
        phaseId: this.phaseId,
        triggerNumber: this.triggerCounter,
        outputType: "text",
        content: response.text,
        cost: callCost,
        tokens: { input: usage.inputTokens, output: usage.outputTokens },
        eventCount: trigger.events.length
      }
    });
  }
}

// ChroniclerManager sets up callback routing
class ChroniclerManager {
  private chroniclerEventCallback?: (event: ChroniclerEvent) => void;

  setEventCallback(callback: (event: ChroniclerEvent) => void) {
    this.chroniclerEventCallback = callback;
  }

  async loadChroniclersForPhase() {
    new Chronicler(config, this.chroniclerEventCallback);
  }
}

// TadpoleServer provides the callback
this.chroniclerManager.setEventCallback((chrEvent) => {
  this.emit("event", this.convertChroniclerEvent(chrEvent));
});
```

### 5.2 Emission Points in TadpoleServer

**After Loading Chroniclers**:
```typescript
// In startPhase(), after manager.loadChroniclersForPhase()
for (const chroniclerId of this.chroniclerManager.getChroniclerIds()) {
  this.emit("event", {
    type: "chronicler.loaded",
    data: { /* chronicler metadata */ }
  });
}
```

**During Completing-Chroniclers Transition**:
```typescript
// In handlePhaseComplete(), gather final chronicler states
const chroniclerStates = await this.chroniclerManager.getChroniclerStates();

// Transition with metadata
this.stateManager.transition({
  type: "PhaseTransitioned",
  from: "completing-chroniclers",
  to: "completed",
  metadata: {
    chroniclerStates,
    chroniclerTotalCost: chroniclerStates.reduce((sum, s) => sum + s.totalCost, 0)
  }
});
```

---

## Question 6: Testing Strategy

### 6.1 What Needs Testing

**Event Emission**:
- Chronicler.loaded emitted when loading succeeds
- Chronicler.error emitted on LLM failure
- Chronicler.output emitted (when enabled)
- Chronicler.unloaded emitted on completion
- Events have correct structure

**State Updates**:
- ChroniclerSnapshot added to phase on load
- Costs/counts update on LLM call
- Status updates on unload
- State persists correctly

**Edge Cases**:
- Multiple chroniclers in one phase
- Chronicler unloads mid-phase (errors)
- Chronicler with no LLM calls (never triggers)
- Phase fails before chroniclers load

### 6.2 Test Files Needed

**Unit Tests**:
1. `chronicler-events.test.ts` - Event structure validation
2. `chronicler-state-transitions.test.ts` - State updates

**Integration Tests**:
1. `chronicler-reporting.test.ts` - Event emission patterns
2. `chronicler-state-persistence.test.ts` - state.json updates

**E2E Tests**:
1. Modify `happy-path-e2e.test.ts` - Add chronicler to phase, verify events
2. Modify `rollback-e2e.test.ts` - Verify chronicler state on rollback

---

## Question 7: Configuration Examples

### 7.1 Chronicler Config with reportToWebsocket

```json
{
  "id": "narrator",
  "model": "anthropic/claude-3-5-sonnet-20241022",
  "trigger": { "type": "event", "on": ["assistant.action"] },
  "execution": { "strategy": "debounce", "milliseconds": 5000 },
  "userPromptText": "Summarize: <%= JSON.stringify(it.events) %>",
  "reportToWebsocket": {
    "lifecycle": true,
    "errors": true,
    "outputs": true,
    "triggers": false
  }
}
```

### 7.2 Phase Config with Override

```json
{
  "id": "analysis",
  "chroniclers": [
    {
      "chroniclerConfig": "./chroniclers/narrator.json",
      "settings": {
        "outputPaths": {
          "logFile": "analysis-narrative.md"
        },
        "reportToWebsocket": {
          "outputs": false  // Override: Disable output events for this phase
        }
      }
    },
    {
      "chroniclerConfig": {
        "id": "metrics-tracker",
        "model": "openai/gpt-4o-mini",
        "trigger": { "type": "event", "on": ["tool.result"] },
        "execution": { "strategy": "count", "threshold": 5 },
        "userPromptText": "Track metrics",
        "structuredOutput": {
          "output": "object",
          "schemaStr": "z.object({ count: z.number() })"
        },
        "reportToWebsocket": {
          "triggers": true  // Enable trigger events for this chronicler
        }
      }
    }
  ]
}
```

### 7.3 State.json with Chroniclers

```json
{
  "runs": [{
    "runId": "123-abc",
    "phases": [{
      "phaseId": "analysis",
      "status": "completed",
      "finalCost": 0.15,
      "chroniclers": {
        "executed": [{
          "id": "narrator",
          "model": "anthropic/claude-3-5-sonnet-20241022",
          "loadedAt": "2025-03-11T10:00:00Z",
          "unloadedAt": "2025-03-11T10:05:00Z",
          "llmCallCount": 12,
          "failedLLMCalls": 2,
          "lastLlmCallAt": "2025-03-11T10:04:55Z",
          "totalTriggers": 15,
          "totalCost": 0.0234,
          "status": "unloaded",
          "unloadReason": "phase-complete"
        }],
        "totalCost": 0.0234
      }
    }]
  }]
}
```

---

## Recommendations Summary

### Priority 1: Essential (Must Implement)

1. ✅ **Chronicler Events Category**: New event category (journaled + broadcast like Server State)
2. ✅ **Chronicler Events**: Add chronicler.loaded, chronicler.unloaded, chronicler.error
3. ✅ **State Integration**: Add ChroniclerState[] to all phase types (Running, Completed, Failed, Skipped)
4. ✅ **Clean Up API**: Use options object for loadChroniclersForPhase()
5. ✅ **Config System**: reportToWebsocket with two-level override (chronicler + phase)
6. ✅ **Sequencing**: Add triggerNumber to output/triggered events
7. ✅ **State Fields**: Add totalTriggers to ChroniclerState

### Priority 2: Optional but Recommended

8. ✅ **Chronicler.output events**: Default ON (outputs: true by default)
9. ✅ **Chronicler.triggered events**: Optional (triggers: false by default)
10. ⚠️ **Callback Pattern**: ChroniclerManager.setEventCallback() for event emission
11. ⚠️ **Cost Tracking API**: Add method to get chronicler states with all metadata (not just costs)

### Priority 3: Future Enhancements

12. ❌ **Sampling**: Only if event volume becomes an issue
13. ❌ **Real-time LLM tracking**: Per-call state updates (too much churn)

---

## Answered Questions

**All questions from original "Open Questions" section are now answered:**

1. ✅ **Event verbosity**: Per-output (no batching per decision #10)
2. ✅ **State granularity**: Aggregates only (no per-LLM-call state transitions)
3. ✅ **Chronicler costs**: Separate from phase.completed cost (just in state.json)
4. ✅ **Fallback pattern**: Options object with defaults (decision #12)
5. ✅ **Output content**: Full content, no truncation (decision #5)

---

## Implementation Complexity

### Low Complexity (Easy Wins)
- ✅ Add chronicler event schemas (30 min)
- ✅ Emit chronicler.loaded/unloaded (1 hour)
- ✅ Add ChroniclerSnapshot to state types (30 min)
- ✅ Refactor loadChroniclersForPhase API (1 hour)

### Medium Complexity
- ⚠️ State transitions for chroniclers (2 hours)
- ⚠️ Update state manager to handle new transitions (2 hours)
- ⚠️ Callback pattern for chronicler events (2 hours)
- ⚠️ Tests for all new functionality (3 hours)

### High Complexity
- ❌ Real-time LLM call tracking (complex, many transitions)
- ❌ Chronicler.output with content (size management, truncation logic)
- ❌ Sampling and aggregation (optimization, not needed yet)

---

## Implementation Requirements Summary

Based on the design decisions above, here's what needs to be implemented:

### 1. Event Schemas (event-schemas.ts)
- Add 5 new chronicler event types with full Zod schemas
- Create new CHRONICLER_EVENT_TYPES set
- Add isChroniclerEvent() type guard
- Update isJournaledEvent() to include chronicler events
- Add event data schemas for each chronicler event type

### 2. Chronicler Types (chronicler-types.ts or config-validation/chronicler.schema.ts)
- Add reportToWebsocket field to ChroniclerConfig
- Add reportToWebsocket field to PhaseChroniclerEntry.settings
- Update validation schemas

### 3. State Types (state-types.ts)
- Add ChroniclerState interface (renamed from ChroniclerSnapshot)
- Add chroniclers field to RunningPhase, CompletedPhase, FailedPhase, SkippedPhase
- Update PhaseTransitioned metadata to include chroniclerStates and chroniclerTotalCost
- Ensure completing-chroniclers status is in PhaseStatus and transitions

### 4. ChroniclerManager (chronicler-manager.ts)
- Add setEventCallback() method
- Update loadChroniclersForPhase() signature to use options object
- Add getChroniclerStates() method (returns full ChroniclerState objects, not just costs)
- Update all internal calls to use new API

### 5. Chronicler (chronicler.ts)
- Add onEvent callback parameter to constructor
- Track triggerNumber (sequence counter)
- Track failedLLMCalls counter
- Emit chronicler.output events (respecting reportToWebsocket config)
- Emit chronicler.triggered events (respecting reportToWebsocket config)
- Emit chronicler.error events (respecting reportToWebsocket config)

### 6. TadpoleServer (tadpole-server.ts)
- Add chroniclerManager.setEventCallback() in constructor
- Update loadChroniclersForPhase() calls to use options object
- Emit chronicler.loaded events after loading
- Gather chronicler states during completing-chroniclers transition
- Include chronicler metadata in phase completion transitions

### 7. StateManager (state-manager.ts)
- Update applyTransition() to handle chronicler metadata in PhaseTransitioned
- Handle completing-chroniclers → completed/failed/skipped transitions
- Store ChroniclerState[] in phase.chroniclers field

### 8. Testing
- Unit tests for event schemas
- Integration tests for event emission and state persistence
- E2E tests for full lifecycle

---

## Next Steps

1. ✅ **Design Discussion**: Complete (this document)
2. **Write Implementation Spec**: Create detailed spec with exact code changes
3. **Implement**: Execute the implementation
4. **Test**: Comprehensive test coverage
5. **Document**: Update user-facing docs

---

## Appendix: Code Exploration Notes

### Current Chronicler Lifecycle

```
Load → Receive Events → Trigger → Execute → Write Output → Unload
  ↓        ↓              ↓         ↓           ↓            ↓
  ?      (silent)      (silent)  (silent)   (to file)    (silent)
```

**None of this is visible in event stream!**

### Ideal Chronicler Lifecycle (Phase 2)

```
Load → Receive Events → Trigger → Execute → Write Output → Unload
  ↓        ↓              ↓         ↓           ↓            ↓
EVENT    (silent)      EVENT?    EVENT?      EVENT?       EVENT
```

**What users see**:
- When chroniclers start/stop
- When they produce outputs
- When they encounter errors
- Their resource usage (costs, calls)

### State.json Philosophy

From state-types.ts comments:
> "Only store what's expensive to aggregate from events"

**For chroniclers**:
- ✅ Total cost: Could sum from events, but easier in state
- ✅ Call count: Could count events, but easier in state
- ✅ Load/unload times: Core lifecycle info
- ❌ Individual LLM calls: Available in events
- ❌ Queue sizes: Too transient
- ❌ Output content: In files

**Conclusion**: Minimal state, rich events
