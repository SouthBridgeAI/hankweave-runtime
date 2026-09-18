/**
 * File-closure walker + portability lint for `hankweave pack` (U2 spec §4.1, §4.5).
 *
 * Computes every file reachable from a hank.json through the schema's
 * path-valued fields, hashes each one, assigns bundle paths, and emits lint
 * findings. Pure analysis: nothing here writes an archive or touches the CLI.
 *
 * PATH POLICY LIVES IN THE LOADER, NOT HERE. Strict hank refs (spec 63) make
 * every authored ref a portable relative path inside the hank dir with no
 * symlink on its route — including the entries inside copy.from trees — and
 * the runtime loader (`config.ts :: loadCodonSequence`) enforces all of it.
 * computeClosure RUNS the loader as the GATE: a hank that fails to load
 * fails to pack, so a hank packs if and only if it runs. The walker is the
 * REPORTER: it resolves refs exactly like the runtime loaders do (relative
 * to the hank dir, except a file-based sentinel config's own refs, which
 * resolve from that config file's directory), re-runs HankRef.validate on every
 * ref it materializes, re-schema-checks file sentinel configs on the
 * captured bytes, snapshots, hashes, assigns bundle paths — which are simply
 * the hank-relative source paths, because nothing can escape — and names
 * each problem at the field that authored it (`review.rigSetup[1].copy.from`)
 * with hank-relative paths. The walk runs even when the loader refused, so
 * one --check shows every problem at once; the loader's own message is kept
 * only as a `load-error` fallback for a refusal the walk did not reproduce.
 * The re-vetting is also what keeps the gate honest: the loader validates
 * its OWN read of each config, while the walk runs over captured snapshot
 * bytes — TOCTOU defense for a config changing mid-pack, not a second
 * policy home.
 *
 * COPY TREES ARE IGNORE-FILTERED. Directory copy.from walks are THE hank
 * directory's walk (hank-dir.ts :: HankDir.walkCopyTree) — the very same
 * one the loader's tree scan and the runtime's rig copy run — honoring the
 * hank's ignore rules: an explicit root .gitignore, or the implicit default
 * set (node_modules/, .git/, build junk) when none exists. Ignored
 * directories are pruned, never descended, so "packs iff runs" holds by
 * construction. The tree hash covers only the filtered tree, and an
 * explicit .gitignore ships as a bundle member so a repack of the extracted
 * bundle applies the same rules.
 *
 * The known path-field list below is pinned by the schema-drift canary in
 * tests/unit/pack-closure.test.ts, which enumerates EVERY free-string schema
 * field (not just `*File`-named ones) and requires each to be classified as
 * closure input or known non-input — a new string field fails that test
 * until classified, instead of silently escaping the closure. Parity tests
 * beside it hold this walker to the runtime loaders' resolution.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hankFileSchema, loadCodonSequence } from "../config.js";
import { sentinelConfigSchema } from "../config-validation/sentinel.schema.js";
import { assertGitAvailable } from "../git-support.js";
import {
  type CopyTreeEntry,
  describeIgnoredEntries,
  HANK_RULES_FILE,
  HankConfigFile,
  HankDir,
  type IgnoredEntry,
} from "../hank-dir.js";
import {
  compareUtf8,
  normalizeRefField,
  type RefViolation,
  refViolationMessage,
} from "../utils.js";

// -------------
// Types
// -------------

export type LintSeverity = "error" | "warn";

export type LintErrorCategory =
  | "missing-file"
  // Two codons flatten to the same key (the id, or loop/id for loop children).
  | "duplicate-codon-id"
  // Two sentinels of one codon carry the same id.
  | "duplicate-sentinel-id"
  // The argument names a file that is not a JSON config, or a directory
  // that does not exist / holds no hank.json.
  | "not-a-hank"
  // The root config (or a file sentinel config) is not JSON at all. The
  // detail is fixed; the JSON engine's own message rides in `note`.
  | "invalid-json"
  // Valid JSON that fails the schema: missing fields, unknown models,
  // escaping refs — the detail names the field and the schema's message.
  | "schema-error"
  // A ref that resolves outside the hank directory (R2, the filesystem
  // half: lexical spellings never get past the schema).
  | "ref-escapes"
  // A copy.from that names the hank directory itself ("." or "sub/..").
  | "copy-from-hank-dir"
  // Root-only ignore policy violations and explicitly excluded copy roots.
  | "invalid-ignore-rules"
  | "ignored-copy-root"
  // The shared copy-tree walk could not run (rules-file I/O or Git failure).
  | "copy-tree-error"
  // Fallback only. The runtime loader (loadCodonSequence) refused the hank
  // and the walk — which re-checks everything the loader checks — found no
  // error of its own. The detail is the loader's message, one finding per
  // violation, with its preambles, absolute paths and severity tags
  // stripped (loaderFailureFindings). If this ever fires, the walker lags
  // the loader; add the missing check to the walker.
  | "load-error"
  // Defense in depth, not policy: the loader already rejects every symlink a
  // hank can author. The walker re-checks with lstat while materializing
  // because a link appearing between validation and the walk would otherwise
  // be silently dereferenced — and a link cycle could hang the tree walk.
  | "symlink-ref"
  // A closure member claims a bundle path pack owns — hank.lock, or the
  // root hank.json slot when the root config is a different file.
  | "reserved-path"
  // A copy.from source with no files anywhere in its tree. Empty dirs are
  // excluded from bundles (git convention), so the extracted bundle could
  // not recreate the source and the runtime copy would fail — refuse at
  // pack time instead of shipping a broken bundle.
  | "empty-copy-root"
  // A member name that does not survive as ONE portable relative path on
  // every platform. Authored refs can't contain backslashes (loader R1),
  // but a file SWEPT IN by a copy.from tree can be named "..\\escape" — on
  // POSIX that's an ordinary filename, on Windows it extracts OUTSIDE the
  // bundle root. Also covers platform-equivalent aliasing: two members
  // distinct on a case-sensitive source ("Foo.md" vs "foo.md", NFC vs NFD
  // spellings) extract to ONE path on Windows or default macOS — one
  // overwrites the other and neither lock hash can verify. The same gate
  // rejects per-name unportabilities via portableNameProblem: control
  // characters (they break the one-line lint protocol and Windows
  // filenames), Windows reserved device names, and trailing dots/spaces.
  // Mirrors the extendClosure gate for native members.
  | "non-portable-path"
  // The closure exceeds pack's deterministic resource quotas (member
  // count, individual member size, or total logical bytes). The whole
  // closure — source bytes, canonical tar, and compressed archive — is
  // held in memory, so an unbounded input dies as an OOM kill instead of
  // a clean finding unless pack refuses first.
  | "closure-too-large";

export type LintWarnCategory =
  | "home-ref"
  | "network-op"
  | "inline-env"
  | "empty-dir"
  // Entries inside a copy.from tree excluded by the hank's ignore rules
  // (explicit root .gitignore, or the implicit default set — hank-dir.ts).
  // One warn per copy root, never per file: an ignored node_modules would
  // otherwise emit hundreds of thousands of findings.
  | "ignored-paths";

export interface LintFinding {
  severity: LintSeverity;
  category: LintErrorCategory | LintWarnCategory;
  where: string;
  detail: string;
  /** Supplementary text whose wording depends on the runtime (a JSON
   * engine's parse message). The CLI prints it to stderr; it is never part
   * of the finding on stdout, so findings compare equal across Bun and Node. */
  note?: string;
}

export type FileMode = "644" | "755";

/** One regular file that will become a bundle member. */
export interface ClosureFileEntry {
  /** Path inside the bundle, POSIX separators, relative — identical to the
   * hank-relative source path (strict refs: nothing can escape). */
  bundlePath: string;
  /** Absolute source path on disk; "" for generated members contributed via
   * extendClosure. */
  sourcePath: string;
  sha256: string;
  mode: FileMode;
  /**
   * The exact bytes the hash covers, captured at walk time. The archive
   * writer MUST consume these (never re-read the source path) — a file
   * changing between closure and archiving would otherwise produce a
   * bundle that fails its own lock verification.
   */
  bytes: Buffer;
}

/** Hashes of a file-based sentinel config's own referenced files (spec §4.4). */
export interface SentinelFileRefs {
  systemPromptFile?: string[];
  userPromptFile?: string[];
  schemaFile?: string[];
}

/** One distinct path reference (memoized per baseDir + raw string). */
export interface RefRecord {
  raw: string;
  baseDir: string;
  resolved: string;
  kind: "file" | "dir";
  /** Content hash for files; deterministic tree hash for directories. */
  sha256: string;
  /** Normalized mode for file refs (absent for directories — tree hashes
   * already cover per-file modes). */
  mode?: FileMode;
  bundlePath: string;
  sentinelRefs?: SentinelFileRefs;
}

export interface ClosureResult {
  ok: boolean;
  hankDir: string;
  hankJsonPath: string;
  /** Raw parsed hank.json (pre-Zod: `model` stays the authored string). */
  raw: unknown;
  /** Sorted by bundlePath; includes hank.json; excludes hank.lock. Every
   * config ships verbatim — with strict refs there is nothing to rewrite. */
  files: ClosureFileEntry[];
  findings: LintFinding[];
  /** Memoized reference records, keyed by refKey(baseDir, raw). */
  refs: Map<string, RefRecord>;
}

/** Root-level lock member: always generated by pack, never collected from
 * the source dir (spec §4.3 — `files` excludes hank.lock). */
export const RESERVED_LOCK_PATH = "hank.lock";

// -------------
// Resource quotas (phase-2 issue 11)
// -------------
// The whole closure is buffered: captured bytes + canonical tar +
// compressed archive coexist in memory. These deterministic,
// runtime-independent bounds turn an would-be OOM kill into a
// `closure-too-large` finding. Symlink rejection already rules out
// alias-DAG blowups, so these guard sheer size, not graph shape.

