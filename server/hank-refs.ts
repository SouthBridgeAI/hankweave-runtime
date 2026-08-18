import fs from "node:fs";
import path from "node:path";
import { checkRegularFile } from "./fs-guards.js";

/**
 * Shared resolver for hank config file references.
 *
 * A hank's config files name other files as strings ("promptFile":
 * "prompts/main.md"). This module is the single owner of the conversion from
 * such an authored ref to an absolute path, and of the normalization rule for
 * fields that may be a string, a list of strings, or empty. Spec:
 * intermediates/62-hank-ref-resolver/hank-refs-spec.md.
 *
 * Relative refs resolve against a base dir — the hank dir for fields in
 * hank.json itself, or a file-based sentinel config's own directory for refs
 * inside it. There is deliberately no cwd fallback: baseDir is required.
 *
 * Not to be confused with file-resolver.ts (UnifiedFileResolver), which
 * expands glob patterns over the agent workspace respecting gitignore. Hank
 * config refs never consult gitignore and never glob.
 *
 * Everything here except readRef and validateRef is pure path math — no
 * filesystem access — so validation and pack can ask "where would this
 * resolve to?" without touching disk.
 *
 * This module also owns the POLICY layer for strict hank refs (spec:
 * intermediates/63-strict-hank-paths/strict-paths-spec.md): refs must be
 * portable POSIX-style relative paths (R1), must never climb above the hank
 * root (R2), and must not pass through a symlink (R3). Resolution
 * (resolveRef) and policy (validateRef) stay distinct functions with one
 * home; resolveRef's absolute-passthrough contract is unchanged because
 * policy rejects absolute spellings before resolution matters.
 */

/**
 * An absolute path produced by resolveRef. The brand makes "this went through
 * hank-refs" checkable by the type system: a hand-rolled path.resolve yields a
 * plain string that won't typecheck where a ResolvedPath is expected.
 */
export type ResolvedPath = string & { readonly __hankRefResolved: unique symbol };

/**
 * Resolve one authored ref against its base dir.
 *
 * Absolute refs pass through EXACTLY as written — no lexical normalization.
 * Collapsing "link/.." picks a different file than the OS does when "link"
 * is a symlink (the kernel follows the link first, then walks .. from the
 * link's target). Relative refs resolve against baseDir. Throws on an empty
 * ref (normalize fields first) and on a non-absolute baseDir (no cwd
 * fallback).
 */
export function resolveRef(raw: string, baseDir: string): ResolvedPath {
  if (raw === "") {
    throw new Error(`Cannot resolve an empty file reference (base dir: ${baseDir})`);
  }
  if (!path.isAbsolute(baseDir)) {
    throw new Error(
      `Base directory for resolving "${raw}" must be absolute, got: ${baseDir === "" ? "(empty)" : baseDir}`,
    );
  }
  if (path.isAbsolute(raw)) {
    return raw as ResolvedPath;
  }
  return path.resolve(baseDir, raw) as ResolvedPath;
}

/**
 * Normalize a maybe-string, maybe-array config field to a string[].
 *
 * undefined, null, and the empty-string SCALAR all mean "nothing was
 * provided" → []. Empty strings INSIDE an array pass through so a malformed
 * ["a.md", ""] surfaces as an error downstream instead of being dropped.
 */
