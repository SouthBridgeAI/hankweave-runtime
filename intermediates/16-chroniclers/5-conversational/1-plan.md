### **The Conversational Chronicler: A Detailed Explanation**

Imagine you hire a personal assistant whose only job is to watch an AI developer work and write a running summary of what's happening. You don't want the assistant to interrupt the developer, just to observe and keep a coherent journal. This is exactly what a Conversational Chronicler does.

Its goal is to maintain a continuous, stateful "conversation" with an LLM about the events of a Tadpole phase, allowing it to build context over time.

Here is the step-by-step lifecycle of how it works:

#### **1. Waking Up (Initialization)**

When a Tadpole phase begins, any configured Conversational Chroniclers "wake up." However, they don't immediately load their history - this happens lazily on first use.

*   **Lazy initialization:** The chronicler waits until it actually needs to process events before initializing.
*   **Directory creation:** On first use, it ensures the `.tadpole/chroniclers/` directory exists.
*   **It checks for a history file:** It looks for a file like `.tadpole/chroniclers/narrator.json`.
*   **It reads its memory:** If the file exists, the Chronicler parses the JSON array and loads the past conversation (a series of "user" and "assistant" messages) into its in-memory history. This is how it remembers what happened if the server was restarted. If no file exists, it starts with a blank slate.
*   **NO system prompt storage:** The system prompt is NOT stored in the history file. It's passed fresh each time (since it may be templated with dynamic values).

At this point, the Chronicler is ready and is silently listening.

#### **2. The Trigger (Listening for Something Interesting)**

The Chronicler doesn't react to every single event. It waits for its specific `trigger` conditions to be met. This is like telling our assistant, "Only tap me on the shoulder when something important happens."

*   An "important event" is defined by the trigger configuration. It could be:
    *   A single event: "After every `tool.result` that is an error."
    *   A batch of events: "After 5 `file.updated` events have occurred."
    *   A timed window: "After a 10-second burst of activity has quieted down (debounce)."

When the trigger fires, it hands the Chronicler a **batch of the raw server events** that just occurred.

#### **3. Taking Notes (Processing the *New* Batch of Events)**

This is a critical step. The Chronicler now takes the **new batch of raw events** it just received and turns them into a single, human-readable "note."

*   **Template Processing Happens Outside HistoryManager:** The conversion of raw events into formatted text happens at a higher level (in the Chronicler or its caller). The HistoryManager only receives the final formatted string - it doesn't know about events or templates.
*   The caller uses its `promptTemplate` to format the events. For example, if it received two `file.updated` events, the template might turn them into a single string:
    > `"User: The following files were just changed: `src/index.ts` was modified, and `src/utils.ts` was created."`
*   **Crucially, it does NOT go back and re-process old raw events.** The history of previous events is already "frozen" as text in its conversation history. It only ever templates the new batch.
*   This newly formatted string is passed to `HistoryManager.addUserMessage()` as a simple string.

#### **4. Building the Message List (Preparing for Future LLM Integration)**

**Note: The actual LLM call is not implemented in this phase. We're focusing on the history management infrastructure first.**

The HistoryManager provides a method `getMessagesToSend(systemPrompt)` that returns a properly formatted array of `TadpoleModelMessage[]`:

1.  `System: "You are a helpful narrator..."` **<-- Fresh system prompt (passed in each time)**
2.  `User: "The session started and the agent read the main project file."`
3.  `Assistant: "Understood. The agent is beginning its analysis."`
4.  `User: "The agent just created a new utility file and added a helper function."` **<-- The new note**

The system prompt is added fresh each time, not stored in the history. This allows it to contain dynamic, templated values that may change between calls.

#### **5. Managing Response State (Pending Message Tracking)**

To maintain conversation integrity, the HistoryManager tracks whether there's a pending user message waiting for an assistant response:

- When `addUserMessage()` is called, it sets a `hasPendingUserMessage` flag
- If another user message is added while one is pending, it throws an error (unless forced)
- When `addAssistantResponse()` is called, it clears the pending flag
- The history is immediately saved to disk after each assistant response

This ensures the conversation always maintains proper user/assistant alternation.


#### **6. Trimming the History (Memory Management)**

A conversation can't grow forever. The HistoryManager automatically prunes the history based on the configured strategy:

*   **`maxTurns`:** Keeps only the N most recent complete turns (user + assistant pairs)
*   **`maxTokens`:** Removes oldest messages until total token count is under the limit

The pruning happens automatically when `getMessagesToSend()` is called, before returning the message list.

