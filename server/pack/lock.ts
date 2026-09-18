/**
 * `hank.lock` builder for `hankweave pack` (U2 spec §4.3–§4.4).
 *
 * FROZEN OUTPUT: everything in this file feeds sha256 preimages. Any change
 * to serialization, key selection, field substitution, or the canonical-JSON
 * rules changes every existing `bundleHash` and `codonInputs` value —
 * orphaning registry entries and defeating change detection. Treat the
 * output format as immutable; evolve it only by bumping the version prefix
 * constants below (a deliberate, breaking identity migration), never in
 * place.
 *
 * `bundleHash` is derived purely from the identity payload — never from tar
 * or zstd bytes — so the complete lock is computable without building an
 * archive, and a lock can embed its own bundleHash without circularity (the
 * lock is excluded from `files`).
 *
 * Every lock field is one of (phase-1 review, issue 01):
 * - AUTHORITATIVE, inside the identity payload: `v`, `files` (paths + modes
 *   + content hashes), `runtime.min`. These are the behavior-affecting
 *   inputs that cannot be recomputed from bundle bytes alone.
 * - DERIVED, re-derived from bundle bytes before use (spec §6 B19): `name`,
 *   `version`, `codonInputs`. Excluded from the payload so identity
 *   survives derived-algorithm evolution (e.g. the planned `codonInputs`
 *   coarseness tightening via prefix bump).
 *
 * `codonInputs` is the change-aware-rerun contract: raw pre-Zod codon nodes,
 * canonicalized, with every path-valued field replaced in place by
 * `{path, sha256}` — where `path` is the bundle path (which, under strict
 * refs, is simply the hank-relative source path) — plus the codon's
 * flattened execution position, so comparing two locks tells a future rerun
 * engine the first flattened codon whose inputs changed even when the edit
 * was a pure reorder. Deliberately coarse: any `overrides` edit invalidates
 * every codon, and inserting a codon invalidates everything after it
 * (spec §4.4).
 */

import { DEFAULT_IGNORE_FINGERPRINT } from "../hank-dir.js";
import { compareUtf8, getMetadata } from "../utils.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  type ClosureResult,
  flattenCodons,
  type RefRecord,
  refKey,
  type SentinelFileRefs,
  sha256Hex,
} from "./closure.js";
import { type HankLock, hankLockSchema, type LockFileEntry } from "./lock-schema.js";
import { parseSemVer } from "./semver.js";

const BUNDLE_HASH_PREFIX = "hankweave-bundle-v1\0";
const CODON_INPUTS_PREFIX = "hankweave-codon-inputs-v1\0";

// The lock shape (incl. LockFileEntry: content hash + normalized mode —
// mode is identity because the exec bit is load-bearing at runtime) is
// defined ONCE in lock-schema.ts; HankLock is inferred from that schema.
export type { HankLock, LockFileEntry } from "./lock-schema.js";

/** The authoritative identity payload — exactly the behavior-affecting
 * inputs that cannot be recomputed from bundle bytes (see module doc). */
export interface BundleIdentity {
  v: 1;
  files: Record<string, LockFileEntry>;
  runtime: { min: string };
}

export function computeBundleHash(identity: BundleIdentity): string {
  return sha256Hex(BUNDLE_HASH_PREFIX + canonicalJsonStringify(identity));
}

/** Build the full hank.lock from a successful closure walk. */
export function buildLock(closure: ClosureResult, options?: { minRuntime?: string }): HankLock {
  if (!closure.ok) {
    throw new Error("buildLock requires a successful closure (lint errors present)");
  }
  const raw = closure.raw as Record<string, unknown>;
  const meta = (raw.meta as Record<string, unknown> | undefined) ?? {};

  // runtime.min feeds bundleHash, so it must satisfy the one shared SemVer
  // grammar — including the default from our own package metadata (an
  // input, not an exemption; phase-2 issue 07).
  const min = options?.minRuntime ?? getMetadata().version;
  if (parseSemVer(min) === null) {
    throw new Error(`runtime.min ${JSON.stringify(min)} is not a canonical SemVer 2.0.0 version`);
  }

  // Null-prototype: bundle paths are authored data and may collide with
  // Object.prototype names (a member literally named "__proto__").
  const files: Record<string, LockFileEntry> = Object.create(null);
  for (const entry of closure.files) {
    files[entry.bundlePath] = { mode: entry.mode, sha256: entry.sha256 };
  }
  const runtime = { min };
  const bundleHash = computeBundleHash({ v: 1, files, runtime });

  const lock: HankLock = {
    v: 1,
    // The fallback must be derivable from bundle bytes ALONE (name is
    // DERIVED — module doc): the source directory's basename does not ship,
    // so byte-identical hanks in alpha/ and beta/ would get the same
    // bundleHash but different, unverifiable names. The hash prefix is
    // recomputable by any consumer and identical for identical bundles.
    // (The default OUTPUT FILENAME may still use the basename; that is a
    // display concern and lives in the CLI, not here.)
    name: typeof meta.name === "string" ? meta.name : `hank-${bundleHash.slice(0, 12)}`,
    version: typeof meta.version === "string" ? meta.version : "0.0.0",
    bundleHash,
    files,
    codonInputs: buildCodonInputs(closure),
    runtime,
    ignoreDefaults: DEFAULT_IGNORE_FINGERPRINT,
  };
  // Self-check against the one authoritative schema: a lock pack cannot
  // itself validate must never be written to disk.
  hankLockSchema.parse(lock);
  return lock;
}