export function normalizeRefField(v: string | string[] | undefined | null): string[] {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

/** Convenience composition: normalizeRefField, then resolveRef on each element. */
export function resolveRefField(
  v: string | string[] | undefined | null,
  baseDir: string,
): ResolvedPath[] {
  return normalizeRefField(v).map((ref) => resolveRef(ref, baseDir));
}

/**
 * Thrown by readRef. `cause` is the underlying fs error; callers branch on
 * (cause as NodeJS.ErrnoException).code (e.g. ENOENT) to keep their own error
 * strategies — validation collects, sentinel code wraps, loaders throw.
 */
export class RefReadError extends Error {
  readonly authoredRef: string;
  readonly resolvedPath: ResolvedPath;
  override readonly cause: unknown;

  constructor(authoredRef: string, resolvedPath: ResolvedPath, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to read "${authoredRef}" (resolved to ${resolvedPath}): ${causeMsg}`);
    this.name = "RefReadError";
    this.authoredRef = authoredRef;
    this.resolvedPath = resolvedPath;
    this.cause = cause;
  }
}

/**
 * Resolve + read utf-8 in one step — the only fs-touching reader in this
 * module, and deliberately the only way from an authored ref to file
 * contents. It accepts ONLY a ValidatedRef (minted by validateRef), so a
 * read that skipped the strict-ref gate does not typecheck. Returns the
 * resolved path alongside the text so callers that key caches or error
 * messages by path don't re-resolve.
 */
export function readRef(raw: ValidatedRef, baseDir: string): { path: ResolvedPath; text: string } {
  const resolved = resolveRef(raw, baseDir);
  // Reject non-regular files before the read: readFileSync on a FIFO blocks
  // forever. Missing paths fall through to the read so callers keep getting
  // an ENOENT cause to branch on.
  const problem = checkRegularFile(resolved, { read: false });
  if (problem?.kind === "irregular") {
    throw new RefReadError(raw, resolved, new Error(`${resolved} ${problem.phrase}`));
  }
  try {
    return { path: resolved, text: fs.readFileSync(resolved, "utf-8") };
  } catch (error) {
    throw new RefReadError(raw, resolved, error);
  }
}

/**
 * validateRef + readRef with the error handling every reading call site was
 * hand-rolling: a strict-ref violation and a missing file each throw an Error
 * whose message is composed here (so the same situation reads the same at
 * every site), and any other read failure rethrows the underlying fs error.
 * `what` names the file kind in the not-found message ("Global system prompt
 * file", "Schema file"); `context` is an optional trailing "(...)" line
 * appended to both messages. Callers that need a specific error TYPE wrap
 * the call in a single catch instead of branching per failure mode.
 */
export function vetAndReadRef(
  raw: string,
  baseDir: string,
  hankDir: string,
  options: { what: string; context?: string },
): { path: ResolvedPath; text: string } {
  const suffix = options.context ? `\n  (${options.context})` : "";
  const vetted = validateRef(raw, baseDir, hankDir);
  if (typeof vetted !== "string") {
    throw new Error(`${refViolationMessage(vetted)}${suffix}`);
  }
  try {
    return readRef(vetted, baseDir);
  } catch (error) {
    if (
      error instanceof RefReadError &&
      (error.cause as NodeJS.ErrnoException)?.code === "ENOENT"
    ) {
      throw new Error(`${options.what} not found: ${error.resolvedPath}${suffix}`);
    }
    throw error instanceof RefReadError ? error.cause : error;
  }
}

// -------------
// Strict-ref policy (R1/R2/R3)
// -------------

/**
 * R1, purely textual. Reports why a spelling is non-portable, or null if it
 * is fine. Hank refs are POSIX-style: "/" is the only separator, and the same
 * string must mean the same thing on every platform — hence explicit spelling
 * checks instead of path.isAbsolute, which only knows the host platform.
 */
export function forbiddenRefSpelling(raw: string): "absolute" | "backslash" | "invalid" | null {
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
  return null;
}

/**
 * R2 for fields whose base is the hank dir — this IS the rule, not an
 * approximation: a ref may never climb above its base, even if it would come
 * back inside afterwards (leave-and-reenter spellings depend on the name of
 * the folder the hank sits in). No filesystem access, so it is safe inside
 * Zod. Call after forbiddenRefSpelling: "/" is the only separator by then.
 */
export function lexicallyEscapesBase(raw: string): boolean {
  const normalized = path.posix.normalize(raw);
  return normalized === ".." || normalized.startsWith("../");
}

export type RefViolation =
  | { kind: "absolute"; raw: string }
  | { kind: "backslash"; raw: string }
  | { kind: "invalid"; raw: string }
  | { kind: "escapes"; raw: string; resolved: string }
  | { kind: "symlink"; raw: string; component: string }
  | { kind: "tree-symlink"; raw: string; entry: string }
  | { kind: "tree-special"; raw: string; entry: string };

/**
 * The author-facing message for a violation. Every layer that has a
 * RefViolation uses this, so the same violation reads the same everywhere.
 * The Zod layer cannot resolve paths, so it emits the same sentence with the
 * detail clause omitted — tests assert on the shared first clause.
 */
export function refViolationMessage(v: RefViolation): string {
  switch (v.kind) {
    case "absolute":
      return `"${v.raw}" is an absolute or drive-qualified path; hank refs must be relative paths inside the hank directory`;
    case "backslash":
      return `"${v.raw}" contains a backslash; hank refs use "/" as the only path separator`;
    case "invalid":
      return `"${v.raw}" contains an invalid character (NUL)`;
    case "escapes":
      return `"${v.raw}" resolves outside the hank directory (${v.resolved}); move the file into the hank directory`;
    case "symlink":
      return `"${v.raw}" passes through a symlink at "${v.component}"; symlinks are not allowed in hank refs`;
    case "tree-symlink":
      return `"${v.raw}" contains a symlink at "${v.entry}"; symlinks are not allowed anywhere in a copied tree`;
    case "tree-special":
      return `"${v.raw}" contains a non-regular file at "${v.entry}"; only regular files and directories can be copied`;
  }
}

/**
 * A ref string that passed validateRef. The brand makes the strict-ref gate
 * unskippable in the type system: validateRef is the ONLY producer, and
 * readRef (the only ref-contents reader) accepts nothing else — so code that
 * reads a config-referenced file without validating it does not typecheck.
 * Re-validate rather than caching brands across time: validation is a
 * point-in-time fact about the disk, and re-checking is nearly free.
 */
export type ValidatedRef = string & { readonly __hankRefValidated: unique symbol };

/**
 * R1+R2+R3 with filesystem access — the one policy implementation every
 * loader (and later the pack walker) calls. Returns the branded ref for a
 * legal ref, or the violation (discriminate with `typeof r !== "string"`).
 *
 * baseDir is where the ref resolves from (hank dir for hank.json fields and
 * inline sentinel configs; the config file's own dir for a file-based
 * sentinel config's refs); hankDir is the containment anchor. Only the hank
 * anchor's own ancestry is canonicalized, so a symlinked path TO the hank
 * (macOS /tmp → /private/tmp) never trips R3 — while the base's components
 * BELOW the hank keep their authored spelling and are walked like any other
 * ref component, so a symlinked base dir (hank/linked → hank/real) is
 * rejected rather than silently dissolved. When baseDir is not spelled as a
 * child of the given hankDir (a caller holding a different alias of the hank
 * path), it falls back to the physical base path, whose below-hank
 * components are already canonical.
 *
 * Totality: a missing or not-a-directory component passes (the existence
 * checks own missing-file reporting; every component before it is already
 * known symlink-free). EACCES/EIO and a nonexistent baseDir/hankDir are not
 * policy questions — those errors propagate to the caller's existing error
 * handling.
 */
export function validateRef(
  raw: string,
  baseDir: string,
  hankDir: string,
): ValidatedRef | RefViolation {
  const spelling = forbiddenRefSpelling(raw);
  if (spelling !== null) return { kind: spelling, raw };

  // R2: spelling math relative to the hank root. The walk below runs over
  // this same lexically-normalized path — deliberately, because every
  // downstream consumer resolves refs the same lexical way via path.resolve,
  // so we check exactly the components that will actually be read.
  const hankReal = fs.realpathSync(hankDir);
  // The base's position inside the hank, computed LEXICALLY from the
  // authored spelling: realpath'ing the base would dissolve a symlinked base
  // component (hank/linked → hank/real), making the walk below inspect the
  // resolved route while the consumer reads through the authored one. Only
  // when baseDir is not spelled as a child of the given hankDir (an aliased
  // hank path) fall back to the physical base — its below-hank components
  // are then already canonical.
  let baseRelHost = path.relative(path.resolve(hankDir), path.resolve(baseDir));
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

  // R3: walk one component at a time below the hank boundary with the
  // no-follow stat. Reject at the FIRST symlink (so a loop is just "a
  // symlink" — we never follow one, and ELOOP cannot happen) and stop at the
  // first genuinely missing component. No realpath string comparison, so
  // on-disk case/Unicode spelling differences cannot false-positive.
  let current = hankReal;
  for (const part of combined === "." ? [] : combined.split("/")) {
    current = path.join(current, part);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return raw as ValidatedRef;
      throw error;
    }
    if (stats.isSymbolicLink()) return { kind: "symlink", raw, component: current };
  }
  return raw as ValidatedRef;
}

/**
 * Spec-63 amendment: R3 extended INTO copy.from directory trees. validateRef
 * checks the ref's own components; this walks the entries inside the tree it
 * names, rejecting any symlink (dangling ones included — we lstat and never
 * follow, so cycles cannot recurse) and any non-regular file (FIFO, socket,
 * device). Both would make a bundle unreproducible, and a check that only
 * ran at pack time would let a hank run locally for weeks before refusing to
 * pack — so the loader enforces it up front.
 *
 * The ValidatedRef parameter enforces the contract that the ref itself was
 * vetted before its target tree is walked. lstat/readdir only —
 * no file contents are read, so the preflight's never-touch-forbidden-paths
 * rule is preserved. A missing or non-directory target returns null: file
 * copies have no entries, and the existence walk owns missing-path errors.
 * EACCES/EIO propagate, like validateRef.
 */
export function validateCopyTree(raw: ValidatedRef, baseDir: string): RefViolation | null {
  const root = resolveRef(raw, baseDir);
  let rootStats: fs.Stats;
  try {
    rootStats = fs.lstatSync(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  if (!rootStats.isDirectory()) {
    // A file copy has no entries to scan; a symlink root is validateRef's
    // finding (contract: call only after validateRef passed). But a FIFO,
    // socket, or device named DIRECTLY as copy.from is the same hazard as
    // one nested in a tree — the runtime copy would hand it to cp — and
    // the existence checks alone would let it through.
    if (rootStats.isFile() || rootStats.isSymbolicLink()) return null;
    return { kind: "tree-special", raw, entry: root };
  }

  const pending: string[] = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    // Sorted so the reported entry is deterministic when several violate.
    for (const name of fs.readdirSync(dir).sort()) {
      const entry = path.join(dir, name);
      const stats = fs.lstatSync(entry);
      if (stats.isSymbolicLink()) return { kind: "tree-symlink", raw, entry };
      if (stats.isDirectory()) pending.push(entry);
      else if (!stats.isFile()) return { kind: "tree-special", raw, entry };
    }
  }
  return null;
}

// -------------
// Authored-ref inventory
// -------------

/**
 * One authored ref pulled out of a config object, labeled with the field name
 * error messages use. scanTree marks copy.from refs, whose target tree also
 * gets scanned (validateCopyTree) once the ref itself is legal.
 */
export interface AuthoredRef {
  field: string;
  raw: string;
  scanTree?: boolean;
}

/** The ref-bearing fields of a sentinel config, structurally (no Zod import). */
export interface SentinelRefFields {
  systemPromptFile?: string | string[];
  userPromptFile?: string | string[];
  structuredOutput?: { schemaFile?: string };
}

/**
 * THE inventory of a sentinel config's own ref fields. Every layer that
 * checks sentinel refs iterates this — the Zod inline-escape refinement,
 * static hank validation, and the runtime config loader — so a new ref field
 * is added here once and every layer picks it up.
 */
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

/** The ref-bearing fields of a codon (loops recurse before this applies). */
export interface CodonRefFields {
  promptFile?: string | string[];
  appendSystemPromptFile?: string | string[];
  rigSetup?: Array<{ type: string; copy?: { from: string } }>;
  sentinels?: Array<{ sentinelConfig: string | object }>;
}

/**
 * THE inventory of a codon's own ref fields (hank-dir anchored). Inline
 * sentinel configs are not included — their refs are sentinelOwnRefs of the
 * inline object; only a string sentinelConfig is itself a ref.
 */
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
