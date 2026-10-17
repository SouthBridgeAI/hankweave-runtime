import { randomBytes } from "node:crypto";

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

const TOOL_KEY_NAMES: Record<string, string> = {
  shellToolCall: "Bash",
  readToolCall: "Read",
  grepToolCall: "Grep",
  searchToolCall: "Grep",
  globToolCall: "Glob",
  lsToolCall: "LS",
  listToolCall: "LS",
  writeToolCall: "Write",
};

export function messageId(): string {
  return `msg_${randomBytes(12).toString("hex")}`;
}

export function publicToolId(nativeId: string): string {
  const hex = nativeId.replace(/[^a-fA-F0-9]/g, "");
  if (hex.length >= 8) return `toolu_${hex.slice(0, 32)}`;
  return `toolu_${randomBytes(12).toString("hex")}`;
}

export function findToolPayload(
  toolCall: Record<string, unknown>,
): { key: string; payload: Record<string, unknown> } | undefined {
  for (const [key, value] of Object.entries(toolCall)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const payload = value as Record<string, unknown>;
    if ("args" in payload || "result" in payload) {
      return { key, payload };
    }
  }
  return undefined;
}

export function shimToolName(key: string, args: Record<string, unknown>, result: unknown): string {
  if (key === "editToolCall") {
    const success = isRecord(result) && isRecord(result.success) ? result.success : undefined;
    const diff = typeof success?.diffString === "string" ? success.diffString : "";
    if (diff.includes("/dev/null")) return "Write";
    if (!success && typeof args.streamContent === "string" && args.old_string === undefined && args.oldString === undefined) {
      return "Write";
    }
    return "Edit";
  }
  return TOOL_KEY_NAMES[key] ?? key.replace(/ToolCall$/, "");
}

export function toolInput(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case "Bash":
      return {
        command: typeof args.command === "string" ? args.command : "",
        description: typeof args.description === "string" ? args.description : undefined,
      };
    case "Read":
      return { file_path: typeof args.path === "string" ? args.path : "" };
    case "Write":
      return {
        file_path: typeof args.path === "string" ? args.path : "",
        content: typeof args.streamContent === "string" ? args.streamContent : args.content,
      };
    case "Edit":
      return {
        file_path: typeof args.path === "string" ? args.path : "",
        content: typeof args.streamContent === "string" ? args.streamContent : undefined,
      };
    case "Grep":
      return {
        pattern: args.pattern ?? args.query ?? "",
        path: args.path,
      };
    case "Glob":
      return { pattern: args.glob_pattern ?? args.pattern ?? args.glob ?? "" };
    case "LS":
      return { path: args.path ?? args.target_directory ?? "" };
    default:
      return args;
  }
}

export function toolResultText(name: string, result: unknown): { text: string; isError: boolean } {
  if (!isRecord(result)) {
    return { text: result === undefined ? "" : stringify(result), isError: false };
  }
  if (isRecord(result.success)) {
    return { text: successText(name, result.success), isError: false };
  }
  const failure = result.error ?? result.failure ?? result;
  return { text: stringify(failure), isError: true };
}

function successText(name: string, success: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return joinParts([success.stdout, success.stderr]);
    case "Read":
      return typeof success.content === "string" ? success.content : stringify(success);
    case "Write":
    case "Edit":
      if (typeof success.message === "string") return success.message;
      if (typeof success.diffString === "string") return success.diffString;
      return stringify(success);
    default:
      return stringify(success);
  }
}

function joinParts(parts: unknown[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assistantText(event: Record<string, unknown>): string {
  const message = event.message;
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return "";
      return block.text;
    })
    .join("");
}

export function usageFromCursor(usage: unknown): Record<string, number> | undefined {
  if (!isRecord(usage)) return undefined;
  return {
    input_tokens: numberField(usage.inputTokens),
    output_tokens: numberField(usage.outputTokens),
    cache_read_input_tokens: numberField(usage.cacheReadTokens),
    cache_creation_input_tokens: numberField(usage.cacheWriteTokens),
  };
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
