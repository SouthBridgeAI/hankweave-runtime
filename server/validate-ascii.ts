// server/validate-ascii.ts
// ASCII art visualization for hank structure

import type { Codon, CodonConfig, HankMeta, Loop, RigSetupItem } from "./config.js";

// Unicode symbols for tree drawing
const SYMBOLS = {
  // Tree structure
  branch: "├",
  corner: "└",
  pipe: "│",
  dash: "─",
  dot: "•",

  // Rounded corners for boxes
  roundTopLeft: "╭",
  roundTopRight: "╮",
  roundBottomLeft: "╰",
  roundBottomRight: "╯",

  // Flow indicators
  arrowDown: "↓",
};

// ANSI color codes for terminal output
const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

export interface RenderOptions {
  /** Terminal width to render for. Default: 80. Minimum: 40. */
  terminalWidth?: number;
  /** Enable color output. Default: auto-detect from process.stdout.isTTY */
  useColor?: boolean;
  /** Hank metadata for header display. */
  hankMeta?: HankMeta;
  /** Global system prompt presence indicator. */
  hasGlobalSystemPrompt?: boolean;
  /** Config path for relativizing absolute paths in output. */
  configPath?: string;
  /** Map of codon ID to prompt line count (sum of all prompt files) */
  promptLineCounts?: Map<string, number>;
}

// Helper: Truncate string with ellipsis at end
function truncateEnd(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  if (maxLength < 4) return str.slice(0, maxLength);
  return `${str.slice(0, maxLength - 3)}...`;
}

// Helper: Extract a short slug from a model ID
// e.g., "claude-3-5-sonnet-20241022" -> "sonnet"
// e.g., "gemini-1.5-pro-latest" -> "gemini-1.5-pro"
function extractModelSlug(modelId: string): string {
  const lower = modelId.toLowerCase();

  // Check for known Anthropic model families
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";

  // For other models, try to extract a meaningful short name
  // Remove date suffixes like -20241022, -latest, etc.
  const cleaned = modelId.replace(/-\d{8}$/, "").replace(/-latest$/, "");

  // If it's still reasonably short, use it
  if (cleaned.length <= 20) return cleaned;

  // Otherwise take the last meaningful part
  const parts = cleaned.split(/[-/]/);
  return parts[parts.length - 1] || modelId;
}

// Helper: Count total codons (including inside loops)
function countCodons(configs: CodonConfig[]): number {
  let count = 0;
  for (const config of configs) {
    if (config.type === "loop") {
      count += config.codons.length;
    } else {
      count += 1;
    }
  }
  return count;
}

// Helper: Count loops
function countLoops(configs: CodonConfig[]): number {
  return configs.filter((c) => c.type === "loop").length;
}

// Helper: Strip ANSI codes for length calculation
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Required for ANSI escape sequence detection
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// Render the header box with rounded corners
function renderHeader(
  meta: HankMeta | undefined,
  codons: CodonConfig[],
  hasGlobalSystemPrompt: boolean,
  width: number,
  useColor: boolean,
): string[] {
  const lines: string[] = [];
  const name = meta?.name || "Hank";
  const version = meta?.version ? ` v${meta.version}` : "";

  const codonCount = countCodons(codons);
  const loopCount = countLoops(codons);

  // Box structure with rounded corners
  const innerWidth = Math.max(width - 4, 20);

  const titleLine = `${name}${version}`;
  const statsLine = `${codonCount} codon${codonCount !== 1 ? "s" : ""} ${SYMBOLS.dot} ${loopCount} loop${loopCount !== 1 ? "s" : ""}${hasGlobalSystemPrompt ? ` ${SYMBOLS.dot} global system prompt` : ""}`;

  // Apply colors if enabled
  const borderColor = useColor ? COLORS.cyan : "";
  const titleColor = useColor ? COLORS.cyan + COLORS.bold : "";
  const statsColor = useColor ? COLORS.dim : "";
  const reset = useColor ? COLORS.reset : "";

  lines.push(
    `${borderColor}${SYMBOLS.roundTopLeft}${SYMBOLS.dash.repeat(innerWidth + 2)}${SYMBOLS.roundTopRight}${reset}`,
  );
  lines.push(
    `${borderColor}${SYMBOLS.pipe}${reset}  ${titleColor}${truncateEnd(titleLine, innerWidth).padEnd(innerWidth)}${reset}${borderColor}${SYMBOLS.pipe}${reset}`,
  );
  lines.push(
    `${borderColor}${SYMBOLS.pipe}${reset}  ${statsColor}${truncateEnd(statsLine, innerWidth).padEnd(innerWidth)}${reset}${borderColor}${SYMBOLS.pipe}${reset}`,
  );
  lines.push(
    `${borderColor}${SYMBOLS.roundBottomLeft}${SYMBOLS.dash.repeat(innerWidth + 2)}${SYMBOLS.roundBottomRight}${reset}`,
  );

  return lines;
}

