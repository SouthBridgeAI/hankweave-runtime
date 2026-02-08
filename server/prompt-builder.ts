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
    private agentRootPath: string,
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
    const processedContent = this.applyTemplateReplacements(content);

    // Strip HTML comments
    const cleanContent = this.stripHtmlComments(processedContent);

    if (cleanContent.length !== processedContent.length) {
      this.logger.log(
        `Stripped HTML comments from system prompt (${processedContent.length} -> ${cleanContent.length} chars)`,
        "debug",
      );
    }

    return cleanContent;
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

    // Strip HTML comments
    const cleanContent = this.stripHtmlComments(processedContent);

    if (cleanContent.length !== processedContent.length) {
      this.logger.log(
        `Stripped HTML comments from prompt (${processedContent.length} -> ${cleanContent.length} chars)`,
        "debug",
      );
    }

    // Store frontmatter for later retrieval
    if (firstFileFrontmatter) {
      this.lastFrontmatter = firstFileFrontmatter;
      this.logger.log(`Prompt frontmatter: ${JSON.stringify(firstFileFrontmatter)}`);
    } else {
      this.lastFrontmatter = undefined;
    }

    return { content: cleanContent, frontmatter: firstFileFrontmatter };
  }

  /**
   * Get frontmatter metadata from the last built prompt.
   * Returns undefined if no frontmatter was present or no prompt has been built yet.
   */
  getLastFrontmatter(): PromptFrontmatter | undefined {
    return this.lastFrontmatter;
  }

  /**
   * Process prompt variables in a string (for exhaustion/extension prompts).
   * Replaces template variables: <%PROJECT_DIR%>, <%EXECUTION_DIR%>, <%DATA_DIR%>
   * Also strips HTML comments.
   *
   * @param prompt - Raw prompt text with template variables
   * @returns Prompt with variables substituted and comments stripped
   */
  public processPromptVariables(prompt: string): string {
    const processed = this.applyTemplateReplacements(prompt);
    return this.stripHtmlComments(processed);
  }

  /**
   * Build prompt content for execution, handling both normal and exhaustion modes.
   * This consolidates the prompt choosing logic used by both managers.
   *
   * @param codon - Codon configuration
   * @param exhaustionPrompt - Optional exhaustion prompt (activates exhaustion mode)
   * @returns Processed prompt content ready for execution
   */
  public buildPromptForExecution(codon: Codon, exhaustionPrompt?: string): string {
    if (exhaustionPrompt) {
      // Exhaustion mode: use the exhaustion prompt directly with variable substitution
      const processed = this.processPromptVariables(exhaustionPrompt);
      this.logger.log(`Exhaustion mode: using prompt (${processed.length} chars)`);
      return processed;
    }

    // Normal mode: build from codon config (strips frontmatter if present)
    const { content } = this.buildPromptContent(codon);
    return content;
  }

  /**
   * Apply template variable replacements to content.
   * All workspace variables resolve to agentRootPath (where agents work).
   *
   * Supports:
   * - <%AGENT_ROOT%>    - Canonical variable for agent workspace (recommended)
   * - <%PROJECT_DIR%>   - Silent alias for AGENT_ROOT
   * - <%EXECUTION_DIR%> - Silent alias for AGENT_ROOT
   * - <%DATA_DIR%>      - Data directory (agentRootPath/read_only_data_source)
   */
  private applyTemplateReplacements(content: string): string {
    return content
      .replace(/<%AGENT_ROOT%>/g, this.agentRootPath)
      .replace(/<%PROJECT_DIR%>/g, this.agentRootPath) // Silent alias
      .replace(/<%EXECUTION_DIR%>/g, this.agentRootPath) // Silent alias
      .replace(/<%DATA_DIR%>/g, path.join(this.agentRootPath, "read_only_data_source"));
  }

  /**
   * Strip HTML comments from content.
   * HTML comments (<!-- ... -->) are removed before sending to the LLM.
   * Also consumes a trailing newline to avoid blank lines accumulating.
   *
   * @param content - Content with potential HTML comments
   * @returns Content with comments stripped
   */
  private stripHtmlComments(content: string): string {
    // Match HTML comments, including multiline, plus optional trailing newline
    return content.replace(/<!--[\s\S]*?-->\r?\n?/g, "");
  }
}
