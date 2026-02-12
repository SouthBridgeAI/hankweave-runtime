/**
 * Tesseract Splash Screen
 *
 * Animated 4D hypercube with static ASCII banner, links, and "Press Enter to start".
 * Adapted from intermediates/41-wizard/tesseract-tui.ts for the welcome wizard.
 *
 * Runs the animation until the user presses Enter, then cleans up and returns.
 * Falls back to a static splash if the terminal is too small or non-TTY.
 */

import { getMetadata } from "../utils.js";

// ── ANSI Helpers ──────────────────────────────────────────────
const ESC = "\x1b[";
const hideCursor = () => process.stdout.write(`${ESC}?25l`);
const showCursor = () => process.stdout.write(`${ESC}?25h`);
const clearScreen = () => process.stdout.write(`${ESC}2J${ESC}H`);
const moveTo = (r: number, c: number) => process.stdout.write(`${ESC}${r + 1};${c + 1}H`);
const fg = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;

// ── Color Palette ─────────────────────────────────────────────
const GRAY = fg(100, 116, 139);
const TEAL = fg(45, 212, 191);
const TEAL2 = fg(30, 160, 145);
const WHITE = fg(255, 255, 255);
const AMBER = fg(245, 158, 11);

// ── Tesseract color endpoints (w-dimension gradient) ──────────
// Near cube (high w): teal family
const NEAR_R = 45;
const NEAR_G = 212;
const NEAR_B = 191;
// Far cube (low w): amber family
const FAR_R = 245;
const FAR_G = 158;
const FAR_B = 11;

/** Per-pixel metadata for depth-aware coloring */
interface CellMeta {
  z: number; // z-depth (3D depth, closer = higher)
  w: number; // w-coordinate (4th dimension, -1..1 range)
}

/** Lerp a 0..1 value, clamped. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/**
 * Get a 24-bit fg color for a tesseract pixel based on w and z values.
 *   w: 4th-dimension coordinate → hue (teal for near, amber for far)
 *   z: 3D depth → brightness (closer = brighter, range roughly -1..1)
 *   intensity: character weight (0 = dim dots, 1 = mid edges, 2 = strong edges/verts)
 */
function tesseractColor(w: number, z: number, intensity: number): string {
  // Normalize w from roughly [-1.5, 1.5] to [0, 1] for hue interpolation
  const wt = Math.max(0, Math.min(1, (w + 1.5) / 3));

  // Base color: interpolate between far (amber) and near (teal)
  const baseR = lerp(FAR_R, NEAR_R, wt);
  const baseG = lerp(FAR_G, NEAR_G, wt);
  const baseB = lerp(FAR_B, NEAR_B, wt);

  // Brightness from z-depth: map z from roughly [-1, 1] to [0.25, 1.0]
  const zBright = lerp(0.25, 1.0, (z + 1) / 2);

  // Intensity multiplier: dots are dim, edges are mid, strong chars are bright
  const iMul = intensity === 0 ? 0.35 : intensity === 1 ? 0.65 : 1.0;

  const bright = zBright * iMul;
  const r = Math.round(baseR * bright);
  const g = Math.round(baseG * bright);
  const b = Math.round(baseB * bright);

  return fg(r, g, b);
}

// ── Wireframe Characters ──────────────────────────────────────
const CHARS = [
  ["\u00b7", "\u00b7", "\u00b7", "\u00b7", "\u00b7"],
  ["\u2500", "-", "/", "/", "\u2502"],
  ["=", "=", "/", "/", "|"],
];

function shapeChar(
  dx: number,
  dy: number,
  sx: number,
  sy: number,
  _e: number,
  tier: number,
): string {
  const total = dx + dy;
  if (total === 0) return "\u00b7";
  const hR = dx / total;
  const row = CHARS[Math.min(tier, 2)];
  if (hR > 0.8) return row[0];
  if (hR > 0.6) return row[1];
  if (hR > 0.35) return sx === sy ? "\\" : row[2];
  if (hR > 0.15) return sx === sy ? "\\" : row[3];
  return row[4];
}

// ── Tesseract Renderer ────────────────────────────────────────
interface TesseractFrame {
  chars: string[][];
  meta: CellMeta[][];
}

