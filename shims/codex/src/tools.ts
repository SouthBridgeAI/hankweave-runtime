import type {
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadItem,
  WebSearchItem,
} from "@openai/codex-sdk";
import { topLevelCamelToSnake, toRelativePath } from "./utils.js";

export interface NormalizedToolUse {
  name: string;
  input?: Record<string, unknown>;
}

export interface NormalizedToolResult {
  isError: boolean;
  content: string | { is_error: true; error: string };
}

export function normalizeToolUse(item: ThreadItem, cwd: string): NormalizedToolUse | null {
  switch (item.type) {
    case "command_execution":
      return normalizeCommandExecution(item);
    case "file_change":
      return normalizeFileChange(item, cwd);
    case "mcp_tool_call":
      return normalizeMcpToolCall(item);
    case "web_search":
      return normalizeWebSearch(item);
    default:
      return null;
  }
}

export function normalizeToolResult(item: ThreadItem, cwd: string): NormalizedToolResult | null {
  switch (item.type) {
    case "command_execution":
      return normalizeCommandExecutionResult(item);
    case "file_change":
      return normalizeFileChangeResult(item, cwd);
    case "mcp_tool_call":
      return normalizeMcpToolCallResult(item);
    case "web_search":
      return {
        isError: false,
        content: `Web search completed for query: ${item.query}`,
      };
    default:
      return null;
  }
}

function normalizeCommandExecution(item: CommandExecutionItem): NormalizedToolUse {
  const innerCommand = extractInnerCommand(item.command);
  const simpleWrite = parseSimpleShellWrite(innerCommand);

  if (simpleWrite) {
    return {
      name: "Write",
      input: {
        file_path: simpleWrite.filePath,
        content: simpleWrite.content,
      },
    };
  }

  const readMatch = innerCommand.match(/^cat\s+([^\s;&|]+)$/);
  if (readMatch) {
    return {
      name: "Read",
      input: { file_path: stripQuotes(readMatch[1]) },
    };
  }

  const lsMatch = innerCommand.match(/^ls(?:\s+(-[A-Za-z-]+))*?(?:\s+([^;&|]+))?$/);
  if (lsMatch) {
    const target = lsMatch[2]?.trim();
    return {
      name: "LS",
      input: target ? { path: stripQuotes(target) } : undefined,
    };
  }

  const grepMatch = innerCommand.match(/^(?:rg|grep)\b(.*)$/);
  if (grepMatch) {
    return {
      name: "Grep",
      input: { command: innerCommand },
    };
  }

  const globMatch = innerCommand.match(/^(?:find|fd)\b(.*)$/);
  if (globMatch) {
    return {
      name: "Glob",
      input: { command: innerCommand },
    };
  }

  return {
    name: "Bash",
    input: { command: innerCommand },
  };
}

function normalizeCommandExecutionResult(item: CommandExecutionItem): NormalizedToolResult {
  const output = item.aggregated_output;
  const innerCommand = extractInnerCommand(item.command);
  const simpleWrite = parseSimpleShellWrite(innerCommand);

  if (item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0)) {
    return {
      isError: true,
      content: {
        is_error: true,
        error: output.trim() || `Command failed with exit code ${item.exit_code ?? "unknown"}`,
      },
    };
  }

  if (output.trim().length > 0) {
    return {
      isError: false,
      content: output,
    };
  }

  if (simpleWrite) {
    return {
      isError: false,
      content: `Wrote ${simpleWrite.filePath}`,
    };
  }

  return {
    isError: false,
    content: `Command completed with exit code ${item.exit_code ?? 0} (no output).`,
  };
}

function normalizeFileChange(item: FileChangeItem, cwd: string): NormalizedToolUse {
  const paths = item.changes.map((change) => toRelativePath(change.path, cwd));
  const allAdds = item.changes.every((change) => change.kind === "add");

  return {
    name: allAdds ? "Write" : "Edit",
    input:
      paths.length === 1
        ? { file_path: paths[0] }
        : { paths },
  };
}

function normalizeFileChangeResult(item: FileChangeItem, cwd: string): NormalizedToolResult {
  const summary = item.changes
    .map((change) => `${change.kind} ${toRelativePath(change.path, cwd)}`)
    .join(", ");

  if (item.status === "failed") {
    return {
      isError: true,
      content: {
        is_error: true,
        error: summary || "File change failed",
      },
    };
  }

  return {
    isError: false,
    content: summary ? `Applied file change: ${summary}` : "Applied file change.",
  };
}

