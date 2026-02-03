import { expect, test } from "bun:test";
import type { InfoEvent } from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runInfoEventsTests(testState: TestState) {
  const infoEvents = testState.client?.getEventsByType("info") || [];

  test("info event for codon continuation", () => {
    const hasContinuationInfo = infoEvents.some(
      (e) => (e as InfoEvent).data?.message?.includes("Continuing from previous session") || false,
    );
    expect(hasContinuationInfo).toBe(true);
  });

  test("info events for all 3 codon session starts", () => {
    const sessionStartEvents = infoEvents.filter(
      (e) => (e as InfoEvent).data?.message?.includes("Started codon") || false,
    );
    expect(sessionStartEvents.length).toBe(3);
  });

  test("info event for all codons completed", () => {
    const hasCompletionInfo = infoEvents.some(
      (e) => (e as InfoEvent).data?.message?.includes("All codons completed") || false,
    );
    expect(hasCompletionInfo).toBe(true);
  });
}
