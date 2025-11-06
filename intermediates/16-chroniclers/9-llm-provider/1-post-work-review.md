### **Refactoring Plan for the Chronicler System**

**Objective:** To refactor the chronicler implementation to improve modularity, remove test-specific artifacts from production code, enhance testability, and increase performance and reliability.

This plan is broken down into four main steps. It is recommended to follow them in order, as later steps depend on the architectural changes made in earlier ones.

---

### **Step 1: Foundational Refactoring - Dependency Injection and Test Spies**

**Goal:** Decouple the `ChroniclerManager` from the environment and remove global test artifacts from the `Chronicler` class. This addresses **Issues #3 and #2**.

#### **Part A: Inject the LLM Provider Registry**

1.  **File to Modify:** `server/chroniclers/chronicler-manager.ts`
2.  **Instructions:**
    *   Update the `ChroniclerManagerOptions` interface to accept an optional `LlmProviderRegistry`.
        ```typescript
        // server/chroniclers/chronicler-manager.ts
        import { LlmProviderRegistry } from "../llm/llm-provider-registry.js";

        export interface ChroniclerManagerOptions {
          logger?: Logger;
          waitForHealthChecks?: boolean;
          enablePersistence?: boolean;
          providerRegistry?: LlmProviderRegistry; // <-- Add this line
        }
        ```
    *   Modify the `ChroniclerManager` constructor to use the injected registry or create a new one if not provided.
        ```typescript
        // server/chroniclers/chronicler-manager.ts
        export class ChroniclerManager {
          // ... properties
          private providerRegistry: LlmProviderRegistry; // <-- No longer optional

          constructor(options: ChroniclerManagerOptions = {}) {
            this.logger = options.logger;

            if (options.enablePersistence !== false) {
              this.chroniclerDir = path.join(".tadpole", "chroniclers");
            }

            // Use injected registry or create a new one
            this.providerRegistry = options.providerRegistry || new LlmProviderRegistry({
              logger: this.logger,
              performHealthCheckOnInit: false,
            });

            this.initializeProviderRegistry(options.waitForHealthChecks);
          }
        // ... rest of the class
        ```
    *   In the `initializeProviderRegistry` method, **remove the `isTestEnvironment` check**. The logic should now run regardless of the environment, as tests will inject a mock registry.
        ```typescript
        // server/chroniclers/chronicler-manager.ts
        private async initializeProviderRegistry(waitForHealthChecks = false): Promise<void> {
            try {
              // REMOVE THE isTestEnvironment CHECK AROUND THIS BLOCK
              this.logger?.log("Initializing LLM Provider Registry", "info");

              // ... rest of the method remains the same ...

            } catch (error) {
              this.logger?.log(`Failed to initialize LLM providers: ${error}`, "error");
            }
        }
        ```

#### **Part B: Replace Global Test Spy with a Callback**

1.  **File to Modify:** `server/chroniclers/chronicler.ts`
2.  **Instructions:**
    *   Add an optional `onExecute` callback to the constructor signature.
        ```typescript
        // server/chroniclers/chronicler.ts
        constructor(
          private config: ChroniclerConfig,
          private phaseId: PhaseId,
          private llmCall: (
            id: string,
            options: TadpoleGenerateTextOptions,
          ) => Promise<TadpoleGenerateTextResult>,
          private logger?: Logger,
          chroniclerDir?: string,
          configDirectory?: string,
          runStartTime?: Date,
          private onExecute?: (id: string, events: ServerEvent[]) => void, // <-- Add this
          private providerRegistry?: LlmProviderRegistry,
        ) {
          // ... constructor logic
        }
        ```
    *   In the `executeChroniclerCall` method, replace the `global.__...` block with a call to the new callback.
        ```typescript
        // server/chroniclers/chronicler.ts
        private async executeChroniclerCall(events: ServerEvent[]): Promise<void> {
          // Replace this:
          // if (typeof global.__TADPOLE_TEST_EVENT_TRACKER === "function") {
          //   global.__TADPOLE_TEST_EVENT_TRACKER(this.config.id, events);
          // }

          // With this:
          this.onExecute?.(this.config.id, events);

          try {
            // ... rest of the method
          }
          // ...
        }
        ```

