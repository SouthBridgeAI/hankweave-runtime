# Execution Specification: Small to Medium Chronicler Improvements

## Background

This document addresses improvements identified during a manual code review of the Chronicler system. Chroniclers are parallel observation agents that watch the main Tadpole workflow's event stream and perform analysis, summarization, or data extraction without blocking the primary task.

The review covered approximately 80% complete chronicler functionality, focusing on:
- `server/chroniclers/chronicler-manager.ts` - Orchestrates multiple chronicler instances
- `server/chroniclers/chronicler.ts` - Individual chronicler runtime
- `server/chroniclers/history-manager.ts` - Conversation history management
- `server/chroniclers/trigger-engine.ts` - Event pattern matching
- `server/chroniclers/condition-evaluator.ts` - Conditional logic evaluation

This specification covers **18 actionable tasks** ranging from small refactorings to medium architectural improvements. All tasks can be implemented now without major system redesign.

## Task Execution Order

Tasks are ordered to minimize dependencies and conflicts:
1. **Variable/Parameter Naming (2, 5, 6, 8, 9)** - Pure refactoring, no behavior changes
2. **Code Structure Improvements (7, 10, 17, 23, 24, 25)** - Improve readability and reduce log noise
3. **Bug Fixes and Enhancements (13, 15, 16, 18, 19, 20)** - Small behavior improvements
4. **Medium Changes (3, 21, 22)** - Require schema/interface changes

**Note:** Item 4 was removed from the original review, so numbering skips from 3 to 5.

---

## Category 1: Variable and Parameter Naming

### Task 2: Add Directory Initialization Flag

**File:** `server/chroniclers/chronicler-manager.ts`
**Lines:** 98-108
**Size:** Small
**Priority:** High (reduces unnecessary I/O)

**Current Problem:**
The `initialize()` method calls `fs.mkdir()` with `{ recursive: true }` every time it's called from `loadChroniclersForPhase()`. While `mkdir` with recursive is idempotent, it's an unnecessary filesystem operation on every chronicler load.

**Solution:**
Add a private boolean flag to track whether directory initialization has succeeded.

**Implementation:**
```typescript
// Add to class properties
private isDirectoryInitialized = false;

// Update initialize() method
public async initialize(): Promise<void> {
  // Early return if already initialized or no directory configured
  if (this.isDirectoryInitialized || !this.chroniclerDir) return;

  try {
    await fs.mkdir(this.chroniclerDir, { recursive: true });
    this.isDirectoryInitialized = true;  // Mark as initialized on success
    this.logger?.log(
      `[ChroniclerManager] Created/verified chronicler directory at ${this.chroniclerDir}`,
      "debug",
    );
  } catch (error) {
    this.logger?.log(
      `[ChroniclerManager] Failed to create directory ${this.chroniclerDir}: ${error}. Running without persistence.`,
      "info",
    );
    this.chroniclerDir = undefined;
    // Don't set isDirectoryInitialized to true on failure - allow retry
  }
}
```

**Verification:**
- Add logging to confirm mkdir is only called once per manager instance
- Run existing chronicler tests to ensure no regression

---

### Task 5: Move hasRealProviders Check Outside Loop

**File:** `server/chroniclers/chronicler-manager.ts`
**Lines:** 195-215
**Size:** Small
**Priority:** Medium (improves performance and readability)

**Current Problem:**
The `hasRealProviders` check is computed inside the `for` loop for each chronicler config. This repeats the same computation unnecessarily and makes the code harder to read.

**Solution:**
Hoist the `hasRealProviders` check outside the loop since it doesn't depend on individual config properties.

**Implementation:**
```typescript
public async loadChroniclersForPhase(...) {
  await this.initialize();

  // Hoist provider availability check outside loop
  const hasRealProviders = this.providerRegistry &&
    Array.from(this.providerRegistry.getProviderStatus().values())
      .some(s => s.status === "available");

  for (const config of configs) {
    try {
      // Only check provider availability if we have real providers AND the model looks like a full model ID (has slash)
      const isFullModelId = config.model?.includes("/");

      if (hasRealProviders && isFullModelId) {
        // Model validation logic...
      }

      // Rest of chronicler creation...
    }
  }
}
```

**Verification:**
- Confirm tests pass without changes
- Add timing logs to verify performance improvement with many chroniclers

---

### Task 6: Rename LLM Call ID Parameters

**File:** `server/chroniclers/chronicler-manager.ts`
**Lines:** 172 (function signature), 243-254 (implementation)
**Size:** Small
**Priority:** High (improves code clarity)

**Current Problem:**
The parameter `id: string` is actually the chronicler ID, but this isn't clear from the variable name. This makes the code harder to understand.

**Solution:**
Rename all instances of the ambiguous `id` parameter to `chroniclerId`.

**Implementation Changes:**
1. Line 172: Function parameter in `loadChroniclersForPhase`
   ```typescript
   llmCall: (
     chroniclerId: string,  // Was: id: string
     options: TadpoleGenerateTextOptions,
   ) => Promise<TadpoleGenerateTextResult>,
   ```

2. Line 243: concreteLlmCall function
   ```typescript
   const concreteLlmCall = async (
     chroniclerId: string,  // Was: id: string
     options: TadpoleGenerateTextOptions,
   ): Promise<TadpoleGenerateTextResult> => {
     if (!config.model) {
       throw new ChroniclerFatalError(
         chroniclerId,  // Was: id
         `Model configuration required for chronicler ${chroniclerId}`,
         "configuration",
         true,
       );
     }
     // ... rest of function
   }
   ```

