import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, Peer } from "crossws";
import { serve as crosswsServe } from "crossws/server";
// Import cross-platform WebSocket client from crossws
// This works in Node.js (18+), Bun, Deno, and browsers
import WebSocket from "crossws/websocket";
import merge from "lodash.merge";
import { z } from "zod";
import { containsGitComponent } from "./git-support.js";
import type { ClientCommand, ServerEvent } from "./types/types.js";
import type { WebSocketLogEntry } from "./types/websocket-log-types.js";

// Re-export WebSocket for use throughout the codebase
// This hides the crossws dependency as an implementation detail
export { WebSocket };

// -------------
// ID Generation
// -------------

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11).padEnd(9, "0")}`;
}

// -------------
// Logger
// -------------

export class Logger {
  constructor(private logFile: string) {}

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

    try {
      const logsDir = path.dirname(this.logFile);
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      fs.appendFileSync(this.logFile, logLine);
    } catch (error) {
      // If we can't write to file (e.g., during shutdown), just log to console
      console.error(`Failed to write to log file: ${error}`);
    }

    if (level === "error") {
      console.error(logLine.trim());
    }
  }

  /**
   * Log WebSocket traffic as JSONL (JSON Lines format).
   * Each line is a complete JSON object representing a WebSocket message.
   *
   * @param socketLogFile - Path to the websocket log file
   * @param direction - Whether this is an incoming or outgoing message
   * @param data - The actual WebSocket message (ClientCommand or ServerEvent)
   */
  logWebSocketMessage(
    socketLogFile: string,
    direction: "in" | "out",
    data: ClientCommand | ServerEvent,
  ): void {
    try {
      // Create the log entry with minimal wrapper
      const logEntry: WebSocketLogEntry = {
        loggedAt: new Date().toISOString(),
        direction,
        message: data,
        metadata: {
          // Calculate message size
          size: JSON.stringify(data).length,
        },
      };

      // Write as a single line of JSON (JSONL format)
      const logLine = `${JSON.stringify(logEntry)}\n`;

      const logsDir = path.dirname(socketLogFile);
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      fs.appendFileSync(socketLogFile, logLine);
    } catch (error) {
      // If we can't log to file, at least log the error
      console.error(`Failed to log WebSocket message: ${error}`);
    }
  }

  /**
   * @deprecated Use logWebSocketMessage instead
   */
  logSocketTraffic(socketLogFile: string, direction: "in" | "out", data: unknown): void {
    // For backward compatibility, convert to new format
    this.logWebSocketMessage(socketLogFile, direction, data as ClientCommand | ServerEvent);
  }
}

// -------------
// Shell Utilities
// -------------

/**
 * Escape a string for safe use in shell commands.
 * Replaces single quotes with '\'' and wraps in single quotes.
 */
export function escapeShellArg(arg: string): string {
  // Replace all single quotes with '\''
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// -------------
// Environment Variable Display / Redaction
// -------------

/**
 * Decide whether an environment variable's value should be masked based on its
 * NAME. Secrets are conventionally named with markers like SECRET/TOKEN/KEY/
 * PASSWORD, while readable config (URLs, public keys, hosts) is not.
 *
 * Default is to show the value; we only mask names that look secret. The
 * `PUBLIC`/`PUBLISHABLE` markers explicitly override the generic `KEY` rule, so
 * e.g. `LANGFUSE_PUBLIC_KEY` is shown but `LANGFUSE_SECRET_KEY` is masked.
 */
export function isSensitiveEnvKey(key: string): boolean {
  const k = key.toUpperCase();

  // Explicitly public/publishable values are safe to show — but only if they
  // aren't also tagged as a secret (e.g. a hypothetical PUBLIC_SECRET stays masked).
  if (/PUBLIC|PUBLISHABLE/.test(k) && !/SECRET|PRIVATE|TOKEN|PASSWORD|PASSWD/.test(k)) {
    return false;
  }

  // Name markers that indicate a secret value.
  return /SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE|KEY|AUTH|BEARER|SESSION|COOKIE|SIGNING|SIGNATURE|ACCESS|CERT|ENCRYPT|SALT/.test(
    k,
  );
}

/**
 * Mask an environment-variable value for display in validation output.
 *
 * Reveals only the last 4 characters of sufficiently long values (enough to
 * sanity-check which secret is loaded) and fully masks short ones.
 */
export function maskSecretValue(value: string): string {
  if (value.length === 0) return "(empty)";
  if (value.length < 12) return `•••••• (${value.length} chars)`;
  return `••••••${value.slice(-4)} (${value.length} chars)`;
}

/**
 * Format an env var for the validation listing: secret-named values are masked,
 * everything else is shown verbatim.
 */
export function formatEnvVarForDisplay(key: string, value: string): string {
  return isSensitiveEnvKey(key) ? maskSecretValue(value) : value;
}

// -------------
// Runtime Detection
// -------------

/**
 * Supported JavaScript runtimes.
 */
export type Runtime = "bun" | "node" | "deno";

/**
 * Detect the current JavaScript runtime.
 * Uses global object inspection following the crossws pattern.
 *
 * @returns The detected runtime ('bun', 'deno', or 'node')
 */
export function detectRuntime(): Runtime {
  if ("Bun" in globalThis) return "bun";
  if ("Deno" in globalThis) return "deno";
  return "node";
}

/**
 * Get the current runtime name and version as a string.
 * e.g. "bun 1.2.0", "node 22.0.0", "deno 2.1.0"
 */
export function getRuntimeVersion(): string {
  const runtime = detectRuntime();
  switch (runtime) {
    case "bun":
      return `bun ${process.versions.bun}`;
    case "deno":
      // biome-ignore lint/suspicious/noExplicitAny: Deno global is not typed in non-Deno environments
      return `deno ${(globalThis as any).Deno?.version?.deno ?? "unknown"}`;
    case "node":
      return `node ${process.version}`;
  }
}

/**
 * Detects if we're running from a compiled Bun executable.
 *
 * When compiled, Bun puts files in a virtual filesystem at:
 * - On Unix: /$bunfs/root/...
 * - On Windows: X:/~BUN/root/... (drive letter varies)
 *
 * @returns true if running from a compiled executable, false otherwise
 */
export function isCompiledExecutable(): boolean {
  // Allow override for testing (avoids Bun's module mock persistence bug)
  // https://github.com/oven-sh/bun/issues/7823
  if (process.env.HANKWEAVE_TEST_IS_COMPILED !== undefined) {
    return process.env.HANKWEAVE_TEST_IS_COMPILED === "true";
  }

  // We only support Bun compiled executables
  const isBun = typeof Bun !== "undefined";

  if (!isBun) {
    return false;
  }

  // Simple check: if we're running from Bun's virtual filesystem, we're compiled
  // On Unix: /$bunfs/root/...
  // On Windows: X:\~BUN\ or X:/~BUN/ (drive letter varies, slashes can be either direction)
  const path = import.meta.path;
  const isCompiled =
    path.startsWith("/$bunfs/") || // Unix
    /^[A-Z]:[/\\]~BUN[/\\]/i.test(path); // Windows (both forward and backslashes)
  return isCompiled;
}

// -------------
// Metadata Management
// -------------

/**
 * Schema for application metadata.
 * This is embedded in compiled executables and used to track version info.
 */
export const metadataSchema = z.object({
  version: z.string().min(1, "Version cannot be empty"),
  buildDate: z.string().optional(),
  buildTarget: z.string().optional(),
});

export type Metadata = z.infer<typeof metadataSchema>;

/**
 * Metadata class for managing application metadata.
 * Supports serialization/deserialization and validation via Zod.
 */
export class AppMetadata {
  private constructor(private data: Metadata) {}

  /**
   * Create metadata from object (validates with Zod schema)
   */
  static create(data: unknown): AppMetadata {
    const validated = metadataSchema.parse(data);
    return new AppMetadata(validated);
  }

  /**
   * Deserialize metadata from JSON string
   */
  static deserialize(json: string): AppMetadata {
    const data = JSON.parse(json);
    return AppMetadata.create(data);
  }

  /**
   * Serialize metadata to JSON string
   */
  serialize(): string {
    return JSON.stringify(this.data, null, 2);
  }

  /**
   * Get the version string
   */
  get version(): string {
    return this.data.version;
  }

  /**
   * Get the build date (if available)
   */
  get buildDate(): string | undefined {
    return this.data.buildDate;
  }

  /**
   * Get the build target (if available)
   */
  get buildTarget(): string | undefined {
    return this.data.buildTarget;
  }

  /**
   * Get raw metadata object
   */
  toObject(): Metadata {
    return { ...this.data };
  }
}

// Cached metadata to avoid repeated file reads/imports
let cachedMetadata: AppMetadata | null = null;
const FALLBACK_VERSION = "1.0.0";

/**
 * Get application metadata (version, build info, etc.).
 * Works in both development (reads from filesystem) and compiled executable
 * (uses build-time constants) contexts.
 *
 * In compiled mode: Uses BUILD_VERSION, BUILD_DATE, BUILD_TARGET constants
 * In dev mode: Reads from package.json
 *
 * @returns AppMetadata instance, or metadata with fallback version
 */
export function getMetadata(): AppMetadata {
  if (cachedMetadata) return cachedMetadata;

  try {
    // For compiled executables, use build-time constants
    // These are injected via Bun's --define flag and replaced at compile-time
    if (isCompiledExecutable()) {
      try {
        // Build-time constants are compile-time replacements
        // They will be replaced with their actual values during compilation
        const buildMetadata = {
          version: BUILD_VERSION,
          buildDate: BUILD_DATE,
          buildTarget: BUILD_TARGET,
        };
        cachedMetadata = AppMetadata.create(buildMetadata);
        return cachedMetadata as AppMetadata;
      } catch {
        // Fallback if constants are somehow not defined
        cachedMetadata = AppMetadata.create({ version: FALLBACK_VERSION });
        return cachedMetadata as AppMetadata;
      }
    }

    // Fallback: Read from package.json (dev mode)
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = path.resolve(__dirname, "../package.json");
    if (fs.existsSync(packageJsonPath)) {
      const content = fs.readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);
      cachedMetadata = AppMetadata.create({
        version: pkg.version || FALLBACK_VERSION,
      });
    } else {
      // Ultimate fallback
      cachedMetadata = AppMetadata.create({ version: FALLBACK_VERSION });
    }
  } catch {
    cachedMetadata = AppMetadata.create({ version: FALLBACK_VERSION });
  }

  return cachedMetadata as AppMetadata;
}

// ANSI color codes for terminal output
const STARTUP_COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
};

/**
 * Render the startup banner box with version and platform info.
 * Matches the style of the codon structure boxes.
 */
export function renderStartupBanner(): void {
  const version = getMetadata().version;
  const platform = process.platform;
  const arch = process.arch;
  const runtime = getRuntimeVersion();

  const useColor = process.stdout.isTTY !== false;
  const terminalWidth = process.stdout.columns || 80;
  const boxWidth = Math.min(terminalWidth - 2, 70);
  const innerWidth = boxWidth - 4;

  const c = useColor ? STARTUP_COLORS : { reset: "", bold: "", dim: "", cyan: "" };

  const titleLine = `Hankweave v${version}`;
  const platformLine = `${platform} ${arch} • ${runtime}`;

  console.log();
  console.log(`${c.cyan}╭${"─".repeat(boxWidth - 2)}╮${c.reset}`);
  console.log(
    `${c.cyan}│${c.reset}  ${c.bold}${c.cyan}${titleLine.padEnd(innerWidth)}${c.reset}${c.cyan}│${c.reset}`,
  );
  console.log(
    `${c.cyan}│${c.reset}  ${c.dim}${platformLine.padEnd(innerWidth)}${c.reset}${c.cyan}│${c.reset}`,
  );
  console.log(`${c.cyan}╰${"─".repeat(boxWidth - 2)}╯${c.reset}`);
  console.log();
}

/**
 * Shorten a path by replacing the home directory with ~
 */
export function shortenPath(fullPath: string): string {
  const home = os.homedir();
  if (fullPath.startsWith(home)) {
    return `~${fullPath.slice(home.length)}`;
  }
  return fullPath;
}

export interface StartupInfo {
  executionId: string;
  isResuming: boolean;
  sourcePath: string;
  executionPath: string;
  linkType: string;
  sdks: Array<{ name: string; version: string; cached: boolean }>;
}

/**
 * Render the execution info section after the startup banner.
 */
export function renderStartupInfo(info: StartupInfo): void {
  const useColor = process.stdout.isTTY !== false;
  const c = useColor ? STARTUP_COLORS : { reset: "", bold: "", dim: "", cyan: "" };

  const status = info.isResuming ? "Resuming" : "New execution";
  const sourceBasename = path.basename(info.sourcePath);
  const shortExecPath = shortenPath(info.executionPath);

  // Format SDKs line
  const sdkParts = info.sdks.map((sdk) => {
    const status = sdk.cached ? "✓" : "↓";
    return `${sdk.name} ${sdk.version} ${status}`;
  });
  const sdksLine = sdkParts.join("  ");

  console.log(`${c.dim}${status}:${c.reset} ${info.executionId}`);
  console.log(`  Source ${c.dim}→${c.reset} ${sourceBasename}`);
  console.log(`  Exec   ${c.dim}→${c.reset} ${shortExecPath}`);
  console.log(`  SDKs   ${c.dim}→${c.reset} ${sdksLine}`);
  console.log();
}

// -------------
// Error Utilities
// -------------

/**
 * Type guard to check if a value is an Error instance.
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

/**
 * Convert any value to an Error instance.
 * If already an Error, returns it unchanged.
 * Otherwise creates a new Error with string representation.
 */
export function toError(error: unknown): Error {
  if (isError(error)) return error;
  if (typeof error === "string") return new Error(error);
  return new Error(String(error));
}

// -------------
// Type Utilities
// -------------

/**
 * Helper type to check if two types are exactly equal at compile time.
 * Returns `true` if the types match, `never` if they don't.
 *
 * Use this to enforce type constraints that must be validated at compile time.
 *
 * @example
 * // Ensure all event types are categorized
 * const _check: AssertEqual<EventType, CategoryA | CategoryB> = true;
 */
export type AssertEqual<T, U> = (<G>() => G extends T ? 1 : 2) extends <G>() => G extends U ? 1 : 2
  ? true
  : never;

// -------------
// Exhaustive Checking
// -------------

/**
 * Exhaustive checking helper for switch statements.
 * Use this in the default case to ensure all union cases are handled.
 * TypeScript will error if a case is missing.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

// -------------
// Idle Timeout
// -------------

export class IdleTimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Idle timeout: no events received for ${timeoutMs}ms`);
    this.name = "IdleTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wraps an async iterable with an idle timeout. If no event is received
 * within `timeoutMs` milliseconds, throws an `IdleTimeoutError`.
 *
 * The timer resets on each received event, so long-running operations
 * that produce regular events will not be interrupted.
 */