function renderTesseract(W: number, H: number, t: number): TesseractFrame {
  const chars: string[][] = [];
  const meta: CellMeta[][] = [];
  const zb: number[][] = [];
  for (let r = 0; r < H; r++) {
    chars[r] = Array(W).fill(" ");
    meta[r] = [];
    zb[r] = Array(W).fill(-999);
    for (let c = 0; c < W; c++) {
      meta[r][c] = { z: -999, w: 0 };
    }
  }

  const v4: number[][] = [];
  for (let i = 0; i < 16; i++) {
    v4.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
  }

  const edges: [number, number, number][] = [];
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      let diff = 0;
      let axis = -1;
      for (let d = 0; d < 4; d++) {
        if (v4[i][d] !== v4[j][d]) {
          diff++;
          axis = d;
        }
      }
      if (diff === 1) edges.push([i, j, axis]);
    }
  }

  const xw = t * 0.55;
  const yz = t * 0.35;
  const xy = t * 0.2;
  const cXW = Math.cos(xw);
  const sXW = Math.sin(xw);
  const cYZ = Math.cos(yz);
  const sYZ = Math.sin(yz);
  const cXY = Math.cos(xy);
  const sXY = Math.sin(xy);

  function transform(v: number[]): [number, number, number, number] {
    const x = v[0];
    const y = v[1];
    const z = v[2];
    const w = v[3];
    const x1 = x * cXW - w * sXW;
    const w1 = x * sXW + w * cXW;
    const y1 = y * cYZ - z * sYZ;
    const z1 = y * sYZ + z * cYZ;
    const x2 = x1 * cXY - y1 * sXY;
    const y2 = x1 * sXY + y1 * cXY;
    const pw = 2.0 / (w1 + 3.2);
    const x3 = x2 * pw;
    const y3 = y2 * pw;
    const z3 = z1 * pw;
    // Terminal chars are ~2x taller than wide. Derive scY from scX so the
    // tesseract looks visually round regardless of terminal dimensions.
    // CHAR_ASPECT = charWidth / charHeight ≈ 0.5 for typical monospace fonts.
    const CHAR_ASPECT = 0.5;
    const scX = W * 0.2;
    const scY = Math.min(scX * CHAR_ASPECT, H * 0.36);
    const p2 = 4.0 / (z3 + 5.0);
    return [Math.floor(W / 2 + x3 * p2 * scX), Math.floor(H / 2 + y3 * p2 * scY), z3, w1];
  }

  function drawEdge(p0: number[], p1: number[], axis: number, avgW: number) {
    let x0 = p0[0];
    let y0 = p0[1];
    const x1 = p1[0];
    const y1 = p1[1];
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    const steps = Math.max(dx, dy);
    if (!steps) return;
    const tier = avgW > 0.3 ? 2 : avgW > -0.3 ? 1 : 0;
    // Interpolate w along the edge
    const w0 = p0[3];
    const w1 = p1[3];
    for (let i = 0; i <= steps; i++) {
      if (x0 >= 0 && x0 < W && y0 >= 0 && y0 < H) {
        const tt = i / steps;
        const zz = p0[2] + (p1[2] - p0[2]) * tt;
        if (zz >= zb[y0][x0] - 0.01) {
          zb[y0][x0] = zz;
          chars[y0][x0] =
            axis === 3 ? (i % 2 === 0 ? "\u00b7" : " ") : shapeChar(dx, dy, sx, sy, err, tier);
          meta[y0][x0] = { z: zz, w: w0 + (w1 - w0) * tt };
        }
      }
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  const proj = v4.map(transform);
  const sorted = edges
    .slice()
    .sort((a, b) => proj[a[0]][2] + proj[a[1]][2] - (proj[b[0]][2] + proj[b[1]][2]));
  for (const e of sorted) {
    drawEdge(proj[e[0]], proj[e[1]], e[2], (proj[e[0]][3] + proj[e[1]][3]) / 2);
  }

  for (let i = 0; i < proj.length; i++) {
    const px = proj[i][0];
    const py = proj[i][1];
    const zz = proj[i][2];
    const ww = proj[i][3];
    if (px < 0 || px >= W || py < 0 || py >= H) continue;
    chars[py][px] = ww > 0.3 ? "@" : ww > -0.3 ? "*" : "o";
    meta[py][px] = { z: zz, w: ww };
    if (ww > 0) {
      for (const [ddx, ddy] of [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ] as const) {
        const nx = px + ddx;
        const ny = py + ddy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H && chars[ny][nx] === " ") {
          chars[ny][nx] = "\u00b7";
          meta[ny][nx] = { z: zz, w: ww };
        }
      }
    }
  }
  return { chars, meta };
}

