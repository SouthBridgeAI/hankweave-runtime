import { describe, expect, test } from "bun:test";
import type { ClaudeLogMessage } from "../../server/types/types.js";
import { isContextExceeded } from "../../server/types/types.js";

describe("Context Exceeded Detection", () => {
  describe("Pattern 1: Synthetic terminated message", () => {
    test("detects synthetic terminated message", () => {
      expect(
        isContextExceeded({
          type: "assistant",
          message: {
            id: "92543df9-1a77-4605-bec0-3cea4ce9f51f",
            model: "<synthetic>",
            role: "assistant",
            stop_reason: "stop_sequence",
            stop_sequence: "",
            type: "message",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            content: [{ type: "text", text: "API Error: terminated" }],
          },
          parent_tool_use_id: null,
          session_id: "983b8c3c-7336-4ef9-8d38-f564e81f551e",
        } as ClaudeLogMessage),
      ).toBe(true);

      expect(
        isContextExceeded({
          type: "assistant",
          message: {
            id: "a05350c1-bebd-4e89-a1df-b38066e9f3ee",
            type: "message",
            role: "assistant",
            model: "<synthetic>",
            content: [
              {
                type: "text",
                text: "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
              },
            ],
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              server_tool_use: {
                web_search_requests: 0,
              },
              service_tier: null,
            },
            stop_reason: "stop_sequence",
            stop_sequence: "",
          },
        }),
      ).toBe(true);
    });

    test("does not detect synthetic timeout messages", () => {
      const msg = {
        type: "assistant",
        message: {
          id: "msg_timeout",
          model: "<synthetic>",
          role: "assistant",
          type: "message",
          content: "API Error: Request timed out.",
          stop_reason: null,
          stop_sequence: null,
        },
      } as ClaudeLogMessage;

      expect(isContextExceeded(msg)).toBe(false);
    });

    test("does not detect if content is wrong", () => {
      const msg = {
        type: "assistant",
        message: {
          id: "msg_123",
          model: "<synthetic>",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "API Error: something else" }],
          stop_reason: "stop_sequence",
          stop_sequence: "",
        },
      } as ClaudeLogMessage;

      expect(isContextExceeded(msg)).toBe(false);
    });

    test("does not detect if model is not synthetic", () => {
      const msg = {
        type: "assistant",
        message: {
          id: "msg_123",
          model: "claude-sonnet-4-20250514",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "API Error: terminated" }],
          stop_reason: "stop_sequence",
          stop_sequence: "",
        },
      } as ClaudeLogMessage;

      expect(isContextExceeded(msg)).toBe(false);
    });

    test("does not detect if content is not an array", () => {
      const msg = {
        type: "assistant",
        message: {
          id: "msg_123",
          model: "<synthetic>",
          role: "assistant",
          type: "message",
          content: "API Error: terminated",
          stop_reason: "stop_sequence",
          stop_sequence: "",
        },
      } as ClaudeLogMessage;

      expect(isContextExceeded(msg)).toBe(false);
    });
  });

  describe("Pattern 2: Output token maximum exceeded in result message", () => {
    test("detects output token maximum exceeded", () => {
      const msg = {
        type: "result",
        subtype: "success",
        is_error: true,
        duration_ms: 370393,
        duration_api_ms: 371414,
        num_turns: 18,
        result:
          "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
        session_id: "89273bda-141c-4842-ba54-96d1eab913a0",
        total_cost_usd: 0.7717817000000001,
        usage: {
          input_tokens: 6,
          cache_creation_input_tokens: 71382,
          cache_read_input_tokens: 75580,
          output_tokens: 32008,
        },
      } as ClaudeLogMessage;

      expect(isContextExceeded(msg)).toBe(true);
    });

    test("does not detect successful result messages", () => {
      const msg = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 12000,
        duration_api_ms: 11500,
        num_turns: 5,
        result: "Task completed successfully",
        session_id: "session-123",
      } as ClaudeLogMessage;

      expect(isContextExceeded(msg)).toBe(false);
    });

    test("does not detect error result with different message", () => {
      const msg = {
        type: "result",
        subtype: "error",
        is_error: true,
        duration_ms: 5000,
        duration_api_ms: 4500,
        num_turns: 2,
        result: "API Error: Invalid API key",
        session_id: "session-456",
      } as ClaudeLogMessage;

      expect(isContextExceeded(msg)).toBe(false);
    });

    test("does not detect if is_error is false", () => {
      const msg = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 12000,
        duration_api_ms: 11500,
        num_turns: 5,
        result:
          "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
        session_id: "session-123",
      } as ClaudeLogMessage;

      expect(isContextExceeded(msg)).toBe(false);
    });
  });

  describe("General message type handling", () => {
    test("does not detect regular assistant messages", () => {
      const msg = {
        type: "assistant",
        message: {
          id: "msg_123",
          model: "claude-sonnet-4-20250514",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "Hello!" }],
          stop_reason: "end_turn",
          stop_sequence: null,
        },
      } as ClaudeLogMessage;

      expect(isContextExceeded(msg)).toBe(false);
    });

    test("does not detect other message types", () => {
      const msg = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "Some user message" }],
        },
      } as ClaudeLogMessage;

      expect(isContextExceeded(msg)).toBe(false);
    });

    test("does not detect system messages", () => {
      const msg = {
        type: "system",
        subtype: "init",
        cwd: "/some/path",
        session_id: "session-123",
        tools: ["bash", "read"],
        model: "claude-sonnet-4-20250514",
        permissionMode: "requestPermissions",
        apiKeySource: "ANTHROPIC_API_KEY",
      } as ClaudeLogMessage;

      expect(isContextExceeded(msg)).toBe(false);
    });
  });
});
