import type {
  ShimMessage,
  SystemMessage,
  AssistantMessage,
  UserMessage,
  ResultMessage,
  ContentBlock,
  ToolUseContent,
  ToolResultContent,
} from "../types.js";

/**
 * Parse JSONL output from a shim into structured messages
 */
export function parseJsonl(stdout: string): { messages: ShimMessage[]; parseErrors: string[] } {
  const messages: ShimMessage[] = [];
  const parseErrors: string[] = [];

  const lines = stdout.split("\n").filter((line) => line.trim() !== "");

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      messages.push(parsed as ShimMessage);
    } catch {
      parseErrors.push(line);
    }
  }

  return { messages, parseErrors };
}

/**
 * Get all text content from an assistant message
 */
export function getAssistantText(message: AssistantMessage): string {
  const content = message.message.content;
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Get all text from all assistant messages
 */
export function getAllAssistantText(messages: ShimMessage[]): string {
  return messages
    .filter((m): m is AssistantMessage => m.type === "assistant")
    .map(getAssistantText)
    .join("\n");
}

/**
 * Get the system init message
 */
export function getSystemMessage(messages: ShimMessage[]): SystemMessage | undefined {
  return messages.find((m): m is SystemMessage => m.type === "system" && m.subtype === "init");
}

/**
 * Get the result message
 */
export function getResultMessage(messages: ShimMessage[]): ResultMessage | undefined {
  return messages.find((m): m is ResultMessage => m.type === "result");
}

/**
 * Get all tool use content blocks from assistant messages
 */
export function getToolUseCalls(messages: ShimMessage[]): ToolUseContent[] {
  const toolCalls: ToolUseContent[] = [];

  for (const msg of messages) {
    if (msg.type === "assistant") {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use") {
            toolCalls.push(block);
          }
        }
      }
    }
  }

  return toolCalls;
}

/**
 * Get all tool results from user messages
 */
export function getToolResults(messages: ShimMessage[]): ToolResultContent[] {
  const results: ToolResultContent[] = [];

  for (const msg of messages) {
    if (msg.type === "user") {
      for (const content of msg.message.content) {
        if (content.type === "tool_result") {
          results.push(content);
        }
      }
    }
  }

  return results;
}

/**
 * Check if all tool_use have matching tool_result
 */
export function checkToolPairing(
  messages: ShimMessage[]
): { paired: boolean; orphanToolUseIds: string[]; orphanToolResultIds: string[] } {
  const toolUses = getToolUseCalls(messages);
  const toolResults = getToolResults(messages);

  const toolUseIds = new Set(toolUses.map((t) => t.id));
  const toolResultIds = new Set(toolResults.map((t) => t.tool_use_id));

  const orphanToolUseIds = [...toolUseIds].filter((id) => !toolResultIds.has(id));
  const orphanToolResultIds = [...toolResultIds].filter((id) => !toolUseIds.has(id));

  return {
    paired: orphanToolUseIds.length === 0 && orphanToolResultIds.length === 0,
    orphanToolUseIds,
    orphanToolResultIds,
  };
}

/**
 * Count messages by type
 */
export function countMessageTypes(messages: ShimMessage[]): Record<string, number> {
  const counts: Record<string, number> = {
    system: 0,
    assistant: 0,
    user: 0,
    result: 0,
  };

  for (const msg of messages) {
    counts[msg.type] = (counts[msg.type] || 0) + 1;
  }

  return counts;
}

/**
 * Get unique tool names used in the conversation
 */
export function getUniqueToolNames(messages: ShimMessage[]): string[] {
  const names = new Set<string>();
  for (const toolUse of getToolUseCalls(messages)) {
    names.add(toolUse.name);
  }
  return [...names];
}

/**
 * Get all tool names used in the conversation (including duplicates)
 */
export function getToolNames(messages: ShimMessage[]): string[] {
  return getToolUseCalls(messages).map(t => t.name);
}

