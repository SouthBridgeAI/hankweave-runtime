/**
 * Strict SemVer 2.0.0 parsing and comparison for `hankweave pack`
 * (phase-2 issue 07).
 *
 * ONE grammar, ONE comparator, shared by the pack CLI (`--min-runtime`),
 * the lock schema (`runtime.min`), and the phase-3 bundle runner's version
 * gate. `runtime.min` participates in `bundleHash`, so acceptance here is
 * identity-affecting: the grammar admits only canonical SemVer spellings
 * (no `v` prefix, no whitespace, no leading zeros), which makes the stored
 * representation exactly the accepted input — no normalization step exists
 * to drift. Build metadata is accepted and preserved (distinct metadata is
 * a distinct identity, per the recorded policy) but ignored by ordering,
 * as SemVer requires.
 *
 * Numeric identifiers are compared as BigInt: version fields have no
 * defined upper bound, and coercing through JS Number would order
 * `999999999999999999999999.0.0` incorrectly.
 */

// SemVer 2.0.0 (semver.org #75-spec-grammar), anchored, no v-prefix, no
// leading zeros in numeric fields or numeric prerelease identifiers.
// Exported so the lock schema can attach it as a Zod .regex check — which
// zod-to-json-schema emits as a `pattern`, keeping the GENERATED
// hank.lock.schema.json as strict as this grammar (a .refine predicate
// would be silently dropped from the generated schema).
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export interface SemVer {
  major: bigint;
  minor: bigint;
  patch: bigint;
  /** Dot-split prerelease identifiers; numeric ones as bigint. Empty = release. */
  prerelease: (string | bigint)[];
  /** Build metadata identifiers; no precedence effect. */
  build: string[];
  /** The accepted spelling, verbatim (grammar ⇒ already canonical). */
  raw: string;
}

/** Parse a strict SemVer 2.0.0 string. Returns null on any deviation from
 * the canonical grammar (v-prefix, whitespace, missing parts, leading
 * zeros, empty identifiers). */
export function parseSemVer(input: string): SemVer | null {
  const m = SEMVER_RE.exec(input);
  if (!m) return null;
  const prerelease = (m[4] ?? "")
    .split(".")
    .filter((id) => id !== "")
    .map((id) => (/^\d+$/.test(id) ? BigInt(id) : id));
  const build = (m[5] ?? "").split(".").filter((id) => id !== "");
  return {
    major: BigInt(m[1] as string),
    minor: BigInt(m[2] as string),
    patch: BigInt(m[3] as string),
    prerelease,
    build,
    raw: input,
  };
}

function cmpBigint(a: bigint, b: bigint): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrereleaseIdentifier(x: string | bigint, y: string | bigint): -1 | 0 | 1 {
  if (typeof x === "bigint" && typeof y === "bigint") {
    return cmpBigint(x, y);
  } else if (typeof x === "bigint") {
    return -1; // numeric identifiers order below alphanumeric ones
  } else if (typeof y === "bigint") {
    return 1;
  } else {
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** SemVer 2.0.0 precedence (spec §11). Build metadata is ignored. */
export function compareSemVer(a: SemVer, b: SemVer): -1 | 0 | 1 {
  const core =
    cmpBigint(a.major, b.major) || cmpBigint(a.minor, b.minor) || cmpBigint(a.patch, b.patch);
  if (core !== 0) return core;

  // A prerelease version has lower precedence than its release.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i] as string | bigint;
    const y = b.prerelease[i] as string | bigint;
    const c = comparePrereleaseIdentifier(x, y);
    if (c !== 0) return c;
  }
  // All shared identifiers equal: more identifiers = higher precedence.
  return cmpBigint(BigInt(a.prerelease.length), BigInt(b.prerelease.length));
}

/** True iff `input` is canonical SemVer (the lock-schema refinement). */
export function isStrictSemVer(input: string): boolean {
  return SEMVER_RE.test(input);
}