export async function* withIdleTimeout<T>(
  events: AsyncIterable<T>,
  timeoutMs: number,
): AsyncGenerator<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `withIdleTimeout: timeoutMs must be a positive finite number, got ${timeoutMs}`,
    );
  }
  const iterator = events[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await nextBeforeIdleTimeout(iterator, timeoutMs);
      if (result.done) break;
      yield result.value;
    }
  } finally {
    // Fire-and-forget: don't await because the iterator may be stuck
    // on a hung promise (which is exactly why we're timing out).
    // In the normal completion case, return() on a finished iterator is a no-op.
    void iterator.return?.();
  }
}

async function nextBeforeIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  // Start requesting the next event before arming its idle deadline.
  const next = iterator.next();
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new IdleTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([next, deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// -------------
// Hank Reference Utilities
// -------------

/** A portable-path, containment, symlink, or copy-tree policy violation. */
export type RefViolation =
  | { kind: "absolute"; raw: string }
  | { kind: "backslash"; raw: string }
  | { kind: "invalid"; raw: string }
  | { kind: "git-metadata"; raw: string }
  | { kind: "escapes"; raw: string; resolved: string }
  | { kind: "symlink"; raw: string; component: string }
  | { kind: "tree-symlink"; raw: string; entry: string }
  | { kind: "tree-special"; raw: string; entry: string }
  | { kind: "tree-nested-gitignore"; raw: string; entry: string }
  | { kind: "tree-ignored-root"; raw: string };

/** An authored reference and its diagnostic field; scanTree marks copy.from sources. */
export interface AuthoredRef {
  field: string;
  raw: string;
  scanTree?: boolean;
}

/** Reference-bearing fields of a sentinel config, without a schema dependency. */
export interface SentinelRefFields {
  systemPromptFile?: string | string[];
  userPromptFile?: string | string[];
  structuredOutput?: { schemaFile?: string };
}

/** Reference-bearing fields of a codon; callers handle loop traversal. */
export interface CodonRefFields {
  promptFile?: string | string[];
  appendSystemPromptFile?: string | string[];
  rigSetup?: Array<{ type: string; copy?: { from: string } }>;
  sentinels?: Array<{ sentinelConfig: string | object }>;
}

/** Normalize a scalar/list reference field. An empty scalar means absent;
 * empty array elements remain so validation can report them. */
export function normalizeRefField(v: string | string[] | undefined | null): string[] {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

/** Portable spelling check, independent of the host platform and filesystem. */
export function forbiddenRefSpelling(
  raw: string,
): "absolute" | "backslash" | "invalid" | "git-metadata" | null {
  if (raw.startsWith("/")) return "absolute";
  // C:\x, C:/x, drive-relative C:foo, bare C: — checked before the backslash
  // rule so every drive-qualified spelling reports "absolute": the real
  // problem is that the ref names a fixed location, not how it is spelled.
  if (/^[A-Za-z]:/.test(raw)) return "absolute";
  // What's left: Windows separators mid-path, the drive-less absolute form
  // (\foo), and UNC paths (\\srv\share) — and "\" is a legal filename
  // CHARACTER on POSIX, so a ref containing one cannot be portable at all.
  if (raw.includes("\\")) return "backslash";
  if (raw.includes("\0")) return "invalid";
  // The hard `.git` prohibition overrides explicit references: `.git` — the
  // directory, or the worktree/submodule marker FILE holding a
  // machine-specific gitdir path — is never copied or bundled, so a ref that
  // names it (or reaches through it) is an error, not an admitted file.
  // Checked on the LEXICALLY NORMALIZED spelling, because that is what every
  // consumer resolves and reads: "sub/.git/../safe.md" collapses to
  // "sub/safe.md" and never touches git metadata, so it stays legal
  // (internal ".." hops are permitted policy). ".github" and ".gitignore"
  // are ordinary names.
  if (containsGitComponent(path.posix.normalize(raw))) return "git-metadata";
  return null;
}

/** Whether a POSIX reference climbs above its base after lexical normalization. */
export function lexicallyEscapesBase(raw: string): boolean {
  const normalized = path.posix.normalize(raw);
  return normalized === ".." || normalized.startsWith("../");
}

/** Schema for a root-relative reference: spelling and lexical containment
 * only. Disk checks still happen through HankRef.validate(). */
export const refStringSchema = (what: string) =>
  z
    .string()
    .min(1, `${what} cannot be an empty string; omit the field instead`)
    .superRefine((raw, ctx) => {
      const kind = forbiddenRefSpelling(raw);
      if (kind !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: refViolationMessage({ kind, raw }),
        });
        return;
      }
      if (lexicallyEscapesBase(raw)) {
        // Same first clause as refViolationMessage's "escapes"; the resolved
        // path is omitted because the schema layer never resolves.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${raw}" resolves outside the hank directory; move the file into the hank directory`,
        });
      }
    });

