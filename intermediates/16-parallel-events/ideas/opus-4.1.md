Looking at your codebase, this is a fantastic addition that fits naturally with your existing event-driven architecture! Let me share my thoughts:

## Naming Suggestions

Given the Tadpole/amphibian theme and what these components do, here are some options:

1. **"Observers"** - Clean, describes their function well, fits the scientific observation theme
2. **"Lenses"** - They provide different views/perspectives on the same data stream
3. **"Filters"** (aquatic theme) - Like filter feeders extracting nutrients from water
4. **"Neurons"** - Processing units that respond to stimuli and produce signals
5. **"Chroniclers"** - From sci-fi, recording and interpreting events

I personally like **"Observers"** or **"Lenses"** - they're clear and fit the pattern of observing the event stream and producing focused insights.

## Architecture Observations & Recommendations

Looking at your code, you already have excellent foundations:

### What You Have Working For You:
1. **Robust event system** - Your `ServerEvent` types flow through WebSocket
2. **Event sourcing mindset** - State transitions, event logging to JSONL
3. **Parallel processing** - `ClaudeLogParser` already runs in parallel
4. **Type safety** - Strong TypeScript patterns throughout
5. **AI SDK** - Ready for multi-model support

### Suggested Design Pattern: Event Projections

Think of these as **event projections** (from event sourcing) that:
- Subscribe to specific event patterns
- Maintain their own state
- Produce derived outputs asynchronously

```typescript
interface ObserverConfig {
  id: string;
  name: string;
  description?: string;

  // Event filtering
  triggers: EventTrigger[];

  // LLM configuration
  model: {
    provider: 'openai' | 'anthropic' | 'groq';
    model: string;
    temperature?: number;
  };

  // Processing configuration
  processing: {
    mode: 'immediate' | 'batch' | 'windowed';
    batchSize?: number;
    windowMs?: number;
    includeHistory?: boolean;
    maxHistoryEvents?: number;
  };

  // Prompts
  systemPromptFile?: string;
  systemPromptText?: string;
  promptTemplate?: string; // With {{event}} placeholders

  // Output configuration
  output: {
    format: 'text' | 'json' | 'structured';
    schema?: any; // JSON Schema for structured output
    destination: string; // File path
    append?: boolean;
    stream?: boolean;
  };

  // Resource limits
  limits?: {
    maxTokensPerCall?: number;
    maxCallsPerMinute?: number;
    maxCostPerHour?: number;
  };
}

interface EventTrigger {
  eventTypes?: string[]; // e.g., ['assistant.action', 'tool.result']
  toolNames?: string[];  // Filter by specific tools
  phaseIds?: string[];   // Only certain phases
  conditions?: {        // Custom conditions
    path: string;      // JSONPath to field
    operator: 'eq' | 'contains' | 'matches';
    value: any;
  }[];
}
```

## Implementation Considerations

### 1. **Event Queue & Backpressure**
```typescript
class ObserverManager {
  private observerQueues = new Map<string, EventQueue>();

  // Each observer gets its own queue to prevent blocking
  async processEvent(event: ServerEvent) {
    for (const observer of this.activeObservers) {
      if (this.matchesTriggers(event, observer.triggers)) {
        // Non-blocking enqueue
        this.observerQueues.get(observer.id)?.enqueue(event);
      }
    }
  }
}
```

### 2. **State Management**
Observers might need to accumulate context:
```typescript
class ObserverState {
  private eventWindow: ServerEvent[] = [];
  private derivedState: Map<string, any> = new Map();

  // Sliding window of events
  addEvent(event: ServerEvent) {
    this.eventWindow.push(event);
    if (this.eventWindow.length > this.maxWindow) {
      this.eventWindow.shift();
    }
  }
}
```

### 3. **Streaming vs Batch**
```typescript
// Immediate: Process each event as it arrives
// Batch: Collect N events, then process
// Windowed: Process every T milliseconds with accumulated events
```

### 4. **Example Observer Configurations**

```json
[
  {
    "id": "code-quality-monitor",
    "name": "Code Quality Observer",
    "triggers": [{
      "eventTypes": ["tool.result"],
      "toolNames": ["Write", "Edit", "MultiEdit"]
    }],
    "model": {
      "provider": "openai",
      "model": "gpt-4-turbo"
    },
    "systemPromptText": "You are a code quality analyst. Evaluate the code changes for bugs, style issues, and improvements.",
    "output": {
      "format": "structured",
      "schema": {
        "type": "object",
        "properties": {
          "quality_score": { "type": "number" },
          "issues": { "type": "array" },
          "suggestions": { "type": "array" }
        }
      },
      "destination": "observers/code-quality.jsonl"
    }
  },
  {
    "id": "executive-summary",
    "name": "Executive Summary Generator",
    "triggers": [{
      "eventTypes": ["phase.completed"]
    }],
    "processing": {
      "mode": "immediate",
      "includeHistory": true,
      "maxHistoryEvents": 100
    },
    "model": {
      "provider": "anthropic",
      "model": "claude-3-haiku"
    },
    "systemPromptText": "Create a concise executive summary of what was accomplished.",
    "output": {
      "format": "text",
      "destination": "observers/summaries/{{phaseId}}.md"
    }
  }
]
```

## Additional Concerns

1. **Cost Management**: Track observer LLM costs separately from main agent costs
2. **Error Isolation**: Observer failures shouldn't affect main execution
3. **Replay Capability**: Ability to replay events through observers for testing
4. **Performance Monitoring**: Track observer latency and resource usage
5. **Dependency Management**: Some observers might depend on others' outputs
6. **Privacy/Security**: Observers might need different data access levels

## Event Sourcing Benefits

Your architecture is already event-sourced, which is perfect because:
- **Replay**: Can replay past executions through new observers
- **Debugging**: Can test observers on historical data
- **Flexibility**: Add new observers without changing core system
- **Audit**: Complete trace of what observers saw and produced

Would you like me to elaborate on any of these aspects or create a more detailed implementation plan for the Observer system?