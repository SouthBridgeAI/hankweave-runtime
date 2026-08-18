import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LlmProviderRegistry } from "../../server/llm/llm-provider-registry.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import {
  SentinelManager,
  type SentinelManagerOptions,
} from "../../server/sentinels/sentinel-manager.js";
import { CodonId, EventId } from "../../server/types/branded-types.js";
import type {
  HankweaveGenerateTextOptions,
  HankweaveGenerateTextResult,
} from "../../server/types/llm-call-types.js";
import type { SentinelConfig } from "../../server/types/sentinel-types.js";
import { WebSocketLogReader } from "../../server/websocket-log-reader.js";
import "../types/global-test-types.js";
import { createMockLlm } from "./mock-llm.js";
import { createMockLlmProviderRegistry } from "./mock-llm-provider-registry.js";

/**
 * A SentinelManager wired the way sentinel tests want it by default: no
 * persistence and a mock provider registry. Every constructor option can be
 * overridden; pass `providerRegistry` un-cast — this helper owns the single
 * cast from the mock's surface to the registry type the manager expects.
 */
export function createTestSentinelManager(
  overrides: Omit<SentinelManagerOptions, "providerRegistry"> & { providerRegistry?: unknown } = {},
): SentinelManager {
  const { providerRegistry, ...rest } = overrides;
  return new SentinelManager({
    enablePersistence: false,
    providerRegistry: (providerRegistry ?? createMockLlmProviderRegistry()) as LlmProviderRegistry,
    ...rest,
  });
}

type FileUpdatedEvent = Extract<ServerEvent, { type: "file.updated" }>;

let fileUpdatedEventCounter = 0;

/**
 * The file.updated ServerEvent sentinel tests trigger on, with the usual
 * placeholder data. Override the id or any data field as needed.
 */
export function fileUpdatedEvent(
  overrides: Partial<FileUpdatedEvent["data"]> & { id?: string } = {},
): ServerEvent {
  const { id, ...data } = overrides;
  return {
    id: EventId(id ?? `evt-file-updated-${++fileUpdatedEventCounter}`),
    timestamp: new Date().toISOString(),
    type: "file.updated",
    data: {
      path: "test.txt",
      filename: "test.txt",
      content: "content",
      action: "created",
      ...data,
    },
  };
}

/**
 * Enhanced mock implementation that properly tracks original events.
 * Uses a clean test hook approach to track events without global state pollution.
 * Uses a queue-based system to handle multiple immediate executions correctly.
 */
class MockLlmCall {
  public calls: Array<{ sentinelId: string; eventsOrMessages: ServerEvent[] }> = [];
  private mockLlmProvider = createMockLlm();
  // Changed to use a queue (array of arrays) for each sentinel
  private pendingEventsQueueBySentinel = new Map<string, ServerEvent[][]>();

  public fn = async (
    sentinelId: string,
    options: HankweaveGenerateTextOptions,
  ): Promise<HankweaveGenerateTextResult> => {
    // Get the queue for this sentinel
    const eventQueue = this.pendingEventsQueueBySentinel.get(sentinelId) || [];

    // Shift the first batch of events from the queue (FIFO)
    const events = eventQueue.shift() || [];

    // Update the queue if there are remaining batches
    if (eventQueue.length > 0) {
      this.pendingEventsQueueBySentinel.set(sentinelId, eventQueue);
    } else {
      // Remove the sentinel from the map if queue is empty
      this.pendingEventsQueueBySentinel.delete(sentinelId);
    }

    this.calls.push({ sentinelId, eventsOrMessages: events });

    // Use the typed mock to generate proper response
    return await this.mockLlmProvider.generateText(options);
  };

  public mockClear() {
    this.calls = [];
    this.pendingEventsQueueBySentinel.clear();
  }

  public toHaveBeenCalled(): boolean {
    return this.calls.length > 0;
  }

  public toHaveBeenCalledTimes(times: number): boolean {
    return this.calls.length === times;
  }

  public getCall(index: number): [string, ServerEvent[]] | undefined {
    const call = this.calls[index];
    return call ? [call.sentinelId, call.eventsOrMessages] : undefined;
  }

  // Track events for a specific sentinel (called when events are about to be processed)
  public trackEventsForSentinel(sentinelId: string, events: ServerEvent[]): void {
    // Get or create the queue for this sentinel
    let eventQueue = this.pendingEventsQueueBySentinel.get(sentinelId);
    if (!eventQueue) {
      eventQueue = [];
      this.pendingEventsQueueBySentinel.set(sentinelId, eventQueue);
    }

    // Push the new events to the queue (not replace)
    eventQueue.push(events);
  }

  // Get count of pending events for debugging
  public getPendingEventsCount(): number {
    let totalBatches = 0;
    for (const queue of this.pendingEventsQueueBySentinel.values()) {
      totalBatches += queue.length;
    }
    return totalBatches;
  }
}

/**
 * Mock LLM call function for testing.
 * Tracks all calls with sentinel ID and events.
 */
export const mockLlmCall = new MockLlmCall();

/**
 * Run a sentinel test against a websocket log file.
 *
 * @param logFilePath - Path to the JSONL websocket log file
 * @param sentinelConfigs - Array of sentinel configurations to test
 * @returns The mock LLM function for assertions
 */
export async function runSentinelTest(
  logFilePath: string,
  sentinelConfigs: SentinelConfig[],
): Promise<MockLlmCall> {
  // 1. Reset mocks before each run
  mockLlmCall.mockClear();

  // 2. Create temp directory for test execution
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-test-"));

  try {
    // 3. Create callback that tracks events for the MockLlmCall
    const onExecute = (id: string, events: ServerEvent[]) => {
      mockLlmCall.trackEventsForSentinel(id, events);
    };

    // 4. Create an instance of the SentinelManager without logger (silent mode)
    const manager = new SentinelManager({ enablePersistence: false });

    // 5. Tell the manager to load our test configurations and use our mock LLM function
    await manager.loadSentinelsForCodon(sentinelConfigs, CodonId("test-codon"), {
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
