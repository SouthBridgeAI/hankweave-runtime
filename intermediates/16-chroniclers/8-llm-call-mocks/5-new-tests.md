### **Testing Philosophy: Moving from "Did it run?" to "Did it do the right thing?"**

Your previous tests confirmed that triggers match and an LLM call happens. These new tests will verify:
1.  **Correctness:** Was the *right prompt* sent to the LLM?
2.  **Statefulness:** Is conversation history being managed correctly?
3.  **Resilience:** Does the system handle LLM failures and bad data gracefully?

---

### **1. New Unit Tests**

These tests focus on the `Chronicler` and `HistoryManager` classes in isolation.

#### **File Location:** `tests/unit/history-manager.test.ts`

This file already exists, but we can expand it to be more thorough.

##### **`HistoryManager` Pruning and Persistence Logic**
```typescript
describe("HistoryManager Logic Tests", () => {
  it("should correctly prune history based on maxTurns", async () => {
    // Setup with maxTurns: 2
    // Add 3 message pairs
    // Assert history contains only the last 2 pairs
  });

  it("should correctly prune history based on maxTokens", async () => {
    // Setup with a low maxTokens value
    // Add a long message pair, then a short one
    // Assert the long pair is pruned and the short one remains
  });

  it("should not prune if under the limits", async () => {
    // Setup with maxTurns: 5
    // Add 4 message pairs
    // Assert all 4 pairs are still in the history
  });

  it("should handle loading a corrupted history file and start fresh", async () => {
    // Write invalid JSON to the history file
    // Create HistoryManager
    // Assert that getMessagesToSend returns only the system prompt
  });

  it("should filter invalid message types when loading from a file", async () => {
    // Write a history file with user, assistant, AND system/tool messages
    // Create HistoryManager and load the file
    // Assert that the history only contains the user and assistant messages
  });

  it("should not attempt to save or load files in memory-only mode", async () => {
    // Instantiate HistoryManager with 'chroniclerDir' as undefined
    // Add a message pair
    // Assert no file was written to disk
  });
});
```

#### **File Location:** `tests/unit/chronicler-logic.test.ts` (New File)

This file will test the internal logic of a single `Chronicler` instance, mocking its dependencies (`HistoryManager`, `llmCall`).

##### **Chronicler's LLM Call Construction**
```typescript
import { describe, it, expect, spyOn } from "bun:test";
import { Chronicler } from "../../server/chroniclers/chronicler";
import { HistoryManager } from "../../server/chroniclers/history-manager";
import { createMockLlm } from "../utils/mock-llm";
// ... other imports

describe("Chronicler LLM Interaction Logic", () => {
  const mockLlmProvider = createMockLlm();

  it("should construct the correct TadpoleGenerateTextOptions for a non-conversational chronicler", async () => {
    const capturedOptions: TadpoleGenerateTextOptions[] = [];
    const mockLlmCall = async (id, options) => {
      capturedOptions.push(options);
      return mockLlmProvider.generateText(options);
    };

    // Create a non-conversational chronicler
    const chronicler = new Chronicler(nonConversationalConfig, /* ... */, mockLlmCall);

    await chronicler.handleEvent(testEvent);

    // Assertions
    expect(capturedOptions.length).toBe(1);
    const opts = capturedOptions[0];
    expect(opts.system).toBe("Rendered system prompt");
    expect(opts.messages.length).toBe(1);
    expect(opts.messages[0].role).toBe("user");
    expect(opts.messages[0].content).toContain("Rendered user prompt");
  });

  it("should construct correct options for a conversational chronicler, including history", async () => {
    const capturedOptions: TadpoleGenerateTextOptions[] = [];
    const mockLlmCall = async (id, options) => {
      capturedOptions.push(options);
      return mockLlmProvider.generateText(options);
    };

    // Create a conversational chronicler with a pre-populated history manager
    const chronicler = new Chronicler(conversationalConfig, /* ... */, mockLlmCall);
    await chronicler.getHistoryManager()?.addMessagePair("Old question", "Old answer");

    await chronicler.handleEvent(testEvent);

    // Assertions
    expect(capturedOptions.length).toBe(1);
    const opts = capturedOptions[0];
    expect(opts.system).toBeUndefined(); // System prompt should be in messages
    expect(opts.messages.length).toBe(4); // system + old_user + old_assistant + new_user
    expect(opts.messages[0].role).toBe("system");
    expect(opts.messages[1].content).toBe("Old question");
    expect(opts.messages[3].content).toContain("Rendered user prompt for new event");
  });

  it("should add the LLM response to history ONLY on successful call", async () => {
    const mockLlmCall = createMockLlm().generateText; // Use the real mock
    const chronicler = new Chronicler(conversationalConfig, /* ... */, (id, opts) => mockLlmCall(opts));

    const historyManager = chronicler.getHistoryManager();
    const addPairSpy = spyOn(historyManager, "addMessagePair");

    await chronicler.handleEvent(testEvent);

    // Assertions
    expect(addPairSpy).toHaveBeenCalledTimes(1);
    const callArgs = addPairSpy.mock.calls[0];
    expect(callArgs[0]).toContain("Rendered user prompt"); // User part
    expect(callArgs[1]).toContain("Mock response for:");  // Assistant part
  });
});
```