/** requirements.env, trimmed exactly as hankRequirementsSchema transforms it
 * — the runtime preflight checks the trimmed name, so the codonInputs
 * preimage must hash the same spelling. This is the list's ONLY use in the
 * lock; it is not emitted as a field (hank.json is the source of truth). */
function requirementsEnv(raw: Record<string, unknown>): string[] {
  const env = ((raw.requirements as Record<string, unknown> | undefined)?.env as string[]) ?? [];
  return env.map((name) => name.trim());
}

/** Canonical JSON, sorted keys, single trailing newline (spec §4.2). */
export function serializeLock(lock: HankLock): string {
  return `${canonicalJsonStringify(lock)}\n`;
}

// -------------
// codonInputs (spec §4.4)
// -------------

interface PathSub {
  path: string;
  sha256: string;
}

function lookupRef(closure: ClosureResult, baseDir: string, raw: string): RefRecord {
  const record = closure.refs.get(refKey(baseDir, raw));
  if (!record) {
    throw new Error(`pack internal error: no ref record for ${raw} (base ${baseDir})`);
  }
  return record;
}

function substitute(closure: ClosureResult, baseDir: string, ref: string): PathSub {
  const record = lookupRef(closure, baseDir, ref);
  // The materialized bundle path, never the authored spelling: codonInputs
  // is DERIVED (module doc) — recomputable from bundle bytes alone — and
  // after rewrites only the bundle path exists inside the bundle. This also
  // collapses spelling variants ("p.md" vs "./p.md", relative vs absolute)
  // to one identity.
  return { path: record.bundlePath, sha256: record.sha256 };
}

function substituteStringOrArray(
  closure: ClosureResult,
  baseDir: string,
  value: unknown,
): PathSub | PathSub[] | unknown {
  // An empty-string scalar is absent to the runtime (the walker skipped
  // it, so there is no ref record) — keep it verbatim in the preimage.
  if (value === "") return value;
  if (typeof value === "string") return substitute(closure, baseDir, value);
  if (Array.isArray(value)) {
    return value.map((ref) => substitute(closure, baseDir, String(ref)));
  }
  return value;
}

function buildCodonInputs(closure: ClosureResult): Record<string, string> {
  const raw = closure.raw as Record<string, unknown>;
  const hankDir = closure.hankDir;

  // global — identical preimage component for every codon. Selection
  // MIRRORS config.ts :: loadGlobalSystemPrompt exactly (truthy text wins,
  // then truthy file; empty string is absent) — a hand-written imitation,
  // deliberately not shared code, because this feeds a hash preimage (see
  // module header). If the loader's precedence changes, this must change
  // with it; the resolution-parity tests are the tripwire.
  const globalSystemPrompt = ((): unknown => {
    if (raw.globalSystemPromptText) {
      return { text: raw.globalSystemPromptText };
    }
    if (raw.globalSystemPromptFile) {
      const refs = Array.isArray(raw.globalSystemPromptFile)
        ? (raw.globalSystemPromptFile as string[])
        : [raw.globalSystemPromptFile as string];
      return { files: refs.map((ref) => lookupRef(closure, hankDir, ref).sha256) };
    }
    return null;
  })();
  const global = {
    globalSystemPrompt,
    overrides: raw.overrides ?? null,
    requirementsEnv: requirementsEnv(raw),
  };

  // Null-prototype: codon ids are authored ("__proto__" is a legal id).
  const inputs: Record<string, string> = Object.create(null);
  const flattened = flattenCodons((raw.hank as unknown[]) ?? []);
  for (const [position, { key, codon, loop }] of flattened.entries()) {
    const container = loop
      ? {
          terminateOn: loop.terminateOn ?? null,
          budget: loop.budget ?? null,
          archiveOnSuccess: loop.archiveOnSuccess ?? null,
        }
      : null;
    const codonNode = substituteCodonPaths(closure, codon);
    // `position` is the codon's index in flattened execution order. It is
    // part of the preimage because behavior depends on WHERE a codon runs
    // (earlier codons shape its rig and context), while the codonInputs map
    // itself is key-sorted — without position, reordering codons would
    // change execution and leave every digest untouched, blinding the
    // partial-rerun comparison. Inserting a codon therefore invalidates
    // everything after it, which is the honest answer.
    const preimage =
      CODON_INPUTS_PREFIX +
      canonicalJsonStringify({ global, container, position, codon: codonNode });
    inputs[key] = sha256Hex(preimage);
  }

  // Deterministic key order in the serialized lock comes from canonical
  // JSON; sort here too so direct consumers of the object see stable order.
  const sorted: Record<string, string> = Object.create(null);
  for (const key of Object.keys(inputs).sort(compareUtf8)) {
    sorted[key] = inputs[key] as string;
  }
  return sorted;
}

