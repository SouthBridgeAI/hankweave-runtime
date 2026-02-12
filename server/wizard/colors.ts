/**
 * Wizard Color Palette & Box-Drawing Helpers
 *
 * Shared 24-bit ANSI color palette anchored to the tesseract splash colors.
 * Used by the welcome wizard for consistent visual language.
 */

// ── Raw ANSI helpers ──────────────────────────────────────────
const ESC = "\x1b[";
const _BOLD = `${ESC}1m`;
const _DIM = `${ESC}2m`;
const _ITALIC = `${ESC}3m`;
const _RESET = `${ESC}0m`;

function fg(r: number, g: number, b: number): string {
  return `${ESC}38;2;${r};${g};${b}m`;
}

// ── Palette ───────────────────────────────────────────────────
// Anchored to the tesseract splash: amber primary, teal secondary.

const COLORS = {
  amber: fg(245, 158, 11),
  amberLight: fg(252, 211, 77),
  teal: fg(45, 212, 191),
  emerald: fg(52, 211, 153),
  warmYellow: fg(251, 191, 36),
  rose: fg(251, 113, 133),
  slate: fg(148, 163, 184),
  darkSlate: fg(71, 85, 105),
  white: fg(248, 250, 252),
  sky: fg(125, 211, 252),
} as const;

// ── Style functions ───────────────────────────────────────────
// Each returns the styled string with RESET appended.

export const amber = (s: string) => `${COLORS.amber}${s}${_RESET}`;
export const amberBold = (s: string) => `${COLORS.amber}${_BOLD}${s}${_RESET}`;
export const teal = (s: string) => `${COLORS.teal}${s}${_RESET}`;
export const tealBold = (s: string) => `${COLORS.teal}${_BOLD}${s}${_RESET}`;
export const emerald = (s: string) => `${COLORS.emerald}${s}${_RESET}`;
export const emeraldBold = (s: string) => `${COLORS.emerald}${_BOLD}${s}${_RESET}`;
export const warmYellow = (s: string) => `${COLORS.warmYellow}${s}${_RESET}`;
export const warmYellowBold = (s: string) => `${COLORS.warmYellow}${_BOLD}${s}${_RESET}`;
export const rose = (s: string) => `${COLORS.rose}${s}${_RESET}`;
export const slate = (s: string) => `${COLORS.slate}${s}${_RESET}`;
export const darkSlate = (s: string) => `${COLORS.darkSlate}${s}${_RESET}`;
export const white = (s: string) => `${COLORS.white}${s}${_RESET}`;
export const whiteBold = (s: string) => `${COLORS.white}${_BOLD}${s}${_RESET}`;
export const sky = (s: string) => `${COLORS.sky}${s}${_RESET}`;
export const bold = (s: string) => `${_BOLD}${s}${_RESET}`;
export const dim = (s: string) => `${_DIM}${s}${_RESET}`;
export const italic = (s: string) => `${_ITALIC}${s}${_RESET}`;

// ── Box Drawing ───────────────────────────────────────────────

/**
 * Strip ANSI escape codes to get the visible character count.
 */
export function visibleLength(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Pad a string (accounting for ANSI codes) to a given visible width.
 */
export function padVisible(s: string, width: number): string {
  const vis = visibleLength(s);
  if (vis >= width) return s;
  return s + " ".repeat(width - vis);
}

export interface BoxOptions {
  /** Title displayed in the top border. Colored with amber by default. */
  title?: string;
  /** Inner width (content area, not including border chars). Auto-calculated if omitted. */
  width?: number;
  /** Padding inside the box (left/right). Default: 1 */
  padding?: number;
}

/**
 * Wrap lines of content in a rounded box with optional title.
 *
 * ```
 * ╭─ Title ──────────────────╮
 * │  content line 1           │
 * │  content line 2           │
 * ╰───────────────────────────╯
 * ```
 */
export function box(lines: string[], opts: BoxOptions = {}): string {
  const pad = opts.padding ?? 1;
  const padStr = " ".repeat(pad);

  // Calculate inner width from content if not specified
  const contentWidths = lines.map((l) => visibleLength(l));
  const titleWidth = opts.title ? visibleLength(opts.title) + 4 : 0; // "─ Title ─"
  const autoWidth = Math.max(...contentWidths, titleWidth) + pad * 2;
  const innerWidth = opts.width ?? autoWidth;

  const bc = darkSlate; // border color

  // Top border
  let top: string;
  if (opts.title) {
    const titleStr = ` ${amberBold(opts.title)} `;
    const titleVisLen = visibleLength(titleStr);
    const remainingDashes = Math.max(0, innerWidth - titleVisLen - 1);
    top = `  ${bc("╭─")}${titleStr}${bc(`${"─".repeat(remainingDashes)}╮`)}`;
  } else {
    top = `  ${bc(`╭${"─".repeat(innerWidth)}╮`)}`;
  }

  // Content lines
  const contentLines = lines.map((line) => {
    const paddedLine = padVisible(`${padStr}${line}`, innerWidth - pad);
    return `  ${bc("│")}${paddedLine}${" ".repeat(Math.max(0, innerWidth - visibleLength(paddedLine)))}${bc("│")}`;
  });

  // Bottom border
  const bottom = `  ${bc(`╰${"─".repeat(innerWidth)}╯`)}`;

  return [top, ...contentLines, bottom].join("\n");
}