3. Line 246, 251: ChroniclerFatalError calls - update to use `chroniclerId`

4. Update all call sites in `server/chroniclers/chronicler.ts` where this function is invoked

**Verification:**
- TypeScript compilation succeeds
- All tests pass
- Search codebase for any remaining ambiguous `id` parameters in LLM call contexts

---

### Task 8: Rename llmCall Parameter to Clarify Purpose

**File:** `server/chroniclers/chronicler-manager.ts`
**Lines:** 172 (parameter), 299-309 (usage)
**Size:** Small
**Priority:** Medium (improves code clarity)

**Current Problem:**
The `llmCall` parameter name doesn't clearly indicate it's a mock/fallback used when real providers aren't available. This creates confusion about when it's used.

**Solution:**
Rename to `mockOrFallbackLlmCall` and add JSDoc documentation explaining its purpose.

**Implementation:**
```typescript
/**
 * Load chronicler configurations for a specific phase.
 * @param configs - The chronicler configurations to load
 * @param phaseId - The ID of the phase these chroniclers belong to
 * @param mockOrFallbackLlmCall - LLM call function used in test mode or when provider
 *   registry is unavailable. In production with configured providers, a concrete
 *   implementation is used instead that directly accesses the provider registry.
 * @param configDirectory - Directory containing the config file (for resolving relative paths)
 * @param runStartTime - Start time of the current run
 * @param onExecute - Optional callback for test instrumentation
 */
public async loadChroniclersForPhase(
  configs: ChroniclerConfig[],
  phaseId: PhaseId,
  mockOrFallbackLlmCall: (  // Was: llmCall
    chroniclerId: string,
    options: TadpoleGenerateTextOptions,
  ) => Promise<TadpoleGenerateTextResult>,
  configDirectory?: string,
  runStartTime?: Date,
  onExecute?: (id: string, events: ServerEvent[]) => void,
): Promise<void> {
  // ... implementation

  // Line 299-309: Update usage
  const chronicler = new Chronicler(
    config,
    phaseId,
    hasRealProviders && isFullModelId ? concreteLlmCall : mockOrFallbackLlmCall,  // Was: llmCall
    this.logger,
    this.chroniclerDir,
    configDirectory,
    runStartTime,
    onExecute,
  );
}
```

**Verification:**
- Update all call sites to use new parameter name
- Ensure tests still pass
- JSDoc appears correctly in IDE

---

### Task 9: Rename consecutiveFailures for Consistency

**File:** `server/chroniclers/chronicler-manager.ts`
**Lines:** 33 (declaration), 128 (usage), 313-317 (initialization)
**Size:** Small
**Priority:** Low (improves code readability)

**Current Problem:**
The map is named `consecutiveFailures` but doesn't parallel the naming convention of `chroniclerConfigs`. This makes the code harder to scan.

**Solution:**
Rename to `chroniclerFailureCounts` for consistency. Also rename local variable `currentFailures` to `currentFailureCount`.

**Implementation:**
```typescript
// Line 33: Class property declaration
private chroniclerFailureCounts: Map<string, number> = new Map();  // Was: consecutiveFailures

// Line 128: Usage in _safelyExecute
const currentFailureCount = this.chroniclerFailureCounts.get(chroniclerId) || 0;  // Was: currentFailures
this.chroniclerFailureCounts.set(chroniclerId, currentFailureCount + 1);

// Reset on success
this.chroniclerFailureCounts.set(chroniclerId, 0);

// Line 157: Check threshold
const newFailureCount = this.chroniclerFailureCounts.get(chroniclerId) || 0;

// Line 313-317: Initialization in loadChroniclersForPhase
this.chroniclerFailureCounts.set(config.id, 0);  // Was: consecutiveFailures
```

**Verification:**
- Search and replace all instances
- Verify TypeScript compilation
- Run tests to ensure no behavioral changes

---

## Category 2: Code Structure Improvements

### Task 7: Use Mapping Object for Finish Reasons

**File:** `server/chroniclers/chronicler-manager.ts`
**Lines:** 274-286 (inside concreteLlmCall)
**Size:** Small
**Priority:** Low (improves maintainability)

**Original Question from Review:**
"Is this the only way to do this? If so it's okay, is there not a more elegant way?"

**Current Problem:**
The code uses multiple if-else statements to map AI SDK finish reasons to internal types:
```typescript
let finishReason = "stop";
if (response.finishReason === "length") finishReason = "length";
else if (response.finishReason === "content-filter") finishReason = "content-filter";
// ... etc
```

This is verbose and harder to maintain when adding new finish reason types.

**Solution:**
Replace with a mapping object for cleaner code.

**Implementation:**
```typescript
// Inside concreteLlmCall function, replace the if-else chain
const finishReasonMap: Record<string, "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other"> = {
  "stop": "stop",
  "length": "length",
  "content-filter": "content-filter",
  "tool-calls": "tool-calls",
  "error": "error",
};

// Replace the if-else chain with:
const finishReason = finishReasonMap[response.finishReason] ?? "other";

return {
  text: response.text,
  finishReason,
  usage: {
    inputTokens: response.usage?.inputTokens || 0,
    outputTokens: response.usage?.outputTokens || 0,
  },
};
```

**Verification:**
- All existing finish reasons still map correctly
- Unknown finish reasons default to "other"
- Tests pass without changes

---