/** Largest individual bundle member (bytes). */
export const MAX_MEMBER_BYTES = 1024 ** 3; // 1 GiB
/** Largest sum of logical member sizes (bytes). */
const MAX_TOTAL_BYTES = 2 * 1024 ** 3; // 2 GiB
/** Logical bytes plus canonical headers/PAX allowance. Also caps compressed input. */
export const MAX_ARCHIVE_BYTES = MAX_TOTAL_BYTES + 128 * 1024 ** 2;
/** Largest bundle member count. */
const MAX_MEMBERS = 50_000;

/** The three size quotas the walk enforces. Production always runs the
 * defaults; tests lower them so a quota case needs hundreds of files, not
 * tens of thousands. */
export interface ClosureQuotas {
  maxMemberBytes: number;
  maxTotalBytes: number;
  maxMembers: number;
}
export const DEFAULT_QUOTAS: ClosureQuotas = Object.freeze({
  maxMemberBytes: MAX_MEMBER_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxMembers: MAX_MEMBERS,
});

/** Windows reserved device basenames; reserved with any extension too
 * ("CON.txt" is still the console device). */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Why a bundle member name is not portable across supported extraction
 * platforms, or null when it is. ONE validator for native members
 * (addFileEntry) and extension members (extendClosure) — phase-2 issue 10.
 * Structural shape (relative, normalized, no "..") is the caller's
 * concern; this covers per-name portability only. Unicode normalization
 * is deliberately NOT folded (NFC/NFD collisions are accepted as out of
 * scope and documented; case folding below is the cheap, common half).
 */
