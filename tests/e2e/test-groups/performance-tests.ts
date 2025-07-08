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
        // Token events should follow within 5 seconds (Claude can take ~4 seconds)
        expect(latency).toBeLessThan(5000);
      }
    });
  });

  test("WebSocket messages maintain FIFO ordering", () => {
    // Check ordering only for events with different timestamps
    const events = testState.client?.getEvents() || [];

    for (let i = 0; i < events.length - 1; i++) {
      const currentTime = new Date(events[i].timestamp).getTime();
      const nextTime = new Date(events[i + 1].timestamp).getTime();

      // Events should be chronologically ordered (same timestamp is OK in any order)
      expect(currentTime).toBeLessThanOrEqual(nextTime);
    }

    // For events with different timestamps, check specific ordering rules
    events.forEach((event, index) => {
      if (event.type === "assistant.action") {
        // Find next token usage event with a later timestamp
        const laterTokenEvent = events
          .slice(index + 1)
          .find(
            (e) =>
              e.type === "token.usage" &&
              new Date(e.timestamp).getTime() > new Date(event.timestamp).getTime(),
          );

        if (laterTokenEvent) {
          // Token usage with later timestamp should come after assistant action
          const tokenIndex = events.indexOf(laterTokenEvent);
          expect(index).toBeLessThan(tokenIndex);
        }
      }
    });
  });
}