### Task 10: Hoist Chronicler Variable for Safe Cleanup

**File:** `server/chroniclers/chronicler-manager.ts`
**Lines:** 324-337 (error handling in loadChroniclersForPhase)
**Size:** Small
**Priority:** Medium (prevents resource leaks)

**Current Problem:**
If the Chronicler constructor partially succeeds (e.g., creates file handles) before throwing, those resources could leak because we don't track the partially-created chronicler.

**Solution:**
Hoist chronicler variable outside try-catch to enable cleanup on partial initialization.

**Implementation:**
```typescript
for (const config of configs) {
  let chronicler: Chronicler | undefined;  // Hoist outside try block

  try {
    // Check provider availability...

    chronicler = new Chronicler(
      config,
      phaseId,
      hasRealProviders && isFullModelId ? concreteLlmCall : mockOrFallbackLlmCall,
      this.logger,
      this.chroniclerDir,
      configDirectory,
      runStartTime,
      onExecute,
    );

    // Only add to collections after successful creation
    this.chroniclers.push(chronicler);
    this.chroniclerConfigs.set(config.id, config);
    this.chroniclerFailureCounts.set(config.id, 0);

    this.logger?.log(
      `[ChroniclerManager] Loaded chronicler '${config.id}' for phase '${phaseId}'`,
      "info",
    );
  } catch (error) {
    // If chronicler was partially created, we still have reference to clean it up
    // (though for now we skip explicit destroy() call as requested)

    if (error instanceof ChroniclerFatalError) {
      this.logger?.log(
        `Fatal error loading chronicler ${config.id}: ${error.message}`,
        "error",
      );
      continue;
    }

    this.logger?.log(
      `[ChroniclerManager] Failed to load chronicler ${config.id}: ${error}`,
      "error",
    );
  }
}
```

**Verification:**
- Chroniclers only added to array after successful construction
- Error handling still works correctly
- No resource leaks in tests

---

### Task 17: Narrow Try-Catch Scope for Template Errors

**File:** `server/chroniclers/chronicler.ts`
**Lines:** 556-567 (outer try-catch), 470-479 and 488-497 (template rendering)
**Size:** Small
**Priority:** Medium (improves error clarity)

**Current Problem:**
The outer try-catch wraps the entire `executeChroniclerCall` method but only catches template rendering errors. This makes it harder to track which exceptions can occur where.

**Solution:**
Move try-catch blocks to specifically wrap only the template rendering operations.

**Implementation:**
```typescript
private async executeChroniclerCall(events: ServerEvent[]): Promise<void> {
  this.onExecute?.(this.config.id, events);

  // Create template context
  const templateContext: TemplateContext = {
    events,
    phase: {
      id: this.phaseId,
      name: this.config.name,
      description: this.config.description,
      startTime: this.runStartTime,
    },
    world: {
      currentTime: new Date(),
    },
  };

  // Render user prompt template with focused error handling
  let userMessage: string;
  try {
    userMessage = await TemplateRenderer.render(this.userPromptTemplate, templateContext);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Template syntax error")) {
      throw new ChroniclerFatalError(
        this.config.id,
        `Template syntax permanently broken: ${error.message}`,
        "template",
        true,
      );
    }
    if (error instanceof Error && error.message.includes("Template rendering failed")) {
      this.logger?.log(
        `[Chronicler:${this.config.id}] Template rendering failed: ${error.message}`,
        "error",
      );
      return; // Terminate execution cycle
    }
    throw error; // Re-throw unexpected errors
  }

  // Render system prompt template if available, with same error handling
  let renderedSystemPrompt: string | undefined;
  if (this.systemPromptTemplate) {
    try {
      renderedSystemPrompt = await TemplateRenderer.render(
        this.systemPromptTemplate,
        templateContext,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("Template syntax error")) {
        throw new ChroniclerFatalError(
          this.config.id,
          `System prompt template syntax permanently broken: ${error.message}`,
          "template",
          true,
        );
      }
      if (error instanceof Error && error.message.includes("Template rendering failed")) {
        this.logger?.log(
          `[Chronicler:${this.config.id}] System template rendering failed: ${error.message}`,
          "error",
        );
        return; // Terminate execution cycle
      }
      throw error;
    }
  }

  // Rest of method continues without outer try-catch
  // LLM calls, history management, etc. - errors propagate normally

  if (this.config.conversational && this.historyManager) {
    // Conversational flow...
  } else {
    // Non-conversational flow...
  }
}
```

**Verification:**
- Template errors still caught and handled appropriately
- Other errors (LLM failures, etc.) propagate correctly
- Tests pass, especially template error tests

---

### Task 23: Document Trigger ID Collision Behavior

**File:** `server/chroniclers/trigger-engine.ts`
**Lines:** 30-31 (EventTriggerEngine constructor)
**Size:** Small
**Priority:** Low (documentation only)

**Current Problem:**
The trigger ID can collide between chroniclers with identical trigger configurations. This is intentional for logging purposes but not documented.

**Solution:**
Add class-level JSDoc and inline comment explaining collision behavior.

**Implementation:**
```typescript
/**
 * Engine for evaluating simple event triggers.
 * Stateless - evaluates each event independently.
 *
 * Note: triggerId is for logging only and may collide between chroniclers
 * with identical trigger configurations. This is intentional for grouping
 * related log messages from similar triggers.
 */
export class EventTriggerEngine extends TriggerEngine {
  private triggerId: string;

  constructor(
    private trigger: EventTrigger,
    private logger?: Logger,
  ) {
    super();
    // Note: Non-unique across chroniclers - multiple chroniclers with same
    // trigger configuration will share this ID for logging purposes
    this.triggerId = `EventTrigger-${trigger.on.join(",")}`;
  }

  // ... rest of class
}
```