/** The same reference schema accepting either a string or an array. */
export const refFieldSchema = (what: string) =>
  z.union([refStringSchema(what), z.array(refStringSchema(what))]);

/** Spelling-only schema for refs whose base inside the hank is not yet
 * known. Parent traversal may be valid; containment is checked at load. */
export const portableRefStringSchema = (what: string) =>
  z
    .string()
    .min(1, `${what} cannot be an empty string; omit the field instead`)
    .superRefine((raw, ctx) => {
      const kind = forbiddenRefSpelling(raw);
      if (kind !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: refViolationMessage({ kind, raw }),
        });
      }
    });

/** The spelling-only schema accepting either a string or an array. */
export const portableRefFieldSchema = (what: string) =>
  z.union([portableRefStringSchema(what), z.array(portableRefStringSchema(what))]);

/** Inline sentinel refs are anchored at the hank root, so their schema
 * can also reject lexical escapes. Returns messages for the caller's Zod context. */
export function inlineSentinelRefsEscapeIssues(config: SentinelRefFields): string[] {
  const issues: string[] = [];
  for (const { field, raw } of sentinelOwnRefs(config)) {
    if (forbiddenRefSpelling(raw) === null && lexicallyEscapesBase(raw)) {
      issues.push(
        `${field}: "${raw}" resolves outside the hank directory; move the file into the hank directory`,
      );
    }
  }
  return issues;
}

