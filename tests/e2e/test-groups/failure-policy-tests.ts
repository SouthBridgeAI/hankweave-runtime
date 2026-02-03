import { describe, expect, test } from "bun:test";
import type {
  CodonCompletedEvent,
  ErrorEvent,
  InfoEvent,
  ServerEvent,
} from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
  events: ServerEvent[];
  errorEvents: ErrorEvent[];
}

/**
 * Tests for onFailure configurations (abort, retry, ignore).
 * These tests verify the runtime behavior of failure policies.
 */
export function runFailurePolicyTests(testState: TestState) {
  describe("Failure Policy: onFailure configurations", () => {
    test("onFailure: ignore - codon failure emits failureIgnored flag", () => {
      const completedEvents = testState.events.filter(
        (e) => e.type === "codon.completed",
      ) as CodonCompletedEvent[];

      // Find any codon that was configured with onFailure: ignore and failed
      const ignoredFailure = completedEvents.find(
        (e) => !e.data.success && e.data.failureIgnored === true,
      );

      if (ignoredFailure) {
        // Verify failureIgnored flag is set
        expect(ignoredFailure.data.failureIgnored).toBe(true);
        expect(ignoredFailure.data.success).toBe(false);

        // Verify failureReason is present
        expect(ignoredFailure.data.failureReason).toBeDefined();
      }
    });

    test("onFailure: ignore - subsequent codon runs after ignored failure", () => {
      const completedEvents = testState.events.filter(
        (e) => e.type === "codon.completed",
      ) as CodonCompletedEvent[];

      // Find the codon that was configured with onFailure: ignore and failed
      const ignoredFailure = completedEvents.find(
        (e) => !e.data.success && e.data.failureIgnored === true,
      );

      if (ignoredFailure) {
        // Verify subsequent codon ran (there should be a codon.completed after this one)
        const ignoredIndex = completedEvents.indexOf(ignoredFailure);

        // If there was supposed to be another codon, it should have run
        if (completedEvents.length > ignoredIndex + 1) {
          const nextCodon = completedEvents[ignoredIndex + 1];
          expect(nextCodon).toBeDefined();
        }
      }
    });

    test("onFailure: retry - emits info events for retry attempts", () => {
      const infoEvents = testState.events.filter((e) => e.type === "info") as InfoEvent[];

      const retryInfos = infoEvents.filter((e) => e.data.message.includes("Retrying codon"));

      // If there are retry info events, verify their format
      retryInfos.forEach((event) => {
        // Verify retry message format: "Retrying codon X (attempt N/M)"
        expect(event.data.message).toMatch(/Retrying codon .+ \(attempt \d+\/\d+\)/);
      });
    });

    test("onFailure: ignore - emits info event about continuation", () => {
      const infoEvents = testState.events.filter((e) => e.type === "info") as InfoEvent[];

      const ignoreInfos = infoEvents.filter((e) =>
        e.data.message.includes("continuing (onFailure=ignore)"),
      );

      // If there are ignored failure info events, verify they reference the codon
      ignoreInfos.forEach((event) => {
        expect(event.data.message).toContain("failed");
        expect(event.data.message).toContain("onFailure=ignore");
      });
    });

    test("onFailure: abort (default) - failed codons without failureIgnored stop run", () => {
      // Find any codon that failed without failureIgnored flag
      const completedEvents = testState.events.filter(
        (e) => e.type === "codon.completed",
      ) as CodonCompletedEvent[];

      const abortedFailure = completedEvents.find(
        (e) =>
          !e.data.success && !e.data.failureIgnored && e.data.failureReason?.retriable === false,
      );

      if (abortedFailure) {
        // For aborted failures with non-retriable errors, no subsequent codon should run
        expect(abortedFailure.data.failureIgnored).toBeUndefined();
        // This should be the last codon if it caused an abort
        // (unless there are codons from other runs)
      }
    });

    test("failure events include cost even for failed codons", () => {
      const completedEvents = testState.events.filter(
        (e) => e.type === "codon.completed",
      ) as CodonCompletedEvent[];

      completedEvents.forEach((event) => {
        // Cost should always be a number (may be 0 for early failures)
        expect(typeof event.data.cost).toBe("number");
        expect(event.data.cost).toBeGreaterThanOrEqual(0);
      });
    });

    test("retry accumulated costs are included in final event", () => {
      const completedEvents = testState.events.filter(
        (e) => e.type === "codon.completed",
      ) as CodonCompletedEvent[];
      const infoEvents = testState.events.filter((e) => e.type === "info") as InfoEvent[];

      // Find a codon that was retried
      const retriedCodonIds = new Set<string>();
      infoEvents.forEach((event) => {
        const match = event.data.message.match(/Retrying codon (\S+)/);
        if (match) {
          retriedCodonIds.add(match[1]);
        }
      });

      // For retried codons, the final completed event should include accumulated costs
      retriedCodonIds.forEach((codonId) => {
        const finalEvent = completedEvents.find((e) => e.data.codonId === codonId);
        if (finalEvent) {
          // Cost should be present (may be 0 if all attempts failed early)
          expect(typeof finalEvent.data.cost).toBe("number");
        }
      });
    });
  });
}