// ── Colorize Tesseract Frame ──────────────────────────────────

/**
 * Color a single row of the tesseract using per-pixel depth metadata.
 * Intensity tiers: 0 = dots/glow, 1 = mid edges, 2 = strong edges/vertices
 */
function colorRow(charRow: string[], metaRow: CellMeta[]): string {
  let out = "";
  for (let c = 0; c < charRow.length; c++) {
    const ch = charRow[c];
    if (ch === " ") {
      out += " ";
      continue;
    }
    const m = metaRow[c];
    // Determine intensity tier from character type
    let intensity: number;
    if ("@".includes(ch))
      intensity = 2; // vertices, strongest glow
    else if ("=|*".includes(ch))
      intensity = 2; // strong edges
    else if ("/-\\".includes(ch))
      intensity = 1; // mid edges
    else intensity = 0; // dots, halos

    const color = tesseractColor(m.w, m.z, intensity);

    // Vertices and strong edges get bold
    if (intensity === 2) {
      out += color + BOLD + ch + RESET;
    } else {
      out += color + ch + RESET;
    }
  }
  return out;
}

// ── Static ASCII Banner ───────────────────────────────────────
// Calvin S box-drawing font — compact, heavy, readable
const BANNER_ART = [
  "\u2566 \u2566\u2554\u2550\u2557\u2554\u2557\u2554\u2566\u2554\u2550\u2566 \u2566\u2554\u2550\u2557\u2554\u2550\u2557\u2566  \u2566\u2554\u2550\u2557",
  "\u2560\u2550\u2563\u2560\u2550\u2563\u2551\u2551\u2551\u2560\u2569\u2557\u2551\u2551\u2551\u2551\u2563 \u2560\u2550\u2563\u255a\u2557\u2554\u255d\u2551\u2563 ",
  "\u2569 \u2569\u2569 \u2569\u255d\u255a\u255d\u2569 \u2569\u255a\u2569\u255d\u255a\u2550\u255d\u2569 \u2569 \u255a\u255d \u255a\u2550\u255d",
];

const version = getMetadata().version;

const BANNER_INFO = [
  "",
  `v${version}`,
  "",
  "single-threaded, headless-first",
  "data agent runtime",
];

const BANNER_LINKS = [
  "",
  "  Docs     https://hankweave.southbridge.ai",
  "  GitHub   https://github.com/SouthBridgeAI/hankweave-runtime",
  "  About    https://southbridge.ai/hankweave",
];

const FULL_BANNER = [...BANNER_ART, ...BANNER_INFO, ...BANNER_LINKS];
const BANNER_W = Math.max(...FULL_BANNER.map((l) => l.length));
const BANNER_H = FULL_BANNER.length;

// Sky blue for clickable URLs (matches wizard palette)
const SKY = fg(125, 211, 252);

function colorBanner(line: string, row: number): string {
  // First 3 lines are the logo text — teal, bold
  if (row < 3) {
    let out = "";
    for (const ch of line) {
      if (ch === " ") out += " ";
      else out += TEAL + BOLD + ch + RESET;
    }
    return out;
  }

  // Version line
  if (row === 4) return WHITE + BOLD + line + RESET;

  // Description lines
  if (row === 6 || row === 7) return TEAL2 + line + RESET;

  // Link lines
  if (row >= 9) {
    // Color the label amber, URL in sky blue
    const match = line.match(/^(\s+\S+\s+)(https?:\/\/.+)$/);
    if (match) {
      return AMBER + BOLD + match[1] + RESET + SKY + match[2] + RESET;
    }
    return GRAY + line + RESET;
  }

  return GRAY + line + RESET;
}

// ── Layout Constants ──────────────────────────────────────────
const SIDE_MIN_W = 110;
const GAP = 4;

// ── Main Splash Function ──────────────────────────────────────