/** Enumerate a codon's authored source references, including copy trees. */
export function codonOwnRefs(codon: CodonRefFields): AuthoredRef[] {
  const refs: AuthoredRef[] = [
    ...normalizeRefField(codon.promptFile).map((raw) => ({ field: "promptFile", raw })),
    ...normalizeRefField(codon.appendSystemPromptFile).map((raw) => ({
      field: "appendSystemPromptFile",
      raw,
    })),
  ];
  for (const item of codon.rigSetup ?? []) {
    if (item.type === "copy" && item.copy) {
      refs.push({ field: "copy.from", raw: item.copy.from, scanTree: true });
    }
  }
  for (const entry of codon.sentinels ?? []) {
    if (typeof entry.sentinelConfig === "string") {
      refs.push({ field: "sentinelConfig", raw: entry.sentinelConfig });
    }
  }
  return refs;
}

/** Enumerate references owned by a sentinel config. */
export function sentinelOwnRefs(config: SentinelRefFields): AuthoredRef[] {
  return [
    ["systemPromptFile", config.systemPromptFile],
    ["userPromptFile", config.userPromptFile],
    ["structuredOutput.schemaFile", config.structuredOutput?.schemaFile],
  ].flatMap(([field, value]) =>
    normalizeRefField(value as string | string[] | undefined).map((raw) => ({
      field: field as string,
      raw,
    })),
  );
}

