/**
 * Standard shim output message types
 * Used by all shims for consistent output format
 */

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface SystemMessage {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  model: string;
  permissionMode: "bypassPermissions" | "requestPermissions";
  apiKeySource: string;
  mcp_servers?: unknown[];
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string | { is_error: true; error: string };
}

export type ContentBlock = TextContent | ThinkingContent | ToolUseContent;

export interface AssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: ContentBlock[] | string;
    usage?: TokenUsage;
    stop_reason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  };
}

export interface UserMessage {
  type: "user";
  message: {
    role: "user";
    content: ToolResultContent[];
  };
}

export interface ResultMessage {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns: number;
  result: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: TokenUsage;
}

export type ShimMessage = SystemMessage | AssistantMessage | UserMessage | ResultMessage;

export const MESSAGE_ID_REGEX =
  /^(msg_[a-zA-Z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const TOOL_USE_ID_REGEX = /^(toolu_[a-zA-Z0-9]+|call_[a-fA-F0-9]+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (!isRecord(value)) {
    return false;
  }

  const numericKeys = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ] as const;

  return numericKeys.every((key) => value[key] === undefined || typeof value[key] === "number");
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "thinking":
      return typeof value.thinking === "string";
    case "tool_use":
      return (
        typeof value.id === "string" &&
        TOOL_USE_ID_REGEX.test(value.id) &&
        typeof value.name === "string" &&
        (value.input === undefined || isRecord(value.input))
      );
    default:
      return false;
  }
}

function isToolResultContent(value: unknown): value is ToolResultContent {
  if (!isRecord(value)) {
    return false;
  }

  const hasValidErrorObject =
    isRecord(value.content) &&
    value.content.is_error === true &&
    typeof value.content.error === "string";

  return (
    value.type === "tool_result" &&
    typeof value.tool_use_id === "string" &&
    TOOL_USE_ID_REGEX.test(value.tool_use_id) &&
    (typeof value.content === "string" || hasValidErrorObject)
  );
}

export function validateShimMessage(
  value: unknown,
): { valid: true } | { valid: false; reason: string } {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { valid: false, reason: "Message must be an object with a string type" };
  }

  switch (value.type) {
    case "system": {
      if (value.subtype !== "init") {
        return { valid: false, reason: "System message subtype must be init" };
      }

      if (
        typeof value.cwd !== "string" ||
        typeof value.session_id !== "string" ||
        !Array.isArray(value.tools) ||
        !value.tools.every((tool) => typeof tool === "string") ||
        typeof value.model !== "string" ||
        (value.permissionMode !== "bypassPermissions" &&
          value.permissionMode !== "requestPermissions") ||
        typeof value.apiKeySource !== "string"
      ) {
        return { valid: false, reason: "System init message is missing required fields" };
      }

      return { valid: true };
    }

    case "assistant": {
      if (!isRecord(value.message)) {
        return { valid: false, reason: "Assistant message payload must be an object" };
      }

      if (
        typeof value.message.id !== "string" ||
        !MESSAGE_ID_REGEX.test(value.message.id) ||
        value.message.type !== "message" ||
        value.message.role !== "assistant" ||
        typeof value.message.model !== "string"
      ) {
        return { valid: false, reason: "Assistant message has invalid core fields" };
      }

      const content = value.message.content;
      if (
        typeof content !== "string" &&
        (!Array.isArray(content) || !content.every((block) => isContentBlock(block)))
      ) {
        return {
          valid: false,
          reason: "Assistant content must be a string or valid content blocks",
        };
      }

      if (value.message.usage !== undefined && !isTokenUsage(value.message.usage)) {
        return { valid: false, reason: "Assistant usage must match token usage schema" };
      }

      const validStopReasons = ["end_turn", "max_tokens", "stop_sequence", "tool_use", null];
      if (
        value.message.stop_reason !== undefined &&
        !validStopReasons.includes(value.message.stop_reason as (typeof validStopReasons)[number])
      ) {
        return { valid: false, reason: "Assistant stop_reason is invalid" };
      }

      return { valid: true };
    }

    case "user": {
      if (
        !isRecord(value.message) ||
        value.message.role !== "user" ||
        !Array.isArray(value.message.content) ||
        !value.message.content.every((block) => isToolResultContent(block))
      ) {
        return { valid: false, reason: "User message must contain valid tool_result blocks" };
      }

      return { valid: true };
    }

    case "result": {
      if (
        (value.subtype !== "success" && value.subtype !== "error") ||
        typeof value.is_error !== "boolean" ||
        typeof value.duration_ms !== "number" ||
        typeof value.num_turns !== "number" ||
        typeof value.result !== "string"
      ) {
        return { valid: false, reason: "Result message has invalid core fields" };
      }

      if (value.is_error !== (value.subtype === "error")) {
        return { valid: false, reason: "Result is_error must match subtype" };
      }

      if (value.usage !== undefined && !isTokenUsage(value.usage)) {
        return { valid: false, reason: "Result usage must match token usage schema" };
      }

      return { valid: true };
    }

    default:
      return { valid: false, reason: `Unsupported shim message type: ${value.type}` };
  }
}