function substituteRigCopy(closure: ClosureResult, item: Record<string, unknown>): void {
  const hankDir = closure.hankDir;
  if (item.type === "copy") {
    const copy = item.copy as Record<string, unknown>;
    // The runtime copy preserves the exec bit, so a direct-file
    // copy.from includes its normalized mode in the preimage (dir tree
    // hashes already cover per-file modes).
    const record = lookupRef(closure, hankDir, String(copy.from));
    copy.from =
      record.kind === "file"
        ? { path: record.bundlePath, sha256: record.sha256, mode: record.mode }
        : { path: record.bundlePath, sha256: record.sha256 };
  }
}

function substituteSentinelEntry(closure: ClosureResult, entry: Record<string, unknown>): void {
  const hankDir = closure.hankDir;
  const config = entry.sentinelConfig;
  if (typeof config === "string") {
    // The config file ships verbatim (strict refs: nothing is ever
    // rewritten), so its plain file entry IS its bundled identity.
    const record = lookupRef(closure, hankDir, config);
    entry.sentinelConfig = {
      path: record.bundlePath,
      sha256: record.sha256,
      refs: normalizeSentinelRefs(record.sentinelRefs),
    };
  } else if (config && typeof config === "object") {
    entry.sentinelConfig = substituteInlineSentinel(closure, config as Record<string, unknown>);
  }
}

/**
 * Deep-copy a raw codon node with every path-valued field from the spec
 * §4.1 table replaced in place by `{path: bundlePath, sha256}` (arrays
 * element-wise; directory copy.from gets the tree hash; string
 * sentinelConfig gains `refs` covering the sentinel's own prompt/schema
 * files).
 */
function substituteCodonPaths(
  closure: ClosureResult,
  codon: Record<string, unknown>,
): Record<string, unknown> {
  const hankDir = closure.hankDir;
  const node = structuredClone(codon);

  if (node.promptFile !== undefined) {
    node.promptFile = substituteStringOrArray(closure, hankDir, node.promptFile);
  }
  if (node.appendSystemPromptFile !== undefined) {
    node.appendSystemPromptFile = substituteStringOrArray(
      closure,
      hankDir,
      node.appendSystemPromptFile,
    );
  }

  if (Array.isArray(node.rigSetup)) {
    for (const item of node.rigSetup as Record<string, unknown>[]) {
      substituteRigCopy(closure, item);
    }
  }

  if (Array.isArray(node.sentinels)) {
    for (const entry of node.sentinels as Record<string, unknown>[]) {
      substituteSentinelEntry(closure, entry);
    }
  }

  return node;
}

function normalizeSentinelRefs(refs: SentinelFileRefs | undefined): SentinelFileRefs {
  return {
    ...(refs?.systemPromptFile ? { systemPromptFile: refs.systemPromptFile } : {}),
    ...(refs?.userPromptFile ? { userPromptFile: refs.userPromptFile } : {}),
    ...(refs?.schemaFile ? { schemaFile: refs.schemaFile } : {}),
  };
}

/** Inline sentinel objects get the same in-place file-ref substitution;
 * their refs resolve relative to the hank dir (spec §2 resolution rules). */
function substituteInlineSentinel(
  closure: ClosureResult,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const hankDir = closure.hankDir;
  const node = structuredClone(config);
  if (node.systemPromptFile !== undefined) {
    node.systemPromptFile = substituteStringOrArray(closure, hankDir, node.systemPromptFile);
  }
  if (node.userPromptFile !== undefined) {
    node.userPromptFile = substituteStringOrArray(closure, hankDir, node.userPromptFile);
  }
  const structured = node.structuredOutput as Record<string, unknown> | undefined;
  if (structured && typeof structured.schemaFile === "string" && structured.schemaFile) {
    structured.schemaFile = substitute(
      closure,
      hankDir,
      structured.schemaFile,
    ) as unknown as string;
  }
  return node;
}