/** Shared author-facing wording for reference and copy-tree violations. */
export function refViolationMessage(v: RefViolation): string {
  switch (v.kind) {
    case "absolute":
      return `"${v.raw}" is an absolute or drive-qualified path; hank refs must be relative paths inside the hank directory`;
    case "backslash":
      return `"${v.raw}" contains a backslash; hank refs use "/" as the only path separator`;
    case "invalid":
      return `"${v.raw}" contains an invalid character (NUL)`;
    case "git-metadata":
      return `"${v.raw}" names git metadata (.git); git metadata is never copied or bundled — reference the files you need directly`;
    case "escapes":
      return `"${v.raw}" resolves outside the hank directory (${v.resolved}); move the file into the hank directory`;
    case "symlink":
      return `"${v.raw}" passes through a symlink at "${v.component}"; symlinks are not allowed in hank refs`;
    default:
      return copyTreeViolationMessage(v);
  }
}

/** Copy-tree diagnostics describe entries or ignore rules, rather than
 * the spelling and route of an individual reference. */
function copyTreeViolationMessage(v: Extract<RefViolation, { kind: `tree-${string}` }>): string {
  switch (v.kind) {
    case "tree-symlink":
      return `"${v.raw}" contains a symlink at "${v.entry}"; symlinks are not allowed anywhere in a copied tree`;
    case "tree-special":
      return `"${v.raw}" contains a non-regular file at "${v.entry}"; only regular files and directories can be copied`;
    case "tree-nested-gitignore":
      return `"${v.raw}" contains a nested .gitignore at "${v.entry}"; hank ignore rules live in ONE .gitignore at the hank root — move the rules there, prefixed with the folder path (e.g. "sub/build/")`;
    case "tree-ignored-root":
      return `"${v.raw}" is a directory excluded by the hank's ignore rules (.gitignore or the default set), so every file in it would be excluded; adjust the rules or copy a different source`;
  }
}

// -------------
// String Utilities
// -------------

const utf8Encoder = new TextEncoder();

/** Compare two strings by their UTF-8 byte sequences. */
export function compareUtf8(a: string, b: string): number {
  const ab = utf8Encoder.encode(a);
  const bb = utf8Encoder.encode(b);
  const len = Math.min(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    const d = (ab[i] as number) - (bb[i] as number);
    if (d !== 0) return d;
  }
  return ab.length - bb.length;
}

// -------------
// File and Directory Utilities
// -------------

/** Convert the host platform's path separators to POSIX separators. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Whether a name carries a packed-bundle suffix. One definition keeps `pack`'s
 * output check, the run-mode positional heuristic, and the bundle resolver in
 * lockstep: a file `pack` accepts as output is a file the runner recognizes.
 */
export function isBundlePath(name: string): boolean {
  return name.endsWith(".hank") || name.endsWith(".tar.zst");
}

/** What checkRegularFile found wrong with a path. */
export interface RegularFileProblem {
  kind: "missing" | "irregular" | "unreadable";
  /** Message fragment phrased to follow the file name (`promptFile "x" does not exist`). */
  phrase: string;
}

/**
 * Guard for paths that must be readable regular files. Returns null when the
 * path is one, otherwise the problem kind plus a message fragment phrased to
 * follow the file name (`promptFile "x" does not exist`).
 *
 * The regular-file check must run before any read: readFileSync on a FIFO
 * blocks forever, and on a directory throws a confusing EISDIR. Pass
 * { read: false } when the caller does its own read right after (the trial
 * read here would just double it).
 */