---

### **2. New Integration Tests**

These tests verify that the `ChroniclerManager` and multiple `Chronicler` instances work together correctly with the mock LLM.

#### **File Location:** `tests/integration/chronicler-llm-interactions.test.ts` (New File)

##### **Event Batching and LLM Call Verification**
```typescript
describe("ChroniclerManager LLM Call Integration", () => {
  it("should make a single LLM call for all debounced events", async () => {
    const manager = new ChroniclerManager(/* ... */);
    // Load a chronicler with debounce strategy
    await manager.loadChroniclersForPhase([debounceConfig], /* ... */);

    // Fire 5 events in quick succession
    for (let i = 0; i < 5; i++) {
      manager.handleEvent(createMockEvent("assistant.action"));
    }

    // Wait for debounce timer to fire
    await new Promise(resolve => setTimeout(resolve, debounceConfig.execution.milliseconds + 50));
    await manager.flush(); // Ensure everything is processed

    // Assert that mockLlm was called exactly ONCE
    expect(mockLlmCall.toHaveBeenCalledTimes(1)).toBe(true);

    // Assert that the template context for that one call contained all 5 events
    const capturedOptions = mockLlmCall.getCapturedOptions();
    const userMessage = capturedOptions[0].messages.find(m => m.role === 'user').content;
    // Assuming template includes event count for easy testing
    expect(userMessage).toContain("5 events");
  });

  it("should make multiple LLM calls for the 'count' strategy", async () => {
    const manager = new ChroniclerManager(/* ... */);
    // Load chronicler with count strategy, threshold: 3
    await manager.loadChroniclersForPhase([countConfig], /* ... */);

    // Fire 7 events
    for (let i = 0; i < 7; i++) {
      manager.handleEvent(createMockEvent("file.updated"));
    }

    // Assert it was called twice immediately
    expect(mockLlmCall.toHaveBeenCalledTimes(2)).toBe(true);

    // Now flush to process the remainder
    await manager.flush();

    // Assert it was called a third time for the remaining event
    expect(mockLlmCall.toHaveBeenCalledTimes(3)).toBe(true);

    // Verify batch sizes
    const calls = mockLlmCall.getCapturedOptions();
    // Assuming template includes event count
    expect(calls[0].messages.find(m => m.role === 'user').content).toContain("3 events");
    expect(calls[1].messages.find(m => m.role === 'user').content).toContain("3 events");
    expect(calls[2].messages.find(m => m.role === 'user').content).toContain("1 event");
  });
});
```

##### **End-to-End Conversational Flow**
```typescript
describe("End-to-End Conversational Flow", () => {
  it("should maintain conversation history across multiple triggers", async () => {
    const manager = new ChroniclerManager(/* ... */);
    await manager.loadChroniclersForPhase([conversationalConfig], /* ... */);
    const capturedOptions: TadpoleGenerateTextOptions[] = [];
    // ... setup mock to capture options

    // 1. First trigger
    await manager.handleEvent(firstEvent);
    await manager.flush();

    expect(capturedOptions.length).toBe(1);
    expect(capturedOptions[0].messages.length).toBe(2); // system + user

    // 2. Second trigger
    await manager.handleEvent(secondEvent);
    await manager.flush();

    expect(capturedOptions.length).toBe(2);
    // The second call should contain the history from the first call
    const secondCallMessages = capturedOptions[1].messages;
    expect(secondCallMessages.length).toBe(4); // system + first_user + first_assistant + second_user
    expect(secondCallMessages[1].role).toBe("user");
    expect(secondCallMessages[2].role).toBe("assistant");
    expect(secondCallMessages[2].content).toContain("Mock response"); // Contains response from first call
  });
});
```

##### **Resilience and Error Handling (Leveraging the Mock's New Capabilities)**
```typescript
describe("Chronicler Resilience and Error Handling", () => {
  it("should unload a non-conversational chronicler after 3 consecutive LLM errors", async () => {
    // Configure mock to always throw an error
    const failingMock = createMockLlm({ forceError: new Error("API unavailable") });
    const manager = new ChroniclerManager(/* ... */);
    // ... load a non-conversational chronicler with the failing mock

    expect(manager.getChroniclerCount()).toBe(1);

    // Trigger 3 times
    await manager.handleEvent(testEvent);
    await manager.handleEvent(testEvent);
    await manager.handleEvent(testEvent);

    // It should be unloaded
    expect(manager.getChroniclerCount()).toBe(0);
  });

  it("should NOT unload a conversational chronicler if continueOnError is true", async () => {
    const failingMock = createMockLlm({ forceError: new Error("API unavailable") });
    // Load a conversational chronicler with continueOnError: true
    // ...

    expect(manager.getChroniclerCount()).toBe(1);
    await manager.handleEvent(testEvent); // Trigger the error
    // It should still be loaded
    expect(manager.getChroniclerCount()).toBe(1);
  });
});
```

By implementing these tests, you will have exceptional confidence in your Chronicler system's logic, state management, and resilience—all without making a single real API call.