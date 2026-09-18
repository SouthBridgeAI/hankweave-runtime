/**
 * `hankweave pack` — the phase-2 CLI: lint + lock + bundle emission.
 *
 * Pipeline: parse args → computeClosure → print findings → buildLock →
 * canonical tar → zstd → atomic publish → sidecar lock. The pack parser
 * owns its whole flag namespace (nothing here touches the run-mode
 * parser), and `--check` returns after printing findings — no lock, no
 * archive, no sidecar, no zstd probe (phase-2 issues 05/06/14).
 *
 * ## Output
 *
 * Findings print to stdout, grouped by severity, category, and location;
 * a finding's runtime-dependent note (a JSON engine's message) prints to
 * stderr so stdout is identical across Bun and Node.
 * Bundle details and the file tree print to stderr after publication.
 * Both streams use the same structured layout when redirected; color is
 * detected per stream from terminal capability. Authored
 * control characters are escaped, and finding order is deterministic.
 *
 * ## Exit codes (issue 14)
 *
 * 0 = success (warnings allowed) · 1 = lint errors or pack failure
 * (zstd missing, write failure, unsafe output) · 2 = usage error.
 *
 * ## Publication (issues 02/03/04/05)
 *
 * The destination must end in `.hank` or `.tar.zst` (phase 3 recognizes
 * bundles by suffix) and may not alias an input: the source config, any
 * captured source file, the sidecar slot, or anything under a copy.from
 * tree. Writes stage to a random-named exclusively-created (O_EXCL,
 * umask-independent 0644) sibling and commit via rename — an existing
 * regular file or symlink at the destination is atomically replaced, a
 * directory is refused, a missing parent is refused. This is
 * process-crash safety, not power-loss durability (no fsync). The bundle
 * rename is THE commit point; the sidecar `hank.lock` (byte-identical to
 * the embedded lock) publishes after it, and a sidecar failure reports
 * partial state: the bundle on disk is already valid. The pair publishes
 * under a per-hank `.hankweave-pack-lock` file so concurrent packs of the
 * same source cannot interleave bundle and sidecar commits. With --no-lock,
 * only the bundle is published; no source-side lock is acquired or written.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { compareUtf8, isBundlePath } from "../utils.js";
import {
  type ClosureResult,
  computeClosure,
  type LintFinding,
  portableNameProblem,
  RESERVED_LOCK_PATH,
} from "./closure.js";
import { buildLock, serializeLock } from "./lock.js";
import { parseSemVer } from "./semver.js";
import { type TarMember, writeCanonicalTar } from "./tar.js";
import { ZstdUnavailableError, zstdCompress } from "./zstd.js";

// -------------
// Argument parsing (issue 14)
// -------------

export class PackUsageError extends Error {}

export interface PackArgs {
  hankPathOrDir: string;
  /** Explicit -o/--output destination; null = derive the default name. */
  output: string | null;
  check: boolean;
  noLock: boolean;
  /** Validated canonical SemVer, or null = default to our own version. */
  minRuntime: string | null;
  help: boolean;
}

const PACK_USAGE = `Usage: hankweave pack [hankPathOrDir] [options]

Create a deterministic .hank bundle (a zstd-compressed PAX tar containing
the hank's full file closure plus its hank.lock), after a portability lint.

Arguments:
  hankPathOrDir             Path to hank.json or its directory (default: .)
                            Use -- before a path that starts with "-".

Options:
  -o, --output <path>       Bundle destination; must end in .hank or .tar.zst
                            (default: <slug>-<version>.hank in the current
                            directory). Not allowed with --check.
  --no-lock                 Write only the bundle; skip source lock files
  --check                   Lint only: print findings and exit; writes nothing
  --min-runtime <semver>    Minimum Hankweave version recorded in the lock
                            (canonical SemVer 2.0.0; default: this version)
  -h, --help                Show this help

Pack writes hank.lock next to hank.json (and a temporary .hankweave-pack-lock
while publishing), so the hank directory must be writable unless --no-lock
is used. Commit hank.lock to track the packed inputs; use --no-lock when
you only need the bundle. The bundle always contains its own hank.lock.
The default name slug lowercases the hank name and replaces characters outside
[a-z0-9._-] with hyphens; path separators and control characters are refused.

Exit codes: 0 success (warnings allowed), 1 lint errors or pack failure,
2 usage error. Findings print to stdout; bundle details print to stderr.
Output groups findings and shows the bundle tree, including when piped.
Color is enabled for supported terminals and disabled when redirected.`;

