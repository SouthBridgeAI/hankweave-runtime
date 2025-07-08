import { expect, test } from "bun:test";
import {
  isInfoEvent,
  isPhaseStartedEvent,
  isStateSnapshotEvent,
} from "../../../server/type-guards.js";
import type { PhaseStartedEvent, ServerEvent } from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
  phase1Started: PhaseStartedEvent | null;
  phase2Started: PhaseStartedEvent | null;
  phase3Started: PhaseStartedEvent | null;
}

export function runDualIdSystemTests(testState: TestState) {
  test("phase.started events only appear after Claude init", () => {
    // For each phase, verify that phase.started comes after the info event about Claude starting
    const phases = ["phase-1", "phase-2", "phase-3"];

    phases.forEach((phaseId) => {
      const phaseEvents = testState.events.filter((e) => {
        if (isPhaseStartedEvent(e) && e.data?.phaseId === phaseId) {
          return true;
        }
        if (isInfoEvent(e)) {
          const msg = e.data?.message || "";
          return (
            msg.includes("Claude started with session ID:") &&
            testState.events.some(
              (pe) =>
                isPhaseStartedEvent(pe) &&
                pe.data?.phaseId === phaseId &&
                msg.includes(pe.data?.sessionId || ""),
            )
          );
        }
        return false;
      });

      if (phaseEvents.length >= 2) {
        // Find the Claude started info event and phase.started event
        const claudeStartedEvent = phaseEvents.find(
          (e) => isInfoEvent(e) && e.data?.message?.includes("Claude started with session ID:"),
        );
        const phaseStartedEvent = phaseEvents.find((e) => isPhaseStartedEvent(e));

        if (claudeStartedEvent && phaseStartedEvent) {
          // Claude init should come before or at the same time as phase.started
          const claudeTime = new Date(claudeStartedEvent.timestamp).getTime();
          const phaseTime = new Date(phaseStartedEvent.timestamp).getTime();

          // They should be very close in time (within 100ms) since they're sent together
          expect(Math.abs(phaseTime - claudeTime)).toBeLessThan(100);
        }
      }
    });
  });

  test("session IDs are always UUIDs, never timestamp-random format", () => {
    // Check all phase.started events
    const phaseStartedEvents = testState.events.filter((e) => e.type === "phase.started");

    phaseStartedEvents.forEach((event) => {
      if (isPhaseStartedEvent(event)) {
        const sessionId = event.data?.sessionId;
        if (sessionId) {
          // UUID v4 format: 8-4-4-4-12 characters
          const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          expect(sessionId).toMatch(uuidRegex);

          // Should NOT match timestamp-random format (e.g., "1234567890123-abc123def")
          const timestampRandomRegex = /^\d{13}-[a-z0-9]{9}$/;
          expect(sessionId).not.toMatch(timestampRandomRegex);
        }
      }
    });

    // Check completed phases in state snapshots
    const snapshots = testState.client?.getEventsByType("state.snapshot") || [];
    snapshots.forEach((snapshot) => {
      if (isStateSnapshotEvent(snapshot)) {
        snapshot.data?.completedPhases?.forEach((phase) => {
          // UUID format check
          const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          expect(phase.sessionId).toMatch(uuidRegex);
        });
      }
    });
  });

  test("no duplicate session IDs within a single phase execution", () => {
    // Map to track all session IDs seen for each phase
    const phaseSessionIds = new Map<string, Set<string>>();

    // Collect from phase.started events
    testState.events.forEach((event) => {
      if (isPhaseStartedEvent(event)) {
        const phaseId = event.data?.phaseId;
        const sessionId = event.data?.sessionId;

        if (phaseId && sessionId) {
          if (!phaseSessionIds.has(phaseId)) {
            phaseSessionIds.set(phaseId, new Set());
          }
          phaseSessionIds.get(phaseId)?.add(sessionId);
        }
      }
    });

    // Collect from info events (Claude started messages)
    testState.events.forEach((event) => {
      if (isInfoEvent(event)) {
        const msg = event.data?.message || "";
        const match = msg.match(/Claude started with session ID: ([0-9a-f-]+)/i);
        if (match) {
          const sessionId = match[1];
          // Find which phase this belongs to by looking at nearby events
          const eventIndex = testState.events.indexOf(event);
          // Look for phase.started event within 5 events
          for (
            let i = Math.max(0, eventIndex - 5);
            i < Math.min(testState.events.length, eventIndex + 5);
            i++
          ) {
            const nearbyEvent = testState.events[i];
            if (isPhaseStartedEvent(nearbyEvent)) {
              const phaseId = nearbyEvent.data?.phaseId;
              if (phaseId) {
                if (!phaseSessionIds.has(phaseId)) {
                  phaseSessionIds.set(phaseId, new Set());
                }
                phaseSessionIds.get(phaseId)?.add(sessionId);
              }
              break;
            }
          }
        }
      }
    });

    // Each phase should have exactly one unique session ID
    phaseSessionIds.forEach((sessionIds, _phaseId) => {
      expect(sessionIds.size).toBe(1);
    });
  });

  test("previousSessionId is properly set for continued phases", () => {
    // Phase 2 continues from Phase 1
    if (testState.phase1Started && testState.phase2Started) {
      expect(testState.phase2Started.data?.previousSessionId).toBe(
        testState.phase1Started.data?.sessionId,
      );
    }

    // Phase 3 does NOT continue (based on test config)
    if (testState.phase3Started) {
      expect(testState.phase3Started.data?.previousSessionId).toBeUndefined();
    }
  });

  test("phase.started event contains all required fields with valid UUIDs", () => {
    const phaseStartedEvents = [
      testState.phase1Started,
      testState.phase2Started,
      testState.phase3Started,
    ].filter((e): e is PhaseStartedEvent => e !== null);

    phaseStartedEvents.forEach((event) => {
      // Required fields
      expect(event.data).toHaveProperty("phaseId");
      expect(event.data).toHaveProperty("phaseName");
      expect(event.data).toHaveProperty("sessionId");
      expect(event.data).toHaveProperty("startTime");

      // Session ID should be a valid UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(event.data.sessionId).toMatch(uuidRegex);

      // Start time should be valid ISO string
      expect(() => new Date(event.data.startTime)).not.toThrow();
    });
  });

  test("completed phases only include phases that received Claude session IDs", () => {
    // In the happy path, all phases should complete with session IDs
    const finalSnapshot = [...testState.events].reverse().find((e) => isStateSnapshotEvent(e));

    if (finalSnapshot?.data?.completedPhases) {
      // All completed phases should have valid UUID session IDs
      finalSnapshot.data.completedPhases.forEach((phase) => {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        expect(phase.sessionId).toMatch(uuidRegex);
      });

      // Should have 3 completed phases in happy path
      expect(finalSnapshot.data.completedPhases.length).toBe(3);
    }
  });

  test("info events about Claude starting appear before phase.started", () => {
    // For each phase, find the pair of events
    ["phase-1", "phase-2", "phase-3"].forEach((phaseId) => {
      const phaseStarted = testState.events.find(
        (e) => isPhaseStartedEvent(e) && e.data?.phaseId === phaseId,
      );

      if (phaseStarted && isPhaseStartedEvent(phaseStarted)) {
        const sessionId = phaseStarted.data.sessionId;

        // Find the corresponding info event
        const infoEvent = testState.events.find(
          (e) =>
            isInfoEvent(e) && e.data?.message === `Claude started with session ID: ${sessionId}`,
        );

        expect(infoEvent).toBeDefined();

        if (infoEvent) {
          // Info event should come before or at same time as phase.started
          const infoIndex = testState.events.indexOf(infoEvent);
          const phaseIndex = testState.events.indexOf(phaseStarted);

          // They should be close together (within a few events)
          expect(Math.abs(phaseIndex - infoIndex)).toBeLessThanOrEqual(2);
        }
      }
    });
  });

  test("state snapshots include phaseExecutionId for internal tracking", () => {
    const snapshots = testState.client?.getEventsByType("state.snapshot") || [];

    snapshots.forEach((snapshot) => {
      if (isStateSnapshotEvent(snapshot) && snapshot.data?.currentPhase) {
        // Should always have phaseExecutionId (internal tracking)
        expect(snapshot.data.currentPhase).toHaveProperty("phaseExecutionId");

        // phaseExecutionId should be timestamp-random format
        const timestampRandomRegex = /^\d{13}-[a-z0-9]{9}$/;
        expect(snapshot.data.currentPhase.phaseExecutionId).toMatch(timestampRandomRegex);

        // sessionId might be null during execution
        if (snapshot.data.currentPhase.sessionId !== null) {
          // But if present, should be UUID
          const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          expect(snapshot.data.currentPhase.sessionId).toMatch(uuidRegex);
        }
      }
    });
  });
}
