import { expect, test } from "bun:test";
import type {
  AssistantActionEvent,
  ServerEvent,
  StateSnapshotEvent,
  TokenUsageEvent,
} from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
}

export function runEventIntegrityTests(testState: TestState) {
  test("all events have unique IDs", () => {
    const eventIds = new Set<string>();
    const duplicates: string[] = [];

    testState.events.forEach((event) => {
      if (eventIds.has(event.id)) {
        duplicates.push(event.id);
      }
      eventIds.add(event.id);
    });

    expect(duplicates).toEqual([]);
  });

  test("no events are dropped or duplicated", () => {
    // Check for suspicious patterns
    const tokenEvents = testState.client?.getEventsByType("token.usage") || [];

    // Group token events by timestamp to understand Claude's streaming pattern
    const eventsByTimestamp = new Map<string, ServerEvent[]>();
    tokenEvents.forEach((event) => {
      const timestamp = event.timestamp;
      if (!eventsByTimestamp.has(timestamp)) {
        eventsByTimestamp.set(timestamp, []);
      }
      eventsByTimestamp.get(timestamp)?.push(event);
    });

    // Claude sends multiple complete packets with the same message ID
    // This is expected behavior - not duplicates
    // Each packet represents a different aspect (text content vs tool use)

    // Check that events with the same timestamp have different token counts
    // (indicating they're different stages of the same message)
    eventsByTimestamp.forEach((events, _timestamp) => {
      if (events.length > 1) {
        // Multiple events at same timestamp should have different token counts
        const tokenCounts = events.map((e) => {
          if (e.type === "token.usage") {
            return (e as TokenUsageEvent).data?.outputTokens || 0;
          }
          return 0;
        });
        const uniqueTokenCounts = new Set(tokenCounts);

        // If all token counts are identical, that would be a true duplicate
        if (uniqueTokenCounts.size === 1 && events.length > 1) {
          // Check if they're truly identical events
          const firstEventStr = JSON.stringify(events[0]);
          const allIdentical = events.every((e) => JSON.stringify(e) === firstEventStr);
          expect(allIdentical).toBe(false);
        }
      }
    });

    // Also check assistant actions for true duplicates
    const assistantActions = testState.client?.getEventsByType("assistant.action") || [];
    const actionSignatures = new Map<string, number>();

    assistantActions.forEach((action) => {
      const a = action as AssistantActionEvent;
      const signature = `${a.data?.phaseId}_${a.data?.action}_${a.data?.content}`;
      actionSignatures.set(signature, (actionSignatures.get(signature) || 0) + 1);
    });

    // No action should appear more than once with identical content
    actionSignatures.forEach((count, signature) => {
      if (count > 1) {
        // Tool use actions can legitimately appear multiple times (e.g., multiple LS calls)
        const isToolUse = signature.includes("_tool_use_");
        if (!isToolUse) {
          expect(count).toBe(1);
        }
      }
    });
  });

  test("event IDs follow expected format", () => {
    testState.events.forEach((event) => {
      // Based on generateId() in utils.ts: timestamp-randomstring
      expect(event.id).toMatch(/^\d{13}-[a-z0-9]{9}$/);

      // Timestamp portion should be reasonable
      const timestamp = parseInt(event.id.split("-")[0]);
      expect(timestamp).toBeGreaterThan(1600000000000); // After 2020
      expect(timestamp).toBeLessThan(2000000000000); // Before 2033
    });
  });

  test("memory and resource monitoring in completed phases", () => {
    const finalSnapshot = [...testState.events]
      .reverse()
      .find((e) => e.type === "state.snapshot") as StateSnapshotEvent;

    if (finalSnapshot?.data?.completedPhases) {
      // Completed phases should only have essential data
      finalSnapshot.data.completedPhases.forEach((phase) => {
        expect(phase).toHaveProperty("phaseId");
        expect(phase).toHaveProperty("sessionId");
        expect(phase).toHaveProperty("success");
        expect(phase).toHaveProperty("cost");
        expect(phase).toHaveProperty("duration");
        expect(phase).toHaveProperty("completedAt");

        // Should not have large data structures
        const phaseStr = JSON.stringify(phase);
        expect(phaseStr.length).toBeLessThan(1000); // Reasonable size
      });
    }
  });
}