3.  **File to Modify:** `server/chroniclers/chronicler-manager.ts`
4.  **Instructions:**
    *   Update the `loadChroniclersForPhase` method to accept and pass through the `onExecute` callback.
        ```typescript
        // server/chroniclers/chronicler-manager.ts
        public async loadChroniclersForPhase(
          configs: ChroniclerConfig[],
          phaseId: PhaseId,
          llmCall: (
            id: string,
            options: TadpoleGenerateTextOptions,
          ) => Promise<TadpoleGenerateTextResult>,
          configDirectory?: string,
          runStartTime?: Date,
          onExecute?: (id: string, events: ServerEvent[]) => void, // <-- Add this
        ): Promise<void> {
            // ... inside the loop ...
            const chronicler = new Chronicler(
              config,
              phaseId,
              llmCall,
              this.logger,
              this.chroniclerDir,
              configDirectory,
              runStartTime,
              onExecute, // <-- Pass it here
              this.providerRegistry,
            );
            // ...
        }
        ```

**Outcome of Step 1:** The system is now properly decoupled. The manager's behavior is controlled by the objects it's given, not by environment variables. Test instrumentation is explicit and safe.

---

### **Step 2: Centralize and Simplify LLM Call Logic**

**Goal:** Eliminate the dual-path logic in `Chronicler.executeChroniclerCall` by making the `ChroniclerManager` solely responsible for creating the LLM call function. This addresses **Issue #1**.

1.  **File to Modify:** `server/chroniclers/chronicler-manager.ts`
2.  **Instructions:**
    *   Inside the `loadChroniclersForPhase` method, create a concrete `llmCall` function that uses the manager's `providerRegistry`.
        ```typescript
        // server/chroniclers/chronicler-manager.ts
        public async loadChroniclersForPhase(
          configs: ChroniclerConfig[],
          phaseId: PhaseId,
          // The llmCall parameter is now a fallback for tests
          llmCall: (
            id: string,
            options: TadpoleGenerateTextOptions,
          ) => Promise<TadpoleGenerateTextResult>,
          configDirectory?: string,
          runStartTime?: Date,
          onExecute?: (id: string, events: ServerEvent[]) => void,
        ): Promise<void> {
          // ...
          for (const config of configs) {
            try {
              // ... provider availability checks remain the same ...

              // Create the concrete LLM call function for production
              const concreteLlmCall = async (
                id: string,
                options: TadpoleGenerateTextOptions,
              ): Promise<TadpoleGenerateTextResult> => {
                const modelResult = this.providerRegistry.getProviderForModel(config.model);
                if (!modelResult.success) {
                  throw new ChroniclerFatalError(id, `Model ${config.model} is not available: ${modelResult.reason}`, "configuration", true);
                }

                const response = await generateText({
                    model: modelResult.model,
                    ...options,
                });

                return {
                    text: response.text,
                    finishReason: response.finishReason,
                    usage: {
                        // Adapt usage from AI SDK v2+
                        inputTokens: response.usage.promptTokens,
                        outputTokens: response.usage.completionTokens,
                    },
                };
              };

              const chronicler = new Chronicler(
                config,
                phaseId,
                // Use the concrete function in production, fallback to injected for tests
                this.providerRegistry ? concreteLlmCall : llmCall,
                this.logger,
                this.chroniclerDir,
                configDirectory,
                runStartTime,
                onExecute,
                // The providerRegistry is NO LONGER passed to the Chronicler
              );
              // ...
            } catch (error) {
              // ...
            }
          }
        }
        ```

3.  **File to Modify:** `server/chroniclers/chronicler.ts`
4.  **Instructions:**
    *   Remove the `providerRegistry` from the constructor and as a class property.
    *   Drastically simplify `executeChroniclerCall` to remove the `if/else` block.
        ```typescript
        // server/chroniclers/chronicler.ts
        export class Chronicler {
          // ... properties (remove providerRegistry)

          constructor(
            // ...
            runStartTime?: Date,
            private onExecute?: (id: string, events: ServerEvent[]) => void,
            // REMOVE providerRegistry from constructor signature
          ) {
            // ...
          }

          private async executeChroniclerCall(events: ServerEvent[]): Promise<void> {
            this.onExecute?.(this.config.id, events);

            try {
              // ... prepare templateContext, userMessage, renderedSystemPrompt ...

              // The entire if/else block is replaced with a single path
              if (this.historyManager) {
                // Conversational flow
                if (!renderedSystemPrompt) {
                   throw new Error(`[Chronicler:${this.config.id}] Conversational chroniclers require a system prompt`);
                }
                const messages = await this.historyManager.getMessagesToSend(renderedSystemPrompt);
                messages.push({ role: "user", content: userMessage });

                const options: TadpoleGenerateTextOptions = { /* ... */ messages };
                const response = await this.llmCall(this.config.id, options);
                await this.historyManager.addMessagePair(userMessage, response.text);
              } else {
                // Non-conversational flow
                const options: TadpoleGenerateTextOptions = { /* ... */ };
                await this.llmCall(this.config.id, options);
              }
            } catch (error) {
              // ... existing error handling
            }
          }
        }
        ```

