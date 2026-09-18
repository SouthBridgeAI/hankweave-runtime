/**
 * THE HANK DIRECTORY — file and reference operations for a hank:
 * the directory holding hank.json, its prompts, sentinel configs, and the
 * copy.from trees that rig setup copies into the agent workspace.
 *
 * The selected config file is exposed as `config` (HankConfigFile), which
 * owns entry-point reads and updates. HankRef owns each source reference
 * and its resolution base. Consumers share the directory and reference policy:
 *   - the loader (config.ts) validates refs and scans copy trees,
 *   - `hankweave pack` (pack/closure.ts) walks copy trees and reads refs,
 *   - the runtime (hankweave-runtime.ts) copies rig trees into the workspace.
 * They share ONE walk and ONE set of rules, so "a hank packs iff it runs"
 * holds by construction rather than by three hand-synchronized loops.
 *
 * What the module owns:
 *   - HankRef: portable relative spellings, resolution,
 *     validation, and reads. No escape above the root, no symlink on the
 *     route, never `.git`. Pure reference helpers and schemas live in utils.ts.
 *   - HankDir IGNORE RULES for copy trees: the single root `.gitignore`, or built-in
 *     defaults when that file is absent (root-only policy — nested rules files are
 *     rejected), judged by `git check-ignore` over an immutable rules-only
 *     mirror repo in a temp dir. The mirror snapshots the root rules once at
 *     first use, so a mid-walk edit changes nothing, and `.GITIGNORE` on a
 *     case-insensitive filesystem is consistently NOT the rules file.
 *   - THE COPY-TREE WALK: sorted (UTF-8 byte order, identical on every
 *     platform), lstat without following links, ignored entries pruned before
 *     any other gate, vanished entries reported in sorted position, and the
 *     three tree violations (symlink, special file, nested rules file)
 *     yielded as RefViolations in the loader's own words.
 *   - THE RIG COPY: fs.cp filtered by the same walk.
 *
 * Laziness: constructing a HankDir touches nothing. git is spawned and the
 * root `.gitignore` read only when a copy TREE is first judged — a hank with
 * no directory copies never pays for either, and a broken root `.gitignore`
 * only fails hanks it governs. `dispose()` removes the mirror; idempotent,
 * and a disposed instance re-initializes on its next tree question.
 *
 * Isolation: every git spawn runs with the curated environment from
 * git-support.ts. The one in-process exception to "git decides": `.git`
 * itself (git never reports it as ignored, and an authored `!.git` would
 * outrank the defaults), answered ignored before git is asked.
 *
 * Verdict-producing commands are fail-closed: a spawn failure, an unexpected
 * exit code, or ANY stderr output throws — git merely WARNS about unreadable
 * rule files while exiting 0/1, and "assume not ignored" is the fail-open
 * bug this class exists to kill.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "./execution-layout.js";
import { assertGitAvailable, containsGitComponent, gitEnv } from "./git-support.js";
import {
  checkRegularFile,
  compareUtf8,
  forbiddenRefSpelling,
  type RefViolation,
  refViolationMessage,
  toPosix,
} from "./utils.js";

// -------------
// Config file
// -------------

/** Config capture keeps refusal reasons separate so callers own diagnostics. */
export type UnboundedConfigSnapshotRead =
  | { kind: "file"; bytes: Buffer; stats: fs.Stats }
  | { kind: "irregular" };

export type ConfigSnapshotRead = UnboundedConfigSnapshotRead | { kind: "too-large"; size: number };

/** A selected config file, including hank.json and hankweave.json. Owns file
 * I/O; callers own JSON parsing, schema validation, and reference policy. */
export class HankConfigFile {
  /** Absolute entry-point path. Symlinks retain their spelling. */
  readonly path: string;

  /** Select a file without inspecting or reading it. */
  constructor(configPath: string) {
    this.path = path.resolve(configPath);
  }

  /** Select a config-file or hank-directory entry point, following symlinks.
   * Disk type wins over spelling (a directory may be named foo.json). When
   * inspection fails, a .json suffix means a file; otherwise use hank.json
   * inside the directory, keeping missing-input diagnostics predictable. */
  static fromInput(hankPathOrDir: string): HankConfigFile {
    const resolved = path.resolve(hankPathOrDir);
    let isDirectory: boolean | null = null;
    try {
      isDirectory = fs.statSync(resolved).isDirectory();
    } catch {
      // Keep the original spelling heuristic for an uninspectable input.
    }
    if (isDirectory === true) return new HankConfigFile(path.join(resolved, "hank.json"));
    if (isDirectory === false || resolved.endsWith(".json")) return new HankConfigFile(resolved);
    return new HankConfigFile(path.join(resolved, "hank.json"));
  }

  /** Capture the selected config, following entry-point symlinks. Metadata
   * and bytes use separate stat/read calls; the result is not cached.
   * Reject non-regular files and, when maxBytes is supplied, oversized files
   * before allocating their bytes. Omit options to read without a size limit.
   * Filesystem errors propagate. */
  readSnapshot(): UnboundedConfigSnapshotRead;
  readSnapshot(options: { maxBytes: number }): ConfigSnapshotRead;
  readSnapshot(options?: { maxBytes: number }): ConfigSnapshotRead {
    const stats = fs.statSync(this.path);
    if (!stats.isFile()) return { kind: "irregular" };
    if (options && stats.size > options.maxBytes) return { kind: "too-large", size: stats.size };
    return { kind: "file", bytes: fs.readFileSync(this.path), stats };
  }

