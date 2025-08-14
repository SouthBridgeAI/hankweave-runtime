import * as fs from "node:fs";
import { ChroniclerManager } from "../../server/chroniclers/chronicler-manager.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import type { ChroniclerConfig } from "../../server/types/chronicler-types.js";
import { WebSocketLogReader } from "../../server/websocket-log-reader.js";

/**
 * Simple mock implementation for LLM calls.
 */
class MockLlmCall {
  public calls: Array<{ chroniclerId: string; events: ServerEvent[] }> = [];

  public fn = (chroniclerId: string, batchedEvents: ServerEvent[]) => {
    console.log(
      `[Mock LLM Call] Chronicler '${chroniclerId}' fired with ${batchedEvents.length} events.`,
    );
    this.calls.push({ chroniclerId, events: batchedEvents });
    return Promise.resolve({ summary: "Mock LLM Result" });
  };

  public mockClear() {
    this.calls = [];
  }

  public toHaveBeenCalled(): boolean {
    return this.calls.length > 0;
  }

  public toHaveBeenCalledTimes(times: number): boolean {
    return this.calls.length === times;
  }

  public getCall(index: number): [string, ServerEvent[]] | undefined {
    const call = this.calls[index];
    return call ? [call.chroniclerId, call.events] : undefined;
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

  // 2. Create an instance of the ChroniclerManager
  const manager = new ChroniclerManager();

  // 3. Tell the manager to load our test configurations and use our mock LLM function
  await manager.loadChroniclers(chroniclerConfigs, mockLlmCall.fn);

  // 4. Read the event stream from the provided log file
  const logReader = new WebSocketLogReader(logFilePath);
  const entries = await logReader.readLog();

  // 5. Feed the events into the manager one by one to simulate a real-time stream
  for (const logEntry of entries) {
    // We only care about outgoing server events
    if (logEntry.direction === "out") {
      const event = logEntry.message as ServerEvent;
      // Only process if it's actually a server event (has type, id, timestamp, data)
      if (event && typeof event === "object" && "type" in event && "id" in event) {
        await manager.handleEvent(event);
      }
    }
  }

  // 6. After all events are processed, tell the manager to flush any pending triggers
  //    (e.g., for debounce or timeWindow strategies that might have pending events)
  await manager.flush();

  // 7. Return the mock function so tests can make assertions on it
  return mockLlmCall;
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
