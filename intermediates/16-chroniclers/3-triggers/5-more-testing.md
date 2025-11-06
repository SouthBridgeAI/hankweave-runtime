### **Plan: Standalone Chronicler Trigger Integration Test Suite**

#### **1. Goal & Philosophy**

The primary goal of this test suite is to verify the end-to-end logic of the Chronicler trigger system in a controlled, offline environment. We will simulate the `ChroniclerManager`'s core responsibility: listening to an event stream and determining when to fire Chroniclers.

**Key Principles:**

*   **Test Against Reality:** Use real `websocket.log` files as the source of truth for the event stream. This ensures our tests cover the actual structure and timing of events produced by the server.
*   **Isolate the System Under Test:** We will test the `ChroniclerManager`, `Chronicler`, `TriggerEngine`, and `ConditionEvaluator` together, but we will **not** involve the `TadpoleServer` or live LLM calls.
*   **Mock at the Boundary:** The only thing we will mock is the final LLM call. Instead of calling the AI SDK, we will substitute a simple function that records the fact that it was called, when it was called, and what events it was given.
*   **Declarative Tests:** Each test case will be defined by a Chronicler configuration file and an expected outcome (e.g., "the narrator should fire 3 times").

#### **2. Test Harness & Infrastructure**

First, we need to build a reusable test harness that can run any Chronicler configuration against any event log.

**Create a new file: `tests/utils/chronicler-test-harness.ts`**

```typescript
import { vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ChroniclerManager } from "../../server/chroniclers/chronicler-manager"; // This file doesn't exist yet, we will create it
import { WebSocketLogReader } from "../../server/websocket-log-reader";
import type { ChroniclerConfig } from "../../server/types/chronicler-types";
import type { ServerEvent } from "../../server/schemas/event-schemas";

// This is our mock LLM call function.
// We use vi.fn() from Bun's test runner to track its calls.
export const mockLlmCall = vi.fn(
  (chroniclerId: string, batchedEvents: ServerEvent[]) => {
    console.log(
      `[Mock LLM Call] Chronicler '${chroniclerId}' fired with ${batchedEvents.length} events.`,
    );
    // In a real test, we might return a mock result
    return Promise.resolve({ summary: "Mock LLM Result" });
  },
);

// The main test runner function
export async function runChroniclerTest(
  logFilePath: string,
  chroniclerConfigs: ChroniclerConfig[],
) {
  // 1. Reset mocks before each run
  mockLlmCall.mockClear();

  // 2. Create an instance of the ChroniclerManager
  const manager = new ChroniclerManager();

  // 3. Tell the manager to load our test configurations and use our mock LLM function
  await manager.loadChroniclers(chroniclerConfigs, mockLlmCall);

  // 4. Read the event stream from the provided log file
  const logReader = new WebSocketLogReader(logFilePath);
  const events = await logReader.readLog();

  // 5. Feed the events into the manager one by one to simulate a real-time stream
  for (const logEntry of events) {
    // We only care about outgoing server events
    if (logEntry.direction === "out") {
      const event = logEntry.message as ServerEvent;
      await manager.handleEvent(event);
    }
  }

  // 6. After all events are processed, tell the manager to flush any pending triggers
  //    (e.g., for debounce or timeWindow strategies that might have pending events)
  await manager.flush();

  // 7. Return the mock function so tests can make assertions on it
  return mockLlmCall;
}
```

#### **3. Building the `ChroniclerManager` and `Chronicler` Stubs**

To make the test harness compile, we first need to create placeholder versions of `ChroniclerManager` and `Chronicler`.

**Create `server/chroniclers/chronicler.ts` (Stub)**

```typescript
import type { ChroniclerConfig } from "../types/chronicler-types";
import type { ServerEvent } from "../schemas/event-schemas";

// Placeholder for the real Chronicler class
export class Chronicler {
  constructor(
    private config: ChroniclerConfig,
    private llmCall: (id: string, events: ServerEvent[]) => Promise<any>,
  ) {}

  public async handleEvent(event: ServerEvent): Promise<void> {
    // TODO: Implement trigger and execution logic here
    console.log(`Chronicler ${this.config.id} received event ${event.type}`);
  }

  public async flush(): Promise<void> {
    // TODO: Implement flushing logic for timed strategies
  }
}
```

**Create `server/chroniclers/chronicler-manager.ts` (Stub)**

```typescript
import { Chronicler } from "./chronicler";
import type { ChroniclerConfig } from "../types/chronicler-types";
import type { ServerEvent } from "../schemas/event-schemas";

// Placeholder for the real Manager class
export class ChroniclerManager {
  private chroniclers: Chronicler[] = [];

  public async loadChroniclers(
    configs: ChroniclerConfig[],
    llmCall: (id: string, events: ServerEvent[]) => Promise<any>,
  ) {
    this.chroniclers = configs.map(
      (config) => new Chronicler(config, llmCall),
    );
  }

  public async handleEvent(event: ServerEvent): Promise<void> {
    for (const chronicler of this.chroniclers) {
      await chronicler.handleEvent(event);
    }
  }

  public async flush(): Promise<void> {
    for (const chronicler of this.chroniclers) {
      await chronicler.flush();
    }
  }
}
```

With these stubs and the test harness, we can now write our tests.

#### **4. The Integration Test Suite**

**Create a new test file: `tests/integration/chronicler-triggers.test.ts`**

