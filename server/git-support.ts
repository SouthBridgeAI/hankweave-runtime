/**
 * Shared git plumbing for the two file-domain entities (hank-dir.ts and
 * workspace/files.ts): the availability probe, the curated spawn environment, and
 * the byte-safe NUL-framed output parser. Nothing here knows what a hank or
 * a workspace is — policy lives in those modules.
 *
 * Isolation: every spawn runs with a curated environment (inherited GIT_*
 * stripped, HOME redirected, system config disabled), so a parent repo's
 * rules or the user's global config can never leak into a verdict.
 */

import { spawnSync } from "node:child_process";

// -------------
// Git availability
// -------------

export class GitMissingError extends Error {
  constructor(context: string, detail: string) {
    super(
      `git is required (${context}) but could not be run: ${detail}\n` +
        `Install git and ensure it is on PATH — https://git-scm.com/downloads`,
    );
    this.name = "GitMissingError";
  }
}

/** Oldest git the file-domain modules are tested against. Every flag used
 * (check-ignore -z -v -n --stdin --no-index, ls-files --exclude-standard)
 * predates it by years. */
const MIN_GIT_VERSION = "2.20";

let gitProbe: { ok: true; version: string } | { ok: false; detail: string } | null = null;

/**
 * Probe the git binary once per process; throw GitMissingError when absent.
 * A version older than MIN_GIT_VERSION also throws — better a clear startup
 * error than subtly wrong ignore verdicts. An unparseable version string
 * passes (some builds re-brand the banner); flag misuse would surface as
 * fail-closed errors downstream.
 */
export function assertGitAvailable(context: string): void {
  gitProbe ??= probeGit();
  if (!gitProbe.ok) throw new GitMissingError(context, gitProbe.detail);
}

function probeGit(): NonNullable<typeof gitProbe> {
  // env passed explicitly: the runtime's CURRENT PATH decides, not the
  // one snapshotted at process start.
  const r = spawnSync("git", ["--version"], { encoding: "utf8", env: { ...process.env } });
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      detail: r.error ? String(r.error.message) : `exit ${r.status}: ${r.stderr ?? ""}`.trim(),
    };
  }
  return checkGitVersion(r.stdout);
}

function checkGitVersion(banner: string): NonNullable<typeof gitProbe> {
  const m = /git version (\d+)\.(\d+)/.exec(banner);
  if (!m) return { ok: true, version: "unknown" };
  const [minMajor, minMinor] = MIN_GIT_VERSION.split(".").map(Number) as [number, number];
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    return {
      ok: false,
      detail: `git ${major}.${minor} is older than the minimum supported ${MIN_GIT_VERSION}`,
    };
  }
  return { ok: true, version: `${major}.${minor}` };
}

/** Test seam: forget the memoized probe result. */
export function resetGitProbeForTests(): void {
  gitProbe = null;
}

// -------------
// Spawn environment
// -------------

/**
 * Minimal, curated environment for every git spawn — built from scratch so
 * inherited GIT_* variables (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_*, tracing)
 * can never redirect a command, and the user's global/system config never
 * leaks in. `overrides` supplies HOME/GIT_DIR/etc. per mode.
 */
export function gitEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (process.platform === "win32") {
    for (const k of ["SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
  } else if (process.env.TMPDIR) {
    env.TMPDIR = process.env.TMPDIR;
  }
  return { ...env, ...overrides };
}

// -------------
// The hard `.git` rule
// -------------

/** A path component that IS `.git` — directory or the worktree/submodule
 * marker FILE (which holds a machine-specific `gitdir:` path). Enforced
 * in-process: git never reports `.git` as ignored, and an authored `!.git`
 * outranks info/exclude, so this rule cannot ride on git. Case-FOLDED on
 * purpose: on a case-insensitive filesystem `.GIT` is the same directory
 * entry (and would alias a mirror repo's own admin dir), and git itself
 * refuses to track `.GIT` variants — so every spelling is git metadata
 * here, on every platform. `.github`/`.gitignore` are ordinary names. */
export function containsGitComponent(relPosix: string): boolean {
  return relPosix.split("/").some((c) => c.toLowerCase() === ".git");
}

// -------------
// Output parsing
// -------------

/** NUL-framed output → strings, byte-safely: each segment must round-trip
 * UTF-8 exactly, or a filename with invalid bytes would silently decode
 * to a DIFFERENT path (U+FFFD) that callers then lstat, add, or rm — the
 * wrong file. Fail loudly instead: hankweave requires UTF-8 filenames. */
export function parseNulSeparated(stdout: Buffer): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= stdout.length; i++) {
    if (i === stdout.length || stdout[i] === 0) {
      if (i > start) {
        const seg = stdout.subarray(start, i);
        const s = seg.toString("utf8");
        if (!Buffer.from(s, "utf8").equals(seg)) {
          throw new Error(
            `workspace filename is not valid UTF-8 (${s}); hankweave requires UTF-8 filenames — rename or delete the file`,
          );
        }
        out.push(s);
      }
      start = i + 1;
    }
  }
  return out;
}
