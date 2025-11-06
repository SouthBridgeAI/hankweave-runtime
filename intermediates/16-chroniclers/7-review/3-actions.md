We're building a new feature (@/intermediates/16-parallel-events/3-triggers/7-comprehensive-summary.md , @/intermediates/16-chroniclers/5-conversational/4-implementation-review.md, intermediates/16-chroniclers/6-templates/implementation-overview.md ) into our project (@/README.md , @/documentation ).

We're making some updates to the features, following the questions in @/Users/hrishioa/Dropbox/Projects/Southbridge/tadpole/intermediates/16-chroniclers/7-review/1-questions.md . We have plans in @/Users/hrishioa/Dropbox/Projects/Southbridge/tadpole/intermediates/16-chroniclers/7-review/2.5-2-gemini-2.5-pro.md - can you follow my thoughts below, with the specific choices being listed below and methodically implement each one by one? Use `bun lint:fix` and `bun tc` (typecheck) to check your results after each.

1. Let's implement this later.
2. Debounce strategy - This is all good - but we need to add documentation to make sure it's spelt out.
3. 'any' events - let's do that now, and update the documentation?
4. Let's fix the mixed error outputs.
5. Fair - let's skip it
6. Let's do it
7. Debug context let's improve
8. Let's follow the plan specifics listed below to implement unloading.

<plans>
## 3. 'Any' Event Trigger
Current State: This is not currently possible. The Zod schema isValidEventType in chronicler.schema.ts strictly validates that trigger types are members of the ServerEvent union.

Implementation Difficulty: Easy. This would be a straightforward addition.

Proposed Implementation Strategy:

Configuration Change: Allow a special wildcard string, like '*', in the configuration.

Schema Update: The Zod schema would be updated to z.string().refine(val => val === '*' || isValidEventType(val)).

Trigger Engine Logic Update (trigger-engine.ts):

EventTriggerEngine:

TypeScript Copy
// In processEvent()
if (this.trigger.on.includes('*') || this.trigger.on.includes(event.type)) {
  // Event type matches
}
SequenceTriggerEngine:

TypeScript Copy
// In check...Pattern() methods
if (step.type === '*' || event.type === step.type) {
  // This step in the pattern matches
}
This would immediately enable the scenarios you described:

'trigger on any n events':

json Copy
"trigger": { "type": "event", "on": ["*"] },
"execution": { "strategy": "count", "threshold": n }
'2 assistant messages, then 2 any messages, then 1 tool call':

json Copy
"trigger": {
  "type": "sequence",
  "interestFilter": { "on": ["*"] },
  "pattern": [
    { "type": "assistant.action" },
    { "type": "assistant.action" },
    { "type": "*" },
    { "type": "*" },
    { "type": "tool.result" }
  ]
}
This is a high-value, low-effort feature to add.

⚠️ Inconsistencies Found__:
Mixed Error Outputs:

// Some places use console.error
console.error(`[Chronicler ${this.config.id}] Error in immediate LLM call:`, error);
// Others use logger
this.logger?.log(`[Chronicler:${this.config.id}] Error in immediate LLM call: ${error}`, "error");

## 7. Debug Context Coverage
Current State: Partially adequate but could be improved.

Good Examples:

TypeScript Copy
`[Chronicler:${this.config.id}] Error in immediate LLM call: ${error}`
`[HistoryManager] Error loading history: ${error}`
Missing Context:

Phase ID not always included in chronicler errors

Event details missing from trigger failures

Stack traces not preserved in some error paths

Improvement Needed:

TypeScript Copy
// Enhanced error context
this.logger?.log(
  `[Chronicler:${this.config.id}:${this.phaseId}] LLM call failed`,
  "error",
  {
    eventCount: events.length,
    strategy: this.config.execution.strategy,
    error: error.message,
    stack: error.stack
  }
);

**Excellent idea!** That's a much better design pattern than self-unloading. This approach maintains architectural integrity while providing chroniclers a way to signal unrecoverable states.

## Why This Approach is Superior

### 1. **Preserves Control Flow**
```typescript
// Chronicler signals intent, manager maintains control:
class ChroniclerFatalError extends Error {
  constructor(
    public readonly chroniclerId: string,
    message: string,
    public readonly errorType: 'configuration' | 'corruption' | 'resource' | 'template',
    public readonly shouldUnload: boolean = true,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'ChroniclerFatalError';
  }
}
```

### 2. **Clean Separation of Concerns**
- **Chronicler**: Detects error severity and context
- **Manager**: Makes unloading decisions and executes cleanup
- **Configuration**: Can define unloading policies per chronicler

