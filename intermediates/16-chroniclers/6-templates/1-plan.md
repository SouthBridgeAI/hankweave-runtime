### **Execution Plan: Chronicler Templating Engine (Updated)**

#### Summary of Updates

Based on code review and feedback:

1. **No new HistoryManager method needed** - Use existing `force` parameter on `addUserMessage()` for error recovery
2. **Simplified error handling** - Don't add user message until LLM call succeeds to avoid pending state issues
3. **Minimal helper library** - Only include `json()` helper for safe JSON.stringify in v1
4. **Realistic test scenarios** - Focus on JSON.stringify, spread operators, and iteration patterns with real ServerEvent data
5. **Added `continueOnError` to schema** - New field for conversational config to handle transient errors gracefully

---

#### 1. Feature Overview & Intent

**Intent:** The primary goal of this feature is to provide a powerful, expressive, and resilient templating system for Chroniclers. This system will transform the raw, structured array of `ServerEvent` objects from a trigger into a coherent, LLM-ready prompt.

**Core Philosophy:**

1.  **Developer-Centric Power:** The system is for developers. We will use the **Eta** templating engine to provide the full power and familiarity of JavaScript for data transformation within templates.
2.  **Resilience over Fragility:** Chroniclers are long-running observers. They must be resilient to transient errors. The system will support a configurable mode to ignore single-turn failures in conversational Chroniclers, allowing them to maintain long-term context despite temporary issues.
3.  **Isolation and Graceful Degradation:** A failure within a single Chronicler's templating or execution logic must be logged clearly but **must never** impact the main Tadpole agent or any other Chronicler.
4.  **Clear Separation of Concerns:** The logic for assembling prompts from files and text will be centralized within a dedicated templating service, simplifying the Chronicler's orchestration role.

---

#### 2. Feature Specification: Components & APIs

This feature will introduce one new service and update two existing components and one configuration schema.

##### **A. New Service: `PromptTemplatingEngine`**

*   **Location:** `server/chroniclers/prompt-templating-engine.ts`
*   **Purpose:** A stateless service responsible for all aspects of prompt assembly and rendering. It encapsulates the Eta templating engine.

*   **Dependencies:** Requires `eta` package - install with `bun add eta`

*   **Type Definitions:**
    ```typescript
    interface PromptSource {
      files?: string | string[];
      text?: string;
    }

    interface TemplateContext {
      events: ServerEvent[];
      phase: { id: string; name: string; description?: string; startTime: Date };
      run: { id: string; startTime: Date };
      world: { currentTime: Date };
      utils: { json(obj: any, indent?: number): string };
    }
    ```

*   **API:**
    *   `constructor()`: Stateless service, no configuration needed.
    *   `async format(templateString: string, context: TemplateContext): Promise<string>`: The primary public method that renders a pre-assembled template string.

*   **Internal Responsibilities:**
    1.  **Template Execution:** Execute pre-assembled template strings using `eta.renderAsync()` with timeout wrapper.
    2.  **Template Caching:** Cache compiled Eta template functions using template string as key. Implement LRU cache with max 100 entries to prevent unbounded memory growth.
    3.  **Error Handling:** Wrap template rendering in `try...catch` blocks.
    4.  **Timeout:** Enforce strict **3-second timeout** on template rendering to prevent runaway scripts.

*   **File Loading Optimization:** Prompt files are loaded once at chronicler creation time and held in memory, not on every template execution.

*   **Template Syntax Examples:**
    ```javascript
    // Event iteration
    <% for (const event of it.events) { %>
    Event: <%= event.type %> at <%= event.timestamp %>
    <% } %>

    // Conditional rendering
    <% if (it.events.some(e => e.type === 'error')) { %>
    ⚠️ Errors detected!
    <% } %>

    // JSON output
    Events: <%= it.utils.json(it.events.map(e => ({type: e.type, id: e.id}))) %>
    ```

##### **B. The Template Context Object (`it`)**

This is the API contract for template authors. The `PromptTemplatingEngine` will provide this object to every template.

*   `it.events: ServerEvent[]`: The array of events that triggered the Chronicler.
*   `it.phase: object`: Context about the current phase.
    *   `id: string`
    *   `name: string`
    *   `description: string | undefined`
    *   `startTime: Date` (A native JavaScript `Date` object)
*   `it.run: object`: Context about the current run.
    *   `id: string`
    *   `startTime: Date` (A native JavaScript `Date` object)
*   `it.world: object`: General, non-sensitive environmental information.
    *   `currentTime: Date` (The `Date` at the time of template execution)
*   `it.utils: object`: A minimal library of safe, pre-built helper functions.
    *   `json(obj: any, indent?: number): string` (Safe `JSON.stringify` with error handling)

##### **C. `HistoryManager` API Update**

*   **Location:** `server/chroniclers/history-manager.ts`
*   **No Changes Needed:** The existing `addUserMessage(userContent, force)` method already supports error recovery. When `force=true`, it will add a user message even if there's a pending one. For error recovery, we simply won't add the user message if the LLM call fails.

##### **D. `ChroniclerConfig` Schema Update**

*   **Location:** `server/config-validation/chronicler.schema.ts`
*   **Change:** Add a new optional boolean field to the `conversational` block:
    ```typescript
    conversational: z.object({
      trimmingStrategy: trimmingStrategySchema,
      continueOnError: z.boolean().optional().default(false), // NEW FIELD
    }).optional()
    ```
    *   `continueOnError`: If `true`, the Chronicler will ignore errors from a single templating/LLM-call cycle and attempt to continue the conversation on the next trigger.

---

#### 3. Behavioral Specification

##### **End-to-End "Happy Path" Flow**