export function checkRegularFile(
  filePath: string,
  options?: { read?: boolean },
): RegularFileProblem | null {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return { kind: "missing", phrase: "does not exist" };
  }
  if (!stats.isFile()) {
    return { kind: "irregular", phrase: "is not a regular file" };
  }
  if (options?.read !== false) {
    try {
      fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      return {
        kind: "unreadable",
        phrase: `is not readable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return null;
}

/**
 * Locate a program on PATH the way `sh -c` (or cmd.exe) would: first
 * executable regular file named `name` in a PATH entry, honouring PATHEXT
 * on Windows. Returns null when nothing matches. Runs under Node as well as
 * Bun, so it never touches `Bun.which`.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const isWin = process.platform === "win32";
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((d) => d.length > 0);
  // On Windows a bare name tries each PATHEXT suffix; a name that already
  // carries an extension, and every POSIX name, is tried verbatim.
  const suffixes =
    isWin && path.extname(name) === ""
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((e) => e.length > 0)
      : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      if (isExecutableFile(candidate, isWin)) return candidate;
    }
  }
  return null;
}

/** A regular file that the current user may execute (Windows has no
 * execute bit; existence as a regular file is the whole test there). */
function isExecutableFile(candidate: string, isWin: boolean): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (!isWin) fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Root for auto-managed executions. `HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR`
 * overrides — primarily so tests never touch the real home directory. Read at
 * call time, not module load, so tests can set it per-process.
 */
export function getManagedExecutionsRoot(): string {
  const override = process.env.HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR;
  return override && override.trim() !== ""
    ? path.resolve(override)
    : path.join(os.homedir(), ".hankweave-executions");
}

/**
 * Calculate the total size of a directory recursively.
 * Includes a timeout to prevent hanging on large directories.
 */
export async function getDirectorySize(
  dirPath: string,
  timeoutMs = 30000, // Preserve timeout feature from cleanup folder
): Promise<number> {
  let totalSize = 0;
  const startTime = Date.now();

  async function walkDir(currentPath: string): Promise<void> {
    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Directory size calculation timed out after ${timeoutMs}ms`);
    }

    const entries = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else {
        try {
          const stats = await fs.promises.stat(fullPath);
          totalSize += stats.size;
        } catch {
          // Ignore files we can't stat
        }
      }
    }
  }

  await walkDir(dirPath);
  return totalSize;
}

/**
 * Format a byte size into a human-readable string.
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / k ** i).toFixed(1)} ${units[i]}`;
}

// Maximum number of conflict copies before throwing an error
const MAX_CONFLICT_COPIES = 100;

/**
 * Generate a non-conflicting filename by adding a numbered suffix with timestamp.
 * Format: file_<counter>_<timestamp>.txt (e.g., report_1_1738678800.txt)
 *
 * @param destPath - The desired destination path
 * @returns Object with resolved path and conflict info
 * @throws Error if more than MAX_CONFLICT_COPIES exist (prevents runaway loops)
 */
export async function resolveFileConflict(destPath: string): Promise<{
  resolvedPath: string;
  hadConflict: boolean;
  conflictNumber?: number;
  timestamp?: number;
}> {
  // If path doesn't exist, no conflict
  if (!fs.existsSync(destPath)) {
    return { resolvedPath: destPath, hadConflict: false };
  }

  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const baseName = path.basename(destPath, ext);
  const timestamp = Math.floor(Date.now() / 1000); // Unix timestamp in seconds

  let counter = 1;
  let candidatePath: string;

  do {
    candidatePath = path.join(dir, `${baseName}_${counter}_${timestamp}${ext}`);
    counter++;

    // Safety limit to prevent infinite loops in unusual situations
    if (counter > MAX_CONFLICT_COPIES) {
      throw new Error(
        `Too many conflicting copies of '${path.basename(destPath)}' (>${MAX_CONFLICT_COPIES}). ` +
          `Consider cleaning the output directory or using a unique output path.`,
      );
    }
  } while (fs.existsSync(candidatePath));

  return {
    resolvedPath: candidatePath,
    hadConflict: true,
    conflictNumber: counter - 1,
    timestamp,
  };
}

// -------------
// Object Utilities
// -------------

/**
 * Deep merge multiple objects with proper handling of nested structures.
 *
 * Uses lodash.merge for deep merging. Note that arrays are merged by index
 * (not replaced entirely).
 *
 * Merging rules:
 * - Plain objects are merged recursively
 * - Arrays are merged by index (e.g., [1,2,3] + [4,5] = [4,5,3])
 * - Primitives (string, number, boolean, null) are replaced
 * - Later sources take precedence over earlier ones
 *
 * @param sources - Objects to merge, in priority order (later = higher priority)
 * @returns Merged object with all properties from all sources
 *
 * @example
 * const defaults = { port: 8080, sentinel: { enabled: true, timeout: 1000 } };
 * const userConfig = { port: 3000, sentinel: { timeout: 5000 } };
 * const merged = deepMerge(defaults, userConfig);
 * // Result: { port: 3000, sentinel: { enabled: true, timeout: 5000 } }
 */
export function deepMerge<T extends Record<string, unknown>>(...sources: Array<T | undefined>): T {
  return merge({}, ...sources) as T;
}

// -------------
// File System Reliability Utilities
// -------------

/**
 * Rename file with retry logic for Windows file locking issues.
 *
 * On Windows, EPERM/EBUSY errors can occur transiently due to:
 * - Antivirus scanning (Windows Defender in CI environments)
 * - File handles not fully released after previous operations
 * - Windows filesystem timing differences vs Unix
 *
 * This implements exponential backoff retry to handle these transient locks.
 *
 * @param source - Source file path
 * @param target - Target file path
 * @param options - Retry configuration options
 * @param options.maxRetries - Maximum number of retry attempts (default: 5)
 * @param options.initialDelay - Initial delay in milliseconds (default: 10ms)
 * @param options.logger - Optional logger for debugging retry attempts
 * @returns Promise that resolves when rename succeeds
 * @throws Error if rename fails after all retries or encounters non-retryable error
 *
 * @example
 * ```ts
 * // Basic usage
 * await renameWithRetry('temp.json', 'state.json');
 *
 * // With custom retry settings and logging
 * await renameWithRetry('temp.json', 'state.json', {
 *   maxRetries: 10,
 *   initialDelay: 20,
 *   logger: myLogger
 * });
 * ```
 */