**Verification:**
- JSDoc renders correctly in IDE
- Comment explains the design decision

---

### Task 24: Remove Verbose Trigger Logging

**File:** `server/chroniclers/trigger-engine.ts`
**Lines:** 41-52
**Size:** Small
**Priority:** High (reduces log noise)

**Current Problem:**
Every event generates multiple debug logs for condition checking. In busy systems this creates thousands of log lines per second.

**Solution:**
Remove the verbose condition-checking logs, keep only the "MATCHED" log which is important for understanding trigger behavior.

**Implementation:**
```typescript
processEvent(event: ServerEvent): { matched: boolean; events: ServerEvent[] } {
  // Check if event type matches (including wildcard)
  if (!this.trigger.on.includes(event.type) && !this.trigger.on.includes("*")) {
    return { matched: false, events: [] };
  }

  // Check conditions if any
  if (this.trigger.conditions && this.trigger.conditions.length > 0) {
    // REMOVED: Verbose logging
    // this.logger?.log(
    //   `[${this.triggerId}] Checking ${this.trigger.conditions.length} conditions for ${event.type}`,
    //   "debug",
    // );

    const conditionsMet = evaluateConditions(this.trigger.conditions, event.data);
    if (!conditionsMet) {
      // REMOVED: Verbose logging
      // this.logger?.log(`[${this.triggerId}] Conditions not met for ${event.type}`, "debug");
      return { matched: false, events: [] };
    }
  }

  // KEEP: This log is important for understanding trigger behavior
  this.logger?.log(`[${this.triggerId}] MATCHED ${event.type}`, "debug");
  return { matched: true, events: [event] };
}
```

**Verification:**
- Logs significantly reduced in high-traffic scenarios
- MATCHED logs still appear for successful triggers
- No functional changes

---

### Task 25: Document Unknown Type Choice in Condition Evaluator

**File:** `server/chroniclers/condition-evaluator.ts`
**Lines:** 10-21
**Size:** Small
**Priority:** Low (documentation only)

**Current Problem:**
The function uses `Record<string, unknown>` for event data, which might seem too loose. However, this is intentional and correct.

**Solution:**
Add JSDoc comment explaining why `unknown` is the appropriate choice.

**Implementation:**
```typescript
/**
 * Evaluates a single condition against event data.
 *
 * Note: eventData is typed as Record<string, unknown> intentionally because:
 * - Event data structure varies by event type (discriminated union)
 * - Condition paths are strings defined at runtime (from JSON config)
 * - We cannot statically verify path existence or value types at compile time
 * - Runtime type checking happens inside the function for each operator
 *
 * Using 'unknown' accurately represents our compile-time knowledge and forces
 * proper runtime validation rather than unsafe type assertions.
 *
 * @param condition - The condition to evaluate
 * @param eventData - The event data to evaluate against (from ServerEvent.data)
 * @returns true if the condition matches, false otherwise
 */
export function evaluateCondition(
  condition: Condition,
  eventData: Record<string, unknown>,
): boolean {
  const actualValue = getValueByPath(eventData, condition.path);
  // ... rest of function
}
```

**Verification:**
- Comment explains the design rationale
- No code changes needed

---

## Category 3: Bug Fixes and Enhancements

### Task 13: Fix Time Window Timer Drift

**File:** `server/chroniclers/chronicler.ts`
**Lines:** 287-332 (startTimeWindowLoop)
**Size:** Small
**Priority:** Medium (improves timing accuracy)

**Current Problem:**
The time window timer can drift over time because it schedules the next window based on `Date.now()` when the previous window completes, not from a fixed baseline. If LLM calls take variable time, drift accumulates.

**Solution:**
Track absolute timestamps and calculate delay to next window, with handling for cases where start time is in the past (system was paused/hanging).

**Implementation:**
```typescript
// Add class property
private lastWindowTime?: number;

/**
 * Start a periodic time window loop that processes events at regular intervals.
 * Uses absolute timestamps to prevent drift accumulation from variable LLM call times.
 */
private startTimeWindowLoop(milliseconds: number): void {
  if (this.timeWindowTimer) {
    clearTimeout(this.timeWindowTimer);
  }

  // Calculate next window time based on last window, or start now if first time
  const now = Date.now();
  const nextWindowTime = this.lastWindowTime
    ? this.lastWindowTime + milliseconds
    : now + milliseconds;

  // Calculate delay, handling case where we're behind schedule
  const delay = Math.max(0, nextWindowTime - now);

  // If we're significantly behind (> 100ms), log a warning
  if (delay === 0 && this.lastWindowTime) {
    this.logger?.log(
      `[Chronicler:${this.config.id}] Time window behind schedule by ${now - nextWindowTime}ms, firing immediately`,
      "debug",
    );
  }

  const windowStartTime = now;
  this.timeWindowTimer = setTimeout(() => {
    // Record when this window actually fired for next calculation
    this.lastWindowTime = Date.now();

    const eventCount = this.pendingEvents.length;
    if (eventCount > 0) {
      this.logger?.log(
        `[Chronicler:${this.config.id}] Time window CLOSING: Duration: ${
          Date.now() - windowStartTime
        }ms, Events collected: ${eventCount}`,
        "info",
      );

      const eventsToProcess = [...this.pendingEvents];
      this.pendingEvents = [];
      const startTime = Date.now();

      this.executeChroniclerCall(eventsToProcess)
        .then(() => {
          this.logger?.log(
            `[Chronicler:${this.config.id}] Time window execution completed: Events: ${eventCount}, Duration: ${
              Date.now() - startTime
            }ms`,
            "debug",
          );
        })
        .catch((error) => {
          this.logger?.log(
            `[Chronicler:${this.config.id}] Error in timeWindow LLM call: ${error}`,
            "error",
          );
        });
    }

    // Schedule the next window
    this.startTimeWindowLoop(milliseconds);
  }, delay);
}
```

