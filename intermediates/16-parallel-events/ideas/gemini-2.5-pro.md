Excellent, this is a fantastic and powerful feature idea. It moves Tadpole from being just a linear executor to a platform for multi-agent analysis and observation. Let's break this down.

### What's a Good Name?

This is a fun and important part of building a system's identity. You're right to look for something thematic.

*   **Watchers/Reporters/Observers:** These are descriptive and clear, common in software design (Observer pattern). They are safe but maybe lack a bit of personality.
*   **Sidecars:** From the world of microservices, this is a very strong technical analogy. A sidecar runs alongside a primary application, augmenting its functionality without being part of the core process. This fits perfectly.
*   **MCU/Sci-Fi/Biology:**
    *   **Symbiotes:** This is a brilliant idea. A symbiote lives in a close relationship with a host organism (the core agent). It feeds on the host's activity stream and produces something valuable in return. It's memorable, fits the "Tadpole" biological theme, and perfectly describes the relationship.
    *   **Sentinels:** (X-Men/Matrix) Implies watching over, guarding, and analyzing. Very cool.
    *   **Chroniclers:** (Dune) Their purpose is to observe and record history, which aligns with generating human-readable results.
    *   **Familiars:** (Fantasy) Magical companions that assist a primary user.

**Recommendation:** I strongly recommend **Symbiotes**. It's unique, thematic, and technically accurate in a metaphorical sense. It suggests a collection of different organisms (LLM calls) that can attach to a phase and enhance it.

---

### Analysis of the Code and Architectural Fit

Your existing architecture is *perfectly* suited for this feature. The key enablers I see are:

1.  **Event-Driven Core (`TadpoleServer`, `TypedEventEmitter`):** The server is built around a central event bus. `TadpoleServer` emits a rich stream of `ServerEvent` types for everything from phase state changes (`phase.started`, `phase.completed`) to granular agent actions (`assistant.action`, `tool.result`, `file.updated`). This is the lifeblood for the Symbiotes. They can simply subscribe to this stream.

2.  **Event Sourcing Pattern (`StateManager`):** You've already embraced the core principle of event sourcing. The `StateManager` processes a queue of `StateTransition` events to build its state. The `ServerEvent` stream is a direct result of this. The Symbiotes will act as **consumers** or **projections** of this event stream, running in parallel to the main state-modifying loop. This is a classic and powerful pattern.

3.  **Configuration-Driven Design (`phases.json`, `config.ts`):** The system is designed to be configured via JSON. Adding a `symbiotes` array to the `PhaseConfig` schema in `config.ts` is the natural place to define these parallel agents.

4.  **AI SDK (`ai-sdk-docs.md`):** You've provided the documentation for a modern AI SDK. This is crucial. We don't need to replicate the complex `ClaudeProcessManager` for these parallel calls. The Symbiotes can use the SDK's `generateObject`, `streamObject`, `generateText`, and `streamText` functions for their own, more lightweight LLM interactions. This decouples them from the core `claude-cli` process.

### Design Proposal: The Symbiote System

Let's outline a concrete design based on your requirements.

#### 1. Configuration in `phases.json`

We'll add a `symbiotes` array to the `PhaseConfig` schema. Each object in the array defines one parallel LLM agent.

```json
// In your phases.json, inside a phase object:
{
  "id": "phase-2-implementation",
  "name": "Phase 2: Implementation",
  // ... other phase properties ...
  "trackedFiles": ["src/**/*.ts", "analysis.md"],
  "symbiotes": [
    {
      "id": "file-tracker",
      "description": "Keeps a running list of all files read or written by the agent.",
      "trigger": {
        "on": ["tool.result"],
        "filter": {
          "toolName": ["Read", "Write", "Edit", "MultiEdit"]
        }
      },
      "promptFile": "symbiote_prompts/track_files.md",
      "model": "openai/gpt-4o-mini",
      "output": {
        "mode": "json",
        "schemaFile": "symbiote_schemas/file_access.json",
        "file": ".tadpole/symbiotes/file_access_log.jsonl"
      },
      "history": {
        "mode": "full"
      }
    },
    {
      "id": "quality-evaluator",
      "description": "Evaluates if the agent is making progress or getting stuck.",
      "trigger": {
        "on": ["assistant.action", "tool.result"],
        "debounceMs": 5000
      },
      "systemPromptText": "You are an expert software engineering manager observing a junior AI developer. Is the developer making logical steps? Are they stuck in a loop? Provide a brief evaluation.",
      "promptFile": "symbiote_prompts/evaluate_step.md",
      "model": "anthropic/claude-3.5-sonnet",
      "includeFiles": ["analysis.md"],
      "output": {
        "mode": "text",
        "file": ".tadpole/symbiotes/quality_log.txt",
        "stream": true
      },
      "history": {
        "mode": "none"
      }
    }
  ]
}
```

**Configuration Fields Explained:**