#### **7. Saving the Notebook (Persistence for Safety)**

The Chronicler's memory is valuable. To protect against server crashes, it saves its journal to disk immediately after each successful LLM interaction.

*   **Immediate Save:** After adding the assistant's response to the history, the Chronicler immediately saves the entire conversation to disk. This ensures no data is lost even if the server crashes.
*   **Atomic Writes:** The save operation uses an atomic write pattern:
    1. Write to a temporary file (`.tmp`)
    2. Atomically rename the temp file to the main file
*   **Simple JSON Format:** The entire conversation history is saved as a JSON array. This is simpler than JSONL and easier to validate and recover.
*   **Optional Persistence:** If no chronicler directory is provided (e.g., in testing), the history manager runs in memory-only mode without file persistence.
*   **Directory Management:** The parent ChroniclerManager creates and manages the `.tadpole/chroniclers/` directory, passing it to individual chroniclers.

This approach prioritizes data safety over performance, ensuring conversations are never lost when persistence is enabled.

#### **8. Validation and Error Handling**

The system includes several validation and error handling mechanisms:

*   **System Prompt Required:** Conversational chroniclers must have a system prompt defined (validated at configuration time).
*   **Pending Message Validation:** The system prevents adding multiple user messages without assistant responses (unless forced).
*   **Graceful Degradation:** If the chronicler directory can't be created, the system falls back to memory-only mode.
*   **Comprehensive Logging:** All operations are logged with appropriate levels (debug, info, warn, error) for troubleshooting.

**Note:** Context length retry logic will be implemented when the full LLM integration is added in a future phase.

#### **9. Implementation Phases**

This conversational chronicler implementation is being built in phases:

**Phase 1 (Current):**
- ✅ Configuration schema with `conversational` field
- ✅ HistoryManager class for conversation state management
- ✅ Basic integration with Chronicler class (just instantiation)
- ✅ ChroniclerManager directory handling
- ✅ Unit tests for HistoryManager and configuration

**Phase 2 (Future):**
- Integration with trigger execution flow
- Event templating and serialization
- Actual LLM call implementation
- Output file writing
- Context length error handling and retries

**Phase 3 (Future):**
- Integration with TadpoleServer
- End-to-end testing
- Performance optimization
- Advanced features (e.g., conversation forking, history export)

#### **10. Message Types and AI SDK Compatibility**

All messages passed to the LLM conform to the Tadpole AI input message schemas defined in `server/types/input-ai-types.ts`. This ensures type safety and compatibility with the AI SDK.

- **Schema Source of Truth**
  - We use the following Zod schemas and derived types:
    - `tadpoleModelMessageSchema` (discriminated union)
    - `TadpoleModelMessage`, `TadpoleSystemModelMessage`, `TadpoleUserModelMessage`, `TadpoleAssistantModelMessage`
  - History only stores user and assistant messages:
    - History type: `Array<TadpoleUserModelMessage | TadpoleAssistantModelMessage>`
  - The system prompt is passed fresh each call and represented as:
    - `TadpoleSystemModelMessage`

- **Returned Message Shape**
  - `HistoryManager.getMessagesToSend(systemPrompt)` returns `TadpoleModelMessage[]`
  - The first element is always a `TadpoleSystemModelMessage`
  - The remaining elements are the pruned conversation history (user/assistant)

- **Validation**
  - When loading persisted history, each entry is validated with `tadpoleModelMessageSchema.safeParse(...)`
  - Only valid `user` or `assistant` messages are kept in memory
  - This guarantees that persisted data remains compatible with the SDK

- **Chronicler LLM Interface**
  - The conversational flow constructs an array of `TadpoleModelMessage` and forwards it to the LLM call
  - The stateless flow continues to pass events directly (no changes)

Example (plan-level illustration):
```ts
import type {
  TadpoleModelMessage,
  TadpoleSystemModelMessage,
  TadpoleUserModelMessage,
  TadpoleAssistantModelMessage,
} from "../types/input-ai-types.js";

// HistoryManager
type HistoryArray = Array<TadpoleUserModelMessage | TadpoleAssistantModelMessage>;

async function getMessagesToSend(systemPrompt: string): Promise<TadpoleModelMessage[]> {
  const system: TadpoleSystemModelMessage = { role: "system", content: systemPrompt };
  return [system, ...history]; // history is HistoryArray
}

// Chronicler
type LlmCall = (id: string, events: ServerEvent[], messages?: TadpoleModelMessage[]) => Promise<string>;
```
