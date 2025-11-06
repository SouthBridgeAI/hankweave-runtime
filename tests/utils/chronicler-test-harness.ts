import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChroniclerManager } from "../../server/chroniclers/chronicler-manager.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { PhaseId } from "../../server/types/branded-types.js";
import type { ChroniclerConfig } from "../../server/types/chronicler-types.js";
import type {
  TadpoleGenerateTextOptions,
  TadpoleGenerateTextResult,
} from "../../server/types/llm-call-types.js";
import { WebSocketLogReader } from "../../server/websocket-log-reader.js";
import "../types/global-test-types.js";
import { createMockLlm } from "./mock-llm.js";

/**
 * Enhanced mock implementation that properly tracks original events.
 * Uses a clean test hook approach to track events without global state pollution.
 * Uses a queue-based system to handle multiple immediate executions correctly.
 */
class MockLlmCall {
  public calls: Array<{ chroniclerId: string; eventsOrMessages: ServerEvent[] }> = [];
  private mockLlmProvider = createMockLlm();
  // Changed to use a queue (array of arrays) for each chronicler
  private pendingEventsQueueByChronicler = new Map<string, ServerEvent[][]>();

  public fn = async (
    chroniclerId: string,
    options: TadpoleGenerateTextOptions,
  ): Promise<TadpoleGenerateTextResult> => {
    // Get the queue for this chronicler
    const eventQueue = this.pendingEventsQueueByChronicler.get(chroniclerId) || [];

    // Shift the first batch of events from the queue (FIFO)
    const events = eventQueue.shift() || [];

    // Update the queue if there are remaining batches
    if (eventQueue.length > 0) {
      this.pendingEventsQueueByChronicler.set(chroniclerId, eventQueue);
    } else {
      // Remove the chronicler from the map if queue is empty
      this.pendingEventsQueueByChronicler.delete(chroniclerId);
    }

    this.calls.push({ chroniclerId, eventsOrMessages: events });

    // Use the typed mock to generate proper response
    return await this.mockLlmProvider.generateText(options);
  };

  public mockClear() {
    this.calls = [];
    this.pendingEventsQueueByChronicler.clear();
  }

  public toHaveBeenCalled(): boolean {
    return this.calls.length > 0;
  }

  public toHaveBeenCalledTimes(times: number): boolean {
    return this.calls.length === times;
  }

  public getCall(index: number): [string, ServerEvent[]] | undefined {
    const call = this.calls[index];
    return call ? [call.chroniclerId, call.eventsOrMessages] : undefined;
  }

  // Track events for a specific chronicler (called when events are about to be processed)
  public trackEventsForChronicler(chroniclerId: string, events: ServerEvent[]): void {
    // Get or create the queue for this chronicler
    let eventQueue = this.pendingEventsQueueByChronicler.get(chroniclerId);
    if (!eventQueue) {
      eventQueue = [];
      this.pendingEventsQueueByChronicler.set(chroniclerId, eventQueue);
    }

    // Push the new events to the queue (not replace)
    eventQueue.push(events);
  }

  // Get count of pending events for debugging
  public getPendingEventsCount(): number {
    let totalBatches = 0;
    for (const queue of this.pendingEventsQueueByChronicler.values()) {
      totalBatches += queue.length;
    }
    return totalBatches;
  }
}

/**
 * Mock LLM call function for testing.
 * Tracks all calls with chronicler ID and events.
 */
export const mockLlmCall = new MockLlmCall();

/**
 * Run a chronicler test against a websocket log file.
 *
 * @param logFilePath - Path to the JSONL websocket log file
 * @param chroniclerConfigs - Array of chronicler configurations to test
 * @returns The mock LLM function for assertions
 */