  /** Rewrite an existing regular config file only when its text changes.
   * The caller supplies the transformation and handles read/write errors.
   * Missing and non-regular files are left alone. */
  updateText(transform: (text: string) => string): boolean {
    let source: UnboundedConfigSnapshotRead;
    try {
      source = this.readSnapshot();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
    if (source.kind === "irregular") return false;
    const text = source.bytes.toString("utf-8");
    const updated = transform(text);
    if (updated === text) return false;
    fs.writeFileSync(this.path, updated);
    return true;
  }
}

// -------------
// Reference types
// -------------

/** Absolute path produced by HankRef.path; spelling is preserved for absolute inputs. */
export type ResolvedPath = string & { readonly __hankRefResolved: unique symbol };

/** One source reference, with its authored spelling, resolution base, and
 * hank containment boundary. Construction and path resolution do no I/O;
 * validation is always a fresh filesystem check, never a cached promise. */
export class HankRef {
  readonly raw: string;
  readonly root: string;
  readonly baseDir: string;

  constructor(raw: string, options: { root: string; baseDir?: string }) {
    this.raw = raw;
    this.root = path.resolve(options.root);
    this.baseDir = options.baseDir ?? this.root;
    if (!path.isAbsolute(this.baseDir)) {
      throw new Error(
        `Base directory for resolving "${raw}" must be absolute, got: ${this.baseDir === "" ? "(empty)" : this.baseDir}`,
      );
    }
  }

  /** Resolve an authored ref against `baseDir` (the hank root by default;
   * a file-based sentinel config's own directory for refs inside it). Pure
   * path math: absolute paths keep their exact spelling; relative paths
   * normalize against an absolute base. Empty refs and relative bases throw. */
  get path(): ResolvedPath {
    const { raw, baseDir } = this;
    if (raw === "") {
      throw new Error(`Cannot resolve an empty file reference (base dir: ${baseDir})`);
    }
    if (path.isAbsolute(raw)) {
      return raw as ResolvedPath;
    }
    return path.resolve(baseDir, raw) as ResolvedPath;
  }