export function portableNameProblem(bundlePath: string): string | null {
  if (bundlePath.includes("\\")) {
    return "member names may not contain backslashes (Windows interprets \\ as a path separator)";
  }
  // "/" is the member separator and never reaches this test as part of a
  // component, so the whole path can be scanned at once.
  if (/[:*?"<>|]/.test(bundlePath)) {
    return 'member names may not contain characters reserved on Windows (: * ? " < > |)';
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/u.test(bundlePath)) {
    return "member names may not contain control characters";
  }
  for (const component of bundlePath.split("/")) {
    if (WINDOWS_RESERVED_RE.test(component)) {
      return `"${component}" is a reserved device name on Windows`;
    }
    if (component.endsWith(".") || component.endsWith(" ")) {
      return `"${component}" ends with a dot or space, which Windows strips on extraction`;
    }
  }
  return null;
}
/** Root-level ignore-rules member (hank-dir.ts): the exact name is a
 * legal member — it IS the hank's explicit .gitignore, folded in by pack —
 * but nothing else may fold onto the slot (case/normalization variants,
 * directories named .gitignore), or extraction on a case-insensitive
 * filesystem would rewrite the rules the tree hashes were built under. */
const RESERVED_IGNORE_PATH = HANK_RULES_FILE;

export function refKey(baseDir: string, raw: string): string {
  return `${baseDir}\0${raw}`;
}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// -------------
// Lint heuristics (spec §4.5)
// -------------

const NETWORK_OP_RE =
  /git clone|git fetch|curl|wget|bun install|bun add|npm install|npm ci|pnpm install|pip install|uv pip|brew install|apt-get|fetch\(/;

const HOME_REF_RE = /\$HOME|~\/|\/Users\/|\/home\//;

const SECRET_KEY_RE = /key|token|secret|password/i;

// -------------
// Internal walk state
// -------------

/**
 * Portable collision key for a bundle member path: Unicode NFC
 * normalization plus lower-case folding. Two member paths sharing a key are
 * distinct on a case-sensitive source filesystem but alias to ONE file when
 * extracted on a case-insensitive or Unicode-normalizing filesystem
 * (Windows NTFS, default macOS APFS). String.prototype.toLowerCase is
 * locale-independent and covers the practical folds; "/" is unaffected by
 * either transform, so the key is computed over the whole path.
 */
function portableCollisionKey(p: string): string {
  return p.normalize("NFC").toLowerCase();
}

/** Detail suffix shared by every platform-alias finding/rejection. */
const ALIAS_SUFFIX = "on case-insensitive filesystems (e.g. Windows, default macOS)";

function modeOf(stat: fs.Stats): FileMode {
  return (stat.mode & 0o111) !== 0 ? "755" : "644";
}

/** Bytes, mode, and hash captured by the FIRST read of a source file. */
interface FileSnapshot {
  bytes: Buffer;
  mode: FileMode;
  sha256: string;
}

interface RefOptions {
  raw: string;
  baseDir: string;
  allowDir: boolean;
  where: string;
}

interface ResolvedRefOptions {
  raw: string;
  baseDir: string;
  resolved: string;
  bundlePath: string;
  where: string;
}

interface TreeFile extends FileSnapshot {
  rel: string;
  sourcePath: string;
}

/** Everything one copy-tree walk collected. */
interface TreeWalk {
  files: TreeFile[];
  ignored: IgnoredEntry[];
}

class ClosureWalker {
  readonly hankDir: string;
  readonly hankJsonPath: string;
  readonly findings: LintFinding[] = [];
  readonly refs = new Map<string, RefRecord>();
  /** bundlePath → entry, for every closure file collected during the walk. */
  readonly fileEntries = new Map<string, ClosureFileEntry>();
  /** portableCollisionKey → first bundlePath claiming it, for detecting
   * members that alias each other on case-insensitive filesystems. */
  private canonicalPaths = new Map<string, string>();
  /** portableCollisionKey of each member's parent-directory prefixes → the
   * first exact spelling claiming it. Two spellings of one folded prefix
   * ("Foo/" vs "foo/") are distinct directories here but merge into ONE on
   * extraction — a copy.from root would gain files its tree hash and
   * codonInputs never covered. */
  private canonicalDirPrefixes = new Map<string, string>();
  /** First-read snapshots keyed by normalized resolved source path. */
  private snapshots = new Map<string, FileSnapshot>();
  /** Sum of logical member sizes (duplicated bundle paths count once).
   * Read by computeClosure when folding in the root config, which bypasses
   * addFileEntry. */
  totalBytes = 0;
  /** Aggregate reservation for the copy tree currently being walked: its
   * files are buffered until traversal completes and addFileEntry (the real
   * accounting) only runs after that, so the member-count and total-byte
   * quotas must be reserved against while traversing, before each read, or
   * a tree of many sub-quota files would exhaust memory (or the member map)
   * before closure-too-large could fire. Reset per tree by collectTreeFiles. */
  private treeReservedBytes = 0;
  // Defer empty-directory warnings until we know whether the entire copy
  // source is empty; that condition gets just the empty-copy-root error.
  private pendingEmptyDirs: string[] = [];
  /** The hank directory entity (hank-dir.ts): ref validation, ignore
   * verdicts (git, against a rules-only mirror snapshotted at first use),
   * and THE copy-tree walk — the walk and the post-pack self-check share
   * this ONE instance, so they can never disagree. Lazy: a hank with no
   * directory copies never spawns git. computeClosure disposes it. */
  readonly hank: HankDir;
  /** Bundle paths of directories the walks PRUNED (ignored, never
   * descended) — the self-check consults this instead of re-asking the
   * oracle about ancestors, so it can never enter a pruned directory. */
  readonly prunedDirs = new Set<string>();
  raw: unknown;

  readonly quotas: ClosureQuotas;

  constructor(hankJsonPath: string, quotas: ClosureQuotas = DEFAULT_QUOTAS) {
    this.hankJsonPath = hankJsonPath;
    this.quotas = quotas;
    this.hank = HankDir.forConfig(hankJsonPath);
    this.hankDir = this.hank.root;
  }

  error(category: LintErrorCategory, where: string, detail: string, note?: string): void {
    this.findings.push(
      note === undefined
        ? { severity: "error", category, where, detail }
        : { severity: "error", category, where, detail, note },
    );
  }

  warn(category: LintWarnCategory, where: string, detail: string): void {
    this.findings.push({ severity: "warn", category, where, detail });
  }

  hankRelative(abs: string): string {
    return this.hank.relative(abs);
  }

  /** Pre-register bytes already read (the root config, a rule-source
   * snapshot), so a ref back to the same file reuses them instead of
   * re-reading. FIRST READ WINS, matching snapshotFile's contract: a seed
   * arriving after a direct ref already captured the file must not swap the
   * bytes/mode out from under the RefRecord built on the first read —
   * divergence between the two reads is a mid-pack drift the caller must
   * refuse, not paper over. Returns the snapshot actually in effect. */
  seedSnapshot(abs: string, bytes: Buffer, mode: FileMode): FileSnapshot {
    const key = path.resolve(abs);
    const existing = this.snapshots.get(key);
    if (existing) return existing;
    const snap: FileSnapshot = { bytes, mode, sha256: sha256Hex(bytes) };
    this.snapshots.set(key, snap);
    return snap;
  }

  // -------------
  // Reference handling
  // -------------

  /**
   * Resolve one string path reference, hash its target (file, or directory
   * tree when `allowDir`), and assign its bundle path. Returns null after
   * recording an error finding.
   *
   * Hashing/bundle-path assignment is memoized per (baseDir, raw); the
   * occurrence-specific allowDir check runs for EVERY occurrence.
   */
  handleRef(options: {
    raw: string;
    baseDir: string;
    where: string;
    allowDir: boolean;
  }): RefRecord | null {
    const { raw, baseDir, where, allowDir } = options;

    // The schema rejects empty refs (.min(1)); this is walker-crash defense
    // for resolveRef, which throws on "".
    if (raw === "") {
      this.error("missing-file", where, "empty file reference");
      return null;
    }

    const memoKey = refKey(baseDir, raw);
    let record = this.refs.get(memoKey) ?? null;
    if (!record) {
      record = this.resolveAndHash({ raw, baseDir, allowDir, where });
      if (!record) return null;
      this.refs.set(memoKey, record);
    }

    if (record.kind === "dir" && !allowDir) {
      this.error(
        "missing-file",
        where,
        `${raw} resolves to a directory (${this.hankRelative(record.resolved)}); expected a file`,
      );
      return null;
    }

    return record;
  }

  private validateCapturedRef(options: RefOptions): boolean {
    const { raw, baseDir, where } = options;
    // The loader's strict-ref gate validated the refs in its OWN re-read of
    // the configs; this walk runs over captured snapshot bytes, which can
    // diverge if a config (or the disk route under a ref) changed mid-pack.
    // Re-run R1/R2/R3 on every ref actually walked, so policy provably
    // covers the bytes that ship — never just the bytes the loader saw.
    let violation: RefViolation | null;
    try {
      violation = this.hank.ref(raw, { baseDir }).validate();
    } catch (e) {
      this.error(
        "missing-file",
        where,
        `${raw} could not be validated (${e instanceof Error ? e.message : String(e)})`,
      );
      return false;
    }
    if (violation) {
      // Same words as the loader, minus the hank directory: findings name
      // paths relative to it.
      this.error(
        REF_VIOLATION_CATEGORIES[violation.kind],
        where,
        stripHankDirPrefixes(refViolationMessage(violation), this.hankDir),
      );
      return false;
    }

    return true;
  }

  private statRef(options: ResolvedRefOptions): fs.Stats | null {
    const { raw, resolved, where } = options;
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(resolved);
    } catch {
      const rel = this.hankRelative(resolved);
      this.error(
        "missing-file",
        where,
        rel === path.posix.normalize(raw)
          ? `${raw} does not exist`
          : `${raw} does not exist (resolves to ${rel})`,
      );
      return null;
    }

    if (lst.isSymbolicLink()) {
      this.error(
        "symlink-ref",
        where,
        `${raw} is a symlink (${this.hankRelative(resolved)}); symlinks are not allowed in hank refs`,
      );
      return null;
    }

    return lst;
  }

  private resolveDirectoryRef(options: ResolvedRefOptions, allowDir: boolean): RefRecord | null {
    const { raw, baseDir, resolved, where } = options;
    if (!allowDir) {
      // Refuse before walking: a prompt field accidentally naming a huge
      // directory must fail fast, not hash the whole tree first.
      this.error(
        "missing-file",
        where,
        `${raw} resolves to a directory (${this.hankRelative(resolved)}); expected a file`,
      );
      return null;
    }
    // HankRef.validate vets containment, but "." (or "sub/..") stays IN-dir by
    // resolving to the hank root itself. The loader separately refuses
    // that for copy sources (refIsHankDir) — on its OWN re-read; re-apply
    // it to the captured ref, or a mid-pack swap would walk the whole
    // hank with bundlePath "" and emit rootless members like "/hank.json".
    if (this.hank.ref(raw, { baseDir }).isRoot()) {
      this.error(
        "copy-from-hank-dir",
        where,
        `copy source "${raw}" is the hank directory itself; move the files into a subdirectory and copy that`,
      );
      return null;
    }
    return this.handleDirRef(options);
  }

  private resolveFileRef(options: ResolvedRefOptions, lst: fs.Stats): RefRecord | null {
    const { raw, baseDir, resolved, bundlePath, where } = options;
    if (!lst.isFile()) {
      // FIFOs block readFileSync forever; device files can be unbounded;
      // none can be represented as a regular tar member.
      this.error(
        "missing-file",
        where,
        `${raw} is not a regular file (${this.hankRelative(resolved)})`,
      );
      return null;
    }

    if (bundlePath === RESERVED_LOCK_PATH) {
      this.error(
        "reserved-path",
        where,
        `${raw}: ${RESERVED_LOCK_PATH} is a reserved bundle member owned by pack`,
      );
      return null;
    }

    // Size gate BEFORE the read: an over-quota file must be refused
    // without allocating a buffer of that size.
    if (lst.size > this.quotas.maxMemberBytes) {
      this.error(
        "closure-too-large",
        where,
        `${raw} is ${lst.size} bytes; bundle members are limited to ${this.quotas.maxMemberBytes} bytes`,
      );
      return null;
    }

    let snap: FileSnapshot;
    try {
      snap = this.snapshotFile(resolved);
    } catch (e) {
      this.error(
        "missing-file",
        where,
        `${raw} is unreadable (${e instanceof Error ? e.message : String(e)})`,
      );
      return null;
    }
    const entry: ClosureFileEntry = {
      bundlePath,
      sourcePath: resolved,
      sha256: snap.sha256,
      mode: snap.mode,
      bytes: snap.bytes,
    };
    if (!this.addFileEntry(entry, where)) return null;
    return {
      raw,
      baseDir,
      resolved,
      kind: "file",
      sha256: entry.sha256,
      mode: entry.mode,
      bundlePath,
    };
  }

  /** The memoized half of handleRef: stat, hashing, bundle path assignment.
   * allowDir is only consulted to refuse walking a directory a file-only
   * field pointed at. */
  private resolveAndHash(options: RefOptions): RefRecord | null {
    if (!this.validateCapturedRef(options)) return null;
    const resolved = this.hank.ref(options.raw, { baseDir: options.baseDir }).path;
    // HankRef.validate guarantees an in-dir, symlink-free route.
    const bundlePath = this.hank.relative(resolved);
    const location = { ...options, resolved, bundlePath };
    const lst = this.statRef(location);
    if (!lst) return null;
    if (lst.isDirectory()) return this.resolveDirectoryRef(location, options.allowDir);
    return this.resolveFileRef(location, lst);
  }

  /**
   * Read a regular file at most once per resolved path. Different authored
   * spellings ("p.md" vs "./p.md"), directory-walk overlaps, and a file
   * referenced both directly and inside a copy.from tree all reuse the
   * first snapshot, so a file edited while pack runs cannot end up with
   * one hash in the lock and different bytes in the bundle. Throws like
   * fs.readFileSync — callers keep their own error handling.
   *
   * HankRef owns the descriptor-based capture and its symlink/FIFO guards;
   * this layer owns hashing, bundle modes, and first-read-wins caching.
   */
  private snapshotFile(abs: string): FileSnapshot {
    const key = path.resolve(abs);
    const cached = this.snapshots.get(key);
    if (cached) return cached;
    const { bytes, stats } = this.hank.refFromPath(abs).readSnapshot();
    const snap: FileSnapshot = { bytes, mode: modeOf(stats), sha256: sha256Hex(bytes) };
    this.snapshots.set(key, snap);
    return snap;
  }

  private validateMemberPath(entry: ClosureFileEntry, segments: string[], where: string): boolean {
    // Backstop behind the refIsHankDir/HankRef.validate gates: no member may
    // carry an empty, absolute, or unnormalized computed bundle path — a
    // ref that somehow resolved to the hank root or above would otherwise
    // ship members that extract outside (or on top of) the bundle root.
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      this.error(
        "non-portable-path",
        where,
        `${JSON.stringify(entry.bundlePath)}: computed bundle path must be a normalized relative path`,
      );
      return false;
    }
    const nameProblem = portableNameProblem(entry.bundlePath);
    if (nameProblem) {
      this.error(
        "non-portable-path",
        where,
        `${entry.bundlePath}: ${nameProblem}; rename the file`,
      );
      return false;
    }
    return true;
  }

  private reserveMemberQuota(entry: ClosureFileEntry, where: string): boolean {
    if (!this.fileEntries.has(entry.bundlePath)) {
      if (this.fileEntries.size >= this.quotas.maxMembers) {
        this.error("closure-too-large", where, `bundle exceeds ${this.quotas.maxMembers} members`);
        return false;
      }
      this.totalBytes += entry.bytes.length;
      if (this.totalBytes > this.quotas.maxTotalBytes) {
        this.error(
          "closure-too-large",
          where,
          `bundle exceeds ${this.quotas.maxTotalBytes} total bytes`,
        );
        return false;
      }
    }
    return true;
  }

  private checkMemberClaim(entry: ClosureFileEntry, canonKey: string, where: string): boolean {
    if (!this.reserveMemberQuota(entry, where)) return false;
    const existing = this.fileEntries.get(entry.bundlePath);
    if (existing && existing.sourcePath !== entry.sourcePath) {
      // Cannot happen for in-dir paths (same relpath ⇒ same source) —
      // defensive all the same.
      this.error(
        "missing-file",
        where,
        `bundle path collision at ${entry.bundlePath} (${existing.sourcePath} vs ${entry.sourcePath})`,
      );
      return false;
    }
    return this.checkMemberAliases(entry, canonKey, where);
  }

  private checkMemberAliases(entry: ClosureFileEntry, canonKey: string, where: string): boolean {
    // The exact-match reserved check in resolveAndHash misses variants like
    // HANK.LOCK, which extract onto pack's lock file where names fold.
    if (canonKey === RESERVED_LOCK_PATH && entry.bundlePath !== RESERVED_LOCK_PATH) {
      this.error(
        "non-portable-path",
        where,
        `${entry.bundlePath} aliases the reserved ${RESERVED_LOCK_PATH} member ${ALIAS_SUFFIX}; rename the file`,
      );
      return false;
    }
    // Root .gitignore is a SEMANTIC slot (the copy-tree ignore rules,
    // hank-dir.ts). The exact name is legal — it IS the rules file,
    // folded in with identical snapshot bytes — but a case/normalization
    // variant (.GITIGNORE) extracts INTO that slot where names fold,
    // rewriting rules the tree hashes were built without. Applies in
    // implicit-defaults mode too, where no lowercase occupant exists to
    // trip the plain alias check.
    if (canonKey === RESERVED_IGNORE_PATH && entry.bundlePath !== RESERVED_IGNORE_PATH) {
      this.error(
        "non-portable-path",
        where,
        `${entry.bundlePath} aliases the hank's ${RESERVED_IGNORE_PATH} (the copy-tree ignore rules) ${ALIAS_SUFFIX}; rename the file`,
      );
      return false;
    }
    const claimant = this.canonicalPaths.get(canonKey);
    if (claimant !== undefined && claimant !== entry.bundlePath) {
      this.error(
        "non-portable-path",
        where,
        `bundle members ${claimant} and ${entry.bundlePath} are distinct here but alias ${ALIAS_SUFFIX}; rename one`,
      );
      return false;
    }
    return true;
  }

  private claimMemberDirectories(
    entry: ClosureFileEntry,
    segments: string[],
    where: string,
  ): boolean {
    // Claim every parent-directory prefix under its folded key, not just
    // the complete path: Foo/a and foo/b share no member key, yet their
    // directories merge on extraction. The reserved lock name is a prefix
    // nothing may fold onto — extraction writes the root lock FILE there.
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join("/");
      const prefixKey = portableCollisionKey(prefix);
      if (prefixKey === RESERVED_LOCK_PATH) {
        this.error(
          "non-portable-path",
          where,
          prefix === RESERVED_LOCK_PATH
            ? `${entry.bundlePath}: parent directory ${prefix} collides with the reserved ${RESERVED_LOCK_PATH} member; rename the directory`
            : `${entry.bundlePath}: parent directory ${prefix} aliases the reserved ${RESERVED_LOCK_PATH} member ${ALIAS_SUFFIX}; rename the directory`,
        );
        return false;
      }
      // A DIRECTORY folding to the .gitignore slot would extract there and
      // make readHankGitignore refuse the whole extracted hank (the rules
      // must be a regular file).
      if (prefixKey === RESERVED_IGNORE_PATH) {
        this.error(
          "non-portable-path",
          where,
          `${entry.bundlePath}: parent directory ${prefix} occupies the ${RESERVED_IGNORE_PATH} slot (the copy-tree ignore rules, which must be a regular file); rename the directory`,
        );
        return false;
      }
      const dirClaimant = this.canonicalDirPrefixes.get(prefixKey);
      if (dirClaimant !== undefined && dirClaimant !== prefix) {
        this.error(
          "non-portable-path",
          where,
          `bundle directories ${dirClaimant}/ and ${prefix}/ are distinct here but alias ${ALIAS_SUFFIX}; rename one`,
        );
        return false;
      }
      this.canonicalDirPrefixes.set(prefixKey, prefix);
    }
    return true;
  }

  /** Returns false when the entry was refused (after recording an error
   * finding) — callers must treat the reference as failed rather than
   * assume the member exists. */
  private addFileEntry(entry: ClosureFileEntry, where: string): boolean {
    const segments = entry.bundlePath.split("/");
    if (!this.validateMemberPath(entry, segments, where)) return false;
    const canonKey = portableCollisionKey(entry.bundlePath);
    if (!this.checkMemberClaim(entry, canonKey, where)) return false;
    if (!this.claimMemberDirectories(entry, segments, where)) return false;
    this.fileEntries.set(entry.bundlePath, entry);
    this.canonicalPaths.set(canonKey, entry.bundlePath);
    return true;
  }

  private reportUnreadable(what: string, e: unknown, where: string): void {
    this.error(
      "missing-file",
      where,
      `${what} is unreadable (${e instanceof Error ? e.message : String(e)})`,
    );
  }

  private collectTreeFile(
    options: ResolvedRefOptions,
    entryAbs: string,
    entryRel: string,
    lst: fs.Stats,
    treeFiles: TreeFile[],
  ): boolean {
    const { raw, where } = options;
    if (lst.size > this.quotas.maxMemberBytes) {
      this.error(
        "closure-too-large",
        where,
        `${raw}/${entryRel} is ${lst.size} bytes; bundle members are limited to ${this.quotas.maxMemberBytes} bytes`,
      );
      return false;
    }
    // Reservation is conservative: a tree file that later dedups
    // against an already-collected member counts twice here, which
    // can only refuse earlier, never admit more.
    if (this.fileEntries.size + treeFiles.length >= this.quotas.maxMembers) {
      this.error("closure-too-large", where, `bundle exceeds ${this.quotas.maxMembers} members`);
      return false;
    }
    if (this.totalBytes + this.treeReservedBytes + lst.size > this.quotas.maxTotalBytes) {
      this.error(
        "closure-too-large",
        where,
        `bundle exceeds ${this.quotas.maxTotalBytes} total bytes`,
      );
      return false;
    }
    try {
      const snap = this.snapshotFile(entryAbs);
      this.treeReservedBytes += snap.bytes.length;
      treeFiles.push({
        rel: entryRel,
        mode: snap.mode,
        sha256: snap.sha256,
        sourcePath: entryAbs,
        bytes: snap.bytes,
      });
    } catch (e) {
      this.reportUnreadable(`${raw}/${entryRel}`, e, where);
      return false;
    }
    return true;
  }

  /** The walk's violations (symlink, nested rules file, special file,
   * ignored root) become findings in the loader's own words — the loader
   * already rejected them on its OWN read, and the walk re-rejects on the
   * captured tree (TOCTOU). */
  private reportTreeViolation(violation: RefViolation, where: string): void {
    this.error(
      REF_VIOLATION_CATEGORIES[violation.kind],
      where,
      stripHankDirPrefixes(refViolationMessage(violation), this.hankDir),
    );
  }

  private collectTreeEntry(
    options: ResolvedRefOptions,
    entry: CopyTreeEntry,
    walk: TreeWalk,
  ): boolean {
    const { raw, bundlePath, where } = options;
    /** Copy-root-relative spelling for tree lines and messages. */
    const rootRelative = (rel: string): string => rel.slice(bundlePath.length + 1);
    switch (entry.kind) {
      case "dir":
        if (entry.entryCount === 0) {
          this.pendingEmptyDirs.push(`${entry.rel} is empty; excluded from bundle and tree hash`);
        }
        return true;
      case "dir-error":
        this.reportUnreadable(entry.rel, entry.error, where);
        return false;
      case "vanished":
        this.reportUnreadable(`${raw}/${rootRelative(entry.rel)}`, entry.error, where);
        return false;
      case "ignored":
        walk.ignored.push({ rel: entry.rel, by: entry.rule });
        if (entry.isDir) this.prunedDirs.add(entry.rel);
        return true;
      case "violation":
        this.reportTreeViolation(entry.violation, where);
        return false;
      case "file":
        return this.collectTreeFile(
          options,
          this.hank.absolute(entry.rel),
          rootRelative(entry.rel),
          entry.stats,
          walk.files,
        );
    }
  }

  private collectTreeFiles(options: ResolvedRefOptions): TreeWalk | null {
    this.pendingEmptyDirs = [];
    const walk = this.walkTree(options);
    const emptyDirs = this.pendingEmptyDirs;
    this.pendingEmptyDirs = [];
    if (walk === null || walk.files.length > 0) {
      for (const detail of emptyDirs) this.warn("empty-dir", options.where, detail);
    }
    return walk;
  }

  private walkTree(options: ResolvedRefOptions): TreeWalk | null {
    const walk: TreeWalk = { files: [], ignored: [] };
    this.treeReservedBytes = 0;
    try {
      for (const entry of this.hank.walkCopyTree(options.bundlePath, options.raw)) {
        if (!this.collectTreeEntry(options, entry, walk)) return null;
      }
    } catch (error) {
      // The loader may already have refused these rules, but the reporting
      // walk still runs. Keep failures as findings so unrelated refs can be
      // checked too; no partial tree is eligible for the bundle.
      this.error(
        "copy-tree-error",
        options.where,
        stripHankDirPrefixes(errorText(error), this.hankDir),
      );
      return null;
    }
    return walk;
  }

  /** The same sentence the validator and the runtime rig copy print. */
  private warnIgnoredEntries(ignored: IgnoredEntry[], where: string): void {
    this.warn("ignored-paths", where, describeIgnoredEntries(ignored));
  }

  /**
   * Collect a directory `copy.from` source through THE hank walk
   * (HankDir.walkCopyTree): ignored files are skipped and ignored
   * directories pruned — never descended, matching git's parent-exclusion
   * rule and the loader's own scan (validateCopyTree, the same walk). The
   * walk's violations (symlink, nested rules file, special file, ignored
   * root) become findings in the loader's own words — the loader already
   * rejected them on its OWN read, and the walk re-rejects on the captured
   * tree (TOCTOU). A link is never followed, so no cycle can recurse. Empty
   * directories are excluded from bundle and tree hash (git convention) and
   * linted. Tree hash = sha256 over sorted `relpath\0mode\0sha256\n` lines
   * of the FILTERED tree — ignored entries never reach the preimage.
   */
  private handleDirRef(options: ResolvedRefOptions): RefRecord | null {
    const { raw, baseDir, resolved, bundlePath, where } = options;
    const walk = this.collectTreeFiles(options);
    if (!walk) return null;
    const { files: treeFiles, ignored } = walk;

    if (treeFiles.length === 0) {
      // An empty copy source cannot be recreated from the bundle (empty
      // dirs are excluded per the git convention), so the runtime copy
      // would fail after extraction — refuse rather than pack a broken ref.
      this.error(
        "empty-copy-root",
        where,
        ignored.length > 0
          ? `${raw} contains no files after ignore rules (${ignored.length} entr${
              ignored.length === 1 ? "y" : "ies"
            } ignored); the bundle cannot recreate an empty copy source`
          : `${raw} contains no files; the bundle cannot recreate an empty copy source`,
      );
      return null;
    }

    if (ignored.length > 0) this.warnIgnoredEntries(ignored, where);

    treeFiles.sort((a, b) => compareUtf8(a.rel, b.rel));
    const preimage = treeFiles.map((f) => `${f.rel}\0${f.mode}\0${f.sha256}\n`).join("");
    const treeHash = sha256Hex(preimage);

    let inserted = true;
    for (const f of treeFiles) {
      inserted =
        this.addFileEntry(
          {
            bundlePath: `${bundlePath}/${f.rel}`,
            sourcePath: f.sourcePath,
            sha256: f.sha256,
            mode: f.mode,
            bytes: f.bytes,
          },
          where,
        ) && inserted;
    }
    if (!inserted) return null;

    return {
      raw,
      baseDir,
      resolved,
      kind: "dir",
      sha256: treeHash,
      bundlePath,
    };
  }
}