export async function runChroniclerTest(
  logFilePath: string,
  chroniclerConfigs: ChroniclerConfig[],
): Promise<MockLlmCall> {
  // 1. Reset mocks before each run
  mockLlmCall.mockClear();

  // 2. Create temp directory for test execution
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicler-test-"));

  try {
    // 3. Create callback that tracks events for the MockLlmCall
    const onExecute = (id: string, events: ServerEvent[]) => {
      mockLlmCall.trackEventsForChronicler(id, events);
    };

    // 4. Create an instance of the ChroniclerManager without logger (silent mode)
    const manager = new ChroniclerManager();

    // 5. Tell the manager to load our test configurations and use our mock LLM function
    await manager.loadChroniclersForPhase(chroniclerConfigs, PhaseId("test-phase"), {
      llmCallOverride: mockLlmCall.fn,
      onExecute,
      executionPath: tempDir, // Pass temp directory as execution path
    });

    // 6. Read the event stream from the provided log file
    const logReader = new WebSocketLogReader(logFilePath);
    const entries = await logReader.readLog();

    // 7. Feed the events into the manager one by one to simulate a real-time stream
    for (const logEntry of entries) {
      // We only care about outgoing server events
      if (logEntry.direction === "out") {
        const event = logEntry.message as ServerEvent;
        // Only process if it's actually a server event (has type, id, timestamp, data)
        if (event && typeof event === "object" && "type" in event && "id" in event) {
          // Fire and forget - no await
          manager.handleEvent(event);
        }
      }
    }

    // 8. Wait for all pending operations to complete
    await manager.completeAllWork();

    // 9. Return the mock function so tests can make assertions on it
    return mockLlmCall;
  } finally {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Helper to count events of a specific type in a log file.
 * Useful for setting up test expectations.
 */
export async function countEventType(logFilePath: string, eventType: string): Promise<number> {
  const logReader = new WebSocketLogReader(logFilePath);
  const entries = await logReader.readLog();

  let count = 0;
  for (const entry of entries) {
    if (entry.direction === "out") {
      const event = entry.message as ServerEvent;
      if (event && typeof event === "object" && "type" in event && event.type === eventType) {
        count++;
      }
    }
  }

  return count;
}

/**
 * Helper to count events matching specific conditions.
 */
export async function countEventsWithCondition(
  logFilePath: string,
  eventType: string,
  condition: (event: ServerEvent) => boolean,
): Promise<number> {
  const logReader = new WebSocketLogReader(logFilePath);
  const entries = await logReader.readLog();

  let count = 0;
  for (const entry of entries) {
    if (entry.direction === "out") {
      const event = entry.message as ServerEvent;
      if (
        event &&
        typeof event === "object" &&
        "type" in event &&
        event.type === eventType &&
        condition(event)
      ) {
        count++;
      }
    }
  }

  return count;
}

/**
 * Helper to get the duration of a log file in milliseconds.
 * Useful for time-window tests.
 */
export async function getLogDuration(logFilePath: string): Promise<number> {
  const logReader = new WebSocketLogReader(logFilePath);
  const entries = await logReader.readLog();

  if (entries.length === 0) {
    return 0;
  }

  const firstTime = new Date(entries[0].loggedAt).getTime();
  const lastTime = new Date(entries[entries.length - 1].loggedAt).getTime();

  return lastTime - firstTime;
}

/**
 * Helper to create a simple test log file with specific events.
 * Useful for creating targeted test scenarios.
 */
export function createTestLog(
  outputPath: string,
  events: Array<{ type: string; data?: Record<string, unknown>; delayMs?: number }>,
): void {
  const entries: Array<{
    direction: "in" | "out";
    loggedAt: string;
    message: ServerEvent;
    metadata?: { size: number };
  }> = [];

  let currentTime = Date.now();

  for (const eventSpec of events) {
    if (eventSpec.delayMs) {
      currentTime += eventSpec.delayMs;
    }

    const event: ServerEvent = {
      type: eventSpec.type as ServerEvent["type"],
      id: `test-${currentTime}`,
      timestamp: new Date(currentTime).toISOString(),
      data: eventSpec.data || {},
    } as ServerEvent;

    entries.push({
      direction: "out",
      loggedAt: new Date(currentTime).toISOString(),
      message: event,
      metadata: {
        size: JSON.stringify(event).length,
      },
    });
  }

  const lines = entries.map((entry) => JSON.stringify(entry));
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`);
}
