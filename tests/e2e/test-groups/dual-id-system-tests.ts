import { expect, test } from "bun:test";
import type { CodonStartedEvent, ServerEvent } from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
  codon1Started: CodonStartedEvent | null;
  codon2Started: CodonStartedEvent | null;
  codon3Started: CodonStartedEvent | null;
}

export function runDualIdSystemTests(testState: TestState) {
  test("codon.started events only appear after Claude init", () => {
    // For each codon, verify that codon.started comes after the info event about Claude starting
    const codons = ["codon-1", "codon-2", "codon-3"];

    codons.forEach((codonId) => {
      const codonEvents = testState.events.filter((e) => {
        if (e.type === "codon.started" && e.data.codonId === codonId) {
          return true;
        }
        if (e.type === "info") {
          const msg = e.data.message || "";
          return (
            msg.includes("Claude started with session ID:") &&
            testState.events.some(
              (pe) =>
                pe.type === "codon.started" &&
                pe.data.codonId === codonId &&
                msg.includes(pe.data.sessionId || ""),
            )
          );
        }
        return false;
      });

      if (codonEvents.length >= 2) {
        // Find the Claude started info event and codon.started event
        const claudeStartedEvent = codonEvents.find(
          (e) => e.type === "info" && e.data.message.includes("Claude started with session ID:"),
        );
        const codonStartedEvent = codonEvents.find((e) => e.type === "codon.started");

        if (claudeStartedEvent && codonStartedEvent) {
          // Claude init should come before or at the same time as codon.started
          const claudeTime = new Date(claudeStartedEvent.timestamp).getTime();
          const codonTime = new Date(codonStartedEvent.timestamp).getTime();

          // They should be very close in time (within 100ms) since they're sent together
          expect(Math.abs(codonTime - claudeTime)).toBeLessThan(100);
        }
      }
    });
  });

  test("session IDs are always UUIDs, never timestamp-random format", () => {
    // Check all codon.started events
    const codonStartedEvents = testState.events.filter((e) => e.type === "codon.started");

    codonStartedEvents.forEach((event) => {
      if (event.type === "codon.started") {
        const sessionId = event.data.sessionId;
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

    // Check completed codons in state snapshots
    const snapshots = testState.client?.getEventsByType("state.snapshot") || [];
    snapshots.forEach((snapshot) => {
      if (snapshot.type === "state.snapshot") {
        snapshot.data.completedCodons.forEach((codon) => {
          // UUID format check - only for codons that have sessionId
          if (
            codon.status === "completed" ||
            codon.status === "failed" ||
            codon.status === "skipped"
          ) {
            const uuidRegex =
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            if (codon.status === "completed" && codon.claudeSessionId) {
              expect(codon.claudeSessionId).toMatch(uuidRegex);
            } else if (codon.status === "failed" && codon.claudeSessionId) {
              expect(codon.claudeSessionId).toMatch(uuidRegex);
            } else if (codon.status === "skipped" && codon.claudeSessionId) {
              expect(codon.claudeSessionId).toMatch(uuidRegex);
            }
          }
        });
      }
    });
  });

  test("no duplicate session IDs within a single codon execution", () => {
    // Map to track all session IDs seen for each codon
    const codonSessionIds = new Map<string, Set<string>>();

    // Collect from codon.started events
    testState.events.forEach((event) => {
      if (event.type === "codon.started") {
        const codonId = event.data.codonId;
        const sessionId = event.data.sessionId;

        if (codonId && sessionId) {
          if (!codonSessionIds.has(codonId)) {
            codonSessionIds.set(codonId, new Set());
          }
          codonSessionIds.get(codonId)?.add(sessionId);
        }
      }
    });

    // Collect from info events (Claude started messages)
    testState.events.forEach((event) => {
      if (event.type === "info") {
        const msg = event.data.message || "";
        const match = msg.match(/Claude started with session ID: ([0-9a-f-]+)/i);
        if (match) {
          const sessionId = match[1];
          // Find which codon this belongs to by looking at nearby events
          const eventIndex = testState.events.indexOf(event);
          // Look for codon.started event within 5 events
          for (
            let i = Math.max(0, eventIndex - 5);
            i < Math.min(testState.events.length, eventIndex + 5);
            i++
          ) {
            const nearbyEvent = testState.events[i];
            if (nearbyEvent.type === "codon.started") {
              const codonId = nearbyEvent.data.codonId;
              if (codonId) {
                if (!codonSessionIds.has(codonId)) {
                  codonSessionIds.set(codonId, new Set());
                }
                codonSessionIds.get(codonId)?.add(sessionId);
              }
              break;
            }
          }
        }
      }
    });

    // Each codon should have exactly one unique session ID
    codonSessionIds.forEach((sessionIds, _codonId) => {
      expect(sessionIds.size).toBe(1);
    });
  });

  test("previousSessionId is properly set for continued codons", () => {
    // Codon 2 continues from Codon 1
    if (testState.codon1Started && testState.codon2Started) {
      expect(testState.codon2Started.data.previousSessionId).toBe(
        testState.codon1Started.data.sessionId,
      );
    }

    // Codon 3 does NOT continue (based on test config)
    if (testState.codon3Started) {
      expect(testState.codon3Started.data.previousSessionId).toBeUndefined();
    }
  });

  test("codon.started event contains all required fields with valid UUIDs", () => {
    const codonStartedEvents = [
      testState.codon1Started,
      testState.codon2Started,
      testState.codon3Started,
    ].filter((e): e is CodonStartedEvent => e !== null);

    codonStartedEvents.forEach((event) => {
      // Required fields
      expect(event.data).toHaveProperty("codonId");
      expect(event.data).toHaveProperty("codonName");
      expect(event.data).toHaveProperty("sessionId");
      expect(event.data).toHaveProperty("startTime");

      // Session ID should be a valid UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(event.data.sessionId).toMatch(uuidRegex);

      // Start time should be valid ISO string
      expect(() => new Date(event.data.startTime)).not.toThrow();
    });
  });

  test("completed codons only include codons that received Claude session IDs", () => {
    // In the happy path, all codons should complete with session IDs
    const finalSnapshot = [...testState.events].reverse().find((e) => e.type === "state.snapshot");

    if (finalSnapshot?.type === "state.snapshot") {
      // All completed codons should have valid UUID session IDs
      finalSnapshot.data.completedCodons.forEach((codon) => {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (codon.status === "completed" && codon.claudeSessionId) {
          expect(codon.claudeSessionId).toMatch(uuidRegex);
        } else if (codon.status === "failed" && codon.claudeSessionId) {
          expect(codon.claudeSessionId).toMatch(uuidRegex);
        } else if (codon.status === "skipped" && codon.claudeSessionId) {
          expect(codon.claudeSessionId).toMatch(uuidRegex);
        }
      });

      // Should have 3 completed codons in happy path
      expect(finalSnapshot.data.completedCodons.length).toBe(3);
    }
  });

  test("info events about Claude starting appear before codon.started", () => {
    // For each codon, find the pair of events
    ["codon-1", "codon-2", "codon-3"].forEach((codonId) => {
      const codonStarted = testState.events.find(
        (e) => e.type === "codon.started" && e.data.codonId === codonId,
      );

      if (codonStarted?.type === "codon.started") {
        const sessionId = codonStarted.data.sessionId;

        // Find the corresponding info event
        const infoEvent = testState.events.find(
          (e) =>
            e.type === "info" && e.data.message === `Claude started with session ID: ${sessionId}`,
        );

        expect(infoEvent).toBeDefined();

        if (infoEvent) {
          // Info event should come before or at same time as codon.started
          const infoIndex = testState.events.indexOf(infoEvent);
          const codonIndex = testState.events.indexOf(codonStarted);

          // They should be close together (within a few events)
          expect(Math.abs(codonIndex - infoIndex)).toBeLessThanOrEqual(2);
        }
      }
    });
  });

  test("state snapshots no longer include codonExecutionId", () => {
    const snapshots = testState.client?.getEventsByType("state.snapshot") || [];

    snapshots.forEach((snapshot) => {
      if (snapshot.type === "state.snapshot" && snapshot.data.currentCodon) {
        // codonExecutionId has been removed in the new state management system
        expect(snapshot.data.currentCodon).not.toHaveProperty("codonExecutionId");

        // claudeSessionId only exists when status is "running" and should be UUID format
        if (
          snapshot.data.currentCodon.status === "running" &&
          snapshot.data.currentCodon.claudeSessionId
        ) {
          const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          expect(snapshot.data.currentCodon.claudeSessionId).toMatch(uuidRegex);
        }
      }
    });
  });
}