**Outcome of Step 2:** The `Chronicler` is now truly agnostic about where its LLM capability comes from. The manager handles the "real" implementation, and tests provide a "mock" implementation, following the Dependency Inversion Principle.

---

### **Step 3: Improve Asynchronicity and Test Reliability**

**Goal:** Remove flaky `setTimeout` calls from tests by making event handling more deterministic, and improve performance by making the `immediate` strategy non-blocking. This addresses the "setTimeout" and "Async Execution" issues.

1.  **File to Modify:** `server/chroniclers/chronicler.ts`
2.  **Instructions:**
    *   In `handleEvent`, change the `immediate` strategy case to be fire-and-forget.
        ```typescript
        // server/chroniclers/chronicler.ts
        public async handleEvent(event: ServerEvent): Promise<void> {
          // ...
          switch (this.config.execution.strategy) {
            case "immediate": {
              // ...
              // Change this:
              // await this.executeChroniclerCall(eventsToProcess);

              // To this:
              this.executeChroniclerCall(eventsToProcess).catch((error) => {
                this.logger?.log(
                  `[Chronicler:${this.config.id}] Error in immediate LLM call: ${error}`,
                  "error",
                );
                // Error is now self-contained and will be picked up by manager on next event
              });
              break;
            }
            // ...
          }
        }
        ```

3.  **Files to Modify:** All test files in `tests/integration/` (e.g., `chronicler-triggers.test.ts`, `chronicler-edge-cases.test.ts`).
4.  **Instructions:**
    *   This is a pattern change. Replace all instances of `setTimeout` used for waiting.
    *   The new pattern for testing should be:
        1.  Create the `ChroniclerManager`.
        2.  Load chroniclers.
        3.  Loop through and call `manager.handleEvent(event)` for all test events. **Do not await these individually.**
        4.  Call `await manager.flush()`. This is the crucial step that forces all pending debounce, count, and timeWindow executions to run.
        5.  Now, make your assertions. They will be deterministic.

    **Example Test Refactor:**
    ```typescript
    // Before
    it("should batch events with debounce", async () => {
      // ... setup
      for (const event of events) {
        manager.handleEvent(event);
      }
      await new Promise(resolve => setTimeout(resolve, 1500)); // Flaky wait
      expect(mock.calls.length).toBe(1);
    });

    // After
    it("should batch events with debounce", async () => {
      // ... setup
      for (const event of events) {
        manager.handleEvent(event); // Fire and forget
      }
      await manager.flush(); // Deterministic execution
      expect(mock.calls.length).toBe(1);
    });
    ```

**Outcome of Step 3:** The test suite will be faster and significantly more reliable. The production `immediate` strategy will no longer block the main event processing loop.

---

### **Step 4: Code Cleanup and Finalizing E2E Tests**

**Goal:** Address the remaining minor code smells and refactor the E2E test to leverage our new dependency injection pattern. This addresses **Issues #4 and #7**.

1.  **File to Modify:** `server/chroniclers/prompt-templating-engine.ts`
2.  **Instructions:**
    *   Remove the redundant export.
        ```typescript
        // server/chroniclers/prompt-templating-engine.ts

        // REMOVE THIS LINE:
        // export const PromptTemplatingEngine = TemplateRenderer;
        ```

3.  **Project-Wide Change:**
    *   Perform a global find-and-replace in your IDE:
        *   Find: `PromptTemplatingEngine`
        *   Replace with: `TemplateRenderer`

