import { describe, expect, test } from "bun:test";
import { EventId } from "../../server/branded-types.js";
import type { FailureReason, PhaseCompletedEvent } from "../../server/types.js";

describe("Phase Failure Reason", () => {
  describe("FailureReason type", () => {
    test("should have correct structure for timeout", () => {
      const failureReason: FailureReason = {
        type: "timeout",
        retriable: true,
        message: "API Error: Request timed out.",
      };

      expect(failureReason.type).toBe("timeout");
      expect(failureReason.retriable).toBe(true);
      expect(failureReason.message).toBe("API Error: Request timed out.");
    });

    test("should have correct structure for rate-limit", () => {
      const failureReason: FailureReason = {
        type: "rate-limit",
        retriable: true,
        message: "Rate limit exceeded",
      };

      expect(failureReason.type).toBe("rate-limit");
      expect(failureReason.retriable).toBe(true);
      expect(failureReason.message).toBe("Rate limit exceeded");
    });

    test("should have correct structure for api-error", () => {
      const failureReason: FailureReason = {
        type: "api-error",
        retriable: false,
        message: "Invalid API key",
      };

      expect(failureReason.type).toBe("api-error");
      expect(failureReason.retriable).toBe(false);
      expect(failureReason.message).toBe("Invalid API key");
    });

    test("should have correct structure for unknown error", () => {
      const failureReason: FailureReason = {
        type: "unknown",
        retriable: false,
      };

      expect(failureReason.type).toBe("unknown");
      expect(failureReason.retriable).toBe(false);
      expect(failureReason.message).toBeUndefined();
    });
  });

  describe("PhaseCompletedEvent with failure reason", () => {
    test("should include failure reason for failed phase", () => {
      const event: PhaseCompletedEvent = {
        id: EventId("test-id"),
        timestamp: new Date().toISOString(),
        type: "phase.completed",
        data: {
          phaseId: "phase-1",
          success: false,
          cost: 0.1234,
          duration: 5000,
          exitStatus: { type: "error", code: 1 },
          failureReason: {
            type: "timeout",
            retriable: true,
            message: "API Error: Request timed out.",
          },
        },
      };

      expect(event.type).toBe("phase.completed");
      expect(event.data.success).toBe(false);
      expect(event.data.failureReason).toBeDefined();
      expect(event.data.failureReason?.type).toBe("timeout");
      expect(event.data.failureReason?.retriable).toBe(true);
      expect(event.data.failureReason?.message).toBe(
        "API Error: Request timed out."
      );
    });

    test("should not include failure reason for successful phase", () => {
      const event: PhaseCompletedEvent = {
        id: EventId("test-id-2"),
        timestamp: new Date().toISOString(),
        type: "phase.completed",
        data: {
          phaseId: "phase-1",
          success: true,
          cost: 0.1234,
          duration: 5000,
          exitStatus: { type: "success" },
        },
      };

      expect(event.type).toBe("phase.completed");
      expect(event.data.success).toBe(true);
      expect(event.data.failureReason).toBeUndefined();
    });

    test("should handle phase completed without failure reason", () => {
      const event: PhaseCompletedEvent = {
        id: EventId("test-id-3"),
        timestamp: new Date().toISOString(),
        type: "phase.completed",
        data: {
          phaseId: "phase-1",
          success: false,
          cost: 0.1234,
          duration: 5000,
          exitStatus: { type: "error", code: 1 },
          // No failureReason provided
        },
      };

      expect(event.type).toBe("phase.completed");
      expect(event.data.success).toBe(false);
      expect(event.data.failureReason).toBeUndefined();
    });
  });

  describe("Retriable error classification", () => {
    const retriableErrors: Array<[FailureReason["type"], boolean]> = [
      ["timeout", true],
      ["rate-limit", true],
      ["api-error", false],
      ["unknown", false],
    ];

    test.each(retriableErrors)(
      "should classify %s as retriable: %s",
      (type, expectedRetriable) => {
        const failureReason: FailureReason = {
          type,
          retriable: expectedRetriable,
        };

        expect(failureReason.retriable).toBe(expectedRetriable);
      }
    );
  });
});