  /** Capture an already vetted source. Metadata and bytes come
   * from one descriptor: O_NOFOLLOW refuses a substituted final symlink where
   * supported, and O_NONBLOCK lets fstat reject a substituted FIFO without
   * hanging on open. The descriptor is closed even when inspection/read fails.
   *
   * The caller validates the route before capture. This guarantees metadata
   * and bytes describe the same opened inode, not a point-in-time snapshot
   * against in-place writers. Ignore rules, caching, and hashing do not run.
   * Callers can supply their own diagnostic for a non-regular source. */
  readSnapshot(options: { irregularMessage?: string } = {}): { bytes: Buffer; stats: fs.Stats } {
    const resolved = this.path;
    const flags =
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const fd = fs.openSync(resolved, flags);
    try {
      const stats = fs.fstatSync(fd);
      if (!stats.isFile()) {
        throw new Error(
          options.irregularMessage ??
            `${resolved} is not a regular file (replaced while pack was running?)`,
        );
      }
      return { bytes: fs.readFileSync(fd), stats };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** R1+R2+R3: portable spelling, containment, and a symlink-free route.
   * Returns null or a violation. Only the hank anchor's ancestry
   * is canonicalized; below-hank components retain their authored spelling
   * so a symlinked base directory is rejected. A differently spelled alias
   * of the hank falls back to its physical base path.
   *
   * Missing/non-directory components defer to existence checks. Other disk
   * errors propagate. The verdict describes the filesystem at this call;
   * callers must revalidate rather than cache it across filesystem changes. */
  validate(): RefViolation | null {
    const { raw, baseDir } = this;
    const spelling = forbiddenRefSpelling(raw);
    if (spelling !== null) return { kind: spelling, raw };

    // R2: use the same lexical path that consumers resolve and read. Only
    // canonicalize the anchor, preserving symlinks below it for the R3 walk.
    const hankReal = fs.realpathSync(this.root);
    let baseRelHost = path.relative(this.root, path.resolve(baseDir));
    if (
      baseRelHost === ".." ||
      baseRelHost.startsWith(`..${path.sep}`) ||
      path.isAbsolute(baseRelHost)
    ) {
      baseRelHost = path.relative(hankReal, fs.realpathSync(baseDir));
    }
    const baseRel = baseRelHost.split(path.sep).join("/");
    const combined = path.posix.normalize(baseRel === "" ? raw : `${baseRel}/${raw}`);
    if (combined === ".." || combined.startsWith("../")) {
      return { kind: "escapes", raw, resolved: path.resolve(hankReal, combined) };
    }

    return this.validateRoute(hankReal, combined);
  }

  /** R3: inspect the contained route one component at a time. Stop at the
   * first symlink, even a dangling link or loop; missing components defer to
   * existence checks. lstat avoids case/Unicode comparison false positives. */
  private validateRoute(hankReal: string, combined: string): RefViolation | null {
    let current = hankReal;
    for (const part of combined === "." ? [] : combined.split("/")) {
      current = path.join(current, part);
      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
      if (stats.isSymbolicLink()) return { kind: "symlink", raw: this.raw, component: current };
    }
    return null;
  }

  /** Validate and read UTF-8 text. Violations and missing files use shared
   * wording with optional caller context; other filesystem errors propagate.
   * Non-regular files are rejected before reading so FIFOs cannot block. */
  readText(options: { what: string; context?: string }): { path: ResolvedPath; text: string } {
    const suffix = options.context ? `\n  (${options.context})` : "";
    const violation = this.validate();
    if (violation) {
      throw new Error(`${refViolationMessage(violation)}${suffix}`);
    }
    const resolved = this.path;
    // Missing paths fall through to read so ENOENT gets the caller's file
    // kind. Other read failures keep their original filesystem error.
    const problem = checkRegularFile(resolved, { read: false });
    if (problem?.kind === "irregular") {
      throw new Error(`${resolved} ${problem.phrase}`);
    }
    try {
      return { path: resolved, text: fs.readFileSync(resolved, "utf-8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new Error(`${options.what} not found: ${resolved}${suffix}`);
      }
      throw error;
    }
  }

  /** Recheck and inspect this source file. Applies ref policy and returns UTF-8
   * text plus the file's byte size. Warning thresholds and line counting
   * belong to the config layer; optional copy-tree ignore rules do not apply. */
  async inspect(): Promise<{ text: string; bytes: number }> {
    const resolved = this.path;
    const violation = this.validate();
    if (violation) throw new Error(refViolationMessage(violation));
    const stats = await fs.promises.stat(resolved);
    if (!stats.isFile()) throw new Error(`${resolved} is not a regular file`);
    const text = await fs.promises.readFile(resolved, "utf-8");
    return { text, bytes: stats.size };
  }

  /**
   * Does this reference name the hank directory itself — the one directory a copy
   * source may never name? Lexical by default (every spelling: ".", "./",
   * "sub/..", an absolute path). `physical` additionally follows symlinks,
   * for callers that copy from the live filesystem (pack snapshots instead);
   * an unresolvable path is simply not the root.
   */
  isRoot(options: { physical?: boolean } = {}): boolean {
    if (path.resolve(this.path) === this.root) return true;
    if (!options.physical) return false;
    try {
      return fs.realpathSync(this.path) === fs.realpathSync(this.root);
    } catch {
      return false;
    }
  }
}

// -------------
// Rules: the built-in defaults
// -------------

/** The one authored rules file, by exact directory-entry spelling. */
export const HANK_RULES_FILE = ".gitignore";

/** Built-in ignore rules for hank copy trees: VCS/OS junk plus common
 * dependency and build-output trees — the things that make a bundle huge and
 * machine-bound rather than portable. Used only when the root `.gitignore`
 * is absent; an authored file, even an empty one, replaces these defaults. */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  "node_modules/",
  `${ExecutionLayout.STATE_DIR}/`,
  ".DS_Store",
  "__pycache__/",
  "*.log",
  "dist/",
  "build/",
  "target/",
  ".venv/",
  "venv/",
  "coverage/",
  ".cache/",
];

/** Identity of the default list, recorded in hank.lock (advisory tier) so a
 * future hankweave whose defaults changed can WARN that a repack ran under
 * different built-in rules instead of silently drifting. */
export const DEFAULT_IGNORE_FINGERPRINT = crypto
  .createHash("sha256")
  .update(DEFAULT_IGNORE_PATTERNS.join("\n"))
  .digest("hex");

// -------------
// Types
// -------------

/** One git-check-ignore answer. */
export interface IgnoreVerdict {
  /** Hank-root-relative POSIX path, no leading "./". */
  rel: string;
  ignored: boolean;
  /** "source:line:pattern" of the matching rule (git check-ignore
   * --verbose), the built-in `.git` marker, or null when no rule matched. */
  rule: string | null;
}

/** Byte snapshot of the hank root's `.gitignore` — the ONE authored rules
 * file. These are the only rule bytes git ever sees (via the mirror), and
 * the exact bytes pack must ship. */
export interface RuleSourceSnapshot {
  bytes: Buffer;
  mode: "644" | "755";
}

/**
 * One directory-listing entry, fully classified. Ignored and broken entries
 * are included — a listing is never just the kept files, because the walk
 * consumers must SEE what they warn about, refuse, or prune.
 */
export interface DirEntry {
  name: string;
  /** Hank-root-relative POSIX path of the entry, no leading "./". */
  rel: string;
  /** lstat result (never follows symlinks), or null when the entry vanished
   * between readdir and lstat — `error` then carries the failure. */
  stats: fs.Stats | null;
  error?: unknown;
  ignored: boolean;
  /** "source:line:pattern" of the matching rule (git check-ignore
   * --verbose), the built-in `.git` marker, or null. */
  ignoredBy: string | null;
}

/**
 * What the copy-tree walk yields, in deterministic order: each kept
 * directory (root first) as a `dir` event, then its entries sorted by UTF-8
 * byte order, then its kept subdirectories in that same order (pre-order
 * depth-first). A `violation` ends the walk — the consumers all stop at the
 * first one. `vanished` (an entry deleted between readdir and lstat) and
 * `dir-error` (a directory that could not be listed) are reported, not
 * thrown, so each consumer keeps its own error strategy: the loader
 * propagates EACCES/EIO and passes ENOENT, pack records a finding.
 */
export type CopyTreeEntry =
  | { kind: "dir"; rel: string; entryCount: number }
  | { kind: "file"; rel: string; name: string; stats: fs.Stats }
  | { kind: "ignored"; rel: string; name: string; isDir: boolean; rule: string | null }
  | { kind: "vanished"; rel: string; name: string; error: unknown }
  | { kind: "dir-error"; rel: string; error: unknown }
  | { kind: "violation"; violation: RefViolation };

/** A copy-tree entry the ignore rules pruned (a directory counts as one),
 * with the matching rule for attribution. */
export interface IgnoredEntry {
  rel: string;
  by: string | null;
}

/**
 * THE sentence for "the ignore rules dropped these from a copy tree" —
 * shared by the validator (`--validate` and startup), the rig copy at run
 * time, and `hankweave pack`, so an author reads the same line wherever
 * they look. Attributed to the authored root .gitignore when any excluded
 * entry matched it; pure-default exclusions say so. `ignored` must be
 * non-empty.
 */
export function describeIgnoredEntries(ignored: readonly IgnoredEntry[]): string {
  const examples = ignored
    .slice(0, 3)
    .map((i) => i.rel)
    .join(", ");
  const authored = ignored.some((i) => i.by?.includes(HANK_RULES_FILE));
  return `${ignored.length} entr${ignored.length === 1 ? "y" : "ies"} excluded by ${
    authored ? "the hank .gitignore" : "the default ignore rules"
  }: ${examples}${ignored.length > 3 ? ", …" : ""}`;
}

// -------------
// The entity
// -------------

export class HankDir {
  /** Absolute, resolved path of the hank directory. */
  readonly root: string;
  /** Selected config file, defaulting to hank.json for a directory. */
  readonly config: HankConfigFile;

  private scratch: string | null = null;
  private mirror: string | null = null;
  /** The root .gitignore snapshot; undefined until the mirror exists. */
  private rootSource: RuleSourceSnapshot | null | undefined;
  private readonly verdicts = new Map<string, IgnoreVerdict>();

  /** Select a directory or config file without touching the filesystem. */
  constructor(source: string | HankConfigFile) {
    this.config =
      typeof source === "string"
        ? new HankConfigFile(path.join(path.resolve(source), "hank.json"))
        : source;
    this.root = path.dirname(this.config.path);
  }

  /** The hank directory a config file lives in, retaining the selected entry point. */
  static forConfig(configPath: string): HankDir {
    return new HankDir(new HankConfigFile(configPath));
  }

  /** Hank-root-relative POSIX spelling of an absolute path. */
  relative(abs: string): string {
    return toPosix(path.relative(this.root, abs));
  }

  /** Absolute path of a hank-root-relative POSIX path. */
  absolute(relPosix: string): string {
    return relPosix === "" ? this.root : path.join(this.root, ...relPosix.split("/"));
  }

  // -------------
  // Refs
  // -------------

  /** Bind an authored reference to this hank and its resolution base. */
  ref(raw: string, options: { baseDir?: string } = {}): HankRef {
    return new HankRef(raw, { root: this.root, baseDir: options.baseDir });
  }

  /** Reconstruct a reference from an already resolved absolute path. This
   * is for loader output and walked entries, never authored config values.
   * Policy is still checked by validate/readText/inspect when called. */
  refFromPath(absolutePath: string): HankRef {
    if (!path.isAbsolute(absolutePath)) {
      throw new Error(`Expected an absolute source path, got: ${absolutePath}`);
    }
    return this.ref(this.relative(absolutePath) || ".");
  }

  // -------------
  // Rules
  // -------------

  /**
   * Read the hank ROOT's explicit `.gitignore` (bytes and mode), or null when
   * absent. A symlinked or otherwise non-regular root `.gitignore` throws:
   * the rules govern what ships in a bundle, so they get the same no-symlink
   * treatment as every other pack input. ENOENT is the only silent case;
   * EACCES/EIO propagate like every other loader read. Only the exact
   * directory-entry spelling counts — a case-insensitive filesystem resolves
   * the lookup for `.GITIGNORE`, which is not the rules file on ANY platform.
   * The final read is O_NOFOLLOW so a symlink swapped in between the lstat
   * and the read still throws instead of being followed.
   */
  readRulesFile(): RuleSourceSnapshot | null {
    const rulesPath = path.join(this.root, HANK_RULES_FILE);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(rulesPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!fs.readdirSync(this.root).includes(HANK_RULES_FILE)) return null;
    if (stats.isSymbolicLink()) {
      throw new Error(
        `${HANK_RULES_FILE} at the hank root is a symlink (${rulesPath}); the copy-tree ignore rules must be a regular file`,
      );
    }
    const irregularMessage = `${HANK_RULES_FILE} at the hank root is not a regular file (${rulesPath}); the copy-tree ignore rules must be a regular file`;
    if (!stats.isFile()) throw new Error(irregularMessage);

    // Share the descriptor capture with ordinary references: refuse a
    // substituted symlink/FIFO and read bytes and metadata from one file.
    try {
      const snapshot = this.ref(HANK_RULES_FILE).readSnapshot({ irregularMessage });
      return { bytes: snapshot.bytes, mode: (snapshot.stats.mode & 0o111) !== 0 ? "755" : "644" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ELOOP/EMLINK: O_NOFOLLOW hit a symlink. ENOENT: vanished after lstat.
      if (["ELOOP", "EMLINK", "ENOENT"].includes(String(code))) {
        throw new Error(irregularMessage);
      }
      throw error;
    }
  }

  /** The hank root `.gitignore` the verdicts were judged with — exact bytes;
   * null when the hank has none (defaults only); undefined when no tree was
   * ever judged (no verdicts exist, so there is nothing to reconcile — and
   * forcing the lazy init here would break the contract that a hank with no
   * directory copies never reads .gitignore or spawns git). */
  rootRuleSource(): RuleSourceSnapshot | null | undefined {
    if (this.mirror === null) return undefined;
    return this.rootSource ?? null;
  }

  /** Lazy mirror init. Any failure — including a symlinked root
   * `.gitignore` — rolls the instance back to pristine and removes the
   * scratch tree: mirror/scratch are published only on FULL success, so a
   * failed first use can never leave a later call running with the root
   * rules silently missing (and retries never leak temp dirs). The probe
   * and `git init` are deliberately NOT stderr-fatal (a benign PATH
   * wrapper's warning must not brick startup); the fail-closed stderr rule
   * applies to VERDICT-producing commands. */
  private ensureRepo(): string {
    if (this.mirror !== null) return this.mirror;
    assertGitAvailable("copy-tree ignore rules");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-ignore-"));
    try {
      const mirror = path.join(scratch, "mirror");
      fs.mkdirSync(mirror);
      const env = gitEnv({ HOME: scratch, XDG_CONFIG_HOME: scratch });
      const init = spawnSync("git", ["init", "--quiet", mirror], { env, encoding: "utf8" });
      if (init.error || init.status !== 0) {
        throw new Error(
          `failed to initialize the ignore-rules mirror repo: ${
            init.error ? init.error.message : `exit ${init.status}: ${init.stderr}`
          }`,
        );
      }
      const gitdir = path.join(mirror, ".git");
      // Pinned so verdicts are identical on every platform: case-SENSITIVE
      // matching even on macOS/Windows (core.ignorecase feeds git's exclude
      // matching), no line-ending rewriting, no background helpers.
      fs.appendFileSync(
        path.join(gitdir, "config"),
        "[core]\n\tautocrlf = false\n\tignorecase = false\n\tuntrackedcache = false\n\tfsmonitor = false\n",
      );
      // Snapshot once: file presence selects authored rules, even when empty.
      const snapshot = this.readRulesFile();
      const defaults = snapshot === null ? DEFAULT_IGNORE_PATTERNS : [];
      fs.mkdirSync(path.join(gitdir, "info"), { recursive: true });
      fs.writeFileSync(
        path.join(gitdir, "info", "exclude"),
        `# hankweave fallback rules (only without a root .gitignore)\n${defaults.join(
          "\n",
        )}\n# belt-and-braces only — the authoritative .git rule is enforced in-process\n.git\n`,
      );
      // The ONE authored rules layer: the root .gitignore, snapshotted once
      // and written into the mirror root (root-only policy).
      if (snapshot !== null) {
        fs.writeFileSync(path.join(mirror, HANK_RULES_FILE), snapshot.bytes);
      }
      this.rootSource = snapshot;
      this.scratch = scratch;
      this.mirror = mirror;
      return mirror;
    } catch (error) {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      throw error;
    }
  }

  /** Memo key: dir-only patterns ("node_modules/") make the entry TYPE part
   * of the verdict, so a path judged as a file must not answer for the same
   * name later reappearing as a directory (rig commands can swap them
   * between copies). */
  private static verdictKey(rel: string, isDir: boolean): string {
    return `${isDir ? "d" : "f"}\0${rel}`;
  }

  /** Batched verdicts — one git spawn per call for the not-yet-memoized
   * subset. Directories must pass isDir=true (dir-only patterns match only
   * paths git can SEE are directories, so they are materialized in the
   * mirror first). Fail-closed: any git irregularity throws. */
  checkIgnored(entries: ReadonlyArray<{ rel: string; isDir: boolean }>): IgnoreVerdict[] {
    const mirror = this.ensureRepo();
    const results = new Array<IgnoreVerdict>(entries.length);
    const pending: Array<{ rel: string; key: string; index: number }> = [];
    entries.forEach(({ rel, isDir }, index) => {
      const key = HankDir.verdictKey(rel, isDir);
      const memo = this.verdicts.get(key);
      if (memo !== undefined) {
        results[index] = memo;
        return;
      }
      if (containsGitComponent(rel)) {
        const verdict: IgnoreVerdict = {
          rel,
          ignored: true,
          rule: "built-in: .git is never copied or bundled",
        };
        this.verdicts.set(key, verdict);
        results[index] = verdict;
        return;
      }
      if (isDir) {
        // Dir-only patterns ("node_modules/") match only paths git can SEE
        // are directories — materialize the (empty) directory in the mirror.
        fs.mkdirSync(path.join(mirror, ...rel.split("/")), { recursive: true });
      } else {
        // The reverse: a name judged as a DIRECTORY earlier (and mkdir'd
        // above, possibly with materialized descendants from deeper
        // queries) now queried as a FILE — a stale mirror directory would
        // make dir-only patterns match the file. Force-remove it, children
        // and all: if this path is a file, no legitimate child path can
        // coexist, and every verdict already computed is memoized (we never
        // re-query the mirror for it). rmSync stays inside our own temp
        // mirror.
        fs.rmSync(path.join(mirror, ...rel.split("/")), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
      pending.push({ rel, key, index });
    });

    if (pending.length > 0) {
      const byPath = this.runCheckIgnore(
        mirror,
        pending.map((p) => p.rel),
      );
      for (const { rel, key, index } of pending) {
        const rec = byPath.get(rel);
        if (rec === undefined) {
          throw new Error(
            `git check-ignore returned no verdict for "${rel}" (pack internal error)`,
          );
        }
        // --verbose reports NEGATION matches too — a "!pattern" record means
        // the path is explicitly NOT ignored. Misreading this would silently
        // drop files, so it is the load-bearing line of the parser.
        const ignored = rec.pattern !== "" && !rec.pattern.startsWith("!");
        const verdict: IgnoreVerdict = {
          rel,
          ignored,
          rule: rec.pattern === "" ? null : `${rec.source}:${rec.line}:${rec.pattern}`,
        };
        this.verdicts.set(key, verdict);
        results[index] = verdict;
      }
    }
    return results;
  }

  /** Single-path convenience over `checkIgnored`. Directories must pass
   * isDir=true so dir-only patterns match. */
  isIgnored(relPosix: string, isDir: boolean): boolean {
    return (this.checkIgnored([{ rel: relPosix, isDir }])[0] as IgnoreVerdict).ignored;
  }

  /** One `git check-ignore -z -v -n --stdin` batch. Exit 0 (some ignored)
   * and 1 (none ignored) are both success; anything else — or ANY stderr —
   * throws. Output is NUL-framed quadruples source/line/pattern/path;
   * keyed by path, never by position.
   *
   * Every input path is prefixed `./`: check-ignore --stdin parses a
   * leading ":" as pathspec magic (which it then rejects as unsupported —
   * `:(literal)` and GIT_LITERAL_PATHSPECS are rejected the same way), so a
   * perfectly legal filename like ":(glob)x" would otherwise abort the whole
   * batch. A "./"-prefixed path is never magic; git echoes it back verbatim,
   * so we strip the prefix to recover the original key. Our rels never begin
   * with "/" (hank-root-relative), so "./" + rel is unambiguous. */
  private runCheckIgnore(
    mirror: string,
    rels: string[],
  ): Map<string, { source: string; line: string; pattern: string }> {
    const r = spawnSync("git", ["check-ignore", "-z", "-v", "-n", "--no-index", "--stdin"], {
      cwd: mirror,
      env: gitEnv({ HOME: this.scratch as string, XDG_CONFIG_HOME: this.scratch as string }),
      input: `${rels.map((rel) => `./${rel}`).join("\0")}\0`,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) {
      throw new Error(`git check-ignore failed to run: ${r.error.message}`);
    }
    const stderr = r.stderr.toString("utf8");
    if ((r.status !== 0 && r.status !== 1) || stderr.length > 0) {
      throw new Error(
        `git check-ignore failed (exit ${r.status}): ${stderr || "(no stderr)"} — refusing to guess ignore verdicts`,
      );
    }
    const fields = r.stdout.toString("utf8").split("\0");
    const byPath = new Map<string, { source: string; line: string; pattern: string }>();
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const echoed = fields[i + 3] as string;
      const key = echoed.startsWith("./") ? echoed.slice(2) : echoed;
      byPath.set(key, {
        source: fields[i] as string,
        line: fields[i + 1] as string,
        pattern: fields[i + 2] as string,
      });
    }
    return byPath;
  }

  /** Remove the mirror repo and clear its rule snapshot and cached verdicts.
   * Idempotent; safe to call in `finally`. The next tree question snapshots
   * the current rules lazily and computes fresh verdicts. */
  dispose(): void {
    if (this.scratch === null) return;
    fs.rmSync(this.scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    this.scratch = null;
    this.mirror = null;
    this.rootSource = undefined;
    this.verdicts.clear();
  }

  // -------------
  // Trees
  // -------------

  /**
   * List ONE directory of the hank, classified: sorted by UTF-8 byte order,
   * lstat'd without following symlinks, and judged by the ignore rules in
   * one batched git call. Throws when the directory itself is unreadable,
   * and on any git irregularity (fail-closed verdicts).
   */
  listDir(relPosix: string): DirEntry[] {
    const rel = relPosix === "." ? "" : relPosix;
    const dirAbs = this.absolute(rel);
    const entries: DirEntry[] = [];
    for (const name of fs.readdirSync(dirAbs).sort(compareUtf8)) {
      const abs = path.join(dirAbs, name);
      const entryRel = rel === "" ? name : `${rel}/${name}`;
      try {
        entries.push({
          name,
          rel: entryRel,
          stats: fs.lstatSync(abs),
          ignored: false,
          ignoredBy: null,
        });
      } catch (error) {
        entries.push({ name, rel: entryRel, stats: null, error, ignored: false, ignoredBy: null });
      }
    }
    const statted = entries.filter((e) => e.stats !== null);
    const verdicts = this.checkIgnored(
      statted.map((e) => ({ rel: e.rel, isDir: (e.stats as fs.Stats).isDirectory() })),
    );
    statted.forEach((entry, i) => {
      const v = verdicts[i] as IgnoreVerdict;
      entry.ignored = v.ignored;
      entry.ignoredBy = v.rule;
    });
    return entries;
  }

  private *classifyCopyEntry(
    entry: DirEntry,
    raw: string,
    subdirs: string[],
  ): Generator<CopyTreeEntry> {
    if (entry.stats === null) {
      yield { kind: "vanished", rel: entry.rel, name: entry.name, error: entry.error };
      return;
    }
    if (entry.ignored) {
      yield {
        kind: "ignored",
        rel: entry.rel,
        name: entry.name,
        isDir: entry.stats.isDirectory(),
        rule: entry.ignoredBy,
      };
      return;
    }
    const abs = this.absolute(entry.rel);
    if (entry.stats.isSymbolicLink()) {
      yield { kind: "violation", violation: { kind: "tree-symlink", raw, entry: abs } };
      return;
    }
    // Exact spelling, like every rules-file check; ignored ones were
    // pruned above — they ship nowhere and govern nothing.
    if (entry.name === HANK_RULES_FILE) {
      yield {
        kind: "violation",
        violation: { kind: "tree-nested-gitignore", raw, entry: abs },
      };
      return;
    }
    if (entry.stats.isDirectory()) {
      subdirs.push(entry.rel);
    } else if (!entry.stats.isFile()) {
      yield { kind: "violation", violation: { kind: "tree-special", raw, entry: abs } };
      return;
    } else {
      yield { kind: "file", rel: entry.rel, name: entry.name, stats: entry.stats };
    }
  }

  private *classifyCopyDirectory(
    entries: DirEntry[],
    raw: string,
    subdirs: string[],
  ): Generator<CopyTreeEntry> {
    for (const entry of entries) {
      for (const result of this.classifyCopyEntry(entry, raw, subdirs)) {
        yield result;
        if (result.kind === "violation") return;
      }
    }
  }

  /**
   * THE copy-tree walk, shared by the loader scan, the pack closure, and the
   * rig copy. `rootRel` is the hank-root-relative POSIX path of a DIRECTORY
   * (callers classify the root; a file copy has no tree); `raw` is the
   * authored ref, carried into violations for the author-facing message.
   *
   * Rules first: an ignored entry is pruned before the symlink and
   * special-file gates — it ships nowhere and is copied nowhere, so nothing
   * about it can matter — and an ignored directory is never descended
   * (git's parent-exclusion). Then the gates, each a RefViolation that ends
   * the walk: a symlink (dangling included — never followed, so no cycle
   * can recurse), a nested rules file (root-only policy: it would govern
   * nothing, and shipping an inert rules file would be a lie), a
   * non-regular file (FIFO, socket, device). A directory root that is
   * ITSELF ignored is the first violation: parent-exclusion would empty the
   * whole tree, so the runtime would copy nothing and pack would refuse —
   * rejecting at load keeps "packs iff runs". (rootRel "" is the hank dir
   * itself, refused elsewhere; the walk still runs over it.)
   */
  *walkCopyTree(rootRel: string, raw: string): Generator<CopyTreeEntry> {
    if (rootRel !== "" && this.isIgnored(rootRel, true)) {
      yield { kind: "violation", violation: { kind: "tree-ignored-root", raw } };
      return;
    }
    const worklist: string[] = [rootRel];
    while (worklist.length > 0) {
      const dirRel = worklist.pop() as string;
      let entries: DirEntry[];
      try {
        entries = this.listDir(dirRel);
      } catch (error) {
        yield { kind: "dir-error", rel: dirRel, error };
        continue;
      }
      yield { kind: "dir", rel: dirRel, entryCount: entries.length };
      const subdirs: string[] = [];
      for (const result of this.classifyCopyDirectory(entries, raw, subdirs)) {
        yield result;
        if (result.kind === "violation") return;
      }
      // LIFO worklist: push reversed so subdirs process in sorted order.
      for (let i = subdirs.length - 1; i >= 0; i--) worklist.push(subdirs[i] as string);
    }
  }

  private validateCopyEntries(root: string, raw: string): RefViolation | null {
    for (const entry of this.walkCopyTree(this.relative(root), raw)) {
      if (entry.kind === "violation") return entry.violation;
      if (entry.kind === "vanished") {
        const code = (entry.error as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw entry.error;
      }
      if (entry.kind === "dir-error") throw entry.error;
    }
    return null;
  }

  /**
   * The loader's copy-tree scan (spec-63 amendment: R3 extended INTO
   * copy.from directory trees). The reference is validated before its target
   * tree is walked, using its own base directory within this hank.
   * lstat/readdir only — no file contents are read (the ROOT rules
   * file excepted: judging requires its contents), so the preflight's
   * never-touch-forbidden-paths rule is preserved. A missing or
   * non-directory target returns null: file copies have no entries, and
   * the existence walk owns missing-path errors. A vanished entry passes
   * (existence is someone else's job); EACCES/EIO propagate, like every
   * other loader read. Ignore rules are consulted only once the root is
   * classified a DIRECTORY, so a broken root .gitignore never rejects a
   * hank whose only copy sources are plain files.
   */
  validateCopyTree(ref: HankRef): RefViolation | null {
    if (ref.root !== this.root) throw new Error("Copy reference belongs to a different hank");
    const violation = ref.validate();
    if (violation) return violation;
    const { raw, path: root } = ref;
    let rootStats: fs.Stats;
    try {
      rootStats = fs.lstatSync(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
    if (!rootStats.isDirectory()) {
      // A file copy has no entries to scan; a symlink root was checked by
      // ref.validate above. But a FIFO,
      // socket, or device named DIRECTLY as copy.from is the same hazard as
      // one nested in a tree — the runtime copy would hand it to cp — and
      // the existence checks alone would let it through.
      if (rootStats.isFile() || rootStats.isSymbolicLink()) return null;
      return { kind: "tree-special", raw, entry: root };
    }
    return this.validateCopyEntries(root, raw);
  }

  /**
   * The fs.cp filter for a rig copy of `sourceRoot` (absolute). The SOURCE
   * ROOT is always admitted — `copy.from` is an explicit ref and explicit
   * refs are never filtered. Descendants are tested hank-root-relative like
   * every other walk; entries outside the hank dir are never filtered
   * ("outside" means a leading ".." PATH COMPONENT, not a ".." string
   * prefix — a top-level name like "..templates" is inside). An ignored
   * entry is excluded (what was excluded is reported by `copyTo`, not by
   * the filter); a non-ignored SYMLINK or nested rules file throws (both
   * were rejected at validation — one appearing afterwards must fail the
   * copy loudly, not be planted in the rig). The source tree is pre-walked
   * so the synchronous filter runs off the verdict memo, never spawning git
   * per file.
   */
  copyFilter(sourceRoot: string): (src: string) => boolean {
    this.scanIgnored(sourceRoot);
    return this.primedCopyFilter(sourceRoot);
  }

  /** `copyFilter` minus the pre-walk: the caller has already scanned. */
  private primedCopyFilter(sourceRoot: string): (src: string) => boolean {
    const resolvedRoot = path.resolve(sourceRoot);
    return (src: string): boolean => {
      const resolvedSrc = path.resolve(src);
      if (resolvedSrc === resolvedRoot) return true;
      const rel = path.relative(this.root, resolvedSrc);
      if (rel === "" || path.isAbsolute(rel)) return true;
      const relPosix = toPosix(rel);
      if (relPosix === ".." || relPosix.startsWith("../")) return true;
      const lst = fs.lstatSync(resolvedSrc);
      if (this.isIgnored(relPosix, lst.isDirectory())) return false;
      if (lst.isSymbolicLink()) {
        throw new Error(
          `refusing to copy ${resolvedSrc}: it is a symlink (symlinks are not allowed in a copied tree; it appeared after validation)`,
        );
      }
      if (path.basename(resolvedSrc) === HANK_RULES_FILE) {
        throw new Error(
          `refusing to copy ${resolvedSrc}: nested ${HANK_RULES_FILE} files are not allowed in a copied tree (it appeared after validation); hank ignore rules live in the root ${HANK_RULES_FILE}`,
        );
      }
      return true;
    };
  }

  /**
   * Walk a DIRECTORY copy source (absolute) through THE copy-tree walk and
   * return every entry the ignore rules pruned, in walk order — the list
   * the validator warns about, the rig copy reports, and pack lints. The
   * walk also batch-populates the verdict memo, so `copyFilter` never
   * spawns git per file. Errors and violations are left for the caller's
   * own read to surface (the validator rejected them already; fs.cp and
   * the filter re-reject at copy time), so a source outside the hank dir
   * or the hank dir itself scans as nothing excluded.
   */
  scanIgnored(rootAbs: string): IgnoredEntry[] {
    const rootRel = toPosix(path.relative(this.root, path.resolve(rootAbs)));
    if (rootRel === "" || rootRel === ".." || rootRel.startsWith("../")) return [];
    if (path.isAbsolute(rootRel)) return [];
    const ignored: IgnoredEntry[] = [];
    for (const entry of this.walkCopyTree(rootRel, rootRel)) {
      if (entry.kind === "ignored") ignored.push({ rel: entry.rel, by: entry.rule });
    }
    return ignored;
  }

  /**
   * Copy a rig source (an absolute path produced by `resolve`) to `to`. A
   * FILE source is an explicit ref — copied verbatim, and the rules file is
   * never even READ (the loader consults ignore rules only for directory
   * sources, so a broken .gitignore must not fail a rig operation the
   * loader accepted). A DIRECTORY source is copied through `copyFilter`:
   * the same verdicts the loader scan and `hankweave pack` consult, so a
   * rig built from source matches a rig built from an extracted bundle.
   * fs.cp rather than a shelled `cp -r`, which removes cp's GNU/BSD symlink
   * divergence. Target-side checks are the caller's (Workspace.copyFromHank).
   * Returns the entries the rules excluded, so the caller can say so — a
   * file dropped from a rig must have a line in the log.
   */
  async copyTo(from: string, to: string): Promise<IgnoredEntry[]> {
    const stats = await fs.promises.stat(from);
    if (!stats.isDirectory()) {
      await fs.promises.cp(from, to, { recursive: true });
      return [];
    }
    const ignored = this.scanIgnored(from);
    await fs.promises.cp(from, to, { recursive: true, filter: this.primedCopyFilter(from) });
    return ignored;
  }
}