export async function renameWithRetry(
  source: string,
  target: string,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    logger?: Logger;
  } = {},
): Promise<void> {
  const { maxRetries = 5, initialDelay = 10, logger } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fs.promises.rename(source, target);
      return; // Success!
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      lastError = err;

      // Only retry on file locking errors
      if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
        if (attempt < maxRetries - 1) {
          const delay = initialDelay * 2 ** attempt;
          logger?.log(
            `File locked, retrying rename in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
            "debug",
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      // Non-retryable error or max retries exceeded
      throw error;
    }
  }

  // Should never reach here, but TypeScript doesn't know that
  throw lastError || new Error("Rename failed after retries");
}

/**
 * Synchronous version of renameWithRetry for use in synchronous contexts.
 *
 * Same behavior as renameWithRetry but uses synchronous fs operations.
 * Useful for scenarios where async/await cannot be used.
 *
 * @param source - Source file path
 * @param target - Target file path
 * @param options - Retry configuration options
 * @param options.maxRetries - Maximum number of retry attempts (default: 5)
 * @param options.initialDelay - Initial delay in milliseconds (default: 10ms)
 * @param options.logger - Optional logger for debugging retry attempts
 * @throws Error if rename fails after all retries or encounters non-retryable error
 *
 * @example
 * ```ts
 * renameWithRetrySync('temp.json', 'state.json');
 * ```
 */
export function renameWithRetrySync(
  source: string,
  target: string,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    logger?: Logger;
  } = {},
): void {
  const { maxRetries = 5, initialDelay = 10, logger } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.renameSync(source, target);
      return; // Success!
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      lastError = err;

      // Only retry on file locking errors
      if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
        if (attempt < maxRetries - 1) {
          const delay = initialDelay * 2 ** attempt;
          logger?.log(
            `File locked, retrying rename in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
            "debug",
          );
          // Synchronous sleep using busy-wait (not ideal but necessary for sync context)
          const start = Date.now();
          while (Date.now() - start < delay) {
            // Busy wait
          }
          continue;
        }
      }

      // Non-retryable error or max retries exceeded
      throw error;
    }
  }

  // Should never reach here, but TypeScript doesn't know that
  throw lastError || new Error("Rename failed after retries");
}

/**
 * Synchronous directory/file removal with retry logic for Windows file locking issues.
 *
 * On Windows, file handles can take time to release after process termination,
 * causing EBUSY/EPERM errors when trying to delete directories. This function
 * retries the operation with exponential backoff to handle these transient errors.
 *
 * @param targetPath - Path to file or directory to remove
 * @param options - Removal and retry configuration options
 * @param options.recursive - Allow recursive removal of directories (default: false)
 * @param options.force - Continue even if path doesn't exist (default: false)
 * @param options.maxRetries - Maximum number of retry attempts (default: 5)
 * @param options.initialDelay - Initial delay in milliseconds (default: 10ms)
 * @param options.logger - Optional logger for debugging retry attempts
 * @throws Error if removal fails after all retries or encounters non-retryable error
 *
 * @example
 * ```ts
 * rmSyncWithRetry(tempDir, { recursive: true, force: true, logger });
 * ```
 */
