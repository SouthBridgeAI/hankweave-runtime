/**
 * Pi SDK → claude-session-schema translation, for the IN-PROCESS PiSdkManager.
 *
 * This is the in-process analogue of the pi shim's `translator.ts`: it converts
 * Pi agent-session events into the same claude-session JSONL the runtime's
 * ClaudeLogParser already consumes, so the rest of hankweave is harness-agnostic.
 * It is intentionally self-contained (no `@shims/common` coupling) and targets
 * the server's own `claude-session-schema` types.
 */
import type {
  AssistantMessage,
  ResultMessage,
  SystemMessage,
  ToolResultContent,
  UserMessage,
} from "./types/claude-session-schema.js";

/** Pi token-usage shape (from message.usage / session stats). */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** A content block inside a Pi assistant message. */
export interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  // tool-call block fields
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface PiAssistantMessage {
  role?: string;
  content: PiContentBlock[];
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

export interface PiToolResultMessage {
  toolCallId: string;
  toolName: string;
  content?: Array<{ type: string; text?: string }>;
  isError: boolean;
}

/** Pi tool name (lowercase) → Claude/Hankweave tool name. */
export const PI_TO_CLAUDE_TOOL_NAMES: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
};

export function normalizeToolName(name: string): string {
  return PI_TO_CLAUDE_TOOL_NAMES[name.toLowerCase()] ?? name;
}

/** Pi tool-input keys → Claude tool-input keys (so path extraction works). */
const KEY_RENAMES: Record<string, string> = { path: "file_path", filePath: "file_path" };

function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
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

const VALID_TOOL_ID = /^(toolu_[a-zA-Z0-9]+|call_[a-fA-F0-9]+)$/;

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 14).padEnd(12, "0");
}

export function generateToolUseId(): string {
  return `toolu_${Date.now().toString(36)}${randomSuffix()}`;
}

