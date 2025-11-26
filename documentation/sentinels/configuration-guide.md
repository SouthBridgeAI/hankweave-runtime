# Sentinel Configuration Guide

This guide provides a comprehensive walkthrough of how to configure Sentinels in Strandweave Runner. Sentinels are defined in JSON and can be included in your `codon-sequence.json` file to run alongside your main agent.

## The Wrapper Pattern

Sentinels are added to a codon's configuration using a "wrapper" pattern. This is a crucial concept that separates the reusable sentinel definition from its codon-specific settings. This allows you to define a sentinel once and use it in multiple codons with different settings.

In your `codon-sequence.json`, you add a `sentinels` array to a codon. Each entry in the array is an object containing:

- `sentinelConfig`: The path to a reusable sentinel JSON file or an inline sentinel configuration object.
- `settings`: An optional object for codon-specific settings, such as `failCodonIfNotLoaded` or `outputPaths`.

**Example `codon-sequence.json` entry:**
```json
{
  "id": "codon-1-analysis",
  "name": "Codon 1: Analysis",
  // ... other codon settings
  "sentinels": [
    {
      "sentinelConfig": "./sentinels/narrator.json",
      "settings": {
        "failCodonIfNotLoaded": true,
        "outputPaths": {
          "logFile": "codon-1-narrative.md"
        }
      }
    },
    {
      "sentinelConfig": {
        "id": "inline-counter",
        "name": "Event Counter",
        "model": "anthropic/claude-3-5-sonnet-20241022",
        "trigger": { "type": "event", "on": ["*"] },
        "execution": { "strategy": "count", "threshold": 10 },
        "userPromptText": "10 events have occurred."
      }
    }
  ]
}
```

## Basic Sentinel Structure

A sentinel configuration is a JSON object with several key fields.

**Minimal Example (`./sentinels/narrator.json`):**
```json
{
  "id": "narrator",
  "name": "Activity Narrator",
  "model": "anthropic/claude-3-5-sonnet-20241022",
  "trigger": {
    "type": "event",
    "on": ["assistant.action", "tool.result"]
  },
  "execution": {
    "strategy": "debounce",
    "milliseconds": 10000
  },
  "userPromptText": "Summarize the following agent activities in a human-readable way:\n\n<%= JSON.stringify(it.events, null, 2) %>"
}
```

### Required Fields
- `id`: A unique, machine-readable identifier (e.g., `my-sentinel`).
- `name`: A human-readable name for display in logs and UI.
- `model`: The full model ID to use (e.g., `anthropic/claude-3-5-sonnet-20241022`).
- `trigger`: An object defining when the sentinel should activate.
- `execution`: An object defining how events are batched and processed.
- `userPromptFile` or `userPromptText`: The prompt to send to the LLM.

## Triggers in Detail

The `trigger` object determines when a sentinel runs. There are two types: `event` and `sequence`.

### Event Triggers

An `event` trigger fires when one or more specific events occur.

```json
{
  "trigger": {
    "type": "event",
    "on": ["assistant.action", "tool.result"],
    "conditions": [
      {
        "path": "toolName",
        "operator": "equals",
        "value": "Bash"
      }
    ]
  }
}
```

- `on`: An array of event types to listen for. You can use a wildcard `"*"` to listen to all events.
- `conditions`: (Optional) An array of conditions that must all be true for the trigger to fire.

### Sequence Triggers

A `sequence` trigger fires when a specific pattern of events occurs in order.

```json
{
  "trigger": {
    "type": "sequence",
    "interestFilter": {
      "on": ["tool.result"]
    },
    "pattern": [
      { "type": "tool.result", "conditions": [{ "path": "isError", "operator": "equals", "value": true }] },
      { "type": "tool.result", "conditions": [{ "path": "isError", "operator": "equals", "value": true }] }
    ]
  }
}
```
- `interestFilter`: An `on` array (just like in event triggers) that pre-filters which events are considered for the pattern. This improves performance.
- `pattern`: An array of "pattern step" objects that define the sequence. Each step has a `type` and optional `conditions`.
- `options.consecutive`: (Optional) If `true`, the events in the pattern must occur one after another with no other events in between.

### Condition Operators

Conditions allow for fine-grained control over your triggers.