4.  **File to Modify:** `tests/e2e/chronicler-llm-e2e.test.ts`
5.  **Instructions:**
    *   Restructure the test file to separate mock tests from real API tests.
    *   Use the new DI pattern to inject either a `MockLlmProviderRegistry` or a real `LlmProviderRegistry`.

    **Example Structure:**
    ```typescript
    // tests/e2e/chronicler-llm-e2e.test.ts
    import { describe, it, expect } from "bun:test";
    import { MockLlmProviderRegistry } from "../utils/mock-llm-provider-registry.js";
    import { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
    // ... other imports

    describe("Chronicler LLM Integration (with Mock Provider)", () => {
      it("should use the mock provider and process templates", async () => {
        const mockRegistry = new MockLlmProviderRegistry();
        // ... configure mock registry

        const manager = new ChroniclerManager({
          logger: mockLogger,
          providerRegistry: mockRegistry
        });

        // ... rest of test logic, no more conditional checks inside the test
      });
    });

    describe("Chronicler LLM Integration (with Real Provider)", () => {
      const hasApiKey = process.env.ANTHROPIC_API_KEY; // or check for any key

      it.if(hasApiKey)("should make a real LLM call", async () => {
        const realRegistry = new LlmProviderRegistry({ logger: mockLogger });
        const manager = new ChroniclerManager({
          logger: mockLogger,
          providerRegistry: realRegistry
        });

        // ... rest of test logic
      }, 15000); // Test timeout for API call
    });
    ```

**Outcome of Step 4:** The codebase is more consistent, and the E2E tests are cleaner, more readable, and better reflect modern testing practices for dependency-injected systems.

---

### **Verification and Testing Strategy**

After completing all steps, run `bun lint:fix` and `bun typecheck` and methodically fix any issues (no randomly widening types or adding underscores without understanding). Then run the entire test suite to ensure no regressions have been introduced.

```bash
bun test
```

Pay special attention to the tests in `tests/integration/` and `tests/e2e/`. They should all pass and run noticeably faster and more reliably due to the removal of `setTimeout`. The `chronicler-llm-e2e.test.ts` will now clearly show which tests are being skipped if API keys are not present.

### **Summary of Issues to Be Addressed**

This refactoring plan targets seven key issues to improve the chronicler system's architecture, testability, and reliability:

1.  **Dual LLM Call Logic:** The `Chronicler` class contains two separate implementations for calling an LLM—one for production (using `LlmProviderRegistry`) and one for testing (using an injected function). This violates the Single Responsibility Principle and complicates the code.
2.  **Test Artifacts in Production Code:** The presence of `global.__TADPOLE_TEST_EVENT_TRACKER` in `chronicler.ts` is a significant code smell. Production code should be completely unaware of the testing environment.
3.  **Environmental Coupling:** The `ChroniclerManager` currently changes its behavior based on the `NODE_ENV` environment variable to decide whether to initialize the LLM provider registry. This makes the system less modular and its dependencies implicit.
4.  **Redundant Exports:** The file `prompt-templating-engine.ts` exports the same object under two different names (`TemplateRenderer` and `PromptTemplatingEngine`), creating inconsistency.
5.  **Over-reliance on `setTimeout` in Tests:** The integration tests use fixed `setTimeout` delays to wait for asynchronous operations, leading to slow and potentially flaky test runs.
6.  **Blocking `await` in `immediate` Execution Strategy:** The `immediate` strategy blocks the event loop while waiting for an LLM call to complete, which can slow down the entire system and delay event processing for other chroniclers.
7.  **Overly Complex E2E Test:** The main E2E test (`chronicler-llm-e2e.test.ts`) contains complex internal logic to switch between mock and real providers, which is a symptom of the environmental coupling issue.

---

### **File Impact Analysis and Refactoring Guide**

Here is a breakdown of all the files that will need to be changed, with specific instructions for each.

#### **I. Core Logic Files**

These changes are foundational and should be done first.