export function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}${randomSuffix()}`;
}

/**
 * Map a Pi native tool-call id to a schema-valid public id, stably per id.
 * Pi ids like `call_00_vBGE...` contain underscores/mixed case and fail the
 * claude-schema regex, so they get a generated `toolu_…` id. The SAME map must
 * be shared across message translation so tool_use and tool_result ids
 * correlate.
 */
export function ensurePublicToolId(nativeId: string, toolIdMap: Map<string, string>): string {
  const existing = toolIdMap.get(nativeId);
  if (existing) return existing;
  const publicId = VALID_TOOL_ID.test(nativeId) ? nativeId : generateToolUseId();
  toolIdMap.set(nativeId, publicId);
  return publicId;
}

export function normalizeUsage(usage: PiUsage | undefined): AssistantMessage["message"]["usage"] {
  if (!usage) return undefined;
  return {
    input_tokens: Math.max(0, Math.round(usage.input ?? 0)),
    output_tokens: Math.max(0, Math.round(usage.output ?? 0)),
    cache_read_input_tokens: Math.max(0, Math.round(usage.cacheRead ?? 0)),
    cache_creation_input_tokens: Math.max(0, Math.round(usage.cacheWrite ?? 0)),
  };
}

/**
 * Map pi's native stop reasons ("stop" | "length" | "toolUse" | "error" |
 * "aborted") to the claude-schema vocabulary, as the removed shim's translator
 * did. error/aborted (and anything unknown) map to null — the schema's
 * "no clean stop" value.
 */
function normalizeStopReason(
  reason: string | undefined,
): AssistantMessage["message"]["stop_reason"] {
  switch (reason) {
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

type ContentBlock = AssistantMessage["message"]["content"];

function translatePiBlock(
  block: PiContentBlock,
  toolIdMap: Map<string, string>,
):
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | null {
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return { type: "thinking", thinking: block.thinking };
  }
  if (block.type === "toolCall" && block.id) {
    return {
      type: "tool_use",
      id: ensurePublicToolId(block.id, toolIdMap),
      name: normalizeToolName(block.name ?? ""),
      input: normalizeToolInput(block.arguments),
    };
  }
  return null;
}

export function makeAssistantMessage(
  message: PiAssistantMessage,
  model: string,
  toolIdMap: Map<string, string>,
): AssistantMessage {
  const content = (Array.isArray(message.content) ? message.content : [])
    .map((block) => translatePiBlock(block, toolIdMap))
    .filter((block): block is NonNullable<typeof block> => block !== null);

  return {
    type: "assistant",
    message: {
      id: generateMessageId(),
      type: "message",
      role: "assistant",
      model,
      content: content as ContentBlock,
      usage: normalizeUsage(message.usage),
      stop_reason: normalizeStopReason(message.stopReason),
    },
  };
}

export function serializeToolResultContent(
  content: Array<{ type: string; text?: string }> | undefined,
): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .join("")
    .trim();
}

export function makeUserMessageWithToolResults(
  toolResults: Array<{ toolUseId: string; content: string; isError: boolean }>,
): UserMessage {
  const content: ToolResultContent[] = toolResults.map((r) => ({
    type: "tool_result",
    tool_use_id: r.toolUseId,
    content: r.isError ? { is_error: true as const, error: r.content } : r.content,
  }));
  return { type: "user", message: { role: "user", content } };
}

export function makeSystemInit(args: {
  sessionId: string;
  cwd: string;
  model: string;
  tools: string[];
  apiKeySource: string;
}): SystemMessage {
  return {
    type: "system",
    subtype: "init",
    cwd: args.cwd,
    session_id: args.sessionId,
    tools: args.tools,
    mcp_servers: [],
    model: args.model,
    permissionMode: "bypassPermissions",
    apiKeySource: args.apiKeySource,
  } as SystemMessage;
}

/**
 * Claude-schema compact_boundary marker for a pi compaction. Pi's
 * compaction_end carries `reason: "manual" | "threshold" | "overflow"`;
 * threshold/overflow are pi's automatic triggers and map to "auto" — the
 * shape isContextExceeded Pattern 3 fires on. A manual compaction maps to
 * "manual", which Pattern 3 deliberately ignores (hankweave never issues
 * one, but correctness shouldn't depend on that).
 */
export function makeCompactBoundary(args: {
  sessionId: string;
  trigger?: "auto" | "manual";
  preTokens?: number;
  postTokens?: number;
}): SystemMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    session_id: args.sessionId,
    compact_metadata: {
      trigger: args.trigger ?? "auto",
      ...(args.preTokens !== undefined ? { pre_tokens: args.preTokens } : {}),
      ...(args.postTokens !== undefined ? { post_tokens: args.postTokens } : {}),
    },
  };
}

export function makeResult(args: {
  isError: boolean;
  sessionId: string;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  totalCostUsd: number;
  result: string;
  usage?: PiUsage;
}): ResultMessage {
  return {
    type: "result",
    subtype: args.isError ? "error" : "success",
    is_error: args.isError,
    duration_ms: Math.max(0, Math.round(args.durationMs)),
    duration_api_ms: Math.max(0, Math.round(args.durationApiMs)),
    num_turns: Math.max(0, Math.round(args.numTurns)),
    result: args.result,
    session_id: args.sessionId,
    // A zero total is non-authoritative — it means pi's catalog had no pricing
    // for the model, not that the turn was free. CostTracker treats any defined
    // total_cost_usd as final and would overwrite the registry-calculated cost
    // with $0, so omit it and let the registry fallback run (the removed pi
    // shim emitted the field only when positive for the same reason).
    ...(args.totalCostUsd > 0 ? { total_cost_usd: args.totalCostUsd } : {}),
    // CostTracker.handleResultUsage() ignores the whole message — including
    // total_cost_usd — when usage is absent, so the aggregate must be present
    // for pi's reported cost to reach budgets and telemetry.
    ...(args.usage ? { usage: normalizeUsage(args.usage) } : {}),
  };
}
