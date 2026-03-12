export function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

export function topLevelSnakeCase(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[camelToSnake(key)] = value;
  }
  return output;
}

const TOOL_NAME_MAP = new Map<string, string>([
  ["read_file", "Read"],
  ["readfile", "Read"],
  ["write_file", "Write"],
  ["writefile", "Write"],
  ["replace", "Edit"],
  ["edit", "Edit"],
  ["run_shell_command", "Bash"],
  ["shell", "Bash"],
  ["bash", "Bash"],
  ["glob", "Glob"],
  ["search_file_content", "Grep"],
  ["grep", "Grep"],
  ["list_directory", "LS"],
  ["ls", "LS"],
]);

export function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP.get(name.toLowerCase()) ?? name;
}

export function normalizeToolInput(
  name: string,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const snake = topLevelSnakeCase(input);
  if (!snake) return undefined;

  switch (name) {
    case "Read": {
      const filePath = snake.file_path ?? snake.path;
      const result: Record<string, unknown> = {};
      if (filePath !== undefined) result.file_path = filePath;
      if (snake.offset !== undefined) result.offset = snake.offset;
      if (snake.limit !== undefined) result.limit = snake.limit;
      return result;
    }
    case "Write": {
      const filePath = snake.file_path ?? snake.path;
      const result: Record<string, unknown> = {};
      if (filePath !== undefined) result.file_path = filePath;
      if (snake.content !== undefined) result.content = snake.content;
      return result;
    }
    case "Edit":
      return snake;
    case "Bash":
      return {
        command: snake.command,
        ...(snake.description !== undefined ? { description: snake.description } : {}),
        ...(snake.directory !== undefined ? { directory: snake.directory } : {}),
      };
    case "Glob": {
      const out: Record<string, unknown> = {};
      if (snake.pattern !== undefined) out.pattern = snake.pattern;
      if (snake.path !== undefined) out.path = snake.path;
      if (snake.case_sensitive !== undefined) out.case_sensitive = snake.case_sensitive;
      if (snake.respect_git_ignore !== undefined) out.respect_git_ignore = snake.respect_git_ignore;
      return out;
    }
    case "Grep": {
      const out: Record<string, unknown> = {};
      if (snake.pattern !== undefined) out.pattern = snake.pattern;
      if (snake.path !== undefined) out.path = snake.path;
      if (snake.include !== undefined) out.glob = snake.include;
      return out;
    }
    case "LS": {
      const out: Record<string, unknown> = {};
      if (snake.path !== undefined) out.path = snake.path;
      if (snake.ignore !== undefined) out.ignore = snake.ignore;
      if (snake.respect_git_ignore !== undefined) out.respect_git_ignore = snake.respect_git_ignore;
      return out;
    }
    default:
      return snake;
  }
}

export function extractToolFilePath(input: Record<string, unknown> | undefined): string | undefined {
  const candidate = input?.file_path ?? input?.path;
  return typeof candidate === "string" ? candidate : undefined;
}
