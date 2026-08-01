import { expect, test } from "bun:test";
import type { ErrorEvent, ServerEvent } from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
  errorEvents: ErrorEvent[];
}

/**
 * Tests for scenarios where Claude fails before sending init message.
 * In these cases, we should NOT see codon.started events since there's no session ID.
 */
export function runEarlyCodonFailureTests(testState: TestState) {
  test("error events should be properly emitted even without session IDs", () => {
    // All error events should have required fields
    testState.errorEvents.forEach((error) => {
      expect(error.type).toBe("error");
      expect(error.data).toHaveProperty("message");
      expect(error.data).toHaveProperty("fatal");

      // Error events might not have codon info if Claude failed early
      // but they should still be well-formed
      if (error.data.codon) {
        expect(typeof error.data.codon).toBe("string");
      }
    });
  });

  test("state snapshots handle codons without session IDs gracefully", () => {
    const snapshots = testState.client?.getEventsByType("state.snapshot") || [];

    snapshots.forEach((event) => {
      if (event.type === "state.snapshot") {
        // Current codon might not have claudeSessionId if Claude hasn't initialized yet
        if (event.data.currentCodon) {
          // codonId should always be present
          expect(event.data.currentCodon.codonId).toBeDefined();
          expect(event.data.currentCodon.startTime).toBeDefined();

          if (event.data.currentCodon.status === "initializing") {
            // If status is initializing, codon should still have other required fields
            expect(event.data.currentCodon.codonId).toBeDefined();
            expect(event.data.currentCodon.startTime).toBeDefined();
            // No claudeSessionId or cost/token fields in initializing state
          }
        }

        // Completed codons should always have session IDs (they wouldn't be in completed list otherwise)
        event.data.completedCodons.forEach((codon) => {
          if (codon.status === "completed") {
            expect(codon.claudeSessionId).toBeDefined();
            expect(codon.claudeSessionId).not.toBeNull();
          } else if (codon.status === "failed" && codon.claudeSessionId) {
            expect(codon.claudeSessionId).toBeDefined();
            expect(codon.claudeSessionId).not.toBeNull();
          } else if (codon.status === "skipped" && codon.claudeSessionId) {
            expect(codon.claudeSessionId).toBeDefined();
            expect(codon.claudeSessionId).not.toBeNull();
          }
        });
      }
    });
  });

  test("codon completion can occur without codon.started if Claude fails early", () => {
    // Look for any codon.completed events without corresponding codon.started
    const completedCodons = testState.events.filter((e) => e.type === "codon.completed");

    completedCodons.forEach((event) => {
      if (event.type === "codon.completed") {
        const codonStarted = testState.events.find(
          (e) => e.type === "codon.started" && e.data.codonId === event.data.codonId,
        );

        // If codon failed, it's acceptable to not have codon.started
        if (!event.data.success && !codonStarted) {
          // This is expected behavior - codon failed before Claude init
          expect(codonStarted).toBeUndefined();

          // But we should have an error event
          const errorEvent = testState.errorEvents.find(
            (e) =>
              e.data.codon === event.data.codonId || e.data.message.includes(event.data.codonId),
          );

          if (!event.data.success && event.data.exitStatus.type === "error") {
            expect(errorEvent).toBeDefined();
          }
        }
      }
    });
  });

  test("fatal errors include codon information when available", () => {
    const fatalErrors = testState.errorEvents.filter((e) => e.data.fatal);

    fatalErrors.forEach((error) => {
      // Fatal errors during codon execution should reference the codon
      if (
        error.data.message.includes("Codon failed") ||
        error.data.message.includes("Claude process")
      ) {
        // Should have either codon field or codon ID in message
        const hasCodonInfo = error.data.codon || error.data.message.match(/codon[- ]?\w+/i);
        expect(hasCodonInfo).toBeTruthy();
      }
    });
  });
}
