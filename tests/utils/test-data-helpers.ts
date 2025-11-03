// Utilities for test data parsing and validation

// ============================================================================
// JSONL Parsing
// ============================================================================

// Types for Claude JSONL log entries
export interface ClaudeLogEntry {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
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

// ============================================================================
// Cost Calculation
// ============================================================================

export interface UsageData {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

// Standardized token usage interface
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

// Pricing by model
const COSTS_PER_MTOK = {
  sonnet: {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  opus: {
    input: 15.0,
    output: 75.0,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },
} as const;

/**
 * Calculate cost from token usage with support for multiple models.
 * @param usage - Token usage data (supports both old format with underscores and new camelCase)
 * @param model - Model to use for pricing (default: "sonnet")
 * @returns Total cost in USD
 */
export function calculateCostFromUsage(
  usage: UsageData | TokenUsage,
  model: "sonnet" | "opus" = "sonnet",
): number {
  const costs = COSTS_PER_MTOK[model];

  // Support both formats (old with underscores, new with camelCase)
  const inputTokens = "inputTokens" in usage ? usage.inputTokens : usage.input_tokens || 0;
  const outputTokens = "outputTokens" in usage ? usage.outputTokens : usage.output_tokens || 0;
  const cacheCreationTokens =
    "cacheCreationTokens" in usage
      ? usage.cacheCreationTokens
      : usage.cache_creation_input_tokens || 0;
  const cacheReadTokens =
    "cacheReadTokens" in usage ? usage.cacheReadTokens : usage.cache_read_input_tokens || 0;

  return (
    (inputTokens * costs.input) / 1_000_000 +
    (outputTokens * costs.output) / 1_000_000 +
    (cacheCreationTokens * costs.cacheWrite) / 1_000_000 +
    (cacheReadTokens * costs.cacheRead) / 1_000_000
  );
}

// ============================================================================
// File Tree Navigation
// ============================================================================

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