1.  A trigger fires in a `Chronicler` instance, providing an array of `events`.
2.  The `Chronicler` assembles the `it` context object with current phase/run data and events.
3.  It calls `promptTemplatingEngine.format()` with the pre-loaded template string and the `it` context.
4.  The `PromptTemplatingEngine` renders the template string with Eta, returning the rendered user message string.
5.  **Flow Split:**
   - **Non-conversational:** Call `llmCall(id, events)` directly with events, write response to output file
   - **Conversational:**
     a. Call `historyManager.addUserMessage()` with the rendered string
     b. Call `historyManager.getMessagesToSend(systemPrompt)` to get message array
     c. Call `llmCall(id, messages)` (modified signature for conversational)
     d. Call `historyManager.addAssistantResponse()` with LLM response
     e. Write response to output file

##### **Failure Scenario 1: Template Error (Syntax or Runtime)**

1.  The `Chronicler` calls `promptTemplatingEngine.format()`.
2.  The `PromptTemplatingEngine` encounters an error during rendering (e.g., accessing a null property, invalid syntax).
3.  The `format` method throws a detailed error.
4.  The `Chronicler` catches the error.
5.  It logs a high-visibility error message: `[Chronicler: 'id'] Template rendering failed: <error message>`.
6.  **The execution cycle for this Chronicler terminates immediately.** No LLM call is made. The `HistoryManager` is not modified. The system waits for the next trigger.

##### **Failure Scenario 2: LLM Call Error with `continueOnError: true`**

1.  Templating succeeds.
2.  If conversational: The chronicler does NOT add the user message yet (to avoid pending state on error).
3.  The LLM call is made and it fails (e.g., network error, API rate limit).
4.  The `Chronicler` catches the error.
5.  It logs the error: `[Chronicler: 'id'] LLM call failed: <error message>`.
6.  It checks `config.conversational.continueOnError` and finds it `true`.
7.  It logs an additional message: `Ignoring error as per configuration and continuing conversation.`
8.  The execution cycle terminates. Since we didn't add the user message, the history remains clean for the next trigger.

**Alternative approach**: Add user message first, but only save assistant response on success. On error with `continueOnError: false`, the next trigger will fail due to pending message. With `continueOnError: true`, use `force=true` to override.

---

#### 4. Problems & Overcomplications to Avoid

*   **Minimal Helper Library (v1):** Only include `json()` for safe JSON.stringify. Skip date formatting and truncation helpers.
*   **No Template File I/O:** The `it` context must not allow file system access. All file content loaded via `promptFile` mechanism only.
*   **Simple Caching:** LRU cache with max 100 entries. Key = template string, Value = compiled function.
*   **Fixed Timeout:** Hard-coded 3-second timeout on template execution. Kill and throw error if exceeded.
*   **Encapsulation:** Chronicler interacts with PromptTemplatingEngine service, never directly with Eta instance.

---

#### 5. Integration Points in Existing Codebase

*   **`server/chroniclers/chronicler.ts`:** Main integration point:
    *   **At Construction:** Load and assemble prompt files using same pattern as `server/config.ts`
    *   **Store assembled template strings** in chronicler instance (userPromptTemplate, systemPromptTemplate)
    *   Instantiate and use the `PromptTemplatingEngine`
    *   Implement flow control for conversational vs non-conversational
    *   Handle `continueOnError` logic for conversational chroniclers
    *   Implement main `try...catch` block for templating and LLM error handling
*   **`server/config-validation/chronicler.schema.ts`:**
    *   Update schema to include the `continueOnError` field
*   **`server/chroniclers/chronicler-manager.ts`:**
    *   Pass `configDirectory` path to Chronicler constructor for prompt file resolution
*   **Dependencies:**
    *   Run `bun add eta` to install Eta templating engine

---

#### 6. Testing Plan

A robust testing suite is critical for this feature.

*   **Unit Tests for `PromptTemplatingEngine`:**
    *   Verify it correctly renders template strings with injected `it` context and sub-properties
    *   Test graceful failure on template syntax errors
    *   Test graceful failure on template runtime errors
    *   Test that the 3-second timeout works correctly
    *   Test template caching (same template returns cached function)
    *   Test LRU cache eviction when max entries exceeded

*   **Unit Tests for Chronicler Prompt Loading:**
    *   Test prompt assembly from `text` only, `files` only (single and multiple), and combinations
    *   Test file path resolution (relative to config directory, absolute paths unchanged)
    *   Test error handling for non-existent files at chronicler creation time
    *   Test file reading errors are caught during construction, not execution

*   **Unit Tests for Template Processing:**
    *   Test `it.utils.json()` on realistic event objects with nested data, arrays, circular references
    *   Test spread operators: `<% it.events.map(e => e.type).join(', ') %>`
    *   Test iteration: `<% for (const event of it.events) { %>Event: <%= event.type %><%  } %>`
    *   Test conditional rendering based on event types and data
    *   Test handling of undefined/null values in events (should not crash)
    *   Test complex ServerEvent data including tool.result events with large outputs

*   **Integration Tests for `Chronicler`:**
    *   Test conversational vs non-conversational flow differences
    *   Test template rendering failure → no LLM call made
    *   Test LLM failure with `continueOnError: false` → history left pending
    *   Test LLM failure with `continueOnError: true` → clean recovery on next trigger
    *   Test successful conversational flow over multiple triggers
    *   Test with realistic ServerEvent data and various execution strategies

*   **Quality Assurance:**
    *   Run `bun lint:fix` after implementation to catch and fix linting issues
    *   Run `bun tc` to verify type checking passes
    *   Carefully fix any type errors without widening types unnecessarily
    *   Update chronicler system documentation after testing is complete
