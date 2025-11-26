import { expect, test } from "bun:test";
import type { ErrorEvent } from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runErrorEventTests(testState: TestState) {
  test("error events contain proper context", () => {
    const errorEvents = testState.client?.getEventsByType("error") || [];

    errorEvents.forEach((event) => {
      const error = event as ErrorEvent;

      // Should have severity (from refactor plan)
      if (error.data?.severity) {
        expect(["fatal", "codon", "operation", "warning"]).toContain(error.data.severity);
      }

      // Fatal errors should have context
      if (error.data?.fatal) {
        expect(error.data?.context).toBeDefined();
      }

      // Should have reasonable message
      expect(error.data?.message?.length).toBeGreaterThan(0);
      expect(error.data?.message?.length).toBeLessThan(1000);
    });
  });
}
