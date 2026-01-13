/**
 * Simple frontmatter parser for prompt markdown files.
 *
 * Frontmatter is ONLY for metadata/labeling (not configuration).
 * Allowed fields: name, description, tags, version, author
 *
 * Example:
 * ---
 * name: Code Analyzer
 * description: Analyzes code for patterns
 * tags: [analysis, code-review]
 * version: 1.0.0
 * author: Team Name
 * ---
 */

import { z } from "zod";

/**
 * Schema for allowed frontmatter fields.
 * Strict validation - rejects unknown fields.
 */
export const promptFrontmatterSchema = z
  .object({
    name: z.string().optional().describe("Display name for the prompt"),
    description: z.string().optional().describe("What this prompt does"),
    tags: z.array(z.string()).optional().describe("For categorization"),
    version: z.string().optional().describe("Prompt version"),
    author: z.string().optional().describe("Who wrote the prompt"),
  })
  .strict();

export type PromptFrontmatter = z.infer<typeof promptFrontmatterSchema>;

export interface ParsedPrompt {
  /** The prompt content without frontmatter */
  content: string;
  /** Parsed frontmatter metadata (undefined if no frontmatter) */
  frontmatter?: PromptFrontmatter;
  /** Whether the file had frontmatter */
  hasFrontmatter: boolean;
}

/**
 * Parse a simple YAML frontmatter value.
 * Handles strings, numbers, arrays (inline only).
 */
function parseYamlValue(value: string): string | string[] | undefined {
  const trimmed = value.trim();

  // Handle inline arrays: [item1, item2]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    if (!inner.trim()) return [];
    return inner.split(",").map((item) => {
      const cleaned = item.trim();
      // Remove quotes if present
      if (
        (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))
      ) {
        return cleaned.slice(1, -1);
      }
      return cleaned;
    });
  }

  // Handle quoted strings
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed || undefined;
}

/**
 * Parse frontmatter from markdown content.
 * Returns the content without frontmatter and the parsed metadata.
 *
 * @param rawContent - Raw markdown content (may include frontmatter)
 * @returns Parsed prompt with content and optional frontmatter
 * @throws Error if frontmatter has invalid fields
 */
export function parsePromptFrontmatter(rawContent: string): ParsedPrompt {
  // Check if content starts with frontmatter delimiter
  if (!rawContent.startsWith("---")) {
    return {
      content: rawContent,
      hasFrontmatter: false,
    };
  }

  // Find the closing delimiter
  const endDelimiter = rawContent.indexOf("---", 3);
  if (endDelimiter === -1) {
    // No closing delimiter, treat as normal content
    return {
      content: rawContent,
      hasFrontmatter: false,
    };
  }

  // Extract frontmatter section
  const frontmatterRaw = rawContent.slice(3, endDelimiter).trim();
  const content = rawContent.slice(endDelimiter + 3).trim();

  // Parse simple YAML key: value pairs
  const data: Record<string, unknown> = {};
  const lines = frontmatterRaw.split("\n");

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;

    const colonIndex = trimmedLine.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmedLine.slice(0, colonIndex).trim();
    const value = trimmedLine.slice(colonIndex + 1);
    const parsed = parseYamlValue(value);

    if (parsed !== undefined) {
      data[key] = parsed;
    }
  }

  // Validate against schema (strict - rejects unknown fields)
  const result = promptFrontmatterSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      if (issue.code === "unrecognized_keys") {
        const keys = (issue as z.ZodIssue & { keys?: string[] }).keys?.join(", ");
        return `Unknown frontmatter field(s): ${keys}. Allowed fields: name, description, tags, version, author`;
      }
      return `${issue.path.join(".")}: ${issue.message}`;
    });
    throw new Error(`Invalid prompt frontmatter:\n${errors.join("\n")}`);
  }

  return {
    content,
    frontmatter: result.data,
    hasFrontmatter: true,
  };
}

/**
 * Format frontmatter metadata for display.
 */
export function formatFrontmatterForDisplay(frontmatter: PromptFrontmatter): string {
  const parts: string[] = [];

  if (frontmatter.name) {
    parts.push(`📝 ${frontmatter.name}`);
  }

  if (frontmatter.description) {
    parts.push(`   ${frontmatter.description}`);
  }

  if (frontmatter.author) {
    parts.push(`   Author: ${frontmatter.author}`);
  }

  if (frontmatter.version) {
    parts.push(`   Version: ${frontmatter.version}`);
  }

  if (frontmatter.tags && frontmatter.tags.length > 0) {
    parts.push(`   Tags: ${frontmatter.tags.join(", ")}`);
  }

  return parts.join("\n");
}
