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
      // Find the codon.started event for this codon
      const codonStartedEvent = testState.events.find(
        (e) => e.type === "codon.started" && e.data.codonId === codonId,
      );

      if (codonStartedEvent?.type === "codon.started") {
        const sessionId = codonStartedEvent.data.sessionId;

        // Find the Claude started info event for this specific codon
        const claudeStartedEvent = testState.events.find(
          (e) =>
            e.type === "info" &&
            e.data.message === `Claude started codon ${codonId} with session ID: ${sessionId}`,
        );

        if (claudeStartedEvent) {
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
          // UUID format: 8-4-4-4-12 (any RFC-4122 version; SDK 0.3.x emits UUIDv7)
          const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
        const match = msg.match(/Claude started codon ([\w-]+) with session ID: ([0-9a-f-]+)/i);
        if (match) {
          const codonId = match[1];
          const sessionId = match[2];
          if (!codonSessionIds.has(codonId)) {
            codonSessionIds.set(codonId, new Set());
          }
          codonSessionIds.get(codonId)?.add(sessionId);
        }
      }
    });

    // Retries are recorded in the stream as "Retrying codon <id> (attempt
    // N/M)" info events; each retry attempt legitimately starts a fresh
    // session, so exactly-one only holds for codons that were never retried.
    const retriedCodons = new Set<string>();
    for (const event of testState.events) {
      if (event.type === "info") {
        const match = (event.data.message || "").match(
          /Retrying codon ([\w#-]+) \(attempt \d+\/\d+\)/i,
        );
        if (match) {
          retriedCodons.add(match[1]);
        }
      }
    }

    // Authoritative final session per codon: the last state snapshot.
    const lastSnapshot = [...testState.events].reverse().find((e) => e.type === "state.snapshot");

    codonSessionIds.forEach((sessionIds, codonId) => {
      if (!retriedCodons.has(codonId)) {
        // No retry recorded: exactly one session for this codon.
        expect(sessionIds.size).toBe(1);
        return;
      }

      // Retried: one session per attempt. Require at least one, and that the
      // final session recorded in state is among the ones we observed.
      expect(sessionIds.size).toBeGreaterThanOrEqual(1);
      if (lastSnapshot?.type === "state.snapshot") {
        const finalSessionId = lastSnapshot.data.completedCodons.find(
          (c) => c.codonId === codonId,
        )?.claudeSessionId;
        if (finalSessionId) {
          expect(sessionIds.has(finalSessionId)).toBe(true);
        }
      }
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
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
        const uuidRegex =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

  test("info events about codon starting appear before codon.started", () => {
    // For each codon, find the pair of events
    ["codon-1", "codon-2", "codon-3"].forEach((codonId) => {
      const codonStarted = testState.events.find(
        (e) => e.type === "codon.started" && e.data.codonId === codonId,
      );

      if (codonStarted?.type === "codon.started") {
        const sessionId = codonStarted.data.sessionId;

        // Find the corresponding info event for this specific codon
        const infoEvent = testState.events.find(
          (e) =>
            e.type === "info" &&
            e.data.message === `Started codon ${codonId} with session ID: ${sessionId}`,
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
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          expect(snapshot.data.currentCodon.claudeSessionId).toMatch(uuidRegex);
        }
      }
    });
  });
}
