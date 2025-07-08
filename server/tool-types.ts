/**
 * Strongly typed tool input definitions for Claude tools.
 * These match the expected input schemas for each tool.
 */

export interface WriteToolInput {
  file_path: string;
  content: string;
}

export interface ReadToolInput {
  file_path: string;
}

export interface EditToolInput {
  file_path: string;
  old_str: string;
  new_str: string;
  view_range?: [number, number];
}

export interface MultiEditToolInput {
  file_path: string;
  edits: Array<{
    old_str: string;
    new_str: string;
    view_range?: [number, number];
  }>;
}

export interface LSToolInput {
  path: string;
}

export interface GlobToolInput {
  pattern: string;
}

export interface GrepToolInput {
  pattern: string;
  path?: string;
}

export interface BashToolInput {
  command: string;
  description?: string;
}

export interface TaskToolInput {
  title: string;
  description?: string;
}

export interface NotebookReadToolInput {
  path: string;
}

export interface NotebookEditToolInput {
  path: string;
  cell_index: number;
  new_content: string;
}

export interface WebFetchToolInput {
  url: string;
}

export interface WebSearchToolInput {
  query: string;
}

export interface TodoWriteToolInput {
  content: string;
}

export type ToolInputMap = {
  Write: WriteToolInput;
  Read: ReadToolInput;
  Edit: EditToolInput;
  MultiEdit: MultiEditToolInput;
  LS: LSToolInput;
  Glob: GlobToolInput;
  Grep: GrepToolInput;
  Bash: BashToolInput;
  Task: TaskToolInput;
  NotebookRead: NotebookReadToolInput;
  NotebookEdit: NotebookEditToolInput;
  WebFetch: WebFetchToolInput;
  WebSearch: WebSearchToolInput;
  TodoWrite: TodoWriteToolInput;
  exit_plan_mode: Record<string, never>; // No input
};

export type ToolName = keyof ToolInputMap;

/**
 * Type guard to check if a tool name is valid
 */
export function isValidToolName(name: string): name is ToolName {
  return (
    name in
    ({
      Write: true,
      Read: true,
      Edit: true,
      MultiEdit: true,
      LS: true,
      Glob: true,
      Grep: true,
      Bash: true,
      Task: true,
      NotebookRead: true,
      NotebookEdit: true,
      WebFetch: true,
      WebSearch: true,
      TodoWrite: true,
      exit_plan_mode: true,
    } as Record<ToolName, true>)
  );
}