```typescript
import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { runChroniclerTest, mockLlmCall } from "../utils/chronicler-test-harness";
import { chroniclerConfigSchema } from "../../server/config-validation/chronicler.schema";
import * as fs from "node:fs";

// --- Test Setup ---
const TEST_LOG_PATH = path.resolve(process.cwd(), "tests/test-data/websocket-logs/happy-path-log.jsonl");
const CHRONICLER_CONFIGS_DIR = path.resolve(process.cwd(), "tests/config/chronicler-triggers");

// Helper to load a Chronicler config from our test files
function loadChroniclerConfig(fileName: string) {
    const filePath = path.join(CHRONICLER_CONFIGS_DIR, fileName);
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(fileContent);
    // Validate it before using to catch schema errors
    return chroniclerConfigSchema.parse(config);
}


// --- The Tests ---

describe("Chronicler Trigger Integration Tests", () => {

  it("should correctly trigger the narrator chronicler based on debounce", async () => {
    const narratorConfig = loadChroniclerConfig("narrator.json");

    await runChroniclerTest(TEST_LOG_PATH, [narratorConfig]);

    // The happy-path log is long and has many bursts of activity.
    // We expect it to fire multiple times, but not on every single event.
    expect(mockLlmCall).toHaveBeenCalled();
    // A good test would be to check if the number of calls is much less than the total number of assistant.action/tool.result events
    expect(mockLlmCall.mock.calls.length).toBeLessThan(20);
    expect(mockLlmCall.mock.calls.length).toBeGreaterThan(5);

    // Check the payload of the first call to see if it batched correctly
    const firstCallArgs = mockLlmCall.mock.calls[0];
    expect(firstCallArgs[0]).toBe("narrator"); // Chronicler ID
    expect(firstCallArgs[1].length).toBeGreaterThan(1); // Should have batched more than one event
  });

  it("should trigger the file activity monitor on a count of 5", async () => {
    const fileMonitorConfig = loadChroniclerConfig("file-activity-monitor.json");

    await runChroniclerTest(TEST_LOG_PATH, [fileMonitorConfig]);

    expect(mockLlmCall).toHaveBeenCalled();

    // The happy path log has many file.updated events. Let's check the batching.
    const totalFileUpdateEvents = 12; // Manually counted from the log file for this example
    const expectedCalls = Math.floor(totalFileUpdateEvents / 5); // threshold is 5
    expect(mockLlmCall.mock.calls.length).toBe(expectedCalls);

    // Verify the first batch contains exactly 5 events
    const firstCallArgs = mockLlmCall.mock.calls[0];
    expect(firstCallArgs[1].length).toBe(5);
    // Verify all events in the batch are 'file.updated'
    expect(firstCallArgs[1].every(e => e.type === 'file.updated')).toBe(true);
  });

  it("should trigger the error detector on a sequence of 3 consecutive tool errors", async () => {
    // Since our happy-path log has no errors, we need a specific log for this.
    const errorLogPath = path.resolve(process.cwd(), "tests/test-data/websocket-logs/consecutive-errors-log.jsonl");
    const errorDetectorConfig = loadChroniclerConfig("error-detector.json");

    await runChroniclerTest(errorLogPath, [errorDetectorConfig]);

    // This log is specifically crafted to have one sequence of 3 errors.
    expect(mockLlmCall).toHaveBeenCalledTimes(1);

    // Verify the payload of the call
    const callArgs = mockLlmCall.mock.calls[0];
    expect(callArgs[0]).toBe("error-detector");
    expect(callArgs[1].length).toBe(3);
    expect(callArgs[1].every(e => e.type === 'tool.result' && e.data.isError)).toBe(true);
  });

  it("should trigger the cost tracker only for high-cost events", async () => {
    const costTrackerConfig = loadChroniclerConfig("cost-tracker.json");

    await runChroniclerTest(TEST_LOG_PATH, [costTrackerConfig]);

    // The happy-path log has many token.usage events, but only a few with high cost.
    // The threshold in the config is $0.50
    expect(mockLlmCall).toHaveBeenCalledTimes(2); // Manually counted from log

    // Verify the events that triggered it met the condition
    const firstCallArgs = mockLlmCall.mock.calls[0];
    expect(firstCallArgs[1][0].data.totalCost).toBeGreaterThan(0.5);
  });

});
```

#### **5. New Test Triggers to Write**

Your existing Chronicler configs are excellent and cover most cases. Here are a few more to add to make the test suite exhaustive:

1.  **`non-consecutive-sequence.json`**
    *   **Purpose:** To test a sequence trigger with `options.consecutive: false`.
    *   **Trigger:** Match a `phase.started` event followed by a `phase.completed` event for the same `phaseId`, even if other events happened in between. This is a great test for rollback summaries.

2.  **`complex-condition.json`**
    *   **Purpose:** To test multiple `AND` conditions with different operators.
    *   **Trigger:** Fire on `assistant.action` only if `action` is `tool_use`, `toolName` is `Bash`, AND `toolInput.command` `contains` the word `python`.

3.  **`time-window-summary.json`**
    *   **Purpose:** To test the `timeWindow` execution strategy.
    *   **Execution:** `"strategy": "timeWindow", "milliseconds": 10000` (10 seconds).
    *   **Test:** Run against a log file and assert that the LLM is called approximately `(log_duration_in_ms / 10000)` times.

By building these stubs, the test harness, and the integration tests first, you can now incrementally implement the real logic inside `chronicler.ts` and `chronicler-manager.ts` and continuously run your test suite to verify that your implementation is correct. This is a very solid, test-driven approach.