### 3. **Integration with Existing Error Handling**
```typescript
// In ChroniclerManager.handleEvent():
const results = await Promise.allSettled(promises);

for (const [index, result] of results.entries()) {
  if (result.status === "rejected") {
    const chronicler = this.chroniclers[index];

    if (result.reason instanceof ChroniclerFatalError) {
      // Fatal error - chronicler is recommending unload
      const fatalError = result.reason;

      if (await this.shouldUnloadChronicler(chronicler, fatalError)) {
        await this.unloadChronicler(fatalError.chroniclerId, fatalError.message);
      } else {
        this.disableChronicler(chronicler.getId(), fatalError.message);
      }
    } else {
      // Regular error - apply existing retry logic
      this.handleChroniclerError(chronicler, result.reason);
    }
  }
}
```

## When Chroniclers Should Throw Fatal Errors

### **Template Corruption** (Definitely fatal)
```typescript
try {
  const userMessage = await TemplateRenderer.render(this.userPromptTemplate, templateContext);
} catch (error) {
  if (error.message.includes("Template syntax error")) {
    throw new ChroniclerFatalError(
      this.config.id,
      `Template syntax permanently broken: ${error.message}`,
      'template',
      true  // Definitely unload
    );
  }
}
```

### **Configuration Errors** (Fatal)
```typescript
if (this.config.conversational && !this.systemPromptTemplate) {
  throw new ChroniclerFatalError(
    this.config.id,
    'Conversational chronicler missing required system prompt',
    'configuration',
    true
  );
}
```

### **Resource Corruption** (Potentially fatal)
```typescript
// In HistoryManager:
if (historyLoadError && historyLoadError.code === 'EACCES') {
  throw new ChroniclerFatalError(
    this.chroniclerId,
    'Cannot access history file - permission denied',
    'resource',
    false  // Don't unload - might be temporary
  );
}
```

### **LLM Persistent Failures** (Context-dependent)
```typescript
if (this.consecutiveFailures >= 5 && !this.config.conversational?.continueOnError) {
  throw new ChroniclerFatalError(
    this.config.id,
    `5 consecutive LLM failures without continueOnError policy`,
    'resource',
    true  // Unload to stop wasting API calls
  );
}
```

## Manager Decision Logic

```typescript
private async shouldUnloadChronicler(
  chronicler: Chronicler,
  fatalError: ChroniclerFatalError
): Promise<boolean> {
  // Error explicitly recommends unloading
  if (fatalError.shouldUnload) {
    return true;
  }

  // Check chronicler-specific policies
  const wrapper = this.getWrapper(chronicler.getId());
  if (wrapper?.config.unloadPolicy) {
    switch (fatalError.errorType) {
      case 'template':
      case 'configuration':
        return true;  // Always unload for these

      case 'resource':
        return wrapper.config.unloadPolicy.unloadOnResourceErrors;

      case 'corruption':
        return wrapper.config.unloadPolicy.unloadOnCorruption;
    }
  }

  // Default: don't unload, just disable
  return false;
}
```

## Configuration Schema Extension

```typescript
const chroniclerConfigSchema = z.object({
  // ... existing fields

  unloadPolicy: z.object({
    unloadOnResourceErrors: z.boolean().default(false),
    unloadOnCorruption: z.boolean().default(true),
    maxConsecutiveFailures: z.number().default(3),
    backoffPolicy: z.enum(['disable', 'exponential', 'linear']).default('disable')
  }).optional()
});
```

## Benefits of This Design

### 1. **Predictable Behavior**
- Manager always knows when/why chroniclers are removed
- Atomic operations prevent race conditions
- Clear audit trail in logs

### 2. **Flexible Policies**
- Different chroniclers can have different failure tolerance
- Manager can implement sophisticated retry/backoff strategies
- Easy to change policies without modifying chronicler code

### 3. **Better Debugging**
```typescript
// Rich context for debugging:
this.logger?.log(
  `[ChroniclerManager] Unloading chronicler ${chroniclerId}: ${reason}`,
  "info",
  {
    errorType: fatalError.errorType,
    failureCount: wrapper.failureCount,
    uptime: Date.now() - wrapper.startTime,
    lastSuccess: wrapper.lastSuccessTime
  }
);
```

### 4. **Graceful Degradation**
```typescript
// Manager can choose to disable rather than unload:
private disableChronicler(chroniclerId: string, reason: string): void {
  const wrapper = this.getWrapper(chroniclerId);
  if (wrapper) {
    wrapper.isActive = false;
    wrapper.disabledReason = reason;
    // Keep for diagnostics but don't send events
  }
}
```

This approach gives you the best of both worlds: chroniclers can signal their assessment of error severity, but the manager maintains control over the actual lifecycle decisions. It's much more robust and debuggable than self-unloading while still being responsive to chronicler-detected fatal conditions.
</plans>

