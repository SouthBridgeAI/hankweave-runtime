// Utilities for test data parsing and validation

// -------------
// JSONL Parsing
// -------------

// Types for Claude JSONL log entries
export interface ClaudeLogEntry {
  type: string;
  subtype?: string;
  session_id?: string;
  message?:
    | string
    | {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        content?: Array<{ type?: string }>;
      };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

export function parseJSONL(content: string): ClaudeLogEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as ClaudeLogEntry;
      } catch {
        return null;
      }
    })
    .filter((item): item is ClaudeLogEntry => item !== null);
}

// -------------
// File Tree Navigation
// -------------

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  lastModified?: string;
  children?: FileNode[];
}

export function findInTree(tree: FileNode[], name: string): FileNode | undefined {
  for (const node of tree) {
    if (node.name === name) return node;
    if (node.children) {
      const found = findInTree(node.children, name);
      if (found) return found;
    }
  }
  return undefined;
}

export function extractPathsFromTree(tree: FileNode[]): string[] {
  const paths: string[] = [];

  function traverse(nodes: FileNode[]) {
    for (const node of nodes) {
      paths.push(node.path);
      if (node.children) {
        traverse(node.children);
      }
    }
  }

  traverse(tree);
  return paths;
}
