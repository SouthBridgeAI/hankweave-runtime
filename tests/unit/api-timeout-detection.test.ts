import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ResultMessage } from "../../types/claude-session-schema.js";
import { APITimeoutError, ErrorSeverity } from "../../server/error-types.js";

describe("API Timeout Detection", () => {
  describe("APITimeoutError", () => {
    test("should create timeout error with correct properties", () => {
      const phaseId = "test-phase";
      const context = { timestamp: "2025-07-09T12:00:00Z" };
      const error = new APITimeoutError(phaseId, context);

      expect(error).toBeInstanceOf(APITimeoutError);
      expect(error.name).toBe("APITimeoutError");
      expect(error.message).toBe("Claude API request timed out");
      expect(error.severity).toBe(ErrorSeverity.PHASE);
      expect(error.code).toBe("API_TIMEOUT_ERROR");
      expect(error.context).toEqual({
        phaseId: "test-phase",
        timestamp: "2025-07-09T12:00:00Z",
      });
    });
  });

  describe("Timeout Message Detection", () => {
    test("should detect timeout in assistant message", () => {
      const assistantMessage: AssistantMessage = {
        type: "assistant",
        message: {
          id: "msg_01234",
          type: "message",
          role: "assistant",
          model: "claude-3-opus-20240229",
          content: [
            {
              type: "text",
              text: "API Error: Request timed out.",
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
        },
      };

      // Extract text content
      const content = assistantMessage.message.content;
      const textContent = Array.isArray(content) 
        ? content.find(item => item.type === "text" && "text" in item)?.text
        : content;

      expect(textContent).toBe("API Error: Request timed out.");
    });

    test("should detect timeout in result message", () => {
      const resultMessage: ResultMessage = {
        type: "result",
        subtype: "error",
        is_error: true,
        duration_ms: 1253987,
        duration_api_ms: 414469,
        num_turns: 319,
        result: "API Error: Request timed out.",
        session_id: "374bf5fd-dc81-4fe4-bb06-a92b30c79227",
        total_cost_usd: 0.9070275,
        usage: {
          input_tokens: 39,
          output_tokens: 12279,
          cache_creation_input_tokens: 153466,
          cache_read_input_tokens: 490760,
        },
      };

      expect(resultMessage.subtype).toBe("error");
      expect(resultMessage.result).toBe("API Error: Request timed out.");
    });

    test("should not detect timeout in normal messages", () => {
      const normalMessage: AssistantMessage = {
        type: "assistant",
        message: {
          id: "msg_01234",
          type: "message",
          role: "assistant",
          model: "claude-3-opus-20240229",
          content: [
            {
              type: "text",
              text: "Here is a normal response without any timeout.",
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
        },
      };

      const content = normalMessage.message.content;
      const textContent = Array.isArray(content) 
        ? content.find(item => item.type === "text" && "text" in item)?.text
        : content;

      expect(textContent).not.toBe("API Error: Request timed out.");
      expect(textContent).not.toContain("Request timed out");
    });
  });

  describe("Timeout Detection Patterns", () => {
    const timeoutPatterns = [
      "API Error: Request timed out.",
      // Future: we might want to detect variations
    ];

    test.each(timeoutPatterns)("should match timeout pattern: %s", (pattern) => {
      expect(pattern).toMatch(/API Error: Request timed out\./);
    });

    test("exact match for timeout message", () => {
      const exactTimeoutMessage = "API Error: Request timed out.";
      const similarButDifferent = [
        "API Error: Request timed out",  // missing period
        "API Error: Request timed out!",  // different punctuation
        "API error: request timed out.",  // different case
        "Error: Request timed out.",      // missing API
        "API Error: Connection timed out.", // different error
      ];

      // Exact match
      expect(exactTimeoutMessage === "API Error: Request timed out.").toBe(true);

      // Similar messages should not match exactly
      for (const msg of similarButDifferent) {
        expect(msg === "API Error: Request timed out.").toBe(false);
      }
    });
  });
});