// -------------
// Raw-JSON shape helpers (pre-Zod; shapes are guaranteed by the schema
// parse that runs before the walk)
// -------------

function asRecord(v: unknown): Record<string, unknown> {
  return v as Record<string, unknown>;
}

/** Drop the hank directory (as authored and as realpath'd) from every path
 * in a message, so a finding reads hank-relative like the walker's own. */
function stripHankDirPrefixes(text: string, hankDir: string): string {
  const prefixes = [hankDir + path.sep];
  try {
    prefixes.push(fs.realpathSync.native(hankDir) + path.sep);
  } catch {
    // unresolvable hank dir: the authored prefix is all there is
  }
  // Longest first: the realpath form can contain the authored form as a
  // suffix (/private/var/… vs /var/…), and stripping the shorter one first
  // would leave a mangled remainder.
  prefixes.sort((a, b) => b.length - a.length);
  let out = text;
  for (const prefix of prefixes) out = out.split(prefix).join("");
  return out;
}

/** Category for a strict-ref violation met while re-vetting a captured
 * ref. Lexical kinds (absolute, backslash, invalid) cannot reach here — the
 * schema rejects them before the walk — so they share the escape bucket. */
const REF_VIOLATION_CATEGORIES = {
  absolute: "ref-escapes",
  backslash: "ref-escapes",
  invalid: "ref-escapes",
  escapes: "ref-escapes",
  "git-metadata": "reserved-path",
  symlink: "symlink-ref",
  "tree-symlink": "symlink-ref",
  "tree-special": "missing-file",
  "tree-nested-gitignore": "invalid-ignore-rules",
  "tree-ignored-root": "ignored-copy-root",
} satisfies Record<RefViolation["kind"], LintErrorCategory>;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** First three Zod issues on one line, for schema-error details. */
function formatZodIssues(error: {
  issues: Array<{ path: (string | number)[]; message: string }>;
}): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** normalizeRefField over a raw pre-Zod value: the shared rule with the
 * unknown-cast in one spot. */