| Operator      | Description                               | Example Value              |
|---------------|-------------------------------------------|----------------------------|
| `equals`      | The value at `path` is exactly equal.     | `"Bash"`, `true`, `404`    |
| `notEquals`   | The value is not equal.                   | `"Bash"`                   |
| `in`          | The value is one of the items in an array.| `["Read", "Write"]`        |
| `notIn`       | The value is not in the array.            | `["Read", "Write"]`        |
| `contains`    | The string value contains a substring.    | `"error"`                  |
| `matches`     | The string value matches a regex pattern. | `"(rm -rf|mkfs)"`          |
| `greaterThan` | The numeric value is greater than.        | `1000`                     |
| `lessThan`    | The numeric value is less than.           | `0.5`                      |

## Execution Strategies

The `execution` object controls how a sentinel batches events when its trigger fires.

- **`immediate`**: Executes immediately for every single trigger match. No batching.
  ```json
  { "execution": { "strategy": "immediate" } }
  ```
- **`debounce`**: Waits for a quiet period before executing. If another trigger fires during the wait, the timer resets. All events collected during the window are batched together.
  ```json
  { "execution": { "strategy": "debounce", "milliseconds": 5000 } }
  ```
- **`count`**: Executes after a specific number of trigger matches have occurred.
  ```json
  { "execution": { "strategy": "count", "threshold": 5 } }
  ```
- **`timeWindow`**: Executes at a fixed time interval, batching all events that occurred during that window.
  ```json
  { "execution": { "strategy": "timeWindow", "milliseconds": 30000 } }
  ```

## Prompting and Templating

Sentinels use the Eta templating engine to dynamically insert data into prompts.

### Prompt Fields
- `userPromptFile` / `userPromptText`: The main prompt. At least one is required.
- `systemPromptFile` / `systemPromptText`: (Optional) The system prompt. Required for conversational sentinels.

You can provide a single path, or an array of paths to be concatenated.

### The `it` Context Object

Your templates have access to a context object named `it` with the following structure:

```typescript
{
  // The array of events that caused this trigger
  events: ServerEvent[],

  // Information about the current codon
  codon: {
    id: string,
    name: string,
    description?: string,
    startTime: Date
  },

  // General information
  world: {
    currentTime: Date // The timestamp when the trigger was queued
  }
}
```

### Template Example

```eta
A trigger occurred at <%= it.world.currentTime.toISOString() %> during codon '<%= it.codon.name %>'.

There were <%= it.events.length %> events in this batch.

<% for (const event of it.events) { %>
- Event Type: <%= event.type %>, Timestamp: <%= event.timestamp %>
<% } %>
```

## Conversational Sentinels

You can configure a sentinel to maintain a conversation history across multiple triggers within a codon. This allows it to build context over time.

```json
{
  "conversational": {
    "trimmingStrategy": {
      "type": "maxTurns",
      "maxTurns": 10
    }
  },
  "systemPromptText": "You are a helpful assistant that maintains context."
}
```

- `conversational`: The presence of this block enables conversational mode.
- `trimmingStrategy`: Defines how the history is pruned to prevent exceeding context limits.
  - `maxTurns`: Keeps the last N pairs of user/assistant messages.
  - `maxTokens`: Keeps as many recent messages as fit within a token limit.
- **Requirement**: A `systemPrompt` is required for conversational sentinels to establish their role.
- **State**: History is persisted to disk in the `.strandweave/sentinels/history/` directory, scoped to the sentinel and codon.

## Structured Output

Sentinels can be configured to produce validated, typed JSON objects instead of plain text, using Zod schemas.

```json
{
  "structuredOutput": {
    "output": "object",
    "schemaStr": "z.object({ entities: z.array(z.string()), sentiment: z.enum(['positive', 'neutral', 'negative']) })"
  }
}
```

- `structuredOutput`: The presence of this block enables structured output mode.
- `output`: The desired output format.
  - `object`: A single JSON object matching the schema.
  - `array`: An array of objects, each matching the schema.
  - `enum`: A single string value from a predefined list.
- `schemaStr`: A string containing the Zod schema definition (for `object` and `array`).
- `schemaFile`: A path to a `.ts` file containing the Zod schema (alternative to `schemaStr`).
- `enumValues`: An array of strings for `enum` mode.

### Example: Entity Extraction (`object`)
```json
{
  "id": "entity-extractor",
  "model": "anthropic/claude-3-5-sonnet-20241022",
  "userPromptText": "Extract entities from: <%= it.events[0].data.content %>",
  "structuredOutput": {
    "output": "object",
    "schemaStr": "z.object({ entities: z.array(z.string()), sentiment: z.enum(['positive', 'neutral', 'negative']) })"
  }
}
```

