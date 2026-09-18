import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { containsGitComponent } from "./git-support.js";
import {
  computeClosure,
  MAX_ARCHIVE_BYTES,
  portableNameProblem,
  RESERVED_LOCK_PATH,
  sha256Hex,
} from "./pack/closure.js";
import { computeBundleHash } from "./pack/lock.js";
import { type HankLock, hankLockSchema } from "./pack/lock-schema.js";
import { compareSemVer, parseSemVer } from "./pack/semver.js";
import { readCanonicalTar, type TarMember } from "./pack/tar.js";
import { ZstdUnavailableError, zstdDecompress } from "./pack/zstd.js";
import { checkRegularFile, getMetadata } from "./utils.js";

export class BundleError extends Error {
  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`);
    this.name = "BundleError";
  }
}

function readBundle(bundlePath: string): TarMember[] {
  const problem = checkRegularFile(bundlePath, { read: false });
  if (problem) throw new Error(problem.phrase);
  if (fs.statSync(bundlePath).size > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  }
  const compressed = fs.readFileSync(bundlePath);
  let tar: Buffer;
  try {
    tar = zstdDecompress(compressed, MAX_ARCHIVE_BYTES);
  } catch (error) {
    const reason =
      error instanceof ZstdUnavailableError
        ? "running a .hank bundle requires Node >=22.15 or Bun (zstd)"
        : `not a zstd archive: ${(error as Error).message}`;
    throw new Error(reason);
  }
  return readCanonicalTar(tar);
}

function verifyLockPaths(lock: HankLock): void {
  for (const key of Object.keys(lock.files)) {
    const unsafeSegment = key
      .split("/")
      .some((part) => part === "" || part === "." || part === "..");
    const portableProblem = portableNameProblem(key);
    if (
      path.isAbsolute(key) ||
      unsafeSegment ||
      containsGitComponent(key) ||
      key === RESERVED_LOCK_PATH ||
      portableProblem
    ) {
      throw new BundleError(key, portableProblem ?? "unsafe or reserved hank.lock path");
    }
  }
  if (!Object.hasOwn(lock.files, "hank.json"))
    throw new BundleError("hank.lock", "missing hank.json");
}

function verifyMembers(members: TarMember[], lock: HankLock): void {
  const names = new Set(members.map((member) => member.path));
  const missing = Object.keys(lock.files).find((key) => !names.has(key));
  const extra = members.find((member) => !Object.hasOwn(lock.files, member.path));
  if (missing || extra) {
    throw new BundleError(
      "hank.lock",
      [missing && `missing member ${missing}`, extra && `extra member ${extra.path}`]
        .filter(Boolean)
        .join("; "),
    );
  }
  for (const member of members) {
    const expected = lock.files[member.path];
    const actualHash = sha256Hex(member.bytes);
    if (actualHash !== expected.sha256 || member.mode !== expected.mode) {
      throw new BundleError(
        member.path,
        `does not match hank.lock (expected ${expected.sha256} mode ${expected.mode}, got ${actualHash} mode ${member.mode})`,
      );
    }
  }
  if (computeBundleHash({ v: 1, files: lock.files, runtime: lock.runtime }) !== lock.bundleHash) {
    throw new BundleError(
      "hank.lock",
      "bundleHash does not match its files (lock edited without repacking?)",
    );
  }
}

function verifyRuntime(lock: HankLock): void {
  const version = getMetadata().version;
  const current = parseSemVer(version);
  const required = parseSemVer(lock.runtime.min);
  if (!current) {
    console.warn(`Warning: cannot check bundle runtime.min against development version ${version}`);
  } else if (required && compareSemVer(required, current) > 0) {
    throw new BundleError(
      "hank.lock",
      `bundle requires hankweave ≥ ${lock.runtime.min}, this is ${version}`,
    );
  }
}

function extractMember(dir: string, member: TarMember): void {
  const target = path.resolve(dir, member.path);
  const relative = path.relative(dir, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new BundleError(member.path, "escapes extraction directory");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = member.mode === "755" ? 0o755 : 0o644;
  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    mode,
  );
  try {
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, member.bytes);
  } finally {
    fs.closeSync(fd);
  }
}

/** Content-addressed extraction root. Every invocation of the same bundle
 * lands at `<root>/<bundleHash>`, so absolute paths persisted in an
 * execution's plan stay valid across resumes, and a tree the OS or user
 * removed is recreated at the very same path on the next run. */
export function bundleExtractionRoot(): string {
  return path.join(os.tmpdir(), "hankweave-bundles");
}

export type ExtractionOutcome = "fresh" | "reused" | "repaired";

/** True when the tree at `dir` packs to this bundle: the closure walker —
 * the same code `hankweave pack` runs — yields members whose identity hash
 * equals the lock's bundleHash. Anything that would change the packed
 * bundle (edited bytes, a lost member, a stray file inside a copied tree, a
 * flipped executable bit) makes the tree untrusted. Files the closure never
 * reaches are harmless and never checked. Windows cannot store the
 * executable bit, so there the lock's mode stands in for it.
 *
 * Cost: the closure evaluates ignore rules through git (`git init` for the
 * rules mirror, then `git check-ignore`), so one check is ~0.75 s on a
 * 10-file hank regardless of size. extractMembers pays it once per
 * invocation when the tree is reused, twice when it repairs one. That is
 * the price of not owning a second verifier; the in-memory archive
 * verification above stays fast. */
function extractionMatches(dir: string, lock: HankLock): boolean {
  if (!fs.existsSync(path.join(dir, "hank.json"))) return false;
  try {
    const closure = computeClosure(dir);
    if (!closure.ok) return false;
    const files: HankLock["files"] = Object.create(null);
    for (const entry of closure.files) {
      const mode =
        process.platform === "win32" && Object.hasOwn(lock.files, entry.bundlePath)
          ? lock.files[entry.bundlePath].mode
          : entry.mode;
      files[entry.bundlePath] = { mode, sha256: entry.sha256 };
    }
    return computeBundleHash({ v: 1, files, runtime: lock.runtime }) === lock.bundleHash;
  } catch {
    return false;
  }
}

function extractToStaging(root: string, members: TarMember[]): string {
  const staging = fs.mkdtempSync(path.join(root, ".staging-"));
  let current = "extraction directory";
  try {
    fs.chmodSync(staging, 0o700);
    for (const member of members) {
      current = member.path;
      extractMember(staging, member);
    }
    return staging;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new BundleError(current, `extraction failed: ${(error as Error).message}`);
  }
}

/** Reuse a verified tree at the content address, or publish a fresh one by
 * extracting into a private staging directory and renaming it into place.
 * A concurrent invocation of the same bundle may publish first; its tree is
 * accepted when it verifies, so two runs never fight over identical bytes.
 * Each extractionMatches call is a full closure walk (see its doc), so the
 * re-check after staging is only made when a tree already existed. */
function extractMembers(
  members: TarMember[],
  lock: HankLock,
): { hankDir: string; extraction: ExtractionOutcome } {
  const root = bundleExtractionRoot();
  fs.mkdirSync(root, { recursive: true });
  const hankDir = path.join(root, lock.bundleHash);
  const existed = fs.existsSync(hankDir);
  if (existed && extractionMatches(hankDir, lock)) return { hankDir, extraction: "reused" };
  const staging = extractToStaging(root, members);
  if (existed) {
    // Re-check before discarding: a concurrent run may have just repaired it.
    if (extractionMatches(hankDir, lock)) {
      fs.rmSync(staging, { recursive: true, force: true });
      return { hankDir, extraction: "reused" };
    }
    fs.rmSync(hankDir, { recursive: true, force: true });
  }
  try {
    fs.renameSync(staging, hankDir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!extractionMatches(hankDir, lock)) {
      throw new BundleError(
        "extraction directory",
        `cannot publish ${hankDir}: ${(error as Error).message}`,
      );
    }
    return { hankDir, extraction: "reused" };
  }
  return { hankDir, extraction: existed ? "repaired" : "fresh" };
}

/** Verify all bytes before touching the content-addressed extraction. Verified
 * trees survive for resume and replay; see {@link bundleExtractionRoot}. */
export async function resolveBundleHank(bundlePath: string): Promise<{
  hankPath: string;
  hankDir: string;
  bundleHash: string;
  bundlePath: string;
  lock: HankLock;
  extraction: ExtractionOutcome;
}> {
  const absolute = path.resolve(bundlePath);
  try {
    const members = readBundle(absolute);
    if (members[0]?.path !== RESERVED_LOCK_PATH) {
      throw new BundleError("hank.lock", "must be the first bundle member");
    }
    const lock = hankLockSchema.parse(JSON.parse(members[0].bytes.toString("utf8")));
    verifyLockPaths(lock);
    verifyMembers(members.slice(1), lock);
    verifyRuntime(lock);
    const { hankDir, extraction } = extractMembers(members, lock);
    return {
      hankPath: path.join(hankDir, "hank.json"),
      hankDir,
      bundleHash: lock.bundleHash,
      bundlePath: absolute,
      lock,
      extraction,
    };
  } catch (error) {
    throw new BundleError(absolute, (error as Error).message);
  }
}
