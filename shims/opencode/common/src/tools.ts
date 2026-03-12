/**
 * Standard tool names and constants
 */

export const STANDARD_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS"] as const;

export type StandardToolName = (typeof STANDARD_TOOLS)[number];

export interface ToolMapping {
  [key: string]: StandardToolName;
}