// Helper: Format a rig setup item as a short description
function formatRigItem(item: RigSetupItem, maxLength: number): string {
  if (item.type === "copy" && item.copy) {
    const desc = `copy: ${item.copy.from} → ${item.copy.to}`;
    return truncateEnd(desc, maxLength);
  } else if (item.type === "command" && item.command) {
    const cmd = item.command.run;
    const desc = `cmd: ${cmd}`;
    return truncateEnd(desc, maxLength);
  }
  return "unknown rig";
}

// Codon detail fields with priority (higher = more important, shown first)
interface DetailField {
  key: string;
  value: string;
  priority: number; // Higher = more important
  coloredValue?: string; // Pre-colored version for color mode
}

// Format codon details as multiple lines (up to 3)
// Returns array of lines, each fitting within maxWidth
function formatCodonDetails(
  codon: Codon,
  maxWidth: number,
  useColor: boolean,
  promptLineCount?: number,
): string[] {
  const fields: DetailField[] = [];

  // Model (highest priority) - show slug + friendly name
  const slug = extractModelSlug(codon.model.modelId);
  const friendlyName = codon.model.name;
  // If friendly name is different and informative, show both
  const modelDisplay =
    friendlyName && !friendlyName.toLowerCase().includes(slug.toLowerCase())
      ? `${slug} (${friendlyName})`
      : slug;
  const coloredModel = useColor ? `${COLORS.green}${modelDisplay}${COLORS.reset}` : modelDisplay;
  fields.push({
    key: "model",
    value: modelDisplay,
    priority: 100,
    coloredValue: coloredModel,
  });

  // Continuation mode (high priority)
  const modeValue = codon.continuationMode === "fresh" ? "fresh" : "continue";
  fields.push({ key: "mode", value: modeValue, priority: 90 });

  // Prompt info (high priority)
  if (codon.promptFile) {
    const count = Array.isArray(codon.promptFile) ? codon.promptFile.length : 1;
    const lineInfo = promptLineCount ? ` (${promptLineCount} lines)` : "";
    fields.push({
      key: "prompts",
      value: `${count}${lineInfo}`,
      priority: 80,
    });
  } else if (codon.promptText) {
    const inlineLines = codon.promptText.split("\n").length;
    fields.push({
      key: "prompt",
      value: `inline (${inlineLines} lines)`,
      priority: 80,
    });
  }

  // Checkpointed files (medium priority)
  if (codon.checkpointedFiles?.length) {
    fields.push({
      key: "checkpointedGlobs",
      value: String(codon.checkpointedFiles.length),
      priority: 60,
    });
  }

  // Sentinels (medium priority)
  if (codon.sentinels?.length) {
    fields.push({
      key: "sentinels",
      value: String(codon.sentinels.length),
      priority: 50,
    });
  }

  // Rigs are handled separately (shown on additional lines)
  // We don't add them to fields here

  // Sort by priority (highest first)
  fields.sort((a, b) => b.priority - a.priority);

  // Build lines with graceful wrapping
  const separator = useColor ? ` ${COLORS.dim}│${COLORS.reset} ` : " │ ";
  const separatorLen = 3; // " │ " visible length

  const lines: string[] = [];
  let currentLine: string[] = [];
  let currentLineLen = 0;

  for (const field of fields) {
    const fieldText = `${field.key}: ${field.coloredValue || field.value}`;
    const fieldVisibleLen = stripAnsi(fieldText).length;

    // Check if this field fits on current line
    const neededLen =
      currentLine.length > 0 ? currentLineLen + separatorLen + fieldVisibleLen : fieldVisibleLen;

    if (neededLen <= maxWidth) {
      // Fits on current line
      currentLine.push(fieldText);
      currentLineLen =
        currentLine.length > 0 ? currentLineLen + separatorLen + fieldVisibleLen : fieldVisibleLen;
    } else if (lines.length < 2) {
      // Start a new line (we allow up to 3 lines)
      if (currentLine.length > 0) {
        lines.push(currentLine.join(separator));
      }
      currentLine = [fieldText];
      currentLineLen = fieldVisibleLen;
    }
    // If we're at 3 lines and it doesn't fit, just drop the field
  }

  // Push any remaining fields
  if (currentLine.length > 0) {
    lines.push(currentLine.join(separator));
  }

  // Add rig commands on separate lines (if present)
  if (codon.rigSetup?.length) {
    const rigColor = useColor ? COLORS.magenta : "";
    const reset = useColor ? COLORS.reset : "";

    // Show each rig on its own line, truncated if needed
    // First rig gets the "rigs:" header, subsequent rigs get indentation
    let rigIndex = 0;
    for (const rig of codon.rigSetup) {
      if (lines.length >= 3) break; // Max 3 lines total

      const rigDesc = formatRigItem(rig, maxWidth - 8); // Leave room for header/indent
      const coloredDesc = useColor ? `${COLORS.dim}${rigDesc}${COLORS.reset}` : rigDesc;

      if (rigIndex === 0) {
        // First rig: add header
        lines.push(`${rigColor}rigs:${reset} ${coloredDesc}`);
      } else {
        // Subsequent rigs: indent to align with first rig's content
        lines.push(`      ${coloredDesc}`);
      }
      rigIndex++;
    }
  }

  return lines.length > 0 ? lines : ["(no details)"];
}