/**
 * Show the animated tesseract splash screen.
 * Resolves when the user presses Enter.
 * Falls back to static output if terminal is not interactive.
 */
export async function showTesseractSplash(): Promise<void> {
  // Non-TTY fallback: just print static info and return
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    printStaticSplash();
    return;
  }

  return new Promise<void>((resolve) => {
    hideCursor();
    clearScreen();

    let t = 0;
    let stopped = false;

    function termSize() {
      return { w: process.stdout.columns || 80, h: process.stdout.rows || 40 };
    }

    function frame() {
      if (stopped) return;

      const { w, h } = termSize();
      t += 0.06;

      const sideMode = w >= SIDE_MIN_W;

      let tessW: number;
      let tessH: number;
      let tessCol: number;
      let bannerCol: number;
      let bannerRow: number;

      if (sideMode) {
        tessW = Math.min(Math.floor(w * 0.5) - GAP, 55);
        tessH = h - 3;
        tessCol = Math.max(0, Math.floor((w - tessW - GAP - BANNER_W) / 2));
        bannerCol = tessCol + tessW + GAP;
        bannerRow = Math.floor((tessH - BANNER_H) / 2) + 1;
      } else {
        tessH = Math.max(12, h - BANNER_H - 5);
        tessW = Math.min(w - 2, 70);
        tessCol = Math.max(0, Math.floor((w - tessW) / 2));
        bannerCol = Math.max(0, Math.floor((w - BANNER_W) / 2));
        bannerRow = tessH + 2;
      }

      // Render tesseract
      const { chars: tessChars, meta: tessMeta } = renderTesseract(tessW, tessH, t);

      // Draw tesseract
      for (let i = 0; i < tessChars.length; i++) {
        moveTo(i + 1, 0);
        process.stdout.write(`${ESC}2K`);
        moveTo(i + 1, tessCol);
        process.stdout.write(colorRow(tessChars[i], tessMeta[i]));
      }

      // Draw banner
      for (let i = 0; i < BANNER_H; i++) {
        const row = bannerRow + i;
        if (row < 1 || row >= h) continue;
        moveTo(row, 0);
        if (!sideMode) process.stdout.write(`${ESC}2K`);
        moveTo(row, bannerCol);
        process.stdout.write(colorBanner(FULL_BANNER[i].padEnd(BANNER_W), i));
      }

      // Clear leftover lines
      const lastContent = sideMode ? tessChars.length + 1 : bannerRow + BANNER_H;
      for (let i = lastContent; i < h - 1; i++) {
        moveTo(i, 0);
        process.stdout.write(`${ESC}2K`);
      }

      // Bottom hint
      const hint = "Press Enter to start";
      moveTo(h - 1, Math.floor((w - hint.length) / 2));
      process.stdout.write(`${AMBER}${BOLD}${hint}${RESET}`);

      // Ctrl+C hint
      const DARK_SLATE = fg(71, 85, 105);
      moveTo(h, w - 14);
      process.stdout.write(`${DARK_SLATE}ctrl+c to exit${RESET}`);
    }

    // Listen for Enter key
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (data: Buffer) => {
      // Enter (CR or LF) or Return
      if (data[0] === 13 || data[0] === 10) {
        cleanup();
        return;
      }
      // Ctrl+C
      if (data[0] === 3) {
        cleanup();
        showCursor();
        clearScreen();
        process.stdout.write(RESET);
        process.exit(0);
      }
    };

    process.stdin.on("data", onData);

    const resizeHandler = () => clearScreen();
    process.stdout.on("resize", resizeHandler);

    const interval = setInterval(frame, 16);

    function cleanup() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      process.stdout.removeListener("resize", resizeHandler);
      showCursor();
      clearScreen();
      process.stdout.write(RESET);
      resolve();
    }
  });
}

/**
 * Print a static (non-animated) splash for non-TTY environments.
 */
function printStaticSplash(): void {
  const v = getMetadata().version;
  console.log(`
Hankweave v${v}

No hank.json found in current directory.

Quick start:
  npx hankweave --init            Create a new hank here
  npx hankweave --help            Show all options
  npx hankweave <hank.json>       Run a specific hank

Docs:   https://hankweave.southbridge.ai
GitHub: https://github.com/SouthBridgeAI/hankweave-runtime
`);
}
