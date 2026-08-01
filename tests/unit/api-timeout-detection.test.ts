import { describe, expect, test } from "bun:test";
import { APITimeoutError, ErrorSeverity } from "../../server/types/error-types.js";

describe("API Timeout Detection", () => {
  describe("APITimeoutError", () => {
    test("should create timeout error with correct properties", () => {
      const codonId = "test-codon";
      const context = { timestamp: "2025-07-09T12:00:00Z" };
      const error = new APITimeoutError(codonId, context);

      expect(error).toBeInstanceOf(APITimeoutError);
      expect(error.name).toBe("APITimeoutError");
      expect(error.message).toBe("Claude API request timed out");
      expect(error.severity).toBe(ErrorSeverity.CODON);
      expect(error.code).toBe("API_TIMEOUT_ERROR");
      expect(error.context).toEqual({
        codonId: "test-codon",
        timestamp: "2025-07-09T12:00:00Z",
      });
    });
  });
});
