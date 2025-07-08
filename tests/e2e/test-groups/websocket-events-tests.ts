import { expect, test } from "bun:test";
import type { ErrorEvent, FileUpdatedEvent, ServerEvent } from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
}

export function runWebSocketEventsTests(testState: TestState) {
  test("received expected event sequence", () => {
    const expectedSequence = [
      "server.ready",
      "state.snapshot",
      "phase.started",
      "phase.completed",
      "phase.started",
      "phase.completed",
      "phase.started",
      "phase.completed",
    ];

    const actualSequence = testState.events.map((e) => e.type);
    let sequenceIndex = 0;

    for (const eventType of actualSequence) {
      if (
        sequenceIndex < expectedSequence.length &&
        eventType === expectedSequence[sequenceIndex]
      ) {
        sequenceIndex++;
      }
    }

    expect(sequenceIndex).toBe(expectedSequence.length);
  });

  test("received assistant action events", () => {
    const assistantActions = testState.client?.getEventsByType("assistant.action") || [];
    expect(assistantActions.length).toBeGreaterThan(0);
  });

  test("received token usage events", () => {
    const tokenUsageEvents = testState.client?.getEventsByType("token.usage") || [];
    expect(tokenUsageEvents.length).toBeGreaterThan(0);
  });

  test("received file creation events", () => {
    const fileUpdateEvents = testState.client?.getEventsByType("file.updated") || [];
    const createdFiles = fileUpdateEvents.filter(
      (e) => (e as FileUpdatedEvent).data?.action === "created",
    );

    // We should receive at least 1 file creation event (files are only sent if they match watch patterns)
    expect(createdFiles.length).toBeGreaterThanOrEqual(1);
  });

  test("all events are in chronological order", () => {
    let lastTimestamp = 0;
    let chronologicalOrder = true;

    for (const event of testState.events) {
      const timestamp = new Date(event.timestamp).getTime();
      if (timestamp < lastTimestamp) {
        chronologicalOrder = false;
        break;
      }
      lastTimestamp = timestamp;
    }

    expect(chronologicalOrder).toBe(true);
  });

  test("no fatal errors occurred", () => {
    const errorEvents = testState.client?.getEventsByType("error") || [];
    const fatalErrors = errorEvents.filter((e) => (e as ErrorEvent).data?.fatal);
    expect(fatalErrors.length).toBe(0);
  });
}