**Verification:**
- Timer fires at consistent intervals even with variable LLM call times
- Handles case where system is behind schedule gracefully
- Add test to verify timing accuracy over multiple windows

---

### Task 15: Make Conversational Check Explicit

**File:** `server/chroniclers/chronicler.ts`
**Lines:** 503-504
**Size:** Small
**Priority:** Low (improves code clarity)

**Current Problem:**
Code only checks `if (this.historyManager)` but this relies on implicit assumption that historyManager exists IFF config.conversational is true.

**Solution:**
Make the relationship explicit by checking both conditions.

**Implementation:**
```typescript
// Around line 503-504, replace:
if (this.historyManager) {
  // Conversational flow
  // ...
} else {
  // Non-conversational flow
  // ...
}

// With:
if (this.config.conversational && this.historyManager) {
  // Conversational flow
  if (!renderedSystemPrompt) {
    throw new Error(
      `[Chronicler:${this.config.id}] Conversational chroniclers require a system prompt`,
    );
  }
  // ... rest of conversational flow
} else {
  // Non-conversational flow
  // ...
}
```

**Verification:**
- Both conversational and non-conversational chroniclers still work
- Code is more self-documenting
- Tests pass without changes

---

### Task 16: Make Model Optional in TadpoleGenerateTextOptions

**File:** `server/types/llm-call-types.ts`, `server/chroniclers/chronicler.ts`
**Lines:** Type definition, line 541 (usage in chronicler)
**Size:** Small
**Priority:** Medium (removes type hack)

**Original Question from Review:**
"What on earth is happening here? Why are we doing this?"

**Current Problem:**
Chronicler currently passes an empty object cast as LanguageModel: `model: {} as LanguageModel`. This is a type system workaround because:
- `TadpoleGenerateTextOptions` requires a `model` field
- The Chronicler doesn't have access to the actual model instance
- The model is only available in ChroniclerManager's `concreteLlmCall` function
- The empty object is discarded and replaced with the real model before the LLM call

This type hack works but is confusing and fragile.

**Solution:**
Make `model` optional in `TadpoleGenerateTextOptions` since it's actually provided by the concrete implementation that wraps chronicler calls. This matches the actual usage pattern and eliminates the type hack.

**Implementation:**

1. Update type definition in `server/types/llm-call-types.ts`:
```typescript
export interface TadpoleGenerateTextOptions {
  model?: LanguageModel;  // Make optional - provided by concrete implementation
  messages: TadpoleModelMessage[];
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
}
```

2. Remove type hack in `server/chroniclers/chronicler.ts`:
```typescript
// Around line 511 (conversational flow):
const options: TadpoleGenerateTextOptions = {
  // Removed: model: {} as LanguageModel,
  messages,
  temperature: this.llmParams.temperature,
  maxOutputTokens: this.llmParams.maxOutputTokens,
  maxRetries: this.llmParams.maxRetries,
};

// Around line 541 (non-conversational flow):
const options: TadpoleGenerateTextOptions = {
  // Removed: model: {} as LanguageModel,
  messages: [{ role: "user", content: userMessage }],
  system: renderedSystemPrompt,
  temperature: this.llmParams.temperature,
  maxOutputTokens: this.llmParams.maxOutputTokens,
  maxRetries: this.llmParams.maxRetries,
};
```

3. In `server/chroniclers/chronicler-manager.ts`, ensure concreteLlmCall provides the model:
```typescript
// Line ~274 in concreteLlmCall - already does this correctly:
const response = await generateText({
  model: modelResult.model,  // Model provided here
  ...optionsWithoutModel
});
```

**IMPORTANT: Verification Steps:**
1. Check if AI SDK types require model to be present
2. Verify TypeScript compilation succeeds
3. Run all chronicler tests
4. If AI SDK requires model, we may need to keep the current approach and just add a comment

**Note:** Manual review requested checking AI SDK compatibility. If making model optional breaks type compatibility with AI SDK, revert and add explanatory comment instead.

---

### Task 18: Document Async Initialization Patterns

**Files:** `server/chroniclers/chronicler-manager.ts`, `server/chroniclers/history-manager.ts`, `server/chroniclers/chronicler.ts`
**Size:** Small
**Priority:** Low (documentation only)

**Current Problem:**
Three different async initialization patterns exist but the rationale isn't documented, making it look accidental.

**Solution:**
Add JSDoc to each class explaining why its particular initialization pattern was chosen.

**Implementation:**

1. ChroniclerManager:
```typescript
/**
 * Manages multiple Chronicler instances for a phase.
 * Orchestrates event distribution and lifecycle management.
 *
 * Initialization Pattern: Explicit async initialize() method
 * Rationale: Shared resource (filesystem directory) needs setup before
 * chroniclers can be created. Explicit call allows caller to control timing
 * and handle setup failures gracefully.
 */
export class ChroniclerManager {
  // ... class implementation
}
```

