import fs from "node:fs";
import path from "node:path";
import type { PromptFrontmatter } from "./prompt-frontmatter.js";
import type { Codon } from "./types/types.js";
import type { Logger } from "./utils.js";

/**
 * Handles all prompt-related functionality for process managers.
 * Builds system prompts, user prompts, parses frontmatter, and applies template replacements.
 */
export class PromptBuilder {
  private lastFrontmatter?: PromptFrontmatter;

  constructor(
    private executionPath: string,
    private logger: Logger,
    private globalSystemPrompt?: string | null,
  ) {}

  /**
   * Build system prompt from global prompt and/or codon-specific prompt.
   * Global prompt is prepended, then codon-specific prompt follows.
   *
   * @returns Combined system prompt with template replacements applied, or null if no prompts configured
   */
  buildSystemPrompt(codon: Codon): string | null {
    const parts: string[] = [];

    // Add global system prompt first (if configured)
    if (this.globalSystemPrompt) {
      parts.push(this.globalSystemPrompt);
    }

    // Add codon-specific system prompt
    if (codon.appendSystemPromptFile) {
      const files = Array.isArray(codon.appendSystemPromptFile)
        ? codon.appendSystemPromptFile
        : [codon.appendSystemPromptFile];

      for (const file of files) {
        parts.push(fs.readFileSync(file, "utf-8"));
      }
    } else if (codon.appendSystemPromptText) {
      parts.push(codon.appendSystemPromptText);
    }

    if (parts.length === 0) {
      return null;
    }

    // Join and apply template variable replacements
    const content = parts.join("\n\n");
    return this.applyTemplateReplacements(content);
  }

  /**
   * Build prompt content from file or text.
   * Parses and strips frontmatter from markdown files.
   * Stores frontmatter metadata for later retrieval via getLastFrontmatter().
   *
   * @returns Prompt content with template replacements applied and optional frontmatter metadata
   */
  buildPromptContent(codon: Codon): {
    content: string;
    frontmatter?: PromptFrontmatter;
  } {
    const { parsePromptFrontmatter } = require("./prompt-frontmatter.js");
    let promptContent: string;
    let firstFileFrontmatter: PromptFrontmatter | undefined;

    if (codon.promptFile) {
      const files = Array.isArray(codon.promptFile) ? codon.promptFile : [codon.promptFile];
      const parts: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const rawContent = fs.readFileSync(files[i], "utf-8");
        const parsed = parsePromptFrontmatter(rawContent);
        parts.push(parsed.content);
        // Only use frontmatter from first file
        if (i === 0 && parsed.hasFrontmatter) {
          firstFileFrontmatter = parsed.frontmatter;
        }
      }
      promptContent = parts.join("\n\n");
    } else if (codon.promptText) {
      promptContent = codon.promptText;
    } else {
      throw new Error("No prompt file or text provided");
    }

    const processedContent = this.applyTemplateReplacements(promptContent);

    // Store frontmatter for later retrieval
    if (firstFileFrontmatter) {
      this.lastFrontmatter = firstFileFrontmatter;
      this.logger.log(`Prompt frontmatter: ${JSON.stringify(firstFileFrontmatter)}`);
    } else {
      this.lastFrontmatter = undefined;
    }

    return { content: processedContent, frontmatter: firstFileFrontmatter };
  }

  /**
   * Get frontmatter metadata from the last built prompt.
   * Returns undefined if no frontmatter was present or no prompt has been built yet.
   */
  getLastFrontmatter(): PromptFrontmatter | undefined {
    return this.lastFrontmatter;
  }

  /**
   * Apply template variable replacements to content.
   * Supports: <%PROJECT_DIR%>, <%EXECUTION_DIR%>, <%DATA_DIR%>
   */
  private applyTemplateReplacements(content: string): string {
    return content
      .replace(/<%PROJECT_DIR%>/g, this.executionPath) // Legacy support
      .replace(/<%EXECUTION_DIR%>/g, this.executionPath)
      .replace(/<%DATA_DIR%>/g, path.join(this.executionPath, "read_only_data_source"));
  }
}