// Format loop termination condition
function formatLoopTermination(terminateOn: { type: string; limit?: number }): string {
  if (terminateOn.type === "iterationLimit" && terminateOn.limit) {
    return `× ${terminateOn.limit} iteration${terminateOn.limit !== 1 ? "s" : ""}`;
  } else if (terminateOn.type === "contextExceeded") {
    return "until context exceeded";
  }
  return "";
}

// Render a single codon with given index string (supports hierarchical like "2.1")
function renderCodonWithIndex(
  codon: Codon,
  indexStr: string,
  isLast: boolean,
  indent: string,
  options: RenderOptions & { useColor: boolean },
): string[] {
  const lines: string[] = [];
  const width = options.terminalWidth || 80;
  const useColor = options.useColor;
  const prefix = isLast ? `${SYMBOLS.corner}${SYMBOLS.dash}` : `${SYMBOLS.branch}${SYMBOLS.dash}`;
  const continuation = isLast ? "  " : `${SYMBOLS.pipe} `;

  // First line: [index] id (name) - with colors
  const indexPart = useColor ? `${COLORS.bold}[${indexStr}]${COLORS.reset}` : `[${indexStr}]`;
  const namePart = useColor
    ? `${COLORS.bold}${codon.id}${COLORS.reset} (${codon.name})`
    : `${codon.id} (${codon.name})`;
  const prefixColored = useColor ? `${COLORS.dim}${prefix}${COLORS.reset}` : prefix;
  const header = `${prefixColored} ${indexPart} ${namePart}`;

  // Calculate visible length for truncation
  const headerVisible = stripAnsi(header);
  const availableHeaderWidth = width - indent.length;
  if (headerVisible.length > availableHeaderWidth) {
    // Need to truncate the name part
    const truncatedName = truncateEnd(codon.name, availableHeaderWidth - 20);
    const truncatedHeader = `${prefixColored} ${indexPart} ${useColor ? `${COLORS.bold}${codon.id}${COLORS.reset}` : codon.id} (${truncatedName})`;
    lines.push(indent + truncatedHeader);
  } else {
    lines.push(indent + header);
  }

  // Detail lines (now supports multiple lines)
  const detailIndent = `${indent + continuation}    `;
  const availableWidth = width - stripAnsi(detailIndent).length;
  const promptLineCount = options.promptLineCounts?.get(codon.id);
  const detailLines = formatCodonDetails(codon, availableWidth, useColor, promptLineCount);

  for (const detail of detailLines) {
    lines.push(detailIndent + detail);
  }

  return lines;
}