2. HistoryManager:
```typescript
/**
 * Manages conversation history for a single chronicler.
 * Handles loading, saving, and pruning conversation messages.
 *
 * Initialization Pattern: Lazy initialization via private ensureInitialized()
 * Rationale: Cannot await in constructor. History only needed when chronicler
 * actually triggers, so lazy loading avoids unnecessary I/O for chroniclers
 * that never execute. Called automatically on first use of addMessagePair()
 * or getMessagesToSend().
 */
export class HistoryManager {
  // ... class implementation
}
```

3. Chronicler:
```typescript
/**
 * Represents a single running Chronicler instance.
 * Manages its own trigger engine and execution strategy.
 *
 * Initialization Pattern: Synchronous constructor only
 * Rationale: All setup is in-memory (no I/O needed). Prompt files are read
 * synchronously to enable fail-fast behavior. Relies on ChroniclerManager
 * to have initialized shared resources (directory) before construction.
 */
export class Chronicler {
  // ... class implementation
}
```

**Verification:**
- JSDoc renders correctly in IDE
- Patterns are clearly explained
- No code changes needed

---

### Task 19: Add JSDoc to forceSkipPruning Parameter

**File:** `server/chroniclers/history-manager.ts`
**Lines:** 91
**Size:** Small
**Priority:** Low (documentation only)

**Current Problem:**
The `forceSkipPruning` parameter is never used in production code. Its purpose isn't clear.

**Solution:**
Add JSDoc explaining when this parameter might be useful (debugging, inspection).

**Implementation:**
```typescript
/**
 * Get messages to send to LLM with automatic pruning based on strategy.
 *
 * @param systemPrompt - The system prompt to prepend to message history
 * @param forceSkipPruning - If true, skip pruning and return all history.
 *   Useful for debugging conversation state or inspecting full history
 *   without modification. Defaults to false (pruning enabled).
 * @returns Array of messages including system prompt and (pruned) history
 */
public async getMessagesToSend(
  systemPrompt: string,
  forceSkipPruning = false,
): Promise<TadpoleModelMessage[]> {
  // ... implementation
}
```

**Verification:**
- JSDoc explains parameter purpose
- No code changes

---

### Task 20: Add Chronicler ID to HistoryManager Logs

**File:** `server/chroniclers/history-manager.ts`
**Lines:** Constructor, 106-109, and other log statements
**Size:** Small
**Priority:** Medium (improves debugging)

**Current Problem:**
Log messages from HistoryManager don't include the chronicler ID, making it impossible to tell which chronicler's history is being referenced when multiple conversational chroniclers are active.

**Solution:**
Store chronicler ID and include it in all log messages.

**Implementation:**
```typescript
export class HistoryManager {
  private history: Array<TadpoleUserModelMessage | TadpoleAssistantModelMessage> = [];
  private readonly historyFilePath?: string;
  private readonly trimmingStrategy: TrimingStrategy;
  private readonly logger?: Logger;
  private isInitialized = false;
  private readonly chroniclerId: string;  // Add this

  constructor(
    chroniclerId: string,
    phaseId: PhaseId,
    trimmingStrategy: TrimingStrategy,
    chroniclerDir?: string,
    logger?: Logger,
  ) {
    this.chroniclerId = chroniclerId;  // Store it
    this.trimmingStrategy = trimmingStrategy;
    this.logger = logger;

    if (chroniclerDir) {
      const filename = `${chroniclerId}-phase-${phaseId}.json`;
      this.historyFilePath = path.join(chroniclerDir, filename);
      this.logger?.log(
        `[HistoryManager:${this.chroniclerId}] Persistence enabled at: ${this.historyFilePath}`,  // Use it
        "debug",
      );
    } else {
      this.logger?.log(
        `[HistoryManager:${this.chroniclerId}] Running in memory-only mode`,  // Use it
        "info",
      );
    }
  }

  // Update all log statements to include chronicler ID:
  // Line 75:
  this.logger?.log(
    `[HistoryManager:${this.chroniclerId}] Added message pair - user: ${userContent.length} chars, assistant: ${assistantContent.length} chars. Total messages: ${this.history.length}`,
    "debug",
  );

  // Line 106-109:
  this.logger?.log(
    `[HistoryManager:${this.chroniclerId}] Prepared ${messages.length} messages for LLM (including system prompt)`,
    "debug",
  );

  // And all other log statements...
}
```

**Verification:**
- All HistoryManager logs now include chronicler ID
- Easier to debug multi-chronicler scenarios
- Tests pass

---

## Category 4: Medium Changes (Require Schema/Interface Updates)

### Task 3: Add Configurable Error Thresholds

**File:** `server/types/chronicler-types.ts` (schema), `server/chroniclers/chronicler-manager.ts` (usage)
**Lines:** Schema definition, line 157 (usage)
**Size:** Medium
**Priority:** Medium (adds flexibility)

**Current Problem:**
Error threshold is hardcoded to 3 consecutive failures for all non-conversational chroniclers. Different chroniclers have different reliability requirements.

**Solution:**
Add optional `errorHandling` configuration to ChroniclerConfig with configurable thresholds.

**Implementation:**

1. Update schema in `server/types/chronicler-types.ts`:
```typescript
export interface ChroniclerConfig {
  id: string;
  name: string;
  // ... existing fields

  errorHandling?: {
    maxConsecutiveFailures?: number;  // Default: 3
    unloadOnFatalError?: boolean;     // Default: true
  };

  // ... rest of config
}
```