function stringOrArray(v: unknown): string[] {
  return normalizeRefField(v as string | string[] | undefined | null);
}

/** Flattened codon list: [key, rawCodon, rawParentLoop|null]. */
export function flattenCodons(rawHank: unknown[]): Array<{
  key: string;
  codon: Record<string, unknown>;
  loop: Record<string, unknown> | null;
}> {
  const out: Array<{
    key: string;
    codon: Record<string, unknown>;
    loop: Record<string, unknown> | null;
  }> = [];
  for (const item of rawHank) {
    const rec = asRecord(item);
    if (rec.type === "loop") {
      const codons = (rec.codons as unknown[]) ?? [];
      for (const child of codons) {
        const childRec = asRecord(child);
        out.push({ key: `${rec.id}/${childRec.id}`, codon: childRec, loop: rec });
      }
    } else {
      out.push({ key: String(rec.id), codon: rec, loop: null });
    }
  }
  return out;
}

// -------------
// Entry point
// -------------

interface RootProblem {
  category: LintErrorCategory;
  where: string;
  detail: string;
}

/**
 * Resolve the CLI argument to the config path, and describe up front what
 * is wrong with the argument itself (in the user's own spelling) when it
 * cannot name a hank: a missing directory, a directory without hank.json,
 * or a file that is not a JSON config. Classify by filesystem type first: a
 * directory named "foo.json" is still a directory; the extension heuristic
 * only decides the not-found case.
 */
function resolveHankJsonPath(hankPathOrDir: string): {
  hankJsonPath: string;
  problem: RootProblem | null;
} {
  const hankJsonPath = HankConfigFile.fromInput(hankPathOrDir).path;
  // Path selection belongs to HankConfigFile. A selected child hank.json
  // means the argument names a directory (including a missing directory);
  // pack owns only the diagnostic wording and JSON-extension requirement.
  const resolvedInput = path.resolve(hankPathOrDir);
  const inputIsDir = hankJsonPath !== resolvedInput;
  let problem: RootProblem | null = null;
  if (inputIsDir) {
    if (!fs.existsSync(resolvedInput)) {
      problem = {
        category: "not-a-hank",
        where: "hank.json",
        detail: `directory ${hankPathOrDir} does not exist`,
      };
    } else if (!fs.existsSync(hankJsonPath)) {
      problem = {
        category: "not-a-hank",
        where: "hank.json",
        detail: `no hank.json in ${hankPathOrDir}`,
      };
    }
  } else if (!hankJsonPath.endsWith(".json")) {
    problem = {
      category: "not-a-hank",
      where: hankPathOrDir,
      detail: "expected hank.json or a directory containing one",
    };
  } else if (!fs.existsSync(hankJsonPath)) {
    problem = {
      category: "missing-file",
      where: "hank.json",
      detail: `${hankPathOrDir} does not exist`,
    };
  }
  return { hankJsonPath, problem };
}

function validateReservedRoot(walker: ClosureWalker): boolean {
  const { hankJsonPath } = walker;
  // hank.lock is reserved at the hank root: it may only be a regular file
  // (a leftover lock from a previous pack — ignored, never a member).
  // Phase 2 writes the real lock FILE at that exact root path, so nothing
  // may nest beneath it — and the root config may not BE it: a config
  // supplied as "hank.lock" (or hank.json symlinked to it) would pack
  // fine and then be overwritten by the generated lock.
  const lockPath = walker.hank.ref(RESERVED_LOCK_PATH).path;
  if (path.resolve(hankJsonPath) === lockPath) {
    walker.error(
      "reserved-path",
      RESERVED_LOCK_PATH,
      `root config ${hankJsonPath} occupies the reserved ${RESERVED_LOCK_PATH} path; pack writes the generated lock there — rename the config file`,
    );
    return false;
  }
  try {
    const lockStat = fs.lstatSync(lockPath);
    if (!lockStat.isFile()) {
      walker.error(
        "reserved-path",
        RESERVED_LOCK_PATH,
        `${RESERVED_LOCK_PATH} is a reserved bundle member owned by pack and must be a regular file if present`,
      );
      return false;
    }
    if (fs.realpathSync(hankJsonPath) === fs.realpathSync(lockPath)) {
      walker.error(
        "reserved-path",
        RESERVED_LOCK_PATH,
        `root config ${hankJsonPath} is the same file as the reserved ${RESERVED_LOCK_PATH}; pack writes the generated lock there — rename the config file`,
      );
      return false;
    }
  } catch {
    // lock absent (or root config unreadable — reported by the read below)
  }

  return true;
}

function readRootSnapshot(walker: ClosureWalker): { bytes: Buffer; mode: FileMode } | null {
  const { hankJsonPath } = walker;
  let hankBytes: Buffer;
  let hankMode: FileMode = "644";
  try {
    // The config file applies regular-file and size gates before reading, while
    // preserving the root entry point's symlink-following behavior.
    const snapshot = walker.hank.config.readSnapshot({
      maxBytes: walker.quotas.maxMemberBytes,
    });
    if (snapshot.kind === "irregular") {
      walker.error(
        "missing-file",
        "hank.json",
        `${hankJsonPath} is not a regular file (FIFOs/devices cannot be packed)`,
      );
      return null;
    }
    if (snapshot.kind === "too-large") {
      walker.error(
        "closure-too-large",
        "hank.json",
        `${hankJsonPath} is ${snapshot.size} bytes; bundle members are limited to ${walker.quotas.maxMemberBytes} bytes`,
      );
      return null;
    }
    hankMode = modeOf(snapshot.stats);
    hankBytes = snapshot.bytes;
  } catch {
    walker.error("missing-file", "hank.json", `not found at ${hankJsonPath}`);
    return null;
  }
  // A ref back to the root config (e.g. promptFile: "hank.json") must reuse
  // these bytes, not re-read the file (issue 03 snapshot semantics).
  walker.seedSnapshot(hankJsonPath, hankBytes, hankMode);

  return { bytes: hankBytes, mode: hankMode };
}

/** The explicit root `.gitignore` as captured before the loader gate:
 * `bytes` is null when there is none to ship. */
interface RootGitignore {
  path: string;
  bytes: Buffer | null;
  mode: FileMode;
}

function snapshotRootGitignore(walker: ClosureWalker): RootGitignore {
  // Copy-tree ignore rules. Snapshot the explicit root .gitignore ONCE: the
  // same bytes drive the filter here and ship as the `.gitignore` bundle
  // member below, so the shipped rules can never diverge from the applied
  // ones mid-pack. A symlinked or non-regular .gitignore is not snapshotted:
  // the loader gate below rejects it (load-error, loader's own words) iff a
  // copy tree exists for it to govern — with no copy refs the rules are
  // moot and the file simply does not ship.
  const gitignorePath = walker.hank.ref(RESERVED_IGNORE_PATH).path;
  let bytes: Buffer | null = null;
  let mode: FileMode = "644";
  try {
    // The hank's own exact-spelling read: a case-insensitive filesystem
    // resolves the lookup for a file actually named .GITIGNORE, which is
    // NOT the rules file on any platform.
    const rules = walker.hank.readRulesFile();
    if (rules !== null) {
      bytes = rules.bytes;
      mode = rules.mode;
      walker.seedSnapshot(gitignorePath, bytes, mode);
    }
  } catch {
    // symlinked, non-regular, or unreadable — the loader gate reports that
    // when it matters (a copy tree exists for the rules to govern)
  }
  return { path: gitignorePath, bytes, mode };
}

function validateRootSnapshot(walker: ClosureWalker, hankBytes: Buffer): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(hankBytes.toString("utf8"));
  } catch (e) {
    // Fixed detail; the engine's wording differs between Bun and Node, so
    // it travels as a note (stderr), not in the finding.
    walker.error("invalid-json", "hank.json", "not valid JSON", errorText(e));
    return false;
  }
  walker.raw = raw;

  const parsed = hankFileSchema.safeParse(raw);
  if (!parsed.success) {
    walker.error("schema-error", "hank.json", formatZodIssues(parsed.error));
    return false;
  }

  return true;
}

