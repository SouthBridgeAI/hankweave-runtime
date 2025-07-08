import { expect, test } from "bun:test";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runPerformanceTests(testState: TestState) {
  test("events are delivered with reasonable latency", () => {
    // Check that events are delivered promptly after actions
    const assistantActions = testState.client?.getEventsByType("assistant.action") || [];
    const tokenUsageEvents = testState.client?.getEventsByType("token.usage") || [];

    assistantActions.forEach((action) => {
      const actionTime = new Date(action.timestamp).getTime();

      // Find corresponding token usage event
      const tokenEvent = tokenUsageEvents.find((t) => {
        const tokenTime = new Date(t.timestamp).getTime();
        return tokenTime >= actionTime && tokenTime <= actionTime + 5000;
      });

      if (tokenEvent) {
        const latency = new Date(tokenEvent.timestamp).getTime() - actionTime;
        // Token events should follow within 2 seconds
        expect(latency).toBeLessThan(2000);
      }
    });
  });

  test("WebSocket messages maintain FIFO ordering", () => {
    // Messages with the same timestamp should maintain order
    const messageGroups = new Map<string, any[]>();

    testState.client?.getEvents().forEach((event) => {
      const timestamp = event.timestamp;
      if (!messageGroups.has(timestamp)) {
        messageGroups.set(timestamp, []);
      }
      messageGroups.get(timestamp)!.push(event);
    });

    // Within same timestamp, certain events should be ordered
    messageGroups.forEach((events, timestamp) => {
      if (events.length > 1) {
        // Token usage should come after assistant action
        const actionIndex = events.findIndex((e) => e.type === "assistant.action");
        const tokenIndex = events.findIndex((e) => e.type === "token.usage");

        if (actionIndex !== -1 && tokenIndex !== -1) {
          expect(actionIndex).toBeLessThan(tokenIndex);
        }
      }
    });
  });
}