2. Update Zod schema in `server/config-validation/chronicler.schema.ts`:
```typescript
const errorHandlingSchema = z.object({
  maxConsecutiveFailures: z.number().int().min(1).optional()
    .describe("Maximum consecutive failures before unloading chronicler. Default: 3"),
  unloadOnFatalError: z.boolean().optional()
    .describe("Whether to unload on fatal errors. Default: true"),
}).optional();

const chroniclerConfigSchema = z.object({
  // ... existing fields
  errorHandling: errorHandlingSchema,
  // ... rest of schema
});
```

3. Update usage in `server/chroniclers/chronicler-manager.ts`:
```typescript
// Line ~157 in _safelyExecute:
// For non-conversational chroniclers, check threshold from config
if (!config?.conversational) {
  const threshold = config?.errorHandling?.maxConsecutiveFailures ?? 3;  // Use config value or default to 3
  const newFailureCount = this.chroniclerFailureCounts.get(chroniclerId) || 0;

  if (newFailureCount >= threshold) {
    this.logger?.log(
      `[ChroniclerManager] Unloading non-conversational chronicler ${chroniclerId} after ${newFailureCount} consecutive failures (threshold: ${threshold})`,
      "info",
    );
    await this.unloadChronicler(chroniclerId);
  }
}
```

**Verification:**
- Schema validation accepts new optional field
- Default behavior (3 failures) unchanged when field not specified
- Can configure higher/lower thresholds per chronicler
- Documentation updated to explain new field

---

### Task 21: Store and Use Actual Token Counts

**File:** `server/chroniclers/history-manager.ts`, `server/chroniclers/chronicler.ts`
**Lines:** Multiple (interface changes)
**Size:** Medium
**Priority:** Medium (improves accuracy)

**Current Problem:**
Token trimming uses estimated counts (`text.length / 4`) instead of actual token counts returned by the AI SDK.

**Solution:**
Update HistoryManager to accept and store actual token counts, falling back to estimation when unavailable.

**Implementation:**

1. Update HistoryManager interface:
```typescript
// Change history storage to include token counts
private history: Array<{
  message: TadpoleUserModelMessage | TadpoleAssistantModelMessage;
  tokens?: number;  // Actual token count if available
}> = [];

// Update addMessagePair signature
public async addMessagePair(
  userContent: string,
  assistantContent: string,
  userTokens?: number,      // New optional parameter
  assistantTokens?: number  // New optional parameter
): Promise<void> {
  await this.ensureInitialized();

  this.history.push(
    {
      message: { role: "user", content: userContent },
      tokens: userTokens  // Store if provided
    },
    {
      message: { role: "assistant", content: assistantContent },
      tokens: assistantTokens  // Store if provided
    }
  );

  this.logger?.log(
    `[HistoryManager:${this.chroniclerId}] Added message pair - user: ${userContent.length} chars${userTokens ? ` (${userTokens} tokens)` : ''}, assistant: ${assistantContent.length} chars${assistantTokens ? ` (${assistantTokens} tokens)` : ''}`,
    "debug",
  );

  if (this.historyFilePath) {
    await this.saveToFile();
  }
}

// Update getMessagesToSend to return just messages
public async getMessagesToSend(
  systemPrompt: string,
  forceSkipPruning = false,
): Promise<TadpoleModelMessage[]> {
  await this.ensureInitialized();

  if (!forceSkipPruning) {
    this.prune();
  }

  const messages: TadpoleModelMessage[] = [
    { role: "system", content: systemPrompt } as TadpoleSystemModelMessage,
    ...this.history.map(item => item.message)  // Extract just the message
  ];

  this.logger?.log(
    `[HistoryManager:${this.chroniclerId}] Prepared ${messages.length} messages for LLM`,
    "debug",
  );

  return messages;
}

// Update pruning to use actual tokens when available
private prune(): void {
  if (this.trimmingStrategy.type === "maxTurns") {
    // Existing turn-based logic unchanged
  } else if (this.trimmingStrategy.type === "maxTokens") {
    const maxTokens = this.trimmingStrategy.maxTokens;

    let totalTokens = this.history.reduce((sum, item) => {
      // Use actual tokens if available, fall back to estimation
      if (item.tokens !== undefined) {
        return sum + item.tokens;
      } else {
        const text = typeof item.message.content === "string"
          ? item.message.content
          : JSON.stringify(item.message.content);
        return sum + simpleTokenCounter(text);
      }
    }, 0);

    let removedCount = 0;
    while (totalTokens > maxTokens && this.history.length > 0) {
      const removed = this.history.shift();
      if (removed) {
        const tokens = removed.tokens ?? (() => {
          const text = typeof removed.message.content === "string"
            ? removed.message.content
            : JSON.stringify(removed.message.content);
          return simpleTokenCounter(text);
        })();
        totalTokens -= tokens;
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.logger?.log(
        `[HistoryManager:${this.chroniclerId}] Pruned ${removedCount} messages to stay within maxTokens=${maxTokens}. Remaining: ${this.history.length}`,
        "info",
      );
    }
  }
}
```