function gateGlobalPromptSize(walker: ClosureWalker): boolean {
  // Pre-loader size gate: loadCodonSequence READS the global system
  // prompt in full (loadGlobalSystemPrompt → HankRef.readText) — the only
  // referenced file whose contents the loader consumes — so an over-quota
  // file would be allocated wholesale before any walker quota could fire.
  // Stat-gate it here; every other problem with the ref (missing, symlink,
  // policy) is left for the loader to report in its own words.
  {
    const value = asRecord(walker.raw).globalSystemPromptFile;
    for (const [i, ref] of stringOrArray(value).entries()) {
      if (ref === "") continue;
      try {
        const lst = fs.lstatSync(walker.hank.ref(ref).path);
        if (lst.isFile() && lst.size > walker.quotas.maxMemberBytes) {
          walker.error(
            "closure-too-large",
            Array.isArray(value) ? `globalSystemPromptFile[${i}]` : "globalSystemPromptFile",
            `${ref} is ${lst.size} bytes; bundle members are limited to ${walker.quotas.maxMemberBytes} bytes`,
          );
          return false;
        }
      } catch {
        // Unresolvable or unstattable ref — the walk reports it.
      }
    }
  }
  return true;
}

/**
 * THE policy gate: run the runtime loader. It enforces the strict-ref rules
 * (R1/R2/R3 including copy.from tree scans), file existence, model validity,
 * and sentinel config integrity — everything the runtime would refuse at
 * codon start. Returns the loader's message on refusal, null when the hank
 * loads. The caller walks either way: the walk re-checks the same rules on
 * the captured bytes and names each problem at its field, so the message
 * is only surfaced when the walk reproduced nothing (loaderFailureFindings).
 */
function loaderRefusal(hankJsonPath: string): string | null {
  try {
    loadCodonSequence({ configPath: hankJsonPath });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * The loader's refusal as finding details, one per violation: the
 * "Failed to load codon config from <path>: " and "Codon configuration
 * validation failed:" preambles dropped, the runtime's [ERROR]/[WARNING]
 * severity tags dropped, the hank directory prefix stripped from paths, and
 * indented continuation lines folded into the violation above them.
 */
export function loaderFailureFindings(message: string, hankJsonPath: string): string[] {
  const hankDir = path.dirname(hankJsonPath);
  let text = message;
  const loadPrefix = `Failed to load codon config from ${hankJsonPath}: `;
  if (text.startsWith(loadPrefix)) text = text.slice(loadPrefix.length);
  const validationPrefix = "Codon configuration validation failed:\n";
  if (text.startsWith(validationPrefix)) text = text.slice(validationPrefix.length);
  const details: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.trim() === "") continue;
    if (/^\s/.test(rawLine) && details.length > 0) {
      details[details.length - 1] += ` ${rawLine.trim()}`;
      continue;
    }
    const line = rawLine.trim().replace(/ \[(ERROR|WARNING)\]$/, "");
    details.push(stripHankDirPrefixes(line, hankDir));
  }
  return details.length > 0 ? details : [message];
}

/** Apply the loader gate, then report problems at their authored fields.
 * Guard prompt allocation before the loader reads; walk even on refusal,
 * falling back to loader messages only when the captured refs look valid. */
function validateAndWalkRootRefs(walker: ClosureWalker): boolean {
  if (!gateGlobalPromptSize(walker)) return false;
  const refusal = loaderRefusal(walker.hankJsonPath);
  walkRootRefs(walker);
  if (walker.findings.some((f) => f.severity === "error")) return false;
  if (refusal === null) return true;

  for (const detail of loaderFailureFindings(refusal, walker.hankJsonPath)) {
    walker.error("load-error", "hank.json", detail);
  }
  return false;
}

function walkRootRefs(walker: ClosureWalker): void {
  const rawRoot = asRecord(walker.raw);
  const hankDir = walker.hankDir;

  // Root: globalSystemPromptFile
  stringOrArray(rawRoot.globalSystemPromptFile).forEach((ref, i) => {
    const isArray = Array.isArray(rawRoot.globalSystemPromptFile);
    walker.handleRef({
      raw: ref,
      baseDir: hankDir,
      where: isArray ? `globalSystemPromptFile[${i}]` : "globalSystemPromptFile",
      allowDir: false,
    });
  });

  // Codons (incl. loop children), duplicate-key check
  const flattened = flattenCodons((rawRoot.hank as unknown[]) ?? []);
  const seenKeys = new Set<string>();
  for (const { key } of flattened) {
    if (seenKeys.has(key)) {
      walker.error(
        "duplicate-codon-id",
        key,
        `two codons have the id "${key}"; ids must be unique`,
      );
    }
    seenKeys.add(key);
  }

  for (const { key, codon } of flattened) {
    walkCodonRefs(walker, key, codon);
  }
}

function checkIgnoreRulesUnchanged(walker: ClosureWalker, gitignore: RootGitignore): boolean {
  // The hank read the root .gitignore lazily (first directory copy); the
  // fold below ships the bytes snapshotted BEFORE the loader gate. Both
  // reads must agree, or the shipped rules differ from the applied ones —
  // the same mid-pack divergence the .gitignore fold refuses.
  const viewRootSource = walker.hank.rootRuleSource();
  if (viewRootSource === undefined) return true;
  const viewBytes = viewRootSource?.bytes ?? null;
  const same =
    viewBytes === null
      ? gitignore.bytes === null
      : gitignore.bytes !== null && viewBytes.equals(gitignore.bytes);
  if (!same) {
    walker.error(
      "reserved-path",
      ".gitignore",
      `.gitignore changed while pack was running: the closure was judged under different ignore rules than the bundle would ship; re-run pack`,
    );
    return false;
  }
  return true;
}

function includeRootFile(
  walker: ClosureWalker,
  hankBytes: Buffer,
  hankMode: FileMode,
): Map<string, ClosureFileEntry> | null {
  const { hankJsonPath } = walker;
  // Fold the root config into the file list at the canonical hank.json
  // slot. A ref may already have put a file there: the root config itself
  // (same source — the seeded snapshot guarantees identical bytes), or,
  // when the root config was supplied under another name (alt.json), a
  // sibling file literally named hank.json — refusing beats silently
  // shipping the wrong bytes at one of the two paths.
  const allFiles = new Map<string, ClosureFileEntry>(walker.fileEntries);
  const occupant = allFiles.get("hank.json");
  if (occupant && occupant.sourcePath !== hankJsonPath) {
    walker.error(
      "reserved-path",
      "hank.json",
      `bundle path collision: root config ${hankJsonPath} and closure member ${occupant.sourcePath} both land at hank.json`,
    );
    return null;
  }
  if (!occupant) {
    // The fold-in bypasses addFileEntry, so it must apply the same
    // member-count and total-byte accounting the walk applied.
    if (allFiles.size >= walker.quotas.maxMembers) {
      walker.error(
        "closure-too-large",
        "hank.json",
        `bundle exceeds ${walker.quotas.maxMembers} members`,
      );
      return null;
    }
    if (walker.totalBytes + hankBytes.length > walker.quotas.maxTotalBytes) {
      walker.error(
        "closure-too-large",
        "hank.json",
        `bundle exceeds ${walker.quotas.maxTotalBytes} total bytes`,
      );
      return null;
    }
    allFiles.set("hank.json", {
      bundlePath: "hank.json",
      sourcePath: hankJsonPath,
      sha256: sha256Hex(hankBytes),
      mode: hankMode,
      bytes: hankBytes,
    });
  }

  return allFiles;
}

function includeRootGitignore(
  walker: ClosureWalker,
  allFiles: Map<string, ClosureFileEntry>,
  gitignore: RootGitignore,
): boolean {
  // An explicit root .gitignore ships as a bundle member (same fold as
  // hank.json): the rules that shaped every copy tree are part of what the
  // bundle IS, and a repack of the extracted bundle then applies the same
  // rules instead of falling back to the implicit defaults. Same-source
  // occupant (a ref literally naming ".gitignore") reuses the snapshot
  // bytes; a different source cannot happen for an in-dir path — defensive
  // all the same, mirroring the hank.json fold.
  if (gitignore.bytes !== null) {
    const occupant = allFiles.get(".gitignore");
    if (occupant && occupant.sourcePath !== gitignore.path) {
      walker.error(
        "reserved-path",
        ".gitignore",
        `bundle path collision: root .gitignore ${gitignore.path} and closure member ${occupant.sourcePath} both land at .gitignore`,
      );
      return false;
    }
    if (!occupant) {
      allFiles.set(".gitignore", {
        bundlePath: ".gitignore",
        sourcePath: gitignore.path,
        sha256: sha256Hex(gitignore.bytes),
        mode: gitignore.mode,
        bytes: gitignore.bytes,
      });
    }
    return true;
  }
  if (allFiles.has(".gitignore")) {
    // TOCTOU: no .gitignore existed when the rules were captured (the walk
    // used the implicit defaults), yet a member landed at the slot — the
    // file appeared mid-pack and a direct ref swept it in. Shipping it
    // would hand the extracted hank explicit rules the tree hashes were
    // never built under; refuse, like every other mid-pack divergence.
    walker.error(
      "reserved-path",
      ".gitignore",
      `.gitignore appeared while pack was running: the closure was computed with the default ignore rules, but the bundle would ship explicit rules; re-run pack`,
    );
    return false;
  }
  return true;
}

function checkMemberAncestors(
  walker: ClosureWalker,
  allFiles: Map<string, ClosureFileEntry>,
  canonicalMembers: Map<string, string>,
): void {
  for (const p of allFiles.keys()) {
    for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) {
      const ancestor = p.slice(0, i);
      const claimant = canonicalMembers.get(portableCollisionKey(ancestor));
      if (claimant !== undefined) {
        walker.error(
          claimant === ancestor ? "missing-file" : "non-portable-path",
          p,
          `bundle member ${claimant} is a file but also a parent directory of ${p}${
            claimant === ancestor ? "" : ` ${ALIAS_SUFFIX}`
          }`,
        );
      }
    }
  }
}

