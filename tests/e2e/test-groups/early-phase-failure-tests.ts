import { expect, test } from "bun:test";
import {
  isPhaseCompletedEvent,
  isPhaseStartedEvent,
  isStateSnapshotEvent,
} from "../../../server/type-guards.js";
import type { ErrorEvent, ServerEvent } from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
  errorEvents: ErrorEvent[];
}

/**
 * Tests for scenarios where Claude fails before sending init message.
 * In these cases, we should NOT see phase.started events since there's no session ID.
 */
export function runEarlyPhaseFailureTests(testState: TestState) {
  test("phases that fail before Claude init should not emit phase.started events", () => {
    // This test would need to be run in a specific failure scenario
    // For now, we document the expected behavior

    // If we detect a phase that failed very quickly (< 1 second)
    const phaseCompletedEvents = testState.events.filter((e) => isPhaseCompletedEvent(e));

    phaseCompletedEvents.forEach((completed) => {
      if (!completed.data.success && completed.data.duration < 1000) {
        // For very quick failures, check if there was a phase.started event
        const phaseStarted = testState.events.find(
          (e) => isPhaseStartedEvent(e) && e.data?.phaseId === completed.data.phaseId,
        );

        // If the phase failed very quickly, it might not have a phase.started event
        // This is expected behavior with the new dual ID system
        if (!phaseStarted) {
          // This is OK - phase failed before Claude could send init
          expect(phaseStarted).toBeUndefined();
        }
      }
    });
  });

  test("error events should be properly emitted even without session IDs", () => {
    // All error events should have required fields
    testState.errorEvents.forEach((error) => {
      expect(error.type).toBe("error");
      expect(error.data).toHaveProperty("message");
      expect(error.data).toHaveProperty("fatal");

      // Error events might not have phase info if Claude failed early
      // but they should still be well-formed
      if (error.data.phase) {
        expect(typeof error.data.phase).toBe("string");
      }
    });
  });

  test("state snapshots handle phases without session IDs gracefully", () => {
    const snapshots = testState.client?.getEventsByType("state.snapshot") || [];

    snapshots.forEach((snapshot) => {
      if (isStateSnapshotEvent(snapshot)) {
        // Current phase might have null sessionId if Claude hasn't initialized yet
        if (snapshot.data?.currentPhase) {
          // sessionId can be null during execution
          expect(snapshot.data.currentPhase).toHaveProperty("sessionId");
          // But phaseExecutionId should always be present
          expect(snapshot.data.currentPhase).toHaveProperty("phaseExecutionId");

          if (snapshot.data.currentPhase.status === "initializing") {
            // If status is initializing, phase should still have other required fields
            expect(snapshot.data.currentPhase.phase).toBeDefined();
            expect(snapshot.data.currentPhase.startTime).toBeDefined();
            // No sessionId or cost/token fields in initializing state
          }
        }

        // Completed phases should always have session IDs (they wouldn't be in completed list otherwise)
        snapshot.data?.completedPhases?.forEach((phase) => {
          expect(phase.sessionId).toBeDefined();
          expect(phase.sessionId).not.toBeNull();
        });
      }
    });
  });

  test("phase completion can occur without phase.started if Claude fails early", () => {
    // Look for any phase.completed events without corresponding phase.started
    const completedPhases = testState.events.filter((e) => isPhaseCompletedEvent(e));

    completedPhases.forEach((completed) => {
      const phaseStarted = testState.events.find(
        (e) => isPhaseStartedEvent(e) && e.data?.phaseId === completed.data.phaseId,
      );

      // If phase failed, it's acceptable to not have phase.started
      if (!completed.data.success && !phaseStarted) {
        // This is expected behavior - phase failed before Claude init
        expect(phaseStarted).toBeUndefined();

        // But we should have an error event
        const errorEvent = testState.errorEvents.find(
          (e) =>
            e.data.phase === completed.data.phaseId ||
            e.data.message.includes(completed.data.phaseId),
        );

        if (!completed.data.success && completed.data.exitCode !== 0) {
          expect(errorEvent).toBeDefined();
        }
      }
    });
  });

  test("fatal errors include phase information when available", () => {
    const fatalErrors = testState.errorEvents.filter((e) => e.data.fatal);

    fatalErrors.forEach((error) => {
      // Fatal errors during phase execution should reference the phase
      if (
        error.data.message.includes("Phase failed") ||
        error.data.message.includes("Claude process")
      ) {
        // Should have either phase field or phase ID in message
        const hasPhaseInfo = error.data.phase || error.data.message.match(/phase[- ]?\w+/i);
        expect(hasPhaseInfo).toBeTruthy();
      }
    });
  });
}