2. Update Chronicler to pass token counts:
```typescript
// In chronicler.ts, around line 530 (conversational flow):
try {
  const response = await this.llmCall(this.config.id, options);

  // Extract token counts from response
  const userTokens = response.usage?.inputTokens;
  const assistantTokens = response.usage?.outputTokens;

  await this.historyManager.addMessagePair(
    userMessage,
    response.text,
    userTokens,      // Pass actual token counts
    assistantTokens
  );
} catch (error) {
  // ... error handling
}
```

3. Update file persistence to handle new format:
```typescript
// In loadFromFile(), handle both old and new formats
for (const item of parsed) {
  if ('message' in item && 'tokens' in item) {
    // New format with token counts
    const result = tadpoleModelMessageSchema.safeParse(item.message);
    if (result.success && (result.data.role === "user" || result.data.role === "assistant")) {
      valid.push({
        message: result.data as TadpoleUserModelMessage | TadpoleAssistantModelMessage,
        tokens: typeof item.tokens === 'number' ? item.tokens : undefined
      });
    }
  } else {
    // Old format without token counts - backward compatibility
    const result = tadpoleModelMessageSchema.safeParse(item);
    if (result.success && (result.data.role === "user" || result.data.role === "assistant")) {
      valid.push({
        message: result.data as TadpoleUserModelMessage | TadpoleAssistantModelMessage,
        tokens: undefined
      });
    }
  }
}
```

**Verification:**
- Token-based trimming uses actual counts when available
- Falls back to estimation for backward compatibility
- File format handles both old and new storage formats
- Tests verify accurate token tracking

---

### Task 22: Improve History File Corruption Handling

**File:** `server/chroniclers/history-manager.ts`
**Lines:** 177-184 (loadFromFile)
**Size:** Medium
**Priority:** Medium (prevents silent corruption)

**Current Problem:**
Invalid messages are silently skipped during history loading, which can break conversation structure (e.g., two user messages in a row).

**Solution:**
Log parsing failures and throw regular Error (not fatal) when too many messages fail, allowing chronicler to recover.

**Implementation:**
```typescript
private async loadFromFile(): Promise<void> {
  if (!this.historyFilePath) return;

  try {
    const content = await fs.readFile(this.historyFilePath, "utf-8");
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed)) {
      const valid: Array<{
        message: TadpoleUserModelMessage | TadpoleAssistantModelMessage;
        tokens?: number;
      }> = [];
      const errors: string[] = [];

      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];

        // Handle both new format (with tokens) and old format (just message)
        const messageData = 'message' in item ? item.message : item;
        const tokens = 'tokens' in item ? item.tokens : undefined;

        const result = tadpoleModelMessageSchema.safeParse(messageData);

        if (!result.success) {
          errors.push(`Message ${i}: Parse failed - ${result.error.message}`);
          this.logger?.log(
            `[HistoryManager:${this.chroniclerId}] Failed to parse message ${i}: ${result.error.message}`,
            "warn",
          );
          continue;
        }

        if (result.data.role !== "user" && result.data.role !== "assistant") {
          errors.push(`Message ${i}: Invalid role '${result.data.role}'`);
          this.logger?.log(
            `[HistoryManager:${this.chroniclerId}] Invalid role at message ${i}: ${result.data.role}`,
            "warn",
          );
          continue;
        }

        valid.push({
          message: result.data as TadpoleUserModelMessage | TadpoleAssistantModelMessage,
          tokens: typeof tokens === 'number' ? tokens : undefined
        });
      }

      // If more than 20% of messages are corrupt, log error and clear history
      // but don't throw fatal error - let chronicler continue with fresh history
      if (errors.length > 0) {
        const corruptionRate = errors.length / parsed.length;
        this.logger?.log(
          `[HistoryManager:${this.chroniclerId}] History file has ${errors.length}/${parsed.length} invalid messages (${(corruptionRate * 100).toFixed(1)}%)`,
          "error",
        );

        if (corruptionRate > 0.2) {
          this.logger?.log(
            `[HistoryManager:${this.chroniclerId}] Corruption rate too high, clearing history and starting fresh`,
            "error",
          );
          this.history = [];
          // Throw regular error to signal corruption but allow recovery
          throw new Error(
            `History file severely corrupted: ${errors.length}/${parsed.length} invalid messages. Starting with fresh history.`
          );
        }
      }

      this.history = valid;

      this.logger?.log(
        `[HistoryManager:${this.chroniclerId}] Loaded ${this.history.length} messages from file${errors.length > 0 ? ` (skipped ${errors.length} invalid)` : ''}`,
        "info",
      );
    } else {
      this.logger?.log(
        `[HistoryManager:${this.chroniclerId}] Invalid history file format, starting fresh`,
        "info",
      );
      this.history = [];
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      this.logger?.log(
        `[HistoryManager:${this.chroniclerId}] No existing history file, starting fresh`,
        "debug",
      );
    } else {
      this.logger?.log(
        `[HistoryManager:${this.chroniclerId}] Error loading history: ${error}`,
        "error",
      );
    }
    this.history = [];
  }
}
```

**Verification:**
- Invalid messages logged with details
- High corruption rate triggers fresh start
- Chronicler continues operating (not unloaded)
- Tests verify error handling and recovery

---

## Summary

This document covers all small to medium tasks that can be implemented now:

**Small Changes (15 tasks):** 2, 5, 6, 7, 8, 9, 10, 13, 15, 16, 17, 18, 19, 20, 23, 24, 25

**Medium Changes (3 tasks):** 3, 21, 22

These tasks improve code quality, fix bugs, and add flexibility without major architectural changes. Docstring improvements and large architectural discussions are covered in the separate large tasks document.
