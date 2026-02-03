import { describe, expect, test } from "bun:test";
import { EventId } from "../../server/types/branded-types.js";
import type { CodonCompletedEvent, FailureReason } from "../../server/types/types.js";

describe("Codon Failure Reason", () => {
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

  describe("CodonCompletedEvent with failure reason", () => {
    test("should include failure reason for failed codon", () => {
      const event: CodonCompletedEvent = {
        id: EventId("test-id"),
        timestamp: new Date().toISOString(),
        type: "codon.completed",
        data: {
          codonId: "codon-1",
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

      expect(event.type).toBe("codon.completed");
      expect(event.data.success).toBe(false);
      expect(event.data.failureReason).toBeDefined();
      expect(event.data.failureReason?.type).toBe("timeout");
      expect(event.data.failureReason?.retriable).toBe(true);
      expect(event.data.failureReason?.message).toBe("API Error: Request timed out.");
    });

    test("should not include failure reason for successful codon", () => {
      const event: CodonCompletedEvent = {
        id: EventId("test-id-2"),
        timestamp: new Date().toISOString(),
        type: "codon.completed",
        data: {
          codonId: "codon-1",
          success: true,
          cost: 0.1234,
          duration: 5000,
          exitStatus: { type: "success" },
        },
      };

      expect(event.type).toBe("codon.completed");
      expect(event.data.success).toBe(true);
      expect(event.data.failureReason).toBeUndefined();
    });

    test("should handle codon completed without failure reason", () => {
      const event: CodonCompletedEvent = {
        id: EventId("test-id-3"),
        timestamp: new Date().toISOString(),
        type: "codon.completed",
        data: {
          codonId: "codon-1",
          success: false,
          cost: 0.1234,
          duration: 5000,
          exitStatus: { type: "error", code: 1 },
          // No failureReason provided
        },
      };

      expect(event.type).toBe("codon.completed");
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

    test.each(retriableErrors)("should classify %s as retriable: %s", (type, expectedRetriable) => {
      const failureReason: FailureReason = {
        type,
        retriable: expectedRetriable,
      };

      expect(failureReason.retriable).toBe(expectedRetriable);
    });
  });

  describe("CodonCompletedEvent with failureIgnored", () => {
    test("should include failureIgnored when failure is ignored", () => {
      const event: CodonCompletedEvent = {
        id: EventId("test-id"),
        timestamp: new Date().toISOString(),
        type: "codon.completed",
        data: {
          codonId: "codon-1",
          success: false,
          cost: 0.1234,
          duration: 5000,
          exitStatus: { type: "error", code: 1 },
          failureReason: {
            type: "api-error",
            retriable: false,
            message: "Some API error",
          },
          failureIgnored: true,
        },
      };

      expect(event.data.success).toBe(false);
      expect(event.data.failureIgnored).toBe(true);
    });

    test("should omit failureIgnored for successful codon", () => {
      const event: CodonCompletedEvent = {
        id: EventId("test-id"),
        timestamp: new Date().toISOString(),
        type: "codon.completed",
        data: {
          codonId: "codon-1",
          success: true,
          cost: 0.1234,
          duration: 5000,
          exitStatus: { type: "success" },
        },
      };

      expect(event.data.failureIgnored).toBeUndefined();
    });

    test("should omit failureIgnored for aborted failures", () => {
      const event: CodonCompletedEvent = {
        id: EventId("test-id"),
        timestamp: new Date().toISOString(),
        type: "codon.completed",
        data: {
          codonId: "codon-1",
          success: false,
          cost: 0,
          duration: 1000,
          exitStatus: { type: "error", code: 1 },
          failureReason: {
            type: "unknown",
            retriable: false,
            message: "Failed",
          },
          // failureIgnored NOT set - this is an aborted failure
        },
      };

      expect(event.data.success).toBe(false);
      expect(event.data.failureIgnored).toBeUndefined();
    });
  });
});