### Example: Task Generation (`array`)
```json
{
  "id": "task-generator",
  "userPromptText": "Generate 3 follow-up tasks.",
  "structuredOutput": {
    "output": "array",
    "schemaFile": "./schemas/task.ts"
  }
}
```
**`./schemas/task.ts`:**
```typescript
z.object({ task: z.string(), priority: z.enum(['high', 'medium', 'low']) })
```

### Example: Classification (`enum`)
```json
{
  "id": "risk-classifier",
  "userPromptText": "Classify the risk level of this action.",
  "structuredOutput": {
    "output": "enum",
    "enumValues": ["critical", "high", "medium", "low", "none"]
  }
}
```

## Codon-Specific Settings

These settings are defined in the `settings` block within your `codon-sequence.json`.

```json
"settings": {
  "failCodonIfNotLoaded": true,
  "outputPaths": {
    "logFile": "narrative.md",
    "lastValueFile": "latest-summary.md"
  },
  "reportToWebsocket": {
    "outputs": false
  }
}
```

- `failCodonIfNotLoaded`: (Default: `false`) If `true`, the entire codon will fail if this sentinel cannot be loaded (e.g., config file not found, invalid JSON). Use this for critical sentinels.
- `outputPaths`: Specifies where to write output files.
  - `logFile`: An append-only log of all outputs from the sentinel.
  - `lastValueFile`: A file that is overwritten with the latest output.
  - **Path Resolution**: If you provide just a filename (e.g., `"narrative.md"`), it will be placed in a dedicated directory inside `.strandweave/sentinels/outputs/`. If you provide a path with a slash (e.g., `"reports/narrative.md"`), it will be relative to the execution directory.
- `reportToWebsocket`: Controls which sentinel-related events are sent to the WebSocket client. This allows you to fine-tune the verbosity of the event stream.
  - `lifecycle`: (Default: `true`) `sentinel.loaded`, `sentinel.unloaded` events.
  - `errors`: (Default: `true`) `sentinel.error` events.
  - `outputs`: (Default: `true`) `sentinel.output` events.
  - `triggers`: (Default: `false`) `sentinel.triggered` events (can be very noisy).

## LLM Parameters

You can override the default LLM parameters for a sentinel.

```json
{
  "llmParams": {
    "temperature": 0.5,
    "maxOutputTokens": 4096,
    "maxRetries": 3
  }
}
```
- `temperature`: (Default: `0`) Controls randomness. `0` is deterministic.
- `maxOutputTokens`: (Default: `8192`) The maximum number of tokens in the response.
- `maxRetries`: (Default: `2`) How many times to retry a failed LLM call.

## Environment Variables

Sentinels use LLM Provider API keys from environment variables. You can set these to use different API keys for sentinels than for the main agent.

### Sentinel-Specific API Keys (STRANDWEAVE_SENTINEL_ Prefix)

Sentinels check for **sentinel-specific** environment variables first, then fall back to standard variables:

**Priority**: `STRANDWEAVE_SENTINEL_*` > Standard `*_API_KEY`

**Supported Variables**:
- `STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY` - For Anthropic models (claude-*)
- `STRANDWEAVE_SENTINEL_OPENAI_API_KEY` - For OpenAI models (gpt-*, o1-*)
- `STRANDWEAVE_SENTINEL_GROQ_API_KEY` - For Groq models (llama-*, mixtral-*)
- `STRANDWEAVE_SENTINEL_GOOGLE_API_KEY` - For Google models (gemini-*)

### Fallback Behavior

If a `STRANDWEAVE_SENTINEL_*` variable is **not** set, the system automatically falls back to the standard variable:

```bash
# Only standard variable set
export OPENAI_API_KEY=sk-shared-key

# Both main agent and sentinels use: sk-shared-key
```

This ensures backwards compatibility - existing setups continue working without changes.

### Debugging: Which Variable Was Used?

The server logs show which environment variable was actually used:

```
[INFO] Provider anthropic: Initialized (using STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY)
[INFO] Provider openai: Initialized (using OPENAI_API_KEY)
```

### Error Messages

If no API key is found, the error shows both variables that were checked:

```
Provider anthropic: No API key found (checked: STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY, ANTHROPIC_API_KEY)
```

```
