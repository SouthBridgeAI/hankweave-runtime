import micromatch from "micromatch";

// -------------
// Policy: the pattern dialect
// -------------

export interface WorkspacePatternMatcher {
  /** False when the pattern list has no positive pattern — such a list
   * matches nothing (fast-glob's rule). */
  readonly hasPositive: boolean;
  matches(relPosix: string): boolean;
}

/**
 * The glob dialect for workspace patterns (checkpointedFiles,
 * archiveOnSuccess, watched patterns) — fast-glob's, matched with micromatch
 * exactly as fast-glob compiles it: dot enabled, posix classes on, basename
 * matching OFF, a leading "!" negates (unless it opens an extglob "!("),
 * negatives subtract globally regardless of order, "./" prefixes stripped,
 * duplicate slashes collapsed. A pattern naming a directory also matches the
 * directory's contents (`p` implies `p/**`) — the schema has always promised
 * that ("files/directories"), and plain `p` matching nothing was a bug.
 */
export function createWorkspaceMatcher(patterns: readonly string[]): WorkspacePatternMatcher {
  const isNegative = (p: string) => p.startsWith("!") && !p.startsWith("!(");
  const stripDotSlash = (p: string) => (p.startsWith("./") ? p.slice(2) : p);
  const removeDuplicateSlashes = (p: string) => p.replace(/(?!^)\/{2,}/g, "/");
  const expandDir = (p: string): string[] => {
    const trimmed = p.replace(/\/+$/, "");
    return trimmed === "" ? [p] : [trimmed, `${trimmed}/**`];
  };
  // Normalize FIRST (strip a leading "./" and collapse duplicate slashes),
  // THEN classify polarity — fast-glob strips "./" before it decides a
  // pattern is negative, so "./!foo" is the NEGATION of foo, not a positive
  // literal "!foo" (which micromatch would read as a negation inside the
  // positive list and wrongly match everything). Empty strings are dropped
  // last: "!./" normalizes to nothing, and an empty pattern makes micromatch
  // throw. (Known, accepted divergence: brace expansion runs after this, so
  // an exotic "{!,}x" or a brace spanning a slash like "a/{b,}/c" can still
  // classify or match differently than fast-glob — rare in file patterns.)
  const normalized = patterns.map((p) => stripDotSlash(removeDuplicateSlashes(p)));
  const positive = normalized
    .filter((p) => !isNegative(p))
    .flatMap(expandDir)
    .filter((p) => p !== "");
  const negative = normalized
    .filter(isNegative)
    // Strip a "./" that sat AFTER the "!" ("!./x" → "x", "!./" → nothing).
    .map((p) => stripDotSlash(p.slice(1)))
    .flatMap(expandDir)
    .filter((p) => p !== "");
  if (positive.length === 0) return { hasPositive: false, matches: () => false };
  const options = {
    dot: true,
    // fast-glob hardcodes posix: true, which flips negated-class
    // patterns like "[!a]*.txt".
    posix: true,
  };
  // Compile each expanded pattern once; path checks only run these predicates.
  const include = positive.map((pattern) => micromatch.matcher(pattern, options));
  const exclude = negative.map((pattern) => micromatch.matcher(pattern, options));
  return {
    hasPositive: true,
    matches: (relPosix) =>
      include.some((matches) => matches(relPosix)) && !exclude.some((matches) => matches(relPosix)),
  };
}
