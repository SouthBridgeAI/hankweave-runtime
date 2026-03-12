/**
 * Translation helpers for converting Pi SDK messages into the shim protocol.
 */

import type {
  AssistantMessage,
  ContentBlock,
  SystemMessage,
  TokenUsage,
  ToolResultContent,
  ToolUseContent,
  UserMessage,
} from "@shims/common";
import { STANDARD_TOOLS } from "@shims/common";

export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface PiAssistantMessage {
  role: "assistant";
  content: PiContentBlock[];
  usage?: PiUsage;
  stopReason?: string;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content?: Array<{ type: string; text?: string }>;
  isError: boolean;
}

const PI_TO_SHIM_TOOL_NAMES: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
};

const KEY_RENAMES: Record<string, string> = {
  path: "file_path",
  filePath: "file_path",
};

export function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function generateToolUseId(): string {
  return `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function normalizeToolName(name: string): string {
  return PI_TO_SHIM_TOOL_NAMES[name.toLowerCase()] ?? name;
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function normalizeToolInput(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    normalized[KEY_RENAMES[key] ?? camelToSnake(key)] = value;
  }
  return normalized;
}

export function normalizeStopReason(
  stopReason: string | undefined,
): "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null {
  switch (stopReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "toolUse":
      return "tool_use";
    default:
      return null;
  }
}

export function normalizeUsage(usage: PiUsage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    input_tokens: usage.input ?? 0,
    output_tokens: usage.output ?? 0,
    ...(usage.cacheRead && usage.cacheRead > 0
      ? { cache_read_input_tokens: usage.cacheRead }
      : {}),
    ...(usage.cacheWrite && usage.cacheWrite > 0
      ? { cache_creation_input_tokens: usage.cacheWrite }
      : {}),
  };
}

export function ensurePublicToolId(nativeId: string, toolIdMap: Map<string, string>): string {
  const existing = toolIdMap.get(nativeId);
  if (existing) {
    return existing;
  }

  const publicId = /^(toolu_[a-zA-Z0-9]+|call_[a-fA-F0-9]+)$/.test(nativeId)
    ? nativeId
    : generateToolUseId();
  toolIdMap.set(nativeId, publicId);
  return publicId;
}

export function translatePiBlock(
  block: PiContentBlock,
  toolIdMap: Map<string, string>,
): ContentBlock | null {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? { type: "text", text: block.text } : null;
    case "thinking":
      return typeof block.thinking === "string"
        ? { type: "thinking", thinking: block.thinking }
        : null;
    case "toolCall": {
      const nativeId = block.id;
      const publicId = nativeId
        ? toolIdMap.get(nativeId) ?? ensurePublicToolId(nativeId, toolIdMap)
        : generateToolUseId();

      const toolUse: ToolUseContent = {
        type: "tool_use",
        id: publicId,
        name: normalizeToolName(block.name ?? "unknown"),
        input: normalizeToolInput(block.arguments),
      };
      return toolUse;
    }
    default:
      return null;
  }
}

export function makeSystemMessage(
  sessionId: string,
  cwd: string,
  model: string,
  apiKeySource: string,
): SystemMessage {
  return {
    type: "system",
    subtype: "init",
    cwd,
    session_id: sessionId,
    tools: [...STANDARD_TOOLS],
    model,
    permissionMode: "bypassPermissions",
    apiKeySource,
    mcp_servers: [],
  };
}

export function makeAssistantMessage(
  message: PiAssistantMessage,
  model: string,
  toolIdMap: Map<string, string>,
): AssistantMessage {
  const content = message.content
    .map((block) => translatePiBlock(block, toolIdMap))
    .filter((block): block is ContentBlock => block !== null);

  return {
    type: "assistant",
    message: {
      id: generateMessageId(),
      type: "message",
      role: "assistant",
      model,
      content,
      usage: normalizeUsage(message.usage),
      stop_reason: normalizeStopReason(message.stopReason),
    },
  };
}

export function serializeToolResultContent(
  content: Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content || content.length === 0) {
    return "";
  }

  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

function readPathFromInput(input: Record<string, unknown> | undefined): string | undefined {
  const value = input?.file_path;
  return typeof value === "string" ? value : undefined;
}

export function fallbackToolResultContent(
  toolName: string,
  input: Record<string, unknown> | undefined,
  isError: boolean,
): string {
  const normalizedName = normalizeToolName(toolName);
  const filePath = readPathFromInput(input);

  if (isError) {
    return `Tool ${normalizedName} failed`;
  }

  switch (normalizedName) {
    case "Write":
      return filePath ? `File written: ${filePath}` : "Write completed";
    case "Edit":
      return filePath ? `File edited: ${filePath}` : "Edit completed";
    case "Read":
      return filePath ? `Read completed: ${filePath} (file was empty)` : "Read completed (file was empty)";
    case "Bash":
      return "Command completed with no output";
    case "Glob":
      return "No matching files found";
    case "Grep":
      return "No matches found";
    case "LS":
      return "Directory listing was empty";
    default:
      return `${normalizedName} completed`;
  }
}

export function makeUserMessageWithToolResults(
  toolResults: Array<{ toolUseId: string; content: string; isError: boolean }>,
): UserMessage {
  const content: ToolResultContent[] = toolResults.map((toolResult) => ({
    type: "tool_result",
    tool_use_id: toolResult.toolUseId,
    content: toolResult.isError
      ? { is_error: true as const, error: toolResult.content }
      : toolResult.content,
  }));

  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
  };
}

export function classifyRuntimeError(errorMessage: string): string {
  const lower = errorMessage.toLowerCase();
  if (
    lower.includes("auth") ||
    lower.includes("api key") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("rate limit") ||
    lower.includes("quota") ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return `API Error: ${errorMessage}`;
  }
  return `Agent Error: ${errorMessage}`;
}

export function emitMessage(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function flushStdout(): Promise<void> {
  if (!process.stdout.writable || process.stdout.destroyed || process.stdout.writableEnded) {
    return;
  }

  await new Promise<void>((resolve) => {
    process.stdout.write("", () => resolve());
  });
}