function checkMemberCollisions(
  walker: ClosureWalker,
  allFiles: Map<string, ClosureFileEntry>,
): void {
  // No extracted filesystem can hold both a FILE at p and members under
  // p/… — catch ancestor/descendant collisions across the final set
  // (e.g. a directory literally named hank.json swept by copy.from while
  // the root config claims the hank.json file slot). Both this and the
  // member-vs-member scan compare portable canonical keys, not exact
  // strings: paths distinct on the case-sensitive source can extract to one
  // path where names fold. The scan here (rather than only addFileEntry) is
  // what covers the folded-in hank.json slot, which bypasses addFileEntry.
  const canonicalMembers = new Map<string, string>();
  for (const p of allFiles.keys()) {
    const claimant = canonicalMembers.get(portableCollisionKey(p));
    if (claimant !== undefined && claimant !== p) {
      walker.error(
        "non-portable-path",
        p,
        `bundle members ${claimant} and ${p} are distinct here but alias ${ALIAS_SUFFIX}; rename one`,
      );
    }
    canonicalMembers.set(portableCollisionKey(p), p);
  }
  checkMemberAncestors(walker, allFiles, canonicalMembers);
}

/** Whether the walk would have skipped `bundlePath`. ANCESTOR memo first: a
 * member inside a PRUNED directory is ignored by git's parent-exclusion no
 * matter what — asking the oracle directly would auto-enter the pruned
 * directory, snapshotting rule files the walk (and the loader, and the
 * runtime) never read, AFTER shipping already happened. */
function ignoredForRehash(walker: ClosureWalker, bundlePath: string): boolean {
  for (let i = bundlePath.indexOf("/"); i !== -1; i = bundlePath.indexOf("/", i + 1)) {
    if (walker.prunedDirs.has(bundlePath.slice(0, i))) return true;
  }
  return walker.hank.isIgnored(bundlePath, false);
}

function verifyTreeHash(
  walker: ClosureWalker,
  record: RefRecord,
  allFiles: Map<string, ClosureFileEntry>,
): void {
  const prefix = `${record.bundlePath}/`;
  // A DIRECT ref may legally ship a member the tree walk skipped
  // (explicit refs are never filtered — e.g. promptFile naming an
  // ignored file inside the copy root). The rehash must apply the same
  // filter the walk did, or such members would fail it.
  const lines: string[] = [];
  for (const entry of allFiles.values()) {
    if (entry.bundlePath.startsWith(prefix) && !ignoredForRehash(walker, entry.bundlePath)) {
      lines.push(`${entry.bundlePath.slice(prefix.length)}\0${entry.mode}\0${entry.sha256}\n`);
    }
  }
  lines.sort(compareUtf8);
  if (sha256Hex(lines.join("")) !== record.sha256) {
    throw new Error(
      `pack internal error: tree hash for ${record.bundlePath} does not match the shipped members (ref ${record.raw})`,
    );
  }
}

function verifyRefHashes(walker: ClosureWalker, allFiles: Map<string, ClosureFileEntry>): void {
  // Self-check: every RefRecord must agree with the shipped bytes at its
  // bundle path — record hashes feed codonInputs while file entries feed
  // files/bundleHash, and a divergence means the lock disagrees with
  // itself about a member's hash. Reaching a throw is always a pack bug,
  // never a user mistake.
  for (const record of walker.refs.values()) {
    if (record.kind === "file") {
      const entry = allFiles.get(record.bundlePath);
      if (!entry || entry.sha256 !== record.sha256) {
        throw new Error(
          `pack internal error: recorded hash for ${record.bundlePath} does not match the shipped bytes (ref ${record.raw})`,
        );
      }
    } else {
      verifyTreeHash(walker, record, allFiles);
    }
  }
}

/**
 * Compute the full file closure, lint findings, and bundle-member set for
 * the hank at `hankPathOrDir` (a hank.json path or its directory).
 */
export function computeClosure(
  hankPathOrDir: string,
  options: { quotas?: Partial<ClosureQuotas> } = {},
): ClosureResult {
  assertGitAvailable("pack");
  const { hankJsonPath, problem } = resolveHankJsonPath(hankPathOrDir);
  const walker = new ClosureWalker(hankJsonPath, { ...DEFAULT_QUOTAS, ...options.quotas });
  try {
    return computeClosureWith(walker, hankJsonPath, problem);
  } finally {
    walker.hank.dispose();
  }
}

/** The body of computeClosure, split out so the hank's mirror repo is
 * always disposed — every early `return fail()` passes the finally above. */
function computeClosureWith(
  walker: ClosureWalker,
  hankJsonPath: string,
  problem: RootProblem | null,
): ClosureResult {
  const fail = (): ClosureResult => ({
    ok: false,
    hankDir: walker.hankDir,
    hankJsonPath,
    raw: walker.raw,
    files: [],
    findings: walker.findings,
    refs: walker.refs,
  });

  // Reserved-root first: a config supplied AS hank.lock is a non-.json file
  // too, and the reserved-path finding is the one that says why it fails.
  if (!validateReservedRoot(walker)) return fail();
  if (problem) {
    walker.error(problem.category, problem.where, problem.detail);
    return fail();
  }
  const snapshot = readRootSnapshot(walker);
  if (!snapshot) return fail();
  const gitignore = snapshotRootGitignore(walker);
  if (!validateRootSnapshot(walker, snapshot.bytes)) return fail();
  if (!validateAndWalkRootRefs(walker)) return fail();
  if (!checkIgnoreRulesUnchanged(walker, gitignore)) return fail();

  const allFiles = includeRootFile(walker, snapshot.bytes, snapshot.mode);
  if (!allFiles) return fail();
  if (!finalizeClosureFiles(walker, allFiles, gitignore)) return fail();

  return {
    ok: true,
    hankDir: walker.hankDir,
    hankJsonPath,
    raw: walker.raw,
    files: [...allFiles.values()].sort((a, b) => compareUtf8(a.bundlePath, b.bundlePath)),
    findings: walker.findings,
    refs: walker.refs,
  };
}

function finalizeClosureFiles(
  walker: ClosureWalker,
  allFiles: Map<string, ClosureFileEntry>,
  gitignore: Parameters<typeof includeRootGitignore>[2],
): boolean {
  if (!includeRootGitignore(walker, allFiles, gitignore)) return false;
  checkMemberCollisions(walker, allFiles);
  if (walker.findings.some((f) => f.severity === "error")) return false;
  verifyRefHashes(walker, allFiles);

  return true;
}

// -------------
// Extension seam (issue 07): auxiliary bundle members
// -------------

/** An auxiliary member contributed by a consumer outside the hank's own
 * closure (e.g. U14's comments.jsonl). */
export interface AdditionalMember {
  /** Path inside the bundle: relative, POSIX separators, normalized. */
  bundlePath: string;
  bytes: Buffer;
  /** Normalized mode; defaults to "644". */
  mode?: FileMode;
}

type RejectAdditionalMember = (why: string) => never;
type CopyRoot = { path: string; key: string };

function validateAdditionalPath(p: string, reject: RejectAdditionalMember): string {
  if (p === "") reject("empty path");
  // Native member names cannot contain NUL (no filesystem allows it),
  // but an extension-supplied string can — and it would truncate or fail
  // in a tar header long after this closure claimed success.
  if (p.includes("\u0000")) reject("member names may not contain NUL bytes");
  if (p.includes("\\")) reject("POSIX separators required");
  if (path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) reject("must be relative");
  const segments = p.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    reject("must be normalized with no empty, '.' or '..' segments");
  }
  return validateAdditionalName(p, reject);
}

function validateAdditionalName(p: string, reject: RejectAdditionalMember): string {
  // Same per-name portability rules native members get in addFileEntry
  // (control chars, Windows reserved devices, trailing dot/space; the
  // backslash/NUL cases were already rejected above).
  const nameProblem = portableNameProblem(p);
  if (nameProblem) reject(nameProblem);
  const canonKey = portableCollisionKey(p);
  if (canonKey === RESERVED_LOCK_PATH || canonKey.startsWith(`${RESERVED_LOCK_PATH}/`)) {
    // The runtime lock is a regular FILE at the bundle root; no extracted
    // filesystem can hold both that file and members beneath the name —
    // and a case/normalization variant (HANK.LOCK) extracts onto it where
    // names fold.
    reject(`${RESERVED_LOCK_PATH} is reserved`);
  }
  if (canonKey === RESERVED_IGNORE_PATH || canonKey.startsWith(`${RESERVED_IGNORE_PATH}/`)) {
    // The root .gitignore is a SEMANTIC slot: on extraction it becomes
    // the hank's copy-tree ignore rules (hank-dir.ts). An auxiliary
    // member there would rewrite rules the tree hashes were built
    // without (and a directory at the name makes readHankGitignore throw
    // — the extracted hank would not load). When an explicit .gitignore
    // exists it is already a member, so the plain collision gate covers
    // it; this covers the implicit-defaults case where the slot is empty.
    reject(".gitignore is reserved (it defines the hank's copy-tree ignore rules)");
  }
  return canonKey;
}

function checkAdditionalCollision(
  p: string,
  canonKey: string,
  merged: Map<string, ClosureFileEntry>,
  canonical: Map<string, string>,
  reject: RejectAdditionalMember,
): void {
  if (merged.has(p)) reject("collides with an existing bundle member");
  const claimant = canonical.get(canonKey);
  if (claimant !== undefined) {
    reject(`aliases existing bundle member ${claimant} ${ALIAS_SUFFIX}`);
  }
}

function checkAdditionalCopyRoots(
  canonKey: string,
  copyRoots: CopyRoot[],
  reject: RejectAdditionalMember,
): void {
  for (const root of copyRoots) {
    if (canonKey === root.key || canonKey.startsWith(`${root.key}/`)) {
      reject(
        `lands inside copy root ${root.path}/ — the rig copy would include bytes absent from that codon's tree hash and codonInputs`,
      );
    }
  }
}

function checkAdditionalAncestors(
  canonKey: string,
  canonical: Map<string, string>,
  reject: RejectAdditionalMember,
): void {
  for (const [existingKey, existingPath] of canonical) {
    if (existingKey.startsWith(`${canonKey}/`)) {
      reject(`is a parent directory of existing member ${existingPath}`);
    }
    if (canonKey.startsWith(`${existingKey}/`)) {
      reject(`existing member ${existingPath} is a file, not a directory`);
    }
  }
}

