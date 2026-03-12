const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  file_read: "Read",
  readfile: "Read",
  write: "Write",
  file_write: "Write",
  writefile: "Write",
  edit: "Edit",
  str_replace_editor: "Edit",
  bash: "Bash",
  shell: "Bash",
  execute_bash: "Bash",
  glob: "Glob",
  find_files: "Glob",
  grep: "Grep",
  search_files: "Grep",
  ls: "LS",
  list: "LS",
  list_directory: "LS",
};

export function normalizeToolName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) {
    return "Tool";
  }

  const trimmed = name.trim();
  const normalizedKey = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  return TOOL_NAME_MAP[normalizedKey] ?? trimmed;
}

export function camelToSnakeKey(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeToolInput(toolName: string, input: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    normalized[camelToSnakeKey(key)] = value;
  }

  switch (toolName) {
    case "Bash": {
      if (typeof normalized.command === "string") {
        return { command: normalized.command };
      }
      return normalized;
    }
    case "Read": {
      if (typeof normalized.file_path === "string") {
        return { file_path: normalized.file_path };
      }
      return normalized;
    }
    case "Write": {
      const result: Record<string, unknown> = {};
      if (typeof normalized.file_path === "string") result.file_path = normalized.file_path;
      if (typeof normalized.content === "string") result.content = normalized.content;
      return Object.keys(result).length > 0 ? result : normalized;
    }
    case "Edit": {
      const result: Record<string, unknown> = {};
      if (typeof normalized.file_path === "string") result.file_path = normalized.file_path;
      if (typeof normalized.old_string === "string") result.old_string = normalized.old_string;
      if (typeof normalized.new_string === "string") result.new_string = normalized.new_string;
      return Object.keys(result).length > 0 ? result : normalized;
    }
    default:
      return normalized;
  }
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value);
}

export function extractToolResultContent(toolName: string, state: Record<string, unknown>): string | { is_error: true; error: string } {
  const rawOutput = stringifyToolOutput(state.output);
  const metadata = isRecord(state.metadata) ? state.metadata : undefined;
  const input = isRecord(state.input) ? state.input : undefined;
  const exitCode = typeof metadata?.exit === "number" ? metadata.exit : undefined;
  const status = typeof state.status === "string" ? state.status : undefined;

  if (status === "error") {
    const errorText = rawOutput || stringifyToolOutput(metadata?.error) || `${toolName} failed`;
    return { is_error: true, error: errorText };
  }

  if (toolName === "Bash" && exitCode !== undefined && exitCode !== 0) {
    const detail = rawOutput.trim();
    return {
      is_error: true,
      error: detail ? `Exit code ${exitCode}: ${detail}` : `Exit code ${exitCode}`,
    };
  }

  if (rawOutput.length > 0) {
    return rawOutput;
  }

  if (toolName === "Write" && typeof input?.filePath === "string") {
    return `File written: ${String(input.filePath)}`;
  }

  if (toolName === "Write" && typeof input?.file_path === "string") {
    return `File written: ${String(input.file_path)}`;
  }

  if (toolName === "Read") {
    const filePath = typeof input?.filePath === "string" ? input.filePath : input?.file_path;
    if (typeof filePath === "string") {
      return `Read file: ${filePath}`;
    }
  }

  if (toolName === "Bash") {
    return exitCode === 0 || exitCode === undefined
      ? "Command completed successfully with no output."
      : `Exit code ${exitCode}`;
  }

  if (typeof state.title === "string" && state.title) {
    return state.title;
  }

  return `${toolName} completed.`;
}