// Render a loop with its nested codons
function renderLoop(
  loop: Loop,
  index: number,
  isLast: boolean,
  indent: string,
  options: RenderOptions & { useColor: boolean },
): string[] {
  const lines: string[] = [];
  const width = options.terminalWidth || 80;
  const useColor = options.useColor;
  const prefix = isLast ? `${SYMBOLS.corner}${SYMBOLS.dash}` : `${SYMBOLS.branch}${SYMBOLS.dash}`;
  const continuation = isLast ? "  " : `${SYMBOLS.pipe} `;

  // Loop header with index: [2] LOOP: name × N iterations
  const termination = formatLoopTermination(loop.terminateOn);
  const loopMarker = useColor
    ? `${COLORS.yellow}[${index}] LOOP:${COLORS.reset}`
    : `[${index}] LOOP:`;
  const prefixColored = useColor ? `${COLORS.dim}${prefix}${COLORS.reset}` : prefix;

  // Calculate available width and truncate if needed
  const headerContent = `${loop.id} (${loop.name}) ${termination}`;
  const headerPrefix = `${prefix} ${stripAnsi(loopMarker)} `;
  const availableWidth = width - indent.length - headerPrefix.length;
  const truncatedContent = truncateEnd(headerContent, availableWidth);
  const header = `${prefixColored} ${loopMarker} ${truncatedContent}`;
  lines.push(indent + header);

  // Loop body box opening (rounded corner)
  const boxIndent = indent + continuation;
  const boxWidth = Math.min(60, width - stripAnsi(boxIndent).length - 2);
  const boxColor = useColor ? COLORS.yellow : "";
  const reset = useColor ? COLORS.reset : "";

  lines.push(
    `${boxIndent}${boxColor}${SYMBOLS.roundTopLeft}${SYMBOLS.dash.repeat(boxWidth)}${reset}`,
  );
  lines.push(`${boxIndent}${boxColor}${SYMBOLS.pipe}${reset}`);

  // Nested codons with hierarchical numbering (parent.child)
  loop.codons.forEach((codon, i) => {
    const isLastNested = i === loop.codons.length - 1;
    const nestedIndent = boxIndent;
    // Hierarchical index: e.g., [2.1], [2.2] for children of loop [2]
    const hierarchicalIndex = `${index}.${i + 1}`;
    const nestedLines = renderCodonWithIndex(
      codon,
      hierarchicalIndex,
      isLastNested,
      nestedIndent,
      options,
    );
    lines.push(...nestedLines);

    // Flow arrow between nested codons (not after last)
    if (!isLastNested) {
      const arrowIndent = `${nestedIndent}│     `;
      const arrow = useColor
        ? `${COLORS.blue}${SYMBOLS.arrowDown}${COLORS.reset}`
        : SYMBOLS.arrowDown;
      lines.push(arrowIndent + arrow);
    }
  });

  // Loop body box closing (rounded corner)
  lines.push(`${boxIndent}${boxColor}${SYMBOLS.pipe}${reset}`);
  lines.push(
    `${boxIndent}${boxColor}${SYMBOLS.roundBottomLeft}${SYMBOLS.dash.repeat(boxWidth)}${reset}`,
  );

  // Flow arrow after loop (not if last item)
  if (!isLast) {
    const arrow = useColor
      ? `${COLORS.blue}${SYMBOLS.arrowDown}${COLORS.reset}`
      : SYMBOLS.arrowDown;
    lines.push(`${indent + continuation}    ${arrow}`);
  }

  return lines;
}

// Main export: render the hank structure
export function renderHankStructure(codons: CodonConfig[], options: RenderOptions = {}): string {
  const width = Math.max(options.terminalWidth || 80, 40);
  // Color output enabled by default when TTY detected, can be overridden via options
  const useColor =
    options.useColor !== undefined ? options.useColor : (process.stdout?.isTTY ?? false);
  const effectiveOptions = { ...options, terminalWidth: width, useColor };

  const output: string[] = [];

  // Handle empty codons array
  if (codons.length === 0) {
    output.push("(No codons defined)");
    return output.join("\n");
  }

  // Header box with rounded corners
  const headerLines = renderHeader(
    options.hankMeta,
    codons,
    options.hasGlobalSystemPrompt || false,
    width,
    useColor,
  );
  output.push(...headerLines);
  output.push(""); // Blank line after header

  // Tree body with hierarchical numbering
  let topLevelIndex = 1;
  codons.forEach((config, i) => {
    const isLast = i === codons.length - 1;

    if (config.type === "loop") {
      // Loops get a number: [2] LOOP: name
      const loopLines = renderLoop(config, topLevelIndex, isLast, "", effectiveOptions);
      output.push(...loopLines);
      topLevelIndex++; // Loops DO consume an index in hierarchical scheme
    } else {
      const codonLines = renderCodonWithIndex(
        config,
        String(topLevelIndex),
        isLast,
        "",
        effectiveOptions,
      );
      output.push(...codonLines);

      // Flow arrow between top-level codons (not after last)
      if (!isLast) {
        const arrow = useColor
          ? `${COLORS.blue}${SYMBOLS.arrowDown}${COLORS.reset}`
          : SYMBOLS.arrowDown;
        output.push(`${SYMBOLS.pipe}     ${arrow}`);
      }

      topLevelIndex++;
    }
  });

  return output.join("\n");
}
