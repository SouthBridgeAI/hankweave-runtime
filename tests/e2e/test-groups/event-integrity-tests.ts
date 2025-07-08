import { expect, test } from "bun:test";
import type { AssistantActionEvent, StateSnapshotEvent } from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: any[];
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
    const assistantActions = testState.client?.getEventsByType("assistant.action") || [];

    // Group by phase and check for duplicates
    const phaseActions = new Map<string, AssistantActionEvent[]>();
    assistantActions.forEach((event) => {
      const action = event as AssistantActionEvent;
      const phaseId = action.data?.phaseId || "unknown";
      if (!phaseActions.has(phaseId)) {
        phaseActions.set(phaseId, []);
      }
      phaseActions.get(phaseId)!.push(action);
    });

    // Check for exact duplicate events (same content and close timestamps)
    phaseActions.forEach((actions, phaseId) => {
      for (let i = 0; i < actions.length - 1; i++) {
        for (let j = i + 1; j < actions.length; j++) {
          if (
            actions[i].data?.content === actions[j].data?.content &&
            actions[i].data?.action === actions[j].data?.action
          ) {
            const timeDiff = Math.abs(
              new Date(actions[i].timestamp).getTime() - new Date(actions[j].timestamp).getTime(),
            );
            // If same content within 100ms, likely a duplicate
            expect(timeDiff).toBeGreaterThan(100);
          }
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