*   `id`: A unique name for the Symbiote (e.g., "quality-evaluator").
*   `description`: What this Symbiote does.
*   `trigger`:
    *   `on`: An array of `ServerEvent` types that can trigger this Symbiote (e.g., `"tool.result"`, `"assistant.action"`).
    *   `filter`: (Optional) Conditions to further refine the trigger. E.g., only trigger for specific `toolName`s.
    *   `debounceMs`: (Optional) Wait this many milliseconds after the last trigger event before firing, to batch related events.
*   `promptFile` / `promptText`: The prompt for the Symbiote's LLM. It will be combined with the triggering event data.
*   `systemPromptFile` / `systemPromptText`: The system prompt.
*   `model`: The model and provider to use (e.g., `"anthropic/claude-3.5-sonnet"`), leveraging the AI SDK's format.
*   `includeFiles`: (Optional) An array of glob patterns for files whose content should be included in the prompt context.
*   `output`:
    *   `mode`: `"text"` or `"json"`.
    *   `schemaFile` / `schema`: If `mode` is `json`, the Zod/JSON schema for structured output.
    *   `file`: The file to write results to. Using `.jsonl` is an excellent idea for append-only, structured data.
    *   `stream`: (Optional) `true` to stream results to the file as they are generated.
*   `history`:
    *   `mode`: `"full"` to maintain a chat history for context, or `"none"` for stateless calls.

#### 2. Implementation Plan

This can be implemented without major refactoring of the core `TadpoleServer` loop.

1.  **Create a `SymbioteRunner` Class:** This class will manage the lifecycle of a single Symbiote instance for a phase.
    *   `constructor(symbioteConfig, phaseContext)`: Takes its configuration and context (execution path, logger).
    *   `handleEvent(event: ServerEvent)`: The core method. It checks if the event matches the `trigger`, assembles the prompt, makes the LLM call, and handles the output.
    *   `start()`: Initializes resources (e.g., file streams).
    *   `stop()`: Cleans up resources.

2.  **Integrate into `TadpoleServer`:**
    *   In `startPhase`, after initializing the phase, loop through `phase.symbiotes` and create a `SymbioteRunner` instance for each. Store them in a `this.activeSymbiotes` array.
    *   Subscribe each `SymbioteRunner` to the server's event bus: `this.on('event', symbioteRunner.handleEvent.bind(symbioteRunner));`.
    *   In `cleanupCurrentPhase`, iterate through `this.activeSymbiotes` and call their `stop()` method, then clear the array.

3.  **The `handleEvent` Logic in `SymbioteRunner`:**
    *   When an event is received, check against `trigger.on` and `trigger.filter`.
    *   If it matches, assemble the prompt context:
        *   Start with the Symbiote's `promptFile`/`promptText`.
        *   Append a formatted version of the triggering event (e.g., `JSON.stringify(event.data)`).
        *   If `includeFiles` is set, use `fileResolver` to get the file paths and read their content. Append this to the prompt.
    *   Manage the message history array if `history.mode` is `"full"`.
    *   Make the AI SDK call:
        *   If `output.mode === 'json'`, use `generateObject({ schema, ... })`.
        *   If `output.stream === true`, use `streamText` or `streamObject`.
    *   Handle the result:
        *   For streaming, iterate through the `textStream` or `partialObjectStream` and append to the output file.
        *   For non-streaming, await the full `text` or `object` and append it as a single line to the output file.

#### 4. Other Concerns & Implementation Details

*   **Performance and Cost:** Running multiple LLMs in parallel can be expensive and slow down the main agent if not handled correctly.
    *   **Asynchronicity:** All Symbiote LLM calls must be fully asynchronous (`await`-ed in a non-blocking way) so they don't block the main event loop.
    *   **Cost Control:** We should add a separate cost tracker for Symbiotes and potentially emit a `symbiote.token.usage` event.
    *   **Model Choice:** Encourage using cheaper, faster models (like Sonnet or GPT-4o-mini) for Symbiote tasks that don't require Opus-level reasoning.

*   **Error Handling:** A failing Symbiote must *not* crash the main phase. The `handleEvent` method in `SymbioteRunner` should have a top-level `try...catch` block. Errors should be logged and potentially sent as a `symbiote.error` event to the client.

*   **State & History:** For the first version, the Symbiote's chat history can be managed in-memory by the `SymbioteRunner`. If the server restarts, the history is lost. A more advanced version could persist this history or rebuild it from the output `.jsonl` file upon resuming a phase.

*   **Circular Triggers:** A Symbiote that writes to a file could trigger a `file.updated` event. If that same Symbiote is configured to trigger on `file.updated`, it could create an infinite loop. We need to ensure Symbiotes ignore events generated by their own actions, perhaps by tagging the output or having them ignore their own output files.

This feature would be a massive enhancement to Tadpole's capabilities, turning it into a multi-agent observation and analysis platform. The "Symbiote" concept is strong, and the existing architecture is perfectly poised to support it.