interface PackParseState {
  output: string | null;
  minRuntime: string | null;
  check: boolean;
  noLock: boolean;
  help: boolean;
  seenOutput: boolean;
  seenMinRuntime: boolean;
}

function setPackOutput(state: PackParseState, readValue: () => string): void {
  if (state.seenOutput) throw new PackUsageError("duplicate -o/--output");
  state.seenOutput = true;
  state.output = readValue();
}

function setPackMinRuntime(state: PackParseState, readValue: () => string): void {
  if (state.seenMinRuntime) throw new PackUsageError("duplicate --min-runtime");
  state.seenMinRuntime = true;
  state.minRuntime = readValue();
}

const PACK_BOOLEAN_FLAGS = new Map<string, "help" | "check" | "noLock">([
  ["-h", "help"],
  ["--help", "help"],
  ["--check", "check"],
  ["--no-lock", "noLock"],
]);

function applyPackFlag(
  flag: string,
  inline: string | undefined,
  takeValue: (flag: string, inline: string | undefined) => string,
  state: PackParseState,
): void {
  const booleanKey = PACK_BOOLEAN_FLAGS.get(flag);
  if (booleanKey !== undefined) {
    if (inline !== undefined) throw new PackUsageError(`${flag} takes no value`);
    state[booleanKey] = true;
    return;
  }
  switch (flag) {
    case "-o":
    case "--output":
      setPackOutput(state, () => takeValue(flag, inline));
      break;
    case "--min-runtime":
      setPackMinRuntime(state, () => takeValue(flag, inline));
      break;
    default:
      throw new PackUsageError(`unknown option ${flag}`);
  }
}

function validatePackOptions(state: PackParseState): void {
  const { check, output, minRuntime } = state;
  if (check && output !== null) {
    throw new PackUsageError("--check emits no archive; -o/--output is not allowed with it");
  }
  if (output !== null && !isBundlePath(output)) {
    throw new PackUsageError(
      `output must end in .hank or .tar.zst so the runner can recognize it (got ${JSON.stringify(output)})`,
    );
  }
  if (minRuntime !== null && parseSemVer(minRuntime) === null) {
    throw new PackUsageError(
      `--min-runtime ${JSON.stringify(minRuntime)} is not a canonical SemVer 2.0.0 version (e.g. 1.2.3)`,
    );
  }
}

function finishPackArgs(positionals: string[], state: PackParseState): PackArgs {
  const { help, check, noLock, output, minRuntime } = state;
  if (positionals.length > 1) {
    throw new PackUsageError(`expected at most one hank path, got ${positionals.length}`);
  }
  if (help) {
    return {
      hankPathOrDir: ".",
      output: null,
      check: false,
      noLock: false,
      minRuntime: null,
      help: true,
    };
  }
  validatePackOptions(state);
  return {
    hankPathOrDir: positionals[0] ?? ".",
    output,
    check,
    noLock,
    minRuntime,
    help: false,
  };
}

/** Parse pack's argv (after the `pack` word). Throws PackUsageError. */
export function parsePackArgs(argv: readonly string[]): PackArgs {
  const positionals: string[] = [];
  const state: PackParseState = {
    output: null,
    minRuntime: null,
    check: false,
    noLock: false,
    help: false,
    seenOutput: false,
    seenMinRuntime: false,
  };

  let i = 0;
  const takeValue = (flag: string, inline: string | undefined): string => {
    if (inline !== undefined) return inline;
    i++;
    const next = argv[i];
    if (next === undefined) throw new PackUsageError(`${flag} requires a value`);
    return next;
  };

  for (; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    applyPackFlag(flag, inline, takeValue, state);
  }

  return finishPackArgs(positionals, state);
}