/**
 * Return a new ClosureResult with `members` merged into `files`, each
 * passing the same gates as native members: valid normalized relative POSIX
 * path, no reserved paths (hank.lock), no collision with an existing
 * member, no file-vs-directory ancestor conflict — collisions and conflicts
 * compared by portable canonical key (NFC + case fold), since paths
 * distinct here can extract to one path where names fold. Downstream is untouched
 * by construction — buildLock folds the additions into `files` and the
 * identity payload, so `bundleHash` covers them; archive writers consume
 * the merged snapshot. Programmatic API: throws on any invalid member
 * (these are producer bugs, not authored-hank lint findings).
 */
export function extendClosure(
  closure: ClosureResult,
  members: readonly AdditionalMember[],
): ClosureResult {
  if (!closure.ok) {
    throw new Error("extendClosure requires a successful closure (lint errors present)");
  }
  if (members.length === 0) return closure;

  const merged = new Map<string, ClosureFileEntry>(
    closure.files.map((entry) => [entry.bundlePath, entry]),
  );
  // Collision/ancestor checks below compare portable canonical keys, not
  // exact strings — an auxiliary member distinct from a native one on the
  // case-sensitive source can extract to the same path where names fold.
  const canonical = new Map<string, string>();
  for (const existing of merged.keys()) {
    canonical.set(portableCollisionKey(existing), existing);
  }
  // Directory copy.from sources: the extracted tree is copied into the rig
  // at run time, so an auxiliary member inside one would ride along without
  // being part of the copy's tree hash or the owning codon's codonInputs.
  const copyRoots = [...closure.refs.values()]
    .filter((record) => record.kind === "dir")
    .map((record) => ({ path: record.bundlePath, key: portableCollisionKey(record.bundlePath) }));
  for (const member of members) {
    const p = member.bundlePath;
    const reject = (why: string): never => {
      throw new Error(`extendClosure: invalid member ${JSON.stringify(p)}: ${why}`);
    };
    const canonKey = validateAdditionalPath(p, reject);
    checkAdditionalCollision(p, canonKey, merged, canonical, reject);
    checkAdditionalCopyRoots(canonKey, copyRoots, reject);
    checkAdditionalAncestors(canonKey, canonical, reject);
    // Snapshot the caller's buffer: producers may reuse or mutate it after
    // this returns, and the hash must forever describe the bytes we ship.
    const bytes = Buffer.from(member.bytes);
    merged.set(p, {
      bundlePath: p,
      sourcePath: "",
      sha256: sha256Hex(bytes),
      mode: member.mode ?? "644",
      bytes,
    });
    canonical.set(canonKey, p);
  }

  return {
    ...closure,
    files: [...merged.values()].sort((a, b) => compareUtf8(a.bundlePath, b.bundlePath)),
  };
}

// -------------
// Per-codon walk
// -------------

function walkCodonRefs(walker: ClosureWalker, key: string, codon: Record<string, unknown>): void {
  const hankDir = walker.hankDir;

  const fileField = (field: "promptFile" | "appendSystemPromptFile"): void => {
    const value = codon[field];
    stringOrArray(value).forEach((ref, i) => {
      const isArray = Array.isArray(value);
      walker.handleRef({
        raw: ref,
        baseDir: hankDir,
        where: isArray ? `${key}.${field}[${i}]` : `${key}.${field}`,
        allowDir: false,
      });
    });
  };
  fileField("promptFile");
  fileField("appendSystemPromptFile");

  // rigSetup: copy sources join the closure; command strings are linted.
  const rigSetup = (codon.rigSetup as unknown[]) ?? [];
  rigSetup.forEach((item, i) => {
    const rec = asRecord(item);
    if (rec.type === "copy") {
      const copy = asRecord(rec.copy);
      walker.handleRef({
        raw: String(copy.from),
        baseDir: hankDir,
        where: `${key}.rigSetup[${i}].copy.from`,
        allowDir: true,
      });
    } else if (rec.type === "command") {
      lintRunString(walker, String(asRecord(rec.command).run), `${key}.rigSetup[${i}].command.run`);
    }
  });

  // outputFiles[].beforeCopy[]: lint-only (targets are runtime outputs).
  const outputFiles = (codon.outputFiles as unknown[]) ?? [];
  outputFiles.forEach((out, i) => {
    const beforeCopy = (asRecord(out).beforeCopy as unknown[]) ?? [];
    beforeCopy.forEach((cmd, j) => {
      lintRunString(
        walker,
        String(asRecord(asRecord(cmd).command).run),
        `${key}.outputFiles[${i}].beforeCopy[${j}].command.run`,
      );
    });
  });

  // env: values ship inside the bundle — lint keys and values.
  const env = (codon.env as Record<string, string>) ?? {};
  for (const [envKey, envValue] of Object.entries(env)) {
    if (SECRET_KEY_RE.test(envKey)) {
      walker.warn(
        "inline-env",
        `${key}.env.${envKey}`,
        "value looks secret-like and ships inside the bundle",
      );
    }
    if (HOME_REF_RE.test(envValue)) {
      walker.warn("home-ref", `${key}.env.${envKey}`, `machine-bound literal in value`);
    }
  }

  // sentinels
  const sentinels = (codon.sentinels as unknown[]) ?? [];
  const seenSentinelIds = new Set<string>();
  sentinels.forEach((entry, i) => {
    const rec = asRecord(entry);
    const sentinelConfig = rec.sentinelConfig;
    const where = `${key}.sentinels[${i}].sentinelConfig`;
    let sentinelId: unknown;
    if (typeof sentinelConfig === "string") {
      sentinelId = walkFileSentinelConfig(walker, { raw: sentinelConfig, where });
    } else {
      sentinelId = asRecord(sentinelConfig).id;
      walkSentinelConfigRefs(walker, {
        config: asRecord(sentinelConfig),
        baseDir: hankDir,
        wherePrefix: where,
        collectRefs: null,
      });
    }
    // Mirrors the loader's duplicate-id check: sentinel ids key runtime
    // state within a codon, so the loader refuses a repeat.
    if (typeof sentinelId === "string") {
      if (seenSentinelIds.has(sentinelId)) {
        walker.error(
          "duplicate-sentinel-id",
          where,
          `two sentinels in codon "${key}" have the id "${sentinelId}"; sentinel ids must be unique within a codon`,
        );
      }
      seenSentinelIds.add(sentinelId);
    }
  });
}

function lintRunString(walker: ClosureWalker, run: string, where: string): void {
  if (HOME_REF_RE.test(run)) {
    walker.warn("home-ref", where, "machine-bound literal in command");
  }
  if (NETWORK_OP_RE.test(run)) {
    walker.warn("network-op", where, "bundle will need network (and credentials) at run time");
  }
}

/** A string `sentinelConfig`: the JSON file itself joins the closure, then
 * its own prompt/schema refs resolve relative to the config file's dir.
 * ANCHOR RULE MIRROR of sentinels/sentinel-config-loader.ts — the loader
 * owns this rule; if it changes there, change here too (the
 * resolution-parity tests are the tripwire; fix the anchor, never the
 * test). */
function walkFileSentinelConfig(
  walker: ClosureWalker,
  options: { raw: string; where: string },
): unknown {
  const { raw, where } = options;
  const record = walker.handleRef({
    raw,
    baseDir: walker.hankDir,
    where,
    allowDir: false,
  });
  if (!record) return null;

  // Parse the bytes the file entry captured — never re-read the source
  // path: a file changing between the hash read and a second read would put
  // one hash in codonInputs (via the ref record) and different bytes in the
  // archive (issue 03). The loader schema-validated its OWN earlier read of
  // this config; the captured bytes can diverge if the file changed
  // mid-pack, so the schema gate runs again here on exactly the bytes that
  // ship.
  const entry = walker.fileEntries.get(record.bundlePath);
  if (!entry) {
    throw new Error(`pack internal error: no captured bytes for ${record.bundlePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.bytes.toString("utf8"));
  } catch (e) {
    walker.error("invalid-json", where, `${raw} is not valid JSON`, errorText(e));
    return null;
  }
  const checked = sentinelConfigSchema.safeParse(parsed);
  if (!checked.success) {
    walker.error("schema-error", where, `${raw}: ${formatZodIssues(checked.error)}`);
    return null;
  }

  const refs: SentinelFileRefs = {};
  walkSentinelConfigRefs(walker, {
    config: asRecord(parsed),
    baseDir: path.dirname(record.resolved),
    wherePrefix: `${where} (${record.bundlePath})`,
    collectRefs: refs,
  });
  record.sentinelRefs = refs;
  return asRecord(parsed).id;
}

/** Walk a sentinel config's own path fields (file-based or inline). */
function walkSentinelConfigRefs(
  walker: ClosureWalker,
  options: {
    config: Record<string, unknown>;
    baseDir: string;
    wherePrefix: string;
    collectRefs: SentinelFileRefs | null;
  },
): void {
  const { config, baseDir, wherePrefix, collectRefs } = options;

  const promptField = (field: "systemPromptFile" | "userPromptFile"): void => {
    const value = config[field];
    const hashes: string[] = [];
    stringOrArray(value).forEach((ref, i) => {
      const isArray = Array.isArray(value);
      const record = walker.handleRef({
        raw: ref,
        baseDir,
        where: isArray ? `${wherePrefix}.${field}[${i}]` : `${wherePrefix}.${field}`,
        allowDir: false,
      });
      if (record) hashes.push(record.sha256);
    });
    if (collectRefs && value !== undefined) collectRefs[field] = hashes;
  };
  promptField("systemPromptFile");
  promptField("userPromptFile");

  const structured = config.structuredOutput as Record<string, unknown> | undefined;
  const schemaFile = structured?.schemaFile;
  if (typeof schemaFile === "string" && schemaFile) {
    const record = walker.handleRef({
      raw: schemaFile,
      baseDir,
      where: `${wherePrefix}.structuredOutput.schemaFile`,
      allowDir: false,
    });
    if (collectRefs) collectRefs.schemaFile = record ? [record.sha256] : [];
  }
}