function normalizeMcpToolCall(item: McpToolCallItem): NormalizedToolUse {
  const lowerServer = item.server.toLowerCase();
  const lowerTool = item.tool.toLowerCase();

  if (lowerTool.includes("search") || lowerServer.includes("search") || lowerServer.includes("web")) {
    return {
      name: "WebSearch",
      input: topLevelCamelToSnake(item.arguments) ?? { arguments: item.arguments },
    };
  }

  if (lowerTool.includes("fetch") || lowerTool.includes("browse")) {
    return {
      name: "WebFetch",
      input: topLevelCamelToSnake(item.arguments) ?? { arguments: item.arguments },
    };
  }

  return {
    name: `${item.server}:${item.tool}`,
    input: topLevelCamelToSnake(item.arguments) ?? { arguments: item.arguments },
  };
}

function normalizeMcpToolCallResult(item: McpToolCallItem): NormalizedToolResult {
  if (item.status === "failed") {
    return {
      isError: true,
      content: {
        is_error: true,
        error: item.error?.message || "MCP tool call failed",
      },
    };
  }

  const textParts = item.result?.content
    ?.map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      return JSON.stringify(block);
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const combinedText = textParts?.join("\n").trim();

  return {
    isError: false,
    content:
      combinedText ||
      (item.result?.structured_content !== undefined
        ? JSON.stringify(item.result.structured_content)
        : `${item.server}:${item.tool} completed successfully.`),
  };
}

function normalizeWebSearch(item: WebSearchItem): NormalizedToolUse {
  return {
    name: "WebSearch",
    input: { query: item.query },
  };
}

export function shouldTreatAsToolItem(item: ThreadItem): boolean {
  return (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "mcp_tool_call" ||
    item.type === "web_search"
  );
}

function extractInnerCommand(command: string): string {
  const trimmed = command.trim();
  const zshMatch = trimmed.match(/-lc\s+([\s\S]+)$/);
  const shellCommand = zshMatch ? stripQuotes(zshMatch[1].trim()) : trimmed;
  return stripLeadingCdPrefix(shellCommand);
}

function stripLeadingCdPrefix(command: string): string {
  const match = command.match(/^cd\s+(.+?)\s*&&\s*([\s\S]+)$/);
  if (!match) {
    return command;
  }

  return match[2].trim();
}

function parseSimpleShellWrite(command: string): { filePath: string; content: string } | null {
  return parseHereDocShellWrite(command) ?? parseRedirectShellWrite(command);
}

function parseHereDocShellWrite(command: string): { filePath: string; content: string } | null {
  const redirectFirst = command.match(
    /^cat\s*>\s*("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'|[^\s;&|]+)\s*<<['"]?([A-Za-z0-9_-]+)['"]?\n([\s\S]*?)\n\2$/,
  );
  if (redirectFirst) {
    const [, rawFilePath, , body] = redirectFirst;
    return {
      filePath: stripQuotes(rawFilePath.trim()),
      content: `${body}\n`,
    };
  }

  const heredocFirst = command.match(
    /^cat\s*<<['"]?([A-Za-z0-9_-]+)['"]?\s*>\s*("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'|[^\s;&|]+)\n([\s\S]*?)\n\1$/,
  );
  if (heredocFirst) {
    const [, , rawFilePath, body] = heredocFirst;
    return {
      filePath: stripQuotes(rawFilePath.trim()),
      content: `${body}\n`,
    };
  }

  return null;
}

function parseRedirectShellWrite(command: string): { filePath: string; content: string } | null {
  const match = command.match(
    /^(printf|echo)(?:\s+(-n))?\s+([\s\S]+?)\s*>\s*("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'|[^\s;&|]+)$/,
  );
  if (!match) {
    return null;
  }

  const [, commandName, noNewlineFlag, rawContent, rawFilePath] = match;
  const parsedContent = parseSimpleShellTextLiteral(rawContent.trim());
  if (parsedContent === undefined) {
    return null;
  }

  const content =
    commandName === "printf"
      ? decodePrintfEscapes(parsedContent)
      : noNewlineFlag === "-n"
        ? parsedContent
        : `${parsedContent}\n`;

  return {
    filePath: stripQuotes(rawFilePath.trim()),
    content,
  };
}

function parseSimpleShellTextLiteral(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return stripQuotes(trimmed);
  }

  if (/^[^\s;&|<>]+$/.test(trimmed)) {
    return trimmed;
  }

  return undefined;
}

function decodePrintfEscapes(value: string): string {
  return value
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