// -------------
// Findings and bundle presentation
// -------------

const SEVERITY_ORDER = { error: 0, warn: 1 } as const;

/** Deterministic finding order: errors first, then category, where,
 * detail — all bytewise. Stable across machines and runtimes. */
export function sortFindings(findings: readonly LintFinding[]): LintFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      compareUtf8(a.category, b.category) ||
      compareUtf8(a.where, b.where) ||
      compareUtf8(a.detail, b.detail),
  );
}

/** Color follows terminal capability, independently of the output layout. */
export function usePackColor(isTTY: boolean, env: NodeJS.ProcessEnv): boolean {
  return isTTY && env.TERM !== "dumb";
}

function paint(text: string, code: number, color: boolean): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** Keep authored text readable without allowing control sequences or forged lines. */
function displayText(text: string): string {
  return JSON.stringify(text)
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

function renderFindingGroup(group: readonly LintFinding[], color: boolean): string {
  const lines: string[] = [];
  const first = group[0];
  const label = first.severity === "error" ? "ERROR" : "WARN";
  lines.push(
    "",
    `  ${paint(`${label} ${first.category}`, first.severity === "error" ? 31 : 33, color)} ${paint(`(${group.length})`, 2, color)}`,
  );
  let previousWhere: string | undefined;
  for (const finding of group) {
    if (finding.where !== previousWhere) {
      lines.push(`    ${paint(displayText(finding.where), 1, color)}`);
      previousWhere = finding.where;
    }
    lines.push(`      • ${displayText(finding.detail)}`);
  }
  return lines.join("\n");
}

export function renderFindings(findings: readonly LintFinding[], color: boolean): string {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  const lines = ["", paint("Portability check", 1, color)];
  const groups = new Map<string, LintFinding[]>();
  for (const finding of sortFindings(findings)) {
    const key = `${finding.severity}/${finding.category}`;
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    lines.push(renderFindingGroup(group, color));
  }
  const summary = `${errors} ${errors === 1 ? "error" : "errors"} · ${warnings} ${warnings === 1 ? "warning" : "warnings"}`;
  lines.push("", `  ${paint(summary, errors > 0 ? 31 : warnings > 0 ? 33 : 32, color)}`);
  if (errors > 0) lines.push("  Resolve the errors above before packing.");
  return lines.join("\n");
}

/** One stderr line per finding that carries a runtime-dependent note. */
function renderFindingNotes(findings: readonly LintFinding[]): string[] {
  return sortFindings(findings)
    .filter((finding) => finding.note !== undefined)
    .map((finding) => `note: ${displayText(finding.where)}: ${displayText(finding.note ?? "")}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

interface TreeNode {
  children: Map<string, TreeNode>;
  member?: TarMember;
}

/** What happened around the archive that the tree alone does not show. */
export interface BundleDetails {
  /** runtime.min as recorded in the lock: the one bundleHash input that
   * defaults silently (to this build's version), so it is always shown. */
  minRuntime: string;
  warnings: number;
  /** The sidecar hank.lock published beside the source config. */
  sidecar: string | null;
}

/** Render the exact logical members passed to the tar writer, including hank.lock. */
export function renderBundle(
  destination: string,
  bundleHash: string,
  members: readonly TarMember[],
  compressedBytes: number,
  color: boolean,
  details?: BundleDetails,
): string {
  const root: TreeNode = { children: new Map() };
  let totalBytes = 0;
  for (const member of members) {
    totalBytes += member.bytes.length;
    let node = root;
    for (const segment of member.path.split("/")) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.member = member;
  }
  const lines = [
    "",
    paint(`Packed ${displayText(destination)}`, 32, color),
    "",
    `  ${paint(displayText(path.basename(destination)), 1, color)}`,
  ];
  // Iterative traversal also handles deeply nested, valid member paths.
  const pending: Array<{ node: TreeNode; prefix: string; line?: string }> = [
    { node: root, prefix: "  " },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.line !== undefined) lines.push(current.line);
    const children = [...current.node.children.entries()].sort(
      ([aName, a], [bName, b]) =>
        Number(!!a.member) - Number(!!b.member) || compareUtf8(aName, bName),
    );
    // Stack entries carry rendered lines so parent/child order is preserved.
    const visit = children.map(([name, node], index) => {
      const last = index === children.length - 1;
      const branch = last ? "└── " : "├── ";
      const member = node.member;
      const label = member ? displayText(name) : paint(`${displayText(name)}/`, 36, color);
      const metadata = member
        ? paint(
            `  ${formatBytes(member.bytes.length)}${member.mode === "755" ? " · executable" : ""}`,
            2,
            color,
          )
        : "";
      return {
        node,
        prefix: current.prefix + (last ? "    " : "│   "),
        line: `${paint(current.prefix + branch, 2, color)}${label}${metadata}`,
      };
    });
    for (const entry of visit.reverse()) pending.push(entry);
  }
  lines.push(
    "",
    `  ${members.length} files · ${formatBytes(totalBytes)} unpacked · ${formatBytes(compressedBytes)} compressed`,
    `  ${paint(`bundleHash ${displayText(bundleHash)}`, 2, color)}`,
  );
  if (details) lines.push(...renderBundleDetails(details, color));
  return lines.join("\n");
}

function renderBundleDetails(details: BundleDetails, color: boolean): string[] {
  const warnings = `${details.warnings} ${details.warnings === 1 ? "warning" : "warnings"}`;
  return [
    `  ${paint(`runtime.min ${displayText(details.minRuntime)} · ${warnings}`, 2, color)}`,
    ...(details.sidecar === null
      ? []
      : [`  ${paint(`wrote hank.lock to ${displayText(details.sidecar)}`, 2, color)}`]),
  ];
}

// -------------
// Output destination (issues 02/03)
// -------------

/**
 * The default bundle filename, or null when the metadata cannot form one
 * safe cwd-child filename (the caller tells the user to pass -o). The
 * SOURCE inputs stay verbatim in the lock — this is display-side only.
 */
export function defaultBundleFilename(closure: ClosureResult): string | null {
  const raw = closure.raw as Record<string, unknown>;
  const meta = (raw.meta as Record<string, unknown> | undefined) ?? {};
  const name =
    typeof meta.name === "string" ? meta.name : path.basename(path.resolve(closure.hankDir));
  const version = typeof meta.version === "string" ? meta.version : "unversioned";
  // Keep path/control rejection before slugging so unsafe metadata is not
  // silently reinterpreted as a filename. The source metadata stays verbatim.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in authored metadata.
  if (/[/\\\x00-\x1f\x7f]/.test(name)) return null;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return null;
  const filename = `${slug}-${version}.hank`;
  const ok =
    !/\s/.test(filename) &&
    !filename.includes("/") &&
    !filename.includes("\0") &&
    !filename.startsWith("-") &&
    filename !== "." &&
    filename !== ".." &&
    Buffer.byteLength(filename, "utf8") <= 255 &&
    portableNameProblem(filename) === null;
  return ok ? filename : null;
}

function chooseBundleTarget(closure: ClosureResult, explicitOutput: string | null): string {
  let target: string;
  if (explicitOutput !== null) {
    target = path.resolve(explicitOutput);
  } else {
    const filename = defaultBundleFilename(closure);
    if (filename === null) {
      throw new Error("meta.name/meta.version do not form a safe filename; pass -o <path>.hank");
    }
    target = path.resolve(process.cwd(), filename);
  }

  return target;
}

function canonicalizeOutputParent(target: string): string {
  const parent = path.dirname(target);
  let parentStat: fs.Stats;
  try {
    parentStat = fs.statSync(parent);
  } catch {
    throw new Error(`output directory ${parent} does not exist`);
  }
  if (!parentStat.isDirectory()) {
    throw new Error(`output directory ${parent} is not a directory`);
  }
  // Canonicalize the physical parent (it exists — just statted) so a
  // symlinked output directory cannot spell the destination past the
  // alias checks below; the final component is the entry rename replaces
  // and is never resolved through.
  target = path.join(fs.realpathSync.native(parent), path.basename(target));
  return target;
}

function physicalInputPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function statBundleDestination(target: string): fs.Stats | null {
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(target);
  } catch {
    // absent — fine
  }
  if (existing?.isDirectory()) {
    throw new Error(`output ${target} is a directory`);
  }

  return existing;
}

function checkDestinationInputs(
  closure: ClosureResult,
  target: string,
  existing: fs.Stats | null,
): void {
  const sidecar = path.join(physicalInputPath(closure.hankDir), RESERVED_LOCK_PATH);
  if (target === physicalInputPath(closure.hankJsonPath) || target === sidecar) {
    throw new Error(`output ${target} would overwrite a pack input`);
  }
  // Host-filesystem name equivalence: when an entry already exists at the
  // destination, compare it against every input by lstat identity — the
  // only check that sees "-o asset.hank" aliasing an input Asset.hank
  // where names fold. A symlink at the destination is its own inode, so
  // one pointing AT an input still gets atomically replaced, never
  // followed (existing behavior, documented above).
  const aliasesExisting = (p: string): boolean => {
    if (existing === null) return false;
    try {
      const st = fs.lstatSync(p);
      return st.dev === existing.dev && st.ino === existing.ino;
    } catch {
      return false;
    }
  };
  if (aliasesExisting(closure.hankJsonPath) || aliasesExisting(sidecar)) {
    throw new Error(`output ${target} would overwrite a pack input`);
  }
  for (const entry of closure.files) {
    if (entry.sourcePath === "") continue;
    if (target === physicalInputPath(entry.sourcePath) || aliasesExisting(entry.sourcePath)) {
      throw new Error(`output ${target} would overwrite captured source file ${entry.bundlePath}`);
    }
  }
}

function checkDestinationCopyRoots(closure: ClosureResult, target: string): void {
  for (const record of closure.refs.values()) {
    if (record.kind !== "dir") continue;
    const root = physicalInputPath(record.resolved);
    if (target === root || target.startsWith(root + path.sep)) {
      throw new Error(
        `output ${target} is inside the copy.from tree ${record.raw}; it would be swept into the next pack`,
      );
    }
  }
}

/**
 * Resolve and vet the final bundle path. Errors are user-facing pack
 * failures (exit 1), not usage errors. Guards: recognized suffix was
 * enforced at parse time; here the destination must not alias the source
 * config, any captured source file, the sidecar slot, or anything under a
 * traversed copy.from tree — and its parent must already exist. Rename
 * replaces the destination DIRECTORY ENTRY (it does not follow a final
 * symlink or write through hardlinks), so the guards compare at that
 * level — but PHYSICAL paths, not authored spellings: the parent chain is
 * canonicalized (native realpath: symlinks resolved, on-disk case), and a
 * destination entry that already exists is compared against the inputs by
 * lstat identity, because on case-insensitive / Unicode-normalizing
 * filesystems (default macOS, Windows) "-o asset.hank" addresses the same
 * directory entry as an input named Asset.hank even though no string
 * comparison can see it. The identity check refuses a destination
 * hardlinked to an input too — conservative, and the message stays honest.
 */
export function resolveBundleDestination(
  closure: ClosureResult,
  explicitOutput: string | null,
): string {
  const target = canonicalizeOutputParent(chooseBundleTarget(closure, explicitOutput));
  const existing = statBundleDestination(target);
  checkDestinationInputs(closure, target, existing);
  checkDestinationCopyRoots(closure, target);
  return target;
}

// -------------
// Atomic publication (issues 04/05)
// -------------

/**
 * Stage-and-rename with exclusive creation: a random-named staging file
 * is created O_EXCL in the destination directory (same filesystem, so
 * rename is atomic), fchmod'd to 0644 (umask-independent), written
 * through the returned handle, closed, then renamed over the final path.
 * Pre-existing staging entries — a guessed symlink, hardlink, file, or
 * directory — fail the O_EXCL open instead of being written through.
 * Handled failures unlink only this invocation's staging path.
 */
export function atomicPublish(finalPath: string, bytes: Buffer): void {
  const staging = path.join(
    path.dirname(finalPath),
    `.hankweave-staging-${crypto.randomBytes(9).toString("hex")}`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      staging,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o644,
    );
    fs.fchmodSync(fd, 0o644);
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(staging, finalPath);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(staging);
    } catch {}
    throw error;
  }
}

// -------------
// Publication serialization
// -------------

function readPublishLockHolder(lockPath: string): { alive: boolean; pid: number | null } {
  try {
    const contents = fs.readFileSync(lockPath, "utf8").trim();
    const pid = /^\d+$/.test(contents) ? Number(contents) : NaN;
    if (Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff) {
      try {
        process.kill(pid, 0);
        return { alive: true, pid };
      } catch (probe) {
        // EPERM = alive under another user; only ESRCH proves death.
        return { alive: (probe as NodeJS.ErrnoException).code !== "ESRCH", pid };
      }
    }
  } catch {
    // Unreadable or already gone — treat as stale and retry the create.
  }
  return { alive: false, pid: null };
}

/**
 * Serialize the bundle+sidecar publication pair per hank dir. Two
 * concurrent packs of the same source can otherwise interleave their two
 * commit points (A-bundle, B-bundle, B-sidecar, A-sidecar) so that both
 * report success while the destination bundle embeds one lock and the
 * sidecar `hank.lock` holds the other. An O_EXCL lock file holding our
 * pid makes the pair atomic with respect to other packs of this hank: a
 * live holder is a concurrent pack — refuse cleanly rather than
 * interleave — while a dead holder's lock is removed and retaken once.
 * (The stale takeover has a narrow two-reapers race; both would then
 * proceed, which is exactly today's behavior, never worse.) Returns the
 * release function; callers release in `finally`.
 */
function publishLockWriteError(lockPath: string, error: unknown): Error {
  // Name the file and the reason pack needs it: the user asked for a
  // bundle elsewhere and never mentioned the hank directory (issue 18).
  const code = (error as NodeJS.ErrnoException).code;
  const reason =
    code === "EACCES" || code === "EPERM" || code === "EROFS"
      ? "permission denied"
      : (code ?? (error instanceof Error ? error.message : String(error)));
  return new Error(
    `cannot write ${lockPath} (${reason}); pack writes hank.lock and a temporary lock file into the hank directory, which must be writable`,
  );
}

/** O_EXCL-create the lock holding our pid. False = someone else holds it. */
function tryCreatePublishLock(lockPath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o644,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw publishLockWriteError(lockPath, error);
  }
  try {
    fs.writeSync(fd, `${process.pid}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

export function acquirePublishLock(
  hankDir: string,
  onStaleTakeover?: (lockPath: string, pid: number | null) => void,
): () => void {
  const lockPath = path.join(hankDir, ".hankweave-pack-lock");
  const heldByLivePack = () =>
    new Error(
      `another hankweave pack is publishing this hank (lock ${lockPath}); retry when it finishes`,
    );
  if (!tryCreatePublishLock(lockPath)) {
    const holder = readPublishLockHolder(lockPath);
    if (holder.alive) throw heldByLivePack();
    try {
      fs.unlinkSync(lockPath);
      onStaleTakeover?.(lockPath, holder.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw publishLockWriteError(lockPath, error);
      }
    }
    // Retaken between our unlink and create: a live pack, refuse cleanly.
    if (!tryCreatePublishLock(lockPath)) throw heldByLivePack();
  }
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  };
}

// -------------
// The command
// -------------

export interface PackIo {
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
  out(line: string): void;
  err(line: string): void;
}

const processIo: PackIo = {
  get stdoutIsTTY() {
    return process.stdout.isTTY ?? false;
  },
  get stderrIsTTY() {
    return process.stderr.isTTY ?? false;
  },
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

interface BundlePublication {
  destination: string;
  compressed: Buffer;
  sidecar: string | null;
  lockBytes: Buffer;
}

/** Publish the bundle and optional sidecar, reporting partial publication failures. */
function publishPackBundle(publication: BundlePublication, io: PackIo): boolean {
  const { destination, compressed, sidecar, lockBytes } = publication;
  // Bundle-only publication needs no source-directory writes or pair lock.
  if (sidecar === null) {
    atomicPublish(destination, compressed);
    return true;
  }

  // Serialize both commits so simultaneous normal packs cannot mix their bytes.
  const release = acquirePublishLock(path.dirname(sidecar), (lockPath, pid) =>
    io.err(
      `took over a stale pack lock at ${displayText(lockPath)}; ${pid === null ? "unreadable holder PID" : `left by dead pid ${pid}`}`,
    ),
  );
  try {
    // THE commit point: the bundle remains valid even if sidecar publication fails.
    atomicPublish(destination, compressed);
    try {
      atomicPublish(sidecar, lockBytes);
    } catch (error) {
      io.err(
        `Error: bundle published at ${destination}, but writing the sidecar ${sidecar} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    return true;
  } finally {
    release();
  }
}

function emitPackBundle(closure: ClosureResult, args: PackArgs, io: PackIo): number {
  try {
    const lock = buildLock(
      closure,
      args.minRuntime !== null ? { minRuntime: args.minRuntime } : undefined,
    );
    const lockBytes = Buffer.from(serializeLock(lock), "utf8");
    const destination = resolveBundleDestination(closure, args.output);
    // Resolved paths serve the safety checks; the user sees the path as
    // typed (or the derived default filename), never the realpath.
    const shownDestination = args.output ?? path.basename(destination);
    const sidecar = args.noLock ? null : path.join(closure.hankDir, RESERVED_LOCK_PATH);

    const members: TarMember[] = [
      { path: RESERVED_LOCK_PATH, bytes: lockBytes, mode: "644" },
      ...closure.files.map((entry) => ({
        path: entry.bundlePath,
        bytes: entry.bytes,
        mode: entry.mode,
      })),
    ];
    const tar = writeCanonicalTar(members);
    // Only now — after lint passed and an archive is definitely being
    // emitted — is the compressor loaded/probed (issue 06).
    const compressed = zstdCompress(tar);

    if (!publishPackBundle({ destination, compressed, sidecar, lockBytes }, io)) return 1;

    io.err(
      renderBundle(
        shownDestination,
        lock.bundleHash,
        members,
        compressed.length,
        usePackColor(io.stderrIsTTY ?? false, process.env),
        {
          minRuntime: lock.runtime.min,
          warnings: closure.findings.filter((f) => f.severity === "warn").length,
          sidecar,
        },
      ),
    );
    return 0;
  } catch (error) {
    if (error instanceof ZstdUnavailableError) {
      io.err(`Error: ${error.message}`);
      return 1;
    }
    io.err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Run `hankweave pack`. Returns the process exit code. */
export function runPackCommand(argv: readonly string[], io: PackIo = processIo): number {
  let args: PackArgs;
  try {
    args = parsePackArgs(argv);
  } catch (error) {
    if (error instanceof PackUsageError) {
      // The error is the message; the full usage block would bury it
      // (issue 18). --help prints it on request.
      io.err(`Error: ${error.message}`);
      io.err("Run 'hankweave pack --help' for usage.");
      return 2;
    }
    throw error;
  }
  if (args.help) {
    io.out(PACK_USAGE);
    return 0;
  }

  const closure = computeClosure(args.hankPathOrDir);
  io.out(renderFindings(closure.findings, usePackColor(io.stdoutIsTTY ?? false, process.env)));
  for (const line of renderFindingNotes(closure.findings)) io.err(line);
  if (!closure.ok) return 1;
  if (args.check) return 0;

  return emitPackBundle(closure, args, io);
}