**1. `server/chroniclers/chronicler-manager.ts`**
*   **Why:** To implement dependency injection for the provider registry (Issue #3) and to centralize the LLM call logic (Issue #1).
*   **Changes:**
    *   **Update `ChroniclerManagerOptions`:** Add an optional `providerRegistry: LlmProviderRegistry` property.
    *   **Modify Constructor:**
        *   Accept the new `options` object.
        *   Set `this.providerRegistry` to `options.providerRegistry` if it exists, otherwise create a `new LlmProviderRegistry(...)`.
    *   **Update `initializeProviderRegistry()`:** Remove the `if (!isTestEnvironment)` check. The logic should always run, as tests will now inject a mock.
    *   **Update `loadChroniclersForPhase()`:**
        *   This method will now be responsible for creating the concrete `llmCall` function for production.
        *   It will check `this.providerRegistry`, get the appropriate model, and create an `async` function that calls `generateText`.
        *   This new function will be passed to the `Chronicler` constructor.
        *   The `onExecute` callback for testing (from Issue #2) should also be added to the method signature and passed to the `Chronicler` constructor.

**2. `server/chroniclers/chronicler.ts`**
*   **Why:** To remove the dual LLM logic (Issue #1) and the global test spy (Issue #2), and to make the `immediate` strategy non-blocking (Issue #6).
*   **Changes:**
    *   **Modify Constructor:**
        *   **Remove** the `providerRegistry` parameter and class property. The chronicler should no longer be aware of it.
        *   **Add** an optional `onExecute?: (id: string, events: ServerEvent[]) => void` parameter for test instrumentation.
    *   **Simplify `executeChroniclerCall()`:**
        *   **Remove** the entire `if (this.providerRegistry)` block. The method will now have only one path.
        *   **Replace** the `global.__TADPOLE_TEST_EVENT_TRACKER` call with a call to `this.onExecute?.(this.config.id, events);` at the beginning of the method.
        *   The method will simply use `this.llmCall(...)` to execute the LLM request.
    *   **Update `handleEvent()`:**
        *   In the `case "immediate"`, change `await this.executeChroniclerCall(...)` to a fire-and-forget call: `this.executeChroniclerCall(...).catch(...)`.

**3. `server/chroniclers/prompt-templating-engine.ts`**
*   **Why:** To remove the redundant export (Issue #4).
*   **Changes:**
    *   Delete the line: `export const PromptTemplatingEngine = TemplateRenderer;`

**4. All files that import `PromptTemplatingEngine`**
*   **Why:** To standardize on the `TemplateRenderer` name (Issue #4).
*   **Changes:**
    *   Perform a project-wide find-and-replace:
        *   Find: `PromptTemplatingEngine`
        *   Replace with: `TemplateRenderer`
    *   This will likely affect `server/chroniclers/chronicler.ts` and potentially some test files.

#### **II. Testing Harness and Utilities**

These changes will make the test suite more robust and reliable.

**1. `tests/utils/chronicler-test-harness.ts` (if it exists, or create it)**
*   **Why:** To centralize test logic and remove `setTimeout` waits (Issue #5). The `runChroniclerTest` function lives here.
*   **Changes:**
    *   The `runChroniclerTest` function should be updated to create a `ChroniclerManager` and pass it a mock `onExecute` callback that populates the mock LLM call tracker.
    *   At the end of the event processing loop, the function must call `await manager.flush()`.
    *   **Remove any `setTimeout`** calls used for waiting. The `flush` call makes this deterministic.

**2. `tests/utils/mock-llm-provider-registry.ts` (if it exists, or create a mock in the test file)**
*   **Why:** To support the new dependency injection pattern for tests (Issue #3).
*   **Changes:**
    *   This file/class should provide a mock implementation of `LlmProviderRegistry` that can be configured for tests (e.g., to add mock models, set provider health, etc.).
    *   The `getProviderForModel` method should return a mock `LanguageModel` that connects to the test's mock `llmCall` function.

#### **III. Test Files**

These files need to be updated to use the new, more reliable testing patterns.

**1. `tests/integration/chronicler-triggers.test.ts`, `chronicler-edge-cases.test.ts`, `chronicler-wildcard-triggers.test.ts`**
*   **Why:** To remove `setTimeout` and adopt the new deterministic testing pattern (Issue #5).
*   **Changes:**
    *   Remove all `await new Promise(resolve => setTimeout(resolve, ...))` calls.
    *   Ensure that after all events are sent to the `ChroniclerManager`, a final `await manager.flush()` is called before making assertions. This will guarantee that all debounced, counted, or timed events are processed.

**2. `tests/e2e/chronicler-llm-e2e.test.ts`**
*   **Why:** To simplify the test by using dependency injection instead of internal logic (Issue #3 and #7).
*   **Changes:**
    *   **Split the file** into two `describe` blocks: "with Mock Provider" and "with Real Provider".
    *   In the "Mock Provider" block, instantiate `ChroniclerManager` with a `MockLlmProviderRegistry`.
    *   In the "Real Provider" block, instantiate `ChroniclerManager` with a real `LlmProviderRegistry`. Use `it.if(hasApiKey)` to ensure this test only runs when API keys are available in the environment. This removes all conditional logic from the test body itself.

By following this plan, you will systematically address each of the identified issues, resulting in a cleaner, more robust, and highly maintainable chronicler system ready for full integration.