export function rmSyncWithRetry(
  targetPath: string,
  options: {
    recursive?: boolean;
    force?: boolean;
    maxRetries?: number;
    initialDelay?: number;
    logger?: Logger;
  } = {},
): void {
  const { recursive = false, force = false, maxRetries = 5, initialDelay = 10, logger } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.rmSync(targetPath, { recursive, force });
      return; // Success!
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      lastError = err;

      // Only retry on file locking errors
      if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
        if (attempt < maxRetries - 1) {
          const delay = initialDelay * 2 ** attempt;
          logger?.log(
            `Directory locked, retrying removal in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
            "debug",
          );
          // Synchronous sleep using busy-wait (not ideal but necessary for sync context)
          const start = Date.now();
          while (Date.now() - start < delay) {
            // Busy wait
          }
          continue;
        }
      }

      // Non-retryable error or max retries exceeded
      throw error;
    }
  }

  // Should never reach here, but TypeScript doesn't know that
  throw lastError || new Error("Remove failed after retries");
}

// -------------
// Server Utilities
// -------------

/**
 * Abstraction over server instances providing a common interface.
 * This allows the codebase to be runtime-agnostic.
 */
export interface HankweaveServer {
  /** Stop the server and clean up resources */
  stop(): void;
  /** The actual port the server is listening on (may differ from configured port if 0 was specified) */
  readonly port: number;
}

/**
 * Runtime-agnostic WebSocket interface.
 * Provides a common interface that works across Bun, Node.js, and other runtimes.
 */
export interface HankweaveWebSocket<T = unknown> {
  /** Custom data attached to this WebSocket connection */
  data: T;
  /** Send a message to the client */
  send(message: string | Buffer): void;
  /** Close the WebSocket connection */
  close(code?: number, reason?: string): void;
}

/**
 * Configuration options for creating an HTTP or WebSocket server.
 * Provides a runtime-agnostic interface for both HTTP and WebSocket servers.
 *
 * The generic type T represents the WebSocket connection data type.
 */
export interface ServeOptions<T = unknown> {
  /** Port number to listen on */
  port: number;
  /** Idle timeout in seconds (optional, only for HTTP servers) */
  idleTimeout?: number;
  /** HTTP request handler (required for HTTP servers) */
  fetch?: (request: Request, server?: unknown) => Response | Promise<Response> | undefined;
  /** WebSocket handlers (required for WebSocket servers) */
  websocket?: {
    /**
     * Called before upgrading to WebSocket.
     * Return context data to attach to the connection.
     */
    upgrade?: (request: Request) => T | Promise<T>;
    /** Called when a WebSocket connection is opened */
    open?: (ws: HankweaveWebSocket<T>) => void;
    /** Called when a message is received on the WebSocket */
    message?: (ws: HankweaveWebSocket<T>, message: string | Buffer) => void;
    /** Called when a WebSocket connection is closed */
    close?: (ws: HankweaveWebSocket<T>) => void;
  };
}

/**
 * Adapter that wraps a crossws Peer to provide the Hank weave WebSocket interface.
 * Maps Peer.context to .data and adapts method signatures.
 */
class PeerAdapter<T> implements HankweaveWebSocket<T> {
  constructor(private peer: Peer) {
    // Initialize context if it doesn't exist
    if (!this.peer.context) {
      // biome-ignore lint/suspicious/noExplicitAny: crossws Peer type doesn't expose context setter
      (this.peer as any).context = {};
    }
  }

  get data(): T {
    return this.peer.context as T;
  }

  set data(value: T) {
    // Cannot replace context object (readonly), so update its properties
    const context = this.peer.context as Record<string, unknown>;
    // Clear existing properties
    for (const key in context) {
      delete context[key];
    }
    // Copy new properties
    Object.assign(context, value);
  }

  send(message: string | Buffer): void {
    this.peer.send(message);
  }

  close(code?: number, reason?: string): void {
    this.peer.close(code, reason);
  }
}

/**
 * Create an HTTP or WebSocket server using crossws.
 *
 * This provides a runtime-agnostic interface that works with Bun, Node.js, Deno,
 * and other runtimes via the crossws library.
 *
 * @param options - Server configuration options
 * @returns Server instance with stop() method
 *
 * @example
 * // HTTP server
 * const server = serve({
 *   port: 3000,
 *   fetch: async (req) => new Response("Hello"),
 * });
 *
 * @example
 * // WebSocket server
 * const server = serve({
 *   port: 8080,
 *   websocket: {
 *     open: (ws) => console.log("connected"),
 *     message: (ws, msg) => console.log(msg),
 *   },
 *   fetch: (req, server) => server.upgrade(req),
 * });
 */
export function serve<T = unknown>(options: ServeOptions<T>): HankweaveServer {
  // Convert our options to crossws format
  // biome-ignore lint/suspicious/noExplicitAny: crossws options type is complex and runtime-specific
  const crosswsOptions: any = {
    port: options.port,
    fetch: options.fetch,
  };

  // If WebSocket handlers are provided, wrap them with adapters
  if (options.websocket) {
    const { upgrade, open, message, close } = options.websocket;

    // Map to maintain consistent adapter instances per peer
    const peerAdapters = new WeakMap<Peer, PeerAdapter<T>>();

    const getAdapter = (peer: Peer): PeerAdapter<T> => {
      let adapter = peerAdapters.get(peer);
      if (!adapter) {
        adapter = new PeerAdapter<T>(peer);
        peerAdapters.set(peer, adapter);
      }
      return adapter;
    };

    crosswsOptions.websocket = {
      upgrade: upgrade
        ? async (req: Request) => {
            const context = await upgrade(req);
            return { context };
          }
        : undefined,

      open: open
        ? (peer: Peer) => {
            open(getAdapter(peer));
          }
        : undefined,

      message: message
        ? (peer: Peer, msg: Message) => {
            // Convert Message to string or Buffer
            const data = msg.rawData;
            const messageData =
              typeof data === "string" || Buffer.isBuffer(data) ? data : msg.text();
            message(getAdapter(peer), messageData);
          }
        : undefined,

      close: close
        ? (peer: Peer) => {
            close(getAdapter(peer));
          }
        : undefined,
    };
  }

  const server = crosswsServe(crosswsOptions);

  return {
    stop: () => {
      // crossws servers have a close() method
      if (server && typeof server.close === "function") {
        server.close();
      }
    },
    get port(): number {
      // biome-ignore lint/suspicious/noExplicitAny: Different server types have different APIs
      const s = server as any;

      // 1. crossws Bun adapter: actual Bun server is in .bun.server
      if (s.bun?.server?.port) {
        return s.bun.server.port;
      }

      // 2. crossws Bun adapter alternative: .bun.port
      if (s.bun?.port) {
        return s.bun.port;
      }

      // 3. Direct Bun server (has .port property directly)
      if (s.port) {
        return s.port;
      }

      // 4. Node.js HTTP server (try various property names used by different adapters)
      // srvx NodeServer stores the http.Server at .node.server (not .node directly)
      const possibleHttpServers = [
        s.node?.server,
        s.server,
        s._server,
        s.node,
        s.httpServer,
      ].filter(Boolean);
      for (const httpServer of possibleHttpServers) {
        if (typeof httpServer.address === "function") {
          const addr = httpServer.address();
          if (addr && typeof addr === "object" && "port" in addr) {
            return addr.port;
          }
        }
      }

      // 5. Universal: srvx servers expose a .url getter after listening (works for Deno, Node, Bun)
      if (typeof s.url === "string") {
        try {
          const parsed = new URL(s.url);
          if (parsed.port) {
            return Number.parseInt(parsed.port, 10);
          }
        } catch {
          // URL parse failed, fall through
        }
      }

      // 6. Fallback to configured port
      return options.port ?? 0;
    },
  };
}
